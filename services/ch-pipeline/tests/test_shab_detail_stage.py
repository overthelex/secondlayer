"""shab_detail_stage.run(): one publication XML per queued row.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test_d \
        python3 -m pytest services/ch-pipeline/tests/test_shab_detail_stage.py

No live HTTP: every request goes through an httpx.MockTransport serving the
captured fixtures by publication id, so the real Fetcher, the real URL builder
and the real parser are all under test and only the socket is fake.
"""
import dataclasses
import datetime as dt
import os
import pathlib

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import shab_detail_stage

from conftest import apply_migration_202

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "registries"

HR = "e34b9c34-4917-41fa-95e1-89ca86a9d69d"        # HR01, Hikari Labs GmbH
HR03 = "b6a8b11f-3274-4638-863d-769e928c3bd0"      # HR03, a deletion
KK = "c4ebb597-ac02-48a6-a87b-efba3e5f71e3"        # KK01, SM Regio Print GmbH
KK06 = "4ac28e55-3c08-4908-a337-6cb4c5cb2b59"      # KK06, a person debtor

BODIES = {
    HR: (FIXTURES / "shab_detail_hr.xml").read_bytes(),
    HR03: (FIXTURES / "shab_detail_hr03.xml").read_bytes(),
    KK: (FIXTURES / "shab_detail_kk.xml").read_bytes(),
    KK06: (FIXTURES / "shab_detail_kk06.xml").read_bytes(),
}


