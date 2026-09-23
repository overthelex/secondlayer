"""Every citation of the Методика in the record, resolved to a proposition.

The gold set is what the audit measures retrieval against: for each pinpoint
citation, the decision that made it is a document the proposition demonstrably
has support in. Two corpora hold the record:

  * `opendata_amcu_decisions` -- the agency's own decisions, as published by
    the AMCU on data.gov.ua (2017 onwards, which is when the portal starts);
  * `edrsr_fulltext` -- the state register of court decisions, which reaches
    back to the Методика's adoption and holds the courts reviewing the agency.

Finding the citations is not a matter of grepping for "Методика". The word is
generic: a decision about electricity tariffs cites "методики розрахунку
тарифів", one about metering cites the manufacturer's методика. So a mention
counts as ours only when the title follows it ("Методики визначення
монопольного (домінуючого) становища"), or when the document establishes that
title somewhere and carries no competing one.

Pinpoints come in many shapes, all of them real, taken from the corpus:

    пунктом 5.1 Методики            п. 1.3. Методики
    Пункт 7.3 цієї Методики         п. 1.3., 10.3. Методики
    пункту 3 розділу 1 Методики     п. 2.1.3 ст.2 Методики
    Розділом 2 Методики             п. 1.З. Методики   (typo: Cyrillic З for 3)

"пункту 3 розділу 1" is the trap: the item is 1.3, not 3. A bare number with a
розділ beside it is composed into the decimal number the instrument uses.

Usage:
    python3 goldset.py check --limit 60     # look at the detector before trusting it
    python3 goldset.py build --out goldset.jsonl
    python3 goldset.py report --in goldset.jsonl
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys

PSQL = ["docker", "exec", "-i", "secondlayer-postgres-local",
        "psql", "-U", "secondlayer", "-d", "secondlayer_local", "-At", "-F", "\x1f"]

# The candidate sets. Narrow enough to stream, wide enough to over-collect:
# the classifier below throws away what is not ours.
COURT_SQL = """
select doc_id, full_text from edrsr_fulltext
where tsv @@ to_tsquery($q$simple$q$,
      $q$(методики|методикою|методика|методиці|методику|методиках) & становища$q$)
