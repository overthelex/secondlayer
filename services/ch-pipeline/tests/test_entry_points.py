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
from chpipe.stages import (citations_stage, extract_stage, fetch_stage,
                           index_stage, load_stage, ocr_stage)

FAKE = config.Settings(dsn="postgresql://unused@127.0.0.1:1/unused",
                       raw_dir=pathlib.Path("/tmp"), http_concurrency=1,
                       cpu_workers=1, ocr_workers=1, load_ceiling=0.0,
                       max_attempts=3)

CLAIMING_STAGES = [fetch_stage, extract_stage, ocr_stage, load_stage, citations_stage]


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
        citations_stage: citations_stage.CitationsReport,
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
from chpipe.stages import (acts_stage, as_bbl_stage, basic_act_stage,
                           citations_resolve_stage, diff_stage, fetch_xml_stage,
                           parse_akn_stage, project_legacy_stage,
                           provenance_stage, versions_stage)

LEGISLATION_STAGES = [acts_stage, versions_stage, fetch_xml_stage,
                      parse_akn_stage, diff_stage, project_legacy_stage,
                      provenance_stage, as_bbl_stage, basic_act_stage,
                      citations_resolve_stage]

_LEG_REPORT = {
    acts_stage: lambda: acts_stage.ActsReport(),
    versions_stage: lambda: versions_stage.VersionsReport(),
    fetch_xml_stage: lambda: fetch_xml_stage.FetchXmlReport(),
    parse_akn_stage: lambda: parse_akn_stage.ParseReport(),
    diff_stage: lambda: diff_stage.DiffReport(),
    project_legacy_stage: lambda: 0,
    provenance_stage: lambda: provenance_stage.ProvenanceReport(),
    as_bbl_stage: lambda: as_bbl_stage.AsReport(),
    basic_act_stage: lambda: basic_act_stage.LinkReport(),
    citations_resolve_stage: lambda: citations_resolve_stage.ResolveReport(),
}

