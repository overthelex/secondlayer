"""Raw-vs-clean A/B for citation extraction and text quality (read-only).

Guard before the CH PDF-decision backfill: shows that text_clean.clean_pdf_text
does not break the tuned citation extractors or lower text quality.

  --sample FILE   the Task 0 sample (scripts/text_damage_probe.py); only its
                  "decisions" part is used; EXCLUDED_SPIDERS are dropped.
  --raw-dir DIR   optional raw-text archive; a row that has an archive is
                  compared from the archived raw text.
  --out FILE      optional JSON report (the only file this script writes).

ASSUMPTION: until the backfill has run, ch_court_decisions.full_text is still
the raw pdftotext output for every row, so reading full_text gives the raw
side. Once rows are cleaned, pass --raw-dir so the archive supplies the raw.

Compared per document: citations.extract_cases keys (kind, raw),
citations.extract_statutes keys (abbr, article), text_quality.score and
text_damage.markers, on raw vs clean_pdf_text(raw, languages). Languages per
row follow clean_text_stage.languages_for (Sprache first).

Exit 1 when: the sample compares 0 documents; any document errors; aggregate
citations after < 0.99 x before; lost keys (per-document, not masked by gains
elsewhere) > 1% of before; or mean quality drops by more than 0.01.
"""
import argparse
import json
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe import citations, raw_text_archive, text_clean, text_quality  # noqa: E402
from chpipe.stages.clean_text_stage import languages_for  # noqa: E402
from chpipe.text_damage import markers  # noqa: E402
from text_damage_probe import EXCLUDED_SPIDERS  # noqa: E402

CIT_RATIO_MIN = 0.99
QUALITY_DROP_MAX = 0.01


def case_keys(text):
    return {(c.kind, c.raw) for c in citations.extract_cases(text)}


def statute_keys(text):
    return {(s.abbr, s.article) for s in citations.extract_statutes(text)}


def compare_text(raw, languages):
    """Pure comparison of one document, raw vs cleaned. No DB."""
    clean = text_clean.clean_pdf_text(raw, languages)
    cases_b, cases_a = case_keys(raw), case_keys(clean)
    stat_b, stat_a = statute_keys(raw), statute_keys(clean)
    return {
        "cases_before": len(cases_b), "cases_after": len(cases_a),
        "statutes_before": len(stat_b), "statutes_after": len(stat_a),
        "cases_lost": sorted(cases_b - cases_a), "statutes_lost": sorted(stat_b - stat_a),
        "quality_before": text_quality.score(raw, languages),
        "quality_after": text_quality.score(clean, languages),
        "markers_before": markers(raw), "markers_after": markers(clean),
    }


def _lost(d):
    return len(d["cases_lost"]) + len(d["statutes_lost"])


def aggregate(docs, errors=()):
    n = len(docs)
    s = lambda k: sum(d[k] for d in docs)  # noqa: E731
    cit_b = s("cases_before") + s("statutes_before")
    cit_a = s("cases_after") + s("statutes_after")
    keys = docs[0]["markers_before"].keys() if docs else []
    return {
        "n": n, "errors": len(errors),
        "cases_before": s("cases_before"), "cases_after": s("cases_after"),
        "statutes_before": s("statutes_before"), "statutes_after": s("statutes_after"),
        "citations_before": cit_b, "citations_after": cit_a,
        "lost_total": sum(_lost(d) for d in docs),
        "docs_with_loss": sum(1 for d in docs if _lost(d) > 0),
        "quality_before": s("quality_before") / n if n else 0.0,
        "quality_after": s("quality_after") / n if n else 0.0,
        "markers_before": {m: sum(d["markers_before"][m] for d in docs) / n for m in keys},
        "markers_after": {m: sum(d["markers_after"][m] for d in docs) / n for m in keys},
    }


def verdict(agg):
    """List of failure reasons (empty = pass)."""
    bad = []
    if agg["n"] == 0:
        bad.append("no documents compared (empty sample)")
    if agg.get("errors", 0) > 0:
        bad.append(f"{agg['errors']} document(s) raised an error")
    if agg["citations_after"] < CIT_RATIO_MIN * agg["citations_before"]:
        bad.append(f"citations {agg['citations_after']} < {CIT_RATIO_MIN} x {agg['citations_before']}")
    if agg.get("lost_total", 0) > (1 - CIT_RATIO_MIN) * agg["citations_before"]:
        bad.append(f"lost citation keys {agg['lost_total']} > 1% of {agg['citations_before']}")
    if agg["quality_before"] - agg["quality_after"] > QUALITY_DROP_MAX:
        bad.append(f"mean quality {agg['quality_before']:.4f} -> {agg['quality_after']:.4f}")
    return bad


