#!/usr/bin/env python3
"""Stage 8: pick what is worth embedding out of the UK statute book, and write it out.

Nothing here talks to a model. It decides WHAT gets a vector, which is the part
that is expensive to get wrong: the embedding run itself is an afternoon on a
GPU, while a corpus full of repeated boilerplate is an index that answers every
short query with the same useless hit for as long as it lives.

What the corpus looks like, measured 19 Sep 2026 before writing this:

    rows in uk_legislation_provisions          1,775,894
    repealed markers ". . . . ."                 260,892   14.7%
    shorter than 30 characters                    ~20,000
    exact duplicates of another row              193,881   13.0% of the rest
    DISTINCT TEXTS WORTH EMBEDDING             1,300,637   -27%

    1,320 MB of text, about 330M tokens
    16,732 texts over 6,000 chars; the largest is 284,369

⚠ A single 63-character string accounts for 260,194 of those rows: it is
legislation.gov.uk's marker for repealed text, rendered as ". . . . . . .". Per
row it would take 15% of the budget and 15% of the index. Keyed by content it is
one vector, and `--min-chars` plus the marker filter drop it outright.

What was checked and found FINE, so that nobody re-litigates it: provisions do
not nest (84 containment pairs in 9,475 sampled, 0.9%), markup barely leaked (22
rows with tags, 129 with entities, 20 with runaway whitespace out of 1.78M), and
the 1,345 Welsh-looking rows are genuine bilingual SIs. The text is clean. The
waste is repetition, and content-addressing is what removes it.

⚠ KNOWN, NOT YET HANDLED — orphaned hashes after a refresh. When a weekly
refresh rewords a provision, --populate-map re-hashes it, and if no other
provision shared the old wording that hash is now referenced by nothing. There
is no text row to strand — this path stores no copy, the wording lives in
uk_legislation_provisions and is updated in place — but once embedding runs the
vector under the old hash survives with no provision behind it: a search would
hit it, resolve back through uk_provision_text_hash, and find nothing to show.
Today this costs nothing because nothing is embedded yet. Before the first
refresh AFTER the embedding run, either delete vectors whose hash no map row
references, or teach the retrieval path to drop a hit that resolves to zero
provisions. The first is cheaper and is a single anti-join; it is left undone
deliberately rather than done blind, because how it interacts with qdrant
deletion depends on a serving design that does not exist yet. Tracked with the
embedding work.

⚠ The EU commencement boilerplate ("This Regulation shall enter into force…",
34,259 rows) is deliberately NOT filtered. Deduplicated it is one vector per
phrase, and a caller may legitimately search for that wording.

Usage:
  DATABASE_URL=... python3 08_export_provision_texts.py --populate-map
  DATABASE_URL=... python3 08_export_provision_texts.py --out /data/uk/embed.jsonl
  DATABASE_URL=... python3 08_export_provision_texts.py --out - --limit 20 --dry-run
"""

import argparse
import json
import os
import re
import sys

from datetime import datetime, timezone

import psycopg2
import psycopg2.extras

DB_URL = os.environ.get("DATABASE_URL")

# Everything that is only dots and whitespace. Anchored on the whole string so a
# provision that merely *contains* an ellipsis is untouched.
MARKER_RE = re.compile(r"^[.\s]*$")

POPULATE = """
INSERT INTO uk_provision_text_hash (leg_id, valid_from, ord, text_hash)
SELECT leg_id, valid_from, ord, sha256(convert_to(text, 'UTF8'))
  FROM uk_legislation_provisions
 ON CONFLICT (leg_id, valid_from, ord) DO UPDATE
    SET text_hash = EXCLUDED.text_hash
  WHERE uk_provision_text_hash.text_hash IS DISTINCT FROM EXCLUDED.text_hash
"""
PRUNE = """
DELETE FROM uk_provision_text_hash h
 WHERE NOT EXISTS (SELECT 1 FROM uk_legislation_provisions p
                    WHERE p.leg_id = h.leg_id
                      AND p.valid_from = h.valid_from
                      AND p.ord = h.ord)
"""
# The upsert above never removes anything, and stage 5 runs with --replace: an
# act whose revision shed a provision, or renumbered one, leaves a map row
# naming a provision that no longer exists.
#
# It does not reach the export — SELECT_TEXTS joins the map to the provisions,
# so a row with nothing behind it produces no vector. What it does is make the
# map stop being a description of the provisions: the counts diverge, so
# comparing them tells you nothing, and the next person reading a row has to
# find out the hard way that it names text nobody holds.

