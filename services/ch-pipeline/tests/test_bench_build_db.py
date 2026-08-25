"""chpipe.bench.build.build(): the DB glue Task 3 adds on top of Task 1/2's
pure select_change()/make_items(). A mocked DB cannot validate the SQL join
across ch_act_change/ch_act/ch_act_version/ch_act_article/ch_act_alias (see
test_citations_resolve_stage.py's own docstring for the same rule), so this
is a scratch-database test.
"""
import datetime
import json
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.bench import build
from chpipe.config import Settings

from conftest import apply_migration_199

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

_NOW = datetime.datetime(2026, 8, 25, 12, 0, 0, tzinfo=datetime.timezone.utc)

# Same shape as tests/test_bench_build.py's OLD_TEXT/NEW_TEXT: numbered
# paragraphs, paragraph 1 unchanged, paragraphs 2 and 3 materially reworded
# -- >= 200 normalised characters each, SequenceMatcher ratio < 0.9, so
# select_change() accepts this pair and make_items() drops nothing.
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

# A pair long enough (>= 200 normalised chars) but only whitespace apart --
# SequenceMatcher ratio 1.0, so select_change() rejects it. Measured
# directly (see task-3 self-review): normalise() gives 203 chars each side.
_PADDING = " ".join(
    ["Diese Bestimmung regelt die Kündigungsfristen im Arbeitsverhältnis."] * 3)
