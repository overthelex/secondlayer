"""Fixed-sample text damage probe for the CH corpus.

  --make-sample N   write --sample FILE: N PDF decisions, N fedlex_pdf editions,
                    N cantonal editions (split evenly over lexfind/lexwork_pdf/zhlex)
  --sample FILE --out FILE
                    compute chpipe.text_damage.markers per document and per-class
                    aggregates (mean of each marker, share of docs with marker > 0)
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe.text_damage import markers  # noqa: E402

CANTONAL = ("lexfind", "lexwork_pdf", "zhlex")
# excluded from the decision sample by design
EXCLUDED_SPIDERS = ("CH_WEKO_RPW", "CH_WEKO")


def _pick(cur, table, idcol, where, n, pct):
    cur.execute(
        f"SELECT {idcol} AS id FROM (SELECT {idcol} FROM {table} TABLESAMPLE SYSTEM (%s)"
        f" WHERE {where}) s ORDER BY random() LIMIT %s",
        (pct, n),
    )
    return [r["id"] for r in cur.fetchall()]


def make_sample(conn, n, pct=1.0):
    """Return (sample, counts, short): counts per class, short = classes below n."""
    cur = conn.cursor()
    excl = ", ".join(f"'{x}'" for x in EXCLUDED_SPIDERS)
    dec = _pick(cur, "ch_court_decisions", "doc_id",
                f"stage='loaded' AND text_source IN ('pdf','ocr') AND spider NOT IN ({excl})",
                n, pct)
    counts = {"decisions": len(dec)}
    want = {"decisions": n}
    fed = _pick(cur, "ch_act_version", "version_id", "stage='parsed' AND source='fedlex_pdf'", n, pct)
    counts["fedlex_pdf"], want["fedlex_pdf"] = len(fed), n
    ed = list(fed)
    per = n // len(CANTONAL)
    extra = n - per * len(CANTONAL)
    for i, src in enumerate(CANTONAL):
        k = per + (1 if i < extra else 0)
        got = _pick(cur, "ch_act_version", "version_id",
                    f"stage='parsed' AND source='{src}'", k, pct)
        ed += got
        counts[src], want[src] = len(got), k
    short = [c for c in counts if counts[c] < want[c]]
    return {"decisions": dec, "editions": ed}, counts, want, short


def measure(conn, sample):
    cur = conn.cursor()
    docs = []
    missing = {}
    cur.execute(
        "SELECT doc_id, spider, text_source, full_text, text_quality"
        " FROM ch_court_decisions WHERE doc_id = ANY(%s)", (sample["decisions"],))
    for r in cur.fetchall():
        docs.append({"kind": "decisions", "id": r["doc_id"], "class": r["spider"],
                     "text_source": r["text_source"], "text_quality": r["text_quality"],
                     "markers": markers(r["full_text"] or "")})
    cur.execute(
        "SELECT version_id, source, lang, full_text FROM ch_act_version"
        " WHERE version_id = ANY(%s)", (sample["editions"],))
    for r in cur.fetchall():
        docs.append({"kind": "editions", "id": r["version_id"], "class": r["source"],
                     "lang": r["lang"], "markers": markers(r["full_text"] or "")})
    seen = {(d["kind"], d["id"]) for d in docs}
    for kind in ("decisions", "editions"):
        gone = [i for i in sample[kind] if (kind, i) not in seen]
        if gone:
            missing[kind] = len(gone)
    groups = defaultdict(list)
    for d in docs:
        groups[f"{d['kind']}:{d['class']}"].append(d["markers"])
    agg = {}
    for k, ms in sorted(groups.items()):
        keys = ms[0].keys()
        agg[k] = {
            "n": len(ms),
            "mean": {m: sum(x[m] for x in ms) / len(ms) for m in keys},
            "share_nonzero": {m: sum(1 for x in ms if x[m] > 0) / len(ms) for m in keys},
        }
    return {"documents": docs, "aggregates": agg, "missing_ids": missing}


def print_table(agg):
    keys = list(next(iter(agg.values()))["mean"]) if agg else []
    print(f"{'class':28} {'n':>4} " + " ".join(f"{k[:11]:>11}" for k in keys))
    for k, a in agg.items():
        print(f"{k:28} {a['n']:>4} " + " ".join(f"{a['mean'][m]:>11.2f}" for m in keys))
    print("share of documents with marker > 0")
    for k, a in agg.items():
        print(f"{k:28} {a['n']:>4} " + " ".join(f"{a['share_nonzero'][m]:>11.2f}" for m in keys))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--sample", required=True)
    ap.add_argument("--make-sample", type=int, metavar="N_PER_CLASS")
    ap.add_argument("--out")
    ap.add_argument("--sample-pct", type=float, default=1.0,
                    help="TABLESAMPLE SYSTEM percentage (default 1; raise only for tiny test tables)")
    a = ap.parse_args()
    with psycopg.connect(a.dsn, row_factory=dict_row) as conn:
        if a.make_sample:
            s, counts, want, short = make_sample(conn, a.make_sample, a.sample_pct)
            Path(a.sample).write_text(json.dumps(s))
            for c, v in counts.items():
                print(f"{c:12} {v:>4} / {want[c]}")
            print(f"sample written -> {a.sample}")
            if short:
                print(f"ERROR: class(es) below requested size: {', '.join(short)}; "
                      f"raise --sample-pct", file=sys.stderr)
                sys.exit(1)
            return
        res = measure(conn, json.loads(Path(a.sample).read_text()))
    for kind, n in res["missing_ids"].items():
        print(f"WARNING: {n} sampled {kind} ids no longer exist", file=sys.stderr)
    print_table(res["aggregates"])
    if a.out:
        Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
