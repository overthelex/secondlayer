"""Queue primitives over the stage column on ch_court_decisions.

The queue is a column, not a table: the work item and the destination row are
the same row, so a claim can never drift from the data it describes.
"""
from __future__ import annotations

import psycopg
from psycopg.rows import dict_row, tuple_row

from .config import Settings

# Columns a stage runner needs to do its work.
_CLAIM_COLUMNS = (
    "doc_id, ecli, spider, canton, decision_date, html_url, pdf_url, json_url, "
    "languages, text_source, text_quality, pdf_sha256, attempts"
)

# Columns that complete() is allowed to write through **fields.
# Reserved columns (stage, last_error, stage_updated_at, updated_at) are managed
# by complete() itself and cannot be passed in **fields.
_COMPLETE_ALLOWED_COLUMNS = frozenset({
    "full_text", "text_source", "text_quality", "pdf_sha256",
    "decision_date", "abstract", "docket_number", "canton",
    "html_url", "pdf_url", "json_url", "chamber", "court_code",
    "languages", "metadata_json"
})


class QueueWriteMissed(RuntimeError):
    """A keyed queue write matched no row.

    complete() and fail() both key on `WHERE doc_id = %s`. An UPDATE that
    matches nothing is not a quiet no-op to be shrugged off: it means the row
    this stage believes it is working on cannot be advanced, retired or even
    marked as having failed, so the stage will claim it again on the next
    pass and again forever. Raising is what turns that into a visible fault
    the per-document guards already know how to record.
    """


def connect(settings: Settings) -> psycopg.Connection:
    return psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row)


def _require_one(cursor, doc_id: str, operation: str) -> None:
    if cursor.rowcount != 1:
        raise QueueWriteMissed(
            f"{operation} matched {cursor.rowcount} rows for doc_id={doc_id!r}; "
            "the row is gone or was never keyed")


def unkeyed_count(conn, stage: str, spider: str | None = None) -> int:
    """Rows sitting in `stage` that claim() will never hand out.

    claim() refuses rows with a NULL doc_id because nothing downstream can
    write them back. That is the right call, but skipping them silently
    would replace an endless loop with an invisible backlog, so every stage
    logs this number once at start-up. A non-zero count means those rows
    need `index` to give them a doc_id, not another pass of this stage.
    """
    sql = ("SELECT count(*) AS n FROM ch_court_decisions "
           "WHERE stage = %s AND doc_id IS NULL")
    params: list = [stage]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    # Explicit row factory: callers hand in connections with either factory
    # (reports.py needs dict_row, the queue tests use the default), and this
    # helper must not care which.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0]


def claim(conn, stage: str, limit: int, spider: str | None = None,
          max_attempts: int = 3) -> list[dict]:
    """Rows sitting in `stage` that still have attempts left.

    FOR UPDATE SKIP LOCKED reduces overlap between stage processes but is not
    a distributed lock under autocommit mode (the row lock releases the moment
    the SELECT completes). One process per stage is the supported model.

    `doc_id IS NOT NULL` is load-bearing, not defensive. complete() and
    fail() key on doc_id, so a row without one can be claimed but never
    written back: db.fail() is a no-op, attempts never rise, the stage
    re-claims the same rows on the next iteration and `while True` never
    terminates. Measured on a scratch database with a legacy-shaped row
    (ecli set, doc_id NULL), the second claim returned the identical row and
    report.fetched_pdf counted every non-write as a success. The 678,165
    rows already on prod are exactly this shape until `index` runs, and
    documents withdrawn from the entscheidsuche listing stay this shape
    permanently. See unkeyed_count() for how many are being skipped.
    """
    sql = (
        f"SELECT {_CLAIM_COLUMNS} FROM ch_court_decisions "
        "WHERE stage = %s AND attempts < %s AND doc_id IS NOT NULL"
    )
    params: list = [stage, max_attempts]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    sql += " ORDER BY spider, doc_id LIMIT %s FOR UPDATE SKIP LOCKED"
    params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def complete(conn, doc_id: str, next_stage: str, **fields) -> None:
    """Move a row to its next stage, writing any produced fields in the same
    statement so a crash cannot leave the stage ahead of the data."""
    # Guard against reserved columns and injection via unknown column names.
    for column in fields:
        if column not in _COMPLETE_ALLOWED_COLUMNS:
            raise ValueError(f"complete() does not allow column '{column}'")

    assignments = ["stage = %s", "last_error = NULL", "stage_updated_at = now()",
                   "updated_at = now()"]
    params: list = [next_stage]
    for column, value in fields.items():
        assignments.append(f"{column} = %s")
        params.append(value)
    params.append(doc_id)
    cursor = conn.execute(
        f"UPDATE ch_court_decisions SET {', '.join(assignments)} WHERE doc_id = %s",
        params,
    )
    _require_one(cursor, doc_id, f"complete(-> {next_stage})")


def fail(conn, doc_id: str, error: str, max_attempts: int) -> None:
    """Record a failed attempt. The row keeps its stage until attempts run out,
    so a transient error retries and a permanent one stops consuming the queue."""
    cursor = conn.execute(
        """
        UPDATE ch_court_decisions
           SET attempts = attempts + 1,
               last_error = %s,
               stage = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE stage END,
               stage_updated_at = now()
         WHERE doc_id = %s
        """,
        (error[:2000], max_attempts, doc_id),
    )
    _require_one(cursor, doc_id, "fail()")


def retry_failed(conn, stage: str, spider: str | None = None) -> int:
    """Put failed rows back on `stage` with a clean attempt counter.

    Deliberately manual: a failed row means someone has to look at last_error
    before it is worth another 800,000-document run.
    """
    sql = ("UPDATE ch_court_decisions SET stage = %s, attempts = 0, last_error = NULL "
           "WHERE stage = 'failed'")
    params: list = [stage]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    return conn.execute(sql, params).rowcount
