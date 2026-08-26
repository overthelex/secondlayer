"""Queue primitives over the stage column on ch_court_decisions.

The queue is a column, not a table: the work item and the destination row are
the same row, so a claim can never drift from the data it describes.

The citation stages are the one exception, and the exception is measured
rather than stylistic: their bookkeeping lives in ch_citation_state
(migration 200) because ch_court_decisions is 19 GB with a 7.6 GB full-text
GIN, where a flag column inside an index predicate turns every stamp into a
whole-row rewrite across every index on the table. See the "Citations queue"
section below.
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


# Spec section 8: a failed row waits 1, then 5, then 30 minutes before it is
# offered again. Without a time predicate `claim` re-offers a failed row on the
# very next iteration of the same run, so a 30-second source hiccup burns all
# three attempts within seconds and the document is retired as permanently
# broken. No new column is needed: db.fail() already stamps stage_updated_at.
RETRY_BACKOFF_MINUTES = (1, 5, 30)


def claim(conn, stage: str, limit: int, spider: str | None = None,
          max_attempts: int = 3,
          backoff_minutes: tuple[int, ...] | None = RETRY_BACKOFF_MINUTES) -> list[dict]:
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
    if backoff_minutes:
        # attempts is 1-based into the backoff table, which is what Postgres
        # array indexing wants; least() clamps a row that somehow carries more
        # attempts than the table has entries. attempts = 0 (never failed) and
        # a NULL stage_updated_at (a row the migration enrolled) are both
        # immediately eligible.
        sql += (" AND (attempts = 0 OR stage_updated_at IS NULL"
                " OR stage_updated_at <= now() - make_interval("
                "mins => (%s::int[])[least(attempts, %s)]))")
        params.extend([list(backoff_minutes), len(backoff_minutes)])
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

    # attempts is a per-stage retry budget, not a lifetime one. Leaving it
    # alone meant a row that survived two transient fetch retries arrived at
    # extract with a single attempt left for the remaining three stages, so
    # one hiccup anywhere downstream retired it permanently. A row that moves
    # forward has succeeded at what it was retrying, so the budget resets --
    # and failed_stage goes with it, since the row is no longer failed.
    assignments = ["stage = %s", "last_error = NULL", "attempts = 0",
                   "failed_stage = NULL", "stage_updated_at = now()",
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

    # The citation queue lives in ch_citation_state (migration 200), NOT in a
    # column of the row just updated -- see that migration's header for the
    # measurement. Both writes below are separate statements against that
    # narrow table rather than one more assignment in the UPDATE above, which
    # is the entire point: ch_court_decisions carries a 7.6 GB full-text GIN,
    # and a queue flag stored next to it cannot be updated without rewriting
    # the row into every index on the table.
    #
    # Unconditional, not gated on a caller-supplied field -- extract_stage,
    # ocr_stage and load_stage all reach their transitions through this same
    # call, and a citation-graph concern has no business being something any
    # of them has to remember to pass in.
    if next_stage == "extracted":
        # New text means this decision's extraction is stale: the
        # ch_case_citations/ch_legislation_citations rows citations_stage
        # wrote came from the OLD full_text. Re-queue it.
        _enqueue_for_citations_by_doc_id(conn, doc_id)
    elif next_stage == "loaded":
        # First arrival at 'loaded' is what makes a decision claimable at
        # all, so it needs a state row. Absent-only: a decision that has
        # been through here before (a re-extraction that load promotes
        # again) already has its row, queued by the 'extracted' branch
        # above, and must not be re-queued a second time -- nor un-queued.
        ensure_citation_state_by_doc_id(conn, doc_id)


def fail(conn, doc_id: str, error: str, max_attempts: int) -> None:
    """Record a failed attempt. The row keeps its stage until attempts run out,
    so a transient error retries and a permanent one stops consuming the queue."""
    cursor = conn.execute(
        """
        UPDATE ch_court_decisions
           SET attempts = attempts + 1,
               last_error = %s,
               failed_stage = CASE WHEN attempts + 1 >= %s AND stage <> 'failed'
                                   THEN stage ELSE failed_stage END,
               stage = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE stage END,
               stage_updated_at = now()
         WHERE doc_id = %s
        """,
        (error[:2000], max_attempts, max_attempts, doc_id),
    )
    _require_one(cursor, doc_id, "fail()")


def mark_failed(conn, doc_id: str, error: str, from_stage: str, **fields) -> None:
    """Retire a row as permanently failed, keeping the reason and the origin.

    This is the terminal counterpart to fail(): fail() spends an attempt and
    hopes, mark_failed() closes the document. It exists because
    `complete(..., 'failed')` clears last_error as part of its own SET list,
    so two of the three call sites that used it lost the error text
    outright -- extract's bad-quality HTML and ocr's still-unreadable scan,
    which are the two most diagnostically interesting failure classes in the
    pipeline, both landing as an anonymous NULL bucket in the triage query.
    load_stage compensated with a follow-up UPDATE; the other two did not.
    One helper, one behaviour, three call sites that cannot forget.

    `from_stage` is recorded in failed_stage so retry_failed() can send the
    row back where it came from instead of to the front of the queue.
    """
    for column in fields:
        if column not in _COMPLETE_ALLOWED_COLUMNS:
            raise ValueError(f"mark_failed() does not allow column '{column}'")

    assignments = ["stage = 'failed'", "last_error = %s", "failed_stage = %s",
                   "stage_updated_at = now()", "updated_at = now()"]
    params: list = [error[:2000], from_stage]
    for column, value in fields.items():
        assignments.append(f"{column} = %s")
        params.append(value)
    params.append(doc_id)
    cursor = conn.execute(
        f"UPDATE ch_court_decisions SET {', '.join(assignments)} WHERE doc_id = %s",
        params,
    )
    _require_one(cursor, doc_id, "mark_failed()")


def requeue_for_pdf(conn, doc_id: str, error: str) -> None:
    """Send a document whose HTML body was unusable back to `indexed` so the
    next fetch takes the PDF the listing also offered.

    Found on the first prod backfill: GE_TAPI's HTML pages are 3 KB cards --
    docket, descriptors and a `var pdfUrl = ...` -- and AG_Gerichte's are
    Weblaw "AGVE - Archiv" shells; the decision IS the PDF. choose_body()
    prefers HTML, so 506 documents with a pdf_url in the table were retired
    as "html quality 0.0000 ... no scan behind an HTML page". The HTML being
    a card is recorded as text_source = 'pdf' -- the body this document
    WANTS -- and fetch_stage.choose_body() honours it. Not by clearing
    html_url: index_stage's upsert restores html_url from the listing on
    every re-index (COALESCE(EXCLUDED.html_url, ...)), and the nightly delta
    runs index before fetch, so a cleared URL would come back and the row
    would fetch the card again forever. text_source is not in that SET list
    and survives. The diagnosis stays in last_error; attempts are left alone
    because nothing was retried, the body was wrong. Refuses (rowcount 0 ->
    QueueWriteMissed) when there is no pdf_url to fall back to -- that case
    is mark_failed()'s, and the row is left exactly as it was.
    """
    cursor = conn.execute(
        """
        UPDATE ch_court_decisions
           SET stage = 'indexed',
               text_source = 'pdf',
               last_error = %s,
               failed_stage = NULL,
               stage_updated_at = now(),
               updated_at = now()
         WHERE doc_id = %s AND pdf_url IS NOT NULL
        """,
        (error[:2000], doc_id),
    )
    _require_one(cursor, doc_id, "requeue_for_pdf()")


def failed_by_stage(conn) -> list[tuple[str | None, int]]:
    """Triage: how many failures each stage produced. NULL means the row never
    entered a queue stage at all (index found neither HTML nor PDF)."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT failed_stage, count(*) FROM ch_court_decisions "
                    "WHERE stage = 'failed' GROUP BY 1 ORDER BY 2 DESC")
        return [(r[0], r[1]) for r in cur.fetchall()]


