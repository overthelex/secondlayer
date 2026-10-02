"""The annotation packet: every proposition with the passages the record offers it.

The human reader and the judge see this file and nothing else, so what it
shows decides what the labels can mean. Version 1 (2026-09-23, commit
7f03c151) took the eight best passages by cosine. Read against the lessons of
the Ukrainian audit (scripts/metodyka/packet.py) it showed every one of them:

* Recitation. Decisions quote the notice back ("Ziff. 1 VertBek ..."); a
  passage that restates a Ziffer is not evidence the Ziffer was applied.
  Each passage now carries the share of the proposition it reproduces word
  for word, and recitation is shown last.
* One decision several times. The journal prints a decision in German,
  French and Italian as separate items; the Federal Administrative Court
  republishes a judgment under a second date; an entscheidsuche file and its
  journal copy are the same decision. These collapse into one family and the
  packet shows a family once.
* The agency crowded out. The paper's claim is about WEKO, so its own
  non-merger decisions get the first slots where the pool holds any;
  merger clearances (ancillary non-competes are a different rule) and other
  federal authorities (EDÖB, ElCom: "Geschäftsgeheimnis" for Know-how) are
  capped.
* Two columns read across. Journal passages are shown in column order.
* No tier, regime or date. Every passage now carries its evidence tier,
  the cartel-act regime it was decided under and its date (exact, or the
  journal issue's upper bound; see dates.py), and whether it postdates the
  version that introduced the proposition.

The notices themselves (journal part D1) are never evidence.

Controls ride in the same file so the reader and the judge see one set:
fabricated propositions that must come back absent, Art. 5 KG verbatim that
must come back supported, and Art. 5 para. 4 against the record before
1 April 2004 only, which must come back absent (the regime control).

    python3 packet.py --dsn ... --out /data/ch-corpus/weko-bek/packet.json
"""
from __future__ import annotations

import argparse
import collections
import difflib
import functools
import itertools
import json
import pathlib
import random
import re
import subprocess
import sys
from datetime import date

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "services" / "ch-pipeline"))
from chpipe import rpw  # noqa: E402
from propositions import (_NOTE_CALL, _SPACED_HYPHEN, SOURCES, dehyphenate, parse,  # noqa: E402
                          read_text)
from retrieve import dense_index, embed  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")
PLAN = [("2022-12-12", 20), ("2022-12-12-erl", 15), ("2010-06-28", 10), ("2002-02-18", 5)]
SEED = 23
K = 8

POOL_DECISIONS = 120      # the retrieval gate passed at k=100 decisions (PAPER-186)
PER_DECISION = 3          # passages kept per decision to choose a non-recital one from
CLOSE = 0.03              # a lower-ranked passage of the same decision is "as good" within this
RECITAL = 0.40            # share of the proposition reproduced verbatim: recitation
FRESH = 0.25              # below this the passage states the matter in its own words
TWIN = 0.80               # word-level ratio for near-identical passages
AGENCY_SLOTS = 3
MERGER_CAP = 2
OTHER_CAP = 1
FAMILY_JACCARD = 0.6      # numeric-token overlap of two journal items in one issue section
FAMILY_MIN_NUMBERS = 15   # below this a decision has too few numbers to compare

TIER1 = {"CH_WEKO", "CH_WEKO_RPW", "CH_BGE", "CH_BGer", "CH_BVGer"}
AGENCY = {"CH_WEKO", "CH_WEKO_RPW"}

KG95_IN_FORCE = date(1996, 7, 1)
KG03_IN_FORCE = date(2004, 4, 1)

# Art. 5 KG as in force since 2004-04-01 (ch_act 9447, edition 2023-07-01).
ART5_1 = ("Abreden, die den Wettbewerb auf einem Markt für bestimmte Waren oder Leistungen "
          "erheblich beeinträchtigen und sich nicht durch Gründe der wirtschaftlichen Effizienz "
          "rechtfertigen lassen, sowie Abreden, die zur Beseitigung wirksamen Wettbewerbs führen, "
          "sind unzulässig.")
