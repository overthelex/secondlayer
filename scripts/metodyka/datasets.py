"""Export the datasets the paper's numbers rest on.

Everything the audit claims can be recomputed from four files, and they are
small enough to live in the repository beside the code that made them:

    propositions.json     the instrument, cut into its 66 numbered items
    goldset.jsonl         every citation of it found in the record
    coverage.json         the two crossed, per proposition
    corpus-manifest.csv   which documents the corpus held, and which copy of
                          a twice-published decision was kept

The corpus itself is not here: 121 MB of decisions, 191,593 passages and
400 MB of vectors do not belong in git. The manifest is what makes them
reproducible, because it names every document by its identifier in the source
registers and carries the hash of its normalised text, so a rebuild can be
checked document by document rather than by a row count.

Usage:
    python3 datasets.py --out /Users/…/data/metodyka
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import pathlib
import shutil

import psycopg2

import metodyka
import retrieve

WORK = pathlib.Path("/data/amcu")


def manifest(out: pathlib.Path) -> int:
    conn = psycopg2.connect(retrieve.dsn())
    with conn.cursor() as cur:
        cur.execute("""
            SELECT c.doc_id, c.corpus, coalesce(c.doc_ref, ''), c.decision_date,
                   length(c.body), c.body_hash, c.canonical,
                   (SELECT count(*) FROM ua_metodyka_audit_passages p
                     WHERE p.doc_id = c.doc_id)
              FROM ua_metodyka_audit_corpus c
             ORDER BY c.doc_id
        """)
        rows = cur.fetchall()
    with open(out, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["doc_id", "corpus", "doc_ref", "decision_date",
                         "chars", "body_hash", "canonical", "passages"])
        writer.writerows(rows)
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    props = metodyka.load("db")
    with open(out / "propositions.json", "w", encoding="utf-8") as fh:
        json.dump([{"number": p.number, "rozdil": p.rozdil,
                    "rozdil_title": p.rozdil_title, "depth": p.depth,
                    "text": p.text} for p in props], fh,
                  ensure_ascii=False, indent=1)

    for name in ("goldset.jsonl", "coverage.json"):
        shutil.copyfile(WORK / name, out / name)

    n = manifest(out / "corpus-manifest.csv")

    lines = []
    for path in sorted(out.iterdir()):
        if path.name == "checksums.txt":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}  {path.stat().st_size}")
        print(f"  {path.name:<22} {path.stat().st_size / 1024:>8.0f} KB")
    (out / "checksums.txt").write_text("\n".join(lines) + "\n")
    print(f"{len(props)} propositions, {n} documents in the manifest -> {out}")


if __name__ == "__main__":
    main()
