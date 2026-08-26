"""Fills the detail columns of ch_shab_publications from one XML per row.

shab-list writes 2.5M pointers: an id, a date, a rubric and a title it parsed
a name out of. This stage turns each pointer into the record -- the register's
own company name, the UID that joins a publication to a company, the legal
form, the seat, the whole publication text -- by fetching
`/api/v1/publications/{id}/xml` once per row.

Queue model: the queue IS the two detail columns. A row is offered while
`detail_fetched_at IS NULL AND detail_attempts < 3`; a success stamps
detail_fetched_at, a failure raises detail_attempts and writes detail_error,
and the third failure retires the row without ever stamping it. There is no
claimed state in between, so a killed run costs at most the batch it was
holding, and the same query is the backfill's queue and the nightly delta's.

Order: KK before HR, newest first. KK is 215,853 publications against HR's
2,293,215 and it is the half that answers "is this counterparty bankrupt", so
a backfill stopped at any point has delivered the more valuable rubric; within
a rubric the recent publications are the ones a due-diligence question is
about. Both of those come out of `ORDER BY rubric DESC, publication_date DESC`
-- 'KK' sorts after 'HR', so a plain descending sort on the rubric puts
bankruptcies first -- which is exactly the column order of
idx_ch_shab_detail_queue (rubric DESC, publication_date DESC) WHERE
detail_fetched_at IS NULL, so the claim reads the index and never sorts.
Spelling the same order as `(rubric = 'KK') DESC` reads more obviously but is
an expression no index covers: on 1M unfetched rows it sorted the whole set on
every claim, 867 ms and a disk spill to hand out 500 rows.

Politeness, same as shab-list: `Fetcher` caps in-flight requests at
CHPIPE_SHAB_CONCURRENCY (default 4) and one stage-wide rate limiter caps the
whole run at CHPIPE_SHAB_RPS (default 10) requests per second. 2.5M requests
at 10/s is ~70 hours, which is why CHPIPE_SHAB_BUDGET_SECONDS exists -- the
nightly delta stops on the clock and the backfill runs without a budget under
tmux. Through the SOCKS tunnel to prod (~0.4-0.7 s RTT) the default
concurrency of 4 is the binding constraint, not RPS -- see
chpipe/config.py's _shab_concurrency() -- so raise CHPIPE_SHAB_CONCURRENCY
alongside CHPIPE_SHAB_RPS to actually use the RPS ceiling.

This stage does NOT write ch_zefix_companies. A resolved UID is stored on the
publication and nowhere else: ch_zefix_companies holds the register's CURRENT
state, fetched from LINDAS by the zefix stage, and a gazette publication is a
historical event -- a 2004 deletion would otherwise resurrect a struck-off
company as a live row.

Env:
    CHPIPE_LIMIT                  stop after N rows (a smoke run)
    CHPIPE_SHAB_BUDGET_SECONDS    stop after N seconds, checked between batches
    CHPIPE_SHAB_RPS               requests per second ceiling (default 10)
    CHPIPE_SHAB_CONCURRENCY       in-flight requests (default 4) -- see the
                                   module docstring's Politeness paragraph
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from decimal import Decimal

import httpx

from .. import db, shab, throttle, zefix
from ..config import Settings
from ..http import FetchError, Fetcher
# One rate limiter implementation for the two amtsblattportal stages, not two:
# they hit the same host and the ceiling is a property of that host.
from .shab_list_stage import _RateLimiter, rate_limit

log = logging.getLogger(__name__)

# Rows per claim. Large enough that the round-trip is amortised over a batch
# the four workers can keep busy, small enough that a killed run loses little.
BATCH_SIZE = 500

# Fetch attempts per row before it is retired. Matches migration 202's
# detail_attempts smallint and the claim predicate below.
MAX_ATTEMPTS = 3

# Ceiling on this run's poison set. The set is held in memory and sent with
# every claim, so it is bounded on purpose; a run that has already failed on
# this many publications is not working through bad rows, it is talking to a
# source that is down, and stopping leaves tomorrow's attempts unspent.
MAX_POISONED = 5000

# Per-request retry budget inside one attempt, same reasoning as shab-list: a
# 429 or a 503 from a gazette is a request to come back later.
RETRIES = 3
BACKOFF = 2.0

# detail_error is a diagnostic, not a log. A FetchError carries the whole URL
# and psycopg would happily store a megabyte of upstream HTML.
ERROR_CHARS = 500


@dataclass
class ShabDetailReport:
    claimed: int = 0            # rows attempted (claimed, minus this run's poison)
    fetched: int = 0            # rows stamped detail_fetched_at
    failed: int = 0             # rows whose attempt raised
    skipped_exhausted: int = 0  # rows out of attempts, measured before the run


# No NULLS clause anywhere, deliberately: DESC defaults to NULLS FIRST and so
# does a DESC index, so the default is what matches idx_ch_shab_detail_queue
# and keeps the plan free of a Sort node (asserted by an EXPLAIN test). The
# cost is that a row with a NULL rubric -- shab-list writes one for every
# publication, so this is a row that arrived some other way -- is claimed
# ahead of KK and parsed as HR. One misparsed publication is cheaper than
# sorting 2.5M rows on every claim.
#
# The `<> ALL` is this run's poison set (see _run_async): rows that already
# failed in THIS run are still claimable -- that is what lets tomorrow retry
# them -- so they have to be excluded IN the claim. Filtering them out of the
# result instead capped the run at one batch: once the set held BATCH_SIZE
# ids, every claim came back holding nothing but poisoned rows. It stays a
# filter on the ordered index read (asserted by the EXPLAIN test).
_CLAIM = """
SELECT shab_id, rubric
  FROM ch_shab_publications
 WHERE detail_fetched_at IS NULL AND detail_attempts < %s
   AND shab_id <> ALL(%s::text[])
 ORDER BY rubric DESC, publication_date DESC
 LIMIT %s
   FOR UPDATE SKIP LOCKED
