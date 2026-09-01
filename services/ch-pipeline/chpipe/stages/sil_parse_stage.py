"""SIL page -> ch_act_article rows, plain text AND amendment provenance --
the SIL twin of cantonal_parse_stage. SIL pages carry no change-document
index, but the notes sil.parse_act resolves onto each article (GE's
modification-table rows, NE's footnote prose) name the amendments
themselves, and portal_amendments reads them: one ch_article_provenance
row per parsed event, the act's distinct source references (GE the
adoption date, NE the Feuille officielle issue) upserted as
ch_act_change_document rows.

Per claimed row (stage 'fetched', source 'sil'):
  1. sil.parse_act(page) -> articles, full text, page dates;
  2. fewer than MIN_TEXT_CHARS of text fails the row at once
     (max_attempts=1, 'short_text' in Gate F's failed_by_reason). A page
     with prose but no "Art." heading (a treaty in numbered paragraphs, a
     tariff that is one table) is stored as PARSED with article_count=0 --
     the PDF path's long-standing rule, adopted here 2026-08-31 after the
     F3/K9 audit found 27 in-force GE/NE acts "missing" that the source
     publishes exactly so; Gate F counts them as empty_articles;
  3. parse_akn_stage.store_articles() -- the same replace-not-upsert write,
     in one transaction -- then complete_version(-> 'parsed', full_text).
  3b. portal_amendments.events_of() over the parsed articles' notes ->
     store(): the version's provenance rows replaced and the act's change
     documents upserted, in the same transaction as the articles.
  4. When sil_acts_stage had to date the version with the run date
     (ch_act.metadata_json.sil_date_source = 'run') and the page prints
     an 'Etat au' / 'Dernières modifications au' date, date_applicability
     becomes that date and the source 'page'. eli_consolidation_uri keeps
     the discovery date: it is an identifier, not a claim.

CHPIPE_REPROVENANCE=1 is the offline backfill (the CHPIPE_RESPLIT pattern):
no download, no claim -- it walks the rows already at 'parsed', re-parses
the STORED page and rewrites only the provenance rows and change documents,
leaving articles, full_text and dates exactly as they are. That is how the
history of the editions parsed before this stage learned to write
provenance is recovered without refetching a single page.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from psycopg.rows import dict_row

from .. import db, portal_amendments, sil, throttle
from ..config import Settings
from . import parse_akn_stage, sil_fetch_stage

log = logging.getLogger(__name__)

MIN_TEXT_CHARS = 200


@dataclass
class SilParseReport:
    parsed: int = 0
    articles: int = 0
    failed: int = 0
    short_text: int = 0
    no_articles: int = 0
    dates_from_page: int = 0
    provenance_rows: int = 0
    provenance_linked: int = 0
    change_documents: int = 0
    # (act_id, lang) of every edition promoted to 'parsed', what the nightly
    # delta narrows diff and project-legacy on (cantonal_parse_stage's shape)
    acts: set[tuple[int, str]] = field(default_factory=set)


_LOAD = ("SELECT v.akn_xml, a.metadata_json, a.jurisdiction "
         "FROM ch_act_version v JOIN ch_act a USING (act_id) "
         "WHERE v.version_id = %s")


def _refine_date(conn, row: dict, metadata: dict | None, parsed: sil.ParsedAct) -> bool:
    if (metadata or {}).get("sil_date_source") != "run" or not parsed.meta.get("date_state"):
        return False
    conn.execute("UPDATE ch_act_version SET date_applicability = %s WHERE version_id = %s",
                 (parsed.meta["date_state"], row["version_id"]))
    conn.execute("UPDATE ch_act SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || "
                 "jsonb_build_object('sil_date_source', 'page') WHERE act_id = %s",
                 (row["act_id"],))
    return True


def run(settings: Settings, canton_code: str | None = None,
        limit: int | None = None) -> SilParseReport:
    report = SilParseReport()
    prefix = sil_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "sil-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="sil", url_prefix=prefix)
            if not rows:
                break
            for row in rows:
                try:
                    with conn.cursor(row_factory=dict_row) as cur:
                        cur.execute(_LOAD, (row["version_id"],))
                        loaded = cur.fetchone()
                    if not loaded or not loaded["akn_xml"]:
                        db.fail_version(conn, row["version_id"], "no payload", settings.max_attempts)
                        report.failed += 1
                        continue
                    parsed = sil.parse_act(loaded["akn_xml"])
                    # Reasons are fixed strings: Gate F groups failures on
                    # their first 60 characters, and a count inside the
                    # string would make every failure its own bucket.
                    if len(parsed.text) < MIN_TEXT_CHARS:
                        log.warning("version %s: %d chars of text", row["version_id"], len(parsed.text))
                        db.fail_version(conn, row["version_id"],
                                        f"short_text: under {MIN_TEXT_CHARS} chars", max_attempts=1)
                        report.short_text += 1
                        report.failed += 1
                        continue
                    if not parsed.articles:
                        # real prose, no Art. heading: parsed, searchable
                        # text, zero article rows (the PDF path's rule)
                        log.info("version %s: %d chars of prose, no Art. heading",
                                 row["version_id"], len(parsed.text))
                        with conn.transaction():
                            # replace-with-nothing sets article_count = 0
                            parse_akn_stage.store_articles(conn, row["version_id"], [])
                            if _refine_date(conn, row, loaded["metadata_json"], parsed):
                                report.dates_from_page += 1
                        db.complete_version(conn, row["version_id"], "parsed",
                                            full_text=parsed.text)
                        report.no_articles += 1
                        report.parsed += 1
                        report.acts.add((row["act_id"], row["lang"]))
                        continue
                    note_events = portal_amendments.events_of(
                        loaded["jurisdiction"], parsed.articles)
                    with conn.transaction():
                        parse_akn_stage.store_articles(conn, row["version_id"], parsed.articles)
                        stored = portal_amendments.store(
                            conn, row["version_id"], row["act_id"],
                            loaded["jurisdiction"], note_events, platform="sil")
                        if _refine_date(conn, row, loaded["metadata_json"], parsed):
                            report.dates_from_page += 1
                    db.complete_version(conn, row["version_id"], "parsed", full_text=parsed.text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: %s", row["version_id"], exc)
                    try:
                        db.fail_version(conn, row["version_id"], f"{exc}", settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("version %s: also failed recording the failure: %s",
                                  row["version_id"], fail_exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.acts.add((row["act_id"], row["lang"]))
                report.articles += len(parsed.articles)
                report.provenance_rows += stored.rows
                report.provenance_linked += stored.linked
                report.change_documents += stored.documents
            if remaining is not None:
                remaining -= len(rows)
            log.info("sil parsed=%d articles=%d failed=%d short_text=%d no_articles=%d "
                     "dates_from_page=%d provenance=%d (linked=%d) documents=%d",
                     report.parsed, report.articles, report.failed,
                     report.short_text, report.no_articles, report.dates_from_page,
                     report.provenance_rows, report.provenance_linked,
                     report.change_documents)
    finally:
        conn.close()
    return report


# Keyset pagination, the CHPIPE_RESPLIT pattern (fedlex_pdf_text_stage):
# the pages are ~30 KB each and re-read from TOAST batch by batch.
_REPROVENANCE_ROWS = (
    "SELECT v.version_id, v.act_id, v.akn_xml, a.jurisdiction "
    "FROM ch_act_version v JOIN ch_act a USING (act_id) "
    "WHERE v.source = 'sil' AND v.stage = 'parsed' AND v.akn_xml IS NOT NULL "
    "AND (%(prefix)s::text IS NULL OR v.xml_url LIKE %(prefix)s || '%%') "
    "AND v.version_id > %(last)s ORDER BY v.version_id LIMIT %(size)s")

REPROVENANCE_BATCH = 100


def run_reprovenance(settings: Settings, canton_code: str | None = None,
                     limit: int | None = None) -> SilParseReport:
    """CHPIPE_REPROVENANCE=1: provenance rows and change documents for the
    editions already at 'parsed', from their stored pages alone -- no
    download, no claim, no article or date rewrite. Idempotent: store()
    replaces the version's rows and the document upsert keys on the stable
    reference hash, so a rerun converges instead of duplicating."""
    report = SilParseReport()
    prefix = sil_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    last_id = 0
    remaining = limit
    try:
        while True:
            size = REPROVENANCE_BATCH if remaining is None else min(REPROVENANCE_BATCH, remaining)
            if size <= 0:
                break
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(_REPROVENANCE_ROWS,
                            {"prefix": prefix, "last": last_id, "size": size})
                rows = cur.fetchall()
            if not rows:
                break
            for row in rows:
                last_id = row["version_id"]
                try:
                    parsed = sil.parse_act(row["akn_xml"])
                    note_events = portal_amendments.events_of(
                        row["jurisdiction"], parsed.articles)
                    with conn.transaction():
                        stored = portal_amendments.store(
                            conn, row["version_id"], row["act_id"],
                            row["jurisdiction"], note_events, platform="sil")
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: reprovenance failed: %s", row["version_id"], exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.provenance_rows += stored.rows
                report.provenance_linked += stored.linked
                report.change_documents += stored.documents
            if remaining is not None:
                remaining -= len(rows)
            log.info("sil reprovenance parsed=%d provenance=%d (linked=%d) documents=%d "
                     "failed=%d", report.parsed, report.provenance_rows,
                     report.provenance_linked, report.change_documents, report.failed)
    finally:
        conn.close()
    return report


def main() -> SilParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 19 + capacity wait: lxml over Word
    HTML is a CPU stage, small as this corpus is (~1.7K pages)."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    canton = os.environ.get("CHPIPE_CANTON") or None
    limit = int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None
    if os.environ.get("CHPIPE_REPROVENANCE") == "1":
        result = run_reprovenance(Settings.from_env(), canton_code=canton, limit=limit)
        log.info("reprovenance parsed=%d provenance=%d (linked=%d) documents=%d failed=%d",
                 result.parsed, result.provenance_rows, result.provenance_linked,
                 result.change_documents, result.failed)
        return result
    result = run(Settings.from_env(), canton_code=canton, limit=limit)
    log.info("parsed=%d articles=%d failed=%d short_text=%d no_articles=%d dates_from_page=%d "
             "provenance=%d (linked=%d) documents=%d",
             result.parsed, result.articles, result.failed, result.short_text,
             result.no_articles, result.dates_from_page, result.provenance_rows,
             result.provenance_linked, result.change_documents)
    return result


if __name__ == "__main__":
    main()
