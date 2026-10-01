"""The annotation packet: propositions with the evidence the retrieval finds.

Version 1, as run on 2026-09-23 to build /data/ch-corpus/weko-bek/packet.json
(50 propositions, 8 passages each, seed 23). Until 2026-10-01 this script
lived only in /tmp on cthulhu; it is kept here unchanged in what it selects,
so the first packet can be rebuilt from the repository.

    python3 packet.py --dsn postgresql://... --out /data/ch-corpus/weko-bek/packet.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from propositions import SOURCES, parse, read_text  # noqa: E402
from retrieve import dense_index, embed  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")
PLAN = [("2022-12-12", 20), ("2022-12-12-erl", 15), ("2010-06-28", 10), ("2002-02-18", 5)]
SEED = 23
POOL = 120          # distinct decisions considered per proposition
K = 8               # passages shown per proposition


def pick() -> list:
    random.seed(SEED)
    picked = []
    for key, n in PLAN:
        name, journal = SOURCES[key]
        props = [p for p in parse(read_text(DIR / name, journal), key) if len(p.text) > 200]
        picked += random.sample(props, min(n, len(props)))
    return picked


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--tei", default="http://172.30.0.2:80")
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "packet.json")
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)

    picked = pick()
    print(f"propositions picked: {len(picked)}", flush=True)

    vectors, eclis, ords = dense_index()
    cache: dict = {}
    meta = {r["ecli"]: r for r in conn.execute(
        "select ecli, spider, court_code, docket_number, decision_date, "
        "       rpw_chapter as chapter from ch_weko_audit_corpus").fetchall()}
    texts = {(r["ecli"], r["ord"]): r["text"] for r in conn.execute(
        "select ecli, ord, text from ch_weko_audit_passages").fetchall()}

    out = []
    for p in picked:
        q = np.asarray(embed([p.text], args.tei, cache)[0], dtype="float32")
        q /= max(float(np.linalg.norm(q)), 1e-9)
        scores = vectors @ q
        best: dict[str, tuple[float, int]] = {}
        for i in np.argsort(-scores)[:4000]:
            e = str(eclis[i])
            if e not in best:
                best[e] = (float(scores[i]), int(ords[i]))
            if len(best) >= POOL:
                break
        top = sorted(best.items(), key=lambda kv: -kv[1][0])[:K]
        evidence = []
        for ecli, (score, ord_) in top:
            m = meta.get(ecli, {})
            evidence.append({
                "ecli": ecli, "score": round(score, 3),
                "spider": m.get("spider"), "docket": m.get("docket_number"),
                "date": str(m.get("decision_date") or ""),
                "text": texts.get((ecli, ord_), "")[:1600],
            })
        out.append({"version": p.version, "pid": p.pid, "part": p.part,
                    "heading": p.heading, "text": p.text, "evidence": evidence})
        print(f"  {p.version} {p.pid} -> {len(evidence)} passages", flush=True)

    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written {args.out}  ({args.out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
