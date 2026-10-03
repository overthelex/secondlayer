"""The citation-anchor test (PAPER-233): do the decisions the Erläuterungen
cite hold the sentence they are cited for?

Schrepel and Jenny's test of the Commission's draft guidelines: the
citations are real, but what do they anchor? Here the unit is the pair
(sentence of the Erläuterungen, decision cited in its footnote):

  1. footnotes, read in their own sequence (1, 2, 3, ... -- a line
     "<k> <text>" is footnote k only when k is the next number expected);
  2. each footnote's marker in the body text ("Bekanntmachung1",
     "gelten.3", "VertBek).5"), again in sequence, and the sentence it closes;
  3. the Swiss decisions cited in the footnote (BGE, RPW page, BGer and
     BVGer dockets), resolved to the record by docket or, for an RPW page,
     by the item of that issue whose first page is the last one at or before it;
  4. the passages of the cited decision: the one holding the pinpoint
     (Rz or Erwägung) where it can be found, and the nearest by meaning.

The judges then read each pair under protocol v2, as they read the record.

    python3 anchors.py --dsn ... --out /data/ch-corpus/weko-bek/packet_anchors.json
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from propositions import SOURCES, parse, read_text  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")
VERSIONS = ("2019-04-09", "2022-12-12-erl")

MARGIN = re.compile(r"^\s{0,6}(\d{1,3})\.\s+\S")
PAGE_FOOT = re.compile(r"^\s*(\d+/\d+|\d{1,3}|\d{2,3}-\d{5}/COO\.[\d.]+)\s*$")

BGE = re.compile(r"BGE\s*(\d{2,3})\s+(I[AB]|II|III|IV|V|I)[ab]?\s+(\d+)"
                 r"(?:\s*,\s*(\d+)(?:\s*f{1,2}\.)?)?(?:\s*E\.?\s*([\d.]+\d))?", re.I)
RPW = re.compile(r"RPW\s+(\d{4})/(\d)[ab]?,\s*(?:S\.\s*)?(\d+)(?:\s*f{1,2}\.)?"
                 r"(?:\s*(?:Rz|E\.?)\s*([\d.]+\d|\d+))?")
BGER = re.compile(r"\b(\d[A-Z][_.]\d{1,4}/\d{4})")
# A court judgment the journal reprints in its part C, cited by its page
# there: "Urteil des BVGer vom 16.9.2016, RPW 2016/3, 852 E. 7.3.1, Nikon".
# The corpus holds parts B and D of the journal only, so such a page falls on
# the last part-B item before it -- in this case an Italian recommendation
# on Bernese administrative practice. The judgment itself is in the record
# under its own court, so it is found by court and date.
COURT_IN_RPW = re.compile(r"Urteil des (BVGer|BGer|Bundesverwaltungsgerichts|Bundesgerichts|[^,;]{3,60}?) "
                          r"vom (\d{1,2})\.(\d{1,2})\.(\d{4}),\s*RPW\s+(\d{4})/(\d)[ab]?,\s*(?:S\.\s*)?(\d+)"
                          r"(?:\s*f{1,2}\.)?(?:\s*(?:Rz|E\.?)\s*([\d.]+\d|\d+))?"
                          r"(?:(?:,\s*[\d.]+\d)*,\s*([A-ZÄÖÜ][^;,.]{1,40}))?")
COURT_SPIDERS = {"BVGer": ("CH_BVGer",), "Bundesverwaltungsgerichts": ("CH_BVGer",),
                 "BGer": ("CH_BGer", "CH_BGE"), "Bundesgerichts": ("CH_BGer", "CH_BGE")}
BVGER = re.compile(r"\b(B-\d{1,4}/\d{4})")


def footnotes(lines: list[str]) -> tuple[dict[int, str], set[int]]:
    """Footnote k -> its text; and the line numbers they occupy."""
    notes: dict[int, list[str]] = {}
    used: set[int] = set()
    k, cur = 1, None
    for i, line in enumerate(lines):
        m = re.match(rf"^\s{{0,8}}{k}\s+(\S.*)$", line)
        if m and not MARGIN.match(line):
            cur = k
            notes[k] = [m.group(1)]
            used.add(i)
            k += 1
            continue
        if cur is not None:
            if line.startswith("\f") or PAGE_FOOT.match(line) or MARGIN.match(line):
                cur = None
            elif line.strip():
                notes[cur].append(line.strip())
                used.add(i)
            else:
                # a blank line ends the block unless the footnote is carried over it
                cur = cur if notes[cur][-1].endswith(("-", ",")) else None
    return {n: re.sub(r"-\s+(?=[a-zäöü])", "", " ".join(t)) for n, t in notes.items()}, used


# Abbreviations whose full stop does not end a sentence in these texts.
ABBREV = {"ziff", "abs", "lit", "art", "vgl", "bzw", "rz", "nr", "s", "e", "f", "ff", "ca", "inkl", "usw",
          "resp", "sog", "gem", "z", "b", "d", "h", "u", "a", "m", "w", "erw", "bst", "kg", "bger", "bvger",
          "i", "v", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "fn", "ag",
          "dgl", "evtl", "insb", "mio", "mrd", "rs", "sr"}


def sentence_starts(text: str) -> list[int]:
    """Positions where a sentence begins: after '. ', '? ', '! ' or a bullet,
    unless the word before the stop is an abbreviation or a number."""
    out = [0]
    for m in re.finditer(r"[.?!]\s+(?=[A-ZÄÖÜ«„(•])|•\s*", text):
        if m.group(0).startswith("•"):
            out.append(m.end())
            continue
        word = re.search(r"([\wäöüÄÖÜß]+)$", text[:m.start()])
        if word and (word.group(1).lower() in ABBREV or word.group(1).isdigit()):
            continue
        out.append(m.end())
    return out


def markers(lines: list[str], used: set[int], count: int) -> dict[int, dict]:
    """Footnote k -> {rz, sentence}, found in sequence in the body text."""
    body, rz_at = [], []
    rz = None
    for i, line in enumerate(lines):
        if i in used or PAGE_FOOT.match(line) or line.startswith("\f"):
            continue
        m = MARGIN.match(line)
        if m:
            rz = int(m.group(1))
        body.append(line.strip())
        rz_at.append(rz)
    text, owner = "", []
    for line, r in zip(body, rz_at):
        piece = line + " "
        text += piece
        owner += [r] * len(piece)
    out, pos = {}, 0
    for k in range(1, count + 1):
        m = re.compile(rf"(?<=[A-Za-zäöüÄÖÜß.,;:)»“\"])({k})(?=[\s.,;:)]|$)").search(text, pos)
        if not m:
            continue
        pos = m.end()
        starts = sentence_starts(text)
        begin = max(x for x in starts if x <= m.start())
        if text[m.start() - 1] in ".;:!?":
            sent = text[begin: m.start()]           # the marker closes the sentence
        else:                                        # it sits inside one: take the whole sentence
            nxt = min((x for x in starts if x > m.end()), default=len(text))
            sent = text[begin: m.start()] + text[m.end(): nxt]
        sent = re.sub(r"\s+", " ", re.sub(r"(\w)-\s+([a-zäöü])", r"\1\2", sent)).strip()
        sent = re.sub(r"(?<=[A-Za-zäöüß.,;:)»])\d{1,3}(?=[\s.,;:)]|$)", "", sent)   # other markers
        words = re.findall(r"[A-Za-zäöüÄÖÜß]{3,}", re.sub(r"(\w)-\s+([a-zäöü])", r"\1\2", text[max(0, m.start() - 160): m.start()]))
        out[k] = {"rz": owner[m.start()], "sentence": sent, "anchor_words": words[-6:]}
    return out


def cited_sentence(paragraph: str, words: list[str]) -> str | None:
    """The sentence of the clean paragraph that ends with the words before
    the marker (the raw body text carries page furniture and headings; the
    parsed paragraph does not)."""
    if not words:
        return None
    # between the words: numbers, punctuation, markers and words of one or two
    # letters ("KG", "zu"); inside a word, a hyphen the line break left
    # ("Lizenz- oder" in the paragraph, "Lizenzoder" in the raw text)
    sep = r"(?:[^A-Za-zäöüÄÖÜß]+|\b[A-Za-zäöüÄÖÜß]{1,2}\b)+"
    word = lambda w: r"(?:-\s*)?".join(re.escape(c) for c in w)
    pat = sep.join(word(w) for w in words)
    m = None
    for m in re.finditer(pat, paragraph):
        pass                                  # the last occurrence, as the marker closes it
    if not m:
        return None
    starts = sentence_starts(paragraph)
    begin = max(x for x in starts if x <= m.start())
    end = min((x for x in starts if x > m.end()), default=len(paragraph))
    return paragraph[begin:end].strip()


def cites(note: str) -> list[dict]:
    """The Swiss decisions a footnote cites, with their pinpoints. A BGE's
    parallel '(= RPW ...)' is the same decision and is dropped."""
    note = re.sub(r"\(=\s*RPW[^)]*\)", "", note)
    out = []
    for m in COURT_IN_RPW.finditer(note):
        out.append({"kind": "court", "ref": f"{m.group(1)} {m.group(4)}-{int(m.group(3)):02d}-{int(m.group(2)):02d}",
                    "court": m.group(1), "date": f"{m.group(4)}-{int(m.group(3)):02d}-{int(m.group(2)):02d}",
                    "page": int(m.group(7)), "pin": m.group(8), "name": (m.group(9) or "").strip(),
                    "raw": m.group(0)})
    note = COURT_IN_RPW.sub(" ", note)          # its RPW page is not a WEKO decision
    for m in BGE.finditer(note):
        out.append({"kind": "BGE", "ref": f"BGE {m.group(1)} {m.group(2).upper()} {m.group(3)}",
                    "page": m.group(4), "pin": m.group(5), "raw": m.group(0)})
    for m in RPW.finditer(note):
        out.append({"kind": "RPW", "ref": f"RPW {m.group(1)}/{m.group(2)}", "page": int(m.group(3)),
                    "pin": m.group(4), "raw": m.group(0)})
    for rx, kind in ((BGER, "BGer"), (BVGER, "BVGer")):
        for m in rx.finditer(note):
            out.append({"kind": kind, "ref": m.group(1).replace(".", "_"), "page": None, "pin": None,
                        "raw": m.group(0)})
    return out


def resolver(conn):
    rows = conn.execute("SELECT ecli, spider, docket_number, coalesce(date_exact, decision_date) AS d "
                        "FROM ch_weko_audit_corpus WHERE rpw_chapter IS DISTINCT FROM 'D1'").fetchall()
    by_docket = collections.defaultdict(list)
    rpw = collections.defaultdict(list)          # "RPW 2016/3" -> [(first page, ecli, docket)]
    for r in rows:
        d = (r["docket_number"] or "").strip()
        by_docket[re.sub(r"\s+", " ", d).upper()].append(r)
        m = re.match(r"RPW (\d{4}/\d)[ab]?, S\. (\d+)", d)
        if m and r["spider"] == "CH_WEKO_RPW":
            rpw["RPW " + m.group(1)].append((int(m.group(2)), r["ecli"], d))
    for v in rpw.values():
        v.sort()

    def resolve(c: dict) -> dict | None:
        if c["kind"] == "court":
            spiders = COURT_SPIDERS.get(c["court"])
            hits = [r for r in rows if str(r["d"]) == c["date"]
                    and (r["spider"] in spiders if spiders else not r["spider"].startswith("CH_"))]
            if not hits:
                return None
            if len(hits) > 1 and c.get("name"):
                # several judgments that day: the one whose text names the case ("BMW/WEKO" -> BMW)
                word = re.split(r"[\s/]", c["name"])[0]
                named = [r for r in hits if conn.execute(
                    "SELECT 1 FROM ch_weko_audit_corpus WHERE ecli = %s AND full_text ILIKE %s",
                    (r["ecli"], f"%{word}%")).fetchone()]
                hits = named or hits
            hits = sorted(hits, key=lambda r: (r["spider"] != "CH_BGE", r["ecli"]))
            return {"ecli": hits[0]["ecli"], "docket": hits[0]["docket_number"]}
        if c["kind"] == "RPW":
            items = [x for x in rpw.get(c["ref"], []) if x[0] <= c["page"]]
            if not items:
                return None
            first, ecli, docket = items[-1]
            return {"ecli": ecli, "docket": docket}
        key = c["ref"].upper()
        hits = by_docket.get(key) or [r for k, rs in by_docket.items()
                                      if re.search(rf"(^|\s){re.escape(key)}($|\s|,)", k) for r in rs]
        if not hits:
            return None
        # several copies of one judgment (sources, languages): prefer the federal reporter, then German
        hits = sorted(hits, key=lambda r: (r["spider"] != "CH_BGE", r["spider"] != "CH_BGer", r["ecli"]))
        return {"ecli": hits[0]["ecli"], "docket": hits[0]["docket_number"]}
    return resolve


def pinpoint(rows: list[dict], pin: str | None) -> int | None:
    """The passage holding the pinpoint: an RPW margin number ("75. Für die
    Anwendung ...") or a BGE Erwägung ("6.2.3" on its own line), at the start
    of a line so that "85 Rz 171" in a footnote does not count."""
    if not pin:
        return None
    rx = re.compile(rf"(?m)^\s*{re.escape(pin)}(?:\.\s+[A-ZÄÖÜ«„(]|\s*$|\s+[A-ZÄÖÜ])")
    for r in rows:
        if rx.search(r["text"]):
            return r["ord"]
    return None


def build_packet(conn, pairs: list[dict], tei: str, per_item: int = 4, no_pin: int = 8) -> list[dict]:
    """One item per (version, cited sentence, decision), with up to four
    passages of the decision: the pinpoint and the one after it, then the
    nearest to the sentence by meaning."""
    import numpy as np
    import packet as pk
    from retrieve import dense_index, embed
    meta = {r["ecli"]: r for r in conn.execute(pk.META).fetchall()}
    vectors, eclis, ords = dense_index()
    eclis = np.asarray([str(e) for e in eclis])
    cache: dict = {}
    items: dict[tuple, dict] = {}
    for p in pairs:
        if not p["resolved"] or p["rz"] is None:
            continue
        claim = p["sentence"] or p["paragraph"]
        if not claim:
            continue
        ecli = p["resolved"]["ecli"]
        key = (p["version"], claim, ecli)
        it = items.get(key)
        if it:
            it["footnotes"].append(p["footnote"])
            it["pins"] = sorted(set(it["pins"]) | ({p["pin"]} if p["pin"] else set()))
            continue
        items[key] = {"version": p["version"], "rz": p["rz"], "claim": claim, "claim_is_sentence": p["sentence_found"],
                      "ecli": ecli, "docket": p["resolved"]["docket"], "kind": "anchor",
                      "footnotes": [p["footnote"]], "pins": [p["pin"]] if p["pin"] else [], "cited_as": p["raw"]}
    out = []
    for n, it in enumerate(items.values(), 1):
        rows = conn.execute("SELECT ecli, ord, text FROM ch_weko_audit_passages_v2 WHERE ecli = %s ORDER BY ord",
                            (it["ecli"],)).fetchall()
        chosen, how = [], {}
        for pin in it["pins"]:
            o = pinpoint(rows, pin)
            if o is not None:
                for oo in (o, o + 1):
                    if oo not in chosen and any(r["ord"] == oo for r in rows):
                        chosen.append(oo); how[oo] = "pinpoint"
        limit = per_item if chosen else no_pin       # without the cited place, read more of the decision
        mask = np.where(eclis == it["ecli"])[0]
        if len(mask):
            q = np.asarray(embed([it["claim"]], tei, cache)[0], dtype="float32")
            q /= max(float(np.linalg.norm(q)), 1e-9)
            sc = vectors[mask] @ q
            for i in mask[np.argsort(-sc)]:
                o = int(ords[i])
                if len(chosen) >= limit:
                    break
                if o not in chosen:
                    chosen.append(o); how[o] = "nearest"
        body = {r["ord"]: r["text"] for r in rows}
        ev = []
        for o in chosen[:limit]:
            e = pk.evidence({"ecli": it["ecli"], "ord": o, "score": 0.0, "class": "cited",
                             "recital_share": 0.0, "body": body[o]}, meta, None, {it["ecli"]})
            e["how"] = how[o]
            ev.append(e)
        out.append({"version": it["version"], "pid": f"Rz{it['rz']}.{n}", "rz": it["rz"], "kind": "anchor",
                    "part": "anchor", "heading": f"Erläuterungen Rz {it['rz']}, cited for this sentence: "
                                                  f"{it['cited_as']}", "lead": "",
                    "text": it["claim"], "claim_is_sentence": it["claim_is_sentence"],
                    "cited_ecli": it["ecli"], "cited_docket": it["docket"], "footnotes": it["footnotes"],
                    "pins": it["pins"], "pinpoint_found": any(e["how"] == "pinpoint" for e in ev),
                    "evidence": ev})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "anchors.json")
    ap.add_argument("--packet", type=pathlib.Path, help="also build the judges' packet here")
    ap.add_argument("--tei", default="http://172.30.0.2:80")
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    resolve = resolver(conn)

    pairs = []
    for v in VERSIONS:
        name, journal = SOURCES[v]
        lines = read_text(DIR / name, journal).split("\n")
        notes, used = footnotes(lines)
        marks = markers(lines, used, len(notes))
        paragraphs = {p.pid: p.text for p in parse(read_text(DIR / name, journal), v)}
        n_cites = n_res = 0
        for k, note in notes.items():
            for c in cites(note):
                n_cites += 1
                hit = resolve(c)
                n_res += hit is not None
                mk = marks.get(k, {})
                para = paragraphs.get(str(mk.get("rz")))
                sent = cited_sentence(para, mk.get("anchor_words")) if para else None
                pairs.append({"version": v, "footnote": k, "rz": mk.get("rz"), "sentence": sent,
                              "paragraph": para, "sentence_found": sent is not None,
                              "note": note, **c, "resolved": hit})
        print(f"{v}: {len(notes)} footnotes, markers found {len(marks)}, Swiss citations {n_cites}, "
              f"resolved {n_res}")
    args.out.write_text(json.dumps(pairs, ensure_ascii=False, indent=1, default=str))
    unres = collections.Counter(p["ref"] for p in pairs if not p["resolved"])
    print("unresolved:", unres.most_common(40))
    if args.packet:
        items = build_packet(conn, pairs, args.tei)
        args.packet.write_text(json.dumps(items, ensure_ascii=False, indent=1, default=str))
        print(f"{len(items)} (sentence, decision) items -> {args.packet}; pinpoint found in "
              f"{sum(i['pinpoint_found'] for i in items)}; claim is the sentence in "
              f"{sum(i['claim_is_sentence'] for i in items)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
