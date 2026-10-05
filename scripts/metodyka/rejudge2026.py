"""Read again, against all of their 2002 text, the modified norms that came from more than one 2002 provision (PAPER-244).

align2026.py kept one predecessor where several tied; the judges asked whether a
passage applies what 2026 changed saw only that one, and a passage applying the
other (X.4 against 10.3 when its text is 10.4) looked like the change. Every
passage of those norms that either judge read as applying the norm is read again
by both judges with the text of every predecessor (from_2002_all); the new
answers replace the old for those passages.

    python3 rejudge2026.py --out packet2026_rejudge.json
"""
from __future__ import annotations

import argparse
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "metodyka"
STAGES = (("packet2026.json", "judges2026"), ("packet2026_exh.json", "judges2026_exh"), ("packet2026_ext.json", "judges2026_ext"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--packets", type=pathlib.Path, default=pathlib.Path("/data/amcu"))
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("/data/amcu/packet2026_rejudge.json"))
    args = ap.parse_args()
    al = {r["number"]: r for r in json.loads((DATA / "alignment_2002_2026.json").read_text())["new"]}
    old = json.loads((DATA / "propositions.json").read_text())
    old = {p["number"]: p for p in (old["propositions"] if isinstance(old, dict) else old)}
    out: dict[str, dict] = {}
    for packet, judges in STAGES:
        said = {}
        for who in ("claude-opus", "gemini-3.1-pro"):
            for line in (DATA / judges / f"{who}.jsonl").read_text().splitlines():
                r = json.loads(line)
                said.setdefault((r["number"], r["doc_id"], r["ord"]), []).append(r["label"])
        for item in json.loads((args.packets / packet).read_text()):
            pre = al[item["number"]]["from_2002_all"]
            if item["origin"] != "modified" or len(pre) < 2:
                continue
            keep = [s for s in item["passages"] if "застосовує" in said[(item["number"], s["doc_id"], s["ord"])]]
            if not keep:
                continue
            o = out.setdefault(item["number"], {**{k: item[k] for k in ("number", "rozdil", "rozdil_title", "text", "origin")},
                                                "from_2002": item["from_2002"], "from_2002_all": pre,
                                                "text_2002": "\n\n".join(f"{n}. {old[n]['text']}" for n in pre),
                                                "passages": []})
            o["passages"] += [dict(s, stage=judges) for s in keep]
    args.out.write_text(json.dumps(list(out.values()), ensure_ascii=False, indent=1), encoding="utf-8")
    for o in out.values():
        print(f"  {o['number']:<7} {'+'.join(o['from_2002_all']):<16} {len(o['passages'])} passages")
    print(f"{sum(len(o['passages']) for o in out.values())} passages -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