"""
AMCU_SQL = """
select id, body_text from opendata_amcu_decisions
where length(body_text) > 500 and body_text ~* $q$[Мм]етодик$q$
"""

MENTION = re.compile(r"[Мм]етодик(?:а|и|у|ою|ці|ам|ах|о́ю)\b")
# The title, allowing the register's own wording and the courts' shortenings.
TITLE = re.compile(r"\s*(?:визначення\s+)?монопольного\s*\(?\s*домінуючого\s*\)?\s*становища"
                   r"|\s*визначення\s+монопольного\s+становища", re.I)
# A competing instrument: the word followed by a genitive that is not ours.
COMPETING = re.compile(r"[Мм]етодик\w*\s+(?!визначення\s+монопольного)"
                       r"(?:розрахунку|обчислення|проведення|оцінки|визначення\s+(?!монопольного))")
ANCHORS = ("49-р", "317/6605", "z0317-02")

_MARKER = r"(?:під\s?пункт\w*|пункт\w*|п\.\s?п\.|пп\.|п\.|розділ\w*|р\.)"
_NUM = r"\d{1,2}(?:\s?\.\s?[\dЗз]{1,2}){0,3}"
# "пунктом 5.1", "п. 1.3., 10.3.", "пункту 3 розділу 1", "п. 2.1.3 ст.2"
PINPOINT = re.compile(
    rf"({_MARKER})\s*((?:{_NUM})(?:\s*(?:,|та|і|й)\s*(?:{_MARKER})?\s*(?:{_NUM}))*)\s*\.?"
    rf"(?:\s*(?:ст\.?|статт\w+)\s*\d{{1,2}})?"
    rf"(?:\s*розділ\w*\s*(\d{{1,2}}))?", re.I)
# Between the reference and the word "Методики" there is room only for the
# words that point at it. Anything longer means the number belongs to some
# other instrument mentioned in the same sentence, which is how "п. 23" of a
# statute ended up attached to the Методика in a first run.
BRIDGE = re.compile(r"^[\s,«\"]*(?:ціє[її]|зазначено[її]|вказано[її]|згадано[її]|"
                    r"вищезгадано[її]|застосовано[її]|відповідно|до|та|і)?[\s,«\"]*$",
                    re.I)
NUM = re.compile(_NUM)


def rows(sql: str):
    proc = subprocess.Popen(PSQL + ["-c", sql], stdout=subprocess.PIPE, text=True,
                            bufsize=1 << 20)
    doc_id, chunks = None, []
    for line in proc.stdout:
        head, sep, rest = line.partition("\x1f")
        if sep and head.isdigit() and (doc_id is None or chunks):
            if doc_id is not None:
                yield doc_id, "".join(chunks)
            doc_id, chunks = int(head), [rest]
        else:
            chunks.append(line)
    if doc_id is not None:
        yield doc_id, "".join(chunks)
    proc.wait()


def ours(text: str) -> list[tuple[int, int]]:
    """The spans of the mentions that are this Методика."""
    spans = [(m.start(), m.end()) for m in MENTION.finditer(text)]
    if not spans:
        return []
    strong = [s for s in spans if TITLE.match(text, s[1])]
    if not strong:
        if any(a in text for a in ANCHORS) and not COMPETING.search(text):
            return spans
        return []
    if not COMPETING.search(text):
        return spans
    # Both instruments are in the document: keep the titled mentions and the
    # short-form references that sit next to one.
    keep = []
    for span in spans:
        if span in strong or any(abs(span[0] - s[0]) < 1500 for s in strong):
            keep.append(span)
    return keep


def normalise(raw: str) -> str:
    return raw.replace(" ", "").replace("З", "3").replace("з", "3").strip(".")


def pinpoints(text: str, span: tuple[int, int]) -> list[tuple[str, str]]:
    """The numbers cited at a mention, as (kind, number)."""
    before = text[max(0, span[0] - 170):span[0]]
    matches = list(PINPOINT.finditer(before))
    if not matches:
        return []
    last = matches[-1]
    if not BRIDGE.match(before[last.end():]):
        return []
    marker = last.group(1).lower()
    rozdil = last.group(3)
    kind = "rozdil" if marker.startswith(("розділ", "р.")) else "punkt"
    found: list[tuple[str, str]] = []
    for raw in NUM.findall(last.group(2)):
        number = normalise(raw)
        if not number:
            continue
        if kind == "punkt" and "." not in number and rozdil:
            number = f"{rozdil}.{number}"
        found.append((kind, number))
    return found


def build(out: str) -> None:
    seen = 0
    with open(out, "w", encoding="utf-8") as fh:
        for corpus, sql in (("amcu", AMCU_SQL), ("court", COURT_SQL)):
            for doc_id, text in rows(sql):
                spans = ours(text)
                if not spans:
                    continue
                cites: dict[tuple[str, str], str] = {}
                for span in spans:
                    for kind, number in pinpoints(text, span):
                        cites.setdefault((kind, number),
                                         re.sub(r"\s+", " ",
                                                text[max(0, span[0] - 120):span[1] + 60]))
                seen += 1
                fh.write(json.dumps({
                    "corpus": corpus, "doc_id": doc_id, "mentions": len(spans),
                    "cites": [{"kind": k, "number": n, "context": c}
                              for (k, n), c in cites.items()],
                }, ensure_ascii=False) + "\n")
                if seen % 500 == 0:
                    print(f"  {seen} documents", file=sys.stderr)
    print(f"{seen} documents citing the Методика -> {out}")


def check(limit: int) -> None:
    kept = dropped = 0
    for corpus, sql in (("amcu", AMCU_SQL), ("court", COURT_SQL)):
        shown = 0
        for doc_id, text in rows(sql):
            spans = ours(text)
            if not spans:
                dropped += 1
                if shown < limit // 4:
                    snippet = MENTION.search(text)
                    if snippet:
                        print(f"  DROP {corpus} {doc_id}: "
                              f"{re.sub(chr(92) + 's+', ' ', text[max(0, snippet.start() - 60):snippet.end() + 70])}")
                        shown += 1
                continue
            kept += 1
            pins = [p for s in spans for p in pinpoints(text, s)]
            if shown < limit // 2 and pins:
                print(f"  KEEP {corpus} {doc_id}: {sorted(set(pins))[:6]}")
                shown += 1
            if kept + dropped > 4000:
                break
    print(f"\nkept {kept}, dropped {dropped}")


def report(path: str) -> None:
    per_prop: dict[str, collections.Counter] = {}
    docs = collections.Counter()
    for line in open(path, encoding="utf-8"):
        row = json.loads(line)
        docs[row["corpus"]] += 1
        for c in row["cites"]:
            key = c["number"] if c["kind"] == "punkt" else f"розділ {c['number']}"
            per_prop.setdefault(key, collections.Counter())[row["corpus"]] += 1
    print(f"documents: {dict(docs)}, distinct pinpoints: {len(per_prop)}")
    print(f"\n{'pinpoint':>12} {'amcu':>6} {'court':>6}")
    for key, counter in sorted(per_prop.items(),
                               key=lambda kv: -sum(kv[1].values()))[:40]:
        print(f"{key:>12} {counter['amcu']:>6} {counter['court']:>6}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["check", "build", "report"])
    ap.add_argument("--out", default="goldset.jsonl")
    ap.add_argument("--in", dest="path", default="goldset.jsonl")
    ap.add_argument("--limit", type=int, default=40)
    args = ap.parse_args()
    if args.command == "check":
        check(args.limit)
    elif args.command == "build":
        build(args.out)
    else:
        report(args.path)


if __name__ == "__main__":
    main()
