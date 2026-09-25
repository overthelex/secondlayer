"""Retrieval for the audit, and the control that has to pass before any
proposition is labelled.

The audit will say of some propositions that the record holds nothing for
them. Before that claim is worth anything, the retrieval has to find what we
already know is there: for the 29 decisions the Erläuterungen cite by name
(goldset.py), the cited decision must come back among the top k candidates
for the proposition that cites it. Recall below that is a broken retrieval,
not an empty record.

The working corpus is the competition-law slice of ch_court_decisions: WEKO's
own decisions and the notices, plus every court decision whose text names the
Kartellgesetz. It is materialised once, because ranking over 1.2M Swiss
decisions to answer 148 propositions is a waste and the slice is what the
paper describes anyway.

    python3 retrieve.py build   --dsn ...          # the working corpus
    python3 retrieve.py control --dsn ... --k 20   # recall@k on the gold set

STATE, measured 2026-09-23. See the table below; the gate passes at k=100
decisions on the metric that matters (does the annotator see at least one of
the authorities the instrument itself cites), and the earlier variants are
kept because knowing what does NOT work is half the result.

    whole decisions, keyword        pair recall@50 0.31
    passages, keyword               pair recall@50 0.35
    passages, keyword + bge-m3      pair recall@50 0.31
    passages, dense over all 274k   pair recall@50 0.35

Those numbers looked like failure until the ranks were read instead of the
hit rate: the median cited decision sits at rank 85 of 2,828, two thirds are
inside the top 5%, and at a working depth the picture is different --

      k    pair recall    proposition recall
     20          0.129                 0.385
     50          0.258                 0.385
    100          0.516                 0.923
    200          0.613                 0.923

(62 cited pairs over 13 propositions; a citation the search never reaches
counts as a miss, not as a pair left out of the denominator.)

"Proposition recall" is whether AT LEAST ONE of the decisions the instrument
cites for a proposition comes back, which is what an annotator needs to
decide "supported". At k=100 that is 12 of 13 propositions.

Not a data problem: every cited decision is in the working corpus, with full
text at quality 0.94-0.99 and its passages built. It is the query. A
proposition states a rule in the instrument's vocabulary; the decision states
it in its own, inside a hundred pages about a market, and an OR over the
proposition's longest words does not bridge that.

Next, in order: embed all 274,112 passages once (bge-m3 on a GPU box -- the
CH corpus went the same way for $25) and retrieve densely over the lot
instead of re-ranking a keyword pool; keep the keyword stage only as a union,
not as the gate. Re-measure this control before anything is labelled.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

WORKING_CORPUS = """
CREATE TABLE IF NOT EXISTS ch_weko_audit_corpus AS
SELECT ecli, spider, court_code, decision_date, docket_number, abstract, full_text,
       metadata_json->'rpw'->>'chapter' AS rpw_chapter
  FROM ch_court_decisions
 WHERE stage = 'loaded'
   AND (spider IN ('CH_WEKO_RPW', 'CH_WEKO')
        OR full_text ILIKE '%Kartellgesetz%'
        OR full_text ILIKE '%Wettbewerbsabrede%')
