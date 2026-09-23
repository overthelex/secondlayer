"""Moving the audit's passages to the GPU box and the vectors back.

Both commands run on local.lex:

    gpu_io.py export --out /tmp/passages.jsonl.gz
    gpu_io.py load   --npz /tmp/vectors.npz

The vectors stay a file rather than a table. 205k x 1024 float16 is 420 MB,
every dense search reads the whole thing anyway, and this Postgres has no
vector index to offer.
"""
from __future__ import annotations

import argparse
import gzip
import json
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
VECTORS = pathlib.Path("/data/amcu/vectors.npz")


def export(out: pathlib.Path) -> int:
    import psycopg2
    import psycopg2.extras
    import retrieve

    n = 0
    conn = psycopg2.connect(retrieve.dsn())
    cur = conn.cursor(name="passage_export", cursor_factory=psycopg2.extras.DictCursor)
    cur.itersize = 2000
    cur.execute("SELECT doc_id, ord, body FROM ua_metodyka_audit_passages "
                "ORDER BY doc_id, ord")
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        for row in cur:
            fh.write(json.dumps({"doc_id": row["doc_id"], "ord": row["ord"],
                                 "text": row["body"]}, ensure_ascii=False) + "\n")
            n += 1
    cur.close()
    conn.close()
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
    ap.add_argument("--out", type=pathlib.Path,
                    default=pathlib.Path("/tmp/passages.jsonl.gz"))
    ap.add_argument("--npz", type=pathlib.Path,
                    default=pathlib.Path("/tmp/vectors.npz"))
    args = ap.parse_args()
    if args.command == "export":
        export(args.out)
    else:
        load(args.npz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
