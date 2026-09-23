"""Retrieval over the record, so that silence can be told from absence.

A proposition that no decision cites by number is not thereby a dead letter:
the rule may be applied in substance, in the decision's own words, without a
pinpoint. The audit can only say "unsupported" about a proposition after
looking for support and failing to find it, which needs retrieval over the
whole record rather than a citation index.

The corpus is the record that had the Методика in play:

  * every published AMCU decision that carries text (6,820 of them, 2017
    onwards, which is when the open data portal starts);
  * every court decision that cites the Методика (2,160, reaching back to
    adoption).

Restricting the court side to decisions that mention the instrument is a
deliberate narrowing and it cuts both ways: it cannot find a proposition
applied in a case that never names the Методика at all, but it also stops the
measurement from drowning in competition cases decided on the statute alone.

Postgres has no Ukrainian stemmer, so the text is indexed with the 'simple'
configuration and queried with prefix terms (взаємозамінн:*). Ukrainian is
heavily inflected and exact-form matching loses most of the record: the prefix
is the poor man's stemmer, and it is what the register's own indexes use.

Usage:
    python3 retrieve.py build             # corpus table
    python3 retrieve.py passages          # cut and index
    python3 retrieve.py control --k 50    # recall@k of the citation pairs
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

import psycopg2
import psycopg2.extras

def dsn() -> str:
    """The database is in a container and only trusts its own loopback, so the
    password comes from the container rather than from a file on the box."""
    if os.environ.get("METODYKA_DSN"):
        return os.environ["METODYKA_DSN"]
    out = subprocess.run(
        ["docker", "inspect", "secondlayer-postgres-local",
         "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=True).stdout
    password = next((ln.split("=", 1)[1] for ln in out.splitlines()
                     if ln.startswith("POSTGRES_PASSWORD=")), None)
    if not password:
        raise SystemExit("POSTGRES_PASSWORD not found; set METODYKA_DSN")
    return f"postgresql://secondlayer:{password}@127.0.0.1:5432/secondlayer_local"

CORPUS = """
CREATE TABLE IF NOT EXISTS ua_metodyka_audit_corpus (
    doc_id        text PRIMARY KEY,
    corpus        text NOT NULL,
    doc_ref       text,
    decision_date date,
    body          text NOT NULL,
    tsv           tsvector
)
"""
CORPUS_INDEX = ("CREATE INDEX IF NOT EXISTS idx_ua_metodyka_corpus_fts "
                "ON ua_metodyka_audit_corpus USING gin (tsv)")

PASSAGES = """
CREATE TABLE IF NOT EXISTS ua_metodyka_audit_passages (
    doc_id text NOT NULL,
    ord    integer NOT NULL,
    corpus text NOT NULL,
    body   text NOT NULL,
    tsv    tsvector,
    PRIMARY KEY (doc_id, ord)
)
"""
PASSAGE_INDEX = ("CREATE INDEX IF NOT EXISTS idx_ua_metodyka_passages_fts "
                 "ON ua_metodyka_audit_passages USING gin (tsv)")

PASSAGE_CHARS = 1200
PASSAGE_OVERLAP = 200

# Ukrainian has no stemmer here and no stop list either. These are the words
# every legal text uses and none is about: keeping them makes the query match
# the register rather than the proposition.
STOP = set("""
   та і й або чи що який яка яке які якого якому яким якої їх його її цей ця це ці
   того тому тим цього цьому цим така такий таке такі про для від при над під між
   без через після перед разі випадку випадках зокрема також крім тобто якщо коли
   щодо відповідно згідно шляхом чином вимог вимоги пункт пункту пункті пунктом
   розділ розділу статті стаття частини частина закону закон україни комітету
   комітет методики методика методикою може можуть бути буде були є не на по до
   за із зі з у в о та якими яких інших інші інша інше може повинен повинні
   здійснюється визначається розглядається вважається встановлюється проводиться
   таким чином цієї цьому даного даної своєї своїх свої році роки рік
