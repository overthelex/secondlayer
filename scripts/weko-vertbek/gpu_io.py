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
import pathlib
import shutil
import sys

VECTORS = pathlib.Path("/data/ch-corpus/weko-bek/vectors.npz")


def export(dsn: str, out: pathlib.Path) -> int:
    import psycopg
    from psycopg.rows import dict_row
    n = 0
    with psycopg.connect(dsn, row_factory=dict_row) as conn, \
            gzip.open(out, "wt", encoding="utf-8") as fh:
        with conn.cursor(name="passages") as cur:        # server side: 274k rows
            cur.itersize = 2000
            cur.execute("SELECT ecli, ord, text FROM ch_weko_audit_passages ORDER BY ecli, ord")
            for row in cur:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
    print(f"exported {n} passages -> {out} ({out.stat().st_size / 1e6:.0f} MB)")
    return n


def load(npz: pathlib.Path) -> int:
    import numpy as np
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
    args = ap.parse_args()
    if args.command == "export":
        export(args.dsn, args.out)
    else:
        load(args.npz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
