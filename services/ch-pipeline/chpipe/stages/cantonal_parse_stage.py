"""Lexwork payload -> ch_act_article rows, plain text and source provenance
-- the cantonal twin of parse_akn_stage AND provenance_stage in one pass,
because one payload carries both the document tree and the modification
table, and reading it twice from TOAST for two stages buys nothing.

Per claimed row (stage 'fetched', source 'lexwork'):
  1. lexwork.parse_edition(payload, lang) -> articles + plain text. A
     language the payload does not carry fails the row with a counted
     reason (lang_not_in_payload): cantonal_acts_stage created the row from
     cantons.py's expectation, and the payload is the truth.
  2. parse_akn_stage.store_articles() -- the same replace-not-upsert write,
     inside the same transaction shape, that the federal side uses.
  3. lexwork.provenance() -> ch_article_provenance rows, each linked to its
     ch_act_change_document through history_information_map -> Lexwork
     change_documents[].id -> (act_id, source_id) when the host fills the
     map, and through change_refs (the source cell against the document's
     number or publication date) when it does not -- seven hosts ship an
     empty map on every edition (see change_refs). Full replacement per
     edition, like provenance_stage.store().
  3b. The documents just linked get date_decision from the rows that cite
     them: the change-document record has no decision date of its own
     (date_of_decision_string is "????" on every host; only BE and FR put
     it in the title), the modification table's "Beschluss" column is the
     same date, and on the 2026-08-26 sample every document's linked rows
     agreed on one date (1,152 of 1,152). A document whose rows disagree
     is left alone.
  4. complete_version(-> 'parsed', full_text=...).

Steps 2 and 3 are one transaction with the stage move outside it, exactly
as parse_akn_stage does: a crash between them cannot leave an edition at
'parsed' with half its rows.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import change_refs, db, lexwork, throttle
from ..config import Settings
from . import cantonal_fetch_stage, parse_akn_stage

log = logging.getLogger(__name__)


@dataclass
class ParseReport:
    parsed: int = 0
    articles: int = 0
    empty: int = 0
    # empty, split by lexwork.empty_reason(): annex_only / published_by_
    # reference / placeholder / unstructured_text. 235 editions on prod sat
    # at article_count 0 for two days as one opaque number before this was
    # measured (LEXAI-2019); the split is what tells an operator whether a
    # new zero is a host publishing pointers (fine) or a parser miss (not).
    empty_by_reason: dict[str, int] = field(default_factory=dict)
    failed: int = 0
    lang_not_in_payload: int = 0
    # A modification table whose header vocabulary lexwork.py does not know:
    # the version parsed fine but its amendment history was NOT read. Zero
    # is the only acceptable steady state; each host has its own words.
    tables_unrecognised: int = 0
    provenance_rows: int = 0
    provenance_linked: int = 0
    # The share of provenance_linked that came from change_refs rather
    # than the host's history map.
    provenance_matched: int = 0
    decision_dates_filled: int = 0
    # (act_id, lang) of every edition promoted to 'parsed' -- what the
    # nightly delta narrows diff and project-legacy on, same as
    # parse_akn_stage.ParseReport.acts.
    acts: set[tuple[int, str]] = field(default_factory=set)


_INSERT_PROVENANCE = (
    "INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, "
    "bbl_reference, effective_date, source_act_date, raw_note, anchor_level, "
    "container_articles, change_document_id) "
    "VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s)")

_CHANGE_DOCUMENTS = ("SELECT change_document_id, source_id, number, date_publication "
                     "FROM ch_act_change_document WHERE act_id = %s ORDER BY change_document_id")
_JURISDICTION = "SELECT jurisdiction FROM ch_act WHERE act_id = %s"

# date_decision from the rows that cite the document, when they all say the
# same date. Scoped to a set of versions so both the parse stage (the one
# edition it just wrote) and the relink stage (an act's editions) can use it.
_BACKFILL_DECISION_DATES = """
UPDATE ch_act_change_document d
   SET date_decision = s.date_decision, updated_at = now()
  FROM (SELECT change_document_id, min(source_act_date) AS date_decision
          FROM ch_article_provenance
         WHERE version_id = ANY(%s) AND change_document_id IS NOT NULL
               AND source_act_date IS NOT NULL
         GROUP BY change_document_id
        HAVING count(DISTINCT source_act_date) = 1) s
 WHERE d.change_document_id = s.change_document_id AND d.date_decision IS NULL
"""


@dataclass(frozen=True)
class ActContext:
    jurisdiction: str
    by_source_id: dict[int, int]
    candidates: list[change_refs.Candidate]


def act_context(conn, act_id: int) -> ActContext:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_JURISDICTION, (act_id,))
        row = cur.fetchone()
        jurisdiction = row[0] if row else ""
        cur.execute(_CHANGE_DOCUMENTS, (act_id,))
        docs = cur.fetchall()
    return ActContext(
        jurisdiction or "",
        {r[1]: r[0] for r in docs},
        [change_refs.Candidate(r[0], r[2], r[3]) for r in docs])


def change_document_ids(conn, act_id: int) -> dict[int, int]:
    return act_context(conn, act_id).by_source_id


def link(row: lexwork.Provenance, context: ActContext) -> tuple[int | None, str]:
    """(change_document_id, how): 'history' through the host's map,
    else change_refs' reason."""
    if row.change_document_source_id is not None:
        found = context.by_source_id.get(row.change_document_source_id)
        if found is not None:
            return found, "history"
    match = change_refs.match_change_document(
        context.jurisdiction, change_refs.references_of(row.raw_note),
        row.source_act_date, row.effective_date, context.candidates)
    return match.change_document_id, match.reason


