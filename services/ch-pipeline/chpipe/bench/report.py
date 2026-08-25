"""Summarise CH point-in-time benchmark run(s) into per-(lang, system, kind)
label shares, mean coverages, and the "point-in-time grounding score" (share
of `grounded_correct`).

Pure aggregation, no DB: `summarise()` takes the already-scored result lines
any run_*.py module writes (run_oracle.py and run_llm.py) plus the items they
were scored against, and reduces them to one row per (lang, system, kind)
plus an "all" row per (lang, system). `markdown()` renders that as a table;
`main()` is the CLI glue that reads one or more results files and an items
directory and does both -- prints the table and writes report.json.

WHY THE SPLITS EXIST
A single headline number per (lang, system) hides the two ways this
benchmark can be gamed by accident:

  * `kind`. `before` items ask about the wording that was replaced;
    `after` items ask about the wording that replaced it. A system with no
    notion of time scores very differently on the two, and averaging them
    reports a middling number for a model that is simply reciting one side.
  * `gold_is_current`. When the gold edition is still the edition in force
    today, quoting today's text is correct BY COINCIDENCE -- no date
    reasoning required. Only the share on items whose gold has been
    superseded measures point-in-time grounding at all. Both shares are
    reported; the second is the one to read.

WHY LINES ARE DEDUPED
`run_llm.py` re-asks an item that errored on an earlier, interrupted run and
appends the new answer, so a results file can hold more than one line for the
same id. summarise() keeps, per (lang, system, id), the LAST error-free line
-- or, if every line for that id errored, the last line -- so a re-asked item
is counted once, with its final outcome.
"""
from __future__ import annotations

import argparse
import json
import logging
import pathlib
from typing import Any

log = logging.getLogger(__name__)

REPORT_FILENAME = "report.json"

_COLUMNS = ("n", "errors", "correct %", "wrong version %", "ungrounded %",
            "correct % (gold current)", "correct % (gold superseded)", "score")

# The "all" bucket's key in a (lang, system) entry, alongside one key per
# `kind`. Not sorted alphabetically with the kinds -- "after" would sort
# ahead of it -- but pinned first by _bucket_order(), so the totals row
# always leads its (lang, system) block.
ALL = "all"


def _bucket_order(buckets) -> list[str]:
    """"all" first, then every kind alphabetically."""
    return sorted(buckets, key=lambda k: (k != ALL, k))

# Both keys a result line can carry to say the system failed on this item:
# run_llm.py writes `error` (an exception from Bedrock), run_oracle.py
# writes `oracle_error` (a resolution step that came up empty).
_ERROR_KEYS = ("error", "oracle_error")


def _read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                lines.append(json.loads(line))
    return lines


def load_items_by_id(items_dir: str | pathlib.Path) -> dict[str, dict[str, Any]]:
    """Read every `bench-*.jsonl` file in ITEMS_DIR into one {id: item} map.

    Used by main() (and available to callers that already have an items
    directory rather than a single language's file) to resolve a result
    line's `lang`, `kind` and `gold_is_current` -- a result line carries
    none of the last two, and not every system stamps the first.
    """
    items: dict[str, dict[str, Any]] = {}
    for f in sorted(pathlib.Path(items_dir).glob("bench-*.jsonl")):
        for item in _read_jsonl(f):
            items[item["id"]] = item
    return items


def _has_error(line: dict[str, Any]) -> bool:
    return any(key in line for key in _ERROR_KEYS)


