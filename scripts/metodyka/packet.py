"""The review packet: every proposition with the passages the record offers it.

This is what both the human reader and the judge see, and they must see the
same thing. For each of the instrument's 66 propositions it collects the top
passages by dense similarity, marks which of their decisions cite the
proposition by number, and writes one JSON file.

The citation marks are kept out of the reader's way on purpose: whether a
decision names пункт 6.1 says nothing about whether the passage in front of
you applies it, and a reader told the answer stops reading. They are in the
file so that agreement can be measured afterwards.

Usage:
    python3 packet.py --k 8 --out packet.json
"""
from __future__ import annotations

import argparse
import difflib
import json
import re

import psycopg2
import psycopg2.extras

import metodyka
import retrieve


DEEP = 60
RECITAL = 0.40
FRESH = 0.25


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("\u2019", "'")).strip()


def recital_share(proposition: str, passage: str) -> float:
    """How much of the proposition the passage reproduces word for word.

    A decision that recites пункт 6.1 is not evidence that пункт 6.1 was
    applied: it is the rule restated. Measured over a first packet built
    without this test, 36.5% of its passages carried 60% or more of their
    proposition verbatim, and for 27 of the 66 propositions at least six of
    the eight passages were recitation. A reader given those would be
    labelling quotations.
    """
    a, b = _norm(proposition), _norm(passage)
    match = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return match.find_longest_match(0, len(a), 0, len(b)).size / max(len(a), 1)


def candidates(conn, index, text: str, cache: dict, keep: set) -> list[dict]:
    """Dense and keyword together, deep enough to choose from.

    The two miss different propositions: proposition recall at k=200 is 0.887
    for the union against 0.839 for dense alone."""
    dense = retrieve.search_dense(index, text, DEEP, cache, keep)
    merged = [dict(h, source="dense") for h in dense]
    seen = {h["doc_id"] for h in dense}
    for row in retrieve.search_passages(conn, text, DEEP * 3):
        if row["doc_id"] in seen or row["doc_id"] not in keep:
            continue
        seen.add(row["doc_id"])
        merged.append({"doc_id": row["doc_id"], "ord": row["ord"],
                       "rank": float(row["rank"]), "source": "keyword"})
        if len(merged) >= DEEP * 2:
            break
    return merged


AGENCY_SLOTS = 3
TWIN = 0.80


def _words(text: str) -> list[str]:
    return re.findall(r"[А-Яа-яІіЇїЄєҐґA-Za-z']+", text.lower())


def twins(a: list[str], b: list[str]) -> bool:
    """Near-identical prose, on words rather than characters.

    difflib's quick_ratio is an upper bound from a character multiset, and on
    Ukrainian legal prose it calls almost any two passages alike -- a first
    version of this test used it and duly reported duplicates in all 66
    propositions. Word-level ratio with autojunk off is the measure."""
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() > TWIN


