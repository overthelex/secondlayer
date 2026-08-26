"""chpipe.bench.run_oracle / chpipe.bench.report: the oracle answers every
benchmark item the same way ch_get_act_article resolves an edition + article
(see mcp_backend/src/api/tools/ch-legislation-tools.ts's getActArticle) --
directly from the database, no LLM in the loop -- and report.py turns the
resulting results-oracle.jsonl into per-(lang, system) label shares and a
"point-in-time grounding score". A mocked DB cannot validate the oracle's
SQL joins (same rule as test_bench_build_db.py), so this is a scratch-
database test that reuses test_bench_build_db.py's fixture via build.build().
"""
import datetime
import json
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.bench import build, report, run_oracle
from chpipe.config import Settings

from conftest import apply_migration_200

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

_NOW = datetime.datetime(2026, 8, 25, 12, 0, 0, tzinfo=datetime.timezone.utc)

# Identical fixture text to test_bench_build_db.py: paragraph 1 unchanged,
# paragraphs 2/3 materially reworded -- select_change() accepts it, and
# make_items() keeps both the before/after halves.
OLD_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts anderes "
    "vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung innerhalb von 180 Tagen "
    "gerichtlich anfechten."
)
NEW_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist richtet sich nach den Bestimmungen des "
    "Einzelarbeitsvertrags, sofern nichts anderes vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung nur durch eine schriftliche "
    "Klage beim zuständigen Gericht anfechten."
)


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                docket_number text,
                stage text
            )
        """)
        c.execute(MIGRATION_197.read_text())
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        c.execute("TRUNCATE ch_act_change, ch_act_alias, ch_act_article, "
                  "ch_act_version, ch_act RESTART IDENTITY CASCADE")
        yield c


def _act(conn, act_id, sr_number, abbreviation=None, enforcement_status=0,
         date_entry_force=None):
    conn.execute(
        "INSERT INTO ch_act (act_id, eli_work_uri, sr_number, abbreviation, "
        "enforcement_status, date_entry_force) VALUES (%s, %s, %s, %s, %s, %s)",
        (act_id, f"https://x/act/{act_id}", sr_number, abbreviation, enforcement_status,
         date_entry_force))


def _version(conn, version_id, act_id, lang, date_applicability, date_end_applicability=None):
    conn.execute(
        "INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, lang, "
        "date_applicability, date_end_applicability, stage) "
        "VALUES (%s, %s, %s, %s, %s, %s, 'parsed')",
        (version_id, act_id, f"https://x/act/{act_id}/{version_id}", lang,
         date_applicability, date_end_applicability))


def _article(conn, version_id, e_id, article_number, text, ordinal=0):
    conn.execute(
        "INSERT INTO ch_act_article (version_id, e_id, article_number, text, ordinal) "
        "VALUES (%s, %s, %s, %s, %s)",
        (version_id, e_id, article_number, text, ordinal))


def _change(conn, act_id, lang, from_version_id, to_version_id, e_id, article_number,
           date_applicability, change_type="modified"):
    conn.execute(
        "INSERT INTO ch_act_change (act_id, lang, from_version_id, to_version_id, "
        "e_id, article_number, change_type, date_applicability) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (act_id, lang, from_version_id, to_version_id, e_id, article_number,
         change_type, date_applicability))


@pytest.fixture
def seeded(conn):
    """One in-force act (SR 220, abbreviation OR in German, alias CO curated
    in French), two editions each for de/fr, and one real 'modified' change
    (art_336) per language -- same shape as test_bench_build_db.py's
    `seeded` fixture, trimmed to the one change that actually survives
    build() (art_337 there exists only to prove near-identical pairs get
    skipped, which is not this file's concern).
    """
    old_date = datetime.date(2015, 1, 1)
    old_end_date = datetime.date(2020, 12, 31)
    change_date = datetime.date(2021, 1, 1)

    _act(conn, 1, "220", abbreviation="OR", enforcement_status=0)
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source) "
        "VALUES ('CO', 'fr', '220', 'curated')")

    # date_end_applicability is INCLUSIVE -- see run_oracle.py's module
    # docstring for the prod evidence. The old edition's last day in force
    # is 2020-12-31, the new edition's date_applicability is 2021-01-01.
    _version(conn, 101, 1, "de", old_date, old_end_date)
    _version(conn, 102, 1, "de", change_date, None)
    _version(conn, 103, 1, "fr", old_date, old_end_date)
    _version(conn, 104, 1, "fr", change_date, None)

    for old_v, new_v in ((101, 102), (103, 104)):
        _article(conn, old_v, "art_336", "336", OLD_TEXT)
        _article(conn, new_v, "art_336", "336", NEW_TEXT)

    _change(conn, 1, "de", 101, 102, "art_336", "336", change_date)
    _change(conn, 1, "fr", 103, 104, "art_336", "336", change_date)

    return conn


def _read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_oracle_answers_every_item_grounded_correct_with_no_errors(settings, seeded, tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "results"
    build.build(settings, langs=("de", "fr"), out_dir=items_dir, now=_NOW)

    run_report = run_oracle.run(settings, items_path=items_dir, out_path=out_dir,
                                langs=("de", "fr"))

    assert run_report.items == 4  # 2 langs x (before, after)
    assert run_report.answered == 4
    assert run_report.errors == 0

    results = _read_jsonl(out_dir / "results-oracle.jsonl")
    assert len(results) == 4
    for r in results:
        assert r["system"] == "oracle"
        assert "oracle_error" not in r
        assert r["verdict"]["label"] == "grounded_correct"


def test_oracle_resolves_both_sides_of_the_inclusive_end_date_boundary(
        settings, seeded, tmp_path):
    """The 'before' item's as_of (change_date - 1 day = 2020-12-31) lands
    exactly on the old edition's date_end_applicability, and the 'after'
    item's as_of (change_date = 2021-01-01) lands exactly on the new
    edition's date_applicability -- both must resolve to real article text,
    the old edition on the boundary day and the new edition from its first
    day, with no oracle_error and the answer grounded in the RIGHT edition
    (not just any edition)."""
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "results"
    build.build(settings, langs=("de",), out_dir=items_dir, now=_NOW)

    de_items = {it["kind"]: it for it in _read_jsonl(items_dir / "bench-de.jsonl")}
    assert de_items["before"]["as_of"] == "2020-12-31"
    assert de_items["after"]["as_of"] == "2021-01-01"

    run_oracle.run(settings, items_path=items_dir, out_path=out_dir, langs=("de",))
    results = {r["id"]: r for r in _read_jsonl(out_dir / "results-oracle.jsonl")}

    before = results[de_items["before"]["id"]]
    after = results[de_items["after"]["id"]]

    assert "oracle_error" not in before, "2020-12-31 is still covered -- the old edition's last day"
    assert before["answer"] == OLD_TEXT
    assert before["verdict"]["label"] == "grounded_correct"

    assert "oracle_error" not in after, "2021-01-01 is the new edition's first day"
    assert after["answer"] == NEW_TEXT
    assert after["verdict"]["label"] == "grounded_correct"


def test_oracle_records_error_and_ungrounded_for_a_date_before_the_earliest_edition(
        settings, seeded, tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "results"
    build.build(settings, langs=("de",), out_dir=items_dir, now=_NOW)
    de_items = _read_jsonl(items_dir / "bench-de.jsonl")
    template_item = de_items[0]

    # A hand-written item whose as_of predates the earliest edition
    # (old_date = 2015-01-01) entirely -- the oracle must find no covering
    # edition at all.
    bad_item = dict(template_item)
    bad_item["id"] = "0" * 16
    bad_item["as_of"] = "2000-01-01"
    bad_item["kind"] = "before"

    bad_items_dir = tmp_path / "bad-items"
    bad_items_dir.mkdir()
    (bad_items_dir / "bench-de.jsonl").write_text(json.dumps(bad_item, ensure_ascii=False) + "\n")

    run_report = run_oracle.run(settings, items_path=bad_items_dir, out_path=out_dir,
                                langs=("de",))

    assert run_report.items == 1
    assert run_report.answered == 0
    assert run_report.errors == 1

    results = _read_jsonl(out_dir / "results-oracle.jsonl")
    assert len(results) == 1
    assert results[0]["oracle_error"]
    assert results[0]["answer"] == ""
    assert results[0]["verdict"]["label"] == "ungrounded"


def test_oracle_resolves_by_act_id_when_two_acts_share_a_sr_number(
        settings, conn, tmp_path):
    """Reproduces the diagnosed cause of the 135 'after' items that still
    came back no_edition_for_date on prod after the inclusive-end fix alone:
    a second ch_act row can share the item's sr_number (e.g. a predecessor
    act refiled under the same SR number) and outrank the real one on
    run_oracle's old sr_number tiebreak (enforcement_status = 0, then latest
    date_entry_force) -- landing on an act whose editions do not cover the
    date at all, even though the correct act (and its editions) exist.
    act_id, stamped on every item by build.py's make_items(), sidesteps the
    tiebreak entirely."""
    old_date = datetime.date(2015, 1, 1)
    old_end_date = datetime.date(2020, 12, 31)
    change_date = datetime.date(2021, 1, 1)

    # The real act: earlier date_entry_force, owns the change and both
    # editions.
    _act(conn, 1, "220", abbreviation="OR", enforcement_status=0,
         date_entry_force=datetime.date(1912, 1, 1))
    _version(conn, 101, 1, "de", old_date, old_end_date)
    _version(conn, 102, 1, "de", change_date, None)
    _article(conn, 101, "art_336", "336", OLD_TEXT)
    _article(conn, 102, "art_336", "336", NEW_TEXT)
    _change(conn, 1, "de", 101, 102, "art_336", "336", change_date)

    # A decoy sharing sr_number "220": later date_entry_force, so the old
    # sr_number-only ORDER BY (enforcement_status = 0 DESC, date_entry_force
    # DESC) picks THIS act -- which has no edition covering either as_of.
    _act(conn, 2, "220", abbreviation="OR", enforcement_status=0,
         date_entry_force=datetime.date(2020, 1, 1))

    items_dir = tmp_path / "items"
    out_dir = tmp_path / "results"
    build.build(settings, langs=("de",), out_dir=items_dir, now=_NOW)

    de_items = _read_jsonl(items_dir / "bench-de.jsonl")
    assert all(it["act_id"] == 1 for it in de_items), \
        "the item is built from act 1's own ch_act_change row, unaffected by the decoy"

    run_report = run_oracle.run(settings, items_path=items_dir, out_path=out_dir, langs=("de",))
    assert run_report.errors == 0
    results = _read_jsonl(out_dir / "results-oracle.jsonl")
    assert all("oracle_error" not in r for r in results)
    assert all(r["verdict"]["label"] == "grounded_correct" for r in results)

    # The regression this guards against: resolving by sr_number alone (no
    # act_id on the item) lands on the decoy act and fails.
    legacy_items_dir = tmp_path / "legacy-items"
    legacy_items_dir.mkdir()
    legacy_lines = []
    for item in de_items:
        legacy_item = dict(item)
        del legacy_item["act_id"]
        legacy_lines.append(json.dumps(legacy_item, ensure_ascii=False))
    (legacy_items_dir / "bench-de.jsonl").write_text("\n".join(legacy_lines) + "\n")

    legacy_out_dir = tmp_path / "legacy-results"
    legacy_report = run_oracle.run(settings, items_path=legacy_items_dir,
                                   out_path=legacy_out_dir, langs=("de",))
    assert legacy_report.errors == len(de_items)
    legacy_results = _read_jsonl(legacy_out_dir / "results-oracle.jsonl")
    assert all(r["oracle_error"] == "no_edition_for_date" for r in legacy_results), \
        "without act_id, the sr_number tiebreak lands on the decoy act (act 2), " \
        "which has no ch_act_version at all"


def test_report_summarise_and_markdown(settings, seeded, tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "results"
    build.build(settings, langs=("de", "fr"), out_dir=items_dir, now=_NOW)
    run_oracle.run(settings, items_path=items_dir, out_path=out_dir, langs=("de", "fr"))

    items_by_id = {}
    for lang in ("de", "fr"):
        for item in _read_jsonl(items_dir / f"bench-{lang}.jsonl"):
            items_by_id[item["id"]] = item

    result_lines = _read_jsonl(out_dir / "results-oracle.jsonl")
    summary = report.summarise(result_lines, items_by_id)

    assert set(summary.keys()) == {"de", "fr"}
    for lang in ("de", "fr"):
        buckets = summary[lang]["oracle"]
        assert set(buckets) == {"all", "before", "after"}
        stats = buckets["all"]
        assert stats["n"] == 2
        assert stats["errors"] == 0
        assert stats["grounded_correct"] == 2
        assert stats["grounded_wrong_version"] == 0
        assert stats["ungrounded"] == 0
        assert stats["share_correct"] == 1.0
        assert stats["share_wrong"] == 0.0
        assert stats["share_ungrounded"] == 0.0
        assert stats["score"] == 1.0
        assert stats["mean_gold_coverage"] > 0

        # One item per kind, and the pair splits cleanly on gold_is_current:
        # `before`'s gold is the superseded edition, `after`'s is current.
        assert buckets["before"]["n"] == 1
        assert buckets["after"]["n"] == 1
        assert stats["n_gold_current"] == 1
        assert stats["correct_gold_current"] == 1
        assert stats["n_gold_superseded"] == 1
        assert stats["correct_gold_superseded"] == 1
        assert stats["share_correct_gold_superseded"] == 1.0

    md = report.markdown(summary)
    assert "de" in md and "fr" in md and "oracle" in md
    # Header + separator + (all, after, before) per (lang, system) -- 2 here.
    assert len(md.strip().splitlines()) == 8


def test_a_missing_item_file_is_an_error_not_a_silent_skip(settings, seeded, tmp_path):
    """The oracle's whole value is its 100% score. Quietly skipping a
    language whose bench-{lang}.jsonl is missing would report that 100%
    over a smaller set than the caller asked for."""
    items_dir = tmp_path / "items"
    build.build(settings, langs=("de",), out_dir=items_dir, now=_NOW)

    with pytest.raises(FileNotFoundError) as excinfo:
        run_oracle.run(settings, items_path=items_dir, out_path=tmp_path / "out",
                       langs=("de", "fr"))
    assert "bench-fr.jsonl" in str(excinfo.value)
