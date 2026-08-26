"""Fills ch_shab_publications from the amtsblattportal.ch bulk export.

2,509,068 publications (HR 2,293,215 + KK 215,853, measured 2026-08-26) that
the endpoint will only hand over 2,000 at a time, and only in the first page.

THE STAGE NEVER ASKS FOR AN OFFSET, and that is the whole shape of it. Two
measurements, both taken live on 2026-08-26 against the HR rubric, say why:

  * `page * size >= 10000` is refused outright -- "The 10000 maximum allowed
    search offset size exceeded. Use search filter criteria to get more
    results." size=100&page=99 is a 200, page=100 is a 400. August 2026 alone
    holds 18,764 HR publications, so a month cannot be paged even in principle.

  * Worse, paging is LOSSY well before that cap. The window 2026-08-03..04
    reports total=2048; walking it as four pages of 500 returned 2,000
    publications of which only 1,927 were distinct. The result set is not
    ordered stably across requests, so a row that shifts across a page
    boundary between two requests is served twice or not at all -- 3.6% of
    that window silently missing. `pageRequest.sortOrders` does not help: the
    endpoint answers 200 to a sort on a field that does not exist and produced
    the identical duplication.

  * The same window fetched UNPAGED is exact: 2026-08-03 alone reports
    total=1,095 and one request returns 1,095 distinct publications.

So the unit of fetching is a date window narrow enough to fit in a single
page, found by halving the month until `total <= size`; the probe that decides
this asks for one row and reads `<total>`. A month of 2000-era HR is one probe
and one request; a month of modern HR is 31 probes and 16 requests.

The unit of PROGRESS is still the month. Every month that finishes writes a
ch_shab_progress row, and a month whose row has done_at set is not requested
again -- so the backfill can be killed and restarted, and the nightly delta is
the same code with `months=2`.

done_at is stamped only when the month is COMPLETE AND OVER. The current month
is still being published into, so a complete walk of it records its counters
with done_at NULL and is walked again tomorrow; stamping it on the first night
of the month would put it in the skip list and the delta would make zero
requests until the month turned. The previous month is walked one last time
after the boundary and frozen then -- the window that catches a publication
backdated into it, and the reason the delta asks for two months.

A month that does NOT finish writes its progress row too, with done_at NULL and
fetched < total. That is deliberate rather than writing nothing: the row records
what the failed attempt saw, it is visible in a query, and because the skip list
is `done_at IS NOT NULL` the next run picks the month up again regardless. The
windows that did land are kept -- every row is re-upserted on the retry anyway.

Politeness: `Fetcher` caps in-flight requests at CHPIPE_SHAB_CONCURRENCY
(default 4), and a rate limiter caps the whole stage at CHPIPE_SHAB_RPS
(default 10) requests per second, so a retry storm cannot turn into a
hammering of a federal gazette.

Env:
    CHPIPE_SHAB_FROM         first month, "YYYY-MM" (default 2000-01)
    CHPIPE_SHAB_MONTHS       walk only the last N months (delta); unset = all
    CHPIPE_SHAB_RPS          requests per second ceiling (default 10)
    CHPIPE_SHAB_CONCURRENCY  in-flight requests (default 4) -- through the
                             SOCKS tunnel to prod, throughput is roughly this
                             divided by round-trip time regardless of RPS, so
                             raise it together with CHPIPE_SHAB_RPS
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import time
from dataclasses import dataclass
from xml.etree import ElementTree as ET

import httpx

from .. import db, shab, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

# In-flight requests. The endpoint is a federal gazette, not a CDN. This is
# only the fallback default -- the stages actually pass settings.shab_concurrency
# (CHPIPE_SHAB_CONCURRENCY, see chpipe/config.py), which defaults to the same
# 4 but can be raised for a run that goes through the SOCKS tunnel to prod,
# where throughput is roughly concurrency / RTT regardless of the rate
# limiter.
CONCURRENCY = 4

# Per-request retry budget. Longer than the Fetcher's default 1.0 s base: a
# 429 or a 503 from a gazette is a request to come back later, and the whole
# stage is bounded by the rate limiter anyway, so waiting 2 s then 4 s costs
# nothing that matters and turns a transient fault into a fetched window
# rather than a month that has to be walked again tomorrow.
RETRIES = 3
BACKOFF = 2.0

DEFAULT_FROM = dt.date(2000, 1, 1)
DEFAULT_RPS = 10.0

# KK first: it is a twelfth of HR's volume and it is the half that answers
# "is this counterparty bankrupt", so a backfill that is stopped early has
# still delivered the more valuable rubric.
RUBRICS = ("KK", "HR")


@dataclass
class ShabListReport:
    months: int = 0            # months walked to completion
    pages: int = 0             # list pages fetched -- one per leaf window
    publications: int = 0      # publication metas parsed
    upserted: int = 0          # rows written


# company_name and seat are guarded by detail_fetched_at rather than
# overwritten: this stage parses them out of a title, shab-detail reads them
# from the register's own XML, and a nightly re-list of the same month must
# not replace the better value with the guess. Every other column here is
# owned by this stage.
#
# metadata_json is MERGED, not replaced, for the same reason: shab-detail
# writes capital/remarks into it and a re-list would otherwise drop them.
# `||` is right-biased, so this run's `titles` win over the stored copy.
_UPSERT = """
INSERT INTO ch_shab_publications (
    shab_id, publication_date, publication_type, rubric, sub_rubric,
    company_name, canton, language, publication_number, title,
    registration_office, seat, metadata_json, updated_at)
