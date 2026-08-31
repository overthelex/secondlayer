"""shab_list_stage.run(): amtsblattportal.ch list pages into ch_shab_publications.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test_d \
        python3 -m pytest services/ch-pipeline/tests/test_shab_list_stage.py

No live HTTP: every request goes through an httpx.MockTransport, so the real
Fetcher, the real URL builder and the real parser are all under test and only
the socket is fake.

Both fakes REFUSE any request with pageRequest.page > 0, exactly as the live
endpoint refuses one past offset 10,000 -- and unlike the live endpoint, which
answers the pages below that cap with silently duplicated and silently missing
rows (measured 2026-08-26: 2,000 publications over four pages of 500, 1,927 of
them distinct). A walk that finishes here is a walk that never paged.
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
from chpipe.stages import shab_list_stage

from conftest import apply_migration_202

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

TODAY = dt.date(2026, 8, 26)
FROM = dt.date(2026, 6, 1)
JUNE, JULY, AUGUST = dt.date(2026, 6, 1), dt.date(2026, 7, 1), dt.date(2026, 8, 1)

# Wider than any window the FakePortal tests hand out, so nothing splits unless
# a test means it to.
SIZE = 4


class Paged(AssertionError):
    """Raised through the transport if the stage ever asks for an offset."""


_PUBLICATION = """
  <publication ref="https://amtsblattportal.ch/api/v1/publications/{id}/xml">
    <meta>
      <id>{id}</id>
      <rubric>{rubric}</rubric>
      <subRubric>{sub_rubric}</subRubric>
      <language>de</language>
      <registrationOffice>
        <id>ffffffff-0000-0000-0000-000000000000</id>
        <displayName>Handelsregisteramt {canton}</displayName>
      </registrationOffice>
      <publicationNumber>{sub_rubric}-{number}</publicationNumber>
      <publicationState>PUBLISHED</publicationState>
      <publicationDate>{date}</publicationDate>
      <cantons>{canton}</cantons>
      <legalRemedy>boilerplate repeated on every publication</legalRemedy>
      <title>
        <de>{title_de}</de>
        <en>{title_en}</en>
        <it>{title_it}</it>
        <fr>{title_fr}</fr>
      </title>
    </meta>
  </publication>"""


def _page(total: int, publications: list[dict]) -> bytes:
    body = "".join(_PUBLICATION.format(**p) for p in publications)
    return ('<bulk:bulk-export xmlns:bulk="https://shab.ch/bulk-export">'
            f"<total>{total}</total>"
            "<pageRequest><page>0</page><size>0</size></pageRequest>"
            f"{body}</bulk:bulk-export>").encode("utf-8")


def _pub(uid: str, *, rubric="HR", sub_rubric="HR02", canton="ZG",
         date="2026-08-03", name="Enderli AG", seat="Uzwil", number="1000") -> dict:
    return {"id": uid, "rubric": rubric, "sub_rubric": sub_rubric,
            "canton": canton, "date": date, "number": number,
            "title_de": f"Mutation {name}, {seat}",
            "title_en": f"Change {name}, {seat}",
            "title_it": f"Cambiamenti {name}, {seat}",
            "title_fr": f"Mutation {name}, {seat}"}


def _query(url) -> dict:
    return dict(part.split("=", 1) for part in str(url).split("?", 1)[1].split("&"))


class FakePortal:
    """Answers from a {(rubric, month): page bytes} map, recording every URL.

    Does NOT model date windows -- these tests are about months, progress and
    upserts, and every fixture here is small enough that the stage never splits.
    DayPortal below is the one that models windowing.

    `fail` is a set of (rubric, month, size): size 1 is the probe, anything else
    is the fetch, which is the only difference between the two requests.
    """

    def __init__(self, pages: dict, fail: set | None = None):
        self.pages = pages
        self.fail = fail or set()
        self.urls: list[str] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def requested_months(self, rubric: str | None = None) -> list:
        seen = []
        for url in self.urls:
            key = self._key(url)
            if rubric and key[0] != rubric:
                continue
            if key[:2] not in seen:
                seen.append(key[:2])
        return [month for _, month in seen] if rubric else seen

    @staticmethod
    def _key(url):
        """(rubric, month, page, size) -- what the stage asked for."""
        q = _query(url)
        start = dt.date.fromisoformat(q["publicationDate.start"])
        return (q["rubrics"], start.replace(day=1), int(q["pageRequest.page"]),
                int(q["pageRequest.size"]))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        rubric, month, page, size = self._key(request.url)
        if page:
            raise Paged(f"the stage asked for page {page}")
        if (rubric, month, size) in self.fail:
            return httpx.Response(500, text="upstream on fire")
        return httpx.Response(200, content=self.pages.get(
            (rubric, month), _page(0, [])))


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


def _run(settings, portal, *, months=None, rubrics=("KK", "HR"),
         from_month=FROM, today=TODAY, size=SIZE):
    return shab_list_stage.run(settings, months=months, rubrics=rubrics,
                               from_month=from_month, today=today,
                               transport=portal.transport, size=size,
                               rps=0.0, backoff=0.0)


def _rows(conn):
    return {r["shab_id"]: r for r in conn.execute(
        "SELECT * FROM ch_shab_publications").fetchall()}


def _progress(conn):
    return {(r["rubric"], r["month"]): r for r in conn.execute(
        "SELECT * FROM ch_shab_progress").fetchall()}


THREE = {("HR", AUGUST): _page(3, [
    _pub("aaa", number="1001"),
    _pub("bbb", number="1002"),
    _pub("ccc", number="1003", name="Grisomed AG", seat="Chur")])}

# A month that is OVER at TODAY. AUGUST is the month TODAY falls in, so every
# assertion about freezing has to be made about a month like this one.
ONE_JULY = {("HR", JULY): _page(1, [
    _pub("jul", date="2026-07-02", number="2001")])}


# --- one window, one request -----------------------------------------------

def test_a_window_that_fits_is_fetched_in_one_request(conn, settings):
    portal = FakePortal(THREE)
    report = _run(settings, portal, rubrics=("HR",), from_month=AUGUST)

    assert sorted(_rows(conn)) == ["aaa", "bbb", "ccc"]
    assert report.pages == 1
    assert report.publications == 3
    assert report.upserted == 3
    assert report.months == 1


def test_a_month_is_probed_for_its_total_before_it_is_fetched(conn, settings):
    """The probe is a one-row request whose only job is the <total>: a window
    that does not fit in a page has to be split, and paying for 2,000
    publications to learn that is what the probe avoids."""
    portal = FakePortal(THREE)
    _run(settings, portal, rubrics=("HR",), from_month=AUGUST)
    assert [(k[3], k[2]) for k in map(FakePortal._key, portal.urls)] == [
        (1, 0), (SIZE, 0)]


def test_a_row_carries_the_parsed_name_seat_and_label(conn, settings):
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    row = _rows(conn)["ccc"]
    assert row["company_name"] == "Grisomed AG"
    assert row["seat"] == "Chur"
    assert row["canton"] == "ZG"
    assert row["rubric"] == "HR"
    assert row["sub_rubric"] == "HR02"
    assert row["publication_type"] == "Mutation"
    assert row["language"] == "de"
    assert row["publication_number"] == "HR02-1003"
    assert row["publication_date"] == dt.date(2026, 8, 3)
    assert row["title"] == "Mutation Grisomed AG, Chur"
    assert row["registration_office"] == "Handelsregisteramt ZG"


def test_the_metadata_json_keeps_the_titles_in_all_four_languages(conn, settings):
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    meta = _rows(conn)["ccc"]["metadata_json"]
    assert meta["titles"]["fr"] == "Mutation Grisomed AG, Chur"
    assert meta["titles"]["en"] == "Change Grisomed AG, Chur"


def test_an_empty_month_costs_exactly_one_request(conn, settings):
    """The probe says zero and there is nothing to fetch. Much of the backfill's
    640 (rubric, month) units are months before either rubric was published
    electronically at all."""
    portal = FakePortal({})
    report = _run(settings, portal, rubrics=("HR",), from_month=AUGUST)
    assert len(portal.urls) == 1
    assert report.months == 1
    assert report.publications == 0
    assert _progress(conn)[("HR", AUGUST)]["total"] == 0


# --- upsert ----------------------------------------------------------------

def test_a_second_run_updates_rather_than_duplicates(conn, settings):
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    conn.execute("DELETE FROM ch_shab_progress")
    renamed = {("HR", AUGUST): _page(1, [
        _pub("aaa", number="1001", name="Enderli Holding AG", seat="Uzwil")])}
    _run(settings, FakePortal(renamed), rubrics=("HR",), from_month=AUGUST)

    rows = _rows(conn)
    assert sorted(rows) == ["aaa", "bbb", "ccc"]
    assert rows["aaa"]["company_name"] == "Enderli Holding AG"


def test_a_re_listed_row_keeps_what_shab_detail_wrote(conn, settings):
    """The list page knows a title; the detail page knows the UID, the full
    text and the registered name. A nightly re-list of the same month must not
    blank any of that -- and must not overwrite the detail stage's better
    company_name/seat with its own guess from the title."""
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    conn.execute("""
        UPDATE ch_shab_publications
           SET company_uid = 'CHE-123.456.789', content = 'the full text',
               legal_form = 'Aktiengesellschaft', company_name = 'Enderli AG (BE)',
               seat = 'Bern', detail_fetched_at = now(), detail_attempts = 1,
               metadata_json = metadata_json || '{"capital": 100000}'::jsonb
         WHERE shab_id = 'aaa'""")
    conn.execute("DELETE FROM ch_shab_progress")
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    row = _rows(conn)["aaa"]
    assert row["company_uid"] == "CHE-123.456.789"
    assert row["content"] == "the full text"
    assert row["legal_form"] == "Aktiengesellschaft"
    assert row["detail_fetched_at"] is not None
    assert row["company_name"] == "Enderli AG (BE)"
    assert row["seat"] == "Bern"
    assert row["metadata_json"]["capital"] == 100000
    assert row["metadata_json"]["titles"]["de"] == "Mutation Enderli AG, Uzwil"


def test_a_row_without_a_detail_yet_does_take_the_new_title_parse(conn, settings):
    # No DELETE FROM ch_shab_progress: AUGUST is the current month, so the
    # second run walks it again on its own -- which is the whole point of not
    # stamping done_at until a month is over.
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    _run(settings, FakePortal({("HR", AUGUST): _page(1, [
        _pub("aaa", number="1001", name="Enderli AG", seat="Baden")])}),
        rubrics=("HR",), from_month=AUGUST)
    assert _rows(conn)["aaa"]["seat"] == "Baden"


# --- progress and resume ---------------------------------------------------

def test_a_finished_month_records_its_total_and_what_it_fetched(conn, settings):
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    row = _progress(conn)[("HR", AUGUST)]
    assert (row["total"], row["fetched"]) == (3, 3)
    # AUGUST is the month TODAY falls in: the counters are recorded, but the
    # month is not frozen, because publications are still landing in it.
    assert row["done_at"] is None


def test_a_month_that_is_over_is_not_requested_again(conn, settings):
    """done_at is what the skip list reads, and a month that is over cannot
    gain another publication, so that is when it is stamped. This is what
    makes the backfill killable and resumable at the month grain."""
    _run(settings, FakePortal(ONE_JULY), rubrics=("HR",), from_month=JULY)
    assert _progress(conn)[("HR", JULY)]["done_at"] is not None

    portal = FakePortal(ONE_JULY)
    report = _run(settings, portal, rubrics=("HR",), from_month=JULY)
    # JULY is frozen; AUGUST, the current month, is walked again every time.
    assert portal.requested_months("HR") == [AUGUST]
    assert report.pages == 0


def test_the_current_month_is_walked_again_the_next_night(conn, settings):
    """The nightly delta runs `months=2` against a month that is still being
    published into. A done_at stamped on the first night would put the month
    into the skip list and the delta would make zero requests -- and see zero
    new publications -- for the rest of that month."""
    night1 = FakePortal({("HR", AUGUST): _page(1, [_pub("aaa", number="1001")])})
    _run(settings, night1, months=2, rubrics=("HR",), from_month=FROM)
    assert sorted(_rows(conn)) == ["aaa"]

    night2 = FakePortal({("HR", AUGUST): _page(2, [
        _pub("aaa", number="1001"), _pub("bbb", number="1002")])})
    report = _run(settings, night2, months=2, rubrics=("HR",), from_month=FROM)

    assert night2.requested_months("HR") == [AUGUST]
    assert report.pages == 1
    assert sorted(_rows(conn)) == ["aaa", "bbb"]


def test_the_previous_month_is_frozen_only_once_it_is_over(conn, settings):
    """Walked on its own last day, JULY is still open and stays claimable;
    walked once the boundary has passed, the same month is frozen. That is the
    one extra walk `months=2` exists for: a publication backdated into last
    month after the boundary still lands."""
    _run(settings, FakePortal(ONE_JULY), rubrics=("HR",), from_month=JULY,
         today=dt.date(2026, 7, 31))
    assert _progress(conn)[("HR", JULY)]["done_at"] is None

    _run(settings, FakePortal(ONE_JULY), rubrics=("HR",), from_month=JULY,
         today=dt.date(2026, 8, 1))
    assert _progress(conn)[("HR", JULY)]["done_at"] is not None


def test_a_month_done_for_hr_is_still_walked_for_kk(conn, settings):
    """Progress is keyed (rubric, month): the two rubrics are separate walks."""
    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)
    portal = FakePortal({("KK", AUGUST): _page(1, [
        _pub("kk1", rubric="KK", sub_rubric="KK01", number="9")])})
    _run(settings, portal, rubrics=("KK",), from_month=AUGUST)
    assert portal.requested_months("KK") == [AUGUST]
    assert "kk1" in _rows(conn)


# --- month iteration -------------------------------------------------------

def test_every_month_from_the_start_to_today_is_walked(conn, settings):
    portal = FakePortal({})
    _run(settings, portal, rubrics=("HR",), from_month=FROM)
    assert portal.requested_months("HR") == [JUNE, JULY, AUGUST]


def test_the_current_month_is_included_even_though_it_is_not_over(conn, settings):
    portal = FakePortal({})
    _run(settings, portal, rubrics=("HR",), from_month=AUGUST)
    assert portal.requested_months("HR") == [AUGUST]


def test_delta_mode_walks_only_the_last_n_months(conn, settings):
    portal = FakePortal({})
    _run(settings, portal, months=2, rubrics=("HR",), from_month=FROM)
    assert portal.requested_months("HR") == [JULY, AUGUST]


def test_more_months_requested_than_exist_stops_at_the_start_month(conn, settings):
    portal = FakePortal({})
    _run(settings, portal, months=24, rubrics=("HR",), from_month=FROM)
    assert portal.requested_months("HR") == [JUNE, JULY, AUGUST]


def test_a_start_month_in_the_future_walks_nothing(conn, settings):
    portal = FakePortal({})
    report = _run(settings, portal, rubrics=("HR",),
                  from_month=dt.date(2026, 12, 1))
    assert portal.urls == []
    assert report.months == 0


def test_the_bankruptcy_rubric_is_walked_before_the_register(conn, settings):
    """KK is 215,853 publications against HR's 2,293,215 and is the half a
    due-diligence answer needs first."""
    portal = FakePortal({})
    _run(settings, portal, from_month=AUGUST)
    assert portal.requested_months() == [("KK", AUGUST), ("HR", AUGUST)]


# --- failure ---------------------------------------------------------------

def test_a_window_whose_fetch_fails_leaves_the_month_undone(conn, settings):
    portal = FakePortal(THREE, fail={("HR", AUGUST, SIZE)})
    report = _run(settings, portal, rubrics=("HR",), from_month=AUGUST)

    row = _progress(conn)[("HR", AUGUST)]
    assert row["done_at"] is None
    assert (row["total"], row["fetched"]) == (3, 0)
    assert report.months == 0
    assert _rows(conn) == {}


def test_a_failing_request_is_retried_before_the_month_is_given_up(conn, settings):
    """A 500 from a gazette is usually a moment, not a fact. The Fetcher's
    budget is what turns it back into a fetched window; a stage that gave up on
    the first non-200 would strand a month on every hiccup."""
    portal = FakePortal(THREE, fail={("HR", AUGUST, SIZE)})
    _run(settings, portal, rubrics=("HR",), from_month=AUGUST)
    attempts = [u for u in portal.urls if FakePortal._key(u)[3] == SIZE]
    assert len(attempts) == shab_list_stage.RETRIES


def test_an_undone_month_is_retried_by_the_next_run(conn, settings):
    _run(settings, FakePortal(ONE_JULY, fail={("HR", JULY, SIZE)}),
         rubrics=("HR",), from_month=JULY)
    assert _progress(conn)[("HR", JULY)]["done_at"] is None

    portal = FakePortal(ONE_JULY)
    _run(settings, portal, rubrics=("HR",), from_month=JULY)

    assert JULY in portal.requested_months("HR")
    assert sorted(_rows(conn)) == ["jul"]
    assert _progress(conn)[("HR", JULY)]["done_at"] is not None


def test_a_failed_month_does_not_stop_the_months_after_it(conn, settings):
    portal = FakePortal({("HR", JUNE): _page(1, [_pub("jun", date="2026-06-02")])},
                        fail={("HR", JUNE, SIZE)})
    report = _run(settings, portal, rubrics=("HR",), from_month=FROM)

    assert portal.requested_months("HR") == [JUNE, JULY, AUGUST]
    assert report.months == 2
    assert _progress(conn)[("HR", JUNE)]["done_at"] is None
    assert _progress(conn)[("HR", JULY)]["done_at"] is not None


def test_a_probe_that_fails_leaves_no_progress_claim_of_completeness(
        conn, settings):
    """Without a total there is nothing honest to write, so the month gets no
    row at all -- and the skip list is `done_at IS NOT NULL`, so it comes back."""
    portal = FakePortal(THREE, fail={("HR", AUGUST, 1)})
    report = _run(settings, portal, rubrics=("HR",), from_month=AUGUST)
    assert report.months == 0
    assert _progress(conn) == {}
    assert _rows(conn) == {}


def test_a_malformed_page_costs_only_its_own_month(conn, settings):
    """A body the parser cannot read is the same class of failure as a 500:
    it is about that one window, so the months after it are still walked."""
    portal = FakePortal(THREE)
    original = portal._handle

    def broken(request):
        if FakePortal._key(request.url)[1] == JUNE:
            portal.urls.append(str(request.url))
            return httpx.Response(200, content=b"<bulk:bulk-export>truncated")
        return original(request)

    portal._handle = broken
    report = _run(settings, portal, rubrics=("HR",), from_month=FROM)

    assert portal.requested_months("HR") == [JUNE, JULY, AUGUST]
    assert report.months == 2
    assert JUNE not in [month for _, month in _progress(conn)]


def test_a_database_failure_inside_a_month_is_not_reported_as_success(
        conn, settings, monkeypatch):
    """The per-month guard exists so one bad WINDOW does not cost the 300
    months behind it. Catching Exception there also swallowed psycopg saying
    the connection is gone: every remaining month then "failed" the same way,
    the stage exited 0, and the nightly log said nothing worse than a few
    ERROR lines. A DB fault is not a per-month problem -- let it out."""
    real_connect = shab_list_stage.db.connect

    class DeadOnMark:
        """The real connection, except that stamping progress raises."""

        def __init__(self, inner):
            self._inner = inner

        def execute(self, sql, params=None):
            if sql is shab_list_stage._MARK:
                raise psycopg.OperationalError(
                    "server closed the connection unexpectedly")
            return self._inner.execute(sql, params)

        def cursor(self):
            return self._inner.cursor()

        def close(self):
            self._inner.close()

    monkeypatch.setattr(shab_list_stage.db, "connect",
                        lambda s: DeadOnMark(real_connect(s)))

    portal = FakePortal(THREE)
    with pytest.raises(psycopg.OperationalError):
        _run(settings, portal, rubrics=("HR",), from_month=AUGUST)


# --- the URLs the stage builds ---------------------------------------------

def test_the_stage_asks_for_published_rows_of_one_rubric_and_one_month(
        conn, settings):
    portal = FakePortal({("HR", JUNE): _page(1, [_pub("x", date="2026-06-02")])})
    _run(settings, portal, rubrics=("HR",), from_month=JUNE, today=JUNE, size=2000)
    url = portal.urls[-1]
    assert "publicationStates=PUBLISHED" in url
    assert "rubrics=HR" in url
    assert "publicationDate.start=2026-06-01" in url
    assert "publicationDate.end=2026-06-30" in url
    assert "pageRequest.size=2000" in url
    assert "pageRequest.page=0" in url


# --- entry point -----------------------------------------------------------

def test_main_reads_the_month_window_from_the_environment(monkeypatch, settings):
    seen = {}
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(shab_list_stage, "run",
                        lambda s, **kw: seen.update(kw)
                        or shab_list_stage.ShabListReport())
    monkeypatch.setenv("CHPIPE_SHAB_MONTHS", "2")
    shab_list_stage.main()
    assert seen["months"] == 2


def test_an_unset_month_window_means_the_whole_backfill(monkeypatch, settings):
    """run-stage.sh exports its variables unconditionally, so "" must read as
    'no window', not as a window of zero months."""
    seen = {}
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(shab_list_stage, "run",
                        lambda s, **kw: seen.update(kw)
                        or shab_list_stage.ShabListReport())
    monkeypatch.setenv("CHPIPE_SHAB_MONTHS", "")
    shab_list_stage.main()
    assert seen["months"] is None


def test_the_start_month_comes_from_the_environment(monkeypatch, settings):
    monkeypatch.setenv("CHPIPE_SHAB_FROM", "2019-04")
    assert shab_list_stage.start_month() == dt.date(2019, 4, 1)
    monkeypatch.delenv("CHPIPE_SHAB_FROM")
    assert shab_list_stage.start_month() == dt.date(2000, 1, 1)
    monkeypatch.setenv("CHPIPE_SHAB_FROM", "")
    assert shab_list_stage.start_month() == dt.date(2000, 1, 1)


def test_the_rate_limit_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("CHPIPE_SHAB_RPS", "3.5")
    assert shab_list_stage.rate_limit() == 3.5
    monkeypatch.delenv("CHPIPE_SHAB_RPS")
    assert shab_list_stage.rate_limit() == 10.0


# --- windowing: the endpoint cannot be paged -------------------------------
#
# Measured live 2026-08-26 on the HR rubric: `page * size >= 10000` is a 400
# ("The 10000 maximum allowed search offset size exceeded"), and the pages
# BELOW that cap are not a partition -- 2026-08-03..04 reports total=2048 and
# four pages of 500 returned 2,000 rows of which 1,927 were distinct, because
# the result set has no stable order and `pageRequest.sortOrders` is ignored.
# The same window unpaged is exact. So the walk narrows the date range until
# every window fits in one page, and DayPortal is the endpoint with that
# behaviour: it truncates at `size` and raises on any page but the first.

class DayPortal:
    """A publication calendar behind the real windowing rules.

    Unlike FakePortal it answers by DATE WINDOW, so a narrower window really
    does return fewer rows -- which is the whole mechanism under test.
    """

    def __init__(self, days: dict):
        self.days = days                       # {date: number of publications}
        self.urls: list[str] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def windows(self) -> list[tuple[dt.date, dt.date]]:
        out = []
        for url in self.urls:
            q = _query(url)
            window = (dt.date.fromisoformat(q["publicationDate.start"]),
                      dt.date.fromisoformat(q["publicationDate.end"]))
            if window not in out:
                out.append(window)
        return out

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        q = _query(request.url)
        start = dt.date.fromisoformat(q["publicationDate.start"])
        end = dt.date.fromisoformat(q["publicationDate.end"])
        page, size = int(q["pageRequest.page"]), int(q["pageRequest.size"])
        if page:
            raise Paged(f"the stage asked for page {page}")
        ids = [f"{day:%Y%m%d}-{n}"
               for day in sorted(self.days)
               if start <= day <= end
               for n in range(self.days[day])]
        return httpx.Response(200, content=_page(len(ids), [
            _pub(i, date=f"{i[:4]}-{i[4:6]}-{i[6:8]}") for i in ids[:size]]))


def _walk(settings, portal, size, from_month=AUGUST, today=AUGUST, rps=0.0):
    return shab_list_stage.run(settings, rubrics=("HR",), from_month=from_month,
                               today=today, transport=portal.transport,
                               size=size, rps=rps, backoff=0.0)


def test_a_month_bigger_than_a_page_is_split_until_every_window_fits(
        conn, settings):
    """31 publications, four to a page. Unsplit this month would need an
    offset, and DayPortal raises on one."""
    portal = DayPortal({dt.date(2026, 8, d): 1 for d in range(1, 32)})
    report = _walk(settings, portal, size=4)

    assert len(_rows(conn)) == 31
    assert report.months == 1
    row = _progress(conn)[("HR", AUGUST)]
    assert (row["total"], row["fetched"]) == (31, 31)
    # `today` here is inside AUGUST, so the month is complete but not frozen:
    # report.months is what says the walk finished, done_at is what says the
    # month can never gain another publication.
    assert row["done_at"] is None


def test_the_split_halves_the_window_rather_than_walking_days(conn, settings):
    """A day-by-day walk of the corpus would be ~9,700 windows per rubric. The
    walk halves, and stops halving as soon as a half fits."""
    portal = DayPortal({dt.date(2026, 8, d): 1 for d in range(1, 32)})
    _walk(settings, portal, size=4)

    windows = portal.windows()
    assert (dt.date(2026, 8, 1), dt.date(2026, 8, 31)) in windows
    assert (dt.date(2026, 8, 1), dt.date(2026, 8, 16)) in windows
    assert (dt.date(2026, 8, 17), dt.date(2026, 8, 31)) in windows
    assert all(start != end for start, end in windows)


def test_a_window_that_fits_is_never_split(conn, settings):
    portal = DayPortal({dt.date(2026, 8, 3): 3})
    _walk(settings, portal, size=4)
    assert portal.windows() == [(dt.date(2026, 8, 1), dt.date(2026, 8, 31))]
    assert len(_rows(conn)) == 3


def test_the_walk_is_exact_when_every_window_fits(conn, settings):
    """The point of all the splitting: every publication in the month lands
    exactly once. Paging the same month against the live endpoint returned
    18,764 rows carrying only 18,437 distinct ids."""
    portal = DayPortal({dt.date(2026, 8, d): 3 for d in range(1, 32)})
    report = _walk(settings, portal, size=4)
    assert len(_rows(conn)) == 93
    assert report.publications == 93
    assert report.months == 1


def test_a_single_day_bigger_than_a_page_keeps_a_page_and_stays_undone(
        conn, settings):
    """Nothing left to split and paging is not an option. Taking the page and
    marking the month done would be a silent hole; the month stays undone and
    the progress row says how big the hole is."""
    portal = DayPortal({dt.date(2026, 8, 3): 15})
    report = _walk(settings, portal, size=4)

    assert report.months == 0
    row = _progress(conn)[("HR", AUGUST)]
    assert row["done_at"] is None
    assert (row["total"], row["fetched"]) == (15, 4)
    assert len(_rows(conn)) == 4


def test_a_month_that_grows_between_the_probe_and_the_fetch_stays_undone(
        conn, settings):
    """The current month is still being published into. If the window no longer
    fits the page it was probed for, the fetch is short and the month must not
    be claimed as complete -- which is why the total is re-read from the page
    that was actually served rather than trusted from the probe."""
    portal = DayPortal({dt.date(2026, 8, 3): 2})
    original = portal._handle

    def grow(request):
        response = original(request)
        portal.days[dt.date(2026, 8, 3)] = 9      # published while we walked
        return response

    portal._handle = grow
    report = _walk(settings, portal, size=4)

    assert report.months == 0
    assert _progress(conn)[("HR", AUGUST)]["done_at"] is None


def test_a_database_failure_inside_a_split_window_is_not_an_incomplete_month(
        conn, settings, monkeypatch):
    """Every modern month splits, so the halves run under
    `asyncio.gather(return_exceptions=True)` -- which handed a psycopg failure
    back as a value, logged it as a window that did not fit, and let the stage
    finish. The month-level guard never even saw it."""
    def dead(conn_, metas):
        raise psycopg.OperationalError("server closed the connection unexpectedly")

    monkeypatch.setattr(shab_list_stage, "_upsert", dead)
    portal = DayPortal({dt.date(2026, 8, d): 3 for d in range(1, 32)})
    with pytest.raises(psycopg.OperationalError):
        _walk(settings, portal, size=4)


def test_the_rate_limiter_spaces_requests_out(conn, settings):
    """50 requests/second means six requests take at least 5/50 s end to end --
    measured, not asserted from the setting."""
    import time
    portal = DayPortal({dt.date(2026, 8, d): 1 for d in range(1, 6)})
    started = time.monotonic()
    _walk(settings, portal, size=1, rps=50.0)
    assert len(portal.urls) >= 6
    assert time.monotonic() - started >= 5 / 50.0


# --- the SOCKS tunnel ------------------------------------------------------
#
# amtsblattportal.ch does not answer AWS IPs at all: the TCP connection hangs,
# from the same box on which LINDAS, Fedlex and entscheidsuche are all fine.
# The two SHAB stages therefore go out through a reverse SOCKS tunnel from the
# local server; zefix (LINDAS) and every other stage stay direct, so the proxy
# has to be wired per stage rather than into Fetcher or into the environment.

def _fetcher_spy(monkeypatch, module):
    """Record the Fetcher kwargs, then build a real Fetcher without the proxy.

    The proxy is dropped deliberately: httpx mounts an explicit `proxy=` at
    "all://", which takes precedence over the `transport=` this suite uses,
    so a Fetcher built with both would leave the MockTransport unused and
    open a real socket to a tunnel that does not exist here.
    """
    seen = {}
    real = module.Fetcher

    def spy(**kwargs):
        seen.update(kwargs)
        return real(**{k: v for k, v in kwargs.items() if k != "proxy"})

    monkeypatch.setattr(module, "Fetcher", spy)
    return seen


def test_the_configured_proxy_reaches_the_fetcher(conn, settings, monkeypatch):
    seen = _fetcher_spy(monkeypatch, shab_list_stage)
    proxied = dataclasses.replace(settings, shab_proxy="socks5h://127.0.0.1:1080")

    _run(proxied, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["proxy"] == "socks5h://127.0.0.1:1080"


def test_no_proxy_is_configured_by_default(conn, settings, monkeypatch):
    """An unconfigured tunnel must not become a mount: passing None through is
    how the stage stays direct on a box that can reach the portal."""
    seen = _fetcher_spy(monkeypatch, shab_list_stage)

    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["proxy"] is None


# --- the second uplink -------------------------------------------------------
#
# amtsblattportal.ch caps requests at roughly 50/s per source IP. Binding to
# the local server's second uplink is a second, independent per-IP quota.

def test_the_configured_local_address_reaches_the_fetcher(conn, settings,
                                                           monkeypatch):
    seen = _fetcher_spy(monkeypatch, shab_list_stage)
    bound = dataclasses.replace(settings, shab_local_address="203.0.113.7")

    _run(bound, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["local_address"] == "203.0.113.7"


def test_no_local_address_is_configured_by_default(conn, settings, monkeypatch):
    seen = _fetcher_spy(monkeypatch, shab_list_stage)

    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["local_address"] is None


# --- CHPIPE_SHAB_CONCURRENCY -----------------------------------------------
#
# Through the SOCKS tunnel to prod, throughput is roughly concurrency / RTT
# regardless of CHPIPE_SHAB_RPS, so a fixed CONCURRENCY = 4 capped a run at
# ~5 req/s no matter how high the rate limiter was set. Settings.shab_concurrency
# (CHPIPE_SHAB_CONCURRENCY) has to actually reach the Fetcher this stage builds.

def test_the_configured_concurrency_reaches_the_fetcher(conn, settings, monkeypatch):
    seen = _fetcher_spy(monkeypatch, shab_list_stage)
    wide = dataclasses.replace(settings, shab_concurrency=16)

    _run(wide, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["concurrency"] == 16


def test_the_default_concurrency_reaches_the_fetcher(conn, settings, monkeypatch):
    """settings fixture leaves shab_concurrency at its dataclass default (4),
    same as the old module-level CONCURRENCY constant."""
    seen = _fetcher_spy(monkeypatch, shab_list_stage)

    _run(settings, FakePortal(THREE), rubrics=("HR",), from_month=AUGUST)

    assert seen["concurrency"] == settings.shab_concurrency == 4