def retry_failed(conn, stage: str | None = None, spider: str | None = None) -> int:
    """Put failed rows back on the stage they failed in, with a clean budget.

    `stage=None` -- the sensible default -- returns each row to its own
    `failed_stage`. Nothing recorded which stage a row failed in before, and
    `failed` is reachable from five places, so the only available recovery
    was to send every failure to one caller-chosen stage. The README's own
    copy-paste example hardcoded 'indexed', which pushes an OCR-terminal row
    back to the front of the queue and re-runs days of OCR on a document
    that was already read twice.

    Rows with a NULL failed_stage (index found no body, so they never
    entered a queue stage) are left alone unless `stage` is given
    explicitly: there is no stage to return them to, and re-queueing them
    just burns three more attempts against a listing that still offers
    nothing. Re-run `index` for those instead.

    last_error is deliberately NOT cleared. It is the field the operator was
    told to read before retrying; wiping it on the way out destroys the
    evidence for the next failure. complete() clears it when the row
    actually succeeds.

    Deliberately manual: a failed row means someone has to look at
    last_error before it is worth another 800,000-document run.
    """
    sql = ("UPDATE ch_court_decisions "
           "SET stage = COALESCE(%s, failed_stage), attempts = 0, "
           "    failed_stage = NULL, stage_updated_at = now() "
           "WHERE stage = 'failed' AND COALESCE(%s, failed_stage) IS NOT NULL")
    params: list = [stage, stage]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    return conn.execute(sql, params).rowcount


