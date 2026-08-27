"""Discovery of consolidated editions into ch_act_version.

56,326 consolidations (re-measured 2026-08-24; see chpipe/fedlex_queries.py
for the method and for why it is a snapshot), but only 12,033 carry the XML
manifestation this stage's query requires, so a full pass discovers on the
order of 38,000 (consolidation, lang) rows -- measured by running the shipped
VERSIONS query over a random sample of 2,000 works, not by COUNT (see the
warning in fedlex_queries.py about COUNT on this endpoint). Two thirds of
works return no version at all for want of an XML edition; that is a coverage
question about the query, not about paging, and it is deliberately left alone
here. This is the table
the old flat ch_legislation could not express at all: its primary key was
(eli_uri, lang), which allows exactly one edition per act, so production
holds no amendment history whatsoever. The uniqueness this stage writes
against is (eli_consolidation_uri, lang) -- the same consolidation realised
in DEU, FRA and ITA is three rows, not one row overwritten twice.

Two further properties of the source data shape this module:

  * The walk is driven by batches of work URIs read from ch_act rather than
    by a position in a global ordering of every version row. That is what
    keeps every query far below Virtuoso's SR353 ceiling (see
    chpipe/sparql.py), and it has the side effect that a version cannot be
    orphaned by construction -- its parent work is by definition already in
    ch_act. The orphan reporting below is kept all the same: it is now a
    consistency check on that claim rather than the expected outcome, and a
    non-zero count means something is wrong that a silent zero would hide.

    The walk is restartable and idempotent, NOT resumable: _SELECT_WORKS reads
    all of ch_act unconditionally, with no filter for works already walked, so
    an interrupted run redoes the whole pass from the first work. That is
    cheap (about 865 requests) and correct (every write is an upsert), and it
    is also the right default for a live government dataset, where a work's
    edition set can change between runs and skipping already-walked works
    would quietly freeze the ones walked earliest. Making it truly resumable
    would be a one-line `WHERE eli_work_uri > %s`; it is deliberately not
    there, so that a re-run re-discovers rather than resumes.
  * Fedlex returns the same consolidation from more than one named graph, so
    the same row is walked more than once. The second write of a row must
    update the first, not duplicate it -- see the ON CONFLICT clause below.
  * date_end_applicability is genuinely absent for the current edition of an
    act. That absence is meaningful (it is what marks a row as the current
    edition), so it is never defaulted to anything -- COALESCE only ever
    protects a value already on the row from being clobbered by a later,
    less-complete observation of the same consolidation.

The file URL is read from the graph (jolux:isExemplifiedBy on the XML
manifestation), never assembled from a string pattern. Building it by
pattern is the bug that filled 96% of production's ch_legislation with HTML
error pages instead of documents.

PDF-A DISCOVERY (source='fedlex_pdf'). Fedlex serves pdf-a manifestations
back to roughly 1995-2001, well before the XML era begins (~2007 on); most
of the corpus's pre-XML history exists only as pdf-a. run() therefore makes
a SECOND pass over the same driving set with fq.VERSIONS_PDF, writing
source='fedlex_pdf' rows ONLY where no XML edition already covers the same
(consolidation, lang) -- see upsert_pdf_version() and _UPSERT_PDF_VERSION
below. The pdf pass runs strictly AFTER the xml pass, in the same run(),
over the same works list: that ordering (not a query-time check against a
possibly-stale database) is what guarantees a consolidation available in
both formats always lands as XML. Migration 204 is what lets 'fedlex_pdf'
past the source CHECK constraint migration 201 added.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import db, throttle
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)

# A dozen offending URIs is enough for a human to act on; accumulating every
# one of a possible tens of thousands would just trade one silent problem
# (an unread count) for another (unbounded memory on a full 56k-edition walk).
_SAMPLE_CAP = 12


@dataclass
class VersionsReport:
    discovered: int = 0
    # orphaned: a version whose parent work is not in ch_act. Now that the
    # walk is driven BY ch_act, this should be structurally impossible, which
    # makes a non-zero value a louder signal than before rather than a quieter
    # one: it would mean a work vanished from ch_act mid-run, or that Fedlex
    # answered a VALUES batch with a work that was not in it. See
    # orphaned_works below.
    orphaned: int = 0
    orphaned_works: list[str] = field(default_factory=list)
    # skipped_language: a language Fedlex serves that fedlex_queries.LANGUAGE_MAP
    # does not cover. Not mapping a language is a decision, not an accident,
    # but it must stay visible rather than silently vanishing as a version
    # that was never even attempted.
    skipped_language: int = 0
    skipped_langs: list[str] = field(default_factory=list)
    by_lang: dict[str, int] = field(default_factory=dict)
    # One bad row (a malformed binding, a write error) must not abort a walk
    # of tens of thousands of rows. Counted here instead, same shape as
    # acts_stage.
    errors: int = 0
    # The pdf pass (source='fedlex_pdf'). pdf_discovered counts rows
    # actually written -- new or re-walked; pdf_skipped_has_xml counts the
    # desired no-op of upsert_pdf_version() finding an XML row already
    # covering the (consolidation, lang), which is not an error and not a
    # write, but is worth a number of its own rather than disappearing into
    # a silent zero. orphaned/skipped_language/errors above are shared with
    # the pdf pass -- same per-row guard, same meaning either way.
    pdf_discovered: int = 0
    pdf_skipped_has_xml: int = 0


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


# source='fedlex' on the INSERT branch is redundant with migration 201's
# column DEFAULT, but naming it here (rather than relying on the default)
# is what keeps the ON CONFLICT arm below honest about what it is
# reclaiming FROM.
#
# The ON CONFLICT arm resets stage/full_text/article_count with a CASE
# gated on the EXISTING row's source, not the new one -- an edition first
# discovered as pdf-a (source='fedlex_pdf') and already walked through
# fedlex-pdf-text to stage='parsed' with pdf full_text can later gain a
# real XML manifestation. Before this CASE existed, this upsert flipped
# xml_url to the XML file while leaving source='fedlex_pdf' and
# stage='parsed' untouched: db.claim_versions()'s source='fedlex_pdf' AND
# stage='discovered' filter would then never re-claim the row, so nothing
# would ever fetch or parse the XML, and the stale pdf full_text would go
# on being served as if it were that (silently unparsed) xml edition. The
# fix is a reclaim, not just a source flip: stage goes back to
# 'discovered' so the ordinary XML pipeline (fetch_xml_stage,
# parse_akn_stage) walks the row from the top, and full_text/article_count
# are cleared so no stale pdf-derived text can be read back before the XML
# pipeline has re-populated them. A re-walk of an already-XML row (source
# already 'fedlex' -- the ordinary case this stage exists for) must NOT
# reset a row parse_akn_stage has already finished, which is exactly what
# gating the CASE on the existing row's source guarantees.
_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, stage, source, updated_at)
SELECT a.act_id, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
       %(xml_url)s, 'discovered', 'fedlex', now()
  FROM ch_act a WHERE a.eli_work_uri = %(work)s
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = COALESCE(EXCLUDED.date_end_applicability,
                                      ch_act_version.date_end_applicability),
    xml_url                = COALESCE(EXCLUDED.xml_url, ch_act_version.xml_url),
    source                 = 'fedlex',
    stage                  = CASE WHEN ch_act_version.source = 'fedlex_pdf'
                                  THEN 'discovered' ELSE ch_act_version.stage END,
    full_text              = CASE WHEN ch_act_version.source = 'fedlex_pdf'
                                  THEN NULL ELSE ch_act_version.full_text END,
    article_count          = CASE WHEN ch_act_version.source = 'fedlex_pdf'
                                  THEN NULL ELSE ch_act_version.article_count END,
    updated_at             = now()
RETURNING version_id
"""