ART5_2 = ("Wettbewerbsabreden sind durch Gründe der wirtschaftlichen Effizienz gerechtfertigt, "
          "wenn sie notwendig sind, um die Herstellungs- oder Vertriebskosten zu senken, Produkte "
          "oder Produktionsverfahren zu verbessern, die Forschung oder die Verbreitung von "
          "technischem oder beruflichem Wissen zu fördern oder um Ressourcen rationeller zu nutzen; "
          "und den beteiligten Unternehmen in keinem Fall Möglichkeiten eröffnen, wirksamen "
          "Wettbewerb zu beseitigen.")
ART5_4 = ("Die Beseitigung wirksamen Wettbewerbs wird auch vermutet bei Abreden zwischen "
          "Unternehmen verschiedener Marktstufen über Mindest- oder Festpreise sowie bei Abreden "
          "in Vertriebsverträgen über die Zuweisung von Gebieten, soweit Verkäufe in diese durch "
          "gebietsfremde Vertriebspartner ausgeschlossen werden.")

# Written for this audit, false in Swiss law; nothing in the record can hold them.
FABRICATED = [
    "Vertikale Abreden über Höchstpreise sind unzulässig, sobald der Marktanteil der Anbieterin "
    "10 % übersteigt, und können nicht durch Gründe der wirtschaftlichen Effizienz gerechtfertigt "
    "werden.",
    "Ein Wettbewerbsverbot in einem Vertriebsvertrag ist ohne zeitliche Begrenzung zulässig, "
    "sofern die Abnehmerin ihren Sitz im Ausland hat und die Vertragswaren dort weiterverkauft.",
    "Selektive Vertriebssysteme sind nur zulässig, wenn die Anbieterin der Wettbewerbskommission "
    "jährlich eine Liste sämtlicher zugelassener Händler einreicht und diese veröffentlicht wird.",
    "Die Anbieterin darf den Online-Verkauf vollständig untersagen, wenn die Abnehmerin weniger "
    "als fünf stationäre Verkaufsstellen in der Schweiz betreibt.",
]

CONTROLS = (
    [{"kind": "negative", "pid": f"N{i + 1}", "text": t} for i, t in enumerate(FABRICATED)]
    + [{"kind": "positive", "pid": "P1", "text": ART5_1},
       {"kind": "positive", "pid": "P2", "text": ART5_2},
       {"kind": "positive", "pid": "P3", "text": ART5_4},
       {"kind": "regime", "pid": "R1", "text": ART5_4, "before": KG03_IN_FORCE}]
)


def regime(d: date | None) -> str | None:
    if d is None:
        return None
    if d < KG95_IN_FORCE:
        return "KG 1985"
    if d < KG03_IN_FORCE:
        return "KG 1995"
    return "KG 2003"


def tier(spider: str) -> str:
    if spider in TIER1:
        return "1"
    if re.fullmatch(r"[A-Z]{2}_.+", spider) and not spider.startswith("CH_"):
        return "2"
    return "other"


def version_date(version: str) -> date:
    return date.fromisoformat(version[:10])


def pick() -> list:
    """The same 50 propositions as version 1 (seed 23)."""
    random.seed(SEED)
    picked = []
    for key, n in PLAN:
        name, journal = SOURCES[key]
        props = [p for p in parse(read_text(DIR / name, journal), key) if len(p.text) > 200]
        picked += random.sample(props, min(n, len(props)))
    return picked


# --- the record ------------------------------------------------------------

META = """
SELECT a.ecli, a.spider, a.docket_number, a.rpw_chapter,
       a.date_exact, a.date_upper_bound, a.date_source,
       c.metadata_json->'rpw'->>'issue_key'    AS issue_key,
       c.metadata_json->'rpw'->>'section'      AS section,
       c.metadata_json->'rpw'->>'section_name' AS section_name,
       c.metadata_json->'rpw'->>'same_as'      AS same_as,
       c.metadata_json->>'Sprache'             AS lang,
       (c.metadata_json->'rpw'->>'pdf_page')::int        AS pdf_page,
       c.metadata_json->'rpw'->'journal_pages'           AS journal_pages,
       left(a.full_text, 600)                  AS opening
  FROM ch_weko_audit_corpus a JOIN ch_court_decisions c USING (ecli)
"""


def numbers(text: str) -> set[str]:
    return set(re.findall(r"\b\d{2,}(?:[.,/]\d+)*\b", text or ""))


