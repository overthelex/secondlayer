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
    for key in ("CHPIPE_SPIDER", "CHPIPE_LIMIT", "CHPIPE_LANG"):
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


# --- Finding 9 / finding 7: the legislation half's entry points ---
# All six new stages shipped as bare `if __name__ == "__main__":` blocks --
# the exact shape this file's own docstring says the package no longer uses,
# and the reason `index`'s spider filter could be broken without the suite
# noticing. They are `main()` functions now, and these are the tests that
# reach them.
#
# The renice assertions are finding 7 in the same place: spec section 8
# assigns fetch-xml nice 10 and the CPU stages a priority and a load
# ceiling, and not one legislation stage did either. throttle.py's own
# docstring records that running a multi-hour CPU stage at normal priority
# on a box serving live traffic was already a shipped defect once.

from chpipe import throttle
from chpipe.stages import (acts_stage, diff_stage, fetch_xml_stage,
                           parse_akn_stage, project_legacy_stage,
                           versions_stage)

LEGISLATION_STAGES = [acts_stage, versions_stage, fetch_xml_stage,
                      parse_akn_stage, diff_stage, project_legacy_stage]

_LEG_REPORT = {
    acts_stage: lambda: acts_stage.ActsReport(),
    versions_stage: lambda: versions_stage.VersionsReport(),
    fetch_xml_stage: lambda: fetch_xml_stage.FetchXmlReport(),
    parse_akn_stage: lambda: parse_akn_stage.ParseReport(),
    diff_stage: lambda: diff_stage.DiffReport(),
    project_legacy_stage: lambda: 0,
}

# Spec section 8. fetch-xml, acts and versions are network walks that still
# hold the GIL and a connection; parse-akn and diff are the CPU stages;
# project-legacy pushes ~15,000 full documents through a GIN-indexed table.
EXPECTED_NICE = {
    acts_stage: throttle.NICE_IO,
    versions_stage: throttle.NICE_IO,
    fetch_xml_stage: throttle.NICE_IO,
    parse_akn_stage: throttle.NICE_CPU,
    diff_stage: throttle.NICE_CPU,
    project_legacy_stage: throttle.NICE_IO,
}


def _capture_leg(monkeypatch, module):
    seen = {}

    def fake_run(settings, *args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return _LEG_REPORT[module]()

    monkeypatch.setattr(module, "run", fake_run)
    return seen


@pytest.fixture
def no_renice(monkeypatch):
    """os.nice() is irreversible for a non-root process, so the suite must
    never let a real one through -- the defect throttle.renice()'s own
    placement rule exists to prevent."""
    calls = []
    monkeypatch.setattr(throttle, "renice", calls.append)
    return calls


@pytest.mark.parametrize("module", LEGISLATION_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_every_legislation_stage_has_a_reachable_main(module, monkeypatch, no_renice):
    _capture_leg(monkeypatch, module)
    module.main()


@pytest.mark.parametrize("module", LEGISLATION_STAGES,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_every_legislation_stage_renices_in_main(module, monkeypatch, no_renice):
    """Not in run(): os.nice() is irreversible, so a run() that reniced
    would permanently drag down every caller that imports the module."""
    _capture_leg(monkeypatch, module)
    module.main()
    assert no_renice == [EXPECTED_NICE[module]]


@pytest.mark.parametrize("module", [fetch_xml_stage, parse_akn_stage],
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_the_claiming_legislation_stages_honour_chpipe_limit(module, monkeypatch,
                                                             no_renice):
    seen = _capture_leg(monkeypatch, module)
    monkeypatch.setenv("CHPIPE_LIMIT", "500")
    module.main()
    assert seen["kwargs"]["limit"] == 500


@pytest.mark.parametrize("module", [fetch_xml_stage, parse_akn_stage],
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_an_unset_limit_means_the_whole_queue(module, monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, module)
    module.main()
    assert seen["kwargs"]["limit"] is None


def test_diff_honours_chpipe_lang(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, diff_stage)
    monkeypatch.setenv("CHPIPE_LANG", "fr")
    diff_stage.main()
    assert seen["kwargs"]["lang"] == "fr"


def test_diff_defaults_to_german(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, diff_stage)
    monkeypatch.delenv("CHPIPE_LANG", raising=False)
    diff_stage.main()
    assert seen["kwargs"]["lang"] == "de"


def test_an_empty_lang_is_not_a_language(monkeypatch, no_renice):
    """run-stage.sh exports its variables unconditionally, so "" reaches
    the entry point whenever no language was given -- the same shape as the
    CHPIPE_SPIDER bug above."""
    seen = _capture_leg(monkeypatch, diff_stage)
    monkeypatch.setenv("CHPIPE_LANG", "")
    diff_stage.main()
    assert seen["kwargs"]["lang"] == "de"
