"""The gold set for the retrieval control: every decision the instrument
itself cites, paired with the proposition that cites it.

Why it exists. The audit will say of some propositions that the record holds
nothing for them. That claim is worth only as much as the retrieval behind
it, so before any labelling the retrieval has to find what we already KNOW is
there: the decisions the Erläuterungen cite by name. A proposition whose own
cited decision does not come back in the top k means the retrieval is broken,
not that the record is empty.

Where the citations are. Not in the Bekanntmachung: measured over all five
versions, the operative instrument cites the Swiss record once in 2017 and
once in 2022 and not at all in 2002, 2007 and 2010. The Erläuterungen carry
them -- 30 BGE references and 18 dockets in the 2022 text, 15 and 4 in 2017.

    python3 goldset.py --dir /data/ch-corpus/weko-bek
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from propositions import SOURCES, parse, read_text  # noqa: E402

# "BGE 143 II 297", "BGE 148 II 25"
BGE = re.compile(r"\bBGE\s+(\d{2,3})\s+([IVX]+)\s+(\d{1,3})\b")
# Federal Court dockets ("2C_43/2020"), Federal Administrative Court ("B-5918/2017")
BGER = re.compile(r"\b(\d[A-H]_\d{1,4}/\d{4})\b")
BVGER = re.compile(r"\b([AB]-\d{2,5}/\d{4})\b")


def citations(text: str) -> list[dict]:
    out: list[dict] = []
    for m in BGE.finditer(text):
        out.append({"kind": "bge", "ref": f"BGE {m.group(1)} {m.group(2)} {m.group(3)}"})
    for m in BGER.finditer(text):
        out.append({"kind": "bger", "ref": m.group(1)})
    for m in BVGER.finditer(text):
        out.append({"kind": "bvger", "ref": m.group(1)})
    seen, uniq = set(), []
    for c in out:
        if c["ref"] not in seen:
            seen.add(c["ref"])
            uniq.append(c)
    return uniq


def pairs(directory: pathlib.Path, versions: list[str]) -> list[dict]:
    out = []
    for key in versions:
        name, journal = SOURCES[key]
        path = directory / name
        if not path.exists():
            print(f"  ! {key}: {name} not present", file=sys.stderr)
            continue
        # keep_notes: the citations sit in the footnotes, not in the body.
        for p in parse(read_text(path, journal), key, keep_notes=True):
            for c in citations(p.text):
                out.append({"version": key, "pid": p.pid, "part": p.part,
                            "heading": p.heading, "kind": c["kind"], "ref": c["ref"],
                            "proposition": p.text})
    return out


RESOLVE = {
    "bge": ("SELECT ecli, docket_number, decision_date FROM ch_court_decisions "
            "WHERE spider = 'CH_BGE' AND (docket_number = %s OR abstract ILIKE %s) LIMIT 3"),
    "bger": ("SELECT ecli, docket_number, decision_date FROM ch_court_decisions "
             "WHERE docket_number = %s AND spider IN ('CH_BGer', 'CH_BGE') LIMIT 3"),
    "bvger": ("SELECT ecli, docket_number, decision_date FROM ch_court_decisions "
              "WHERE docket_number = %s AND spider = 'CH_BVGer' LIMIT 3"),
}


def resolve(conn, rows: list[dict]) -> list[dict]:
    """Attach the corpus row each citation names, where the corpus has it."""
    for r in rows:
        ref = r["ref"]
        sql = RESOLVE[r["kind"]]
        params = (ref, f"%{ref}%") if r["kind"] == "bge" else (ref,)
        hits = conn.execute(sql, params).fetchall()
        r["resolved"] = [{"ecli": h["ecli"], "docket": h["docket_number"],
                          "date": str(h["decision_date"] or "")} for h in hits]
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", type=pathlib.Path, default=pathlib.Path("/data/ch-corpus/weko-bek"))
    ap.add_argument("--versions", default="2017-05-22,2019-04-09,2022-12-12,2022-12-12-erl")
    ap.add_argument("--dsn")
    ap.add_argument("--out", type=pathlib.Path)
    args = ap.parse_args()

    rows = pairs(args.dir, [v.strip() for v in args.versions.split(",") if v.strip()])
    by_kind: dict[str, int] = {}
    for r in rows:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    print(f"citations in the instruments: {len(rows)} " +
          ", ".join(f"{k} {n}" for k, n in sorted(by_kind.items())))
    print(f"propositions that cite at least one: {len({(r['version'], r['pid']) for r in rows})}")

    if args.dsn:
        import psycopg
        from psycopg.rows import dict_row
        with psycopg.connect(args.dsn, row_factory=dict_row) as conn:
            rows = resolve(conn, rows)
        found = sum(1 for r in rows if r["resolved"])
        print(f"resolved against the corpus: {found}/{len(rows)}")
        for r in rows:
            if not r["resolved"]:
                print(f"    unresolved {r['kind']:6} {r['ref']:18} ({r['version']} {r['pid']})")
    if args.out:
        args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
