"""Item-construction helpers for the CH point-in-time benchmark, and the DB
glue that turns them into the benchmark's JSONL files.

The top half (select_change / item_id / make_items) is pure -- no DB, no
I/O -- given the rows the bottom half's SQL fetches, it decides whether a
change is worth turning into a benchmark item, builds the item pair, and
gives every item a stable id. The bottom half (build() / main()) is the
Task 3 DB glue: one SQL query per language against ch_act_change joined to
ch_act/ch_act_version/ch_act_article/ch_act_alias, stratified sampling in
Python, and a JSONL + build-report.json write. See
docs/superpowers/plans/2026-08-25-ch-pit-benchmark.md, "### Item (JSONL
line)".
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import logging
import math
import pathlib
import random
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Mapping

from chpipe import db
from chpipe.bench import score, templates
from chpipe.config import Settings

log = logging.getLogger(__name__)

# A change is only usable as a benchmark item if both editions have real
# body text (>= 200 normalised characters -- see the plan's "Item (JSONL
# line)" section) and actually differ (SequenceMatcher ratio < 0.9 on the
# normalised text), so a single-space or whitespace-only re-typesetting
# does not masquerade as a change.
_MIN_TEXT_LEN = 200
_MAX_SAME_RATIO = 0.9

# Provenance fields stamped on every item -- see the plan's item schema.
SOURCE = "Fedlex (fedlex.admin.ch)"
LICENCE = "Fedlex data may be reused free of charge with source attribution"


def select_change(old_text: str, new_text: str) -> bool:
    """True if OLD_TEXT -> NEW_TEXT is a real, substantial change worth
    building a benchmark item pair from.

    Both texts must normalise() to at least 200 characters (rules out
    stub/repealed articles with near-empty bodies) AND
    difflib.SequenceMatcher(None, norm(old), norm(new)).ratio() must be
    below 0.9 (rules out a version bump that only re-typesets punctuation
    or whitespace without changing the wording).
    """
    norm_old = score.normalise(old_text)
    norm_new = score.normalise(new_text)
    if len(norm_old) < _MIN_TEXT_LEN or len(norm_new) < _MIN_TEXT_LEN:
        return False
    ratio = SequenceMatcher(None, norm_old, norm_new).ratio()
    return ratio < _MAX_SAME_RATIO


def item_id(lang: str, sr_number: str, e_id: str, as_of: Any) -> str:
    """Stable item id: first 16 hex chars of
    sha1(f"{lang}|{sr_number}|{e_id}|{as_of}"). AS_OF may be a
    datetime.date (formatted as its ISO date, e.g. "2020-12-31") or an
    already-ISO-formatted string -- either way the hashed payload is the
    same string, so ids are stable however the caller passes the date.
    """
    as_of_str = as_of.isoformat() if isinstance(as_of, (datetime.date, datetime.datetime)) else str(as_of)
    payload = f"{lang}|{sr_number}|{e_id}|{as_of_str}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _iso(value: Any) -> Any:
    """Format a date-like value as ISO; pass through None and plain
    strings unchanged."""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    return value


def _edition(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "version_id": row["version_id"],
        "date_applicability": _iso(row["date_applicability"]),
        "date_end_applicability": _iso(row["date_end_applicability"]),
        "eli": row["eli_consolidation_uri"],
        "text": row["text"],
    }


def make_items(
    change_row: Mapping[str, Any],
    old_row: Mapping[str, Any],
    new_row: Mapping[str, Any],
    abbr: str,
    lang: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build the `before`/`after` item pair for one selected change.

    CHANGE_ROW carries act_id, sr_number, e_id, article_number and
    date_applicability (the change date, a datetime.date). OLD_ROW/NEW_ROW
    carry version_id, date_applicability, date_end_applicability,
    eli_consolidation_uri and text for the edition valid before/after the
    change.

    `before`: as_of = change_date - 1 day, gold = OLD_ROW, distractor =
    NEW_ROW. `after`: as_of = change_date, gold = NEW_ROW, distractor =
    OLD_ROW.

    Either half is dropped -- and reported in the second return value
    instead of the first -- when its gold text has no gold-only unit
    relative to its distractor (score.discriminating_units(gold, distractor)
    returns an empty gold_only list): with nothing in gold that isn't also
    in distractor, no answer could ever be scored as grounding in gold
    specifically, so the item would be unscoreable by design.

    Returns (items, skipped): ITEMS is the list of item dicts that survived
    (0, 1 or 2 entries); SKIPPED is a list of
    {"kind", "reason", "as_of", "e_id", "sr_number"} dicts, one per dropped
    half, e.g. {"reason": "no_discriminating_unit", ...}.
    """
    change_date = change_row["date_applicability"]
    sr_number = change_row["sr_number"]
    e_id = change_row["e_id"]
    article_number = change_row["article_number"]
    change_date_str = _iso(change_date)

    variants = (
        ("before", change_date - datetime.timedelta(days=1), old_row, new_row),
        ("after", change_date, new_row, old_row),
    )

    items: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for kind, as_of, gold_row, distractor_row in variants:
        gold_only, _distractor_only, _shared = score.discriminating_units(
            gold_row["text"], distractor_row["text"]
        )
        if not gold_only:
            skipped.append({
                "kind": kind,
                "reason": "no_discriminating_unit",
                "as_of": _iso(as_of),
                "e_id": e_id,
                "sr_number": sr_number,
            })
            continue

        items.append({
            "id": item_id(lang, sr_number, e_id, as_of),
            "lang": lang,
            "sr_number": sr_number,
            "abbreviation": abbr,
            "article_number": article_number,
            "e_id": e_id,
            "as_of": _iso(as_of),
            "kind": kind,
            "change_date": change_date_str,
            "question": templates.question(lang, article_number, abbr, sr_number, as_of),
            "gold": _edition(gold_row),
            "distractor": _edition(distractor_row),
            "source": SOURCE,
            "licence": LICENCE,
        })

    return items, skipped


