"""Rebuild ch_legislation as a projection of the new tables.

Nothing in mcp_backend, lexwebapp or platform references this table (verified
by a word-boundary grep on 2026-08-23; an earlier "47 references" figure was
a substring artefact of `search_legislation`). It is kept only so external
notebooks and audits keep working -- but its sr_number column now holds the
real SR number instead of an ELI fragment, which is a deliberate change of
meaning for that column: the old importer derived a value like
"1971/1069_1068_1068" from the ELI path, which made "SR 220" unfindable by
its own number; this projection writes the real "220" straight from
ch_act.sr_number (see acts_stage.py, which reads it off Fedlex's own
id-systematique notation).

Measured on prod: of ch_legislation's 5,594 rows, 5,382 hold a CSS blob
instead of legislation text -- the old importer built filestore URLs by
string pattern, got HTML error pages back, and a tag-stripping fallback
turned a stylesheet into "full text". Only 212 rows carry genuine Akoma
Ntoso. The projection below upserts on (eli_uri, lang), the table's own
primary key, so any junk row whose eli_uri this corpus never re-derives is
never touched by the UPSERT and survives -- indistinguishable at a glance
from a row this run actually wrote. This module does NOT blind-DELETE those
survivors: nobody has reviewed which of the 5,594 rows are junk and which of
them are among the 212 real ones, so unilaterally deleting rows nobody
looked at would just trade one silent defect for another. Instead:

  * every row this projection writes carries
    metadata_json ->> 'projected_from' = 'ch_act_version', so a real row is
    distinguishable from a survivor by one query instead of by re-parsing
    5,594 akn_xml blobs by hand -- alongside 'article_count', so "this row
    is empty" is a queryable fact rather than a line in a run log somebody
    has to still have;
  * unaccounted_rows() counts, and run() logs, how many pre-existing rows
    this pass did NOT write or update -- so the decision to remove them can
    be made on that evidence, by a human, deliberately, not by a DELETE
    nobody reviewed.

The write itself is batched and bounded -- see run(). It used to be a single
INSERT ... SELECT over the whole corpus with no LIMIT, no statement timeout
and no progress output, so an interrupt discarded every one of ~15,000 rows
and left nothing to resume from.

Separately: stage='parsed' on ch_act_version is not the same claim as
"usable". A parsed edition with article_count = 0 is real data, not a
parsing defect -- Fedlex serves genuine nineteenth-century declarations
whose <act> has no <body> at all, and chpipe.akn correctly parses those into
zero articles. empty_latest_editions() reports how many of the editions
being projected are like that, so the projection says which case it is
rather than silently writing emptiness into the compatibility table as if
it were ordinary content.
"""
from __future__ import annotations

import logging

from psycopg.rows import tuple_row

from .. import db, throttle
from ..config import Settings

log = logging.getLogger(__name__)

# The one place "the latest parsed version per (act_id, lang)" is defined.
#
# An earlier draft of _PROJECT computed that fact twice: once through a JOIN
# LATERAL correlated on act_id -- which, lacking a LIMIT, did not itself
# restrict to the latest edition, only to *an* edition of that act -- and
# once more through an outer `WHERE version_id IN (SELECT DISTINCT ON ...)`
# that did the actual restricting. Two mechanisms computing one fact is how
# they drift apart the day someone edits one and not the other. DISTINCT ON
# alone already expresses "one row per (act_id, lang), the one with the
# latest date_applicability" completely and correctly, so it is the only
# mechanism kept here -- both _PROJECT and the two report queries below
# share this single definition of "latest" rather than each restating it.
#
# The ORDER BY carries a second key ahead of recency:
# (source = 'fedlex_pdf') ASC puts every structured parsed row (false) before
# every federal pdf-text row (true) for the same (act_id, lang). Only the
# FEDERAL pdf rows are demoted: they carry full_text with no article split and
# no akn_xml, so letting one outrank an XML edition would null akn_xml in the
# projection. Cantonal pdf-text rows (lexwork_pdf/lexfind, phase 2) are NOT
# demoted -- pdf_text_stage parses them into articles with akn_xml set, which
# makes them first-class editions that must project when they are the newest.
# So DISTINCT ON
# picks a pdf-a row only when NO xml/cantonal parsed row exists for that
# act+lang at all. Within each of those two groups, date_applicability DESC
# still picks the latest edition -- unchanged recency semantics, just
# scoped to whichever source group actually has a real XML/cantonal
# edition. Without this, a pdf-a edition that merely post-dates every XML
# edition of the same act won outright, and _PROJECT's ON CONFLICT then
# overwrote ch_legislation's real akn_xml/article_count with NULL. For an
# act with ONLY pdf-a editions (typically repealed pre-2021 acts that
# previously projected nothing at all), the pdf row still wins -- a pure
# gain, and akn_xml NULL there is honest, not a regression.
_LATEST_PARSED_VERSION = """
    SELECT DISTINCT ON (act_id, lang) *
      FROM ch_act_version
     WHERE stage = 'parsed'
     ORDER BY act_id, lang, (source = 'fedlex_pdf') ASC, date_applicability DESC
"""