class FakePortal:
    """Answers /publications/{id}/xml from the fixtures, recording every id.

    `status` maps an id to an HTTP status to answer with instead, and `bodies`
    overrides what an id serves; between them they drive every failure path.
    An id with no fixture is a 404, which is what the live endpoint answers
    for a publication that has been withdrawn.
    """

    def __init__(self, status: dict | None = None, bodies: dict | None = None):
        self.status = status or {}
        self.bodies = {**BODIES, **(bodies or {})}
        self.ids: list[str] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        shab_id = str(request.url).rsplit("/", 2)[-2]
        self.ids.append(shab_id)
        if shab_id in self.status:
            return httpx.Response(self.status[shab_id], text="upstream on fire")
        body = self.bodies.get(shab_id)
        if body is None:
            return httpx.Response(404, text="no such publication")
        return httpx.Response(200, content=body)


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        for t in ("ch_zefix_progress", "ch_zefix_municipality",
                  "ch_shab_progress", "ch_shab_publications",
                  "ch_zefix_companies"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        apply_migration_202(c)
        yield c


def _seed(conn, shab_id, *, rubric="HR", date="2026-08-25", name=None,
          seat=None, metadata='{"titles": {"de": "Neueintragung"}}',
          attempts=0, fetched=False):
    conn.execute(
        """INSERT INTO ch_shab_publications
               (shab_id, rubric, publication_date, company_name, seat,
                metadata_json, detail_attempts, detail_fetched_at)
           VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s)""",
        (shab_id, rubric, date, name, seat, metadata, attempts,
         dt.datetime.now(dt.timezone.utc) if fetched else None))


def _row(conn, shab_id):
    return conn.execute("SELECT * FROM ch_shab_publications WHERE shab_id = %s",
                        (shab_id,)).fetchone()


def _run(settings, portal, **kwargs):
    kwargs.setdefault("rps", 0.0)
    kwargs.setdefault("backoff", 0.0)
    return shab_detail_stage.run(settings, transport=portal.transport, **kwargs)


# --- the happy path --------------------------------------------------------

def test_a_queued_row_is_filled_from_the_detail_xml(conn, settings):
    _seed(conn, HR, name="Hikari Labs", seat="Spreitenbach")
    report = _run(settings, FakePortal())

    row = _row(conn, HR)
    assert row["company_uid"] == "CHE-344.059.939"
    assert row["company_name"] == "Hikari Labs GmbH"
    assert row["legal_form"] == "0107"
    assert row["seat"] == "Spreitenbach"
    assert row["content"].startswith("Hikari Labs GmbH, in Spreitenbach")
    assert row["detail_fetched_at"] is not None
    assert row["detail_error"] is None
    assert (report.claimed, report.fetched, report.failed) == (1, 1, 0)


def test_the_metadata_is_merged_rather_than_replaced(conn, settings):
    """The list stage wrote the four titles into the same column. A detail
    that replaced the object would drop them."""
    _seed(conn, HR)
    _run(settings, FakePortal())

    meta = _row(conn, HR)["metadata_json"]
    assert meta["titles"]["de"] == "Neueintragung"
    assert meta["purpose"].startswith("Die Gesellschaft bezweckt")
    assert meta["capital"] == "20000.00"
    assert meta["journal_number"] == "11864"
    assert meta["legal_form_code"] == "0107"


def test_a_bankruptcy_row_keeps_the_debtor_and_gains_no_seat(conn, settings):
    _seed(conn, KK, rubric="KK", name="SM Regio Print GmbH")
    _run(settings, FakePortal())

    row = _row(conn, KK)
    assert row["company_uid"] == "CHE-278.850.327"
    assert row["company_name"] == "SM Regio Print GmbH"
    assert row["seat"] is None
    assert row["metadata_json"]["debtor_type"] == "company"


def test_a_person_debtor_leaves_the_uid_null(conn, settings):
    _seed(conn, KK06, rubric="KK", name="Hannelore Monika Hohensee")
    _run(settings, FakePortal())

    row = _row(conn, KK06)
    assert row["company_uid"] is None
    assert row["company_name"] == "Hannelore Monika Hohensee geb. Hahn"


def test_a_resolved_uid_does_not_create_a_zefix_company(conn, settings):
    """ch_zefix_companies is the zefix stage's table: it holds the register's
    CURRENT state, and a gazette publication is a historical event. Writing a
    company row from a 2004 deletion would resurrect a struck-off company."""
    _seed(conn, HR)
    _run(settings, FakePortal())
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_zefix_companies").fetchone()["n"] == 0


def test_nothing_to_do_costs_no_requests(conn, settings):
    portal = FakePortal()
    report = _run(settings, portal)
    assert portal.ids == []
    assert (report.claimed, report.fetched) == (0, 0)


def test_a_row_already_fetched_is_not_claimed_again(conn, settings):
    _seed(conn, HR, fetched=True)
    portal = FakePortal()
    report = _run(settings, portal)
    assert portal.ids == []
    assert report.claimed == 0


# --- the claim order -------------------------------------------------------

def test_bankruptcies_are_claimed_before_the_register_and_newest_first(conn):
    """KK is a twelfth of HR's volume and it is the half that answers "is this
    counterparty bankrupt", so it goes first; within a rubric the newest
    publication is the one a due-diligence question is about."""
    _seed(conn, "hr-old", rubric="HR", date="2020-01-02")
    _seed(conn, "hr-new", rubric="HR", date="2026-08-25")
    _seed(conn, "kk-old", rubric="KK", date="2019-05-05")
    _seed(conn, "kk-new", rubric="KK", date="2026-08-24")

    claimed = [r["shab_id"] for r in shab_detail_stage.claim(conn, 10)]
    assert claimed == ["kk-new", "kk-old", "hr-new", "hr-old"]


def test_the_claim_reads_the_index_instead_of_sorting(conn):
    """The queue is 2.5M rows and the claim runs once per 500 of them, so it
    has to be an ordered read of idx_ch_shab_detail_queue rather than a sort of
    everything unfetched. `ORDER BY (rubric = 'KK') DESC` was the same order
    written as an expression no index covers: measured on 1M unfetched rows it
    sorted the whole set on every call, 867 ms with a disk spill for 500 rows.

    enable_seqscan is off for this assertion only: the fixture table holds a
    handful of rows and the planner would seq-scan-and-sort them whatever the
    index says, which tells us nothing about the 2.5M-row plan.

    Asserted with a non-empty poison set, because that exclusion is part of
    the claim: it must stay a filter on the ordered index read."""
    _seed(conn, "hr-old", rubric="HR", date="2020-01-02")
    _seed(conn, "kk-new", rubric="KK", date="2026-08-24")
    conn.execute("ANALYZE ch_shab_publications")
    conn.execute("SET enable_seqscan = off")
    try:
        plan = str(conn.execute(
            "EXPLAIN (FORMAT JSON) " + shab_detail_stage._CLAIM,
            (shab_detail_stage.MAX_ATTEMPTS, ["kk-new"], 500)).fetchone())
    finally:
        conn.execute("RESET enable_seqscan")

    assert "idx_ch_shab_detail_queue" in plan
    assert "Sort" not in plan


def test_an_exhausted_row_is_not_claimed(conn):
    _seed(conn, HR, attempts=3)
    assert shab_detail_stage.claim(conn, 10) == []


# --- failure ---------------------------------------------------------------

def test_a_server_error_burns_one_attempt_and_records_it(conn, settings):
    _seed(conn, HR)
    report = _run(settings, FakePortal(status={HR: 500}))

    row = _row(conn, HR)
    assert row["detail_attempts"] == 1
    assert row["detail_fetched_at"] is None
    assert "500" in row["detail_error"]
    assert (report.fetched, report.failed) == (0, 1)


def test_a_third_failure_retires_the_row(conn, settings):
    _seed(conn, HR)
    for _ in range(3):
        _run(settings, FakePortal(status={HR: 500}))
    assert _row(conn, HR)["detail_attempts"] == 3

    portal = FakePortal()
    report = _run(settings, portal)
    assert portal.ids == []
    assert report.claimed == 0
    assert report.skipped_exhausted == 1


def test_a_missing_publication_is_retired_at_once(conn, settings):
    """A 404 is a fact about the publication, not a hiccup: two more fetches
    would learn the same thing."""
    _seed(conn, "gone-forever")
    report = _run(settings, FakePortal())

    row = _row(conn, "gone-forever")
    assert row["detail_attempts"] == shab_detail_stage.MAX_ATTEMPTS
    assert row["detail_error"] == "not_found"
    assert row["detail_fetched_at"] is None
    assert report.failed == 1


def test_a_publication_the_gazette_reports_as_gone_is_retired_at_once(
        conn, settings):
    """410 Gone is the same fact as 404, stated more explicitly: the
    publication was there and has been withdrawn. Retrying it twice more
    burns two requests on a federal gazette to be told the same thing, and
    then leaves the row claimable-looking until the attempt counter catches
    up."""
    _seed(conn, HR)
    report = _run(settings, FakePortal(status={HR: 410}))

    row = _row(conn, HR)
    assert row["detail_attempts"] == shab_detail_stage.MAX_ATTEMPTS
    assert row["detail_error"] == "not_found"
    assert row["detail_fetched_at"] is None
    assert report.failed == 1


def test_a_body_that_does_not_parse_burns_an_attempt(conn, settings):
    _seed(conn, HR)
    report = _run(settings, FakePortal(bodies={HR: b"<html>maintenance</html>"}))

    row = _row(conn, HR)
    assert row["detail_attempts"] == 1
    assert row["detail_fetched_at"] is None
    assert row["detail_error"]
    assert report.failed == 1


def test_a_row_that_failed_is_not_offered_to_the_same_run_again(conn, settings):
    """A failure leaves the row claimable -- that is what lets tomorrow retry
    it -- so the claim query keeps offering it. Without a per-run poison set a
    nightly run would spend its whole budget re-fetching the same failures and
    burn all three attempts of each in one night. A batch that is nothing but
    this run's failures ends the run."""
    _seed(conn, HR)
    _seed(conn, HR03)
    portal = FakePortal(status={HR: 500, HR03: 500})
    report = _run(settings, portal, batch_size=2, retries=1)

    assert report.claimed == 2
    assert sorted(portal.ids) == sorted([HR, HR03])
    assert _row(conn, HR)["detail_attempts"] == 1
    assert _row(conn, HR03)["detail_attempts"] == 1


def test_a_run_keeps_claiming_past_a_whole_batch_of_failures(conn, settings):
    """The poison set is a per-run skip list, and applying it AFTER the claim
    capped the run at one batch: once it held BATCH_SIZE ids, every claim came
    back holding nothing else and the run stopped. A night whose first 500 rows
    all fail must still reach row 501, so the set is excluded IN the claim."""
    conn.execute("""
        INSERT INTO ch_shab_publications (shab_id, rubric, publication_date)
        SELECT 'sick-' || g, 'HR', DATE '2026-08-25' - g
          FROM generate_series(1, 600) AS g""")
    # 500s, not 404s: a 404 retires the row on the spot, so it would never be
    # offered again and the poison set would never be what stops the run.
    portal = FakePortal(status={f"sick-{n}": 500 for n in range(1, 601)})

    report = _run(settings, portal, retries=1)

    assert report.claimed == 600
    assert report.failed == 600
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_shab_publications WHERE detail_attempts = 0"
    ).fetchone()["n"] == 0


