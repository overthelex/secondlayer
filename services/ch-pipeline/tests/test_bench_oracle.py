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

from conftest import apply_migration_199

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
        apply_migration_199(c)
        c.execute("TRUNCATE ch_act_change, ch_act_alias, ch_act_article, "
                  "ch_act_version, ch_act RESTART IDENTITY CASCADE")
        yield c


def _act(conn, act_id, sr_number, abbreviation=None, enforcement_status=0):
    conn.execute(
        "INSERT INTO ch_act (act_id, eli_work_uri, sr_number, abbreviation, "
        "enforcement_status) VALUES (%s, %s, %s, %s, %s)",
        (act_id, f"https://x/act/{act_id}", sr_number, abbreviation, enforcement_status))


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
    change_date = datetime.date(2021, 1, 1)

    _act(conn, 1, "220", abbreviation="OR", enforcement_status=0)
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source) "
        "VALUES ('CO', 'fr', '220', 'curated')")

    _version(conn, 101, 1, "de", old_date, change_date)
    _version(conn, 102, 1, "de", change_date, None)
    _version(conn, 103, 1, "fr", old_date, change_date)
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
        stats = summary[lang]["oracle"]
        assert stats["n"] == 2
        assert stats["grounded_correct"] == 2
        assert stats["grounded_wrong_version"] == 0
        assert stats["ungrounded"] == 0
        assert stats["share_correct"] == 1.0
        assert stats["share_wrong"] == 0.0
        assert stats["share_ungrounded"] == 0.0
        assert stats["score"] == 1.0
        assert stats["mean_gold_coverage"] > 0

    md = report.markdown(summary)
    assert "de" in md and "fr" in md and "oracle" in md
    # One header + separator + one data row per (lang, system) -- 2 here.
    assert len(md.strip().splitlines()) == 4
