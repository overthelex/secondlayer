"""Daily delta for both Swiss corpora.

delta.py never issues SQL of its own -- every write happens inside a stage
whose own test file already exercises it against real Postgres (see
test_index_stage.py, test_fetch_stage.py, test_acts_stage.py,
test_versions_stage.py). What is under test here is composition: which
stages get called, with which arguments, and how the entscheidsuche snapshot
comparison decides that. So these tests monkeypatch stage.run the same way
tests/test_entry_points.py does, and touch no database.
"""
import datetime
import pathlib

import pytest

from chpipe import delta
from chpipe.config import Settings
from chpipe.stages import (acts_stage, extract_stage, fetch_stage,
                           fetch_xml_stage, index_stage, load_stage,
                           parse_akn_stage, versions_stage)


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
#
# reports.completeness()'s docstring (chpipe/reports.py) measured the shape
# of Snapshots/{date}.json against the live 2026-08-20 file: `total` mixes
# three independent levels that each separately sum to `total_alle` -- a
# per-canton rollup (28 keys, e.g. "ZH"), a per-court-code level (131 keys,
# e.g. "ZH_OG"), and a per-chamber level (360 keys, e.g. "CH_BGer_001"). Only
# the chamber level carries the trailing "_NNN" shape already covered above;
# a bare two-letter canton rollup needs its own case, because nothing else
# distinguishes "ZH" (a rollup nobody can re-index) from a genuinely short
# spider name.

def test_a_bare_two_letter_canton_rollup_is_dropped():
    grown = delta.spiders_that_grew({}, {"ZH": 500, "ZH_OG": 12})
    assert grown == ["ZH_OG"]


def test_a_chamber_level_key_with_a_multi_digit_suffix_is_dropped():
    grown = delta.spiders_that_grew({}, {"CH_BGer": 9000, "CH_BGer_001": 40,
                                         "CH_BGer_012": 3})
    assert grown == ["CH_BGer"]


# --- run_decisions: snapshot fetch, fallback, and the ALL_SPIDERS gate ---
#
# spiders_that_grew is deliberately name-agnostic (it would otherwise fail
# the two tests above and the "XX_New"/"ZG_OG" cases): it returns whatever
# court-code-shaped key changed, whether or not that string is one of our 54
# spider directory names. reports.py's own completeness() gate found that
# only 7 of 54 match by exact string (entscheidsuche's "ZH_OG" is our
# "ZH_Obergericht"). Baking an ALL_SPIDERS filter into spiders_that_grew
# itself would just relocate that same 7-of-54 blind spot into the function
# everything else trusts. So the ALL_SPIDERS gate belongs one level up, in
# run_decisions, which is the only place that actually needs a real spider
# directory name to call index_stage.run. Keys that changed but match no
# spider name are real signal that must not be silently dropped -- see the
# "unmapped" assertions below.

class _FakeAsyncFetcher:
    """Stands in for chpipe.http.Fetcher: an async context manager whose
    .json(url) either returns a fixed payload or raises, keyed by url."""

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


def _settings(tmp_path):
    return Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=1,
                    cpu_workers=1, ocr_workers=1, load_ceiling=0.0,
                    max_attempts=3)


def _stub_decision_stages(monkeypatch):
    seen = {"index": None, "fetch": [], "extract": [], "load": []}

    def fake_index(settings, spiders):
        seen["index"] = spiders
        return index_stage.IndexReport(inserted=len(spiders) * 2)

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
        tmp_path, monkeypatch):
    """"ZH_OG" changed but is not a spider directory name (ours is
    "ZH_Obergericht"); "ZH_Obergericht" itself also changed and IS one.
    Only the second may reach index_stage.run -- handing "ZH_OG" to it would
    request https://entscheidsuche.ch/docs/ZH_OG/, a listing that does not
    exist under that name."""
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
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


def test_run_decisions_falls_back_to_an_earlier_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    # Today's and yesterday's files are not published yet; the one from two
    # days ago is -- "falls back up to three days" per the README.
    older = datetime.date(2026, 8, 18)
    snapshot = {"total": {"ZG_Obergericht": 5}, "total_alle": 5}
    fetcher = _FakeAsyncFetcher({delta.snapshot_url(older): snapshot})
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report.spiders == ["ZG_Obergericht"]


def test_run_decisions_gives_up_quietly_after_four_missing_days(
        tmp_path, monkeypatch):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    fetcher = _FakeAsyncFetcher({})   # nothing published at any of the 4 URLs
    seen = _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path),
                                 fetcher_factory=lambda: fetcher)

    assert report == delta.DeltaReport()
    assert seen["index"] is None, "no snapshot means nothing to compare against"


def test_run_decisions_persists_state_so_an_unchanged_run_dispatches_nothing(
        tmp_path, monkeypatch):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
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
        tmp_path, monkeypatch):
    monkeypatch.setattr(delta, "_today", lambda: datetime.date(2026, 8, 20))
    url = delta.snapshot_url(datetime.date(2026, 8, 20))
    snapshot = {"total": {"ZG_Obergericht": 5, "CH_BGer": 9}, "total_alle": 14}
    fetcher = _FakeAsyncFetcher({url: snapshot})
    _stub_decision_stages(monkeypatch)

    report = delta.run_decisions(_settings(tmp_path), fetcher_factory=lambda: fetcher)

    assert report.new_documents == len(report.spiders) * 2  # fake_index's rule


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

    report = delta.run_legislation(_settings(tmp_path))

    # versions is driven by ch_act (see versions_stage.run's own docstring),
    # and fetch-xml/parse-akn drain rows versions just discovered -- so the
    # call order is not a style choice, it is the dependency order.
    assert calls == ["acts", "versions", "fetch-xml", "parse-akn"]
    assert report.new_versions == 7