def test_the_poison_set_cannot_grow_without_bound(conn, settings, monkeypatch):
    """It is a per-run set held in memory and spliced into every claim, so a
    run against a dead endpoint must stop rather than accumulate 2.5M ids."""
    monkeypatch.setattr(shab_detail_stage, "MAX_POISONED", 2)
    for n in range(5):
        _seed(conn, f"missing-{n}")

    report = _run(settings, FakePortal(), batch_size=1, retries=1)

    assert report.claimed == 3          # 1, 2, then the third crosses the cap
    assert report.failed == 3
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_shab_publications WHERE detail_attempts = 0"
    ).fetchone()["n"] == 2


def test_one_failing_row_does_not_cost_the_rest_of_the_batch(conn, settings):
    _seed(conn, HR)
    _seed(conn, KK, rubric="KK")
    report = _run(settings, FakePortal(status={HR: 500}))

    assert _row(conn, KK)["detail_fetched_at"] is not None
    assert (report.fetched, report.failed) == (1, 1)


# --- limit, budget, politeness --------------------------------------------

def test_the_limit_caps_what_is_claimed(conn, settings):
    _seed(conn, HR)
    _seed(conn, KK, rubric="KK")
    report = _run(settings, FakePortal(), limit=1)
    assert report.claimed == 1


