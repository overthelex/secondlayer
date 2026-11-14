"""Read-only gate for phase C of the text cleanup (CHPIPE_RESPLIT=all).

Phase C re-splits every parsed cantonal PDF edition (sources lexwork_pdf,
lexfind, zhlex) from its stored pdftotext output (akn_xml) with
pdf_text.split_text and rewrites its articles. Its first run (2026-11-14)
was rolled back: it lost articles by the thousand (lexfind 1,165,061 ->
1,139,859; zhlex 294662 123 -> 2; lexwork_pdf 90361 137 -> 11). Before the
next run the operator runs this over a prod sample and it must pass.

For each edition it recomputes split_text(akn_xml, lang) and compares the
article numbers to the articles stored today (ch_act_article by ordinal):

  before / after   article counts
  same_sequence    the number sequence is unchanged
  lost             stored numbers the new split does not have (a multiset:
                   "3" twice before, once after is one lost). A bare stored
                   number is kept by the same number with a letter suffix
                   ("43" -> "43a": ZH's "§ 43 a.26" read without its letter
                   by the old splitter). The gate's own rule, written here,
                   not borrowed from pdf_text: the code under test must not
                   grade itself.
  lost_share       len(lost) / before
  kept             the new split has NO article while the edition has some:
                   pdf_text_stage.resplit leaves such a row untouched
                   (report.kept), so it is reported, not counted as a loss.

Skipped, as the stage skips them: a zhlex row whose akn_xml is the WebRT
HTML page (the stage selects zhlex by the notes.zh.ch PDF prefix; the
JSONL mode recognises the HTML by its first character).

Gate (gate_ok), per source and overall:
  LOSING_SHARE_MAX 0.01   at most 1% of the measured editions lose any
                          article number (prod articles may predate the
                          pre-cleanup splitter; a handful may differ)
  LOST_SHARE_P95_MAX 0    p95 of lost_share is zero
  LOST_SHARE_MAX 0.05     no edition loses more than 5% of its numbers
  TOTAL_RATIO_MIN 0.995   sum(after) / sum(before) over the editions
                          rewritten (kept ones excluded)
On the 83-edition sample of the rolled-back run (2026-11-14, 79 measured,
4 zhlex HTML rows skipped): main at 7677971a fails every source (11 of 79
editions lose, lost_share p95 0.50, max 0.98: 294662 123 -> 2, 90361
137 -> 11, 335573 413 -> 199); with the legacy guard in split_text it
passes with 0 losing editions.

Exit 1 when the gate fails or any edition errors, 2 on usage errors. Never
writes (the connection is read-only).

  CHPIPE_DSN=postgresql://... python scripts/cantonal_resplit_check.py \\
      [--source all|lexwork_pdf|lexfind|zhlex] [--limit 200] [--ordered] \\
      [--version-ids 294662,90361] [--json FILE]
  python scripts/cantonal_resplit_check.py --jsonl phasec_sample.jsonl

--dsn overrides CHPIPE_DSN. --limit is per source; the sample is random by
default (--ordered: the first N by version_id). The JSONL mode reads one
edition per line: version_id, source, lang, raw (akn_xml) and before (the
stored articles in order, each with "n" = article_number).
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe import pdf_text  # noqa: E402

SOURCES = ("lexwork_pdf", "lexfind", "zhlex")
# the same prefix pdf_text_stage selects zhlex PDF rows by (its constant is
# not imported: the stage module pulls in the fetch stack)
ZHLEX_PDF_PREFIX = "https://www.notes.zh.ch/appl/zhlex_r.nsf/WebView/"

LOSING_SHARE_MAX = 0.01
LOST_SHARE_P95_MAX = 0.0
LOST_SHARE_MAX = 0.05
TOTAL_RATIO_MIN = 0.995


def lost_numbers(before: list[str], after: list[str]) -> list[str]:
    """Stored numbers the new split does not have (see the module doc)."""
    rest = Counter(after)
    lost = []
    for number in before:
        if rest[number] > 0:
            rest[number] -= 1
            continue
        suffixed = [k for k, n in rest.items() if n > 0 and number.isdigit()
                    and k.startswith(number) and k[len(number):].isalpha()]
        if suffixed:
            rest[suffixed[0]] -= 1
            continue
        lost.append(number)
    return lost


def is_html(raw: str) -> bool:
    return raw.lstrip()[:1] == "<"


def measure(raw: str, lang: str | None, before: list[str]) -> dict:
    articles, _ = pdf_text.split_text(raw, lang)
    after = [a.article_number for a in articles]
    kept = not after and bool(before)
    lost = [] if kept else lost_numbers(before, after)
    return {
        "before": len(before),
        "after": len(before) if kept else len(after),
        "same_sequence": kept or before == after,
        "kept": kept,
        "lost": lost,
        "lost_share": len(lost) / len(before) if before else 0.0,
        "gained": 0 if kept else max(0, len(after) - len(before) + len(lost)),
    }


def _pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(q * (len(ordered) - 1)))))]


def summarise(results: dict[int, dict]) -> dict:
    out: dict = {"n": len(results)}
    if not results:
        return out
    shares = [r["lost_share"] for r in results.values()]
    rewritten = [r for r in results.values() if not r["kept"]]
    before = sum(r["before"] for r in rewritten)
    after = sum(r["after"] for r in rewritten)
    out.update({
        "same": sum(1 for r in results.values() if r["same_sequence"]),
        "gaining": sum(1 for r in results.values() if r["gained"] and not r["lost"]),
        "losing": sum(1 for r in results.values() if r["lost"]),
        "kept": sum(1 for r in results.values() if r["kept"]),
        "losing_share": sum(1 for r in results.values() if r["lost"]) / len(results),
        "lost_share": {"median": statistics.median(shares), "p95": _pct(shares, 0.95),
                       "max": max(shares)},
        "articles_before": before,
        "articles_after": after,
        "total_ratio": after / before if before else 1.0,
        "worst": sorted((v for v in results if results[v]["lost"]),
                        key=lambda v: (results[v]["lost_share"], len(results[v]["lost"])),
                        reverse=True)[:10],
    })
    return out


def gate_ok(summary: dict) -> bool:
    return (summary.get("n", 0) > 0
            and summary["losing_share"] <= LOSING_SHARE_MAX
            and summary["lost_share"]["p95"] <= LOST_SHARE_P95_MAX
            and summary["lost_share"]["max"] <= LOST_SHARE_MAX
            and summary["total_ratio"] >= TOTAL_RATIO_MIN)


def _print(name: str, summary: dict, results: dict[int, dict]) -> None:
    if not summary["n"]:
        print(f"[{name}] editions measured: 0")
        return
    s = summary["lost_share"]
    print(f"[{name}] editions {summary['n']}: same {summary['same']}  gain {summary['gaining']}  "
          f"lose {summary['losing']} ({summary['losing_share']:.3f})  kept {summary['kept']}  "
          f"articles {summary['articles_before']} -> {summary['articles_after']} "
          f"({summary['total_ratio']:.3f})  lost_share median {s['median']:.3f} "
          f"p95 {s['p95']:.3f} max {s['max']:.3f}  -> {'PASS' if gate_ok(summary) else 'FAIL'}")
    for vid in summary["worst"]:
        r = results[vid]
        print(f"    {vid}  {r['before']} -> {r['after']}  lost {len(r['lost'])} "
              f"({r['lost_share']:.2f}) e.g. {r['lost'][:10]}")


def _from_jsonl(path: str, sources: tuple[str, ...], ids: set[int] | None):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row["source"] not in sources or (ids and row["version_id"] not in ids):
                continue
            yield {"version_id": row["version_id"], "source": row["source"], "lang": row.get("lang"),
                   "raw": row["raw"], "before": [a["n"] for a in row["before"]]}


_ROWS = ("SELECT version_id, source, lang, akn_xml AS raw FROM ch_act_version "
         "WHERE source = %s AND stage = 'parsed' AND akn_xml IS NOT NULL ")


def _from_db(dsn: str, sources: tuple[str, ...], limit: int, random_order: bool,
             ids: list[int] | None):
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        conn.read_only = True
        for source in sources:
            sql, params = _ROWS, [source]
            if source == "zhlex":
                sql += "AND xml_url LIKE %s "
                params.append(ZHLEX_PDF_PREFIX.replace("_", "\\_") + "%")
            if ids:
                sql += "AND version_id = ANY(%s) ORDER BY version_id"
                params.append(ids)
            else:
                sql += "ORDER BY " + ("random()" if random_order else "version_id") + " LIMIT %s"
                params.append(limit)
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
            if not rows:
                continue
            with conn.cursor() as cur:
                cur.execute("SELECT version_id, array_agg(article_number ORDER BY ordinal) AS numbers "
                            "FROM ch_act_article WHERE version_id = ANY(%s) GROUP BY version_id",
                            ([r["version_id"] for r in rows],))
                stored = {r["version_id"]: list(r["numbers"]) for r in cur}
            for row in rows:
                row["before"] = [n for n in stored.get(row["version_id"], []) if n is not None]
                yield row


def run(rows, sources: tuple[str, ...]) -> tuple[dict, dict, dict, int]:
    results: dict[str, dict[int, dict]] = {s: {} for s in sources}
    errors: dict[int, str] = {}
    skipped = 0
    for row in rows:
        if is_html(row["raw"]):
            skipped += 1
            continue
        try:
            results[row["source"]][row["version_id"]] = measure(row["raw"], row["lang"], row["before"])
        except Exception as exc:                        # noqa: BLE001
            errors[row["version_id"]] = repr(exc)
    summaries = {s: summarise(r) for s, r in results.items()}
    merged = {v: r for per in results.values() for v, r in per.items()}
    summaries["all"] = summarise(merged)
    return summaries, results, errors, skipped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dsn", default=os.environ.get("CHPIPE_DSN"))
    parser.add_argument("--jsonl", help="read editions from this file instead of the database")
    parser.add_argument("--source", choices=("all",) + SOURCES, default="all")
    parser.add_argument("--limit", type=int, default=200, help="editions per source")
    order = parser.add_mutually_exclusive_group()
    order.add_argument("--random", dest="random", action="store_true", default=True,
                       help="a random sample (the default)")
    order.add_argument("--ordered", dest="random", action="store_false",
                       help="the first N by version_id instead")
    parser.add_argument("--version-ids", default="")
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args(argv)
    sources = SOURCES if args.source == "all" else (args.source,)
    ids = [int(v) for v in args.version_ids.split(",") if v.strip()] or None
    if args.jsonl:
        rows = _from_jsonl(args.jsonl, sources, set(ids) if ids else None)
    elif args.dsn:
        rows = _from_db(args.dsn, sources, args.limit, args.random, ids)
    else:
        print("give --dsn (or CHPIPE_DSN) or --jsonl", file=sys.stderr)
        return 2
    summaries, results, errors, skipped = run(rows, sources)
    for source in sources:
        _print(source, summaries[source], results[source])
    if len(sources) > 1:
        _print("all", summaries["all"], {v: r for per in results.values() for v, r in per.items()})
    if skipped:
        print(f"skipped (akn_xml is HTML, never resplit): {skipped}")
    if errors:
        print(f"errors: {len(errors)} {sorted(errors)[:10]}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(
            {"summary": summaries, "results": results, "errors": errors, "skipped": skipped},
            ensure_ascii=False, indent=1, default=str))
    ok = all(gate_ok(summaries[s]) for s in sources if summaries[s]["n"]) and summaries["all"]["n"] > 0
    print("GATE", "PASS" if ok and not errors else "FAIL")
    return 0 if ok and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
