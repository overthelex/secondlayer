"""Daily delta for both Swiss corpora.

Round 1 review (task-5-findings.md) found the comparison logic sound but
everything around it not fit to run unattended for a year: an unconditional
state save that retires real growth behind a swallowed listing failure or a
malformed snapshot (F2/F3), a withdrawn court invisible to spiders_that_grew
(F5), a WARNING that reported the wrong number (F9), a tautological test
(F10), and a spider/court_code mapping the round-1 report wrongly called a
research task instead of a query. This file's structure follows that review:
the pure-function tests from the brief and round 1 stay as they were (the
comparison logic they cover was upheld), and the fixes below each get a test
that fails on the pre-fix code -- verified by hand for every one of them
(see the fix-round-2 report for the red/green transcript).

court_code_spider_map() issues real SQL, so its own tests -- and every
run_decisions test that reaches a non-empty `grown` set, since run_decisions
now queries that map -- run against a real ch_court_decisions table via
CHPIPE_TEST_DSN, the same fixture shape test_index_stage.py and
test_fetch_stage.py already use. Tests that never get past an empty `grown`
set (nothing changed, or no snapshot found) still touch no database, since
run_decisions only opens a connection once it has something to look up.
"""
import datetime
import json
import logging
import os
import pathlib

import psycopg
import pytest

from chpipe import delta
from chpipe.config import Settings
from chpipe.stages import (acts_stage, diff_stage, extract_stage, fetch_stage,
                           fetch_xml_stage, index_stage, load_stage,
                           parse_akn_stage, project_legacy_stage,
                           provenance_stage, versions_stage)

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"


def test_snapshot_url_uses_the_iso_date():
    assert delta.snapshot_url(datetime.date(2026, 8, 20)) == \
        "https://entscheidsuche.ch/docs/Snapshots/2026-08-20.json"


def test_a_spider_whose_counter_grew_is_returned():
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 103}) == ["ZG_OG"]


def test_a_spider_with_an_unchanged_counter_is_not_returned():
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 100}) == []


def test_a_brand_new_spider_is_returned():
    assert delta.spiders_that_grew({}, {"XX_New": 5}) == ["XX_New"]


def test_a_shrinking_counter_is_returned_too():
    """A drop means the source withdrew documents. That is a change worth
    re-indexing and reporting, not something to ignore because it is not growth."""
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 97}) == ["ZG_OG"]


def test_results_are_sorted_for_a_stable_run_order():
    grown = delta.spiders_that_grew({}, {"ZH_OG": 1, "AG_Gerichte": 1, "BE_VG": 1})
    assert grown == ["AG_Gerichte", "BE_VG", "ZH_OG"]


def test_non_spider_keys_from_the_snapshot_are_dropped():
    """Snapshots.total is keyed by court code as well as spider name; a court
    code that matches no spider must not become a phantom re-index target."""
    grown = delta.spiders_that_grew({}, {"ZG_Obergericht": 1, "ZG_OG_001": 1})
    assert grown == ["ZG_Obergericht"]


# --- The nested-counter problem: canton and chamber rollups are noise ---

def test_a_bare_two_letter_canton_rollup_is_dropped():
    grown = delta.spiders_that_grew({}, {"ZH": 500, "ZH_OG": 12})
    assert grown == ["ZH_OG"]


def test_a_chamber_level_key_with_a_multi_digit_suffix_is_dropped():
    grown = delta.spiders_that_grew({}, {"CH_BGer": 9000, "CH_BGer_001": 40,
                                         "CH_BGer_012": 3})
    assert grown == ["CH_BGer"]


# --- F5: a court withdrawn so completely it vanishes from `current` ---
#
# Pre-fix, the comprehension iterated current.items() only, so a name absent
# from `current` never became a loop variable and could never be compared --
# spiders_that_grew({"ZG_Obergericht": 500}, {}) returned []. Verified by
# hand against the pre-fix code before writing this test.

def test_a_court_that_vanishes_entirely_from_current_is_returned():
    assert delta.spiders_that_grew({"ZG_Obergericht": 500}, {}) == ["ZG_Obergericht"]


def test_a_vanished_court_is_reported_alongside_an_unrelated_growth():
    grown = delta.spiders_that_grew({"ZG_Obergericht": 500, "CH_BGer": 100},
                                    {"CH_BGer": 103})
    assert grown == ["CH_BGer", "ZG_Obergericht"]