# The editions this run will project, oldest version_id first. Read as a
# list up front, then written in batches -- see run() for why the write is
# not one statement.
_LATEST_IDS = f"""
SELECT version_id FROM ({_LATEST_PARSED_VERSION}) v ORDER BY version_id
"""

# How many editions one INSERT ... SELECT covers. Each row carries the
# edition's full akn_xml (2.2 MB for SR 220 alone) and full_text into a table
# with a GIN full-text index, so a batch is sized in rows, not in acts.
BATCH_SIZE = 250

# Per-statement ceiling for a batch. CLAUDE.md's rule for large Postgres
# operations, and the thing that turns a pathological batch into a failed
# batch instead of a session that holds locks on a live table indefinitely.
STATEMENT_TIMEOUT = "10min"

_PROJECT = f"""
INSERT INTO ch_legislation
    (eli_uri, lang, sr_number, title, short_title, version_date, in_force,
     date_entry_force, date_end_validity, akn_xml, full_text, xml_url,
     source, metadata_json, updated_at)
SELECT a.eli_work_uri,
       v.lang,
       a.sr_number,
       CASE v.lang WHEN 'de' THEN a.title_de WHEN 'fr' THEN a.title_fr
                   WHEN 'it' THEN a.title_it WHEN 'en' THEN a.title_en
                   ELSE a.title_rm END,
       a.abbreviation,
       v.date_applicability,
       a.in_force,
       a.date_entry_force,
       a.date_no_longer_in_force,
       v.akn_xml,
       v.full_text,
       v.xml_url,
       -- the edition's own source (migration 203): fedlex, lexwork, sil, ti_rl, ...
       v.source,
       -- article_count is here so "this projected row is empty" is a
       -- queryable fact rather than a line in a run log somebody has to
       -- still have. A body-less Fedlex act is genuine data (see
       -- empty_latest_editions() and the module docstring), and
       -- ch_legislation is the surface external notebooks read -- empty
       -- text that looks like text is the failure mode this whole branch
       -- exists to correct.
       jsonb_build_object('act_id', a.act_id, 'version_id', v.version_id,
                          'article_count', v.article_count,
                          'jurisdiction', a.jurisdiction,
                          'projected_from', 'ch_act_version'),
       now()
  FROM ch_act a
  JOIN ({_LATEST_PARSED_VERSION}) v ON v.act_id = a.act_id
 WHERE v.version_id = ANY(%s)
ON CONFLICT (eli_uri, lang) DO UPDATE SET
    sr_number         = EXCLUDED.sr_number,
    title             = EXCLUDED.title,
    short_title       = EXCLUDED.short_title,
    version_date      = EXCLUDED.version_date,
    in_force          = EXCLUDED.in_force,
    date_entry_force  = EXCLUDED.date_entry_force,
    date_end_validity = EXCLUDED.date_end_validity,
    akn_xml           = EXCLUDED.akn_xml,
    full_text         = EXCLUDED.full_text,
    xml_url           = EXCLUDED.xml_url,
    source            = EXCLUDED.source,
    metadata_json     = EXCLUDED.metadata_json,
    updated_at        = now()
"""

_UNACCOUNTED = """
SELECT count(*) FROM ch_legislation
 WHERE metadata_json IS NULL
    OR metadata_json ->> 'projected_from' IS DISTINCT FROM 'ch_act_version'
"""

_EMPTY_LATEST = f"""
SELECT count(*) FROM ({_LATEST_PARSED_VERSION}) v
 -- NULL is folded in with an explicit 0: in the real pipeline
 -- parse_akn_stage.store_articles() always sets article_count (0 included)
 -- before a version reaches stage='parsed', so a parsed row with a NULL
 -- count here means something reached 'parsed' without going through that
 -- stage -- itself worth surfacing rather than quietly excluding.
 WHERE COALESCE(v.article_count, 0) = 0
"""