# DO UPDATE, not DO NOTHING. The map is content-addressed, so a row whose text
# changed in a weekly refresh and whose hash did not is a row that now points at
# the wrong content — and the export would write the new text under the old
# hash, which is the one failure this design is supposed to make impossible.
# The WHERE keeps it cheap: unchanged provisions, which is nearly all of them,
# are not rewritten.

# DISTINCT ON collapses every provision that shares a wording to one row, which
# is the whole point — 1,775,894 rows become 1,300,637 texts. The join is what
# keeps the text out of the map table: 1,320 MB does not need a second copy.
SELECT_TEXTS = """
SELECT DISTINCT ON (h.text_hash)
       h.text_hash, p.n_chars, p.text
  FROM uk_provision_text_hash h
  JOIN uk_legislation_provisions p
    ON p.leg_id = h.leg_id AND p.valid_from = h.valid_from AND p.ord = h.ord
 WHERE p.n_chars >= %s
 ORDER BY h.text_hash
"""

RECORD = """
INSERT INTO uk_embedding_state (text_hash, chunk_ord, n_chars, model, exported_at)
VALUES %s
ON CONFLICT (text_hash, chunk_ord, model) DO UPDATE SET exported_at = EXCLUDED.exported_at
"""


def chunk(text, limit, overlap):
    """Split on paragraph boundaries, falling back to a hard cut.

    bge-m3 takes 8192 tokens, so most of the corpus needs nothing: the median
    provision is 334 characters. This is for the 16,732 that do — and for the
    one 284,369-character monster (eudn/2019/2198), where a hard cut mid-sentence
    would be the difference between a usable chunk and a broken one.
    """
    if len(text) <= limit:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = min(start + limit, len(text))
        if end < len(text):
            # prefer a paragraph break, then a sentence end, then wherever
            for sep in ("\n\n", "\n", ". "):
                cut = text.rfind(sep, start + limit // 2, end)
                if cut > start:
                    end = cut + len(sep)
                    break
        out.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return [c for c in out if c]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--populate-map", action="store_true",
                    help="fill uk_provision_text_hash from uk_legislation_provisions "
                         "and exit. Idempotent, and re-hashes any provision whose "
                         "text changed in a refresh; it does NOT add a "
                         "column to the provisions table, whose 705 MB GIN index a "
                         "full-table rewrite would thrash.")
    ap.add_argument("--out", default="/data/uk/uk_provision_texts.jsonl",
                    help="JSONL destination, or - for stdout")
    ap.add_argument("--min-chars", type=int, default=30,
                    help="skip anything shorter. The sub-30 rows are real schedule "
                         "entries — 'Golf', 'Barbers.', 'Murder.' — but as standalone "
                         "vectors they match everything and mean nothing.")
    ap.add_argument("--chunk-chars", type=int, default=6000)
    ap.add_argument("--chunk-overlap", type=int, default=200)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--model", default="bge-m3")
    ap.add_argument("--dry-run", action="store_true",
                    help="write the file but record nothing in uk_embedding_state")
    args = ap.parse_args()

    if not DB_URL:
        sys.exit("DATABASE_URL is required")

    # A zero chunk size emits nothing and a negative overlap silently drops
    # characters from the middle of every long provision — both produce a file
    # that looks like a successful export and is not one. Overlap must also stay
    # under the chunk, or the window never advances.
    if args.chunk_chars <= 0:
        sys.exit("--chunk-chars must be positive")
    if not 0 <= args.chunk_overlap < args.chunk_chars:
        sys.exit("--chunk-overlap must be between 0 and --chunk-chars")
    if args.min_chars < 0:
        sys.exit("--min-chars cannot be negative")

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False

    if args.populate_map:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM uk_provision_text_hash")
            before = cur.fetchone()[0]
            cur.execute(PRUNE)
            pruned = cur.rowcount
            cur.execute(POPULATE)
            # rowcount is inserts plus updates; the difference in the row count
            # is inserts alone. Reporting only the latter as "new" would show a
            # refresh that rewrote ten thousand provisions as "0 new", which is
            # true and completely misleading.
            touched = cur.rowcount
            conn.commit()
            cur.execute("SELECT count(*), count(DISTINCT text_hash) "
                        "FROM uk_provision_text_hash")
            rows, distinct = cur.fetchone()
        inserted = rows - before
        print(f"map rows {before} -> {rows} ({inserted + pruned} inserted, "
              f"{max(touched - inserted - pruned, 0)} re-hashed, {pruned} pruned), "
              f"distinct texts {distinct}")
        return

    out = sys.stdout if args.out == "-" else open(args.out, "w")
    # ⚠ TWO connections, deliberately. The reader holds a server-side named cursor
    # and the writer commits every 2,000 rows — on one connection that COMMIT
    # invalidates the cursor and the export dies partway. It would not show up in a
    # --limit smoke test either, because the only flush there happens after reading
    # is already finished.
    wconn = psycopg2.connect(DB_URL)
    wconn.autocommit = False

    # A named cursor streams from the server; 1.3 GB of text will not fit in the
    # client otherwise.
    cur = conn.cursor(name="uk_export", cursor_factory=psycopg2.extras.DictCursor)
    cur.itersize = 2000
    cur.execute(SELECT_TEXTS, (args.min_chars,))

    now = datetime.now(timezone.utc)
    stats = {"texts": 0, "markers": 0, "chunked": 0, "chunks": 0, "written": 0}
    pending, wcur = [], wconn.cursor()

    def flush():
        if pending and not args.dry_run:
            psycopg2.extras.execute_values(wcur, RECORD, pending, page_size=1000)
            wconn.commit()
        pending.clear()

    for row in cur:
        stats["texts"] += 1
        text = row["text"]
        if MARKER_RE.match(text):
            # The repealed marker and its 50 variants. Deduplication already
            # reduced 260,415 rows to these; dropping them costs nothing and
            # removes the corpus's loudest false neighbour.
            stats["markers"] += 1
            continue
        h = bytes(row["text_hash"])
        parts = chunk(text, args.chunk_chars, args.chunk_overlap)
        if len(parts) > 1:
            stats["chunked"] += 1
        for i, part in enumerate(parts):
            out.write(json.dumps({
                "id": h.hex() + (f"-{i}" if len(parts) > 1 else ""),
                "text_hash": h.hex(),
                "chunk_ord": i,
                "n_chars": len(part),
                "text": part,
            }, ensure_ascii=False) + "\n")
            pending.append((psycopg2.Binary(h), i, len(part), args.model, now))
            stats["chunks"] += 1
            stats["written"] += 1
            if len(pending) >= 2000:
                flush()
        if args.limit and stats["texts"] >= args.limit:
            break

    flush()
    cur.close()
    wconn.close()
    if out is not sys.stdout:
        out.close()

    print("=== export summary", file=sys.stderr)
    for k in ("texts", "markers", "chunked", "chunks", "written"):
        print(f"  {k:<9} {stats[k]:,}", file=sys.stderr)
    if args.dry_run:
        print("  (dry run — uk_embedding_state untouched)", file=sys.stderr)


if __name__ == "__main__":
    main()