def families(conn, meta: dict) -> dict[str, str]:
    """ecli -> family id. One decision printed in several languages, published
    twice, or held both as an entscheidsuche file and a journal item is one
    family. Language versions are found by their numbers: margin numbers,
    articles, dates and percentages survive translation (the German, French
    and Italian items of RPW 2019/4 B 2.8.4-6 overlap at 0.92-0.96), and a
    pair is only compared inside one issue section."""
    parent = {e: e for e in meta}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        if a in parent and b in parent:
            parent[find(a)] = find(b)

    for e, m in meta.items():
        if m["same_as"]:
            union(e, m["same_as"])
    # A court judgment republished under a second date carries one docket
    # (B-7920/2015); a cantonal one can arrive through two spiders
    # (SG_Gerichte and SG_Publikationen both hold HG.2011.286). The docket,
    # normalised, is the key; Swiss dockets carry their year.
    by_docket = collections.defaultdict(list)
    for e, m in meta.items():
        if m["spider"] not in AGENCY and m["docket_number"]:
            key = re.sub(r"[^0-9A-Za-z]", "", m["docket_number"]).upper()
            if len(key) >= 6:
                by_docket[key].append(e)
    for es in by_docket.values():
        for e in es[1:]:
            union(es[0], e)

    texts = {r["ecli"]: r["full_text"] for r in conn.execute(
        "SELECT ecli, full_text FROM ch_weko_audit_corpus WHERE spider = 'CH_WEKO_RPW'").fetchall()}
    by_section = collections.defaultdict(list)
    for e, m in meta.items():
        if m["spider"] == "CH_WEKO_RPW" and m["rpw_chapter"] != "D1":
            by_section[(m["issue_key"], m["section"])].append(e)
    nums = {e: numbers(t) for e, t in texts.items()}
    for es in by_section.values():
        for a, b in itertools.combinations(es, 2):
            na, nb = nums.get(a, set()), nums.get(b, set())
            u = na | nb
            if len(u) >= FAMILY_MIN_NUMBERS and len(na & nb) / len(u) >= FAMILY_JACCARD:
                union(a, b)
    return {e: find(e) for e in meta}


def source_class(m: dict) -> str:
    if m["spider"] in AGENCY:
        merger = (m["section_name"] or "").startswith("Unternehmenszusammenschl") or bool(
            re.search(r"Zusammenschluss|concentration|concentrazione", m["opening"] or "")
            and m["spider"] == "CH_WEKO")
        return "merger" if merger else "agency"
    t = tier(m["spider"])
    return {"1": "court", "2": "cantonal"}.get(t, "other")


# --- choosing the passages --------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"-\s*\n\s*", "", text.lower())).strip()


def recital_share(proposition: str, passage: str) -> float:
    """How much of the proposition the passage reproduces word for word
    (longest common run over the proposition's length)."""
    a, b = _norm(proposition), _norm(passage)
    m = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return m.find_longest_match(0, len(a), 0, len(b)).size / max(len(a), 1)


def _words(text: str) -> list[str]:
    return re.findall(r"[A-Za-zÄÖÜäöüßÀ-ÿ]+", text.lower())


def twins(a: list[str], b: list[str]) -> bool:
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() > TWIN


# Page furniture the PDF text carries into a passage: a page number on its
# own line, the journal's running header, an agency file number with its page
# ("22-00027/COO.2101.111.7.305747  38"), the publication stamp.
_FURNITURE = re.compile(
    r"^\s*(?:\d{1,4}"
    r"|.*\b(?:RPW/DPC|DPC/RPW)\b.*"
    r"|RPW \d{4}/\d[a-z]?\s+\d{1,4}"
    r"|\d{1,4}\s+RPW \d{4}/\d[a-z]?"
    r"|.*COO\.\d{4}\.\d+(?:\.\d+)*\s+\d{1,4}"
    r"|\[Publikationsversion\]"
    r"|Seite \d+ von \d+)\s*$")


ISSUES = pathlib.Path("/data/ch-corpus/raw/CH_WEKO_RPW/issues")