def _stats(lines: list[dict[str, Any]],
           items_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """One bucket's numbers. LINES are already deduped by id."""
    n = len(lines)
    counts = {"grounded_correct": 0, "grounded_wrong_version": 0, "ungrounded": 0}
    gold_sum = 0.0
    distractor_sum = 0.0
    errors = 0
    n_current = correct_current = 0
    n_superseded = correct_superseded = 0

    for line in lines:
        verdict = line["verdict"]
        label = verdict["label"]
        counts[label] += 1
        gold_sum += verdict["gold_coverage"]
        distractor_sum += verdict["distractor_coverage"]
        if _has_error(line):
            errors += 1

        item = items_by_id.get(line.get("id"))
        is_current = item.get("gold_is_current") if item else None
        if is_current is True:
            n_current += 1
            if label == "grounded_correct":
                correct_current += 1
        elif is_current is False:
            n_superseded += 1
            if label == "grounded_correct":
                correct_superseded += 1

    share_correct = counts["grounded_correct"] / n if n else 0.0
    return {
        "n": n,
        "errors": errors,
        "grounded_correct": counts["grounded_correct"],
        "grounded_wrong_version": counts["grounded_wrong_version"],
        "ungrounded": counts["ungrounded"],
        "share_correct": share_correct,
        "share_wrong": counts["grounded_wrong_version"] / n if n else 0.0,
        "share_ungrounded": counts["ungrounded"] / n if n else 0.0,
        "mean_gold_coverage": gold_sum / n if n else 0.0,
        "mean_distractor_coverage": distractor_sum / n if n else 0.0,
        "n_gold_current": n_current,
        "correct_gold_current": correct_current,
        "share_correct_gold_current": correct_current / n_current if n_current else 0.0,
        "n_gold_superseded": n_superseded,
        "correct_gold_superseded": correct_superseded,
        "share_correct_gold_superseded": (
            correct_superseded / n_superseded if n_superseded else 0.0),
        "score": share_correct,
    }


def summarise(result_lines: list[dict[str, Any]],
              items_by_id: dict[str, dict[str, Any]] = {},  # noqa: B006 -- read-only
              ) -> dict[str, dict[str, dict[str, dict[str, Any]]]]:
    """Reduce RESULT_LINES (each `{id, system, verdict: {label,
    gold_coverage, distractor_coverage, ...}, lang?, error?, oracle_error?}`)
    to `{lang: {system: {"all"|kind: stats}}}`.

    ITEMS_BY_ID resolves what the result lines do not carry: `lang` (for a
    system that does not stamp one), `kind` and `gold_is_current`. It
    defaults to empty -- a caller with no item files still gets label
    shares, just with every line bucketed under kind "unknown" and both
    gold_is_current splits empty. A line whose id is in neither the line
    itself nor ITEMS_BY_ID is grouped under lang "unknown" rather than
    dropped, so a wiring bug shows up as a visible bucket instead of a
    silently short count.

    Lines are deduped per (lang, system, id) keeping the last error-free
    one -- see the module docstring, "WHY LINES ARE DEDUPED".

    Each STATS dict: `n` (items scored), `errors` (of those, how many the
    system failed on), the three label counts (`grounded_correct`,
    `grounded_wrong_version`, `ungrounded`), their shares of `n`
    (`share_correct`, `share_wrong`, `share_ungrounded`),
    `mean_gold_coverage`, `mean_distractor_coverage`, the gold_is_current
    split (`n_gold_current`/`correct_gold_current`/
    `share_correct_gold_current` and the `_gold_superseded` mirror), and
    `score` -- identical to `share_correct`, named separately because it is
    the one number the benchmark is reported by (the "point-in-time
    grounding score"), and keeping it under its own key means a reader of
    report.json does not have to know that fact to find it.
    """
    # (lang, system) -> id -> line, last error-free line winning.
    groups: dict[tuple[str, str], dict[Any, dict[str, Any]]] = {}
    for line in result_lines:
        item = items_by_id.get(line.get("id"))
        lang = line.get("lang")
        if lang is None:
            lang = item["lang"] if item else "unknown"
        key = (lang, line["system"])
        by_id = groups.setdefault(key, {})
        previous = by_id.get(line["id"])
        # Last line wins, EXCEPT that an error-free line is never displaced
        # by a later errored one for the same id.
        if previous is None or not _has_error(line) or _has_error(previous):
            by_id[line["id"]] = line

    summary: dict[str, dict[str, dict[str, dict[str, Any]]]] = {}
    for (lang, system), by_id in sorted(groups.items()):
        lines = list(by_id.values())
        buckets: dict[str, list[dict[str, Any]]] = {ALL: lines}
        for line in lines:
            item = items_by_id.get(line.get("id"))
            kind = item.get("kind", "unknown") if item else "unknown"
            buckets.setdefault(kind, []).append(line)
        summary.setdefault(lang, {})[system] = {
            bucket: _stats(buckets[bucket], items_by_id)
            for bucket in _bucket_order(buckets)
        }

    return summary


def markdown(summary: dict[str, dict[str, dict[str, dict[str, Any]]]]) -> str:
    """Render SUMMARISE()'s output as a Markdown table, one row per (lang,
    system, kind) with the (lang, system) totals on an `all` row, sorted by
    lang then system then bucket for a stable, diffable report."""
    header = "| lang | system | kind | " + " | ".join(_COLUMNS) + " |"
    separator = "| --- | --- | --- | " + " | ".join("---" for _ in _COLUMNS) + " |"
    rows = [header, separator]
    for lang in sorted(summary):
        for system in sorted(summary[lang]):
            for kind in _bucket_order(summary[lang][system]):
                s = summary[lang][system][kind]
                rows.append(
                    "| {lang} | {system} | {kind} | {n} | {errors} | {correct:.1f} | "
                    "{wrong:.1f} | {ungrounded:.1f} | {cur:.1f} | {sup:.1f} | "
                    "{score:.3f} |".format(
                        lang=lang, system=system, kind=kind, n=s["n"],
                        errors=s["errors"],
                        correct=s["share_correct"] * 100,
                        wrong=s["share_wrong"] * 100,
                        ungrounded=s["share_ungrounded"] * 100,
                        cur=s["share_correct_gold_current"] * 100,
                        sup=s["share_correct_gold_superseded"] * 100,
                        score=s["score"],
                    )
                )
    return "\n".join(rows) + "\n"


def main(argv: list[str] | None = None) -> dict[str, dict[str, dict[str, dict[str, Any]]]]:
    """Entry point: `python -m chpipe.bench.report --results FILE [FILE ...]
    --items DIR --out report.json`.

    Reads every RESULTS file (one run_*.py output each -- pass more than
    one to compare systems in a single table), reduces them with
    summarise() against the items in --items, prints the Markdown table to
    stdout, and writes the summary as JSON to --out.
    """
    parser = argparse.ArgumentParser(
        description="Summarise CH point-in-time benchmark run(s)")
    parser.add_argument("--results", nargs="+", required=True,
                        help="one or more results-*.jsonl files")
    parser.add_argument("--items", required=True,
                        help="directory holding bench-{lang}.jsonl item files")
    parser.add_argument("--out", default=REPORT_FILENAME,
                        help=f"path to write the JSON summary to (default: {REPORT_FILENAME})")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    items_by_id = load_items_by_id(args.items)
    result_lines: list[dict[str, Any]] = []
    for path in args.results:
        result_lines.extend(_read_jsonl(pathlib.Path(path)))

    summary = summarise(result_lines, items_by_id)
    md = markdown(summary)
    print(md)
    pathlib.Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


if __name__ == "__main__":
    main()