# --- court_code_spider_map: the mapping is a query, not a research task ---
#
# ch_court_decisions.court_code is written from the document JSON's own
# "Signatur" field (es_document.parse(), confirmed by reading the source and
# the ZG fixture: Signatur "ZG_OG_001", Spider "ZG_Obergericht") -- chamber
# granularity, one level finer than the court-code level `total`'s "rest"
# keys use. Stripping the same "_<digits>" suffix spiders_that_grew already
# treats as chamber noise recovers that level.

@pytest.fixture
def conn():
    if not os.environ.get("CHPIPE_TEST_DSN"):
        pytest.skip("CHPIPE_TEST_DSN not set")
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _seed(conn, ecli, spider, court_code):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, court_code) VALUES (%s,%s,%s)",
        (ecli, spider, court_code))


def test_court_code_spider_map_strips_the_chamber_suffix(conn):
    _seed(conn, "ECLI:1", "ZG_Obergericht", "ZG_OG_001")
    _seed(conn, "ECLI:2", "ZG_Obergericht", "ZG_OG_002")
    mapping = delta.court_code_spider_map(conn)
    assert mapping == {"ZG_OG": ("ZG_Obergericht",)}


def test_court_code_spider_map_is_partial_by_construction(conn):
    """A spider with zero rows contributes no entry -- that is the correct
    behaviour (see the function's own docstring), not a gap to paper over."""
    _seed(conn, "ECLI:1", "ZG_Obergericht", "ZG_OG_001")
    mapping = delta.court_code_spider_map(conn)
    assert "AG_Gerichte" not in mapping
    assert set(mapping.values()) == {("ZG_Obergericht",)}


def test_court_code_spider_map_keeps_every_spider_under_an_ambiguous_code(conn, caplog):
    """Two real spiders reporting under one stripped court code -- VD_TC on
    the loaded prod corpus (VD_TC_004 is VD_FindInfo's, VD_TC_031 is
    VD_Omni's). Keeping "the first one" routed the other's growth to a
    re-index that could never contain it. Both are kept, sorted, so the
    mapping is the same on every run."""
    _seed(conn, "ECLI:1", "AG_Weitere", "XX_YY_002")
    _seed(conn, "ECLI:2", "AG_Gerichte", "XX_YY_001")
    with caplog.at_level(logging.INFO):
        mapping = delta.court_code_spider_map(conn)
    assert mapping == {"XX_YY": ("AG_Gerichte", "AG_Weitere")}
    assert "re-indexes both" in caplog.text


def test_court_code_spider_map_drops_a_spider_that_is_no_longer_a_directory(
        conn, caplog):
    """N6: `spider` is whatever wrote the row. A value that no longer names
    a directory the pipeline walks would become a nightly re-index target
    for a listing that 404s, forever. It is dropped and logged; the court
    code then falls through to run_decisions()'s unmapped WARNING, which is
    the honest place for growth we cannot act on."""
    _seed(conn, "ECLI:1", "ZG_Obergericht", "ZG_OG_001")
    _seed(conn, "ECLI:2", "ZH_Handelsgericht_alt", "ZH_HG_001")
    with caplog.at_level(logging.WARNING):
        mapping = delta.court_code_spider_map(conn)
    assert mapping == {"ZG_OG": ("ZG_Obergericht",)}
    assert "ZH_Handelsgericht_alt" in caplog.text


def test_a_grown_key_whose_only_spider_is_stale_is_reported_as_unmapped(
        tmp_path, monkeypatch, conn, caplog):
    """The end-to-end consequence: nothing is dispatched, and the night is
    not reported as clean."""
    _seed(conn, "ECLI:1", "ZH_Handelsgericht_alt", "ZH_HG_001")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"ZH_HG": 12}, "total_alle": 12}
    seen = _stub_decision_stages(monkeypatch)

    with caplog.at_level(logging.WARNING):
        report = delta.run_decisions(
            _settings(tmp_path),
            fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    assert report.spiders == []
    assert seen["index"] is None
    assert "resolve to no spider" in caplog.text


# --- run_decisions: composition, monkeypatched at the stage boundary ---

def _settings(tmp_path):
    return Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=1,
                    cpu_workers=1, ocr_workers=1, load_ceiling=0.0,
                    max_attempts=3)


def _use_conn(monkeypatch, conn):
    """The same pattern test_index_stage.py uses to hand a fixture
    connection to code that calls db.connect(settings) internally."""
    monkeypatch.setattr(delta.db, "connect", lambda settings: conn)
    monkeypatch.setattr(conn, "close", lambda: None, raising=False)


class _FakeAsyncFetcher:
    def __init__(self, by_url: dict):
        self._by_url = by_url

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def json(self, url: str) -> dict:
        if url not in self._by_url:
            raise delta.FetchError(f"404 for {url}")
        return self._by_url[url]