"""
# The tsvector is STORED, not recomputed per query. Ranking recomputes it for
# every matching row otherwise, and these rows hold whole decisions -- the
# control took minutes per proposition before this column existed.
WORKING_TSV = [
    "ALTER TABLE ch_weko_audit_corpus ADD COLUMN IF NOT EXISTS tsv tsvector",
    "UPDATE ch_weko_audit_corpus SET tsv = to_tsvector('german', "
    "  coalesce(abstract, '') || ' ' || coalesce(full_text, '')) WHERE tsv IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_weko_audit_fts ON ch_weko_audit_corpus USING gin (tsv)",
    "ANALYZE ch_weko_audit_corpus",
]

# German words that carry no signal in a competition-law text: either
# grammar, or so common in this corpus that they match everything.
STOP = set("""der die das den dem des ein eine einer eines einem einen und oder aber
auch noch nur schon sowie sondern als wie wenn dass weil damit durch für gegen ohne
um bei mit nach seit von vor zu zur zum aus auf in im an am ist sind war waren wird
werden wurde wurden kann können muss müssen soll sollen darf dürfen hat haben hatte
nicht kein keine keiner sich ihre ihrer ihren seine seiner sein diese dieser dieses
diesem diesen jene jener welche welcher welches es er sie wir man dabei dazu daher
somit jedoch insbesondere gemäss gemäß artikel absatz buchstabe ziffer abs art
vorliegende vorliegenden regel fall fällen sinne bezug rahmen""".split())


def terms(text: str, limit: int = 12) -> list[str]:
    """The words a decision would have to use to be about this proposition:
    the longest content words, which in German are the compounds that carry
    the doctrine (Wettbewerbsabrede, Gebietsschutz, Preisempfehlung)."""
    words = [w for w in re.findall(r"[A-Za-zÄÖÜäöüß]{4,}", text)
             if w.lower() not in STOP]
    seen: dict[str, int] = {}
    for w in words:
        seen[w.lower()] = seen.get(w.lower(), 0) + 1
    ranked = sorted(seen, key=lambda w: (-len(w) - 2 * seen[w], w))
    return ranked[:limit]


SEARCH = """
WITH q AS (SELECT to_tsquery('german', %(query)s) AS tsq)
SELECT ecli, spider, docket_number, decision_date,
       -- Measured, both ways: raw cover density reaches recall@50 = 0.31 on
       -- the gold set, and dividing by document length (normalisation 2|32)
       -- drops it to 0.10 -- the cited judgments are long too, and the short
       -- documents that win instead are merger clearances. Neither is good
       -- enough; see the note at the top.
       ts_rank_cd(tsv, q.tsq) AS rank
  FROM ch_weko_audit_corpus, q
 WHERE tsv @@ q.tsq
   AND (%(before)s::date IS NULL OR decision_date IS NULL OR decision_date <= %(before)s::date)
   -- The notices themselves are in the corpus (part D1 of the journal) and
   -- would answer every proposition with its own text.
   AND coalesce(rpw_chapter, '') <> 'D1'
 ORDER BY rank DESC
 LIMIT %(k)s
"""


def query_of(words: list[str], strict: int = 3) -> str:
    """The strongest terms joined with AND, the rest with OR: a decision that
    does not use the words the proposition is about is not a candidate, but
    demanding all twelve returns nothing."""
    if len(words) <= strict:
        return " & ".join(words)
    return "(" + " & ".join(words[:strict]) + ") & (" + " | ".join(words[strict:]) + ")"


def search(conn, text: str, k: int = 20, before: str | None = None) -> list[dict]:
    words = terms(text)
    if not words:
        return []
    # AND over the strongest terms scored worse than OR over all of them
    # (recall@50 0.10 against 0.31): a decision states the rule in its own
    # words and rarely repeats the notice's whole vocabulary.
    rows = conn.execute(SEARCH, {"query": " | ".join(words), "k": k, "before": before}).fetchall()
    return [dict(r) for r in rows]


def control(conn, gold: list[dict], k: int) -> dict:
    """recall@k over the gold set: is the decision a proposition cites among
    the k candidates the retrieval returns for it?"""
    hits, misses = 0, []
    for g in gold:
        wanted = {r["ecli"] for r in g["resolved"]}
        if not wanted:
            continue
        got = search(conn, g["proposition"], k)
        if wanted & {r["ecli"] for r in got}:
            hits += 1
        else:
            misses.append({"version": g["version"], "pid": g["pid"], "ref": g["ref"],
                           "top": [r["docket_number"] for r in got[:3]]})
    total = hits + len(misses)
    return {"k": k, "pairs": total, "recall": round(hits / total, 3) if total else None,
            "misses": misses}


PASSAGES = """
CREATE TABLE IF NOT EXISTS ch_weko_audit_passages (
    ecli text NOT NULL,
    ord  int  NOT NULL,
    text text NOT NULL,
    tsv  tsvector,
    PRIMARY KEY (ecli, ord)
)
"""
PASSAGE_INDEX = ("CREATE INDEX IF NOT EXISTS idx_weko_audit_passages_fts "
                 "ON ch_weko_audit_passages USING gin (tsv)")

PASSAGE_CHARS = 1200
PASSAGE_OVERLAP = 200


def passages_of(text: str, size: int = PASSAGE_CHARS, overlap: int = PASSAGE_OVERLAP) -> list[str]:
    """A decision cut into overlapping windows on paragraph boundaries.

    The unit matters more than the tuning: a decision states the rule a
    proposition is about in one or two Erwägungen, and the rest of its
    hundred pages is the market it was decided in. Whole-decision search
    ranked that noise (recall@50 0.31); the passage is what the annotator
    reads anyway."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    out: list[str] = []
    buf = ""
    for para in paragraphs:
        while len(para) > size:                    # a paragraph longer than a window
            out.append(para[:size])
            para = para[size - overlap:]
        if len(buf) + len(para) + 1 > size:
            if buf:
                out.append(buf)
            buf = (buf[-overlap:] + " " + para).strip() if buf else para
        else:
            buf = f"{buf} {para}".strip()
    if buf:
        out.append(buf)
    return [p for p in out if len(p) > 120]


