"""Roll the decision text cleanup back: put the archived raw text into full_text.

  python scripts/restore_raw_text.py --dsn "$CHPIPE_DSN" [--raw-dir DIR]
         [--spider S] [--limit N] [--dry-run]

STOP the clean-text stage (tmux chclean-b) first: a running stage would race
this script. For every stamped row (ch_text_clean_state.cleaned_at IS NOT NULL):

  1. load the gzip archive, require sha256_of(archive) == state.raw_sha256
     (a mismatch, a missing or corrupt archive: row skipped and counted);
  2. in one transaction per batch, compare-and-set
       UPDATE ch_court_decisions SET full_text = <archive>
        WHERE doc_id = ... AND full_text = clean_pdf_text(<archive>, langs)
     so a row whose text changed after cleaning (re-extracted, re-OCRed) is
     left alone and counted `changed`;
  3. mark the state row rolled back: cleaned_at = NULL, attempts =
     max_attempts (CHPIPE_MAX_ATTEMPTS, default 3), last_error = 'rolled back
     <date>', so clean-text's claim (attempts < max_attempts) never takes it again.

The compare-and-set needs the SAME cleaner code that wrote the text: run this
from the release that cleaned. The FTS GIN index and citations must be
rebuilt afterwards (REINDEX, citations re-extract).
"""
from __future__ import annotations

import argparse
import datetime
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chpipe import raw_text_archive, text_clean  # noqa: E402
from chpipe.stages.clean_text_stage import languages_for  # noqa: E402

BATCH = 200
_COLS = ("s.doc_id, s.spider, s.raw_sha256, d.languages, "
         "d.metadata_json->>'Sprache' AS sprache")


def _batches(conn, spider, limit, batch):
    """Keyset pages over (spider, doc_id): skipped rows stay stamped, so the
    page cursor, not the predicate, is what keeps them from being re-read."""
    last = ("", "")
    seen = 0
    while limit is None or seen < limit:
        n = batch if limit is None else min(batch, limit - seen)
        sql = (f"SELECT {_COLS} FROM ch_text_clean_state s "
               "JOIN ch_court_decisions d USING (doc_id) "
               "WHERE s.cleaned_at IS NOT NULL AND (s.spider, s.doc_id) > (%s, %s)")
        params = [last[0], last[1]]
        if spider:
            sql += " AND s.spider = %s"
            params.append(spider)
        sql += " ORDER BY s.spider, s.doc_id LIMIT %s"
        params.append(n)
        rows = conn.execute(sql, params).fetchall()
        if not rows:
            return
        yield rows
        seen += len(rows)
        last = (rows[-1]["spider"], rows[-1]["doc_id"])


def restore(conn, raw_dir, *, spider=None, limit=None, dry_run=False,
            max_attempts=3, batch=BATCH) -> dict:
    counts = {"restored": 0, "sha_mismatch": 0, "archive_error": 0, "changed": 0}
    note = f"rolled back {datetime.date.today().isoformat()}"
    for rows in _batches(conn, spider, limit, batch):
        with conn.transaction():
            for r in rows:
                try:
                    archived = raw_text_archive.load(raw_dir, r["spider"], r["doc_id"])
                except (OSError, EOFError, ValueError) as exc:  # incl. BadGzipFile
                    print(f"archive error {r['doc_id']}: {type(exc).__name__}", file=sys.stderr)
                    counts["archive_error"] += 1
                    continue
                if raw_text_archive.sha256_of(archived) != r["raw_sha256"]:
                    counts["sha_mismatch"] += 1
                    continue
                expected = text_clean.clean_pdf_text(archived, languages_for(r))
                if dry_run:
                    ok = conn.execute(
                        "SELECT full_text = %s AS ok FROM ch_court_decisions "
                        "WHERE doc_id = %s", (expected, r["doc_id"])).fetchone()
                    counts["restored" if ok and ok["ok"] else "changed"] += 1
                    continue
                cur = conn.execute(
                    "UPDATE ch_court_decisions SET full_text = %s "
                    "WHERE doc_id = %s AND full_text = %s",
                    (archived, r["doc_id"], expected))
                if cur.rowcount != 1:
                    counts["changed"] += 1
                    continue
                conn.execute(
                    "UPDATE ch_text_clean_state SET cleaned_at = NULL, attempts = %s, "
                    "last_error = %s WHERE doc_id = %s",
                    (max_attempts, note, r["doc_id"]))
                counts["restored"] += 1
    return counts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--raw-dir", default=os.environ.get("CHPIPE_RAW_DIR"))
    ap.add_argument("--spider")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not a.raw_dir:
        ap.error("--raw-dir or CHPIPE_RAW_DIR is required")
    with psycopg.connect(a.dsn, autocommit=True, row_factory=dict_row) as conn:
        counts = restore(conn, Path(a.raw_dir), spider=a.spider, limit=a.limit,
                         dry_run=a.dry_run,
                         max_attempts=int(os.environ.get("CHPIPE_MAX_ATTEMPTS", "3")))
    print(("DRY RUN " if a.dry_run else "") + " ".join(f"{k}={v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