def _stub_decision_stages(monkeypatch, inserted=0, failed_spiders=(),
                          failed_per_spider=None):
    seen = {"index": None, "fetch": [], "extract": [], "load": []}

    def fake_index(settings, spiders):
        seen["index"] = spiders
        return index_stage.IndexReport(
            inserted=inserted, failed_spiders=list(failed_spiders),
            failed_per_spider=dict(failed_per_spider or {}))

    def fake_fetch(settings, limit=None, spider=None):
        seen["fetch"].append(spider)
        return fetch_stage.FetchReport()

    def fake_extract(settings, limit=None, spider=None):
        seen["extract"].append(spider)
        return extract_stage.ExtractReport()

    def fake_load(settings, limit=None, spider=None):
        seen["load"].append(spider)
        return load_stage.LoadReport()

    monkeypatch.setattr(index_stage, "run", fake_index)
    monkeypatch.setattr(fetch_stage, "run", fake_fetch)
    monkeypatch.setattr(extract_stage, "run", fake_extract)
    monkeypatch.setattr(load_stage, "run", fake_load)
    return seen


def test_run_decisions_only_dispatches_names_that_are_real_spiders(
        tmp_path, monkeypatch, conn):
    """"ZH_OG" changed but is not a spider directory name and the corpus
    holds no court_code for it yet; "ZH_Obergericht" itself also changed and
    IS a real spider. Only the second may reach index_stage.run."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    snapshot = {"total": {"ZH_OG": 50, "ZH_Obergericht": 12}, "total_alle": 62}
    fetcher = _FakeAsyncFetcher({
        delta.snapshot_url(datetime.date(2026, 8, 20)): snapshot,
    })
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report.spiders == ["ZH_Obergericht"]
    assert seen["index"] == ["ZH_Obergericht"]
    assert seen["fetch"] == ["ZH_Obergericht"]
    assert seen["extract"] == ["ZH_Obergericht"]
    assert seen["load"] == ["ZH_Obergericht"]


def test_run_decisions_resolves_a_grown_key_through_the_court_code_map(
        tmp_path, monkeypatch, conn):
    """The core capability round 1 was missing: "ZH_OG" (entscheidsuche's
    own spelling) resolves to our spider "ZH_Obergericht" because the corpus
    already holds a chamber-level court_code ("ZH_OG_003") under that
    spider -- no hand-maintained table, no exact-name match needed."""
    _seed(conn, "ECLI:1", "ZH_Obergericht", "ZH_OG_003")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    snapshot = {"total": {"ZH_OG": 13}, "total_alle": 13}
    fetcher = _FakeAsyncFetcher({
        delta.snapshot_url(datetime.date(2026, 8, 20)): snapshot,
    })
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report.spiders == ["ZH_Obergericht"]
    assert seen["index"] == ["ZH_Obergericht"]


def test_run_decisions_falls_back_to_an_earlier_snapshot(tmp_path, monkeypatch, conn):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    older = datetime.date(2026, 8, 18)
    snapshot = {"total": {"ZG_Obergericht": 5}, "total_alle": 5}
    fetcher = _FakeAsyncFetcher({delta.snapshot_url(older): snapshot})
    _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report.spiders == ["ZG_Obergericht"]


def test_run_decisions_gives_up_quietly_after_four_missing_days(tmp_path, monkeypatch):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    fetcher = _FakeAsyncFetcher({})   # nothing published at any of the 4 URLs
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report == delta.DeltaReport()
    assert seen["index"] is None, "no snapshot means nothing to compare against"


def test_run_decisions_persists_state_so_an_unchanged_run_dispatches_nothing(
        tmp_path, monkeypatch, conn):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"ZG_Obergericht": 5}, "total_alle": 5}
    seen = _stub_decision_stages(monkeypatch)

    fetcher1 = _FakeAsyncFetcher({url: snapshot})
    first = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher1)
    assert first.spiders == ["ZG_Obergericht"]

    # A second run against an unchanged snapshot must find nothing grown --
    # proof the state file from the first run was actually written and read.
    fetcher2 = _FakeAsyncFetcher({url: snapshot})
    second = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher2)
    assert second == delta.DeltaReport()
    assert seen["index"] == ["ZG_Obergericht"], "unchanged from the first call"


def test_run_decisions_reports_documents_inserted_by_index_stage(
        tmp_path, monkeypatch, conn):
    """F10 fix: the stub's inserted count is independent of len(spiders),
    so a run_decisions that regresses to returning a bare DeltaReport() (the
    mutation the round-1 review used to prove the old test was a tautology:
    0 == 0*2 passed) now fails this assertion (0 != 41)."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"ZG_Obergericht": 5, "CH_BGer": 9}, "total_alle": 14}
    fetcher = _FakeAsyncFetcher({url: snapshot})
    _stub_decision_stages(monkeypatch, inserted=41)

    report = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher)

    assert report.new_documents == 41