# Spec section 8. fetch-xml, acts and versions are network walks that still
# hold the GIL and a connection; parse-akn, diff and provenance are the CPU
# stages (provenance is parse_akn_stage's shape exactly -- a full-corpus
# lxml walk over the same TOASTed akn_xml payloads); project-legacy pushes
# ~15,000 full documents through a GIN-indexed table. as-bbl is a network
# walk over jolux:Act, the same shape as acts/versions; basic-act is a short
# join over rows those walks already discovered -- neither is a multi-hour
# CPU stage, so both take NICE_IO like acts/versions/fetch-xml/project-legacy.
# citations-resolve is four UPDATE ... FROM statements executed and waited
# on -- the work happens inside Postgres, not this process -- so it takes
# NICE_IO for the same reason aliases_stage does.
EXPECTED_NICE = {
    acts_stage: throttle.NICE_IO,
    versions_stage: throttle.NICE_IO,
    fetch_xml_stage: throttle.NICE_IO,
    parse_akn_stage: throttle.NICE_CPU,
    diff_stage: throttle.NICE_CPU,
    project_legacy_stage: throttle.NICE_IO,
    provenance_stage: throttle.NICE_CPU,
    as_bbl_stage: throttle.NICE_IO,
    basic_act_stage: throttle.NICE_IO,
    citations_resolve_stage: throttle.NICE_IO,
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


def test_provenance_honours_chpipe_lang(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, provenance_stage)
    monkeypatch.setenv("CHPIPE_LANG", "fr")
    provenance_stage.main()
    assert seen["kwargs"]["lang"] == "fr"


def test_provenance_defaults_to_german(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, provenance_stage)
    monkeypatch.delenv("CHPIPE_LANG", raising=False)
    provenance_stage.main()
    assert seen["kwargs"]["lang"] == "de"


def test_an_empty_lang_is_not_a_language_for_provenance(monkeypatch, no_renice):
    """The same run-stage.sh shape as diff's identical test above:
    CHPIPE_LANG is exported unconditionally, empty when no language was
    given on the command line."""
    seen = _capture_leg(monkeypatch, provenance_stage)
    monkeypatch.setenv("CHPIPE_LANG", "")
    provenance_stage.main()
    assert seen["kwargs"]["lang"] == "de"


def test_citations_resolve_honours_chpipe_cit_resolve_all(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, citations_resolve_stage)
    monkeypatch.setenv("CHPIPE_CIT_RESOLVE_ALL", "1")
    citations_resolve_stage.main()
    assert seen["kwargs"]["resolve_all"] is True


def test_citations_resolve_defaults_to_first_pass_only(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, citations_resolve_stage)
    monkeypatch.delenv("CHPIPE_CIT_RESOLVE_ALL", raising=False)
    citations_resolve_stage.main()
    assert seen["kwargs"]["resolve_all"] is False


def test_an_empty_chpipe_cit_resolve_all_is_not_a_yes(monkeypatch, no_renice):
    """run-stage.sh exports its variables unconditionally, so "" reaches the
    entry point whenever the flag was not set on the command line -- the
    same shape as the CHPIPE_SPIDER/CHPIPE_LANG bugs above."""
    seen = _capture_leg(monkeypatch, citations_resolve_stage)
    monkeypatch.setenv("CHPIPE_CIT_RESOLVE_ALL", "")
    citations_resolve_stage.main()
    assert seen["kwargs"]["resolve_all"] is False


def test_chpipe_cit_resolve_all_0_is_not_a_yes(monkeypatch, no_renice):
    seen = _capture_leg(monkeypatch, citations_resolve_stage)
    monkeypatch.setenv("CHPIPE_CIT_RESOLVE_ALL", "0")
    citations_resolve_stage.main()
    assert seen["kwargs"]["resolve_all"] is False


# --- the registries half ---
# zefix is neither a decisions stage (no CHPIPE_SPIDER) nor a legislation one
# (no CHPIPE_LANG), so it sits outside both parametrised lists above -- which
# is exactly how a stage ends up with no entry-point test at all.

from chpipe.stages import zefix_stage


def test_zefix_has_a_reachable_main_that_renices_at_nice_io(monkeypatch, no_renice):
    """A walk of 2,111 SPARQL queries on a box serving live traffic, the
    same shape as acts/versions."""
    monkeypatch.delenv("CHPIPE_ZEFIX_MUNICIPALITIES", raising=False)
    seen = {}
    monkeypatch.setattr(
        zefix_stage, "run",
        lambda settings, **kw: seen.update(kw) or zefix_stage.ZefixReport())
    zefix_stage.main()
    assert no_renice == [throttle.NICE_IO]
    assert seen["municipalities"] is None, "no selection means every municipality"


def test_zefix_honours_chpipe_zefix_municipalities(monkeypatch, no_renice):
    seen = {}
    monkeypatch.setattr(
        zefix_stage, "run",
        lambda settings, **kw: seen.update(kw) or zefix_stage.ZefixReport())
    monkeypatch.setenv("CHPIPE_ZEFIX_MUNICIPALITIES", "371,700")
    zefix_stage.main()
    assert seen["municipalities"] == [371, 700]


def test_an_empty_zefix_municipality_list_means_every_municipality(
        monkeypatch, no_renice):
    """run-stage.sh exports its variables unconditionally, so the nightly
    run reaches main() with CHPIPE_ZEFIX_MUNICIPALITIES="" -- and reading an
    empty selection as a selection is exactly the CHPIPE_SPIDER bug this
    file exists to prevent. An empty walk would also mean the sweep never
    runs, because a restricted run never sweeps."""
    seen = {}
    monkeypatch.setattr(
        zefix_stage, "run",
        lambda settings, **kw: seen.update(kw) or zefix_stage.ZefixReport())
    monkeypatch.setenv("CHPIPE_ZEFIX_MUNICIPALITIES", "")
    zefix_stage.main()
    assert seen["municipalities"] is None


# --- run-stage.sh's own usage line ---
# It read `index|fetch|extract|ocr|load` long after six more stages existed,
# and its wrapper is the only way any of them is actually invoked on prod.
# A name it accepts that resolves to no module is a stage nobody can run.

import importlib
import re

_RUN_STAGE = pathlib.Path(__file__).parent.parent / "run-stage.sh"


def _accepted_stage_names() -> set[str]:
    """The case labels run-stage.sh dispatches on, minus the `*` catch-all."""
    body = _RUN_STAGE.read_text()
    case = body[body.index("case \"$STAGE\" in"):body.index("esac")]
    names: set[str] = set()
    for label in re.findall(r"^\s{2}([a-z0-9|_-]+)\)", case, re.M):
        names.update(label.split("|"))
    return names


def test_run_stage_accepts_every_stage_this_package_has():
    expected = {"index", "fetch", "extract", "ocr", "load",
                "aliases", "citations", "citations-resolve",
                "acts", "versions", "fetch-xml", "parse-akn", "diff",
                "project-legacy", "provenance", "as-bbl", "basic-act",
                "zefix", "shab-list", "shab-detail",
                "lexfind-registry", "lexfind-versions", "cantonal-acts",
                "cantonal-fetch", "cantonal-parse", "cantonal-relink", "reports-cantonal",
                "sil-acts", "sil-fetch", "sil-parse", "ti-acts", "ti-fetch", "ti-parse"}
    assert _accepted_stage_names() == expected


def test_every_name_run_stage_accepts_resolves_to_a_module_with_a_main():
    for name in sorted(_accepted_stage_names()):
        module = importlib.import_module(
            f"chpipe.stages.{name.replace('-', '_')}_stage")
        assert callable(getattr(module, "main", None)), \
            f"run-stage.sh offers '{name}' but that module has no main()"


def test_the_usage_comment_names_every_stage_run_stage_accepts():
    """The usage line is what an operator reads at the keyboard, so it must
    list what the dispatcher actually takes -- all of it. Checking three
    hand-picked names, as this did, passes for a usage comment that names
    none of the stages added since it was written."""
    usage = "\n".join(
        line for line in _RUN_STAGE.read_text().splitlines()
        if line.startswith("#"))
    missing = sorted(name for name in _accepted_stage_names()
                     if name not in usage)
    assert missing == [], f"the usage comment does not mention {missing}"


# --- chpipe.delta: the one entry point run-stage.sh does NOT dispatch ---
#
# delta.main() has its own wrapper (run-delta.sh, a cron entry, not a
# run-stage.sh case label) and its own composition -- it calls
# run_decisions() and run_legislation() rather than a single stage `run()`.
# Round 1 review (task-5-findings.md, F11) found the load-bearing claim in
# delta.main()'s own docstring -- exactly one renice, at NICE_IO, standing
# in for every stage's own main() -- confirmed only by hand and kept true by
# nothing in the suite. These are the tests that reach it.

from chpipe import delta as delta_module


def _stub_resolve(monkeypatch, calls=None):
    """aliases_stage.run() and citations_resolve_stage.run() are the two
    guarded steps delta.main() runs after both halves -- stubbed out in every
    test below that reaches main() so neither opens a real connection against
    the FAKE dsn no_env hands out. Only the resolve call is recorded in
    `calls`: these tests are about main()'s composition of the two corpus
    halves, and the alias seed's own placement has its own test in
    tests/test_delta.py."""
    def fake(settings, resolve_all=False):
        if calls is not None:
            calls.append(settings)
        return delta_module.citations_resolve_stage.ResolveReport()

    monkeypatch.setattr(delta_module.citations_resolve_stage, "run", fake)
    # The cantonal step is a fourth guarded half; without a stub it would
    # read cantonal-state.json under the default raw_dir and, given a
    # baseline, page a real Lexwork host from inside the test suite.
    monkeypatch.setattr(delta_module, "run_cantonal",
                        lambda settings, transport=None: delta_module.DeltaReport())
    monkeypatch.setattr(
        delta_module.aliases_stage, "run",
        lambda settings: delta_module.aliases_stage.AliasReport())


def _stub_registries(monkeypatch, calls=None):
    """run_registries is the third independent guarded step delta.main()
    runs, alongside run_decisions/run_legislation -- stubbed out here for the
    same reason _stub_resolve exists: a real call would open a connection
    (zefix_stage.run) against the FAKE dsn no_env hands out and also reach
    the network. These tests are about main()'s composition, not
    run_registries' own behaviour (that has its own tests in
    tests/test_delta.py)."""
    def fake(settings):
        if calls is not None:
            calls.append(settings)
        return delta_module.RegistriesReport()

    monkeypatch.setattr(delta_module, "run_registries", fake)


def test_delta_main_is_reachable(monkeypatch, no_renice):
    """no_env (autouse) already patches Settings.from_env for every test in
    this file, delta.main() included."""
    monkeypatch.setattr(delta_module, "run_decisions",
                        lambda settings, **kw: delta_module.DeltaReport())
    monkeypatch.setattr(delta_module, "run_legislation",
                        lambda settings: delta_module.DeltaReport())
    _stub_registries(monkeypatch)
    _stub_resolve(monkeypatch)
    result = delta_module.main()
    assert isinstance(result, delta_module.DeltaReport)


def test_delta_main_renices_exactly_once_at_nice_io(monkeypatch, no_renice):
    monkeypatch.setattr(delta_module, "run_decisions",
                        lambda settings, **kw: delta_module.DeltaReport())
    monkeypatch.setattr(delta_module, "run_legislation",
                        lambda settings: delta_module.DeltaReport())
    _stub_registries(monkeypatch)
    _stub_resolve(monkeypatch)
    delta_module.main()
    assert no_renice == [throttle.NICE_IO], \
        "delta.main() must renice once, standing in for every stage's own main()"


def test_delta_main_refuses_to_renice_if_nice_io_and_nice_cpu_diverge(
        monkeypatch, no_renice):
    """F12: the single-renice call is only correct while the two constants
    are equal. A silent renice(NICE_IO) after they diverge would run
    parse-akn -- the one CPU-bound stage delta reaches -- at the wrong,
    irreversible priority with nothing left to notice."""
    monkeypatch.setattr(throttle, "NICE_CPU", throttle.NICE_IO + 1)
    with pytest.raises(AssertionError):
        delta_module.main()
    assert no_renice == [], "must fail before ever calling renice, not after"


def test_a_failing_decisions_half_does_not_skip_the_legislation_half(
        monkeypatch, no_renice):
    """The two corpora share no table and no failure mode, but a bare
    `run_decisions(); run_legislation()` coupled them: one SPARQL timeout on
    the decisions side and Fedlex is not walked at all that night, or any
    night after, until someone reads the traceback."""
    called = []

    def boom(settings, **kw):
        called.append("decisions")
        raise RuntimeError("entscheidsuche is down")

    def legislation(settings):
        called.append("legislation")
        return delta_module.DeltaReport(new_versions=4)

    monkeypatch.setattr(delta_module, "run_decisions", boom)
    monkeypatch.setattr(delta_module, "run_legislation", legislation)
    _stub_registries(monkeypatch)
    _stub_resolve(monkeypatch, called)

    # Still raises: run-delta.sh's marker reports the exit status, and a
    # night where half the job died must not print OK.
    with pytest.raises(RuntimeError, match="entscheidsuche is down"):
        delta_module.main()
    assert called == ["decisions", "legislation", FAKE]


def test_a_failing_legislation_half_still_reports_the_decisions_half(
        monkeypatch, no_renice, caplog):
    monkeypatch.setattr(
        delta_module, "run_decisions",
        lambda settings, **kw: delta_module.DeltaReport(
            spiders=["CH_BGer"], new_documents=9))
    monkeypatch.setattr(
        delta_module, "run_legislation",
        lambda settings: (_ for _ in ()).throw(RuntimeError("fedlex 503")))
    _stub_registries(monkeypatch)
    _stub_resolve(monkeypatch)

    with caplog.at_level("INFO"):
        with pytest.raises(RuntimeError, match="fedlex 503"):
            delta_module.main()
    summary = [r.getMessage() for r in caplog.records
               if r.getMessage().startswith("delta: spiders=")]
    assert summary == ["delta: spiders=['CH_BGer'] new_documents=9 "
                       "new_versions=0 new_changes=0 new_provenance=0 "
                       "projected=0 registries(zefix=0 shab_list=0 "
                       "shab_detail=0) "
                       "cantonal(acts=0 versions=0 changes=0 "
                       "projected=0 failed=none) "
                       "resolved(acts=0 editions=0 articles=0 "
                       "cases=0) failed=legislation"]


def test_citations_resolve_still_runs_once_when_a_half_failed(
        monkeypatch, no_renice):
    """citations-resolve is the third guarded step: it belongs after BOTH
    halves regardless of which one (if either) failed, since whatever raw
    edges citations_stage already wrote are worth resolving even on a night
    the legislation half died."""
    monkeypatch.setattr(delta_module, "run_decisions",
                        lambda settings, **kw: delta_module.DeltaReport())
    monkeypatch.setattr(
        delta_module, "run_legislation",
        lambda settings: (_ for _ in ()).throw(RuntimeError("fedlex 503")))
    _stub_registries(monkeypatch)
    calls = []
    _stub_resolve(monkeypatch, calls)

    with pytest.raises(RuntimeError, match="fedlex 503"):
        delta_module.main()

    assert calls == [FAKE]


# --- run-stage.sh must not clobber an env-only spider ---
# The first prod run of `index` was launched as
# `CHPIPE_SPIDER=CH_VB ./run-stage.sh index` and walked all 54 spiders: the
# wrapper exported its EMPTY positional argument over the env, and
# index_stage reads "" as "every spider". Exercised end to end with a stub
# python3 on PATH that prints the env the wrapper hands it.

import os
import stat
import subprocess


def _run_wrapper(tmp_path, monkeypatch, args, env_extra):
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    stub = stub_bin / "python3"
    stub.write_text("#!/bin/sh\nprintf 'SPIDER=%s LANG=%s\\n' "
                    "\"${CHPIPE_SPIDER-<unset>}\" \"${CHPIPE_LANG-<unset>}\"\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    home = tmp_path / "home"
    (home / "SecondLayer" / "deployment").mkdir(parents=True)
    (home / "SecondLayer" / "deployment" / ".env.prod").write_text("POSTGRES_PASSWORD=x\n")
    log_dir = tmp_path / "logs"
    env = {**os.environ, **env_extra,
           "PATH": f"{stub_bin}:{os.environ['PATH']}", "HOME": str(home)}
    body = _RUN_STAGE.read_text().replace("LOG_DIR=/data/ch-corpus/logs",
                                          f"LOG_DIR={log_dir}")
    script = tmp_path / "run-stage.sh"
    script.write_text(body)
    subprocess.run(["bash", str(script), *args], env=env, check=True,
                   capture_output=True)
    logs = list(log_dir.glob("*.log"))
    assert len(logs) == 1, logs
    return logs[0].name, logs[0].read_text().strip().splitlines()[-1]


def test_an_env_only_spider_survives_the_wrapper(tmp_path, monkeypatch):
    name, line = _run_wrapper(tmp_path, monkeypatch, ["index"],
                              {"CHPIPE_SPIDER": "CH_VB"})
    assert line == "SPIDER=CH_VB LANG=<unset>"
    assert name == "index-CH_VB.log", "the log is named for the effective spider too"


def test_a_positional_spider_still_wins_over_the_env(tmp_path, monkeypatch):
    _, line = _run_wrapper(tmp_path, monkeypatch, ["index", "ZH_Obergericht"],
                           {"CHPIPE_SPIDER": "CH_VB"})
    assert line == "SPIDER=ZH_Obergericht LANG=<unset>"


def test_no_spider_anywhere_still_means_all_spiders(tmp_path, monkeypatch):
    env = {k: v for k, v in os.environ.items() if k != "CHPIPE_SPIDER"}
    monkeypatch.setattr(os, "environ", env)
    _, line = _run_wrapper(tmp_path, monkeypatch, ["index"], {})
    assert line == "SPIDER= LANG=<unset>"


def test_a_leftover_lang_does_not_become_a_spider(tmp_path, monkeypatch):
    """The fallback is per family. `CHPIPE_LANG=fr ./run-stage.sh diff`
    followed by `./run-stage.sh index` in the same shell must still mean
    every spider -- not a single nonsense spider called "fr"."""
    _, line = _run_wrapper(tmp_path, monkeypatch, ["index"],
                           {"CHPIPE_LANG": "fr"})
    assert line.startswith("SPIDER= "), line


def test_a_leftover_spider_does_not_become_a_language(tmp_path, monkeypatch):
    _, line = _run_wrapper(tmp_path, monkeypatch, ["diff"],
                           {"CHPIPE_SPIDER": "CH_VB"})
    assert line == "SPIDER=CH_VB LANG=", "diff exports LANG=\"\" (its own default), never the spider"