@functools.lru_cache(maxsize=256)
def journal_pages_text(issue_key: str, first: int, last: int) -> str:
    """The decision's pages of the journal issue, in reading order.

    pdftotext WITHOUT -layout follows the columns; the stored full text was
    extracted with -layout, and a 1,200-character window of a two-column page
    holds pieces of both columns that do not join. Even split at the column
    edge, such a window reads "... nach Art. 5" / "bestimmte Waren ...".
    """
    pdf = ISSUES / f"RPW_{issue_key}.pdf"
    if not pdf.exists():
        return ""
    out = subprocess.run(["pdftotext", "-f", str(first), "-l", str(last), str(pdf), "-"],
                         capture_output=True, text=True, timeout=120).stdout
    lines = [ln for ln in out.splitlines() if not _FURNITURE.match(ln)]
    return dehyphenate("\n".join(lines))


def reading_window(clean: str, passage: str) -> str | None:
    """The stretches of the reading-order text that hold the passage.

    A layout window of a two-column page holds two pieces that lie far apart
    in reading order (the bottom of the left column, the top of the right),
    so the passage is found as up to two dense runs of its word 4-grams.
    Each run is shown with a few words of margin, in reading order, joined
    by "[…]". None when the densest run holds fewer than a fifth of the
    passage's 4-grams (at least 8).
    """
    tokens = [(m.group(0).lower(), m.start(), m.end()) for m in re.finditer(r"[^\W\d_]+|\d+", clean)]
    pw = [w.lower() for w in re.findall(r"[^\W\d_]+|\d+", dehyphenate(two_columns(passage)))]
    if len(pw) < 20 or len(tokens) < 20:
        return None
    grams = {tuple(pw[i:i + 4]) for i in range(len(pw) - 3)}
    hits = [i for i in range(len(tokens) - 3)
            if tuple(t[0] for t in tokens[i:i + 4]) in grams]
    need = max(8, len(grams) / 5)

    def densest(hs: list[int]) -> tuple[int, int, int]:
        """(count, first, last) of the densest run: neighbours within 12 tokens."""
        best = (0, 0, 0)
        i = 0
        while i < len(hs):
            j = i
            while j + 1 < len(hs) and hs[j + 1] - hs[j] <= 12:
                j += 1
            if j - i + 1 > best[0]:
                best = (j - i + 1, hs[i], hs[j])
            i = j + 1
        return best

    first = densest(hits)
    if first[0] < need:
        return None
    runs = [first]
    rest = [h for h in hits if not first[1] - 12 <= h <= first[2] + 12]
    second = densest(rest)
    if second[0] >= max(8, need / 2):
        runs.append(second)
    pieces = []
    for _, lo, hi in sorted(runs, key=lambda r: r[1]):
        a = max(0, lo - 8)
        b = min(len(tokens) - 1, hi + 3 + 8)
        pieces.append(clean[tokens[a][1]:tokens[b][2]])
    return "\n[…]\n".join(pieces)


def two_columns(text: str) -> str:
    """A journal passage in column order: the left column, then the right.

    chpipe.rpw.reading_order finds the column edge from lines where both
    columns stand side by side, and wants five of them. A 1,200-character
    passage often has fewer: in the first v3 packet 62 journal passages still
    read across the columns ("ein neues Pro- B.4.4. Rechtfertigung ... dukt
    auf den Markt"). Here the lines that carry only the right column count as
    well -- they start at the edge after a run of indentation -- and three
    observations are enough when they agree."""
    lines = text.splitlines()
    starts: collections.Counter = collections.Counter()
    for line in lines:
        m = re.match(r"^( {25,})\S", line)
        if m and 30 <= len(m.group(1)) <= 95:
            starts[len(m.group(1))] += 1
            continue
        for g in re.finditer(r"\S\s{3,}(?=\S)", line):
            if 30 <= g.end() <= 95:
                starts[g.end()] += 1
    if not starts:
        return text
    edge = max(starts, key=lambda c: sum(starts[c + d] for d in range(-2, 3)))
    if sum(starts[edge + d] for d in range(-2, 3)) < 3:
        return text
    split = edge - 2
    left = [ln[:split].rstrip() for ln in lines]
    right = [ln[split:].strip() for ln in lines]
    return "\n".join(x for x in left if x.strip()) + "\n" + "\n".join(x for x in right if x)


