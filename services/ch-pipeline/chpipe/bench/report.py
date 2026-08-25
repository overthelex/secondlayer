"""Summarise CH point-in-time benchmark run(s) into per-(lang, system) label
shares, mean coverages, and the "point-in-time grounding score" (share of
`grounded_correct`).

Pure aggregation, no DB: `summarise()` takes the already-scored result lines
any run_*.py module writes (run_oracle.py today; run_llm.py, scoring
separately, later) plus the items they were scored against, and reduces them
to one row per (lang, system). `markdown()` renders that as a table; `main()`
is the CLI glue that reads one or more results files and an items directory
and does both -- prints the table and writes report.json.
"""
from __future__ import annotations

import argparse
import json
import logging
import pathlib
from typing import Any

log = logging.getLogger(__name__)

REPORT_FILENAME = "report.json"

_COLUMNS = ("n", "correct %", "wrong version %", "ungrounded %", "score")


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
    line's `lang` when the result itself does not carry one -- run_oracle.py
    always stamps `lang`, but summarise()'s contract does not require every
    system to.
    """
    items: dict[str, dict[str, Any]] = {}
    for f in sorted(pathlib.Path(items_dir).glob("bench-*.jsonl")):
        for item in _read_jsonl(f):
            items[item["id"]] = item
    return items


def summarise(result_lines: list[dict[str, Any]],
             items_by_id: dict[str, dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    """Reduce RESULT_LINES (each `{id, system, verdict: {label, gold_coverage,
    distractor_coverage, ...}, lang?}`) to `{lang: {system: stats}}`.

    ITEMS_BY_ID resolves `lang` for a result line that does not carry its
    own (see load_items_by_id's docstring); a line whose id is in neither
    the line itself nor ITEMS_BY_ID is grouped under lang "unknown" rather
    than dropped, so a wiring bug shows up as a visible bucket instead of a
    silently short count.

    Each STATS dict: `n` (items scored), the three label counts
    (`grounded_correct`, `grounded_wrong_version`, `ungrounded`), their
    shares of `n` (`share_correct`, `share_wrong`, `share_ungrounded`),
    `mean_gold_coverage`, `mean_distractor_coverage`, and `score` --
    identical to `share_correct`, named separately because it is the one
    number the benchmark is reported by (the "point-in-time grounding
    score"), and keeping it under its own key means a reader of report.json
    does not have to know that fact to find it.
    """
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for line in result_lines:
        lang = line.get("lang")
        if lang is None:
            item = items_by_id.get(line.get("id"))
            lang = item["lang"] if item else "unknown"
        system = line["system"]
        groups.setdefault((lang, system), []).append(line)

    summary: dict[str, dict[str, dict[str, Any]]] = {}
    for (lang, system), lines in sorted(groups.items()):
        n = len(lines)
        counts = {"grounded_correct": 0, "grounded_wrong_version": 0, "ungrounded": 0}
        gold_sum = 0.0
        distractor_sum = 0.0
        for line in lines:
            verdict = line["verdict"]
            counts[verdict["label"]] += 1
            gold_sum += verdict["gold_coverage"]
            distractor_sum += verdict["distractor_coverage"]

        share_correct = counts["grounded_correct"] / n if n else 0.0
        share_wrong = counts["grounded_wrong_version"] / n if n else 0.0
        share_ungrounded = counts["ungrounded"] / n if n else 0.0

        stats = {
            "n": n,
            "grounded_correct": counts["grounded_correct"],
            "grounded_wrong_version": counts["grounded_wrong_version"],
            "ungrounded": counts["ungrounded"],
            "share_correct": share_correct,
            "share_wrong": share_wrong,
            "share_ungrounded": share_ungrounded,
            "mean_gold_coverage": gold_sum / n if n else 0.0,
            "mean_distractor_coverage": distractor_sum / n if n else 0.0,
            "score": share_correct,
        }
        summary.setdefault(lang, {})[system] = stats

    return summary


def markdown(summary: dict[str, dict[str, dict[str, Any]]]) -> str:
    """Render SUMMARISE()'s output as a Markdown table, one row per (lang,
    system), sorted by lang then system for a stable, diffable report."""
    header = "| lang | system | " + " | ".join(_COLUMNS) + " |"
    separator = "| --- | --- | " + " | ".join("---" for _ in _COLUMNS) + " |"
    rows = [header, separator]
    for lang in sorted(summary):
        for system in sorted(summary[lang]):
            s = summary[lang][system]
            rows.append(
                "| {lang} | {system} | {n} | {correct:.1f} | {wrong:.1f} | "
                "{ungrounded:.1f} | {score:.3f} |".format(
                    lang=lang, system=system, n=s["n"],
                    correct=s["share_correct"] * 100,
                    wrong=s["share_wrong"] * 100,
                    ungrounded=s["share_ungrounded"] * 100,
                    score=s["score"],
                )
            )
    return "\n".join(rows) + "\n"


def main(argv: list[str] | None = None) -> dict[str, dict[str, dict[str, Any]]]:
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