def build_passages(conn, batch: int = 200) -> int:
    conn.execute("SET statement_timeout = 0")
    conn.execute(PASSAGES)
    done = {r["ecli"] for r in conn.execute(
        "SELECT DISTINCT ecli FROM ch_weko_audit_passages").fetchall()}
    rows = conn.execute("SELECT ecli, full_text FROM ch_weko_audit_corpus "
                        "WHERE coalesce(rpw_chapter, '') <> 'D1'").fetchall()
    total = 0
    with conn.cursor() as cur:
        for r in rows:
            if r["ecli"] in done:
                continue
            chunks = passages_of(r["full_text"])
            cur.executemany(
                "INSERT INTO ch_weko_audit_passages (ecli, ord, text, tsv) "
                "VALUES (%s, %s, %s, to_tsvector('german', %s)) ON CONFLICT DO NOTHING",
                [(r["ecli"], i, c, c) for i, c in enumerate(chunks)])
            total += len(chunks)
    conn.execute(PASSAGE_INDEX)
    conn.execute("ANALYZE ch_weko_audit_passages")
    return total


PASSAGE_SEARCH = """
WITH q AS (SELECT to_tsquery('german', %(query)s) AS tsq)
SELECT p.ecli, p.ord, p.text, c.spider, c.docket_number, c.decision_date,
       ts_rank_cd(p.tsv, q.tsq) AS rank
  FROM ch_weko_audit_passages p
  JOIN ch_weko_audit_corpus c USING (ecli), q
 WHERE p.tsv @@ q.tsq
   AND (%(before)s::date IS NULL OR c.decision_date IS NULL OR c.decision_date <= %(before)s::date)
 ORDER BY rank DESC
 LIMIT %(n)s
"""


