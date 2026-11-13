"""clean_text_stage: rewrites PDF/OCR decision texts with chpipe.text_clean,
archiving the raw text first (chpipe.raw_text_archive). The queue is
ch_text_clean_state (migration 259). Scratch-database test: the
compare-and-set UPDATE and the claim's FOR UPDATE OF s cannot be mocked."""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from chpipe import db, raw_text_archive, text_clean
from chpipe.config import Settings
from chpipe.stages import clean_text_stage

from conftest import apply_migration_259

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GR_FIXTURE = (FIXTURES / "pdftext_decision_gr_hardwrap.txt").read_text()
# R10: an already-reflowed text (HTML-derived). Stripped, because the
# cleaner strips the outer whitespace -- the stored text it would leave
# alone is the stripped one.
HTML_FIXTURE = (FIXTURES / "decision_bger_html_reflowed.txt").read_text().strip()

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=raw,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        for t in ("ch_court_decisions", "ch_text_clean_state"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                full_text text, languages text[], metadata_json jsonb,
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION_196.read_text())
        apply_migration_259(c)
        yield c


def _insert_decision(conn, doc_id, spider, text_source, full_text,
                     stage="loaded", languages=("de",), metadata=None,
                     text_quality=0.9):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "full_text, languages, metadata_json, text_quality, updated_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, now() - interval '1 day')",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, stage, text_source,
         full_text, list(languages) if languages is not None else None,
         Jsonb(metadata) if metadata is not None else None, text_quality))


def _full_text(conn, doc_id):
    return conn.execute("SELECT full_text FROM ch_court_decisions WHERE doc_id=%s",
                        (doc_id,)).fetchone()["full_text"]


def _state(conn, doc_id):
    return conn.execute("SELECT * FROM ch_text_clean_state WHERE doc_id=%s",
                        (doc_id,)).fetchone()


# --- seed ---------------------------------------------------------------

def test_seed_selects_pdf_and_ocr_not_rpw(conn):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE)
    _insert_decision(conn, "o", "CH_BVGer", "ocr", GR_FIXTURE)
    _insert_decision(conn, "b", "CH_WEKO_RPW", "pdf", "x")
    _insert_decision(conn, "w", "CH_WEKO", "pdf", "x")
    _insert_decision(conn, "c", "GE_Gerichte", "html", "x")
    _insert_decision(conn, "f", "CH_BVGer", "pdf", "x", stage="fetched")
    assert db.seed_clean_state(conn) == 2
    rows = conn.execute("SELECT doc_id, spider FROM ch_text_clean_state "
                        "ORDER BY doc_id").fetchall()
    assert rows == [{"doc_id": "a", "spider": "CH_BVGer"},
                    {"doc_id": "o", "spider": "CH_BVGer"}]
    assert db.seed_clean_state(conn) == 0, "re-seeding is a no-op"


# --- claim / stamp / fail -----------------------------------------------

def test_claim_returns_the_row_with_sprache(conn):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "t", metadata={"Sprache": "fr"})
    db.seed_clean_state(conn)
    [row] = db.claim_for_clean(conn, 10)
    assert row["doc_id"] == "a" and row["spider"] == "CH_BVGer"
    assert row["full_text"] == "t" and row["languages"] == ["de"]
    assert row["sprache"] == "fr" and row["text_quality"] == pytest.approx(0.9)


def test_claim_filters_by_spider_and_orders_by_doc_id(conn):
    for d, s in (("c", "CH_BVGer"), ("a", "CH_BVGer"), ("b", "ZG_Obergericht")):
        _insert_decision(conn, d, s, "pdf", "t")
    db.seed_clean_state(conn)
    assert [r["doc_id"] for r in db.claim_for_clean(conn, 10)] == ["a", "b", "c"]
    assert [r["doc_id"] for r in db.claim_for_clean(conn, 10, spider="CH_BVGer")] == ["a", "c"]
    assert [r["doc_id"] for r in db.claim_for_clean(conn, 1)] == ["a"]


def test_claim_skips_rows_not_loaded_and_stamped_rows(conn):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "t")
    _insert_decision(conn, "b", "CH_BVGer", "pdf", "t")
    db.seed_clean_state(conn)
    conn.execute("UPDATE ch_court_decisions SET stage='extracted' WHERE doc_id='a'")
    db.stamp_clean(conn, "b", "sha", 1)
    assert db.claim_for_clean(conn, 10) == []


def test_claim_skips_failed_rows_after_three_attempts(conn):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "t")
    db.seed_clean_state(conn)
    for i in range(3):
        assert len(db.claim_for_clean(conn, 10, max_attempts=3)) == 1
        db.fail_clean(conn, "a", f"boom {i}")
    assert db.claim_for_clean(conn, 10, max_attempts=3) == []
    st = _state(conn, "a")
    assert st["attempts"] == 3 and st["last_error"] == "boom 2"
    assert st["cleaned_at"] is None


