"""Moving the audit's passages to the GPU box and the vectors back.

Two commands, both meant to run on cthulhu:

    gpu_io.py export --dsn ... --out /tmp/passages.jsonl.gz
    gpu_io.py load   --dsn ... --npz /tmp/vectors.npz

The vectors stay a file rather than a table: 274k x 1024 float16 is 561 MB,
it is read whole for every dense search anyway, and Postgres here has no
vector index to offer.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import shutil
import sys

VECTORS = pathlib.Path(os.environ.get("WEKO_VECTORS", "/data/ch-corpus/weko-bek/vectors.npz"))


def export(dsn: str, out: pathlib.Path, table: str, spider: str | None) -> int:
    import psycopg
    from psycopg.rows import dict_row
    n = 0
    with psycopg.connect(dsn, row_factory=dict_row) as conn, \
            gzip.open(out, "wt", encoding="utf-8") as fh:
        with conn.cursor(name="passages") as cur:        # server side: 274k rows
            cur.itersize = 2000
            if spider:
                cur.execute(f"SELECT p.ecli, p.ord, p.text FROM {table} p JOIN ch_weko_audit_corpus a USING (ecli) "
                            "WHERE a.spider = %s ORDER BY p.ecli, p.ord", (spider,))
            else:
                cur.execute(f"SELECT ecli, ord, text FROM {table} ORDER BY ecli, ord")
            for row in cur:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
    print(f"exported {n} passages -> {out} ({out.stat().st_size / 1e6:.0f} MB)")
    return n


def load(npz: pathlib.Path, merge_with: pathlib.Path | None = None) -> int:
    """Install the vectors; with merge_with, the new rows replace the old
    file's rows of the same decisions and every other row is kept (only the
    journal is re-embedded for v2)."""
    import numpy as np
    data = np.load(npz, allow_pickle=False)
    if merge_with:
        old = np.load(merge_with, allow_pickle=False)
        replaced = set(map(str, data["ecli"]))
        keep = np.array([str(e) not in replaced for e in old["ecli"]])
        merged = pathlib.Path(str(npz) + ".merged.npz")
        np.savez_compressed(merged,
                            vectors=np.concatenate([old["vectors"][keep], data["vectors"]]),
                            ecli=np.concatenate([old["ecli"][keep], data["ecli"]]),
                            ord=np.concatenate([old["ord"][keep], data["ord"]]))
        print(f"merged: kept {int(keep.sum())} of {len(keep)} old rows, added {len(data['ecli'])}")
        npz = merged
        data = np.load(npz, allow_pickle=False)
    vectors = data["vectors"]
    VECTORS.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(npz, VECTORS)
    norms = np.linalg.norm(vectors.astype("float32"), axis=1)
    zero = int((norms == 0).sum())
    print(f"vectors {vectors.shape} {vectors.dtype} -> {VECTORS} "
          f"({VECTORS.stat().st_size / 1e6:.0f} MB); all-zero rows: {zero}")
    return vectors.shape[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["export", "load"])
    ap.add_argument("--dsn")
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("/tmp/passages.jsonl.gz"))
    ap.add_argument("--npz", type=pathlib.Path, default=pathlib.Path("/tmp/vectors.npz"))
    ap.add_argument("--table", default=os.environ.get("WEKO_PASSAGES", "ch_weko_audit_passages"))
    ap.add_argument("--spider", help="export only this source (the journal for v2)")
    ap.add_argument("--merge-with", type=pathlib.Path, help="old vectors to keep for the other sources")
    args = ap.parse_args()
    if args.command == "export":
        export(args.dsn, args.out, args.table, args.spider)
    else:
        load(args.npz, args.merge_with)
    return 0


if __name__ == "__main__":
    sys.exit(main())