# ---------------------------------------------------------------------------
# ch_act_version queue: the fetch-xml / parse-akn pipeline's queue, over a
# second table. Same discipline as the ch_court_decisions queue above -- a
# column allowlist on the dynamic SET, a loud QueueWriteMissed on any keyed
# write that matches no row, and (as of migration 197's stage_updated_at
# column) the same retry backoff -- because all three defects were found,
# the hard way, in the decisions pipeline first (see claim()'s, complete()'s
# and RETRY_BACKOFF_MINUTES's comments above) and there is no reason this
# table gets to relearn them. Without the backoff specifically: a durably
# broken row was reclaimed on run()'s very next while-True iteration and
# burned its whole attempts budget inside one stage run, ending at 'failed'
# before the row ever got a second look on a later day -- the identical
# defect RETRY_BACKOFF_MINUTES exists to close on the decisions queue.
#
# One thing this queue does NOT need that the decisions queue does: an
# unkeyed-row guard. version_id is a bigserial primary key every row has by
# construction -- there is no legacy population claimed but never written
# back, unlike doc_id on ch_court_decisions -- so claim_versions() carries
# no doc_id-is-null equivalent and there is no unkeyed_versions_count().
# ---------------------------------------------------------------------------

_CLAIM_VERSION_COLUMNS = (
    "version_id, act_id, lang, date_applicability, xml_url, attempts"
)

# Columns complete_version() is allowed to write through **fields. Reserved
# columns (stage, last_error, attempts, failed_stage, updated_at) are managed
# by complete_version() itself and cannot be passed in **fields -- see
# _COMPLETE_ALLOWED_COLUMNS above for why an allowlist exists at all: without
# one, a caller passing a column complete_version() already sets
# unconditionally produces two assignments to the same column and Postgres
# rejects the whole UPDATE.
_COMPLETE_VERSION_ALLOWED_COLUMNS = frozenset({
    "akn_xml", "fetched_at", "full_text",
})


def claim_versions(conn, stage: str, limit: int, max_attempts: int = 3,
                   backoff_minutes: tuple[int, ...] | None = RETRY_BACKOFF_MINUTES
                   ) -> list[dict]:
    """The same queue discipline as claim(), against ch_act_version --
    including the same backoff predicate, over the same RETRY_BACKOFF_MINUTES
    schedule: attempt 1 waits a minute, attempt 2 five, attempt 3 thirty; a
    row that has never failed (attempts = 0) or whose stage_updated_at is
    still NULL (migration 197 enrolled it with none) is claimable
    immediately. See claim()'s docstring for why the predicate is `>=`-style
    time math rather than a re-queue timestamp, and why a row is never
    delayed until it has actually failed once."""
    sql = (f"SELECT {_CLAIM_VERSION_COLUMNS} FROM ch_act_version "
           "WHERE stage = %s AND attempts < %s")
    params: list = [stage, max_attempts]
    if backoff_minutes:
        sql += (" AND (attempts = 0 OR stage_updated_at IS NULL"
                " OR stage_updated_at <= now() - make_interval("
                "mins => (%s::int[])[least(attempts, %s)]))")
        params.extend([list(backoff_minutes), len(backoff_minutes)])
    sql += " ORDER BY act_id, date_applicability, lang LIMIT %s FOR UPDATE SKIP LOCKED"
    params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _require_one_version(cursor, version_id: int, operation: str) -> None:
    """The version-queue twin of _require_one() above: a keyed write that
    matches no row is not a quiet no-op. Without this, claim_versions()
    could hand out a row that complete_version()/fail_version() silently
    fail to write back, and the stage would re-claim it forever while
    counting every non-write as a success -- the exact Critical finding
    _require_one() exists to close on the decisions queue."""
    if cursor.rowcount != 1:
        raise QueueWriteMissed(
            f"{operation} matched {cursor.rowcount} rows for "
            f"version_id={version_id!r}; the row is gone or was never keyed")