VALUES (
    %(shab_id)s, %(publication_date)s, %(publication_type)s, %(rubric)s,
    %(sub_rubric)s, %(company_name)s, %(canton)s, %(language)s,
    %(publication_number)s, %(title)s, %(registration_office)s, %(seat)s,
    %(metadata)s, now())
ON CONFLICT (shab_id) DO UPDATE SET
    publication_date    = EXCLUDED.publication_date,
    publication_type    = EXCLUDED.publication_type,
    rubric              = EXCLUDED.rubric,
    sub_rubric          = EXCLUDED.sub_rubric,
    canton              = EXCLUDED.canton,
    language            = EXCLUDED.language,
    publication_number  = EXCLUDED.publication_number,
    title               = EXCLUDED.title,
    registration_office = EXCLUDED.registration_office,
    company_name = CASE WHEN ch_shab_publications.detail_fetched_at IS NULL
                        THEN EXCLUDED.company_name
                        ELSE ch_shab_publications.company_name END,
    seat         = CASE WHEN ch_shab_publications.detail_fetched_at IS NULL
                        THEN EXCLUDED.seat
                        ELSE ch_shab_publications.seat END,
    metadata_json = COALESCE(ch_shab_publications.metadata_json, '{}'::jsonb)
                    || EXCLUDED.metadata_json,
    updated_at = now()
"""

_MARK = """
INSERT INTO ch_shab_progress (rubric, month, total, fetched, done_at)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (rubric, month) DO UPDATE SET
    total = EXCLUDED.total, fetched = EXCLUDED.fetched, done_at = EXCLUDED.done_at
