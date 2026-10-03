"""Where the notice's wording comes from: the EU texts, or WEKO's own pen.

Measurement 2 of the audit (spec 4.4). For every proposition of every version
of the Bekanntmachung and the Erläuterungen, how much of its wording stands
verbatim in the EU vertical texts in force when the version was written:

    2002, 2007 Bek          Regulation 2790/1999 + Guidelines 2000
    2010, 2017 Bek, 2019 Erl Regulation 330/2010  + Guidelines 2010
    2022 Bek, 2022 Erl       Regulation 2022/720  + Guidelines 2022

Two scores per proposition, on word lists after normalisation:

    containment  share of the proposition's word 5-grams found anywhere in
                 the EU texts (verbatim runs, order inside the run kept)
    aligned      share of the proposition's words matched in runs of 4+
                 inside the best EU window (difflib, autojunk OFF: with it
                 on, two texts of the same recital scored 0.178)

Normalisation is what a Swiss transposition changes without changing the
wording: ß -> ss, hyphenation at a line break, and the feminine forms Swiss
legislative drafting uses (Anbieterin -> Anbieter). The terminology Swiss
law has its own word for (Abrede for Vereinbarung, Anbieter for Lieferant)
is a second, separately reported score, because replacing a term is a
choice the paper has to show rather than hide.

The threshold is calibrated, not chosen: the same propositions are scored
against the EU Horizontal Guidelines 2011, same author, same register,
different subject. What they share with that text, and not with any vertical
text, is the noise of competition-law German; a proposition is "own" when it
shares no more with
the vertical texts than the 99th percentile of that null, "imported" when
half or more of its 5-grams are in the vertical texts, "mixed" between.

    python3 provenance.py --out /data/ch-corpus/weko-bek/provenance.json
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import pathlib
import re
import statistics
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from propositions import SOURCES, parse, read_text  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")
EU_DIR = pathlib.Path("/data/ch-corpus/eu")
N = 5
IMPORTED = 0.5

EU = {
    "1999": ["31999R2790_deu.txt", "32000Y101301_deu.txt"],
    "2010": ["32010R0330_deu.txt", "52010XC051904_deu.txt"],
    "2022": ["32022R0720_deu.txt", "52022XC063001_deu.txt"],
}
EU_FOR = {
    "2002-02-18": "1999", "2007-07-02": "1999",
    "2010-06-28": "2010", "2017-05-22": "2010", "2019-04-09": "2010",
    "2022-12-12": "2022", "2022-12-12-erl": "2022",
}
NULL = ["52011XC011404_deu.txt"]
INSTRUMENT = {"2019-04-09": "Erläuterungen", "2022-12-12-erl": "Erläuterungen"}

TERMS = {
    "wettbewerbsabreden": "vereinbarungen", "wettbewerbsabrede": "vereinbarung",
    "abreden": "vereinbarungen", "abrede": "vereinbarung",
    "anbieter": "lieferant", "anbietern": "lieferanten",
}


def words(text: str, terms: bool = False) -> list[str]:
    t = text.lower().replace("ß", "ss")
    t = re.sub(r"(\w)-\s+([a-zäöü])", r"\1\2", t)          # "Wei- terverkauf"
    out = []
    for w in re.findall(r"[a-zäöü]+|\d+", t):
        w = re.sub(r"^(\w{3,}?)(?:erin|erinnen)$", r"\1er", w)   # Anbieterin -> Anbieter
        if terms:
            w = TERMS.get(w, w)
        out.append(w)
    return out


def shingles(ws: list[str]) -> set[tuple]:
    return {tuple(ws[i:i + N]) for i in range(len(ws) - N + 1)}


class Corpus:
    def __init__(self, files: list[str], terms: bool = False):
        self.words: list[str] = []
        for f in files:
            self.words += words((EU_DIR / f).read_text(encoding="utf-8"), terms) + ["§"]
        self.index: dict[tuple, list[int]] = collections.defaultdict(list)
        for i in range(len(self.words) - N + 1):
            self.index[tuple(self.words[i:i + N])].append(i)

    def containment(self, ws: list[str]) -> float:
        sh = shingles(ws)
        return sum(1 for s in sh if s in self.index) / len(sh) if sh else 0.0

    def aligned(self, ws: list[str]) -> tuple[float, str]:
        """Matched share inside the densest EU window, and that window."""
        hits = sorted(p for s in shingles(ws) for p in self.index.get(s, [])[:50])
        if not hits:
            return 0.0, ""
        span = max(len(ws) * 2, 40)
        best, lo = 0, hits[0]
        j = 0
        for i, h in enumerate(hits):                  # window with the most hits
            while hits[j] < h - span:
                j += 1
            if i - j + 1 > best:
                best, lo = i - j + 1, hits[j]
        window = self.words[max(0, lo - len(ws)): lo + span]
        m = difflib.SequenceMatcher(None, ws, window, autojunk=False)
        matched = sum(b.size for b in m.get_matching_blocks() if b.size >= 4)
        return matched / len(ws), " ".join(window[:80])


def propositions() -> list[dict]:
    out = []
    for key in EU_FOR:
        name, journal = SOURCES[key]
        for p in parse(read_text(DIR / name, journal), key):
            if len(words(p.text)) >= N + 3:
                out.append({"version": key, "instrument": INSTRUMENT.get(key, "Bekanntmachung"),
                            "pid": p.pid, "part": p.part, "heading": p.heading, "text": p.text})
    return out


def quantile(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "provenance.json")
    args = ap.parse_args()

    props = propositions()
    eu = {k: Corpus(v) for k, v in EU.items()}
    eu_terms = {k: Corpus(v, terms=True) for k, v in EU.items()}
    null = Corpus(NULL)

    # The Commission repeats itself: the Horizontal Guidelines reproduce the
    # vertical regulation's dual-distribution clause word for word, so a
    # proposition copied from that clause scores 1.0 against them too. Noise
    # is what the proposition shares with the unrelated text and NOT with any
    # vertical text.
    vertical = set().union(*(c.index.keys() for c in eu.values()))

    def noise_of(ws):
        sh = shingles(ws)
        return sum(1 for s in sh if s in null.index and s not in vertical) / len(sh) if sh else 0.0

    noise = [noise_of(words(p["text"])) for p in props]
    t99, t95 = quantile(noise, 0.99), quantile(noise, 0.95)
    print(f"{len(props)} propositions; null (Horizontal Guidelines 2011): "
          f"median {statistics.median(noise):.3f}, p95 {t95:.3f}, p99 {t99:.3f}")

    for p, nz in zip(props, noise):
        ws = words(p["text"])
        c = eu[EU_FOR[p["version"]]]
        p["containment"] = round(c.containment(ws), 3)
        p["containment_terms"] = round(eu_terms[EU_FOR[p["version"]]].containment(words(p["text"], True)), 3)
        p["aligned"], p["eu_window"] = c.aligned(ws)
        p["aligned"] = round(p["aligned"], 3)
        p["null"] = round(nz, 3)
        # also against the EU texts of the other generations: an older text
        # can be the source of wording that survived a revision
        p["containment_any"] = round(max(x.containment(ws) for x in eu.values()), 3)
        s = p["containment"]
        p["class"] = "imported" if s >= IMPORTED else "own" if s <= t99 else "mixed"

    summary = collections.defaultdict(collections.Counter)
    for p in props:
        summary[(p["version"], p["instrument"])][p["class"]] += 1
    print(f"{'version':16} {'instrument':15} {'n':>4} {'imported':>9} {'mixed':>6} {'own':>5}  median")
    for (v, inst), cnt in summary.items():
        n = sum(cnt.values())
        med = statistics.median(p["containment"] for p in props if p["version"] == v)
        print(f"{v:16} {inst:15} {n:4} {cnt['imported']:9} {cnt['mixed']:6} {cnt['own']:5}  {med:.3f}")

    args.out.write_text(json.dumps({
        "method": {"n": N, "imported_at": IMPORTED, "own_up_to": t99, "null": NULL,
                   "null_p95": t95, "null_p99": t99, "eu_for": EU_FOR, "eu": EU, "terms": TERMS},
        "propositions": props}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