def complete_version(conn, version_id: int, next_stage: str, **fields) -> None:
    """Move a version to its next stage, writing any produced fields in the
    same UPDATE statement -- see complete()'s docstring for why a single
    statement matters (a crash cannot leave the stage ahead of the data) and
    why the attempt budget resets on every forward move (a row that survived
    a transient fetch retry must not arrive at parse with its budget already
    spent). failed_stage is cleared alongside attempts for the same reason:
    a row that just moved forward is no longer failed."""
    for column in fields:
        if column not in _COMPLETE_VERSION_ALLOWED_COLUMNS:
            raise ValueError(f"complete_version() does not allow column '{column}'")

    assignments = ["stage = %s", "last_error = NULL", "attempts = 0",
                   "failed_stage = NULL", "stage_updated_at = now()",
                   "updated_at = now()"]
    params: list = [next_stage]
    for column, value in fields.items():
        assignments.append(f"{column} = %s")
        params.append(value)
    params.append(version_id)
    cursor = conn.execute(
        f"UPDATE ch_act_version SET {', '.join(assignments)} WHERE version_id = %s",
        params)
    _require_one_version(cursor, version_id, f"complete_version(-> {next_stage})")


def fail_version(conn, version_id: int, error: str, max_attempts: int) -> None:
    """Record a failed attempt, and -- once attempts run out -- which stage
    the row died in. Same shape as fail(): the row keeps its stage while
    attempts remain (a transient error retries) and moves to 'failed' only
    on the last one (a permanent error stops consuming the queue).
    failed_stage lets retry_failed_versions() below send the row back to
    where it actually died instead of to the front of the queue."""
    cursor = conn.execute(
        """
        UPDATE ch_act_version
           SET attempts = attempts + 1,
               last_error = %s,
               failed_stage = CASE WHEN attempts + 1 >= %s AND stage <> 'failed'
                                   THEN stage ELSE failed_stage END,
               stage = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE stage END,
               stage_updated_at = now()
         WHERE version_id = %s
        """,
        (error[:2000], max_attempts, max_attempts, version_id))
    _require_one_version(cursor, version_id, "fail_version()")


