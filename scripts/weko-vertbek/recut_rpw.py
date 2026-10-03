"""Cut the journal's decisions again, from the issue PDF in reading order.

The passages of ch_weko_audit_passages were cut from text extracted with
pdftotext -layout. For the two-column journal (RPW) that text runs across the
columns, and so do 1,200-character windows of it: a passage holds the bottom
of one column and the top of the other, and the vectors were computed on
that. The reader was already shown reading-order text (packet.view); this
makes retrieval work on it too.

For each RPW decision: the text of its pages from the issue PDF without
-layout (reading order), page furniture dropped, line breaks joined. Those
pages also carry the end of the previous decision and the start of the next,
so the decision's own span is found by its words: the stored (layout) text
is this decision and nothing else, and the densest run of its word 4-grams
in the reading-order pages marks where it lies.

Writes ch_weko_audit_passages_v2: every non-journal passage copied as it is
(same ecli, ord, text -- their vectors are reused), the journal re-cut. The
v1 table stays, so earlier results can be reproduced.

    python3 recut_rpw.py --dsn ... [--limit 20] [--report recut.json]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import packet  # noqa: E402
from retrieve import passages_of  # noqa: E402

V2 = "ch_weko_audit_passages_v2"
GAP = 200            # tokens: a hit further than this from the run starts a new run


def tokens(text: str) -> list[tuple[str, int, int]]:
    return [(m.group(0).lower(), m.start(), m.end()) for m in re.finditer(r"[^\W\d_]+|\d+", text)]


def own_span(clean: str, layout: str) -> tuple[str, float]:
    """The decision's stretch of the reading-order pages, and the share of
    its words that the stretch holds."""
    toks = tokens(clean)
    lw = [t[0] for t in tokens(packet.dehyphenate(packet.two_columns(layout)))]
    grams = {tuple(lw[i:i + 4]) for i in range(len(lw) - 3)}
    if not grams or len(toks) < 4:
        return "", 0.0
    hits = [i for i in range(len(toks) - 3) if tuple(t[0] for t in toks[i:i + 4]) in grams]
    if not hits:
        return "", 0.0
    best, run_start, best_span = 0, 0, (hits[0], hits[0])
    for j in range(1, len(hits) + 1):
        if j == len(hits) or hits[j] - hits[j - 1] > GAP:
            if j - run_start > best:
                best, best_span = j - run_start, (hits[run_start], hits[j - 1])
            run_start = j
    lo, hi = best_span
    a = toks[lo][1]
    b = toks[min(len(toks) - 1, hi + 3)][2]
    # start at the beginning of the line, end at the end of the line
    a = clean.rfind("\n", 0, a) + 1
    nl = clean.find("\n", b)
    b = len(clean) if nl < 0 else nl
    span = clean[a:b].strip()
    # Coverage on words, not 4-grams: a layout text read across the columns
    # breaks the 4-grams that straddle them, and a correct span then scored
    # 0.33-0.48. The share of the decision's words (as a multiset) that the
    # span holds does not depend on the order they were extracted in.
    import collections
    want = collections.Counter(lw)
    have = collections.Counter(t[0] for t in tokens(span))
    return span, sum((want & have).values()) / max(sum(want.values()), 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--min-coverage", type=float, default=0.8)
    ap.add_argument("--report", type=pathlib.Path, default=pathlib.Path("/data/ch-corpus/weko-bek/recut_rpw.json"))
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row, autocommit=True)
    conn.execute("SET statement_timeout = 0")
    rows = conn.execute("""
        SELECT a.ecli, a.full_text,
               c.metadata_json->'rpw'->>'issue_key' AS issue_key,
               (c.metadata_json->'rpw'->>'pdf_page')::int AS pdf_page,
               c.metadata_json->'rpw'->'journal_pages' AS journal_pages
          FROM ch_weko_audit_corpus a JOIN ch_court_decisions c USING (ecli)
         WHERE a.spider = 'CH_WEKO_RPW' AND coalesce(a.rpw_chapter, '') <> 'D1'
         ORDER BY a.ecli""").fetchall()[: args.limit]

    report, cut = [], {}
    for r in rows:
        pages = r["journal_pages"] or []
        first = r["pdf_page"]
        last = first + (pages[-1] - pages[0] if len(pages) > 1 else 0)
        clean = packet.journal_pages_text(r["issue_key"], first, last) if first else ""
        text, cov = own_span(clean, r["full_text"] or "")
        ok = bool(text) and cov >= args.min_coverage
        report.append({"ecli": r["ecli"], "coverage": round(cov, 3), "chars_layout": len(r["full_text"] or ""),
                       "chars_reading": len(text), "used": "reading" if ok else "layout_columns"})
        # below the bar: the layout text in column order, the best the stored text offers
        cut[r["ecli"]] = text if ok else packet.dehyphenate(packet.two_columns(r["full_text"] or ""))

    used = sum(1 for x in report if x["used"] == "reading")
    covs = sorted(x["coverage"] for x in report)
    print(f"{len(report)} journal decisions: reading order {used}, fallback {len(report) - used}; "
          f"coverage median {covs[len(covs) // 2]:.2f}, p10 {covs[len(covs) // 10]:.2f}")
    args.report.write_text(json.dumps(report, indent=1))
    if args.limit:
        for x in report[:10]:
            print("   ", x)
        return 0

    conn.execute(f"DROP TABLE IF EXISTS {V2}")
    conn.execute(f"CREATE TABLE {V2} (LIKE ch_weko_audit_passages INCLUDING ALL)")
    conn.execute(f"""INSERT INTO {V2} SELECT p.* FROM ch_weko_audit_passages p
                     JOIN ch_weko_audit_corpus a USING (ecli) WHERE a.spider <> 'CH_WEKO_RPW'""")
    n = 0
    with conn.cursor() as cur:
        for ecli, text in cut.items():
            chunks = passages_of(text)
            cur.executemany(f"INSERT INTO {V2} (ecli, ord, text, tsv) VALUES (%s, %s, %s, to_tsvector('german', %s))",
                            [(ecli, i, c, c) for i, c in enumerate(chunks)])
            n += len(chunks)
    conn.execute(f"ANALYZE {V2}")
    total = conn.execute(f"SELECT count(*) AS n FROM {V2}").fetchone()["n"]
    print(f"{V2}: {n} journal passages re-cut, {total} passages in all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
