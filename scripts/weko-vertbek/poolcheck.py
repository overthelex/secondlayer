"""Does the pool size the Erläuterungen were tuned on make them codify? (PAPER-236)

The candidate pool of the passage selection was raised from 100 to 200
decisions so that the decisions the Erläuterungen cite reach it after the
journal re-cut. A larger pool lets more decisions compete for the eight
slots, and the tuning target was the Erläuterungen; if it bought them their
codifications, measurement 1 would be partly an artefact of tuning.

For every proposition of a norm's chain, the full-run and step-2 selections
are rebuilt with the pool at 200 -- which must give the published packets --
and at 100. Measurement 1 is then re-read with the passages a pool of 100
would not have shown removed (the exhaustive and text-lag searches select
their decisions themselves and are kept).

    python3 poolcheck.py --dsn ...
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import packet as pk  # noqa: E402
import robust  # noqa: E402
from retrieve import dense_index, embed  # noqa: E402

DIR = pk.DIR
DATA = robust.DATA
FULL = "packet_full_v3.json"
BEFORE = ["packet_before.json", "packet_before_erl.json", "packet_before_v3redo.json",
          "packet_before_v5.json", "packet_before_v6.json"]
ERL = ("2019-04-09", "2022-12-12-erl")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--tei", default="http://172.30.0.2:80")
    args = ap.parse_args()
    import psycopg
    from datetime import date
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    meta = {r["ecli"]: r for r in conn.execute(pk.META).fetchall()}
    family = pk.families(conn, meta)
    index = dense_index()
    dates = {r["ecli"]: str(r["d"]) for r in conn.execute(
        "SELECT ecli, coalesce(date_exact, date_upper_bound) d FROM ch_weko_audit_corpus").fetchall() if r["d"]}

    m1 = [t for t in json.loads((DATA / "measure1_final_v9.json").read_text()) if t["type"] == "norm"]
    keys = {(v, d["pid"]) for t in m1 for v, d in t["versions"].items()}
    keys |= {(v, d["pid"]) for t in m1 for v, ds in (t.get("split") or {}).items() for d in ds}

    packets = {FULL: json.loads((DIR / FULL).read_text())}
    for f in BEFORE:
        packets[f] = json.loads((DIR / f).read_text())
    cache: dict = {}
    shown = {}          # (file, version, pid) -> {200: set, 100: set}
    check = collections.Counter()
    for f, items in packets.items():
        for it in items:
            k = (it["version"], it["pid"])
            if it.get("kind") != "sample" or k not in keys:
                continue
            q = np.asarray(embed([it["text"]], args.tei, cache)[0], dtype="float32")
            q /= max(float(np.linalg.norm(q)), 1e-9)
            before = date.fromisoformat(it["before"]) if it.get("before") else None
            got = {}
            for n in (200, 100):
                pk.POOL_DECISIONS = n
                chosen, _ = pk.pool(conn, index, meta, family, it["text"], q, before)
                got[n] = {r["ecli"] for r in chosen}
            published = {e["ecli"] for e in it["evidence"]}
            check["same" if got[200] == published else "differs"] += 1
            if got[200] != published:
                print("  differs:", f, k, "published only:", sorted(published - got[200]),
                      "rebuilt only:", sorted(got[200] - published))
            shown[(f, k)] = got
    print("pool 200 reproduces the published packets:", dict(check))

    hits = robust.collect(dates)
    # step-2 review files are keyed by their packet
    step2_packet = {"step2:review_before.json": "packet_before.json",
                    "step2:review_before_erl.json": "packet_before_erl.json",
                    "step2:review_before_v3redo.json": "packet_before_v3redo.json",
                    "step2:review_before_v5.json": "packet_before_v5.json",
                    "step2:review_before_v6.json": "packet_before_v6.json"}

    def kept(k, p) -> bool:
        if p["src"] == "full":
            s = shown.get((FULL, k))
        elif p["src"] in step2_packet:
            s = shown.get((step2_packet[p["src"]], k))
        else:
            return True
        # only what a pool of 100 would have dropped; a reader's mark on a
        # decision outside the packet stands as it does in measurement 1
        return s is None or p["ecli"] not in (s[200] - s[100])

    rows, moves = [], collections.Counter()
    for t in m1:
        ks = {(v, d["pid"]) for v, d in t["versions"].items()}
        ks |= {(v, d["pid"]) for v, ds in (t.get("split") or {}).items() for d in ds}
        ps = [p for k in ks for p in hits.get(k, [])]
        ps100 = [p for k in ks for p in hits.get(k, []) if kept(k, p)]
        c200, _ = robust.classify(t, ps, "published")
        c100, _ = robust.classify(t, ps100, "published")
        assert c200 == t["final_class"], (t["track"], c200, t["final_class"])
        moves[("erl" if t["first_version"] in ERL else "notice", c200, c100)] += 1
        rows.append({"track": t["track"], "version": t["first_version"], "pool200": c200, "pool100": c100})
    print("chain, class at 200 -> at 100:")
    for k, n in sorted(moves.items()):
        print("  ", k, n)
    lost = sum(len(v[200] - v[100]) for v in shown.values())
    total = sum(len(v[200]) for v in shown.values())
    out = {"packets_checked": dict(check), "passages_200": total, "not_shown_at_100": lost,
           "moves": {"|".join(k): n for k, n in moves.items()}, "norms": rows}
    (DATA / "poolcheck.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"decisions shown at 200 but not at 100: {lost} of {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