def pool(conn, index, text: str, k: int, cache: dict, keep: set) -> list[dict]:
    """The k passages the reader and the judge see.

    Three things decide the choice, each of them measured on a packet built
    without it:

    * Recitation last. A decision reproducing пункт 6.1 is not evidence that
      6.1 was applied, and 36.5% of a first packet was recitation.
    * No twins. Agency and court decisions are formulaic, and 55 of the 66
      propositions had near-identical passages among their eight -- one
      judgement made eight times, and support that is one paragraph repeated.
    * The agency gets slots. Retrieval left the packet 89% court, because
      courts restate the instrument's language while the agency applies the
      method without naming it. The paper's claim is about the agency, so the
      reading has to see agency decisions where the record holds any: only
      2.1.2 and 2.1.10 have none anywhere in the pool.
    """
    rows = candidates(conn, index, text, cache, keep)
    bodies = passage_bodies_only(conn, rows)
    for row in rows:
        body = bodies.get((row["doc_id"], row["ord"]), "")
        row["recital_share"] = round(recital_share(text, body), 3)
        row["recital"] = row["recital_share"] >= RECITAL
        row["_words"] = _words(body)
    ordered = ([r for r in rows if r["recital_share"] < FRESH]
               + [r for r in rows if FRESH <= r["recital_share"] < RECITAL]
               + [r for r in rows if r["recital_share"] >= RECITAL])

    chosen: list[dict] = []

    def take(pool_rows, limit):
        for row in pool_rows:
            if len(chosen) >= limit:
                return
            if any(twins(row["_words"], c["_words"]) for c in chosen):
                continue
            chosen.append(row)

    take([r for r in ordered if r["doc_id"].startswith("amcu:")], min(AGENCY_SLOTS, k))
    take(ordered, k)
    for row in chosen:
        row.pop("_words", None)
    chosen.sort(key=lambda r: -r["rank"])
    return chosen


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--goldset", default="/data/amcu/goldset.jsonl")
    ap.add_argument("--out", default="packet.json")
    args = ap.parse_args()

    props = metodyka.load("db")
    cited: dict[str, set[str]] = {p.number: set() for p in props}
    for line in open(args.goldset, encoding="utf-8"):
        row = json.loads(line)
        doc_id = f"{row['corpus']}:{row['doc_id']}"
        for cite in row["cites"]:
            if cite["kind"] == "punkt" and cite["number"] in cited:
                cited[cite["number"]].add(doc_id)

    conn = psycopg2.connect(retrieve.dsn())
    index = retrieve.dense_index()
    keep = retrieve.canonical_ids(conn)
    cache: dict = {}
    out = []
    for prop in props:
        hits = pool(conn, index, prop.text, args.k, cache, keep)
        ids = [h["doc_id"] for h in hits]
        bodies, meta = passage_bodies(conn, hits)
        out.append({
            "number": prop.number,
            "rozdil": prop.rozdil,
            "rozdil_title": prop.rozdil_title,
            "text": prop.text,
            "cited_by": len(cited[prop.number]),
            "recital_only": all(h["recital"] for h in hits) if hits else None,
            "passages": [
                {"doc_id": h["doc_id"], "ord": h["ord"],
                 "score": round(h["rank"], 4), "found_by": h.get("source", "dense"),
                 "recital": h["recital"], "recital_share": h["recital_share"],
                 "corpus": meta.get(h["doc_id"], {}).get("corpus"),
                 "doc_ref": meta.get(h["doc_id"], {}).get("doc_ref"),
                 "date": str(meta.get(h["doc_id"], {}).get("decision_date") or ""),
                 "cites_this": h["doc_id"] in cited[prop.number],
                 "body": bodies.get((h["doc_id"], h["ord"]), "")}
                for h in hits],
        })
        print(f"  {prop.number:<9} {len(hits)} passages, "
              f"{sum(1 for h in hits if not h['recital'])} apply rather than recite, "
              f"{sum(1 for h in hits if h['doc_id'] in cited[prop.number])} cite it")
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    total = sum(len(p["passages"]) for p in out)
    print(f"{len(out)} propositions, {total} passages -> {args.out}")


def passage_bodies_only(conn, hits: list[dict]) -> dict:
    if not hits:
        return {}
    keys = [(h["doc_id"], h["ord"]) for h in hits]
    with conn.cursor() as cur:
        cur.execute("SELECT doc_id, ord, body FROM ua_metodyka_audit_passages "
                    "WHERE (doc_id, ord) IN %s", (tuple(keys),))
        return {(r[0], r[1]): r[2] for r in cur.fetchall()}


def passage_bodies(conn, hits: list[dict]) -> tuple[dict, dict]:
    if not hits:
        return {}, {}
    keys = [(h["doc_id"], h["ord"]) for h in hits]
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT doc_id, ord, body FROM ua_metodyka_audit_passages "
            "WHERE (doc_id, ord) IN %s", (tuple(keys),))
        bodies = {(r["doc_id"], r["ord"]): r["body"] for r in cur.fetchall()}
        cur.execute(
            "SELECT doc_id, corpus, doc_ref, decision_date "
            "FROM ua_metodyka_audit_corpus WHERE doc_id = ANY(%s)",
            ([h["doc_id"] for h in hits],))
        meta = {r["doc_id"]: dict(r) for r in cur.fetchall()}
    return bodies, meta


if __name__ == "__main__":
    main()
