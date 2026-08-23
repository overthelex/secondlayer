"""CHPIPE_LOAD_CEILING has to be honoured by more than one stage.

Only `ocr` checked the load average, while the README claimed every stage
was throttled and spec section 8 assigns `nice 10` to index/fetch and three
workers to extract. `extract` is the multi-hour CPU stage -- measured ~17
CPU-hours for 800,000 documents, roughly 4 of 8 cores at cpu_workers=3 --
and it ran at normal priority, unthrottled, on a box serving live traffic.
"""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import throttle
from chpipe.config import Settings
from chpipe.stages import (extract_stage, fetch_stage, index_stage,
                           load_stage, ocr_stage)

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"


def test_pauses_at_or_above_the_ceiling():
    assert throttle.should_pause(load_ceiling=6.0, load1=6.0) is True
    assert throttle.should_pause(load_ceiling=6.0, load1=7.5) is True


def test_runs_below_the_ceiling():
    assert throttle.should_pause(load_ceiling=6.0, load1=5.9) is False


def test_a_zero_ceiling_disables_the_guard():
    assert throttle.should_pause(load_ceiling=0.0, load1=99.0) is False


def test_wait_for_capacity_returns_immediately_when_the_guard_is_off(monkeypatch):
    monkeypatch.setattr(throttle.time, "sleep",
                        lambda s: pytest.fail("must not sleep with the guard off"))
    throttle.wait_for_capacity(0.0, "extract")


def test_wait_for_capacity_blocks_until_the_load_drops(monkeypatch):
    readings = iter([9.0, 8.0, 2.0])
    slept = []
    monkeypatch.setattr(throttle.os, "getloadavg", lambda: (next(readings), 0, 0))
    monkeypatch.setattr(throttle.time, "sleep", slept.append)
    throttle.wait_for_capacity(6.0, "extract", pause_seconds=7)
    assert slept == [7, 7], "one pause per reading at or above the ceiling"


def test_renice_never_raises(monkeypatch):
    """A box that will not let us renice is a reason to warn, not to refuse
    to do the work."""
    def boom(_):
        raise OSError("not permitted")
    monkeypatch.setattr(throttle.os, "nice", boom)
    throttle.renice(10)


def test_every_stage_entry_point_lowers_its_priority(monkeypatch):
    """Spec section 8: index and fetch at nice 10, extract at 10, ocr at 19.
    Only ocr did this before, and it did it inside run(), which permanently
    reniced any caller -- including the test suite."""
    seen = []
    monkeypatch.setattr(throttle, "renice", seen.append)
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: _fake()))
    for key in ("CHPIPE_SPIDER", "CHPIPE_LIMIT"):
        monkeypatch.delenv(key, raising=False)

    for module, expected in ((index_stage, throttle.NICE_IO),
                             (fetch_stage, throttle.NICE_IO),
                             (extract_stage, throttle.NICE_CPU),
                             (ocr_stage, throttle.NICE_OCR)):
        seen.clear()
        monkeypatch.setattr(module, "run", lambda *a, **k: _report(module))
        module.main(argv=[]) if module is index_stage else module.main()
        assert seen == [expected], f"{module.__name__} did not renice"


def test_run_does_not_renice_its_caller(monkeypatch):
    """os.nice() is irreversible for a non-root process, so a run() that
    renices drags down everything that imports it. ocr_stage.run() used to."""
    monkeypatch.setattr(throttle.os, "nice",
                        lambda n: pytest.fail("run() must not renice"))
    monkeypatch.setattr(ocr_stage.os, "nice",
                        lambda n: pytest.fail("run() must not renice"))
    if not os.environ.get("CHPIPE_TEST_DSN"):
        pytest.skip("CHPIPE_TEST_DSN not set")
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("CREATE TABLE ch_court_decisions ("
                  "ecli text PRIMARY KEY, spider text NOT NULL, full_text text,"
                  "court_code text, court_name text, chamber text,"
                  "decision_type text, decision_date date, docket_number text,"
                  "parties text, abstract text, pdf_url text, json_url text,"
                  "languages text[], metadata_json jsonb,"
                  "imported_at timestamptz DEFAULT now(),"
                  "updated_at timestamptz DEFAULT now())")
        c.execute(MIGRATION.read_text())
        ocr_stage.run(_fake(dsn=os.environ["CHPIPE_TEST_DSN"]))


def test_extract_waits_for_capacity_before_claiming(monkeypatch):
    """The finding: extract had no guard at all."""
    calls = []
    monkeypatch.setattr(extract_stage.throttle, "wait_for_capacity",
                        lambda ceiling, stage, **kw: calls.append((ceiling, stage)))
    monkeypatch.setattr(extract_stage.db, "connect", lambda s: _NullConn())
    monkeypatch.setattr(extract_stage.db, "unkeyed_count", lambda *a, **k: 0)
    monkeypatch.setattr(extract_stage.db, "claim", lambda *a, **k: [])
    extract_stage.run(_fake(load_ceiling=6.0))
    assert calls == [(6.0, "extract")]


def test_ocr_still_waits_for_capacity_before_claiming(monkeypatch):
    calls = []
    monkeypatch.setattr(ocr_stage.throttle, "wait_for_capacity",
                        lambda ceiling, stage, **kw: calls.append((ceiling, stage)))
    monkeypatch.setattr(ocr_stage.db, "connect", lambda s: _NullConn())
    monkeypatch.setattr(ocr_stage.db, "unkeyed_count", lambda *a, **k: 0)
    monkeypatch.setattr(ocr_stage.db, "claim", lambda *a, **k: [])
    ocr_stage.run(_fake(load_ceiling=6.0))
    assert calls == [(6.0, "ocr")]


class _NullConn:
    def close(self):
        pass


def _fake(load_ceiling: float = 0.0, dsn: str = "postgresql://unused@127.0.0.1:1/unused") -> Settings:
    return Settings(dsn=dsn,
                    raw_dir=pathlib.Path("/tmp"), http_concurrency=1,
                    cpu_workers=1, ocr_workers=1, load_ceiling=load_ceiling,
                    max_attempts=3, retry_backoff_minutes=())


def _report(module):
    return {
        fetch_stage: fetch_stage.FetchReport,
        extract_stage: extract_stage.ExtractReport,
        ocr_stage: ocr_stage.OcrReport,
        load_stage: load_stage.LoadReport,
        index_stage: index_stage.IndexReport,
    }[module]()
