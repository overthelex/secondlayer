"""Recompute ch_article_provenance.change_document_id for one canton's
editions from what the rows already hold -- no refetch, no reparse.

Why a stage of its own: cantonal_parse_stage now links through change_refs
at parse time, but the 993,939 rows parsed before it did are only
re-parsed when the host publishes a new edition of their act. This walks
them once. A row carries everything the matcher needs -- raw_note (the
source cell is fields 5+), source_act_date (the table's decision date),
effective_date -- so akn_xml, the 367 KB average payload, is never read.
Measured 2026-08-26: raw_note has five fields on exactly the rows where
as_reference is set (BL 85,545 of 85,562, LU 65,992 of 65,993, ZG 52,865
of 52,865, OW 28,849 of 28,849, BS 28,860 of 66,521, TG 0, AR 0), so the
column is sufficient.

Per act of the canton: the act's documents once (candidates), then per
edition (source 'lexwork') its rows, the matcher, one UPDATE per edition
for the rows that gained a link -- never a canton-wide UPDATE (~1.5M rows
across the 19 cantons, and ch_article_provenance carries a partial index
on the column). A row that is already linked is left as it is and
counted (already_linked): the host's history map, when it exists, is
more authoritative than a text match, and that is also what makes a
second run a no-op. CHPIPE_RELINK_FORCE=1 recomputes those too. After
each act, date_decision is backfilled on its documents from the rows now
linked (cantonal_parse_stage.backfill_decision_dates).

Reports linked, already_linked and unlinked by change_refs' reason, so
a canton's remaining NULLs are explained, not just counted: BL's 680
"window_none" rows on the sample are pre-2014 references into a paper
collection the host has no document for; AR's are all no_candidates
(the host publishes none).
"""
from __future__ import annotations

import logging
import os
from collections import Counter
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import cantons, change_refs, db, throttle
from ..config import Settings
from . import cantonal_parse_stage

log = logging.getLogger(__name__)

_LINKED_REASONS = frozenset({"number", "date", "window"})

_ACTS = "SELECT act_id FROM ch_act WHERE jurisdiction = %s ORDER BY act_id"
_VERSIONS = ("SELECT version_id FROM ch_act_version WHERE act_id = %s AND source = 'lexwork' "
             "ORDER BY version_id")
_ROWS = ("SELECT provenance_id, raw_note, source_act_date, effective_date, change_document_id "
         "FROM ch_article_provenance WHERE version_id = %s ORDER BY provenance_id")
_UPDATE = "UPDATE ch_article_provenance SET change_document_id = %s WHERE provenance_id = %s"


@dataclass
class RelinkReport:
    cantons: list[str] = field(default_factory=list)
    acts: int = 0
    versions: int = 0
    rows: int = 0
    linked: int = 0
    already_linked: int = 0
    unlinked: int = 0
    by_reason: Counter = field(default_factory=Counter)
    decision_dates_filled: int = 0


def relink_version(conn, version_id: int, context: cantonal_parse_stage.ActContext,
                   report: RelinkReport, force: bool = False) -> None:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_ROWS, (version_id,))
        rows = cur.fetchall()
    updates: list[tuple[int, int]] = []
    for provenance_id, raw_note, decision, effective, current in rows:
        report.rows += 1
        if current is not None and not force:
            report.already_linked += 1
            continue
        match = change_refs.match_change_document(
            context.jurisdiction, change_refs.references_of(raw_note),
            decision, effective, context.candidates)
        report.by_reason[match.reason] += 1
        if match.change_document_id is None:
            report.unlinked += 1
            if current is not None:      # force: a link the matcher cannot confirm is dropped
                updates.append((None, provenance_id))
            continue
        report.linked += 1
        if match.change_document_id != current:
            updates.append((match.change_document_id, provenance_id))
    if updates:
        with conn.transaction(), conn.cursor() as cur:
            cur.executemany(_UPDATE, updates)


def relink_act(conn, act_id: int, report: RelinkReport, force: bool = False,
               remaining: int | None = None) -> int:
    """All editions of one act. Returns the number of editions walked."""
    context = cantonal_parse_stage.act_context(conn, act_id)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_VERSIONS, (act_id,))
        version_ids = [r[0] for r in cur.fetchall()]
    if remaining is not None:
        version_ids = version_ids[:remaining]
    for version_id in version_ids:
        relink_version(conn, version_id, context, report, force)
    report.versions += len(version_ids)
    report.decision_dates_filled += cantonal_parse_stage.backfill_decision_dates(conn, version_ids)
    return len(version_ids)


def run(settings: Settings, canton_code: str | None = None, limit: int | None = None,
        force: bool = False) -> RelinkReport:
    codes = cantons.lexwork_codes(canton_code)
    report = RelinkReport(cantons=list(codes))
    remaining = limit
    conn = db.connect(settings)
    try:
        for code in codes:
            with conn.cursor(row_factory=tuple_row) as cur:
                cur.execute(_ACTS, (code,))
                act_ids = [r[0] for r in cur.fetchall()]
            for index, act_id in enumerate(act_ids):
                if remaining is not None and remaining <= 0:
                    return report
                if index % 50 == 0:
                    throttle.wait_for_capacity(settings.load_ceiling, "cantonal-relink")
                walked = relink_act(conn, act_id, report, force, remaining)
                report.acts += 1
                if remaining is not None:
                    remaining -= walked
                if report.acts % 100 == 0:
                    log.info("%s acts=%d versions=%d rows=%d linked=%d already=%d unlinked=%d",
                             code, report.acts, report.versions, report.rows, report.linked,
                             report.already_linked, report.unlinked)
    finally:
        conn.close()
    return report


def main() -> RelinkReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a DB walk, one connection."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 force=os.environ.get("CHPIPE_RELINK_FORCE") == "1")
    log.info("cantons=%s acts=%d versions=%d rows=%d linked=%d already_linked=%d unlinked=%d "
             "decision_dates_filled=%d by_reason=%s",
             ",".join(result.cantons), result.acts, result.versions, result.rows, result.linked,
             result.already_linked, result.unlinked, result.decision_dates_filled,
             dict(result.by_reason.most_common()))
    return result


if __name__ == "__main__":
    main()
