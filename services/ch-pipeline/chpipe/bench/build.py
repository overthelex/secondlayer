"""Pure item-construction helpers for the CH point-in-time benchmark.

No DB, no I/O -- given the rows Task 3's DB glue will fetch, decide whether
a change is worth turning into a benchmark item, build the item pair, and
give every item a stable id. See docs/superpowers/plans/2026-08-25-ch-pit-benchmark.md,
"### Item (JSONL line)".
"""
from __future__ import annotations

import datetime
import hashlib
from difflib import SequenceMatcher
from typing import Any, Mapping

from chpipe.bench import score, templates

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