def upsert_version(conn, row: dict) -> int | None:
    """Returns the version_id, or None if the language is unmapped or the
    parent work has not been discovered yet (run the acts stage first)."""
    lang = fq.language_code(row.get("lang"))
    if not lang:
        return None
    params = {
        "work": row["work"],
        "consolidation": row["consolidation"],
        "lang": lang,
        "date_app": row["dateApplicability"][:10],
        "date_end": (row.get("dateEndApplicability") or "")[:10] or None,
        "xml_url": row.get("fileUrl"),
    }
    result = conn.execute(_UPSERT_VERSION, params).fetchone()
    if result is None:
        return None                     # the SELECT matched no act
    return result["version_id"] if isinstance(result, dict) else result[0]


# Same shape as _UPSERT_VERSION, with two differences that carry the whole
# "only where no XML edition exists" contract:
#   * the INSERT's WHERE carries a NOT EXISTS against any row for this
#     (consolidation, lang) whose source is not 'fedlex_pdf' -- i.e. an XML
#     row. That NOT EXISTS is what makes the insert a no-op (zero rows,
#     "the SELECT matched no act OR an XML row already exists" -- see
#     upsert_pdf_version() for how the two are told apart) rather than a
#     write that would then collide with the XML row's own unique index.
#   * the ON CONFLICT arm carries `WHERE ch_act_version.source = 'fedlex_pdf'`
#     so a conflicting row that turned out to be XML (which cannot actually
#     happen -- the NOT EXISTS above already excluded that case -- see the
#     task brief's own note) is never touched by this statement.
_UPSERT_PDF_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, stage, source, updated_at)
SELECT a.act_id, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
       %(file_url)s, 'discovered', 'fedlex_pdf', now()
  FROM ch_act a WHERE a.eli_work_uri = %(work)s
   AND NOT EXISTS (SELECT 1 FROM ch_act_version v
                    WHERE v.eli_consolidation_uri = %(consolidation)s
                      AND v.lang = %(lang)s AND v.source <> 'fedlex_pdf')
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = COALESCE(EXCLUDED.date_end_applicability,
                                      ch_act_version.date_end_applicability),
    xml_url                = COALESCE(EXCLUDED.xml_url, ch_act_version.xml_url),
    updated_at             = now()
  WHERE ch_act_version.source = 'fedlex_pdf'