def failed_by_stage_versions(conn) -> list[tuple[str | None, int]]:
    """Triage for the ch_act_version queue: how many failures each stage
    produced. The twin of failed_by_stage() above, and the query an operator
    is told to run before retrying anything.

    A NULL failed_stage means the row reached 'failed' without fail_version()
    ever recording an origin -- it should not happen (fail_version() stamps
    failed_stage on the attempt that retires the row), so a non-zero NULL
    bucket is itself worth looking at rather than rounding away.
    """
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT failed_stage, count(*) FROM ch_act_version "
                    "WHERE stage = 'failed' GROUP BY 1 ORDER BY 2 DESC")
        return [(r[0], r[1]) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Citations queue: ch_citation_state (migration 200), one narrow row per
# decision, NOT a stage transition and NOT a column on ch_court_decisions.
# citations_stage does not move a row off 'loaded'; it stamps
# ch_citation_state.extracted_at once that decision's text has been scanned
# successfully.
#
# Why the side table: ch_court_decisions is 19 GB with a 7.6 GB full-text
# GIN, and the flag this replaces sat inside a partial index predicate on
# it -- so every stamp and unstamp was a non-HOT row rewrite that re-inserted
# the row into every index on the table. Measured on prod 2026-08-25: a bulk
# unstamp of 1.22M rows ran 22+ minutes and the GIN grew 0.6 GB in a day.
# The stages here now only ever READ ch_court_decisions.
#
# Failure policy: a decision whose extraction raises is not stamped; instead
# fail_citations() spends one of its attempts and records last_error, and
# the claim below refuses rows that have run out of attempts. That is a
# change from the column-flag era, where there was no attempt counter at all
# and a poison text was re-read (and re-logged) on every single run forever.
# The in-run guard in citations_stage.run() still exists and is still
# needed -- it is what stops ONE run from re-claiming the row it just failed
# before the next run's claim can see the raised attempt count.
# ---------------------------------------------------------------------------

_CLAIM_CITATIONS_COLUMNS = ("s.ecli, d.doc_id, d.spider, d.court_code, "
                            "d.decision_date, d.docket_number, d.full_text")


def claim_for_citations(conn, limit: int, spider: str | None = None,
                        max_attempts: int = 3) -> list[dict]:
    """Decisions sitting at `loaded` whose text has not been scanned yet.

    The queue is ch_citation_state; ch_court_decisions is joined for the
    text and the stage/spider predicates only, and is never written here.

    FOR UPDATE OF s -- the state row, not the decision: locking the 19 GB
    table's row would serialise this stage against the pipeline stages that
    actually write it. Same caveat as claim(): under autocommit this is not
    a distributed lock (the row lock releases the moment the SELECT
    completes), so one process per stage is the supported model.

    ORDER BY s.ecli, and that is a performance decision, not a priority one.
    The queue has no priority; the order only has to be STABLE, so a row
    that is skipped is not re-offered ahead of the whole backlog forever.
    The obvious inherited choice, ORDER BY d.spider, d.doc_id, is the order
    the pre-200 claim used -- but that was cheap only because of the
    (spider, doc_id) partial index ON ch_court_decisions, which migration
    200 drops along with the flag it indexed. Without it the planner has to
    hash-join the two tables and sort the result: measured on a 200k-row
    backlog, 255 ms per 200-row claim, materialising full_text for every
    pending row just to sort them. s.ecli is ch_citation_state's primary
    key, so ordering by it is an index scan feeding a nested loop that
    touches only the rows actually returned -- 0.8 ms for the same claim.
    Keep the ORDER BY on the state table's own key if this query is ever
    edited again; the spider filter is a predicate on the joined table and
    does not change that.
    """
    sql = ("SELECT " + _CLAIM_CITATIONS_COLUMNS + " FROM ch_citation_state s "
           "JOIN ch_court_decisions d ON d.ecli = s.ecli "
           "WHERE s.extracted_at IS NULL AND s.attempts < %s "
           "AND d.stage = 'loaded'")
    params: list = [max_attempts]
    if spider:
        # s.spider, not d.spider: the two always agree (every writer copies
        # it off the decision row), and the difference is which table the
        # planner can use to eliminate rows. On the state table this is the
        # leading column of idx_ch_citation_state_pending_spider and the
        # claim seeks straight to that spider's pending rows; on the joined
        # table every pending row in the backlog has to be read and joined
        # before it can be discarded.
        sql += " AND s.spider = %s"
        params.append(spider)
    sql += " ORDER BY s.ecli LIMIT %s FOR UPDATE OF s SKIP LOCKED"
    params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def enqueue_for_citations(conn, eclis: list[str]) -> None:
    """Queue these decisions for (re-)extraction: a state row with a NULL
    extracted_at, whether or not one already existed.

    Called when a decision is given NEW text (db.complete(-> 'extracted')),
    which makes whatever edges it has stale. attempts/last_error are cleared
    with it, for the same reason complete() resets the stage retry budget:
    the attempts belong to the text that raised, and this is different text.

    INSERT ... SELECT rather than a values list: the state row carries the
    decision's spider (see claim_for_citations), and reading it off
    ch_court_decisions in the same statement is what stops any caller from
    having to know -- or pass -- it. A decision that does not exist inserts
    nothing, which is the right answer for a queue row about it.
    """
    if not eclis:
        return
    conn.execute(
        "INSERT INTO ch_citation_state (ecli, spider, extracted_at) "
        "SELECT ecli, spider, NULL FROM ch_court_decisions WHERE ecli = ANY(%s) "
        "ON CONFLICT (ecli) DO UPDATE SET extracted_at = NULL, attempts = 0, "
        "last_error = NULL, spider = EXCLUDED.spider, updated_at = now()",
        (eclis,),
    )


def _enqueue_for_citations_by_doc_id(conn, doc_id: str) -> None:
    """enqueue_for_citations() for the decision with this doc_id.

    complete() knows the doc_id, not the ecli, and reading the ecli back
    first would be a second round-trip per completed row on every extract
    and ocr run; INSERT ... SELECT does it in one.
    """
    conn.execute(
        "INSERT INTO ch_citation_state (ecli, spider, extracted_at) "
        "SELECT ecli, spider, NULL FROM ch_court_decisions WHERE doc_id = %s "
        "ON CONFLICT (ecli) DO UPDATE SET extracted_at = NULL, attempts = 0, "
        "last_error = NULL, spider = EXCLUDED.spider, updated_at = now()",
        (doc_id,),
    )


def ensure_citation_state(conn, eclis: list[str]) -> None:
    """Make sure these decisions have a state row, without disturbing one
    that already exists. The absent-only twin of enqueue_for_citations(),
    and it takes the spider off the decision row the same way."""
    if not eclis:
        return
    conn.execute(
        "INSERT INTO ch_citation_state (ecli, spider, extracted_at) "
        "SELECT ecli, spider, NULL FROM ch_court_decisions WHERE ecli = ANY(%s) "
        "ON CONFLICT (ecli) DO NOTHING",
        (eclis,),
    )


def ensure_citation_state_by_doc_id(conn, doc_id: str) -> None:
    """ensure_citation_state() for the decision with this doc_id -- the path
    load_stage reaches through complete(-> 'loaded'). Without it a decision
    that arrives at 'loaded' after migration 200's one-time seed (i.e. every
    decision the pipeline loads from now on) would have no state row at all,
    and the claim -- which drives off that table -- would never see it."""
    conn.execute(
        "INSERT INTO ch_citation_state (ecli, spider, extracted_at) "
        "SELECT ecli, spider, NULL FROM ch_court_decisions WHERE doc_id = %s "
        "ON CONFLICT (ecli) DO NOTHING",
        (doc_id,),
    )


def delete_citations(conn, eclis: list[str]) -> None:
    """Drop every edge these decisions currently have, ahead of re-inserting
    the ones their CURRENT text produces.

    Callers pass ONLY the decisions whose extraction succeeded: this is a
    delete with no transaction around the insert that follows it (the
    connection is autocommit -- see connect()), so a decision listed here
    whose replacement edges never arrive loses the ones it had.

    A decision only re-enters claim_for_citations() after complete(->
    'extracted') put its ch_citation_state row back to extracted_at IS NULL,
    i.e. after it was given new text. ON CONFLICT DO NOTHING in
    insert_citations() makes an edge the
    new text still contains collide harmlessly with the row already there --
    but an edge the new text no longer contains has nothing to collide with,
    and left alone it outlives the text it came from forever. Deleting the
    decision's edges first makes the batch a replacement rather than an
    addition.

    Scoped to from_ecli, so a re-extracted decision only ever drops its own
    edges -- never the ones some other decision wrote pointing at it.
    """
    if not eclis:
        return
    conn.execute("DELETE FROM ch_case_citations WHERE from_ecli = ANY(%s)", (eclis,))
    conn.execute("DELETE FROM ch_legislation_citations WHERE from_ecli = ANY(%s)",
                 (eclis,))


def insert_citations(conn, case_rows: list[tuple], statute_rows: list[tuple]) -> None:
    """One executemany per edge table, each with ON CONFLICT DO NOTHING.

    ON CONFLICT DO NOTHING is what makes stamp_citations() safe to skip after
    a failed insert: the same batch re-claimed on a later run re-inserts the
    same rows, which collide into the ones that already made it in rather
    than duplicating or erroring.

    case_rows: (from_ecli, to_raw, cite_kind, citation_context, from_date, from_court)
    statute_rows: (from_ecli, abbr_raw, article, paragraph, lang, citation_context, from_date)
    """
    if case_rows:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO ch_case_citations "
                "(from_ecli, to_raw, cite_kind, citation_context, from_date, from_court) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                case_rows,
            )
    if statute_rows:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO ch_legislation_citations "
                "(from_ecli, abbr_raw, article, paragraph, lang, citation_context, from_date) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                statute_rows,
            )


