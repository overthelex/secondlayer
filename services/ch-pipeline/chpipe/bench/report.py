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

from chpipe.bench import score

log = logging.getLogger(__name__)

REPORT_FILENAME = "report.json"

_COLUMNS = ("n", "errors", "correct %", "wrong version %", "ungrounded %",
            "correct % (gold current)", "correct % (gold superseded)",
            "mean gold cov", "mean distractor cov", "score")

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
    """Read PATH as JSONL, tolerating a truncated FINAL line only.

    An interrupted Bedrock run leaves a partial object at the end of its
    results file (run_llm.py repairs it on the next run, but report.py may
    well be pointed at it first). Raising there would mean an interrupted
    run cannot be reported at all, when every completed item in the file is
    perfectly readable. A malformed line ANYWHERE ELSE cannot be explained
    by truncation -- it is corruption, and summarising over it would report
    a quietly short count -- so those still raise. Same rule, and same
    reason, as run_llm._read_jsonl_file().
    """
    lines: list[dict[str, Any]] = []
    raw = path.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(raw):
        line = line.strip()
        if not line:
            continue
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            if i == len(raw) - 1:
                log.warning("%s: dropping a truncated final line (%d chars)",
                            path, len(line))
                break
            raise
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
    lang then system then bucket for a stable, diffable report.

    Both mean coverages are columns, not just the label shares: the shares
    say which bucket an answer fell in, the coverages say how much of each
    edition's discriminating wording it actually reproduced, which is what
    distinguishes a system that quotes the right edition from one that
    gestures at it. CARD.md documents both as reported numbers.
    """
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
                    "{gold_cov:.3f} | {dist_cov:.3f} | {score:.3f} |".format(
                        lang=lang, system=system, kind=kind, n=s["n"],
                        errors=s["errors"],
                        correct=s["share_correct"] * 100,
                        wrong=s["share_wrong"] * 100,
                        ungrounded=s["share_ungrounded"] * 100,
                        cur=s["share_correct_gold_current"] * 100,
                        sup=s["share_correct_gold_superseded"] * 100,
                        gold_cov=s["mean_gold_coverage"],
                        dist_cov=s["mean_distractor_coverage"],
                        score=s["score"],
                    )
                )
    return "\n".join(rows) + "\n"


def _rescore_line(line: dict[str, Any],
                   items_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Return a copy of LINE with `verdict` recomputed from its stored
    `answer` and the item's current gold/distractor text, via the CURRENT
    chpipe.bench.score.score() -- not whatever version of score() scored it
    when the results file was written. Used by --rescore (see main()) to
    re-grade an existing results file against a newer scorer without paying
    to re-run the model.

    LINE is returned unchanged (same object, not a copy) when it cannot be
    rescored: its id is not in ITEMS_BY_ID (an orphan line -- summarise()
    already handles that case by bucketing it under kind "unknown"; rescore
    has no gold/distractor to score it against either), or it carries no
    `answer` field at all. Every line run_llm.py/run_oracle.py write does
    carry `answer` (possibly "" on an error -- see those modules'
    docstrings), so this second case is a defensive fallback, not the
    common path.
    """
    item = items_by_id.get(line.get("id"))
    if item is None or "answer" not in line:
        return line
    verdict = score.score(line["answer"], item["gold"]["text"], item["distractor"]["text"])
    rescored = dict(line)
    rescored["verdict"] = {
        "label": verdict.label,
        "gold_coverage": verdict.gold_coverage,
        "distractor_coverage": verdict.distractor_coverage,
        "shared_coverage": verdict.shared_coverage,
        "distractor_all_coverage": verdict.distractor_all_coverage,
    }
    return rescored


def main(argv: list[str] | None = None) -> dict[str, dict[str, dict[str, dict[str, Any]]]]:
    """Entry point: `python -m chpipe.bench.report --results FILE [FILE ...]
    --items DIR --out report.json [--rescore]`.

    Reads every RESULTS file (one run_*.py output each -- pass more than
    one to compare systems in a single table), reduces them with
    summarise() against the items in --items, prints the Markdown table to
    stdout, and writes the summary as JSON to --out.

    --rescore: before summarising, recompute every line's `verdict` from its
    stored `answer` and the item's gold/distractor text with the CURRENT
    score() (see _rescore_line()) -- e.g. after a scorer fix, to see how an
    already-run, already-paid-for results file grades under the new rule
    without re-asking the model. The report and the returned summary are
    then built from the recomputed verdicts. The input RESULTS files
    themselves are left untouched -- their stored verdicts are exactly what
    was written when the run finished -- and each recomputed line set is
    instead written to a sibling `<results>.rescored.jsonl` file next to its
    input, so the rescored verdicts are inspectable on their own.
    """
    parser = argparse.ArgumentParser(
        description="Summarise CH point-in-time benchmark run(s)")
    parser.add_argument("--results", nargs="+", required=True,
                        help="one or more results-*.jsonl files")
    parser.add_argument("--items", required=True,
                        help="directory holding bench-{lang}.jsonl item files")
    parser.add_argument("--out", default=REPORT_FILENAME,
                        help=f"path to write the JSON summary to (default: {REPORT_FILENAME})")
    parser.add_argument("--rescore", action="store_true",
                        help="recompute each line's verdict from its answer with the "
                             "current score() before summarising, writing "
                             "<results>.rescored.jsonl next to each input (the input "
                             "files themselves are left untouched)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    items_by_id = load_items_by_id(args.items)
    result_lines: list[dict[str, Any]] = []
    for path_str in args.results:
        path = pathlib.Path(path_str)
        lines = _read_jsonl(path)
        if args.rescore:
            lines = [_rescore_line(line, items_by_id) for line in lines]
            rescored_path = path.with_suffix(".rescored.jsonl")
            rescored_path.write_text(
                "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n"
                if lines else "",
                encoding="utf-8")
            log.info("rescored %d lines: %s -> %s", len(lines), path, rescored_path)
        result_lines.extend(lines)

    summary = summarise(result_lines, items_by_id)
    md = markdown(summary)
    print(md)
    pathlib.Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


if __name__ == "__main__":
    main()