def unaccounted_rows(conn) -> int:
    """Pre-existing ch_legislation rows this run's projection did not write
    or update -- see the module docstring for why this is reported instead
    of deleted. Works against any connection, whatever its default
    row_factory (db.connect()'s dict rows, or a plain psycopg.connect()'s
    tuples), by asking for tuple rows explicitly -- same discipline as
    db.unkeyed_count()."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UNACCOUNTED)
        return cur.fetchone()[0]


def empty_latest_editions(conn) -> int:
    """How many of the latest-parsed editions eligible for projection have
    zero articles -- a genuine body-less Fedlex act, not necessarily a
    parsing failure. See the module docstring."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_EMPTY_LATEST)
        return cur.fetchone()[0]


def _pending(conn) -> list[int]:
    """The version_ids to project, in a stable order."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_LATEST_IDS)
        return [r[0] for r in cur.fetchall()]


def _write_batch(conn, version_ids: list[int]) -> int:
    """One batch, one statement. Factored out so a run can be interrupted
    between batches in a test, which is the property that matters."""
    return conn.execute(_PROJECT, (version_ids,)).rowcount


def run(settings: Settings, batch_size: int = BATCH_SIZE,
        statement_timeout: str = STATEMENT_TIMEOUT) -> int:
    """Project every latest parsed edition into ch_legislation, in batches.

    Batched, not one INSERT ... SELECT over the whole corpus. The single
    statement wrote on the order of 15,000 rows, each carrying the full
    akn_xml (2.2 MB for SR 220 alone) and full_text, into a table with a GIN
    full-text index -- with no LIMIT, no statement timeout and no progress
    output, so an interrupt threw away every row and left nothing to resume
    from. That is the opposite of the queue discipline this branch applies
    everywhere else, and it is what CLAUDE.md's rule for large Postgres
    operations exists to prevent.

    db.connect() opens the connection with autocommit=True, so each batch
    commits on its own: an interrupted run keeps the batches it finished,
    and re-running is safe because every write is an upsert on (eli_uri,
    lang). Progress is logged per batch, so a multi-minute run is visible
    while it happens rather than only in its return value.

    `statement_timeout` bounds one batch. Set it to "0" to disable, which is
    a maintenance-window choice, not a default.

    The pending ids are snapshotted once, while _PROJECT re-derives "latest"
    per batch. If parse-akn promotes a newer edition of an act mid-run, that
    act's snapshotted id is no longer latest and its batch row matches
    nothing, so the act is skipped until the next projection. A skip, never
    a wrong write or a duplicate -- and the next run picks it up.
    """
    conn = db.connect(settings)
    try:
        # set_config() rather than a SET statement: SET does not take bound
        # parameters, and building the value into the SQL string is how a
        # setting turns into an injection point.
        conn.execute("SELECT set_config('statement_timeout', %s, false)",
                     (statement_timeout,))
        pending = _pending(conn)
        total = len(pending)
        log.info("projecting %d edition(s) into ch_legislation in batches of %d",
                 total, batch_size)
        written = 0
        for start in range(0, total, batch_size):
            written += _write_batch(conn, pending[start:start + batch_size])
            log.info("projected %d/%d", min(start + batch_size, total), total)
        unaccounted = unaccounted_rows(conn)
        empty = empty_latest_editions(conn)
        log.info("projected %d rows into ch_legislation", written)
        if unaccounted:
            log.warning(
                "UNACCOUNTED: %d pre-existing ch_legislation row(s) this "
                "pass did not write or update -- an eli_uri/lang the new "
                "corpus never re-derived. Likely survivors of the old "
                "importer's CSS-blob defect (see module docstring); review "
                "before deciding whether to remove them.", unaccounted)
        if empty:
            log.info(
                "%d of the projected editions are parsed with zero "
                "articles -- a body-less Fedlex act is expected here, not "
                "necessarily a defect.", empty)
        return written
    finally:
        conn.close()


def main() -> int:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 per spec section 8. The work is Postgres-side, but the batches
    move ~15,000 full documents through a GIN-indexed table on a box serving
    live traffic, so this process yields the core it holds while doing it.
    No capacity wait: the load this stage creates is on the database, which
    its own per-statement timeout and batch size bound, and pausing the
    client would not relieve it.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    written = run(Settings.from_env())
    log.info("projected=%d", written)
    return written


if __name__ == "__main__":
    main()
