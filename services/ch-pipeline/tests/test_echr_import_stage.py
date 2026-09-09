"""echr_import_stage against a real PostgreSQL (CHPIPE_TEST_DSN)."""
import gzip
import json
import os
import pathlib

import psycopg
import pytest

from chpipe.config import Settings
from chpipe.stages import echr_import_stage
from tests.conftest import apply_migration_215

pytestmark = pytest.mark.skipif(not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1, load_ceiling=99.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS echr_cases")
        apply_migration_215(c)
        yield c


def _record(itemid, text="The applicant complained under Article 8. " * 30, **meta):
    m = {"itemid": itemid, "appno": "41773/98", "docname": "CASE OF GLOR v. SWITZERLAND",
         "doctype": "HEJUD", "documentcollectionid2": "CASELAW;JUDGMENTS;CHAMBER;ENG", "importance": "1",
         "respondent": "CHE", "languageisocode": "ENG", "kpdate": "2009-04-30T00:00:00",
         "conclusion": "Violation of Art. 14+8", "isplaceholder": "False", "originatingbody": "8",
         "typedescription": "15", "extractedappno": "41773/98", "documentcollectionid": "CASELAW;JUDGMENTS;CHAMBER;ENG"}
    m.update(meta)
    return {"meta": m, "full_text": text, "text_bytes": len(text or ""), "why": "respondent"}


def _write(path, records):
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def test_import_upserts_rows_and_keeps_an_earlier_text(settings, conn, tmp_path):
    f = tmp_path / "slice.ndjson.gz"
    _write(f, [_record("001-92353"), _record("001-92354", text=None, doctype="HFJUD", languageisocode="FRE",
                                              why="importance")])
    report = echr_import_stage.run(settings, f)
    assert (report.read, report.upserted, report.inserted, report.with_text, report.errors) == (2, 2, 2, 1, 0)
    row = conn.execute("SELECT app_no, importance, judgment_date::text, respondent, language_iso, is_placeholder, "
                       "length(full_text), tsv IS NOT NULL FROM echr_cases WHERE item_id = %s", ("001-92353",)).fetchone()
    assert row == ("41773/98", 1, "2009-04-30", "CHE", "ENG", False, len("The applicant complained under Article 8. " * 30), True)
    assert conn.execute("SELECT full_text FROM echr_cases WHERE item_id = '001-92354'").fetchone() == (None,)

    # a second slice: metadata refreshed, a missing text does not blank the loaded one, a new text lands
    _write(f, [_record("001-92353", text=None, importance="2"),
               _record("001-92354", text="Requête no 41773/98. " * 40)])
    report = echr_import_stage.run(settings, f)
    assert (report.upserted, report.inserted) == (2, 0)
    rows = dict(conn.execute("SELECT item_id, importance FROM echr_cases").fetchall())
    assert rows == {"001-92353": 2, "001-92354": 1}
    assert conn.execute("SELECT length(full_text) > 0 FROM echr_cases WHERE item_id = '001-92353'").fetchone() == (True,)
    assert conn.execute("SELECT full_text LIKE 'Requête%' FROM echr_cases WHERE item_id = '001-92354'").fetchone() == (True,)
    # the search column is live
    assert conn.execute("SELECT count(*) FROM echr_cases WHERE tsv @@ plainto_tsquery('simple', 'applicant complained')").fetchone() == (1,)


def test_a_record_without_itemid_is_counted_not_fatal(settings, conn, tmp_path):
    f = tmp_path / "slice.ndjson.gz"
    _write(f, [{"meta": {"docname": "no id"}, "full_text": None}, _record("001-1")])
    report = echr_import_stage.run(settings, f)
    assert (report.read, report.upserted, report.errors) == (2, 1, 1)


def test_main_needs_the_file_and_renices(monkeypatch):
    from chpipe import throttle
    calls = []
    monkeypatch.setattr(throttle, "renice", calls.append)
    monkeypatch.delenv("CHPIPE_ECHR_FILE", raising=False)
    with pytest.raises(SystemExit):
        echr_import_stage.main()
    assert calls == [throttle.NICE_IO]