# --- F2: a swallowed per-spider listing failure must not retire the night ---

def test_a_failed_listing_keeps_the_old_baseline_so_the_next_run_retries(
        tmp_path, monkeypatch, conn):
    """index_stage.run() swallows a listing failure into `failed_spiders`
    and returns normally -- it does not raise. Pre-fix, _save_state was
    unconditional: reproduced by hand, night 1 with the listing failing
    still wrote state {'CH_BGer': 100}, and night 2 against an unchanged
    snapshot found nothing grown and retried nothing."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch, inserted=0, failed_spiders=["CH_BGer"])

    fetcher1 = _FakeAsyncFetcher({url: snapshot})
    first = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher1)
    assert first.spiders == ["CH_BGer"]

    # Same snapshot again: if the failed listing had advanced the baseline,
    # this second call would see nothing grown. It must see CH_BGer again.
    fetcher2 = _FakeAsyncFetcher({url: snapshot})
    second = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher2)
    assert second.spiders == ["CH_BGer"], \
        "a spider whose listing failed must still look changed next run"


def test_a_failed_listing_with_no_prior_state_drops_the_key_entirely(
        tmp_path, monkeypatch, conn):
    """First-ever run, no snapshot-state.json yet: a failed listing must not
    plant a baseline for a spider we never actually walked."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch, inserted=0, failed_spiders=["CH_BGer"])

    fetcher = _FakeAsyncFetcher({url: snapshot})
    delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher)

    state = delta._load_state(_settings(tmp_path))
    assert "CH_BGer" not in state


# --- F3: a malformed snapshot must not be treated as a no-growth night ---

