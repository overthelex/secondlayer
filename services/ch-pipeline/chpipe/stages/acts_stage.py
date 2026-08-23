"""Discovery of Systematic Compilation works into ch_act.

17,293 works as of 2026-08-23, of which 5,087 are in force. The previous
importer found only 1,901 of them for two independent reasons, both fixed by
the query set this stage consumes (chpipe/fedlex_queries.py):

  * it ran with MAX_ACTS=200 and no paging, so it simply stopped after the
    first 200 works instead of walking all 17,293;
  * it derived the SR number from the ELI path instead of reading the
    graph's own id-systematique notation, so a real number like "SR 220"
    came out as an unfindable path fragment ("1971/1069_1068_1068").

Two further properties of the source data shape this module:

  * ~4,296 works publish no jolux:inForceStatus at all. Their
    enforcement_status is stored as SQL NULL, never as False -- "unknown"
    and "not in force" are different claims, and only Fedlex gets to make
    the second one.
  * Twelve works assert BOTH inForceStatus 0 (in force) and 3 (no longer in
    force) for the very same work -- verified twice against the live graph.
    upsert_act() keys on eli_work_uri, so a naive upsert would let the
    second row silently overwrite the first with an arbitrary winner. This
    module refuses to pick one: when a work's newly observed status
    contradicts a status already stored for it, enforcement_status is left
    NULL and both observed codes are recorded under metadata_json's
    "status_conflict" key, so the row visibly explains why it is unknown
    instead of looking like one of the ~4,296 works with no status
    published at all.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from psycopg.rows import dict_row

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)

_TITLE_COLUMN = {"de": "title_de", "fr": "title_fr", "it": "title_it",
                 "en": "title_en", "rm": "title_rm"}


@dataclass
class ActsReport:
    discovered: int = 0
    with_sr: int = 0
    in_force: int = 0
    titled: int = 0
    # A title batch for works apply_titles never matched returns a rowcount
    # of 0 and looks like success unless this is reported separately -- a
    # mismatch between the ACTS and TITLES query sets must be visible, not
    # silent.
    unmatched_titles: int = 0
    # The twelve (as of 2026-08-23) works with contradictory statuses. A
    # count alone is a statistic a human cannot check; the URIs are a list
    # they can.
    conflicts: int = 0
    conflicting_works: list[str] = field(default_factory=list)
    # One bad row (a malformed binding, a write error) must not abort a walk
    # of 17,293 works. Counted here instead.
    errors: int = 0


_SELECT_EXISTING = """
SELECT enforcement_status, metadata_json FROM ch_act WHERE eli_work_uri = %s
"""

_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, sr_number, date_document, date_entry_force,
                    date_no_longer_in_force, enforcement_status, metadata_json,
                    stage, updated_at)
VALUES (%(work)s, %(sr)s, %(date_document)s, %(date_entry_force)s,
        %(date_no_longer)s, %(status)s, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    sr_number               = COALESCE(EXCLUDED.sr_number, ch_act.sr_number),
    date_document           = COALESCE(EXCLUDED.date_document, ch_act.date_document),
    date_entry_force        = COALESCE(EXCLUDED.date_entry_force, ch_act.date_entry_force),
    date_no_longer_in_force = COALESCE(EXCLUDED.date_no_longer_in_force,
                                       ch_act.date_no_longer_in_force),
    enforcement_status      = EXCLUDED.enforcement_status,
    metadata_json           = EXCLUDED.metadata_json,
    updated_at              = now()
RETURNING act_id
"""


def _date(value: str | None) -> str | None:
    return value[:10] if value else None


def _resolve_status(row: dict, existing: dict | None, metadata: dict) -> int | None:
    """Decide the enforcement_status to store, and annotate `metadata` in
    place with a conflict record when the graph asserts two different
    values for the same work.

    Fedlex's own SPARQL results are the source of the contradiction, not
    this pipeline: twelve works assert inForceStatus 0 and 3 at once (see
    fedlex_queries.ACTS's comment). Picking one would assert something
    Fedlex itself does not. NULL -- "unknown" -- is the only honest value,
    and every distinct code ever observed for the work goes into
    metadata_json so the row explains itself instead of looking like one of
    the ~4,296 works that simply have no status published.

    Works across repeated calls (the two rows for a conflicted work arrive
    one after another within a single ACTS walk) and across re-runs (a
    work already flagged stays flagged, even if this call only reintroduces
    a status already in the recorded conflict).
    """
    new_status = fq.status_code(row.get("inForce"))
    prior_status = existing["enforcement_status"] if existing else None
    prior_metadata = (existing.get("metadata_json") or {}) if existing else {}
    prior_conflict = prior_metadata.get("status_conflict")

    observed: set[int] = set()
    if prior_status is not None:
        observed.add(prior_status)
    if isinstance(prior_conflict, list):
        observed.update(v for v in prior_conflict if isinstance(v, int))
    if new_status is not None:
        observed.add(new_status)

    if len(observed) > 1:
        metadata["status_conflict"] = sorted(observed)
        return None
    return next(iter(observed)) if observed else None


