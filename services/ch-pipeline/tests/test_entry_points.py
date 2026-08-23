"""Every stage's entry point honours CHPIPE_SPIDER.

This exact bug already shipped once: `index_stage`'s `__main__` read
`sys.argv` and never looked at `CHPIPE_SPIDER`, while `run-stage.sh` invokes
`python3 -m chpipe.stages.index_stage` with no argv at all and only exports
the env var. `./run-stage.sh index CH_BVGer` therefore walked all 54 spiders
in silence -- a full re-index of the corpus instead of one court -- and
nothing in the suite noticed, because the selection logic lived in an
`if __name__` block that no test can reach.

Each stage's entry point is now a `main()` function, and this file is the
test that could have caught it. `Settings.from_env` and each stage's `run`
are replaced so nothing touches a database or the network; what is under
test is the argument the entry point decides to pass.
"""
import pathlib

import pytest

from chpipe import config
from chpipe.stages import (extract_stage, fetch_stage, index_stage,
                           load_stage, ocr_stage)

FAKE = config.Settings(dsn="postgresql://unused@127.0.0.1:1/unused",
                       raw_dir=pathlib.Path("/tmp"), http_concurrency=1,
                       cpu_workers=1, ocr_workers=1, load_ceiling=0.0,
                       max_attempts=3)

CLAIMING_STAGES = [fetch_stage, extract_stage, ocr_stage, load_stage]


@pytest.fixture(autouse=True)
def no_env(monkeypatch):
    for key in ("CHPIPE_SPIDER", "CHPIPE_LIMIT"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(config.Settings, "from_env", classmethod(lambda cls: FAKE))


def _capture(monkeypatch, module):
    seen = {}

    def fake_run(settings, *args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return _report(module)

    monkeypatch.setattr(module, "run", fake_run)
    return seen


def _report(module):
    return {
        fetch_stage: fetch_stage.FetchReport,
        extract_stage: extract_stage.ExtractReport,
        ocr_stage: ocr_stage.OcrReport,
        load_stage: load_stage.LoadReport,
        index_stage: index_stage.IndexReport,
    }[module]()


@pytest.mark.parametrize("module", CLAIMING_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_a_stage_entry_point_honours_chpipe_spider(module, monkeypatch):
    seen = _capture(monkeypatch, module)
    monkeypatch.setenv("CHPIPE_SPIDER", "CH_BVGer")
    module.main()
    assert seen["kwargs"]["spider"] == "CH_BVGer"


@pytest.mark.parametrize("module", CLAIMING_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_an_unset_spider_means_all_spiders(module, monkeypatch):
    seen = _capture(monkeypatch, module)
    module.main()
    assert seen["kwargs"]["spider"] is None


@pytest.mark.parametrize("module", CLAIMING_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_an_empty_spider_means_all_spiders(module, monkeypatch):
    """run-stage.sh always exports CHPIPE_SPIDER, empty when no spider was
    given on its command line, so "" must not be treated as a spider name."""
    seen = _capture(monkeypatch, module)
    monkeypatch.setenv("CHPIPE_SPIDER", "")
    module.main()
    assert seen["kwargs"]["spider"] is None


@pytest.mark.parametrize("module", CLAIMING_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_a_stage_entry_point_honours_chpipe_limit(module, monkeypatch):
    seen = _capture(monkeypatch, module)
    monkeypatch.setenv("CHPIPE_LIMIT", "500")
    module.main()
    assert seen["kwargs"]["limit"] == 500


def test_index_honours_chpipe_spider_when_argv_is_empty(monkeypatch):
    """The shipped bug, exactly: run-stage.sh passes no argv."""
    seen = _capture(monkeypatch, index_stage)
    monkeypatch.setenv("CHPIPE_SPIDER", "CH_BVGer")
    index_stage.main(argv=[])
    assert seen["args"] == (["CH_BVGer"],)


def test_index_argv_wins_over_the_env_var(monkeypatch):
    """argv is the only way to pass more than one spider, so it keeps
    precedence for a direct invocation."""
    seen = _capture(monkeypatch, index_stage)
    monkeypatch.setenv("CHPIPE_SPIDER", "CH_BVGer")
    index_stage.main(argv=["SpiderA", "SpiderB"])
    assert seen["args"] == (["SpiderA", "SpiderB"],)


def test_index_with_neither_walks_every_spider(monkeypatch):
    seen = _capture(monkeypatch, index_stage)
    index_stage.main(argv=[])
    assert seen["args"] == (None,), "None means index_stage.ALL_SPIDERS"