def readable(spider: str, text: str) -> str:
    """What the reader and the judge see of a passage, measured clean on
    2026-10-01: in the first v2 packet 78% of passages carried words broken
    across lines ("Wettbe-" / "werb"), 14% a page number on its own line, 5%
    the journal's running header and 8% footnote calls glued to words.
    Journal passages are put in column order first."""
    if spider == "CH_WEKO_RPW":
        text = two_columns(text)
    lines = [ln for ln in text.splitlines() if not _FURNITURE.match(ln)]
    text = dehyphenate("\n".join(lines))
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = _SPACED_HYPHEN.sub(r"\1\2", text)
    text = _NOTE_CALL.sub("", text)
    return text.strip()


def candidates(index, query: np.ndarray, allowed) -> dict[str, list[tuple[float, int]]]:
    """ecli -> its best passages [(score, ord)], for the top POOL_DECISIONS decisions."""
    vectors, eclis, ords = index
    scores = vectors @ query
    out: dict[str, list[tuple[float, int]]] = {}
    for i in np.argsort(-scores)[:20_000]:
        e = str(eclis[i])
        if not allowed(e):
            continue
        if e not in out:
            if len(out) >= POOL_DECISIONS:
                continue
            out[e] = []
        if len(out[e]) < PER_DECISION:
            out[e].append((float(scores[i]), int(ords[i])))
        if len(out) >= POOL_DECISIONS and all(len(v) >= PER_DECISION for v in out.values()):
            break
    return out


def bodies(conn, keys: list[tuple[str, int]]) -> dict:
    rows = conn.execute(
        "SELECT p.ecli, p.ord, p.text FROM ch_weko_audit_passages p "
        "JOIN unnest(%s::text[], %s::int[]) AS k(ecli, ord) USING (ecli, ord)",
        ([k[0] for k in keys], [k[1] for k in keys])).fetchall()
    return {(r["ecli"], r["ord"]): r["text"] for r in rows}


def pool(conn, index, meta, family, text: str, query: np.ndarray,
         before: date | None = None) -> tuple[list[dict], dict]:
    def allowed(e: str) -> bool:
        m = meta.get(e)
        if m is None or m["rpw_chapter"] == "D1":
            return False
        if before is not None:
            return m["date_upper_bound"] is not None and m["date_upper_bound"] < before
        return True

    cands = candidates(index, query, allowed)
    body = bodies(conn, [(e, o) for e, ps in cands.items() for _, o in ps])

    rows = []
    for e, ps in cands.items():
        best = ps[0][0]
        options = []
        for score, o in ps:
            if score < best - CLOSE:
                continue
            b = body.get((e, o), "")
            options.append((recital_share(text, b), -score, o, score, b))
        share, _, o, score, b = min(options)
        m = meta[e]
        rows.append({"ecli": e, "ord": o, "score": score, "best": best,
                     "recital_share": round(share, 3), "body": b,
                     "family": family[e], "class": source_class(m), "_words": _words(b)})

    ordered = sorted(rows, key=lambda r: (0 if r["recital_share"] < FRESH else
                                          1 if r["recital_share"] < RECITAL else 2, -r["best"]))
    chosen: list[dict] = []
    caps = {"merger": MERGER_CAP, "other": OTHER_CAP}

    def take(candidates_, limit):
        for r in candidates_:
            if len(chosen) >= limit:
                return
            if any(r["family"] == c["family"] for c in chosen):
                continue
            if r["class"] in caps and sum(c["class"] == r["class"] for c in chosen) >= caps[r["class"]]:
                continue
            if any(twins(r["_words"], c["_words"]) for c in chosen):
                continue
            chosen.append(r)

    take([r for r in ordered if r["class"] == "agency"], AGENCY_SLOTS)
    take(ordered, K)
    chosen.sort(key=lambda r: -r["score"])

    stats = {
        "pool": len(rows),
        "recital_in_pool": sum(r["recital_share"] >= RECITAL for r in rows),
        "agency_in_pool": sum(r["class"] == "agency" for r in rows),
    }
    return chosen, stats


