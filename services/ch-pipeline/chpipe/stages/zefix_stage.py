"""Fills ch_zefix_companies from LINDAS, municipality by municipality.

792,332 organisations across 2,111 municipality partitions (measured
2026-08-26; see chpipe/zefix.py for every query, every predicate and the
measurements behind them). One query per municipality plus keyset pages
inside the ten or so that hold more than 5,000 organisations -- never a
query per organisation, which at LINDAS's per-query floor of ~90 ms would
be twenty hours.

Three properties of the source shape this stage:

  * The partition list comes from the ORGANISATIONS, not from the
    Municipality class. One municipality organisations reference
    (municipality/700, 5 organisations) is not a Municipality contained in a
    canton at all, so a walk driven by the class loses those five companies
    while doing 56% more queries.
  * A company's canton is its own schema:addressRegion, so it is right even
    for those five.
  * The legal-form labels are read from the graph, never guessed. See
    chpipe/zefix.py for the two labels a hand-written map had wrong.

Resume: every municipality finished writes a ch_zefix_progress row for the
run_date, and a municipality that already has one is skipped. An interrupted
run therefore continues where it stopped when it is started again the same
day, and starts over the next day.

Inactivation: a company that has left the active Zefix set is not deleted --
its SHAB history still points at it -- it is marked 'inactive'. That sweep
asserts something about the WHOLE table, so it runs only after every
partition has a progress row for this run_date, and never at all for a run
restricted to some municipalities. Its cutoff is the START OF run_date, not
this process's start time: a run resumed by a second invocation would
otherwise strike off everything the first invocation had just confirmed.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
from dataclasses import dataclass

from .. import db, throttle, zefix
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)


@dataclass
class ZefixReport:
    municipalities: int = 0
    companies_seen: int = 0
    upserted: int = 0
    inactivated: int = 0
    # An organisation whose rows carry no UID cannot be keyed and is not
    # written. Silence would make that indistinguishable from success.
    skipped: int = 0
    # True when the magnitude guard refused the inactivation sweep -- see
    # _sweep(). Not an error: the walk's rows are written either way.
    sweep_skipped: bool = False


_UPSERT_MUNICIPALITY = """
INSERT INTO ch_zefix_municipality (id, name, canton, iri)
VALUES (%(id)s, %(name)s, %(canton)s, %(iri)s)
ON CONFLICT (id) DO UPDATE SET
    name   = COALESCE(EXCLUDED.name, ch_zefix_municipality.name),
    canton = COALESCE(EXCLUDED.canton, ch_zefix_municipality.canton),
    iri    = EXCLUDED.iri
"""

# COALESCE on the columns LINDAS does not publish: register_office, capital
# and shab_pub_date come from the SHAB stages, and a nightly zefix run must
# not blank them. The columns this stage owns are overwritten outright --
# a company that loses its address in the register should lose it here too.
_UPSERT_COMPANY = """
INSERT INTO ch_zefix_companies (
    uid, name, legal_form, legal_form_code, legal_seat, status, purpose,
    address, canton, chid, ehraid, municipality_id, source_iri, seen_at,
    metadata_json, updated_at)
VALUES (
    %(uid)s, %(name)s, %(legal_form)s, %(legal_form_code)s, %(legal_seat)s,
    %(status)s, %(purpose)s, %(address)s, %(canton)s, %(chid)s, %(ehraid)s,
    %(municipality_id)s, %(source_iri)s, %(seen_at)s, %(metadata)s, now())
ON CONFLICT (uid) DO UPDATE SET
    name            = EXCLUDED.name,
    legal_form      = EXCLUDED.legal_form,
    legal_form_code = EXCLUDED.legal_form_code,
    legal_seat      = EXCLUDED.legal_seat,
    status          = EXCLUDED.status,
    purpose         = EXCLUDED.purpose,
    address         = EXCLUDED.address,
    canton          = EXCLUDED.canton,
    chid            = EXCLUDED.chid,
    ehraid          = EXCLUDED.ehraid,
    municipality_id = EXCLUDED.municipality_id,
    source_iri      = EXCLUDED.source_iri,
    seen_at         = EXCLUDED.seen_at,
    metadata_json   = EXCLUDED.metadata_json,
    updated_at      = now()
"""

_MARK_DONE = """
INSERT INTO ch_zefix_progress (run_date, municipality_id, companies, done_at)
VALUES (%s, %s, %s, now())
ON CONFLICT (run_date, municipality_id) DO UPDATE SET
    companies = EXCLUDED.companies, done_at = now()