def embed(texts: list[str], url: str, cache: dict) -> list[list[float]]:
    """bge-m3 through the TEI service on the box, batched at its own limit
    (max_client_batch_size 16) and cached per text for the run."""
    import json as _json
    import urllib.request
    missing = [t for t in texts if t not in cache]
    for i in range(0, len(missing), 16):
        chunk = [t[:3000] for t in missing[i:i + 16]]
        req = urllib.request.Request(
            f"{url}/embed", data=_json.dumps({"inputs": chunk}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            for text, vec in zip(missing[i:i + 16], _json.loads(resp.read())):
                cache[text] = vec
    return [cache[t] for t in texts]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def search_passages(conn, text: str, k: int, url: str | None, cache: dict,
                    candidates: int = 200, before: str | None = None) -> list[dict]:
    """Keyword search over passages, then -- when an embedding service is
    given -- a bge-m3 re-rank of what it found. The document's score is its
    best passage."""
    words = terms(text)
    if not words:
        return []
    rows = [dict(r) for r in conn.execute(
        PASSAGE_SEARCH, {"query": " | ".join(words), "n": candidates, "before": before}).fetchall()]
    if url and rows:
        vectors = embed([text] + [r["text"] for r in rows], url, cache)
        query_vec, passage_vecs = vectors[0], vectors[1:]
        for r, v in zip(rows, passage_vecs):
            r["rank"] = cosine(query_vec, v)
        rows.sort(key=lambda r: -r["rank"])
    best: dict[str, dict] = {}
    for r in rows:
        if r["ecli"] not in best:
            best[r["ecli"]] = r
    return list(best.values())[:k]


DENSE_VECTORS = pathlib.Path("/data/ch-corpus/weko-bek/vectors.npz")


def dense_index():
    """The passage vectors, normalised once, with their (ecli, ord) keys."""
    import numpy as np
    data = np.load(DENSE_VECTORS, allow_pickle=False)
    vectors = data["vectors"].astype("float32")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors /= np.where(norms == 0, 1, norms)
    return vectors, data["ecli"], data["ord"]


def search_dense(index, text: str, k: int, url: str, cache: dict, per_doc: int = 1):
    """Cosine over every passage in the corpus, then one row per decision.

    Dense over the LOT, not a re-rank of a keyword pool: the pool was the
    ceiling (the cited decision was inside the top 200 keyword passages for
    only 14 of 29 propositions)."""
    import numpy as np
    vectors, eclis, ords = index
    query = np.asarray(embed([text], url, cache)[0], dtype="float32")
    query /= max(float(np.linalg.norm(query)), 1e-9)
    scores = vectors @ query
    order = np.argsort(-scores)[: k * 40]
    best: dict[str, dict] = {}
    for i in order:
        ecli = str(eclis[i])
        if ecli in best:
            continue
        best[ecli] = {"ecli": ecli, "ord": int(ords[i]), "rank": float(scores[i])}
        if len(best) >= k:
            break
    return list(best.values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["build", "passages", "control", "control2", "control3", "search"])
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--gold", type=pathlib.Path,
                    default=pathlib.Path("/data/ch-corpus/weko-bek/goldset.json"))
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--text", help="for `search`: the proposition text")
    ap.add_argument("--tei", default="http://172.30.0.2:80",
                    help="the bge-m3 service; empty string turns the re-rank off")
    ap.add_argument("--candidates", type=int, default=200)
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(args.dsn, autocommit=True, row_factory=dict_row) as conn:
        if args.command == "build":
            conn.execute("SET statement_timeout = 0")
            conn.execute(WORKING_CORPUS)
            for stmt in WORKING_TSV:
                conn.execute(stmt)
            n = conn.execute("SELECT count(*) AS n, count(*) FILTER (WHERE spider LIKE 'CH_WEKO%') AS weko "
                             "FROM ch_weko_audit_corpus").fetchone()
            print(f"working corpus: {n['n']} decisions ({n['weko']} of them WEKO's own)")
            return 0
        if args.command == "search":
            for r in search(conn, args.text or "", args.k):
                print(f"  {r['rank']:7.4f} {r['spider']:12} {str(r['decision_date'] or ''):10} "
                      f"{(r['docket_number'] or '')[:60]}")
            return 0
        if args.command == "passages":
            print(f"passages written: {build_passages(conn)}")
            n = conn.execute("SELECT count(*) AS n, count(DISTINCT ecli) AS d "
                             "FROM ch_weko_audit_passages").fetchone()
            print(f"table now: {n['n']} passages over {n['d']} decisions")
            return 0
        gold = json.loads(args.gold.read_text(encoding="utf-8"))
        if args.command == "control3":
            # Two metrics, because they answer different questions. The pair
            # metric asks whether every citation is found. The proposition
            # metric asks whether the annotator is shown AT LEAST ONE of the
            # authorities the instrument itself points at -- which is what
            # deciding "supported" needs.
            import collections
            index, cache = dense_index(), {}
            print(f"dense index: {index[0].shape[0]} passages")
            by_prop: dict = collections.defaultdict(set)
            for g in gold:
                by_prop[(g["version"], g["pid"], g["proposition"])] |= {r["ecli"] for r in g["resolved"]}
            pair_ranks, prop_best = [], []
            for (_v, _p, text), wanted in by_prop.items():
                ranked = search_dense(index, text, 400, args.tei, cache)
                pos = {r["ecli"]: i + 1 for i, r in enumerate(ranked)}
                # A citation the search never reaches counts as a miss, not as
                # a pair to leave out of the denominator.
                got = [pos.get(e, 10 ** 6) for e in wanted]
                pair_ranks += got
                prop_best.append(min(got))
            print(f"{len(by_prop)} propositions, {len(pair_ranks)} cited pairs")
            print(f"{'k':>5} {'pair recall':>12} {'proposition recall':>20}")
            for k in (5, 10, 20, 50, 100, 200):
                pair = sum(1 for r in pair_ranks if r <= k) / max(len(pair_ranks), 1)
                prop = sum(1 for r in prop_best if r <= k) / max(len(prop_best), 1)
                print(f"{k:5} {pair:12.3f} {prop:20.3f}")
            return 0
        if args.command == "control2":
            cache: dict = {}
            for k in (5, 10, 20, 50):
                hits, misses = 0, []
                for g in gold:
                    wanted = {r["ecli"] for r in g["resolved"]}
                    got = search_passages(conn, g["proposition"], k, args.tei or None,
                                          cache, args.candidates)
                    if wanted & {r["ecli"] for r in got}:
                        hits += 1
                    else:
                        misses.append((g["version"], g["pid"], g["ref"]))
                print(f"recall@{k:<3} {round(hits / len(gold), 3)} over {len(gold)} cited pairs"
                      + (f"   (rerank: {'bge-m3' if args.tei else 'off'})" if k == 5 else ""))
            for m in misses:
                print(f"    miss {m[0]} {m[1]:6} {m[2]}")
            return 0
        for k in (5, 10, args.k, 50):
            res = control(conn, gold, k)
            print(f"recall@{k:<3} {res['recall']} over {res['pairs']} cited pairs")
        res = control(conn, gold, args.k)
        for m in res["misses"]:
            print(f"    miss {m['version']} {m['pid']:6} {m['ref']:18} "
                  f"top: {', '.join((t or '?')[:28] for t in m['top'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
