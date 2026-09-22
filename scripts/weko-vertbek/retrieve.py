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

STATE, measured 2026-09-23 on the 29 cited pairs: recall@5 0.14, @10 0.14,
@20 0.21, @50 0.31. **The gate is not passed**, and nothing may be labelled on
this retrieval. Two variants were tried and are recorded in the code: length
normalisation and an AND over the strongest terms each made it worse (0.10 at
50). What this says is that whole-decision keyword search is the wrong unit:
a decision states a rule in one Erwägung, inside a hundred pages about a
market. The next step is the one the design calls for -- passages rather than
documents, and a bge-m3 re-rank over them (tei-bge-m3-lawrider is running on
the box) -- not more tuning of this query.
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["build", "control", "search"])
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--gold", type=pathlib.Path,
                    default=pathlib.Path("/data/ch-corpus/weko-bek/goldset.json"))
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--text", help="for `search`: the proposition text")
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
        gold = json.loads(args.gold.read_text(encoding="utf-8"))
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