def test_the_budget_stops_the_loop_after_a_batch(conn, settings):
    """The nightly delta shares the box with live traffic, so it stops on the
    clock rather than when the 2.5M-row queue is drained. The check is BETWEEN
    batches: a batch already claimed is always finished."""
    _seed(conn, HR)
    _seed(conn, HR03)
    _seed(conn, KK, rubric="KK")
    report = _run(settings, FakePortal(), budget_seconds=0.0, batch_size=1)

    assert report.claimed == 1
    assert report.fetched == 1


def test_more_rows_than_one_batch_are_walked_in_batches(conn, settings,
                                                        monkeypatch):
    """Three rows against a batch of two: what this test is here to rule out
    is the whole queue being claimed in one go, and `claimed == 3` says
    nothing about that -- it is the same number either way. Count the claims.

    The batch size is what bounds how many publications are in flight and how
    much a killed run leaves half-done, so "it claimed twice" is the
    behaviour, not a detail of it."""
    real_claim = shab_detail_stage.claim
    claimed_per_call: list[int] = []

    def counting_claim(conn_, limit, exclude=()):
        rows = real_claim(conn_, limit, exclude)
        claimed_per_call.append(len(rows))
        return rows

    monkeypatch.setattr(shab_detail_stage, "claim", counting_claim)
    _seed(conn, HR)
    _seed(conn, HR03)
    _seed(conn, KK, rubric="KK")

    report = _run(settings, FakePortal(), batch_size=2)

    assert claimed_per_call == [2, 1, 0], "two full claims, then the drain"
    assert report.claimed == 3
    assert report.fetched == 3


def test_the_rate_limiter_spaces_requests_out(conn, settings):
    """50 requests/second means four requests take at least 3/50 s end to end
    -- measured, not asserted from the setting."""
    import time
    for shab_id, rubric in ((HR, "HR"), (HR03, "HR"), (KK, "KK"), (KK06, "KK")):
        _seed(conn, shab_id, rubric=rubric)
    started = time.monotonic()
    report = _run(settings, FakePortal(), rps=50.0)
    assert report.fetched == 4
    assert time.monotonic() - started >= 3 / 50.0


# --- entry point -----------------------------------------------------------