def test_claim_does_not_lock_the_decision_row(conn, settings):
    """FOR UPDATE OF s: inside an open claim transaction another session must
    still be able to lock the decision row."""
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "t")
    db.seed_clean_state(conn)
    with psycopg.connect(settings.dsn, row_factory=dict_row) as c1, \
            psycopg.connect(settings.dsn, autocommit=True) as c2:
        assert len(db.claim_for_clean(c1, 10)) == 1          # c1's txn stays open
        c2.execute("SET lock_timeout = '500ms'")
        c2.execute("SELECT 1 FROM ch_court_decisions WHERE doc_id='a' FOR UPDATE NOWAIT")
        # ... while the state row IS locked: a second claim skips it
        with psycopg.connect(settings.dsn, row_factory=dict_row) as c3:
            assert db.claim_for_clean(c3, 10) == []
        c1.rollback()


def test_stamp_clean_sets_version_sha_and_clears_error(conn):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "t")
    db.seed_clean_state(conn)
    db.fail_clean(conn, "a", "boom")
    db.stamp_clean(conn, "a", "abc", 7)
    st = _state(conn, "a")
    assert st["raw_sha256"] == "abc" and st["cleaner_version"] == 7
    assert st["cleaned_at"] is not None and st["last_error"] is None


def test_ensure_clean_state_stamped_inserts_and_updates(conn):
    db.ensure_clean_state_stamped(conn, "n", "CH_BVGer", "s1", 1)
    st = _state(conn, "n")
    assert st["spider"] == "CH_BVGer" and st["raw_sha256"] == "s1"
    assert st["cleaned_at"] is not None
    first = st["cleaned_at"]
    db.ensure_clean_state_stamped(conn, "n", "CH_BVGer", "s2", 2)
    st = _state(conn, "n")
    assert st["raw_sha256"] == "s2" and st["cleaner_version"] == 2
    assert st["cleaned_at"] >= first


# --- languages (R6) ------------------------------------------------------

@pytest.mark.parametrize("sprache,languages,expected", [
    ("fr", ["de"], ["fr"]),
    ("Français", ["de"], ["fr"]),
    ("Italiano", None, ["it"]),
    ("Deutsch", ["fr"], ["de"]),
    ("IT", None, ["it"]),
    ('["it"]', ["de"], ["it"]),
    (None, ["fr", "de"], ["fr", "de"]),
    ("", ["de"], ["de"]),
    ("   ", None, []),
    ("Klingonisch", ["fr"], ["fr"]),     # unmappable: fall back to the column
])
def test_languages_prefer_sprache_and_map_names(sprache, languages, expected):
    row = {"sprache": sprache, "languages": languages}
    assert clean_text_stage.languages_for(row) == expected


def test_run_uses_sprache_for_the_hyphen_vocabulary(conn, settings, monkeypatch):
    seen = []
    real = text_clean.clean_pdf_text
    monkeypatch.setattr(clean_text_stage.text_clean, "clean_pdf_text",
                        lambda raw, langs: seen.append(langs) or real(raw, langs))
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE,
                     languages=["de"], metadata={"Sprache": "Français"})
    db.seed_clean_state(conn)
    clean_text_stage.run(settings)
    assert seen == [["fr"]]


# --- run -----------------------------------------------------------------

def test_run_archives_then_updates_then_stamps(conn, settings):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.cleaned == 1 and report.unchanged == 0 and report.failed == 0
    assert report.archived_bytes > 0
    assert raw_text_archive.load(settings.raw_dir, "CH_BVGer", "a") == GR_FIXTURE
    out = _full_text(conn, "a")
    assert "iden-\n" not in out and out == text_clean.clean_pdf_text(GR_FIXTURE, ["de"])
    st = _state(conn, "a")
    assert st["cleaner_version"] == text_clean.CLEANER_VERSION
    assert st["raw_sha256"] == raw_text_archive.sha256_of(GR_FIXTURE)
    assert st["cleaned_at"] is not None
    row = conn.execute("SELECT updated_at > now() - interval '1 hour' AS fresh, "
                       "text_quality FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row["fresh"], "updated_at is bumped on a rewrite"
    assert row["text_quality"] == pytest.approx(0.9), "text_quality is not touched"
    assert clean_text_stage.run(settings).cleaned == 0, "a stamped row is not re-claimed"


def test_run_rerun_after_update_without_stamp_is_idempotent(conn, settings):
    # The archive exists and full_text is already the clean text, but the
    # state row is unstamped (e.g. re-queued for a new cleaner version).
    clean_before = text_clean.clean_pdf_text(GR_FIXTURE, ["de"])
    raw_text_archive.save(settings.raw_dir, "CH_BVGer", "a", GR_FIXTURE)
    _insert_decision(conn, "a", "CH_BVGer", "pdf", clean_before)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.unchanged == 1 and report.cleaned == 0 and report.failed == 0
    assert _full_text(conn, "a") == clean_before
    assert raw_text_archive.load(settings.raw_dir, "CH_BVGer", "a") == GR_FIXTURE
    assert _state(conn, "a")["raw_sha256"] == raw_text_archive.sha256_of(GR_FIXTURE)
    assert _state(conn, "a")["cleaned_at"] is not None


def test_run_existing_archive_is_the_raw_that_gets_cleaned(conn, settings):
    """FileExistsError: the archive is the true raw; the stored text (here a
    stale, half-processed one) is replaced by clean(archive)."""
    raw_text_archive.save(settings.raw_dir, "CH_BVGer", "a", GR_FIXTURE)
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "something else entirely")
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.cleaned == 1
    assert _full_text(conn, "a") == text_clean.clean_pdf_text(GR_FIXTURE, ["de"])
    assert raw_text_archive.load(settings.raw_dir, "CH_BVGer", "a") == GR_FIXTURE