def store_provenance(conn, version_id: int, rows: list[lexwork.Provenance],
                     context: ActContext) -> tuple[int, int, int]:
    """Replace this version's provenance rows. Returns (rows, linked,
    matched) where matched is the part of linked change_refs decided."""
    linked = matched = 0
    conn.execute("DELETE FROM ch_article_provenance WHERE version_id = %s", (version_id,))
    with conn.cursor() as cur:
        for row in rows:
            change_document_id, how = link(row, context)
            if change_document_id is not None:
                linked += 1
                matched += how != "history"
            cur.execute(_INSERT_PROVENANCE, (
                version_id, row.e_id, row.action, row.as_reference,
                row.effective_date, row.source_act_date, row.raw_note,
                row.anchor_level, row.container_articles, change_document_id))
    return len(rows), linked, matched


def backfill_decision_dates(conn, version_ids: list[int]) -> int:
    """Fill ch_act_change_document.date_decision from the provenance rows
    of these versions (see step 3b in the module docstring). Returns the
    number of documents filled."""
    if not version_ids:
        return 0
    return conn.execute(_BACKFILL_DECISION_DATES, (list(version_ids),)).rowcount


def _reasons(report: ParseReport) -> str:
    """' (annex_only=3 unstructured_text=1)' or '' -- the empty count's split,
    for the log line."""
    if not report.empty_by_reason:
        return ""
    return " (" + " ".join(f"{k}={v}" for k, v in sorted(report.empty_by_reason.items())) + ")"


def run(settings: Settings, canton_code: str | None = None,
        limit: int | None = None) -> ParseReport:
    report = ParseReport()
    prefix = cantonal_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "cantonal-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="lexwork", url_prefix=prefix)
            if not rows:
                break
            for row in rows:
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no payload",
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    payload = json.loads(stored)
                    try:
                        articles, text = lexwork.parse_edition(payload, row["lang"])
                    except lexwork.LexworkParseError as exc:
                        if "not in payload" in str(exc):
                            report.lang_not_in_payload += 1
                        db.fail_version(conn, row["version_id"], str(exc),
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    if lexwork.modification_table_status(payload, row["lang"]) == "unrecognised":
                        report.tables_unrecognised += 1
                        log.warning("version %s: modification table header not recognised; "
                                    "no provenance written", row["version_id"])
                    provenance = lexwork.provenance(payload, row["lang"], articles)
                    context = act_context(conn, row["act_id"])
                    with conn.transaction():
                        parse_akn_stage.store_articles(conn, row["version_id"], articles)
                        rows_written, linked, matched = store_provenance(
                            conn, row["version_id"], provenance, context)
                        filled = backfill_decision_dates(conn, [row["version_id"]])
                    db.complete_version(conn, row["version_id"], "parsed", full_text=text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: %s", row["version_id"], exc)
                    try:
                        db.fail_version(conn, row["version_id"], f"{exc}",
                                        settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("version %s: also failed recording the failure: %s",
                                  row["version_id"], fail_exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.acts.add((row["act_id"], row["lang"]))
                report.articles += len(articles)
                report.provenance_rows += rows_written
                report.provenance_linked += linked
                report.provenance_matched += matched
                report.decision_dates_filled += filled
                if not articles:
                    report.empty += 1
                    reason = lexwork.empty_reason(payload, row["lang"], text)
                    report.empty_by_reason[reason] = report.empty_by_reason.get(reason, 0) + 1
                    log.info("version %s: no articles (%s)", row["version_id"], reason)
            if remaining is not None:
                remaining -= len(rows)
            log.info("cantonal parsed=%d articles=%d empty=%d%s failed=%d "
                     "lang_not_in_payload=%d tables_unrecognised=%d provenance=%d linked=%d "
                     "(matched=%d) decision_dates_filled=%d",
                     report.parsed, report.articles, report.empty,
                     _reasons(report), report.failed,
                     report.lang_not_in_payload, report.tables_unrecognised,
                     report.provenance_rows, report.provenance_linked,
                     report.provenance_matched, report.decision_dates_filled)
    finally:
        conn.close()
    return report


def main() -> ParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a CPU stage (JSON + lxml.html
    over every paragraph of ~150K editions); the capacity wait is in run()."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d empty=%d%s failed=%d lang_not_in_payload=%d "
             "provenance=%d linked=%d (matched=%d) decision_dates_filled=%d",
             result.parsed, result.articles, result.empty, _reasons(result),
             result.failed, result.lang_not_in_payload, result.provenance_rows,
             result.provenance_linked, result.provenance_matched, result.decision_dates_filled)
    if result.tables_unrecognised:
        log.warning("TABLES UNRECOGNISED: %d version(s) parsed without provenance because "
                    "their modification table's headers are unknown to lexwork.py; look at "
                    "the host's vocabulary", result.tables_unrecognised)
    if result.lang_not_in_payload:
        log.warning("LANG NOT IN PAYLOAD: %d row(s) failed because the version does not "
                    "exist in the language cantons.py expects; check the canton's langs",
                    result.lang_not_in_payload)
    return result


if __name__ == "__main__":
    main()