def stamp_citations(conn, eclis: list[str]) -> None:
    """Mark decisions as having had citations extracted. Called only after
    insert_citations() has succeeded for the same batch (see
    citations_stage.run()) -- a row must never be stamped ahead of the edges
    it was supposed to produce, and a row whose extraction RAISED must not be
    stamped at all: stamping it would retire it from the queue forever with
    whatever edges it happened to have.

    One narrow UPDATE against ch_citation_state -- ch_court_decisions is not
    touched. last_error is cleared with the stamp: it describes an attempt
    that has now been superseded by a successful one."""
    if not eclis:
        return
    conn.execute(
        "UPDATE ch_citation_state SET extracted_at = now(), last_error = NULL, "
        "updated_at = now() WHERE ecli = ANY(%s)",
        (eclis,),
    )


def fail_citations(conn, failures: list[tuple[str, str]]) -> None:
    """Record a failed extraction: one attempt spent, the reason kept, no
    stamp -- so the decision keeps the edges it already had and is offered
    again until it runs out of attempts (claim_for_citations's max_attempts).

    `failures` is (ecli, error). The attempt counter is the thing the old
    column-flag queue had no room for: an unstamped failure came back on
    every run forever, so one poison text was re-read and re-logged nightly
    with no way to retire it short of an operator noticing the warning.
    """
    if not failures:
        return
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE ch_citation_state SET attempts = attempts + 1, "
            "last_error = %s, updated_at = now() WHERE ecli = %s",
            [(error[:2000], ecli) for ecli, error in failures],
        )