""".split())


def terms(text: str, limit: int = 14) -> list[str]:
    """The words a decision would have to use to be about this proposition.

    Ukrainian carries meaning in long nominals (взаємозамінність, концентрація,
    бар'єри), so the longest content words rank first, weighted by how often
    the proposition repeats them. Each is truncated to a prefix so that the
    'simple' index matches the word's other forms."""
    words = [w for w in re.findall(r"[А-Яа-яІіЇїЄєҐґA-Za-z']{5,}", text)
             if w.lower() not in STOP]
    counts: dict[str, int] = {}
    for w in words:
        counts[w.lower()] = counts.get(w.lower(), 0) + 1
    ranked = sorted(counts, key=lambda w: (-len(w) - 2 * counts[w], w))
    out, seen = [], set()
    for word in ranked:
        stem = stem_of(word)
        if stem in seen:
            continue
        seen.add(stem)
        out.append(stem)
        if len(out) == limit:
            break
    return out


def stem_of(word: str) -> str:
    """Cut the inflection off crudely: keep at least five characters and drop
    up to three trailing ones. A prefix term matches every form the register
    spells, which is the point."""
    core = word.rstrip("'")
    return core[:max(5, len(core) - 3)]


SEARCH = """
WITH q AS (SELECT to_tsquery('simple', %(query)s) AS tsq)
SELECT doc_id, corpus, doc_ref, decision_date,
       ts_rank_cd(tsv, q.tsq) AS rank
  FROM ua_metodyka_audit_corpus, q
 WHERE tsv @@ q.tsq
 ORDER BY rank DESC
 LIMIT %(k)s
"""

# Ranking every matching passage is the cost here, and a window function to
# keep one passage per document made it run over all of them twice. The
# deduplication is done in Python instead, on a candidate list a few times
# longer than what is asked for.
PASSAGE_SEARCH = """
WITH q AS (SELECT to_tsquery('simple', %(query)s) AS tsq)
SELECT doc_id, corpus, ord, body, ts_rank_cd(tsv, q.tsq) AS rank
  FROM ua_metodyka_audit_passages, q
 WHERE tsv @@ q.tsq
 ORDER BY rank DESC
 LIMIT %(k)s
"""


def query_of(words: list[str]) -> str:
    return " | ".join(f"{w}:*" for w in words)


def search(conn, text: str, k: int = 50) -> list[dict]:
    words = terms(text)
    if not words:
        return []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(SEARCH, {"query": query_of(words), "k": k})
        return [dict(r) for r in cur.fetchall()]


def search_passages(conn, text: str, k: int = 50, per_doc: int = 1) -> list[dict]:
    words = terms(text)
    if not words:
        return []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(PASSAGE_SEARCH, {"query": query_of(words), "k": k * 5})
        rows = [dict(r) for r in cur.fetchall()]
    kept: dict[str, int] = {}
    out = []
    for row in rows:
        seen = kept.get(row["doc_id"], 0)
        if seen >= per_doc:
            continue
        kept[row["doc_id"]] = seen + 1
        out.append(row)
        if len(out) >= k:
            break
    return out


TEI = os.environ.get("METODYKA_TEI", "http://172.30.0.2:80")
DENSE_VECTORS = pathlib.Path("/data/amcu/vectors.npz")


def embed(texts: list[str], url: str = TEI, cache: dict | None = None) -> list[list[float]]:
    """bge-m3 through the TEI service on the box, batched at its own limit
    (max_client_batch_size is 16) and cached per text for the run."""
    import urllib.request
    cache = {} if cache is None else cache
    missing = [t for t in texts if t not in cache]
    for i in range(0, len(missing), 16):
        chunk = [t[:3000] for t in missing[i:i + 16]]
        req = urllib.request.Request(
            f"{url}/embed", data=json.dumps({"inputs": chunk, "truncate": True}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            for text, vec in zip(missing[i:i + 16], json.loads(resp.read())):
                cache[text] = vec
    return [cache[t] for t in texts]


def dense_index():
    """The passage vectors, normalised once, with their (doc_id, ord) keys."""
    import numpy as np
    data = np.load(DENSE_VECTORS, allow_pickle=False)
    vectors = data["vectors"].astype("float32")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors /= np.where(norms == 0, 1, norms)
    return vectors, data["doc_id"], data["ord"]


def search_dense(index, text: str, k: int, cache: dict) -> list[dict]:
    """Cosine over every passage in the corpus, then one row per decision.

    Dense over the whole corpus rather than a re-rank of a keyword pool: in
    the Swiss run the pool was the ceiling, not the ranking."""
    import numpy as np
    vectors, doc_ids, ords = index
    query = np.asarray(embed([text], cache=cache)[0], dtype="float32")
    query /= max(float(np.linalg.norm(query)), 1e-9)
    scores = vectors @ query
    order = np.argsort(-scores)[: k * 40]
    best: dict[str, dict] = {}
    for i in order:
        doc_id = str(doc_ids[i])
        if doc_id in best:
            continue
        best[doc_id] = {"doc_id": doc_id, "ord": int(ords[i]), "rank": float(scores[i])}
        if len(best) >= k:
            break
    return list(best.values())


def build(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(CORPUS)
        cur.execute("TRUNCATE ua_metodyka_audit_corpus")
        cur.execute("""
            INSERT INTO ua_metodyka_audit_corpus (doc_id, corpus, doc_ref, decision_date, body, tsv)
            SELECT 'amcu:' || id, 'amcu', decision_no, decision_date, body_text,
                   to_tsvector('simple', body_text)
              FROM opendata_amcu_decisions
             WHERE length(body_text) > 500
        """)
        amcu = cur.rowcount
        ids = [int(x) for x in open("/data/amcu/court_ids.txt")]
        cur.execute("""
            INSERT INTO ua_metodyka_audit_corpus (doc_id, corpus, doc_ref, decision_date, body, tsv)
            SELECT 'court:' || f.doc_id, 'court',
                   coalesce(d.cause_num, f.doc_id::text),
                   d.adjudication_date, f.full_text,
                   to_tsvector('simple', f.full_text)
              FROM edrsr_fulltext f
              LEFT JOIN edrsr_documents d ON d.doc_id = f.doc_id
             WHERE f.doc_id = ANY(%s)
        """, (ids,))
        court = cur.rowcount
        cur.execute(CORPUS_INDEX)
    conn.commit()
    print(f"corpus: {amcu} agency decisions, {court} court decisions")


def passages_of(text: str, size: int = PASSAGE_CHARS,
                overlap: int = PASSAGE_OVERLAP) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text)
    out, start = [], 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            window = text.rfind(" ", start + size - overlap, end)
            if window > start:
                end = window
        chunk = text[start:end].strip()
        if len(chunk) > 80:
            out.append(chunk)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return out


def build_passages(conn, batch: int = 200) -> None:
    with conn.cursor() as cur:
        cur.execute(PASSAGES)
        cur.execute("TRUNCATE ua_metodyka_audit_passages")
    conn.commit()
    # A server-side cursor for the read: the corpus is 121 MB of text, and the
    # writes below need a cursor of their own anyway.
    read = conn.cursor(name="corpus_scan")
    read.itersize = batch
    read.execute("SELECT doc_id, corpus, body FROM ua_metodyka_audit_corpus")
    with conn.cursor() as cur:
        rows, total = read.fetchmany(batch), 0
        while rows:
            payload = [(doc_id, n, corpus, chunk, chunk)
                       for doc_id, corpus, body in rows
                       for n, chunk in enumerate(passages_of(body))]
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO ua_metodyka_audit_passages (doc_id, ord, corpus, body, tsv) "
                "VALUES %s ON CONFLICT DO NOTHING",
                payload,
                template="(%s, %s, %s, %s, to_tsvector('simple', %s))",
                page_size=500,
            )
            total += len(payload)
            print(f"  {total} passages", file=sys.stderr)
            rows = read.fetchmany(batch)
    read.close()
    conn.commit()
    with conn.cursor() as cur:
        cur.execute(PASSAGE_INDEX)
    conn.commit()
    print(f"{total} passages")


def gold_pairs(path: str) -> list[dict]:
    """One pair per (proposition, document that cites it by number)."""
    import metodyka
    props = {p.number: p for p in metodyka.load("db")}
    pairs = []
    for line in open(path, encoding="utf-8"):
        row = json.loads(line)
        doc_id = f"{row['corpus']}:{row['doc_id']}"
        for cite in row["cites"]:
            if cite["kind"] == "punkt" and cite["number"] in props:
                pairs.append({"number": cite["number"], "doc_id": doc_id,
                              "corpus": row["corpus"],
                              "text": props[cite["number"]].text})
    return pairs


def control(conn, pairs: list[dict], k: int, mode: str) -> dict:
    """Two numbers, and the difference between them matters.

    Pair recall asks, of every (proposition, citing decision) pair, whether
    that decision comes back. Proposition recall asks whether any of the
    decisions citing a proposition comes back. The audit needs the second:
    one decision on point is enough to say the proposition has support.
    """
    by_prop: dict[str, set] = {}
    for p in pairs:
        by_prop.setdefault(p["number"], set()).add(p["doc_id"])
    cache: dict[str, set] = {}
    index = dense_index() if mode == "dense" else None
    embed_cache: dict = {}
    text_of = {p["number"]: p["text"] for p in pairs}
    hit_pairs = 0
    hit_props = 0
    misses = []
    for number, wanted in by_prop.items():
        if number not in cache:
            if mode == "dense":
                got = search_dense(index, text_of[number], k, embed_cache)
            elif mode == "passages":
                got = search_passages(conn, text_of[number], k)
            else:
                got = search(conn, text_of[number], k)
            cache[number] = {r["doc_id"] for r in got}
        found = wanted & cache[number]
        hit_pairs += len(found)
        if found:
            hit_props += 1
        else:
            misses.append(number)
    total_pairs = sum(len(v) for v in by_prop.values())
    return {"k": k, "mode": mode,
            "propositions": len(by_prop),
            "proposition_recall": round(hit_props / len(by_prop), 3),
            "pairs": total_pairs,
            "pair_recall": round(hit_pairs / total_pairs, 3),
            "missed": sorted(misses)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["build", "passages", "control", "show"])
    ap.add_argument("--k", type=int, default=50)
    ap.add_argument("--goldset", default="/data/amcu/goldset.jsonl")
    ap.add_argument("--number")
    ap.add_argument("--passages", action="store_true")
    ap.add_argument("--dense", action="store_true")
    args = ap.parse_args()
    conn = psycopg2.connect(dsn())
    if args.command == "build":
        build(conn)
    elif args.command == "passages":
        build_passages(conn)
    elif args.command == "show":
        import metodyka
        prop = next(p for p in metodyka.load("db") if p.number == args.number)
        print(f"{prop.number}: {prop.text[:200]}\n")
        print("terms:", " ".join(terms(prop.text)))
        for r in search_passages(conn, prop.text, args.k)[:8]:
            print(f"  {r['doc_id']:<14} {r['rank']:.4f}  {r['body'][:150]}")
    else:
        pairs = gold_pairs(args.goldset)
        mode = "dense" if args.dense else "passages" if args.passages else "documents"
        print(json.dumps(control(conn, pairs, args.k, mode),
                         ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