def test_a_snapshot_missing_the_total_key_is_not_accepted(tmp_path, monkeypatch):
    """Pre-fix, snapshot.get("total", {}) turned a missing key into {}
    silently -- byte-identical to a real no-growth night, and it overwrote
    the stored baseline with {}. Reproduced by hand from
    {"CH_BGer": 177809} to {}."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    fetcher = _FakeAsyncFetcher({url: {"generated": "2026-08-20", "total_alle": 5}})
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher)

    assert report == delta.DeltaReport()
    assert seen["index"] is None
    # No state file at all: a malformed snapshot must never look like the
    # successful pass that writes one.
    assert not delta._state_path(_settings(tmp_path)).exists()


def test_a_malformed_snapshot_does_not_clobber_a_good_prior_baseline(
        tmp_path, monkeypatch, conn):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    good_url = delta.snapshot_url(datetime.date(2026, 8, 20))
    good_snapshot = {"total": {"CH_BGer": 177809, "ZH_Obergericht": 5},
                     "total_alle": 177814}
    _stub_decision_stages(monkeypatch)
    delta.run_decisions(_settings(tmp_path),
                        fetcher_factory=lambda: _FakeAsyncFetcher({good_url: good_snapshot}))
    before = delta._load_state(_settings(tmp_path))
    assert before == good_snapshot["total"]

    # The next night, today's file parses but has lost its "total" map, and
    # nothing earlier in the lookback window is any better.
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 21))
    broken = _FakeAsyncFetcher({})   # every lookback URL 404s -- see below
    for offset in range(delta._SNAPSHOT_LOOKBACK_DAYS):
        day = datetime.date(2026, 8, 21) - datetime.timedelta(days=offset)
        broken._by_url[delta.snapshot_url(day)] = {"generated": str(day)}  # no "total"

    report = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: broken)

    assert report == delta.DeltaReport()
    after = delta._load_state(_settings(tmp_path))
    assert after == good_snapshot["total"], "the good baseline must survive untouched"


# --- F9: the WARNING reports the growth actually missed, not the stock ---

def test_unmapped_growth_warning_reports_the_miss_not_the_stock(
        tmp_path, monkeypatch, conn, caplog):
    """Pre-fix this summed current.get(name, 0) -- the STOCK of the
    unmapped court, constant on almost every real night -- instead of
    current - previous, the actual overnight change. Two unmapped courts:
    one grew by 3, one is untouched (present unchanged is impossible since
    spiders_that_grew already filters those out, so both here are "grown"
    in the union sense used above -- a withdrawal counts too, at 0 net
    growth after the floor)."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    # ZH_Obergericht IS a real spider (mapped exactly), grows by 2.
    # ZH_OG and VD_TC resolve to no spider by name and have no court_code
    # rows in the corpus (conn is empty), so both are unmapped; ZH_OG grows
    # by 3, VD_TC only had its stock recorded, not a delta -- give it 500
    # in `current` with 497 already in `previous` so its GROWTH is 3 too.
    snapshot = {"total": {"ZH_Obergericht": 14, "ZH_OG": 53, "VD_TC": 500},
               "total_alle": 567}
    state_path = delta._state_path(_settings(tmp_path))
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(
        {"ZH_Obergericht": 12, "ZH_OG": 50, "VD_TC": 497}))
    _stub_decision_stages(monkeypatch)

    with caplog.at_level(logging.WARNING):
        delta.run_decisions(_settings(tmp_path),
                            fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("6 of 8 detected new document(s) still unindexed" in msg
               for msg in warnings), warnings
    # The old (wrong) stock-based number would have been 53 + 500 = 553; it
    # must not appear anywhere in the log.
    assert not any("553" in msg for msg in warnings)


# --- F13: a real bug in the fetch path must not read like a routine 404 ---

def test_a_non_fetch_error_from_the_fetcher_is_logged_loudly(tmp_path, monkeypatch, caplog):
    """Pre-fix, `except Exception` at INFO made a broken fetcher_factory
    (e.g. one that raises TypeError because it was miswired) indistinguishable
    from the routine "not published yet" 404 for all four lookback attempts."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))

    def broken_factory():
        raise TypeError("simulated miswiring")

    with caplog.at_level(logging.INFO):
        report = delta.run_decisions(_settings(tmp_path), fetcher_factory=broken_factory)

    assert report == delta.DeltaReport()
    # Per-attempt warnings for the actual bug, kept apart from the separate
    # (and legitimate) top-level "no snapshot published" warning
    # run_decisions itself logs once nothing usable turned up at all.
    bug_warnings = [r for r in caplog.records if r.levelno == logging.WARNING
                    and "snapshot fetch at" in r.getMessage()]
    infos = [r for r in caplog.records if r.levelno == logging.INFO
            and "no snapshot at" in r.getMessage()]
    assert len(bug_warnings) == delta._SNAPSHOT_LOOKBACK_DAYS, \
        "every attempt hit the same bug and must be loud every time"
    assert infos == [], "a real defect must not also log as a routine miss"


# --- F12: the single-renice premise (NICE_IO == NICE_CPU) must not silently rot ---

def test_main_refuses_to_renice_once_if_the_two_priorities_diverge(monkeypatch):
    """The assertion fires before Settings.from_env(), so this needs no
    CHPIPE_DSN -- a diverged premise must be caught before main() gets
    anywhere near touching the environment or a stage."""
    from chpipe import throttle
    monkeypatch.setattr(throttle, "NICE_CPU", throttle.NICE_IO + 1)
    with pytest.raises(AssertionError):
        delta.main()


# --- run_legislation: acts and versions are cheap, so re-run both in full ---

def test_run_legislation_runs_acts_then_versions_then_drains_the_xml_queue(
        tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(acts_stage, "run",
                        lambda settings: calls.append("acts") or acts_stage.ActsReport())
    monkeypatch.setattr(
        versions_stage, "run",
        lambda settings: calls.append("versions") or
        versions_stage.VersionsReport(discovered=7))
    monkeypatch.setattr(
        fetch_xml_stage, "run",
        lambda settings, limit=None: calls.append("fetch-xml") or
        fetch_xml_stage.FetchXmlReport())
    monkeypatch.setattr(
        parse_akn_stage, "run",
        lambda settings, limit=None: calls.append("parse-akn") or
        parse_akn_stage.ParseReport())
    _stub_legislation_tail(monkeypatch, calls)

    report = delta.run_legislation(_settings(tmp_path))

    assert calls == ["acts", "versions", "fetch-xml", "parse-akn",
                     "project-legacy"]
    assert report.new_versions == 7


# --- N1: parsing an edition is not what makes it readable ---------------

def _stub_legislation_tail(monkeypatch, calls):
    def fake_diff(settings, lang="de", act_id=None):
        calls.append(f"diff({act_id},{lang})")
        return diff_stage.DiffReport(changes=3)

    def fake_provenance(settings, lang="de", limit=None, act_id=None):
        calls.append(f"provenance({act_id},{lang})")
        return provenance_stage.ProvenanceReport(rows=5)

    def fake_project(settings):
        calls.append("project-legacy")
        return 2

    monkeypatch.setattr(diff_stage, "run", fake_diff)
    monkeypatch.setattr(provenance_stage, "run", fake_provenance)
    monkeypatch.setattr(project_legacy_stage, "run", fake_project)


def _stub_legislation_head(monkeypatch, calls, acts):
    monkeypatch.setattr(acts_stage, "run",
                        lambda settings: calls.append("acts") or
                        acts_stage.ActsReport())
    monkeypatch.setattr(versions_stage, "run",
                        lambda settings: calls.append("versions") or
                        versions_stage.VersionsReport(discovered=1))
    monkeypatch.setattr(fetch_xml_stage, "run",
                        lambda settings, limit=None: calls.append("fetch-xml") or
                        fetch_xml_stage.FetchXmlReport())
    monkeypatch.setattr(parse_akn_stage, "run",
                        lambda settings, limit=None: calls.append("parse-akn") or
                        parse_akn_stage.ParseReport(parsed=len(acts), acts=set(acts)))


def test_a_newly_parsed_edition_gets_its_change_log_and_provenance(
        tmp_path, monkeypatch):
    """Stopping after parse-akn left every edition of an act carrying a
    change log, a provenance record and a served row EXCEPT the newest --
    the one a reader is most likely to ask about."""
    calls = []
    _stub_legislation_head(monkeypatch, calls, [(11, "de"), (11, "fr")])
    _stub_legislation_tail(monkeypatch, calls)

    report = delta.run_legislation(_settings(tmp_path))

    assert calls == ["acts", "versions", "fetch-xml", "parse-akn",
                     "diff(11,de)", "provenance(11,de)",
                     "diff(11,fr)", "provenance(11,fr)",
                     "project-legacy"]
    assert (report.new_changes, report.new_provenance, report.projected) == \
        (6, 10, 2)


def test_a_quiet_night_re_derives_nothing_but_still_projects(
        tmp_path, monkeypatch):
    """The narrowing is the point: with no act newly parsed, the nightly job
    must not re-walk 12,033 editions. project-legacy still runs -- it picks
    its own pending set, so it is one query on a quiet night and it is what
    recovers an edition an earlier run parsed and died before projecting."""
    calls = []
    _stub_legislation_head(monkeypatch, calls, [])
    _stub_legislation_tail(monkeypatch, calls)

    delta.run_legislation(_settings(tmp_path))

    assert [c for c in calls if c.startswith(("diff", "provenance"))] == []
    assert "project-legacy" in calls


# --- B3: many-to-one court code -> spider, and the rollback that lost it ---

def test_a_failed_listing_rolls_back_every_court_code_that_shares_the_spider(
        tmp_path, monkeypatch, conn):
    """`actionable` was keyed by spider with a single snapshot key as its
    value, so of two grown court codes resolving to one spider only the
    LAST survived -- and the failed-listing rollback restored only that one,
    advancing the other's baseline as though it had been walked. The
    2026-08-23 snapshot has 131 court-code keys against 54 spiders, so
    many-to-one is the NORMAL shape; the existing coverage seeded only
    CH_BGer, where spider and key are the same string.

    AG_OG and AG_VG both resolve to AG_Gerichte through the corpus-derived
    map, both grow, the listing for AG_Gerichte fails -- so NEITHER
    baseline may advance."""
    _seed(conn, "ECLI:1", "AG_Gerichte", "AG_OG_001")
    _seed(conn, "ECLI:2", "AG_Gerichte", "AG_VG_001")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"AG_OG": 10, "AG_VG": 20}, "total_alle": 30}
    _stub_decision_stages(monkeypatch, failed_spiders=["AG_Gerichte"])

    report = delta.run_decisions(
        _settings(tmp_path),
        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))
    assert report.spiders == ["AG_Gerichte"]

    state = delta._load_state(_settings(tmp_path))
    assert state == {}, (
        "a listing that failed must leave NO key it covered advanced; "
        f"got {state}")

    # And the very next run must see both courts as changed again.
    second = delta.run_decisions(
        _settings(tmp_path),
        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))
    assert second.spiders == ["AG_Gerichte"]


def test_both_court_codes_of_one_spider_reach_index_stage_once(
        tmp_path, monkeypatch, conn):
    """The flip side: two keys, one spider, one re-index -- not two."""
    _seed(conn, "ECLI:1", "AG_Gerichte", "AG_OG_001")
    _seed(conn, "ECLI:2", "AG_Gerichte", "AG_VG_001")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"AG_OG": 10, "AG_VG": 20}, "total_alle": 30}
    seen = _stub_decision_stages(monkeypatch)

    delta.run_decisions(_settings(tmp_path),
                        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    assert seen["index"] == ["AG_Gerichte"]
    assert seen["fetch"] == ["AG_Gerichte"]


# --- N4: growth on a key we cannot re-index must not be retired ---

def test_growth_on_an_unmapped_key_is_never_retired(tmp_path, monkeypatch, conn):
    """`next_state = dict(current)` advanced every key, unmapped ones
    included -- so the WARNING fired once, on the night the court grew, and
    those documents were never detected again. README's Deltas section tells
    the operator a RECURRING warning is the signal to act on, which held
    only while the court kept growing."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    # VD_TC resolves to no spider by name and the corpus (conn) is empty,
    # so nothing can index it. ZH_Obergericht is real and must advance.
    snapshot = {"total": {"VD_TC": 500, "ZH_Obergericht": 14}, "total_alle": 514}
    state_path = delta._state_path(_settings(tmp_path))
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"VD_TC": 497, "ZH_Obergericht": 12}))
    _stub_decision_stages(monkeypatch)

    delta.run_decisions(_settings(tmp_path),
                        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    state = delta._load_state(_settings(tmp_path))
    assert state["VD_TC"] == 497, "an unindexable court's baseline must not move"
    assert state["ZH_Obergericht"] == 14, "a walked spider's baseline must move"


def test_the_unmapped_warning_keeps_escalating_across_nights(
        tmp_path, monkeypatch, conn, caplog):
    """Because the baseline is held back, the reported figure is the
    OUTSTANDING unindexed count and grows every night the court does --
    which is what makes a recurring warning worth acting on."""
    _use_conn(monkeypatch, conn)
    _stub_decision_stages(monkeypatch)
    settings = _settings(tmp_path)
    state_path = delta._state_path(settings)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"VD_TC": 100}))

    seen = []
    for day, total in ((datetime.date(2026, 8, 20), 105),
                       (datetime.date(2026, 8, 21), 112)):
        monkeypatch.setattr(delta, "_today", lambda d=day: d)
        url = delta.snapshot_url(day)
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            delta.run_decisions(
                settings,
                fetcher_factory=lambda: _FakeAsyncFetcher(
                    {url: {"total": {"VD_TC": total}, "total_alle": total}}))
        seen.append([r.getMessage() for r in caplog.records
                     if r.levelno == logging.WARNING])

    assert any("5 of 5 detected new document(s) still unindexed" in m
               for m in seen[0]), seen[0]
    assert any("12 of 12 detected new document(s) still unindexed" in m
               for m in seen[1]), seen[1]