def test_main_reads_the_limit_and_the_budget_from_the_environment(
        monkeypatch, settings):
    seen = {}
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(shab_detail_stage.throttle, "renice", lambda *a: None)
    monkeypatch.setattr(shab_detail_stage, "run",
                        lambda s, **kw: seen.update(kw)
                        or shab_detail_stage.ShabDetailReport())
    monkeypatch.setenv("CHPIPE_LIMIT", "25")
    monkeypatch.setenv("CHPIPE_SHAB_BUDGET_SECONDS", "900")
    shab_detail_stage.main()
    assert seen["limit"] == 25
    assert seen["budget_seconds"] == 900.0


def test_an_unset_limit_and_budget_mean_no_limit_and_no_budget(
        monkeypatch, settings):
    """run-stage.sh exports its variables unconditionally, so "" must read as
    'unset', not as a limit of zero rows."""
    seen = {}
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(shab_detail_stage.throttle, "renice", lambda *a: None)
    monkeypatch.setattr(shab_detail_stage, "run",
                        lambda s, **kw: seen.update(kw)
                        or shab_detail_stage.ShabDetailReport())
    monkeypatch.setenv("CHPIPE_LIMIT", "")
    monkeypatch.setenv("CHPIPE_SHAB_BUDGET_SECONDS", "")
    shab_detail_stage.main()
    assert seen["limit"] is None
    assert seen["budget_seconds"] is None


# --- the SOCKS tunnel ------------------------------------------------------
#
# amtsblattportal.ch does not answer AWS IPs at all: the TCP connection hangs,
# from the same box on which LINDAS, Fedlex and entscheidsuche are all fine.
# The two SHAB stages therefore go out through a reverse SOCKS tunnel from the
# local server; zefix (LINDAS) and every other stage stay direct, so the proxy
# has to be wired per stage rather than into Fetcher or into the environment.

def _fetcher_spy(monkeypatch):
    """Record the Fetcher kwargs, then build a real Fetcher without the proxy.

    The proxy is dropped deliberately: httpx mounts an explicit `proxy=` at
    "all://", which takes precedence over the `transport=` this suite uses,
    so a Fetcher built with both would leave the MockTransport unused and
    open a real socket to a tunnel that does not exist here.
    """
    seen = {}
    real = shab_detail_stage.Fetcher

    def spy(**kwargs):
        seen.update(kwargs)
        return real(**{k: v for k, v in kwargs.items() if k != "proxy"})

    monkeypatch.setattr(shab_detail_stage, "Fetcher", spy)
    return seen


def test_the_configured_proxy_reaches_the_fetcher(conn, settings, monkeypatch):
    _seed(conn, HR)
    seen = _fetcher_spy(monkeypatch)
    proxied = dataclasses.replace(settings, shab_proxy="socks5h://127.0.0.1:1080")

    _run(proxied, FakePortal())

    assert seen["proxy"] == "socks5h://127.0.0.1:1080"


def test_no_proxy_is_configured_by_default(conn, settings, monkeypatch):
    """An unconfigured tunnel must not become a mount: passing None through is
    how the stage stays direct on a box that can reach the portal."""
    _seed(conn, HR)
    seen = _fetcher_spy(monkeypatch)

    _run(settings, FakePortal())

    assert seen["proxy"] is None


# --- CHPIPE_SHAB_CONCURRENCY -------------------------------------------
#
# Through the SOCKS tunnel to prod, throughput is roughly concurrency / RTT
# regardless of CHPIPE_SHAB_RPS, so a fixed CONCURRENCY = 4 capped a
# 2.5M-row detail backfill at ~5 req/s no matter how high the rate limiter
# was set. Settings.shab_concurrency (CHPIPE_SHAB_CONCURRENCY) has to
# actually reach the Fetcher this stage builds.

def test_the_configured_concurrency_reaches_the_fetcher(conn, settings, monkeypatch):
    _seed(conn, HR)
    seen = _fetcher_spy(monkeypatch)
    wide = dataclasses.replace(settings, shab_concurrency=16)

    _run(wide, FakePortal())

    assert seen["concurrency"] == 16


def test_the_default_concurrency_reaches_the_fetcher(conn, settings, monkeypatch):
    """settings fixture leaves shab_concurrency at its dataclass default (4),
    same as the old module-level CONCURRENCY constant."""
    _seed(conn, HR)
    seen = _fetcher_spy(monkeypatch)

    _run(settings, FakePortal())

    assert seen["concurrency"] == settings.shab_concurrency == 4
