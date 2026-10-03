"""The labelling page: page/labels.html with a packet filled in.

The template carries no data; this writes the published page with the packet
embedded, so the reader and the judge see the same file.

    python3 page.py --packet /data/ch-corpus/weko-bek/packet.json --out labels.html

Published at https://claude.ai/artifact/FspwNTMQx7CnSvSujs4ujM (db capability,
labels in the collection `labels`, one document per proposition).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

TEMPLATE = pathlib.Path(__file__).parent / "page" / "labels.html"


def render(packet: list) -> str:
    # "</" inside the JSON would close the <script> element early.
    data = json.dumps(packet, ensure_ascii=False).replace("</", "<\\/")
    html = TEMPLATE.read_text(encoding="utf-8")
    assert html.count("__PACKET__") == 1
    return html.replace("__PACKET__", data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packet", type=pathlib.Path, required=True)
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--review", action="store_true",
                    help="the packet is aggregate.py's review.json: keep disputed and check items")
    args = ap.parse_args()
    packet = json.loads(args.packet.read_text(encoding="utf-8"))
    if args.review:
        # aggregate.py output: only what the human has to read; the judges'
        # answers ride along and the page reveals them after the human label
        packet = [r for r in packet if r.get("status") in ("disputed", "check", "rest")]
        packet.sort(key=lambda r: (r["status"] != "disputed", r["version"], r["pid"]))
    args.out.write_text(render(packet), encoding="utf-8")
    print(f"{len(packet)} propositions -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
