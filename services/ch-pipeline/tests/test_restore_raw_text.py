"""scripts/restore_raw_text.py against a scratch database (compare-and-set and
the claim cannot be mocked)."""
import os
import pathlib
import sys

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import db, raw_text_archive, text_clean

from conftest import apply_migration_260

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import restore_raw_text as rr  # noqa: E402

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
RAW = ((pathlib.Path(__file__).parent / "fixtures" / "pdftext_decision_gr_hardwrap.txt")
       .read_text())
CLEAN = text_clean.clean_pdf_text(RAW, ["de"])

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def raw_dir(tmp_path):
    d = tmp_path / "raw"
    d.mkdir()
    return d


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        for t in ("ch_court_decisions", "ch_text_clean_state"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""CREATE TABLE ch_court_decisions (
            ecli text PRIMARY KEY, spider text NOT NULL, full_text text,
            languages text[], metadata_json jsonb,
            updated_at timestamptz DEFAULT now())""")
        c.execute(MIGRATION_196.read_text())
        apply_migration_260(c)
        yield c


def _cleaned(conn, raw_dir, doc_id, *, stored=CLEAN, sha=None, archive=True):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "full_text, languages) VALUES (%s,'CH_BVGer',%s,'loaded','pdf',%s,%s)",
        (f"e:{doc_id}", doc_id, stored, ["de"]))
    if archive:
        raw_text_archive.save(raw_dir, "CH_BVGer", doc_id, RAW)
    conn.execute(
        "INSERT INTO ch_text_clean_state (doc_id, spider, cleaner_version, "
        "raw_sha256, cleaned_at) VALUES (%s,'CH_BVGer',1,%s, now())",
        (doc_id, sha or raw_text_archive.sha256_of(RAW)))


def _text(conn, d):
    return conn.execute("SELECT full_text FROM ch_court_decisions WHERE doc_id=%s",
                        (d,)).fetchone()["full_text"]


def test_fixture_is_actually_changed_by_cleaning():
    assert CLEAN != RAW


def test_round_trip_restores_raw_and_marks_state(conn, raw_dir):
    _cleaned(conn, raw_dir, "a")
    c = rr.restore(conn, raw_dir)
    assert c["restored"] == 1
    assert _text(conn, "a") == RAW
    s = conn.execute("SELECT * FROM ch_text_clean_state WHERE doc_id='a'").fetchone()
    assert s["cleaned_at"] is None and s["attempts"] == 3
    assert s["last_error"].startswith("rolled back ")


def test_sha_mismatch_is_skipped_and_counted(conn, raw_dir):
    _cleaned(conn, raw_dir, "a", sha="0" * 64)
    c = rr.restore(conn, raw_dir)
    assert c["sha_mismatch"] == 1 and c["restored"] == 0
    assert _text(conn, "a") == CLEAN


def test_missing_archive_is_skipped(conn, raw_dir):
    _cleaned(conn, raw_dir, "a", archive=False)
    assert rr.restore(conn, raw_dir)["archive_error"] == 1
    assert _text(conn, "a") == CLEAN


def test_concurrent_change_is_left_alone(conn, raw_dir):
    _cleaned(conn, raw_dir, "a", stored="re-extracted since cleaning")
    c = rr.restore(conn, raw_dir)
    assert c["changed"] == 1 and c["restored"] == 0
    assert _text(conn, "a") == "re-extracted since cleaning"
    assert conn.execute("SELECT cleaned_at FROM ch_text_clean_state"
                        ).fetchone()["cleaned_at"] is not None


def test_restored_row_is_not_reclaimed(conn, raw_dir):
    _cleaned(conn, raw_dir, "a")
    rr.restore(conn, raw_dir)
    assert db.claim_for_clean(conn, 10, max_attempts=3) == []


def test_dry_run_changes_nothing(conn, raw_dir):
    _cleaned(conn, raw_dir, "a")
    c = rr.restore(conn, raw_dir, dry_run=True)
    assert c["restored"] == 1
    assert _text(conn, "a") == CLEAN
    s = conn.execute("SELECT * FROM ch_text_clean_state").fetchone()
    assert s["cleaned_at"] is not None and s["attempts"] == 0 and s["last_error"] is None


def test_limit_and_spider_filter(conn, raw_dir):
    _cleaned(conn, raw_dir, "a")
    _cleaned(conn, raw_dir, "b")
    assert rr.restore(conn, raw_dir, limit=1)["restored"] == 1
    assert rr.restore(conn, raw_dir, spider="OTHER")["restored"] == 0


def test_corrupt_archive_is_skipped_and_batch_survives(conn, raw_dir):
    _cleaned(conn, raw_dir, "a")
    _cleaned(conn, raw_dir, "b")
    p = raw_text_archive.path_for(raw_dir, "CH_BVGer", "a")
    data = bytearray(p.read_bytes())
    for i in range(12, len(data) - 8):          # corrupt the deflate stream
        data[i] ^= 0xFF
    p.write_bytes(bytes(data))
    c = rr.restore(conn, raw_dir)
    assert c["archive_error"] == 1 and c["restored"] == 1
    assert _text(conn, "a") == CLEAN and _text(conn, "b") == RAW