def retry_failed_versions(conn, stage: str | None = None,
                          act_id: int | None = None) -> int:
    """Put failed editions back on the stage they failed in, with a clean
    budget. The ch_act_version twin of retry_failed() above.

    It exists because the legislation half of this pipeline had no recovery
    path at all while three separate comments promised one:
    fail_version()'s docstring, migration 197's COMMENT ON
    ch_act_version.failed_stage, and the README, which told the operator to
    run db.retry_failed() -- a function that touches ch_court_decisions only
    and therefore returns 0 against a legislation backlog, doing nothing,
    loudly enough to look like "there was nothing to retry".

    Same three decisions as retry_failed(), for the same reasons:

      * `stage=None` -- the sensible default -- returns each row to its own
        failed_stage rather than to one caller-chosen stage. A row that died
        in `parsed` must not be sent back to `discovered` to be re-fetched.
      * Rows with a NULL failed_stage are left alone unless `stage` is given
        explicitly: there is no stage to return them to, and re-queueing
        them just burns another attempts budget.
      * last_error is deliberately NOT cleared. It is the field the operator
        was told to read before retrying; complete_version() clears it when
        the row actually succeeds.

    `act_id` narrows the retry to one act, the way retry_failed()'s `spider`
    narrows it to one court -- so a diagnosis that applies to a single act's
    editions can be acted on without re-queueing the whole corpus.

    Deliberately manual: a failed edition means someone has to read
    last_error (and failed_by_stage_versions()) before another run.
    """
    sql = ("UPDATE ch_act_version "
           "SET stage = COALESCE(%s, failed_stage), attempts = 0, "
           "    failed_stage = NULL, stage_updated_at = now() "
           "WHERE stage = 'failed' AND COALESCE(%s, failed_stage) IS NOT NULL")
    params: list = [stage, stage]
    if act_id is not None:
        sql += " AND act_id = %s"
        params.append(act_id)
    return conn.execute(sql, params).rowcount