def worst_losses(docs, k=10):
    ranked = sorted(docs, key=_lost, reverse=True)[:k]
    return [d for d in ranked if _lost(d) > 0]


def fetch(conn, sample, raw_dir=None):
    """Read-only fetch: ([(doc_id, raw_text, languages)], stats) for the sample decisions."""
    conn.execute("SET TRANSACTION READ ONLY")  # first statement of the txn
    ids = sample.get("decisions", [])
    cur = conn.execute(
        "SELECT doc_id, spider, full_text, languages, metadata_json->>'Sprache' AS sprache"
        " FROM ch_court_decisions WHERE doc_id = ANY(%s)", (ids,))
    out = []
    stats = {"requested": len(ids), "found": 0, "excluded_spider": 0, "empty_text": 0}
    for r in cur.fetchall():
        stats["found"] += 1
        if r["spider"] in EXCLUDED_SPIDERS:
            stats["excluded_spider"] += 1
            continue
        raw = r["full_text"]
        if raw_dir:
            p = raw_text_archive.path_for(Path(raw_dir), r["spider"], r["doc_id"])
            if p.exists():
                raw = raw_text_archive.load(Path(raw_dir), r["spider"], r["doc_id"])
        if not raw:
            stats["empty_text"] += 1
            continue
        out.append((r["doc_id"], raw, languages_for(r)))
    return out, stats


def run(rows):
    """Compare every row; a document that raises is recorded, not fatal."""
    docs, errors = [], []
    for doc_id, raw, langs in rows:
        try:
            d = compare_text(raw, langs)
        except Exception as exc:  # noqa: BLE001
            errors.append({"doc_id": doc_id, "error": f"{type(exc).__name__}: {exc}"})
            continue
        d["doc_id"] = doc_id
        docs.append(d)
    return docs, errors


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--sample", required=True)
    ap.add_argument("--raw-dir")
    ap.add_argument("--out")
    a = ap.parse_args()
    sample = json.loads(Path(a.sample).read_text())
    with psycopg.connect(a.dsn, row_factory=dict_row) as conn:
        rows, stats = fetch(conn, sample, a.raw_dir)
    if not a.raw_dir:
        print("WARNING: no --raw-dir; assuming full_text is still raw for every row",
              file=sys.stderr)
    docs, errors = run(rows)
    agg = aggregate(docs, errors)
    print(f"sample ids requested {stats['requested']}, found {stats['found']}, "
          f"excluded spider {stats['excluded_spider']}, empty text {stats['empty_text']}")
    for e in errors:
        print(f"  ERROR {e['doc_id']}: {e['error']}")
    print("10 documents with the largest citation loss:")
    for d in worst_losses(docs):
        print(f"  {d['doc_id']}: lost {_lost(d)}, cases {d['cases_before']}->{d['cases_after']}, "
              f"statutes {d['statutes_before']}->{d['statutes_after']}")
    print(f"documents: {agg['n']}, errors: {agg['errors']}, "
          f"docs with loss: {agg['docs_with_loss']}, lost keys: {agg['lost_total']}")
    for k in ("cases", "statutes", "citations", "quality"):
        print(f"{k:10} before {agg[k + '_before']:.4f}  after {agg[k + '_after']:.4f}")
    print("mean raw-side markers: " + ", ".join(
        f"{m}={agg['markers_before'][m]:.3f}"
        for m in ("glued_refs", "hyphen_breaks", "mean_line_len") if m in agg["markers_before"]))
    for m in agg["markers_before"]:
        print(f"marker {m:20} {agg['markers_before'][m]:.3f} -> {agg['markers_after'][m]:.3f}")
    bad = verdict(agg)
    if a.out:
        Path(a.out).write_text(json.dumps({"aggregate": agg, "documents": docs, "errors": errors,
                                           "failures": bad}, ensure_ascii=False, indent=1))
    if bad:
        print("FAIL: " + "; ".join(bad), file=sys.stderr)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