def test_run_reflowed_text_is_unchanged(conn, settings):
    _insert_decision(conn, "p", "CH_VB", "pdf", HTML_FIXTURE)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.unchanged == 1 and report.cleaned == 0
    assert _full_text(conn, "p") == HTML_FIXTURE
    row = conn.execute("SELECT updated_at < now() - interval '1 hour' AS old "
                       "FROM ch_court_decisions WHERE doc_id='p'").fetchone()
    assert row["old"], "an unchanged row is not rewritten"
    assert _state(conn, "p")["cleaned_at"] is not None


def test_run_unreadable_archive_fails_and_leaves_the_row(conn, settings):
    path = raw_text_archive.path_for(settings.raw_dir, "CH_BVGer", "a")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not gzip at all")
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.failed == 1 and report.cleaned == 0
    assert _full_text(conn, "a") == GR_FIXTURE
    assert path.read_bytes() == b"not gzip at all", "never overwrite an archive"
    st = _state(conn, "a")
    assert st["attempts"] == 1 and st["last_error"] and st["cleaned_at"] is None


def test_run_cleaner_exception_is_a_failure_not_an_abort(conn, settings, monkeypatch):
    real = text_clean.clean_pdf_text

    def flaky(raw, langs):
        if raw == "poison":
            raise RuntimeError("bad text")
        return real(raw, langs)

    monkeypatch.setattr(clean_text_stage.text_clean, "clean_pdf_text", flaky)
    _insert_decision(conn, "a", "CH_BVGer", "pdf", "poison")
    _insert_decision(conn, "b", "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings, batch=1)
    assert report.failed == 1 and report.cleaned == 1
    assert _state(conn, "a")["attempts"] == 1
    assert "bad text" in _state(conn, "a")["last_error"]
    assert _full_text(conn, "a") == "poison"


def test_run_concurrent_change_is_left_alone(conn, settings, monkeypatch):
    """Compare-and-set: the pipeline rewrote full_text between claim and
    UPDATE, so the row is not touched and not stamped."""
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    real = text_clean.clean_pdf_text

    def racing(raw, langs):
        with psycopg.connect(settings.dsn, autocommit=True) as other:
            other.execute("UPDATE ch_court_decisions SET full_text='fresh' "
                          "WHERE doc_id='a'")
        return real(raw, langs)

    monkeypatch.setattr(clean_text_stage.text_clean, "clean_pdf_text", racing)
    report = clean_text_stage.run(settings, limit=1)
    assert report.skipped_concurrent == 1 and report.cleaned == 0
    assert _full_text(conn, "a") == "fresh"
    assert _state(conn, "a")["cleaned_at"] is None


def test_run_counts_replacement_chars(conn, settings):
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE + "\nBr�cke\n")
    _insert_decision(conn, "b", "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    report = clean_text_stage.run(settings)
    assert report.with_replacement_chars == 1 and report.cleaned == 2


def test_run_honours_limit_and_spider(conn, settings):
    for d in ("a", "b", "c"):
        _insert_decision(conn, d, "CH_BVGer", "pdf", GR_FIXTURE)
    _insert_decision(conn, "z", "ZG_Obergericht", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    assert clean_text_stage.run(settings, limit=2, batch=1).cleaned == 2
    assert clean_text_stage.run(settings, spider="ZG_Obergericht").cleaned == 1
    assert _state(conn, "c")["cleaned_at"] is None


def test_run_waits_for_capacity_before_each_batch(conn, settings, monkeypatch):
    calls = []
    monkeypatch.setattr(clean_text_stage.throttle, "wait_for_capacity",
                        lambda ceiling, stage: calls.append((ceiling, stage)))
    for d in ("a", "b"):
        _insert_decision(conn, d, "CH_BVGer", "pdf", GR_FIXTURE)
    db.seed_clean_state(conn)
    clean_text_stage.run(settings, batch=1)
    assert calls and all(c == (settings.load_ceiling, "clean-text") for c in calls)
    assert len(calls) >= 2


def test_main_seed_mode_seeds_and_exits(conn, settings, monkeypatch):
    monkeypatch.setattr(Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(clean_text_stage.throttle, "renice", lambda n: None)
    monkeypatch.setenv("CHPIPE_SEED", "1")
    _insert_decision(conn, "a", "CH_BVGer", "pdf", GR_FIXTURE)
    assert clean_text_stage.main() == 1
    assert _state(conn, "a")["cleaned_at"] is None
    assert _full_text(conn, "a") == GR_FIXTURE