def view(m: dict, body: str) -> tuple[str, str]:
    """(text, how) for the reader: a journal passage from the issue in
    reading order where it can be found there, else its stored text."""
    if m["spider"] == "CH_WEKO_RPW" and m.get("pdf_page") and m.get("journal_pages"):
        first = m["pdf_page"]
        pages = m["journal_pages"]
        last = first + (pages[-1] - pages[0] if len(pages) > 1 else 0)
        window = reading_window(journal_pages_text(m["issue_key"], first, last), body)
        if window:
            window = "\n".join(ln for ln in window.splitlines() if not _FURNITURE.match(ln))
            text = re.sub(r"[ \t]{2,}", " ", window)
            text = _NOTE_CALL.sub("", _SPACED_HYPHEN.sub(r"\1\2", text))
            return text.strip(), "issue_reading_order"
    return readable(m["spider"], body), "stored"


def evidence(r: dict, meta: dict, vdate: date | None, cited: set[str]) -> dict:
    m = meta[r["ecli"]]
    exact, bound = m["date_exact"], m["date_upper_bound"]
    if vdate is None:
        after = None
    elif exact is not None:
        after = exact > vdate
    elif bound is not None and bound <= vdate:
        after = False
    else:
        after = None
    return {
        "ecli": r["ecli"], "ord": r["ord"], "score": round(r["score"], 3),
        "spider": m["spider"], "docket": m["docket_number"], "lang": m["lang"],
        "section": m["section_name"],
        "tier": tier(m["spider"]), "source": r["class"],
        "date": str(exact or ""), "date_upper_bound": str(bound or ""),
        "date_source": m["date_source"],
        "regime": regime(exact or bound), "regime_exact": exact is not None,
        "after_version": after,
        "recital_share": r["recital_share"], "recital": r["recital_share"] >= RECITAL,
        "cites_this": r["ecli"] in cited,
        "text": view(m, r["body"])[0][:1800],
        "text_view": view(m, r["body"])[1],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--tei", default="http://172.30.0.2:80")
    ap.add_argument("--gold", type=pathlib.Path, default=DIR / "goldset.json")
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "packet.json")
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)

    meta = {r["ecli"]: r for r in conn.execute(META).fetchall()}
    family = families(conn, meta)
    print(f"record: {len(meta)} decisions in {len(set(family.values()))} families", flush=True)

    cited: dict[tuple[str, str], set[str]] = collections.defaultdict(set)
    for g in json.loads(args.gold.read_text(encoding="utf-8")):
        for r in g.get("resolved", []):
            cited[(g["version"], g["pid"])].add(r["ecli"])

    items = [{"kind": "sample", "version": p.version, "pid": p.pid, "part": p.part,
              "heading": p.heading, "lead": p.lead, "text": p.text} for p in pick()]
    items += [{"version": "control", "part": "control", "heading": "", "lead": "", **c} for c in CONTROLS]

    index = dense_index()
    cache: dict = {}
    out, totals = [], collections.Counter()
    for it in items:
        q = np.asarray(embed([it["text"]], args.tei, cache)[0], dtype="float32")
        q /= max(float(np.linalg.norm(q)), 1e-9)
        before = it.pop("before", None)
        chosen, stats = pool(conn, index, meta, family, it["text"], q, before)
        vdate = version_date(it["version"]) if it["kind"] == "sample" else None
        cset = cited.get((it.get("version"), it["pid"]), set())
        ev = [evidence(r, meta, vdate, cset) for r in chosen]
        out.append({**it, "before": str(before or ""), "pool": stats, "evidence": ev})
        totals["passages"] += len(ev)
        totals["recital"] += sum(e["recital"] for e in ev)
        for e in ev:
            totals["source:" + e["source"]] += 1
            totals["tier:" + e["tier"]] += 1
        print(f"  {it['kind']:8} {it['version']:15} {it['pid']:8} {len(ev)} passages, "
              f"{sum(not e['recital'] for e in ev)} not recitation, "
              f"{sum(e['source'] == 'agency' for e in ev)} agency "
              f"(pool {stats['pool']}, agency {stats['agency_in_pool']}, "
              f"recital {stats['recital_in_pool']})", flush=True)

    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} items, {totals['passages']} passages -> {args.out}")
    for k, v in sorted(totals.items()):
        print(f"  {k:20} {v:5}  ({100 * v / max(totals['passages'], 1):.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