RETURNING version_id
"""

_SELECT_XML_ROW_EXISTS = """
SELECT 1 FROM ch_act_version
 WHERE eli_consolidation_uri = %(consolidation)s AND lang = %(lang)s
   AND source <> 'fedlex_pdf'
"""


def upsert_pdf_version(conn, row: dict) -> str:
    """The pdf-a counterpart of upsert_version(): writes source='fedlex_pdf',
    stage='discovered' ONLY where no XML row already covers this
    (consolidation, lang), and never touches a non-pdf row.

    Returns one of:
      'upserted'         -- written, new row or a re-walk of an existing
                            pdf-a row (COALESCE semantics, same as
                            upsert_version()).
      'skipped_has_xml'  -- the desired no-op: an XML row already covers
                            this edition, so nothing was written. Not an
                            error.
      'orphaned'         -- the parent work is not in ch_act (run the acts
                            stage first, or Fedlex answered a VALUES batch
                            with a work outside it).

    _UPSERT_PDF_VERSION's INSERT ... SELECT returns no row for BOTH
    'skipped_has_xml' and 'orphaned' -- the NOT EXISTS clause and the
    act lookup can each independently produce zero rows, and psycopg
    cannot tell which one fired from the empty result alone. One cheap
    SELECT after the fact (_SELECT_XML_ROW_EXISTS) distinguishes them:
    it checks whether an XML row already covers this (consolidation, lang)
    first -- if one does, that alone explains the empty insert
    ('skipped_has_xml'); only when no XML row exists either is the empty
    insert attributed to the work being missing from ch_act
    ('orphaned'), the same condition upsert_version() reports as None.
    """
    lang = fq.language_code(row.get("lang"))
    params = {
        "work": row["work"],
        "consolidation": row["consolidation"],
        "lang": lang,
        "date_app": row["dateApplicability"][:10],
        "date_end": (row.get("dateEndApplicability") or "")[:10] or None,
        "file_url": row.get("fileUrl"),
    }
    result = conn.execute(_UPSERT_PDF_VERSION, params).fetchone()
    if result is not None:
        return "upserted"
    # No row written. Either the work is not in ch_act, or an XML row
    # already covers this edition -- tell them apart with one cheap check.
    xml_exists = conn.execute(_SELECT_XML_ROW_EXISTS, params).fetchone()
    if xml_exists is not None:
        return "skipped_has_xml"
    return "orphaned"


_SELECT_WORKS = "SELECT eli_work_uri FROM ch_act ORDER BY eli_work_uri"


def work_uris(conn) -> list[str]:
    """The driving set: every work the acts stage has discovered.

    Ordered so a run is reproducible and so an interrupted run's batches line
    up with the next one's. 17,293 URIs is about 1.5 MB -- small enough to
    hold, and holding it keeps the cursor from being open across the whole
    walk.
    """
    # An explicit row factory: db.connect() hands out dict rows, the tests'
    # own fixture hands out tuples, and this must read the same either way.
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_SELECT_WORKS)
        return [r[0] for r in cur.fetchall()]


def run(settings: Settings,
        batch_size: int = fq.WORK_BATCH_SIZE) -> VersionsReport:
    """Walk the editions of every work in ch_act, a batch of works at a time.

    Run the acts stage first: an empty ch_act means an empty driving set, and
    this issues no queries at all rather than walking the graph blind.

    Restartable and idempotent rather than resumable -- an interrupted run
    starts again from the first work in ch_act and redoes the whole pass. See
    the module docstring for why that is the intended behaviour.
    """
    report = VersionsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        works = work_uris(conn)
        log.info("versions: driving from %d works in ch_act", len(works))
        for row in client.batched(fq.VERSIONS, works, batch_size=batch_size):
            # A single malformed row (or a write error on it) must not abort
            # a walk of tens of thousands of rows -- log it, count it, move
            # on. Follows
            # the same shape as acts_stage.run()'s per-row guard.
            try:
                lang = fq.language_code(row.get("lang"))
                if not lang:
                    report.skipped_language += 1
                    _sample(report.skipped_langs, row.get("lang") or "<missing>")
                    continue
                version_id = upsert_version(conn, row)
            except Exception as exc:                      # noqa: BLE001
                log.error("versions: %s: %s",
                          row.get("consolidation") or row.get("work"), exc)
                report.errors += 1
                continue

            if version_id is None:
                report.orphaned += 1
                _sample(report.orphaned_works, row.get("work") or "<unknown>")
                continue

            report.discovered += 1
            report.by_lang[lang] = report.by_lang.get(lang, 0) + 1
            if report.discovered % 5000 == 0:
                log.info("versions discovered=%d orphaned=%d skipped_language=%d",
                          report.discovered, report.orphaned, report.skipped_language)

        # The pdf-a pass. Deliberately AFTER the xml pass above and over the
        # SAME works list: a consolidation with both manifestations must
        # land as XML, and upsert_pdf_version()'s NOT EXISTS clause only
        # gets that guarantee for free because every XML row this run will
        # ever write is already committed by the time this loop starts. Not
        # asserted -- just kept in this order, which is why it matters that
        # nothing above reorders these two loops.
        for row in client.batched(fq.VERSIONS_PDF, works, batch_size=batch_size):
            try:
                lang = fq.language_code(row.get("lang"))
                if not lang:
                    report.skipped_language += 1
                    _sample(report.skipped_langs, row.get("lang") or "<missing>")
                    continue
                outcome = upsert_pdf_version(conn, row)
            except Exception as exc:                      # noqa: BLE001
                log.error("versions(pdf): %s: %s",
                          row.get("consolidation") or row.get("work"), exc)
                report.errors += 1
                continue

            if outcome == "orphaned":
                report.orphaned += 1
                _sample(report.orphaned_works, row.get("work") or "<unknown>")
                continue
            if outcome == "skipped_has_xml":
                report.pdf_skipped_has_xml += 1
                continue

            report.pdf_discovered += 1
            report.by_lang[lang] = report.by_lang.get(lang, 0) + 1
            if report.pdf_discovered % 5000 == 0:
                log.info("versions(pdf) discovered=%d skipped_has_xml=%d",
                          report.pdf_discovered, report.pdf_skipped_has_xml)
    finally:
        conn.close()
        client.close()
    return report


def main() -> VersionsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 per spec section 8, same reasoning as acts: a network walk that
    nonetheless holds the GIL and a connection for the whole pass.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("discovered=%d orphaned=%d skipped_language=%d errors=%d by_lang=%s "
             "pdf_discovered=%d pdf_skipped_has_xml=%d",
             result.discovered, result.orphaned, result.skipped_language,
             result.errors, result.by_lang,
             result.pdf_discovered, result.pdf_skipped_has_xml)
    # A non-zero orphaned count after a full acts run is a silent-gap signal,
    # not a footnote -- surface it (and who it is) at warning level so it
    # cannot be missed in a scrolled-past log.
    if result.orphaned:
        log.warning("ORPHANED: %d version(s) reference a work ch_act does not "
                    "have -- the acts and versions queries disagree about what "
                    "exists. Sample of %d: %s", result.orphaned,
                    len(result.orphaned_works), ", ".join(result.orphaned_works))
    if result.skipped_language:
        log.warning("SKIPPED LANGUAGE: %d version(s) in a language "
                    "fedlex_queries.LANGUAGE_MAP does not cover. Sample: %s",
                    result.skipped_language, ", ".join(result.skipped_langs))
    return result


if __name__ == "__main__":
    main()