NEAR_OLD_TEXT = _PADDING
NEAR_NEW_TEXT = _PADDING + "  "


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        # ch_court_decisions is not this test's subject, but migration 199's
        # ALTER TABLE / index statements need it to exist -- same minimal
        # shape test_citations_resolve_stage.py uses.
        c.execute("""
            CREATE TABLE IF NOT EXISTS ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                docket_number text,
                stage text
            )
        """)
        # Both files are IF NOT EXISTS all the way down (migration
        # convention -- see CLAUDE.md), so re-applying them against a
        # scratch DB that already has these tables (from an earlier test
        # module in the same session) is a no-op.
        c.execute(MIGRATION_197.read_text())
        apply_migration_199(c)
        # TRUNCATE rather than DROP: this file's fixtures own exactly these
        # five tables' contents, and CASCADE handles the FK order between
        # them (ch_act -> ch_act_version -> ch_act_article/ch_act_change)
        # regardless of the order they're listed in.
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
    """One in-force act (SR 220, abbreviation OR in German, alias CO
    curated in French), two editions each for de/fr, and two 'modified'
    changes per language: art_336 (a real change) and art_337 (near-
    identical, must be skipped). Plus a second, NOT-in-force act (SR 999)
    with its own edition/article/change, which the SQL's `enforcement_status
    = 0` join must exclude entirely.
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
        _article(conn, old_v, "art_337", "337", NEAR_OLD_TEXT)
        _article(conn, new_v, "art_337", "337", NEAR_NEW_TEXT)

    _change(conn, 1, "de", 101, 102, "art_336", "336", change_date)
    _change(conn, 1, "de", 101, 102, "art_337", "337", change_date)
    _change(conn, 1, "fr", 103, 104, "art_336", "336", change_date)
    _change(conn, 1, "fr", 103, 104, "art_337", "337", change_date)

    # Not in force: excluded by the SQL's JOIN on enforcement_status = 0,
    # never reaches changes_considered at all.
    _act(conn, 2, "999", abbreviation="XX", enforcement_status=3)
    _version(conn, 201, 2, "de", old_date, change_date)
    _version(conn, 202, 2, "de", change_date, None)
    _article(conn, 201, "art_1", "1", OLD_TEXT)
    _article(conn, 202, "art_1", "1", NEW_TEXT)
    _change(conn, 2, "de", 201, 202, "art_1", "1", change_date)

    return conn


def _read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_build_writes_two_items_per_language(settings, seeded, tmp_path):
    report = build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)

    assert report.per_lang["de"]["changes_considered"] == 2
    assert report.per_lang["de"]["selected"] == 1
    assert report.per_lang["de"]["items"] == 2
    assert report.per_lang["de"]["skipped"] == {"near_identical_or_short": 1}

    assert report.per_lang["fr"]["changes_considered"] == 2
    assert report.per_lang["fr"]["selected"] == 1
    assert report.per_lang["fr"]["items"] == 2
    assert report.per_lang["fr"]["skipped"] == {"near_identical_or_short": 1}

    de_items = _read_jsonl(tmp_path / "bench-de.jsonl")
    fr_items = _read_jsonl(tmp_path / "bench-fr.jsonl")
    assert len(de_items) == 2
    assert len(fr_items) == 2
    assert [it["kind"] for it in de_items] == sorted(it["kind"] for it in de_items)


def test_fr_item_uses_the_curated_alias_abbreviation(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)
    fr_items = _read_jsonl(tmp_path / "bench-fr.jsonl")
    assert all(it["abbreviation"] == "CO" for it in fr_items)
    assert all(it["sr_number"] == "220" for it in fr_items)


def test_de_item_uses_the_act_abbreviation(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)
    de_items = _read_jsonl(tmp_path / "bench-de.jsonl")
    assert all(it["abbreviation"] == "OR" for it in de_items)


def test_not_in_force_act_is_excluded_entirely(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)
    de_items = _read_jsonl(tmp_path / "bench-de.jsonl")
    assert all(it["sr_number"] != "999" for it in de_items)
    # Not counted anywhere: excluded by the JOIN before Python ever sees it.
    assert "not_in_force" not in json.loads(
        (tmp_path / "build-report.json").read_text())["de"]["skipped"]


def test_items_are_sorted_by_id(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)
    for lang in ("de", "fr"):
        items = _read_jsonl(tmp_path / f"bench-{lang}.jsonl")
        ids = [it["id"] for it in items]
        assert ids == sorted(ids)


def test_before_and_after_item_shape(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, now=_NOW)
    de_items = {it["kind"]: it for it in _read_jsonl(tmp_path / "bench-de.jsonl")}
    before, after = de_items["before"], de_items["after"]

    assert before["as_of"] == "2020-12-31"
    assert after["as_of"] == "2021-01-01"
    assert before["change_date"] == after["change_date"] == "2021-01-01"
    assert before["article_number"] == "336"
    assert before["e_id"] == "art_336"
    assert before["gold"]["text"] == OLD_TEXT
    assert before["distractor"]["text"] == NEW_TEXT
    assert after["gold"]["text"] == NEW_TEXT
    assert before["gold"]["version_id"] == 101
    assert before["gold"]["date_end_applicability"] == "2021-01-01"
    assert after["gold"]["date_end_applicability"] is None
    assert before["source"] == "Fedlex (fedlex.admin.ch)"
    assert before["licence"] == (
        "Fedlex data may be reused free of charge with source attribution")


def test_build_report_json_matches_the_returned_report(settings, seeded, tmp_path):
    report = build.build(settings, langs=("de", "fr"), out_dir=tmp_path,
                         seed=12345, now=_NOW)
    on_disk = json.loads((tmp_path / "build-report.json").read_text())

    assert on_disk["seed"] == 12345
    assert on_disk["caps"] == {"per_lang_cap": 5000, "per_act_cap": 50}
    assert on_disk["built_at"] == "2026-08-25T12:00:00+00:00"
    assert on_disk["de"] == report.per_lang["de"]
    assert on_disk["fr"] == report.per_lang["fr"]


def test_a_second_build_is_byte_identical(settings, seeded, tmp_path):
    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, seed=20260825, now=_NOW)
    first_de = (tmp_path / "bench-de.jsonl").read_text()
    first_fr = (tmp_path / "bench-fr.jsonl").read_text()
    first_report = (tmp_path / "build-report.json").read_text()

    build.build(settings, langs=("de", "fr"), out_dir=tmp_path, seed=20260825, now=_NOW)
    second_de = (tmp_path / "bench-de.jsonl").read_text()
    second_fr = (tmp_path / "bench-fr.jsonl").read_text()
    second_report = (tmp_path / "build-report.json").read_text()

    assert first_de == second_de
    assert first_fr == second_fr
    assert first_report == second_report


def test_no_abbreviation_is_skipped(settings, conn, tmp_path):
    """An in-force act with no de abbreviation and no fr/it alias at all:
    every change for it is dropped with reason no_abbreviation, before
    select_change() is ever consulted."""
    old_date = datetime.date(2015, 1, 1)
    change_date = datetime.date(2021, 1, 1)
    _act(conn, 3, "555", abbreviation=None, enforcement_status=0)
    _version(conn, 301, 3, "de", old_date, change_date)
    _version(conn, 302, 3, "de", change_date, None)
    _article(conn, 301, "art_5", "5", OLD_TEXT)
    _article(conn, 302, "art_5", "5", NEW_TEXT)
    _change(conn, 3, "de", 301, 302, "art_5", "5", change_date)

    report = build.build(settings, langs=("de",), out_dir=tmp_path, now=_NOW)
    assert report.per_lang["de"]["changes_considered"] == 1
    assert report.per_lang["de"]["selected"] == 0
    assert report.per_lang["de"]["items"] == 0
    assert report.per_lang["de"]["skipped"] == {"no_abbreviation": 1}
    assert (tmp_path / "bench-de.jsonl").read_text() == ""