"""

_DONE = "SELECT rubric, month FROM ch_shab_progress WHERE done_at IS NOT NULL"

# What one (rubric, month) is allowed to fail with without ending the stage:
# the gazette refusing or mangling an answer. Deliberately NOT `Exception`.
# The per-month guard exists so a bad WINDOW does not cost the 300 months
# behind it, but catching everything also swallowed psycopg reporting that
# the connection is gone -- after which every remaining month "failed" the
# same way, the stage exited 0, and the run looked like a success that had
# simply found nothing. A database fault is not a per-month problem.
_PER_MONTH = (FetchError, httpx.HTTPError, ET.ParseError, ValueError)


class _RateLimiter:
    """A whole-stage ceiling of `rps` requests per second.

    Not a token bucket: a bucket lets a burst through, and a burst is exactly
    what a resumed backfill produces at start-up. This spaces every acquire()
    by 1/rps from the previous one, so the ceiling holds across the four
    concurrent workers as well as within one.

    rps <= 0 disables it, which is what the tests use.
    """

    def __init__(self, rps: float):
        self._interval = 1.0 / rps if rps and rps > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def acquire(self) -> None:
        if not self._interval:
            return
        async with self._lock:
            now = time.monotonic()
            wait = self._next - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._next = now + self._interval


def start_month(raw: str | None = None) -> dt.date:
    """CHPIPE_SHAB_FROM="2019-04" -> date(2019, 4, 1).

    An empty value is NOT a month: run-stage.sh exports its variables
    unconditionally, and reading "" as anything but "unset" is the
    CHPIPE_SPIDER bug tests/test_entry_points.py exists to prevent.
    """
    raw = (raw if raw is not None else os.environ.get("CHPIPE_SHAB_FROM", "")).strip()
    if not raw:
        return DEFAULT_FROM
    return dt.datetime.strptime(raw, "%Y-%m").date()


def rate_limit() -> float:
    raw = os.environ.get("CHPIPE_SHAB_RPS", "").strip()
    return float(raw) if raw else DEFAULT_RPS


def months_to_walk(first: dt.date, today: dt.date,
                   months: int | None = None) -> list[dt.date]:
    """Every month from `first` to `today`'s month, oldest first.

    `months=N` keeps only the last N of them, which is delta mode: N=2 is the
    current month and the one before it, so a publication backdated into last
    month after that month was marked done is still picked up.
    """
    first = first.replace(day=1)
    last = today.replace(day=1)
    out: list[dt.date] = []
    cursor = first
    while cursor <= last:
        out.append(cursor)
        cursor = (cursor.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    if months is not None:
        out = out[-months:] if months > 0 else []
    return out


def rows_for(metas: list[dict]) -> list[dict]:
    """One upsert parameter dict per publication meta."""
    rows = []
    for meta in metas:
        name, seat = shab.parse_title(meta["title"], meta["language"],
                                      meta["rubric"])
        rows.append({
            "shab_id": meta["id"],
            "publication_date": meta["publication_date"],
            "publication_type": shab.sub_rubric_label(meta["sub_rubric"]),
            "rubric": meta["rubric"],
            "sub_rubric": meta["sub_rubric"],
            "company_name": name,
            "canton": meta["cantons"],
            "language": meta["language"],
            "publication_number": meta["publication_number"],
            "title": meta["title"],
            "registration_office": meta["registration_office"],
            "seat": seat,
            "metadata": json.dumps({
                "titles": meta["titles"],
                "cantons": meta["all_cantons"],
                "registration_office": meta["registration_office"],
                "ref": meta["ref"],
            }, ensure_ascii=False),
        })
    return rows


def _upsert(conn, metas: list[dict]) -> int:
    rows = rows_for(metas)
    written = 0
    with conn.cursor() as cur:
        for start in range(0, len(rows), shab.UPSERT_BATCH):
            cur.executemany(_UPSERT, rows[start:start + shab.UPSERT_BATCH])
            written += cur.rowcount
    return written


async def _fetch_page(fetcher: Fetcher, limiter: _RateLimiter, rubric: str,
                      start: dt.date, end: dt.date, page: int, size: int) -> bytes:
    await limiter.acquire()
    return await fetcher.bytes(shab.list_url(rubric, start, end, page, size))


async def _probe_total(fetcher: Fetcher, limiter: _RateLimiter, rubric: str,
                       start: dt.date, end: dt.date) -> int:
    """How many publications the window holds, for one row's worth of traffic.

    Asked with pageRequest.size=1 rather than by reading page 0 of the real
    walk, because a window over the cap has to be thrown away and split, and
    discovering that by downloading 2,000 publications first would cost a
    3 MB body per split level for a number that fits in a `<total>` tag.
    """
    return shab.parse_list_page(
        await _fetch_page(fetcher, limiter, rubric, start, end, 0, 1))[0]


async def _walk_window(fetcher: Fetcher, limiter: _RateLimiter, conn,
                       rubric: str, start: dt.date, end: dt.date, size: int,
                       report: ShabListReport) -> tuple[int, int, bool]:
    """(total, fetched, complete) for one date window.

    Halves the window until it holds no more publications than one page, then
    fetches that page. THE STAGE NEVER ASKS FOR AN OFFSET -- see the module
    docstring; page 1 and beyond silently drop rows.

    The two halves of a split run concurrently. They share one connection, but
    an upsert is a blocking call with no await inside it, so two coroutines
    cannot interleave inside one; what the concurrency buys is that the four
    in-flight requests the Fetcher allows are actually in flight.
    """
    total = await _probe_total(fetcher, limiter, rubric, start, end)
    if not total:
        return 0, 0, True

    if total > size and start < end:
        mid = start + (end - start) // 2
        halves = await asyncio.gather(
            _walk_window(fetcher, limiter, conn, rubric, start, mid, size, report),
            _walk_window(fetcher, limiter, conn, rubric,
                         mid + dt.timedelta(days=1), end, size, report),
            return_exceptions=True)
        seen = fetched = 0
        complete = True
        for half in halves:
            if isinstance(half, BaseException):
                # Same rule as the per-month guard: a window may fail on the
                # network or the parser and cost only itself, but anything
                # else (psycopg, a bug in _upsert) is not a window's problem,
                # and return_exceptions=True would otherwise turn it into an
                # "incomplete month" and let the stage finish reporting 0.
                if not isinstance(half, _PER_MONTH):
                    raise half
                log.warning("shab-list: %s %s..%s: %s", rubric, start, end, half)
                complete = False
                continue
            seen += half[0]
            fetched += half[1]
            complete = complete and half[2]
        return seen, fetched, complete

    if total > size:
        # One calendar day that does not fit in a page. Nothing left to split,
        # and paging is not an option, so take the page and leave the month
        # undone rather than pretend. No day in the corpus is close to this:
        # the busiest HR day of August 2026 held 1,095 publications against a
        # page of 2,000. If it ever happens, the fix is a sub-rubric filter.
        log.error("shab-list: %s %s has %d publications in a single day, more "
                  "than one page of %d; keeping the first page and leaving the "
                  "month undone", rubric, start, total, size)

    try:
        body = await _fetch_page(fetcher, limiter, rubric, start, end, 0, size)
    except FetchError as exc:
        log.warning("shab-list: %s %s..%s: %s", rubric, start, end, exc)
        return total, 0, False

    # The window's own total, re-read from the page that was actually served:
    # a month still in progress can gain a publication between the probe and
    # the fetch, and this is what notices.
    total, metas = shab.parse_list_page(body)
    report.pages += 1
    report.publications += len(metas)
    report.upserted += _upsert(conn, metas)
    return total, len(metas), total <= size and len(metas) >= total


async def _walk_month(fetcher: Fetcher, limiter: _RateLimiter, conn,
                      rubric: str, month: dt.date, size: int,
                      report: ShabListReport, today: dt.date) -> bool:
    """One (rubric, month), recorded in ch_shab_progress either way.

    done_at is the skip list, so it is stamped only when the month can no
    longer gain a publication -- complete AND over. A complete walk of the
    CURRENT month writes its counters with done_at NULL, and the nightly
    delta therefore walks it again tomorrow; stamping it on the first night
    of the month froze it for the rest of the month and the delta made zero
    requests. The month before the current one is walked once more after the
    boundary (its done_at is still NULL) and frozen then, which is exactly
    the backdated-publication window `months=2` exists for.
    """
    start, end = shab.month_bounds(month)
    try:
        total, fetched, complete = await _walk_window(
            fetcher, limiter, conn, rubric, start, end, size, report)
    except FetchError as exc:
        # The probe itself failed, so there is no total to record: no progress
        # row at all, and the month is picked up again by the next run.
        log.warning("shab-list: %s %s: %s", rubric, month, exc)
        return False

    frozen = complete and end < today
    conn.execute(_MARK, (rubric, month, total, fetched,
                         dt.datetime.now(dt.timezone.utc) if frozen else None))
    if complete:
        report.months += 1
        log.info("shab-list: %s %s done, %d/%d publications%s", rubric, month,
                 fetched, total, "" if frozen else " (month still open, will "
                 "be walked again)")
    return complete


async def _run_async(settings: Settings, months: int | None, rubrics,
                     first: dt.date, today: dt.date, size: int,
                     rps: float, transport, retries: int,
                     backoff: float) -> ShabListReport:
    report = ShabListReport()
    conn = db.connect(settings)
    try:
        done = {(r["rubric"], r["month"]) for r in conn.execute(_DONE).fetchall()}
        todo = [(rubric, month)
                for rubric in rubrics
                for month in months_to_walk(first, today, months)
                if (rubric, month) not in done]
        if not todo:
            log.info("shab-list: nothing to do")
            return report
        log.info("shab-list: %d (rubric, month) units to walk", len(todo))

        limiter = _RateLimiter(rps)
        # proxy: amtsblattportal.ch does not answer AWS IPs at all -- the TCP
        # connection hangs -- so on the cloud box this goes through a reverse
        # SOCKS tunnel from the local server (CHPIPE_SHAB_PROXY). Only the two
        # SHAB stages; zefix's LINDAS traffic and everything else stay direct.
        async with Fetcher(concurrency=settings.shab_concurrency, retries=retries,
                           backoff=backoff, transport=transport,
                           proxy=settings.shab_proxy,
                           local_address=settings.shab_local_address) as fetcher:
            for rubric, month in todo:
                # One month that fails must not cost the 300 after it.
                try:
                    await _walk_month(fetcher, limiter, conn, rubric, month,
                                      size, report, today)
                except _PER_MONTH as exc:
                    log.error("shab-list: %s %s: %s", rubric, month, exc)
    finally:
        conn.close()
    return report


def run(settings: Settings, months: int | None = None, rubrics=RUBRICS,
        *, from_month: dt.date | None = None, today: dt.date | None = None,
        size: int = shab.PAGE_SIZE, rps: float | None = None,
        transport: httpx.BaseTransport | None = None,
        retries: int = RETRIES, backoff: float = BACKOFF) -> ShabListReport:
    """Walk every (rubric, month) that is not already marked done.

    The keyword-only arguments after `rubrics` are for the tests and for a
    targeted re-run; `transport` is how the suite reaches the real Fetcher,
    the real URL builder and the real parser without a socket.
    """
    return asyncio.run(_run_async(
        settings, months, tuple(rubrics),
        from_month if from_month is not None else start_month(),
        today or dt.date.today(), size,
        rate_limit() if rps is None else rps, transport, retries, backoff))


def main() -> ShabListReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py for the bug that shape already caused once.

    nice 10 (throttle.NICE_IO): a network walk holding one connection on a box
    that also serves live traffic. No wait_for_capacity() -- the rate limiter
    already bounds it far below anything this machine would notice.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    raw = os.environ.get("CHPIPE_SHAB_MONTHS", "").strip()
    result = run(Settings.from_env(), months=int(raw) if raw else None)
    log.info("shab-list months=%d pages=%d publications=%d upserted=%d",
             result.months, result.pages, result.publications, result.upserted)
    return result


if __name__ == "__main__":
    main()