# --- Document-level failures must hold the baseline back too ---
#
# index_stage counts a document whose JSON 404s or decodes badly in
# report.failed and moves on, correctly. But the delta then advanced that
# court's snapshot counter anyway, so tomorrow saw no growth and those
# documents left the corpus permanently, in silence -- the same defect
# failed_spiders already closed one level up.

def test_growth_is_not_retired_for_a_spider_whose_documents_failed(
        tmp_path, monkeypatch, conn):
    """The listing loaded fine; two of its documents did not. Night 2 against
    the same snapshot must still see the court as changed."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch, inserted=98,
                          failed_per_spider={"CH_BGer": 2})

    first = delta.run_decisions(_settings(tmp_path),
                                fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))
    assert first.spiders == ["CH_BGer"]

    second = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))
    assert second.spiders == ["CH_BGer"], \
        "a court whose documents did not land must still look changed next run"


def test_a_document_failure_rolls_back_every_court_code_of_that_spider(
        tmp_path, monkeypatch, conn):
    """Several snapshot keys routinely resolve to one spider (the real
    2026-08-23 file carries 131 court codes against 54 spiders), and the
    baseline is keyed by snapshot key -- so rolling back one of them would
    retire the other court's growth as though it had been indexed."""
    _seed(conn, "ECLI:1", "AG_Gerichte", "AG_OG_001")
    _seed(conn, "ECLI:2", "AG_Gerichte", "AG_VG_001")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"AG_OG": 10, "AG_VG": 20}, "total_alle": 30}
    _stub_decision_stages(monkeypatch, failed_per_spider={"AG_Gerichte": 1})

    delta.run_decisions(_settings(tmp_path),
                        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    state = delta._load_state(_settings(tmp_path))
    assert "AG_OG" not in state and "AG_VG" not in state, \
        "both court codes of the spider must be held back, not one"


def test_a_clean_walk_still_advances_the_baseline(tmp_path, monkeypatch, conn):
    """The guard must fire on real failures only: a night where every
    document landed has to retire its growth, or the delta re-walks the whole
    corpus forever."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch, inserted=100,
                          failed_per_spider={"CH_BGer": 0})

    delta.run_decisions(_settings(tmp_path),
                        fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))
    second = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    assert second.spiders == []
    assert delta._load_state(_settings(tmp_path)) == {"CH_BGer": 100}


def test_a_document_level_failure_is_reported_at_warning(
        tmp_path, monkeypatch, conn, caplog):
    """Held-back growth that nobody is told about is just a delta that never
    finishes. The warning names the spider and how many of its documents did
    not land."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch, failed_per_spider={"CH_BGer": 3})

    with caplog.at_level(logging.WARNING):
        delta.run_decisions(_settings(tmp_path),
                            fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    assert any("CH_BGer:3" in r.getMessage() for r in caplog.records
               if r.levelno == logging.WARNING), caplog.text


# --- snapshot-state.json: written atomically, read defensively ---
#
# It is the one piece of state in this job that decides which documents are
# retired unfetched. A truncated write, or a crash on reading one, must not
# be able to cost a night's growth or the whole run.

def test_the_state_file_is_replaced_atomically_not_truncated_in_place(
        tmp_path, monkeypatch):
    """A direct write_text() truncates the existing file first, so a kill
    anywhere in the write leaves a prefix of the new map. Under os.replace()
    a failed write leaves the OLD file completely intact."""
    settings = _settings(tmp_path)
    delta._save_state(settings, {"CH_BGer": 100})

    real_replace = delta.os.replace
    monkeypatch.setattr(delta.os, "replace",
                        lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        delta._save_state(settings, {"CH_BGer": 200})
    monkeypatch.setattr(delta.os, "replace", real_replace)

    assert delta._load_state(settings) == {"CH_BGer": 100}, \
        "the previous baseline must survive a failed write whole"
    assert not list(tmp_path.glob("*.tmp")), \
        "a failed write must not leave its temp file behind"


def test_a_corrupt_state_file_is_a_loud_warning_not_a_crash(
        tmp_path, monkeypatch, caplog):
    """Letting json.loads raise takes the whole nightly job down over one
    unreadable file; swallowing it silently makes a full 54-spider re-walk
    look like a mystery. It reads as no baseline, and it says so."""
    settings = _settings(tmp_path)
    path = delta._state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"CH_BGer": 10')

    with caplog.at_level(logging.WARNING):
        state = delta._load_state(settings)

    assert state == {}
    assert any("unreadable" in r.getMessage() for r in caplog.records
               if r.levelno == logging.WARNING), caplog.text


def test_a_state_file_that_is_not_a_map_is_rejected_the_same_way(
        tmp_path, caplog):
    """Valid JSON, wrong shape -- a list indexes into nothing this code can
    use, and .get() on it raises deep inside spiders_that_grew()."""
    settings = _settings(tmp_path)
    path = delta._state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('["CH_BGer"]')

    with caplog.at_level(logging.WARNING):
        assert delta._load_state(settings) == {}
    assert any("not the counter map" in r.getMessage() for r in caplog.records)


def test_a_corrupt_state_file_makes_the_run_re_walk_rather_than_retire(
        tmp_path, monkeypatch, conn):
    """The safe direction, and the reason {} is an acceptable answer at all:
    no baseline means every court reads as changed, which costs a night of
    walking -- never a document."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    settings = _settings(tmp_path)
    path = delta._state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not json at all")
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"CH_BGer": 100}, "total_alle": 100}
    _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(settings,
                                 fetcher_factory=lambda: _FakeAsyncFetcher({url: snapshot}))

    assert report.spiders == ["CH_BGer"]


def test_run_decisions_reindexes_every_spider_under_an_ambiguous_court_code(
        tmp_path, monkeypatch, conn):
    """The VD_TC case end to end: one grown court-code key, two spiders with
    chambers under it, both walked. Pre-fix only the first was."""
    _seed(conn, "ECLI:1", "VD_FindInfo", "VD_TC_004")
    _seed(conn, "ECLI:2", "VD_Omni", "VD_TC_031")
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    _use_conn(monkeypatch, conn)
    snapshot = {"total": {"VD_TC": 40}, "total_alle": 40}
    fetcher = _FakeAsyncFetcher({
        delta.snapshot_url(datetime.date(2026, 8, 20)): snapshot,
    })
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert sorted(report.spiders) == ["VD_FindInfo", "VD_Omni"]
    assert sorted(seen["index"]) == ["VD_FindInfo", "VD_Omni"]
