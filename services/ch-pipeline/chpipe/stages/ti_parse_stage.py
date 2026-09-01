"""Ticino flat page -> ch_act_article rows, plain text AND amendment
provenance -- the TI twin of cantonal_parse_stage. The portal publishes no
change-document index, but its footnotes name each amendment ("Modifica
dell'art. 4 cpv. 1 approvata con votazione popolare del 25.9.2016 ... in
vigore dal 1.4.2018 - BU 2018, 81"), and portal_amendments reads them: one
ch_article_provenance row per parsed event, the act's distinct Bollettino
ufficiale references upserted as its ch_act_change_document rows.

Per claimed row (stage 'fetched', source 'ti_rl'):
  1. ti_rl.parse_act(page) -> articles, full_text, meta;
  2. parse_akn_stage.store_articles() -- the same replace-not-upsert
     write the federal and Lexwork sides use;
  2b. portal_amendments.events_of() over the articles' notes -> store():
     the version's provenance rows replaced and the act's change documents
     upserted, in the same transaction as the articles;
  3. the act's date_document / date_entry_force from the page header and
     footer, COALESCE'd onto ch_act (the list gives date_document already;
     "Entrata in vigore" only the page has);
  4. complete_version(-> 'parsed', full_text=...).

A page with fewer than 200 characters of text is retired at once
(max_attempts=1, 'short_text: ...'): retrying the same page tomorrow does
not grow it. A page with real prose but no 'Art. N' heading (an accession
decree, a tariff) is stored as PARSED with article_count=0 and its text in
full_text -- the policy the PDF path always had, adopted for the portal
parsers on 2026-08-31 after the F3/K9 audit found 12 in-force TI acts
"missing" that the source publishes exactly so; Gate F shows them as
empty_articles. A page the parser refuses outright (no content div) fails
with the parser's message and the normal retry budget, since the fetch
stage should not have stored it.

CHPIPE_REPROVENANCE=1 is the offline backfill (the CHPIPE_RESPLIT pattern):
no download, no claim -- it walks the rows already at 'parsed', re-parses
the STORED page and rewrites only the provenance rows and change documents,
leaving articles, full_text and dates exactly as they are.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from .. import db, portal_amendments, throttle, ti_rl
from ..config import Settings
from . import parse_akn_stage

log = logging.getLogger(__name__)

MIN_TEXT_CHARS = 200


@dataclass
class TiParseReport:
    parsed: int = 0
    articles: int = 0
    failed: int = 0
    no_articles: int = 0
    short_text: int = 0
    provenance_rows: int = 0
    provenance_linked: int = 0
    change_documents: int = 0
    # (act_id, lang) of every edition promoted to 'parsed' -- what the
    # nightly delta narrows diff and project-legacy on.
    acts: set[tuple[int, str]] = field(default_factory=set)


_ACT_DATES = ("UPDATE ch_act SET date_document = COALESCE(date_document, %s), "
              "date_entry_force = COALESCE(date_entry_force, %s), updated_at = now() "
              "WHERE act_id = %s")


def run(settings: Settings, limit: int | None = None) -> TiParseReport:
    report = TiParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "ti-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="ti_rl")
            if not rows:
                break
            for row in rows:
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no page stored",
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    try:
                        articles, text, meta = ti_rl.parse_act(stored)
                    except ti_rl.TiParseError as exc:
                        db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
                        report.failed += 1
                        continue
                    if len(text) < MIN_TEXT_CHARS:
                        db.fail_version(conn, row["version_id"],
                                        f"short_text: {len(text)} chars, {len(articles)} article(s)",
                                        max_attempts=1)
                        report.short_text += 1
                        continue
                    if not articles:
                        # real prose, no Art. heading: parsed, searchable text,
                        # zero article rows (the PDF path's rule);
                        # store_articles([]) sets article_count = 0
                        with conn.transaction():
                            parse_akn_stage.store_articles(conn, row["version_id"], [])
                        db.complete_version(conn, row["version_id"], "parsed", full_text=text)
                        report.no_articles += 1
                        report.parsed += 1
                        report.acts.add((row["act_id"], row["lang"]))
                        continue
                    note_events = portal_amendments.events_of("TI", articles)
                    with conn.transaction():
                        parse_akn_stage.store_articles(conn, row["version_id"], articles)
                        stored = portal_amendments.store(
                            conn, row["version_id"], row["act_id"], "TI",
                            note_events, platform="ti_rl")
                        conn.execute(_ACT_DATES, (meta.get("date_document"),
                                                  meta.get("date_entry_force"), row["act_id"]))
                    db.complete_version(conn, row["version_id"], "parsed", full_text=text)
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
                report.articles += len(articles)
                report.provenance_rows += stored.rows
                report.provenance_linked += stored.linked
                report.change_documents += stored.documents
            if remaining is not None:
                remaining -= len(rows)
            log.info("TI parsed=%d articles=%d failed=%d no_articles=%d short_text=%d "
                     "provenance=%d (linked=%d) documents=%d",
                     report.parsed, report.articles, report.failed, report.no_articles,
                     report.short_text, report.provenance_rows, report.provenance_linked,
                     report.change_documents)
    finally:
        conn.close()
    return report


# Keyset pagination, the CHPIPE_RESPLIT pattern (fedlex_pdf_text_stage).
_REPROVENANCE_ROWS = (
    "SELECT version_id, act_id, akn_xml FROM ch_act_version "
    "WHERE source = 'ti_rl' AND stage = 'parsed' AND akn_xml IS NOT NULL "
    "AND version_id > %s ORDER BY version_id LIMIT %s")

REPROVENANCE_BATCH = 100


def run_reprovenance(settings: Settings, limit: int | None = None) -> TiParseReport:
    """CHPIPE_REPROVENANCE=1: provenance rows and change documents for the
    editions already at 'parsed', from their stored pages alone -- no
    download, no claim, no article or date rewrite. Idempotent the way
    portal_amendments.store() is: rows replaced per version, documents
    upserted on the stable reference hash."""
    report = TiParseReport()
    conn = db.connect(settings)
    last_id = 0
    remaining = limit
    try:
        while True:
            size = REPROVENANCE_BATCH if remaining is None else min(REPROVENANCE_BATCH, remaining)
            if size <= 0:
                break
            rows = conn.execute(_REPROVENANCE_ROWS, (last_id, size)).fetchall()
            if not rows:
                break
            for row in rows:
                last_id = row["version_id"]
                try:
                    articles, _, _ = ti_rl.parse_act(row["akn_xml"])
                    note_events = portal_amendments.events_of("TI", articles)
                    with conn.transaction():
                        stored = portal_amendments.store(
                            conn, row["version_id"], row["act_id"], "TI",
                            note_events, platform="ti_rl")
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
            log.info("TI reprovenance parsed=%d provenance=%d (linked=%d) documents=%d "
                     "failed=%d", report.parsed, report.provenance_rows,
                     report.provenance_linked, report.change_documents, report.failed)
    finally:
        conn.close()
    return report


def main() -> TiParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. NICE_CPU: a CPU stage (lxml over every
    paragraph of ~600 pages); the capacity wait is in run()."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    limit = int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None
    if os.environ.get("CHPIPE_REPROVENANCE") == "1":
        result = run_reprovenance(Settings.from_env(), limit=limit)
        log.info("reprovenance parsed=%d provenance=%d (linked=%d) documents=%d failed=%d",
                 result.parsed, result.provenance_rows, result.provenance_linked,
                 result.change_documents, result.failed)
        return result
    result = run(Settings.from_env(), limit=limit)
    log.info("parsed=%d articles=%d failed=%d no_articles=%d short_text=%d "
             "provenance=%d (linked=%d) documents=%d", result.parsed,
             result.articles, result.failed, result.no_articles, result.short_text,
             result.provenance_rows, result.provenance_linked, result.change_documents)
    if result.no_articles or result.short_text:
        log.warning("RETIRED: %d page(s) with no article and %d with under %d chars; "
                    "reasons in last_error, retry after fixing ti_rl.py",
                    result.no_articles, result.short_text, MIN_TEXT_CHARS)
    return result


if __name__ == "__main__":
    main()