"""

_DONE_TODAY = "SELECT municipality_id FROM ch_zefix_progress WHERE run_date = %s"

# seen_at IS NULL is included deliberately: it means a row this walk has
# never confirmed -- migration 129's own importer wrote some, and a company
# that has been gone since before this stage first ran would otherwise stay
# 'active' forever with nothing ever re-examining it.
_INACTIVATE = """
UPDATE ch_zefix_companies SET status = 'inactive', updated_at = now()
WHERE status = 'active' AND (seen_at IS NULL OR seen_at < %s)
"""


def _run_marker(run_date: dt.date) -> dt.datetime:
    """The seen_at every company confirmed by `run_date`'s walk is stamped
    with: midnight UTC at the start of run_date.

    Deliberately NOT the wall clock. seen_at answers "which run last found
    this company in the register", and that has to be one value for the
    whole run, because a run is not one process: a walk interrupted after
    600 municipalities resumes in a second invocation minutes or hours
    later, and stamping each invocation with its own start time makes the
    sweep below unable to tell the 600 municipalities the resume deliberately
    skipped from companies that have actually left the register. It struck
    off every one of them -- caught by
    test_a_resumed_run_does_not_inactivate_what_the_earlier_half_saw.

    Anchoring on run_date makes the two invocations write the same value and
    keeps the sweep a plain `seen_at < today's marker`, with no bookkeeping
    table for "when did this run start".
    """
    return dt.datetime.combine(run_date, dt.time.min, dt.timezone.utc)


def partitions(client, requested: list[int] | None = None) -> list[dict]:
    """The municipalities to walk, largest last so the long tail of small
    ones is already committed before Zürich's eleven pages begin.

    `requested` restricts the walk (CHPIPE_ZEFIX_MUNICIPALITIES, and the
    stage tests); a requested id LINDAS does not report is dropped with a
    warning rather than walked into an empty result.
    """
    rows = []
    for row in client.select(zefix.PARTITIONS):
        iri = row.get("municipality")
        municipality_id = zefix.municipality_from_iri(iri)
        if municipality_id is None:
            log.error("zefix: partition with an unusable municipality: %r", iri)
            continue
        rows.append({
            "id": municipality_id,
            "iri": iri,
            "name": row.get("name"),
            "canton": row.get("canton"),
            "organisations": int(row.get("organisations") or 0),
        })
    if requested is not None:
        wanted = set(requested)
        known = {r["id"] for r in rows}
        for missing in sorted(wanted - known):
            log.warning("zefix: municipality %s is not in the partition list",
                        missing)
        rows = [r for r in rows if r["id"] in wanted]
    rows.sort(key=lambda r: (r["organisations"], r["id"]))
    return rows


def _upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    params = [{**row, "metadata": json.dumps(row["metadata"], ensure_ascii=False)}
              for row in rows]
    with conn.cursor() as cur:
        cur.executemany(_UPSERT_COMPANY, params)
        return cur.rowcount


def walk_municipality(client, conn, partition: dict, seen_at,
                      labels: dict[str, str], page_size: int) -> tuple[int, int, int]:
    """One municipality: (companies seen, rows upserted, rows skipped).

    Deduplicated per municipality. keyset()'s `>=` boundary re-fetches the
    page's last subject, and the aggregated query's SAMPLE()s are not
    guaranteed to pick the same value twice, so a boundary organisation can
    come back with a row that fingerprints differently and escape keyset()'s
    own suppression. Upserting it twice is harmless; counting it twice would
    quietly inflate the report and the progress row.
    """
    template = zefix.organisations_query(partition["iri"])
    seen: set[str] = set()
    batch: list[dict] = []
    upserted = skipped = 0

    rows = client.keyset(template, key="org", page_size=page_size)
    for org_iri, org_rows in zefix.group_by_org(rows).items():
        if org_iri in seen:
            continue
        seen.add(org_iri)
        try:
            row = zefix.company_row(
                org_rows, municipality_id=partition["id"],
                municipality_name=partition["name"], seen_at=seen_at,
                labels=labels)
        except Exception as exc:                          # noqa: BLE001
            log.error("zefix: %s: %s", org_iri, exc)
            row = None
        if row is None:
            skipped += 1
            continue
        batch.append(row)
        if len(batch) >= zefix.UPSERT_BATCH:
            upserted += _upsert(conn, batch)
            batch = []
    upserted += _upsert(conn, batch)
    return len(seen) - skipped, upserted, skipped


def run(settings: Settings, run_date: dt.date | None = None,
        municipalities: list[int] | None = None, client=None,
        page_size: int = zefix.PAGE_SIZE) -> ZefixReport:
    """Walk every municipality that has not been walked for `run_date` yet.

    `client` is for the tests; when this opens its own it closes it too.
    """
    run_date = run_date or dt.date.today()
    report = ZefixReport()
    owned = client is None
    client = client or SparqlClient(zefix.ENDPOINT)
    conn = db.connect(settings)
    seen_at = _run_marker(run_date)
    try:
        labels = zefix.legal_form_labels(client.select(zefix.LEGAL_FORMS))
        log.info("zefix: %d legal-form labels from LINDAS", len(labels))

        todo = partitions(client, municipalities)
        with conn.cursor() as cur:
            cur.executemany(_UPSERT_MUNICIPALITY, todo)
        done = {r["municipality_id"] for r in
                conn.execute(_DONE_TODAY, (run_date,)).fetchall()}
        pending = [p for p in todo if p["id"] not in done]
        log.info("zefix: %d municipalities, %d already done for %s",
                 len(todo), len(todo) - len(pending), run_date)

        for partition in pending:
            # One municipality that fails must not cost the other 2,110 --
            # and must not be marked done either, so the next run retries it.
            try:
                seen, upserted, skipped = walk_municipality(
                    client, conn, partition, seen_at, labels, page_size)
            except Exception as exc:                      # noqa: BLE001
                log.error("zefix: municipality %s (%s): %s", partition["id"],
                          partition["name"], exc)
                continue
            conn.execute(_MARK_DONE, (run_date, partition["id"], seen))
            report.municipalities += 1
            report.companies_seen += seen
            report.upserted += upserted
            report.skipped += skipped
            if report.municipalities % 100 == 0:
                log.info("zefix: %d municipalities, %d companies",
                         report.municipalities, report.companies_seen)

        _sweep(conn, run_date, todo, municipalities, report)
    finally:
        conn.close()
        if owned:
            client.close()
    return report


# The fraction of the currently-active set a walk must have confirmed before
# it is allowed to assert anything about the rest of it. LINDAS answering 200
# with an empty result set is indistinguishable, to the sweep, from "every
# company in Switzerland has been struck off" -- and the sweep would write
# that to all 792K rows. A genuine day's churn is in the hundreds.
SWEEP_MIN_SEEN_FRACTION = 0.5

_ACTIVE_COUNT = "SELECT count(*) AS n FROM ch_zefix_companies WHERE status = 'active'"


def _sweep(conn, run_date: dt.date, todo: list[dict],
           municipalities: list[int] | None, report: ZefixReport) -> None:
    """Mark the companies this run_date's complete walk did not see.

    Three guards, all load-bearing:

      * A run restricted to a municipality list has looked at a fraction of
        the register, so it never sweeps. Without this, `zefix 371` would
        report every company outside Biel/Bienne as struck off.
      * Even an unrestricted run sweeps only once every partition has a
        progress row for run_date, so a run that died half way through, or
        one whose last municipality raised, leaves the table alone.
      * A MAGNITUDE guard: every partition can report in and still describe
        a fraction of the register, because "no organisations here" and "the
        endpoint answered 200 with nothing" look identical from the outside.
        A walk that confirmed less than SWEEP_MIN_SEEN_FRACTION of what is
        currently active is not a snapshot of the register, so it does not
        get to strike anything off; report.sweep_skipped says so and the
        run's rows are written either way.

    The cutoff is this run's own marker (see _run_marker), so it means
    exactly "not confirmed by run_date's walk" -- resumed invocations
    included.
    """
    if municipalities is not None:
        return
    done = {r["municipality_id"] for r in
            conn.execute(_DONE_TODAY, (run_date,)).fetchall()}
    outstanding = [p["id"] for p in todo if p["id"] not in done]
    if outstanding:
        log.warning("zefix: %d municipalities did not finish, not sweeping "
                    "(first few: %s)", len(outstanding), outstanding[:10])
        return

    active_before = conn.execute(_ACTIVE_COUNT).fetchone()["n"]
    if (active_before > 0
            and report.companies_seen < SWEEP_MIN_SEEN_FRACTION * active_before):
        log.warning("zefix: the walk saw %d companies against %d currently "
                    "active (under %.0f%%); NOT sweeping -- this looks like a "
                    "source failure, not %d companies leaving the register",
                    report.companies_seen, active_before,
                    SWEEP_MIN_SEEN_FRACTION * 100,
                    active_before - report.companies_seen)
        report.sweep_skipped = True
        return

    with conn.cursor() as cur:
        cur.execute(_INACTIVATE, (_run_marker(run_date),))
        report.inactivated = cur.rowcount


def _municipalities_from_env() -> list[int] | None:
    """CHPIPE_ZEFIX_MUNICIPALITIES="371, 700" -> [371, 700].

    Unset or empty means every municipality. "" is not a municipality list:
    run-stage.sh exports its variables unconditionally, and reading an empty
    one as a selection is exactly the CHPIPE_SPIDER bug tests/
    test_entry_points.py exists to prevent.
    """
    raw = os.environ.get("CHPIPE_ZEFIX_MUNICIPALITIES", "").strip()
    if not raw:
        return None
    return [int(part) for part in raw.split(",") if part.strip()]


def main() -> ZefixReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py for the bug that shape already caused once.

    nice 10 (throttle.NICE_IO), like acts/versions: a network walk over a
    couple of thousand queries, holding the GIL and one connection, on a box
    serving live traffic. No wait_for_capacity() -- it is bounded by LINDAS's
    response times, not by this machine's cores.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), municipalities=_municipalities_from_env())
    log.info("zefix municipalities=%d companies_seen=%d upserted=%d "
             "inactivated=%d skipped=%d sweep_skipped=%s",
             result.municipalities, result.companies_seen, result.upserted,
             result.inactivated, result.skipped, result.sweep_skipped)
    return result


if __name__ == "__main__":
    main()