# ---------------------------------------------------------------------------
# Task 3: DB glue
# ---------------------------------------------------------------------------
#
# One SQL query, run once per language: ch_act_change (a 'modified' row in
# that language) joined to its act (in force only -- enforcement_status = 0),
# the two editions either side of the change, and the article text in each
# edition, keyed on (version_id, e_id) exactly like select_change/make_items
# above expect. The abbreviation is resolved in the same query rather than a
# second round-trip: German reads ch_act.abbreviation directly; French and
# Italian look it up in ch_act_alias for that language, preferring a
# 'curated' source over 'title_paren' and breaking any further tie on abbr
# text so the pick is deterministic (see the plan's "Item (JSONL line)"
# selection-rules paragraph). The LATERAL join's `ON %(lang)s <> 'de'`
# guard is what keeps German from ever consulting the alias table at all --
# ch_act_alias may hold no 'de' rows for an act with a real
# ch_act.abbreviation, and querying it anyway would silently prefer nothing
# over the real column.
_CHANGE_SQL = """
SELECT
    ch.act_id AS act_id,
    a.sr_number AS sr_number,
    ch.e_id AS e_id,
    ch.article_number AS article_number,
    ch.date_applicability AS date_applicability,
    CASE WHEN %(lang)s = 'de' THEN a.abbreviation ELSE alias.abbr END AS abbreviation,
    old_ver.version_id AS old_version_id,
    old_ver.date_applicability AS old_date_applicability,
    old_ver.date_end_applicability AS old_date_end_applicability,
    old_ver.eli_consolidation_uri AS old_eli,
    old_art.text AS old_text,
    new_ver.version_id AS new_version_id,
    new_ver.date_applicability AS new_date_applicability,
    new_ver.date_end_applicability AS new_date_end_applicability,
    new_ver.eli_consolidation_uri AS new_eli,
    new_art.text AS new_text
FROM ch_act_change ch
JOIN ch_act a
    ON a.act_id = ch.act_id AND a.enforcement_status = 0
JOIN ch_act_version old_ver ON old_ver.version_id = ch.from_version_id
JOIN ch_act_version new_ver ON new_ver.version_id = ch.to_version_id
JOIN ch_act_article old_art
    ON old_art.version_id = ch.from_version_id AND old_art.e_id = ch.e_id
JOIN ch_act_article new_art
    ON new_art.version_id = ch.to_version_id AND new_art.e_id = ch.e_id
LEFT JOIN LATERAL (
    SELECT al.abbr
      FROM ch_act_alias al
     WHERE al.lang = %(lang)s AND al.sr_number = a.sr_number
     ORDER BY CASE al.source WHEN 'curated' THEN 0 ELSE 1 END, al.abbr
     LIMIT 1
) alias ON %(lang)s <> 'de'
WHERE ch.lang = %(lang)s AND ch.change_type = 'modified'
ORDER BY ch.act_id, ch.change_id
"""