def upsert_act(conn, row: dict) -> int:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_SELECT_EXISTING, (row["work"],))
        existing = cur.fetchone()

    metadata = {k: v for k, v in row.items() if k != "work"}
    status = _resolve_status(row, existing, metadata)

    params = {
        "work": row["work"],
        "sr": row.get("srNotation"),
        "date_document": _date(row.get("dateDocument")),
        "date_entry_force": _date(row.get("dateEntryForce")),
        "date_no_longer": _date(row.get("dateNoLongerInForce")),
        # NULL, not False: a work with no published status is unknown, not
        # repealed; a work with contradictory statuses is unknown too.
        "status": status,
        "metadata": json.dumps(metadata, ensure_ascii=False),
    }
    result = conn.execute(_UPSERT_ACT, params).fetchone()
    return result["act_id"] if isinstance(result, dict) else result[0]


def apply_titles(conn, rows: list[dict]) -> int:
    """Write titles onto already-discovered acts. Returns rows affected.

    One bad row (an unmapped language, a write error) must not lose the
    rest of the batch, so each row is guarded individually.
    """
    affected = 0
    for row in rows:
        lang = fq.language_code(row.get("lang"))
        column = _TITLE_COLUMN.get(lang or "")
        if not column:
            # Languages the schema has no first-class column for (anything
            # outside DEU/FRA/ITA/ENG/ROH) are skipped, not fatal.
            continue
        try:
            assignments = [f"{column} = %s"]
            params: list = [row.get("title")]
            # The German abbreviation is the canonical one ("OR" for SR 220).
            if lang == "de" and row.get("titleShort"):
                assignments.append("abbreviation = %s")
                params.append(row["titleShort"])
            params.append(row["work"])
            affected += conn.execute(
                f"UPDATE ch_act SET {', '.join(assignments)}, updated_at = now() "
                f"WHERE eli_work_uri = %s", params).rowcount
        except Exception as exc:                        # noqa: BLE001
            log.error("apply_titles: %s (%s): %s", row.get("work"), lang, exc)
            continue
    return affected


def run(settings: Settings, page_size: int = 5000) -> ActsReport:
    report = ActsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.ACTS, page_size=page_size):
            # A single malformed row (or a write error on it) must not
            # abort the walk of 17,293 works -- log it, count it, move on.
            try:
                upsert_act(conn, row)
            except Exception as exc:                     # noqa: BLE001
                log.error("acts: %s: %s", row.get("work"), exc)
                report.errors += 1
                continue
            report.discovered += 1
            if report.discovered % 2000 == 0:
                log.info("acts discovered=%d", report.discovered)

        batch: list[dict] = []
        attempted = 0

        def _flush() -> None:
            nonlocal batch, attempted
            if not batch:
                return
            attempted += len(batch)
            report.titled += apply_titles(conn, batch)
            batch = []
            log.info("titles applied=%d", report.titled)

        for row in client.paged(fq.TITLES, page_size=page_size):
            batch.append(row)
            if len(batch) >= 1000:
                _flush()
        _flush()
        report.unmatched_titles = attempted - report.titled

        # Authoritative counts and the conflict list come from the table
        # itself, not from accumulating over source rows: the twelve
        # conflicted works appear twice in the ACTS walk, which would
        # otherwise double their contribution to with_sr / in_force.
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT count(sr_number) AS n_with_sr, "
                "count(*) FILTER (WHERE in_force) AS n_in_force FROM ch_act")
            totals = cur.fetchone()
            report.with_sr = totals["n_with_sr"]
            report.in_force = totals["n_in_force"]
            cur.execute(
                "SELECT eli_work_uri FROM ch_act "
                "WHERE metadata_json -> 'status_conflict' IS NOT NULL "
                "ORDER BY eli_work_uri")
            report.conflicting_works = [r["eli_work_uri"] for r in cur.fetchall()]
        report.conflicts = len(report.conflicting_works)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("discovered=%d with_sr=%d in_force=%d titled=%d unmatched_titles=%d "
             "conflicts=%d errors=%d", result.discovered, result.with_sr,
             result.in_force, result.titled, result.unmatched_titles,
             result.conflicts, result.errors)
    if result.conflicting_works:
        log.info("conflicting works: %s", ", ".join(result.conflicting_works))