"""

# coalesce, not assignment: the detail is the better source for every column
# here, but only where it HAS a value. A KK publication states no seat, so
# assigning would erase the one shab-list parsed out of the title.
#
# metadata_json is merged with `||`, right-biased, so this stage's keys win
# over a stored copy and the list stage's `titles` survive.
_SUCCESS = """
UPDATE ch_shab_publications SET
    company_uid       = coalesce(%(company_uid)s, company_uid),
    company_name      = coalesce(%(company_name)s, company_name),
    legal_form        = coalesce(%(legal_form)s, legal_form),
    seat              = coalesce(%(seat)s, seat),
    content           = coalesce(%(content)s, content),
    metadata_json     = coalesce(metadata_json, '{}'::jsonb) || %(metadata)s::jsonb,
    detail_error      = NULL,
    detail_fetched_at = now(),
    updated_at        = now()
 WHERE shab_id = %(shab_id)s
"""

# greatest(): a permanent failure passes MAX_ATTEMPTS as the floor and retires
# the row in one statement, without a second UPDATE and without ever lowering
# an attempt count.
_FAIL = """
UPDATE ch_shab_publications SET
    detail_attempts = greatest(detail_attempts + 1, %(floor)s),
    detail_error    = %(error)s,
    updated_at      = now()
 WHERE shab_id = %(shab_id)s
"""

_EXHAUSTED = """
SELECT count(*) AS n FROM ch_shab_publications
 WHERE detail_fetched_at IS NULL AND detail_attempts >= %s
"""

# The eCH-0097 labels the zefix stage wrote from LINDAS. ~30 rows.
_LEGAL_FORMS = """
SELECT legal_form_code AS code, legal_form AS name
  FROM ch_zefix_companies
 WHERE legal_form_code IS NOT NULL AND legal_form IS NOT NULL
 GROUP BY 1, 2
