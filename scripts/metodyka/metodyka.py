"""The AMCU Методика, cut into the propositions the audit labels.

The instrument is the Методика визначення монопольного (домінуючого) становища
суб'єктів господарювання на ринку, approved by AMCU розпорядження N 49-р of
5 March 2002 (z0317-02) and registered with the Ministry of Justice on 1 April
2002 under N 317/6605. It governed for twenty four years and lost force on
1 August 2026, replaced by the Методика approved by розпорядження N 2-рп of
11 June 2026 (z1043-26).

Unlike WEKO's notice, this text was never amended: the register's own card
lists one edition for the whole period. There is nothing to align across
versions, which removes a whole source of doubt from the Swiss design.

The structure is a plain decimal hierarchy: eleven розділи, each holding
пункти numbered 1.1, 1.2 ... and occasionally a third and fourth level
(2.1.1, 10.1.6.2). A proposition is one numbered item, carrying the text from
its own number down to the next number at any level. An item that opens a list
of sub-items therefore keeps only its lead-in sentence, which is what it
actually asserts on its own.

That granularity is not a guess: it is the granularity the record cites at.
Decisions say "пункту 6.1 розділу 6 Методики", naming the numbered item.

Usage:
    python3 metodyka.py parse --source db          # from npa.edition_text
    python3 metodyka.py parse --source /tmp/m.txt
    python3 metodyka.py dump --out propositions.json
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass

NREG = "z0317-02"
ED_DATE = "2002-03-05"
PSQL = ["docker", "exec", "-i", "secondlayer-postgres-local",
        "psql", "-U", "secondlayer", "-d", "secondlayer_local", "-At", "-c"]

# "1. Загальні положення" opens a розділ: a number, a dot, a capitalised title
# and no sentence after it. The same shape appears twice before the Методика
# itself, in the operative clauses of the розпорядження that approves it, so
# parsing starts at the heading of the annex.
_ROZDIL = re.compile(r"^(\d{1,2})\.\s+([А-ЯІЇЄҐ][^.]{6,140})$")
# "1.1.", "2.1.11.", "10.1.6.2." open a numbered item.
_ITEM = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){1,3})\.\s+(\S.*)$")
_START = re.compile(r"^МЕТОДИКА\b")
_END = re.compile(r"^(Начальник Головного управління|©)")


@dataclass
class Proposition:
    number: str          # "6.1"
    rozdil: int          # 6
    rozdil_title: str
    depth: int           # 2 for "6.1", 3 for "2.1.11"
    text: str
    line: int

    @property
    def pid(self) -> str:
        return f"p{self.number}"


def read_db() -> str:
    out = subprocess.run(
        PSQL + [f"select body from npa.edition_text "
                f"where nreg = $q${NREG}$q$ and ed_date = $q${ED_DATE}$q$"],
        capture_output=True, text=True)
    if out.returncode or not out.stdout.strip():
        raise SystemExit(f"could not read {NREG} from npa.edition_text: {out.stderr[:200]}")
    return out.stdout


def parse(text: str) -> list[Proposition]:
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n")]
    try:
        first = next(i for i, ln in enumerate(lines) if _START.match(ln))
    except StopIteration as exc:
        raise SystemExit("the annex heading 'МЕТОДИКА' was not found") from exc

    props: list[Proposition] = []
    rozdil, title = 0, ""
    current: Proposition | None = None
    buffer: list[str] = []

    def flush() -> None:
        if current is not None:
            current.text = " ".join(x for x in buffer if x).strip()
            props.append(current)

    for n, line in enumerate(lines[first + 1:], start=first + 2):
        if _END.match(line):
            break
        item = _ITEM.match(line)
        if item:
            flush()
            number, rest = item.group(1), item.group(2)
            current = Proposition(number=number, rozdil=int(number.split(".")[0]),
                                  rozdil_title=title, depth=number.count(".") + 1,
                                  text="", line=n)
            buffer = [rest]
            continue
        head = _ROZDIL.match(line)
        if head:
            flush()
            current, buffer = None, []
            rozdil, title = int(head.group(1)), head.group(2).strip()
            continue
        if current is not None:
            buffer.append(line)
    flush()

    for p in props:
        if not p.rozdil_title:
            p.rozdil_title = next((q.rozdil_title for q in props
                                   if q.rozdil == p.rozdil and q.rozdil_title), "")
    return props


def load(source: str) -> list[Proposition]:
    text = read_db() if source == "db" else open(source, encoding="utf-8").read()
    return parse(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["parse", "dump"])
    ap.add_argument("--source", default="db")
    ap.add_argument("--out")
    args = ap.parse_args()
    props = load(args.source)

    if args.command == "dump":
        payload = [asdict(p) | {"pid": p.pid} for p in props]
        target = args.out or "propositions.json"
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        print(f"{len(props)} propositions -> {target}")
        return

    by_rozdil: dict[int, list[Proposition]] = {}
    for p in props:
        by_rozdil.setdefault(p.rozdil, []).append(p)
    total_chars = sum(len(p.text) for p in props)
    print(f"{len(props)} propositions in {len(by_rozdil)} розділи, "
          f"{total_chars} characters of operative text\n")
    for rozdil in sorted(by_rozdil):
        items = by_rozdil[rozdil]
        print(f"{rozdil}. {items[0].rozdil_title[:78]}")
        for p in items:
            head = re.sub(r"\s+", " ", p.text)[:92]
            print(f"   {p.number:<9} {len(p.text):>5}  {head}")
    short = [p for p in props if len(p.text) < 80]
    if short:
        print(f"\n{len(short)} propositions under 80 characters: "
              + ", ".join(p.number for p in short))


if __name__ == "__main__":
    main()
