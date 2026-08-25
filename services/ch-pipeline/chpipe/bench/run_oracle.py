"""The oracle system for the CH point-in-time benchmark: answers every item
straight from the database, the same way the product tool `ch_get_act_article`
does (see mcp_backend/src/api/tools/ch-legislation-tools.ts's getActArticle),
with no LLM in the loop. Its whole purpose is to prove the builder and the
scorer are correct: if the oracle is not scored 100% `grounded_correct` on
its own benchmark, either build.py picked an edition/article pair that is
not actually resolvable the way the product tool resolves it, or score.py's
matching is wrong -- not that the "model" (the DB itself) got the date
wrong.

Selection, identical to getActArticle:
  * act: `ch_act` by `sr_number`, preferring `enforcement_status = 0` then
    the latest `date_entry_force` when more than one row shares the number.
  * edition: the `stage = 'parsed'` `ch_act_version` of that act (and lang)
    with `date_applicability <= as_of AND (date_end_applicability IS NULL
    OR as_of < date_end_applicability)`, latest `date_applicability` first.
  * article: the `ch_act_article` row in that edition with
    `article_number = item.article_number`, preferring the top-level e_id
    (`ORDER BY (e_id LIKE '%/%'), ordinal`).

If any step comes up empty the answer is "" and the result line carries an
`oracle_error` naming which step failed -- "act_not_found",
"no_edition_for_date" or "article_not_found" -- rather than raising, so one
bad item (e.g. a hand-crafted out-of-range as_of, used in tests to exercise
this path) does not abort the whole run.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import pathlib
from typing import Any

from chpipe import db
from chpipe.bench import score
from chpipe.config import Settings

log = logging.getLogger(__name__)

RESULTS_FILENAME = "results-oracle.jsonl"

_ACT_SQL = """
SELECT act_id
  FROM ch_act
 WHERE sr_number = %(sr_number)s
 ORDER BY enforcement_status = 0 DESC, date_entry_force DESC NULLS LAST
 LIMIT 1
"""

_EDITION_SQL = """
SELECT version_id
  FROM ch_act_version
 WHERE act_id = %(act_id)s AND lang = %(lang)s AND stage = 'parsed'
   AND date_applicability <= %(as_of)s::date
   AND (date_end_applicability IS NULL OR %(as_of)s::date < date_end_applicability)
 ORDER BY date_applicability DESC
 LIMIT 1
"""

_ARTICLE_SQL = """
SELECT e_id, text
  FROM ch_act_article
 WHERE version_id = %(version_id)s AND article_number = %(article_number)s
 ORDER BY (e_id LIKE '%%/%%'), ordinal
 LIMIT 1
"""


@dataclasses.dataclass(frozen=True)
class RunReport:
    """One run()'s counts, ready to log or assert on.

    ITEMS is the number of items read; ANSWERED is how many resolved to a
    real article text (no `oracle_error`); ERRORS is how many did not.
    ANSWERED + ERRORS == ITEMS always.
    """

    items: int
    answered: int
    errors: int


def _lookup(cur, item: dict[str, Any]) -> tuple[str, str | None]:
    """Resolve ITEM's (sr_number, article_number, lang, as_of) to article
    text the same way getActArticle would. Returns (answer, oracle_error);
    ANSWER is "" and ORACLE_ERROR is set when any selection step fails."""
    cur.execute(_ACT_SQL, {"sr_number": item["sr_number"]})
    act = cur.fetchone()
    if act is None:
        return "", "act_not_found"

    cur.execute(_EDITION_SQL, {
        "act_id": act["act_id"], "lang": item["lang"], "as_of": item["as_of"],
    })
    edition = cur.fetchone()
    if edition is None:
        return "", "no_edition_for_date"

    cur.execute(_ARTICLE_SQL, {
        "version_id": edition["version_id"], "article_number": item["article_number"],
    })
    article = cur.fetchone()
    if article is None:
        return "", "article_not_found"

    return article["text"], None


def _read_items(items_path: pathlib.Path, langs: tuple[str, ...]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for lang in langs:
        f = items_path / f"bench-{lang}.jsonl"
        if not f.exists():
            continue
        with f.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
    return items


def run(settings: Settings, items_path: str | pathlib.Path, out_path: str | pathlib.Path,
        langs: tuple[str, ...] = ("de", "fr", "it")) -> RunReport:
    """Answer every item in `{items_path}/bench-{lang}.jsonl` (for each LANG
    in LANGS) from the database SETTINGS points to, score each answer with
    chpipe.bench.score.score() against its own gold/distractor, and write
    `{out_path}/results-oracle.jsonl`, one line per item:
    `{id, system: "oracle", lang, answer, verdict: {label, gold_coverage,
    distractor_coverage, shared_coverage}, oracle_error?}`.

    Scoring happens inside this run (not a separate pass) because the
    oracle's answer is never persisted anywhere else -- unlike an LLM run,
    which records the raw answer for a human to re-score later, there is
    nothing to re-score: the oracle's answer is deterministic given the
    database.
    """
    items_dir = pathlib.Path(items_path)
    out_dir = pathlib.Path(out_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    items = _read_items(items_dir, langs)

    answered = 0
    errors = 0
    results: list[dict[str, Any]] = []

    conn = db.connect(settings)
    try:
        with conn.cursor() as cur:
            for item in items:
                answer, oracle_error = _lookup(cur, item)
                verdict = score.score(answer, item["gold"]["text"], item["distractor"]["text"])

                result: dict[str, Any] = {
                    "id": item["id"],
                    "system": "oracle",
                    "lang": item["lang"],
                    "answer": answer,
                    "verdict": {
                        "label": verdict.label,
                        "gold_coverage": verdict.gold_coverage,
                        "distractor_coverage": verdict.distractor_coverage,
                        "shared_coverage": verdict.shared_coverage,
                    },
                }
                if oracle_error is not None:
                    result["oracle_error"] = oracle_error
                    errors += 1
                else:
                    answered += 1
                results.append(result)
    finally:
        conn.close()

    out_file = out_dir / RESULTS_FILENAME
    with out_file.open("w", encoding="utf-8") as f:
        for result in results:
            f.write(json.dumps(result, ensure_ascii=False))
            f.write("\n")

    return RunReport(items=len(items), answered=answered, errors=errors)


def main(argv: list[str] | None = None) -> RunReport:
    """Entry point: `python -m chpipe.bench.run_oracle --items DIR --out DIR
    --langs de,fr,it`.

    Not a run-stage.sh dispatch target -- see build.main()'s docstring for
    the same reasoning: the benchmark is an occasional export/run a human
    triggers by hand, not a nightly pipeline stage.
    """
    parser = argparse.ArgumentParser(
        description="Run the oracle over the CH point-in-time benchmark items")
    parser.add_argument("--items", required=True,
                        help="directory holding bench-{lang}.jsonl item files")
    parser.add_argument("--out", required=True,
                        help="directory to write results-oracle.jsonl into")
    parser.add_argument("--langs", default="de,fr,it",
                        help="comma-separated language codes (default: de,fr,it)")
    args = parser.parse_args(argv)

    langs = tuple(part.strip() for part in args.langs.split(",") if part.strip())

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    report = run(settings, items_path=args.items, out_path=args.out, langs=langs)
    log.info("oracle run: items=%d answered=%d errors=%d",
             report.items, report.answered, report.errors)
    return report


if __name__ == "__main__":
    main()