"""


def claim(conn, limit: int, exclude=()) -> list[dict]:
    """Rows still owed a detail, most valuable first.

    'KK' > 'HR', so `rubric DESC` is "bankruptcies before the register" AND is
    an index-ordered read of idx_ch_shab_detail_queue. See _CLAIM.

    `exclude` is the caller's poison set: ids this run has already tried and
    must not be offered again, skipped by the query rather than by the caller.

    FOR UPDATE SKIP LOCKED reduces overlap between processes but is not a
    distributed lock under autocommit -- the row lock releases the moment the
    SELECT completes, same caveat as db.claim(). One process per stage is the
    supported model.
    """
    return conn.execute(_CLAIM, (MAX_ATTEMPTS, list(exclude), limit)).fetchall()


def legal_form_labels(conn) -> dict[str, str]:
    """{eCH-0097 code: German label}, read from what the zefix stage imported.

    The detail XML states the CODE ("0107") and nothing else. The label is not
    hand-written here for the reason chpipe/zefix.py documents at length: a
    hand-written eCH-0097 map got two labels wrong, and a wrong label is worse
    than a bare code because a bare code is visibly a code. An empty table
    (zefix not run yet) therefore means legal_form holds the code, which is
    still an unambiguous identifier of the form.
    """
    try:
        rows = conn.execute(_LEGAL_FORMS).fetchall()
    except Exception as exc:                                    # noqa: BLE001
        log.warning("shab-detail: no legal-form labels available: %s", exc)
        return {}
    return {row["code"]: row["name"] for row in rows}


def budget_seconds() -> float | None:
    """CHPIPE_SHAB_BUDGET_SECONDS, where "" means no budget.

    run-stage.sh exports its variables unconditionally, and reading "" as
    anything but "unset" is the CHPIPE_SPIDER bug tests/test_entry_points.py
    exists to prevent -- here it would be a budget of zero seconds, i.e. a
    nightly delta that fetches one batch and stops.
    """
    raw = os.environ.get("CHPIPE_SHAB_BUDGET_SECONDS", "").strip()
    return float(raw) if raw else None


def _metadata(detail: dict, labels: dict[str, str]) -> str:
    """The jsonb this stage merges into metadata_json.

    ch_shab_publications has no purpose and no capital column (migration 129
    gave it eight columns and a jsonb), so the fields that have no column of
    their own live here. Nones are dropped rather than merged: `||` would
    write a null over a value a previous run stored.
    """
    payload = {key: value for key, value in detail["extra"].items()
               if value is not None}
    payload.update({key: detail[key] for key in
                    ("purpose", "capital", "capital_currency")
                    if detail.get(key) is not None})
    if detail.get("legal_form"):
        payload["legal_form_code"] = detail["legal_form"]
        payload.setdefault("legal_form", labels.get(detail["legal_form"]))
        if payload["legal_form"] is None:
            del payload["legal_form"]
    return json.dumps(payload, ensure_ascii=False, default=_jsonable)


def _jsonable(value):
    # Decimal is what parse_capital returns and what json refuses. str, not
    # float: 20000.00 is money and the column it feeds is numeric.
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"cannot serialise {type(value).__name__} into metadata_json")


def _row_params(row: dict, detail: dict, labels: dict[str, str]) -> dict:
    return {
        "shab_id": row["shab_id"],
        "company_uid": detail["company_uid"],
        "company_name": detail["company_name"],
        "legal_form": zefix.legal_form_label(detail["legal_form"], labels),
        "seat": detail["seat"],
        "content": detail["content"],
        "metadata": _metadata(detail, labels),
    }


# The statuses that mean "this publication is not coming back", as opposed to
# "not right now". 410 Gone is 404's more explicit sibling -- it says the
# publication WAS here and has been withdrawn -- and the gazette answers it
# for exactly the case this queue has to retire: a publication the list run
# saw and that was pulled before the detail fetch reached it.
_GONE = ("404 ", "410 ")


def _permanent(exc: BaseException) -> bool:
    """A 404 or a 410 is a fact about the publication, not a hiccup.

    Fetcher raises FetchError("{status} for {url}") for the statuses it
    refuses to retry; these two are the ones that retire the row rather than
    spending two more requests on a federal gazette to be told the same
    thing.
    """
    return isinstance(exc, FetchError) and str(exc).startswith(_GONE)


async def _fetch_one(fetcher: Fetcher, limiter: _RateLimiter,
                     row: dict) -> tuple[dict, dict | None, str | None, bool]:
    """(row, detail, error, permanent). Never raises: one publication that
    cannot be read must not cost the 499 behind it."""
    try:
        await limiter.acquire()
        body = await fetcher.bytes(shab.detail_url(row["shab_id"]))
    except FetchError as exc:
        return row, None, "not_found" if _permanent(exc) else str(exc), _permanent(exc)
    except Exception as exc:                                    # noqa: BLE001
        return row, None, f"{type(exc).__name__}: {exc}", False
    try:
        return row, shab.parse_detail(body, row["rubric"]), None, False
    except Exception as exc:                                    # noqa: BLE001
        return row, None, f"{type(exc).__name__}: {exc}", False


def _write(conn, results, labels: dict[str, str], report: ShabDetailReport,
           poisoned: set[str]) -> None:
    with conn.cursor() as cur:
        for row, detail, error, permanent in results:
            if detail is not None:
                cur.execute(_SUCCESS, _row_params(row, detail, labels))
                report.fetched += 1
                continue
            cur.execute(_FAIL, {"shab_id": row["shab_id"],
                                "error": (error or "")[:ERROR_CHARS],
                                "floor": MAX_ATTEMPTS if permanent else 0})
            report.failed += 1
            poisoned.add(row["shab_id"])
            log.warning("shab-detail: %s: %s", row["shab_id"], error)


async def _run_async(settings: Settings, limit: int | None,
                     budget: float | None, rps: float,
                     transport, retries: int, backoff: float,
                     batch_size: int) -> ShabDetailReport:
    report = ShabDetailReport()
    conn = db.connect(settings)
    try:
        # Measured BEFORE the run, so it counts the rows this run refuses to
        # offer rather than the ones it is about to retire.
        report.skipped_exhausted = conn.execute(
            _EXHAUSTED, (MAX_ATTEMPTS,)).fetchone()["n"]
        if report.skipped_exhausted:
            log.info("shab-detail: %d rows are out of attempts and will not be "
                     "claimed", report.skipped_exhausted)

        labels = legal_form_labels(conn)
        limiter = _RateLimiter(rps)
        started = time.monotonic()
        remaining = limit
        # Publications that failed in THIS run. A failure raises attempts but
        # leaves the row claimable (that is the point -- tomorrow retries it),
        # so the claim query keeps offering it and the run would spend its
        # whole budget re-fetching the same 500 failures. Same poison set as
        # citations_stage, for the same reason -- and passed INTO the claim,
        # so a batch that fails entirely does not end the run.
        poisoned: set[str] = set()
        # proxy: amtsblattportal.ch does not answer AWS IPs at all -- the TCP
        # connection hangs -- so on the cloud box this goes through a reverse
        # SOCKS tunnel from the local server (CHPIPE_SHAB_PROXY). Only the two
        # SHAB stages; zefix's LINDAS traffic and everything else stay direct.
        async with Fetcher(concurrency=settings.shab_concurrency, retries=retries,
                           backoff=backoff, transport=transport,
                           proxy=settings.shab_proxy) as fetcher:
            while True:
                size = batch_size if remaining is None else min(batch_size, remaining)
                if size <= 0:
                    break
                rows = claim(conn, size, poisoned)
                if not rows:
                    break
                report.claimed += len(rows)
                if remaining is not None:
                    remaining -= len(rows)

                _write(conn, await asyncio.gather(
                    *(_fetch_one(fetcher, limiter, row) for row in rows)),
                    labels, report, poisoned)
                log.info("shab-detail: %d claimed, %d fetched, %d failed",
                         report.claimed, report.fetched, report.failed)

                # The poison set is held in memory and spliced into every
                # claim, so it cannot be allowed to grow to the size of the
                # queue. Past the cap the endpoint is not having a bad
                # minute, it is down.
                if len(poisoned) > MAX_POISONED:
                    log.error("shab-detail: %d publications failed in this run "
                              "(cap %d); stopping -- this is a source failure, "
                              "not a queue of bad rows",
                              len(poisoned), MAX_POISONED)
                    break

                # Between batches, never inside one: a batch already claimed is
                # always finished, so no row is left holding a lock or an
                # attempt it did not spend.
                if budget is not None and time.monotonic() - started >= budget:
                    log.info("shab-detail: %.0f s budget spent, stopping", budget)
                    break
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None,
        budget_seconds: float | None = None, *, rps: float | None = None,
        transport: httpx.BaseTransport | None = None,
        retries: int = RETRIES, backoff: float = BACKOFF,
        batch_size: int = BATCH_SIZE) -> ShabDetailReport:
    """Fetch a detail for every row that is still owed one.

    The keyword-only arguments are for the tests and for a targeted re-run;
    `transport` is how the suite reaches the real Fetcher, the real URL builder
    and the real parser without a socket.
    """
    return asyncio.run(_run_async(
        settings, limit, budget_seconds,
        rate_limit() if rps is None else rps, transport, retries, backoff,
        batch_size))


def main() -> ShabDetailReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py for the bug that shape already caused once.

    nice 10 (throttle.NICE_IO): a network walk holding one connection on a box
    that also serves live traffic. No wait_for_capacity() -- the rate limiter
    already bounds it far below anything this machine would notice.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    raw = os.environ.get("CHPIPE_LIMIT", "").strip()
    result = run(Settings.from_env(), limit=int(raw) if raw else None,
                 budget_seconds=budget_seconds())
    log.info("shab-detail claimed=%d fetched=%d failed=%d skipped_exhausted=%d",
             result.claimed, result.fetched, result.failed,
             result.skipped_exhausted)
    return result


if __name__ == "__main__":
    main()