# Skip reasons build() itself can add to make_items()'s own
# "no_discriminating_unit" (see make_items' docstring).
_SKIP_NO_ABBREVIATION = "no_abbreviation"
_SKIP_NEAR_IDENTICAL = "near_identical_or_short"
_SKIP_CAPPED = "capped"


@dataclass(frozen=True)
class BuildReport:
    """One build() run's counts, ready to serialise as build-report.json.

    `per_lang` maps each language to {"changes_considered", "selected",
    "items", "skipped": {reason: n}}. `to_dict()` flattens `per_lang`'s
    entries to the top level alongside seed/caps/built_at, matching the
    file's documented shape ({lang: {...}, ..., seed, caps, built_at}) --
    see the plan's "### Item (JSONL line)" section.
    """

    per_lang: dict[str, dict[str, Any]]
    seed: int
    caps: dict[str, int]
    built_at: str

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = dict(self.per_lang)
        result["seed"] = self.seed
        result["caps"] = dict(self.caps)
        result["built_at"] = self.built_at
        return result


def _build_lang(rows: list[Mapping[str, Any]], lang: str, per_lang_cap: int,
                per_act_cap: int, rng: random.Random,
                ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """No I/O: given the rows _CHANGE_SQL already fetched for one language,
    run the full selection pipeline and return (items, lang_report).

    Pipeline: (1) drop rows with no abbreviation or that select_change()
    rejects, recording why; (2) shuffle the survivors with RNG (the SAME
    Random instance build() passes to every language in turn, so its state
    carries forward across languages -- see build()'s docstring); (3) cap
    per act (per_act_cap changes) then per language, applying the language
    cap to CHANGES via ceil(per_lang_cap / 2) -- the most one change can
    ever contribute is 2 items (before/after), so that many changes can
    never itself cut a language short of its item cap; (4) call
    make_items() on the survivors, which may drop a `before` or `after` half
    for having no discriminating unit; (5) if the two-per-change ceiling
    still overshoots (only possible when per_lang_cap is odd), trim the
    tail. Items are sorted by id only at the very end, once selection is
    finished, so id order never influences which items get kept.
    """
    changes_considered = len(rows)
    skipped_counts: dict[str, int] = {}

    def _bump(reason: str, n: int = 1) -> None:
        skipped_counts[reason] = skipped_counts.get(reason, 0) + n

    eligible: list[Mapping[str, Any]] = []
    for row in rows:
        abbr = row["abbreviation"]
        if not abbr:
            _bump(_SKIP_NO_ABBREVIATION)
            continue
        if not select_change(row["old_text"], row["new_text"]):
            _bump(_SKIP_NEAR_IDENTICAL)
            continue
        eligible.append(row)

    selected = len(eligible)

    shuffled = list(eligible)
    rng.shuffle(shuffled)

    per_act_counts: dict[Any, int] = {}
    act_capped_rows: list[Mapping[str, Any]] = []
    for row in shuffled:
        act_id = row["act_id"]
        if per_act_counts.get(act_id, 0) >= per_act_cap:
            continue
        per_act_counts[act_id] = per_act_counts.get(act_id, 0) + 1
        act_capped_rows.append(row)
    capped = len(shuffled) - len(act_capped_rows)

    max_changes = math.ceil(per_lang_cap / 2) if per_lang_cap > 0 else 0
    lang_capped_rows = act_capped_rows[:max_changes]
    capped += len(act_capped_rows) - len(lang_capped_rows)
    if capped:
        _bump(_SKIP_CAPPED, capped)

    items: list[dict[str, Any]] = []
    for row in lang_capped_rows:
        change_row = {
            "act_id": row["act_id"],
            "sr_number": row["sr_number"],
            "e_id": row["e_id"],
            "article_number": row["article_number"],
            "date_applicability": row["date_applicability"],
        }
        old_row = {
            "version_id": row["old_version_id"],
            "date_applicability": row["old_date_applicability"],
            "date_end_applicability": row["old_date_end_applicability"],
            "eli_consolidation_uri": row["old_eli"],
            "text": row["old_text"],
        }
        new_row = {
            "version_id": row["new_version_id"],
            "date_applicability": row["new_date_applicability"],
            "date_end_applicability": row["new_date_end_applicability"],
            "eli_consolidation_uri": row["new_eli"],
            "text": row["new_text"],
        }
        row_items, row_skipped = make_items(change_row, old_row, new_row, row["abbreviation"], lang)
        items.extend(row_items)
        for s in row_skipped:
            _bump(s["reason"])

    if per_lang_cap and len(items) > per_lang_cap:
        _bump(_SKIP_CAPPED, len(items) - per_lang_cap)
        items = items[:per_lang_cap]

    items.sort(key=lambda it: it["id"])

    lang_report = {
        "changes_considered": changes_considered,
        "selected": selected,
        "items": len(items),
        "skipped": skipped_counts,
    }
    return items, lang_report


def build(settings: Settings, langs: tuple[str, ...] = ("de", "fr", "it"),
          per_lang_cap: int = 5000, per_act_cap: int = 50,
          seed: int = 20260825, out_dir: str | pathlib.Path = "/data/ch-corpus/bench",
          now: datetime.datetime | None = None) -> BuildReport:
    """Build bench-{lang}.jsonl for each of LANGS plus build-report.json, in
    OUT_DIR, against the database SETTINGS points to.

    One `random.Random(seed)` instance is created here and handed to
    _build_lang() for every language IN ORDER -- not a fresh one per
    language -- so its state carries forward from one language's shuffle
    into the next; the result is deterministic for a given (langs, seed)
    pair but two languages do not draw the identical shuffle order.

    NOW is accepted explicitly (rather than build() and its callees calling
    datetime.now() wherever built_at is needed) so the report's timestamp
    stamping stays a single, injectable decision at the one impure entry
    point -- callers that want a fixed timestamp (tests) pass it; production
    callers (main()) leave it None and get the real wall clock.
    """
    out_path = pathlib.Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)
    built_at = _iso(now)

    rng = random.Random(seed)
    per_lang_report: dict[str, dict[str, Any]] = {}

    conn = db.connect(settings)
    try:
        for lang in langs:
            with conn.cursor() as cur:
                cur.execute(_CHANGE_SQL, {"lang": lang})
                rows = cur.fetchall()
            items, lang_report = _build_lang(rows, lang, per_lang_cap, per_act_cap, rng)
            per_lang_report[lang] = lang_report

            out_file = out_path / f"bench-{lang}.jsonl"
            with out_file.open("w", encoding="utf-8") as f:
                for item in items:
                    f.write(json.dumps(item, ensure_ascii=False))
                    f.write("\n")
    finally:
        conn.close()

    report = BuildReport(
        per_lang=per_lang_report,
        seed=seed,
        caps={"per_lang_cap": per_lang_cap, "per_act_cap": per_act_cap},
        built_at=built_at,
    )
    (out_path / "build-report.json").write_text(
        json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return report


def main(argv: list[str] | None = None) -> BuildReport:
    """Entry point: `python -m chpipe.bench.build --langs de,fr,it --out DIR`.

    Not a run-stage.sh dispatch target (see chpipe/stages/*_stage.py, whose
    entry points all read CHPIPE_SPIDER/CHPIPE_LIMIT and are wired into that
    script's case statement -- this one is not, and test_entry_points.py's
    fixed set of accepted stage names is not touched by this task). The
    benchmark build is an occasional export a human runs by hand, with its
    own flags, not a nightly pipeline stage.
    """
    parser = argparse.ArgumentParser(
        description="Build the CH point-in-time benchmark JSONL files")
    parser.add_argument("--langs", default="de,fr,it",
                        help="comma-separated language codes (default: de,fr,it)")
    parser.add_argument("--out", default="/data/ch-corpus/bench",
                        help="output directory (default: /data/ch-corpus/bench)")
    parser.add_argument("--per-lang-cap", type=int, default=5000)
    parser.add_argument("--per-act-cap", type=int, default=50)
    parser.add_argument("--seed", type=int, default=20260825)
    args = parser.parse_args(argv)

    langs = tuple(part.strip() for part in args.langs.split(",") if part.strip())

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    report = build(settings, langs=langs, per_lang_cap=args.per_lang_cap,
                   per_act_cap=args.per_act_cap, seed=args.seed, out_dir=args.out)
    for lang, stats in report.per_lang.items():
        log.info("bench-%s: changes_considered=%d selected=%d items=%d skipped=%s",
                 lang, stats["changes_considered"], stats["selected"],
                 stats["items"], stats["skipped"])
    return report


if __name__ == "__main__":
    main()
