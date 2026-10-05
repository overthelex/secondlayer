"""What the 2026 Methodology did with each 2002 provision, against its use (PAPER-245).

The audit of z0317-02 classed every provision by its use in the record
(AMCU decisions 2017-2026, court judgments 2006-2026): applied in at least
one passage read; cited but never applied; never cited at all
(figdata.py, provisions.csv). align2026.py says what z1043-26 did with it:
kept, modified or dropped. Did the replacement drop what practice did not
use and keep what it did?

    python3 fates.py
"""
from __future__ import annotations

import collections
import csv
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "metodyka"
PROVISIONS = pathlib.Path("/data/amcu/paper/figures/provisions.csv")
FATES = ("kept", "modified", "dropped")
USES = ("applied", "cited only", "never cited")


def main() -> int:
    use = {}
    for r in csv.DictReader(PROVISIONS.open(encoding="utf-8")):
        use[r["number"]] = ("applied" if r["applied"] == "1" else
                            "cited only" if int(r["citations"]) > 0 else "never cited")
    fate = {r["number"]: r for r in json.loads((DATA / "alignment_2002_2026.json").read_text())["old"]}
    types = {r["pid"]: r["type"] for r in json.loads((DATA / "typology_ua.json").read_text())["types"]
             if r["version"] == "2002"}
    assert set(use) == set(fate) == set(types), "the three files must cover the same 66 provisions"
    rows = [{"number": n, "type": types[n], "use": use[n], "fate": fate[n]["fate"], "in_2026": fate[n]["in_2026"]}
            for n in fate]
    out = {"provisions": rows}
    for name, sel in (("all", rows), ("norms", [r for r in rows if r["type"] == "norm"])):
        tab = collections.Counter((r["use"], r["fate"]) for r in sel)
        out[name] = {u: {f: tab[(u, f)] for f in FATES} for u in USES}
        print(f"{name} ({len(sel)})")
        print(f"  {'':14}" + "".join(f"{f:>10}" for f in FATES))
        for u in USES:
            print(f"  {u:14}" + "".join(f"{tab[(u, f)]:>10}" for f in FATES))
    (DATA / "fates_2002_2026.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
