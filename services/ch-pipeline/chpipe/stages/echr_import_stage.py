"""ECtHR documents into echr_cases (LEXAI-2040, gap plan phase 3).

Reads the slice scripts/echr_export_subset.py cut from the HUDOC harvest
(one gzipped ndjson: HUDOC record + text) and upserts it on item_id. A
re-run with a newer slice refreshes the metadata and fills a text that was
missing; it never blanks a text the table already has, because the
harvest's own gaps (HUDOC 500s) must not undo an earlier success.

    CHPIPE_ECHR_FILE=/data/echr/echr_ch_subset.ndjson.gz ./run-stage.sh echr-import

The table is echr_cases (migration 215 on a fresh box; on lawrider it
pre-dates the runner). judgment_date is HUDOC's kpdate, the date the
document was delivered.
"""
from __future__ import annotations

import datetime
import gzip
import json
import logging
import os
import pathlib
from dataclasses import dataclass, field

import psycopg

from .. import db, throttle
from ..config import Settings

log = logging.getLogger(__name__)

BATCH = 200


@dataclass
class EchrImportReport:
    read: int = 0
    upserted: int = 0
    inserted: int = 0
    with_text: int = 0
    errors: int = 0
    by_why: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO echr_cases
    (item_id, app_no, doc_name, doc_type, conclusion, ecli, importance, judgment_date,
     language_iso, originating_body, extracted_app_no, type_description, respondent,
     kp_date, document_collection_id, document_collection_id2, is_placeholder, full_text)
VALUES
    (%(item_id)s, %(app_no)s, %(doc_name)s, %(doc_type)s, %(conclusion)s, %(ecli)s, %(importance)s,
     %(judgment_date)s, %(language_iso)s, %(originating_body)s, %(extracted_app_no)s,
     %(type_description)s, %(respondent)s, %(kp_date)s, %(document_collection_id)s,
     %(document_collection_id2)s, %(is_placeholder)s, %(full_text)s)
ON CONFLICT (item_id) DO UPDATE SET
    app_no                  = EXCLUDED.app_no,
    doc_name                = EXCLUDED.doc_name,
    doc_type                = EXCLUDED.doc_type,
    conclusion              = EXCLUDED.conclusion,
    ecli                    = COALESCE(EXCLUDED.ecli, echr_cases.ecli),
    importance              = EXCLUDED.importance,
    judgment_date           = COALESCE(EXCLUDED.judgment_date, echr_cases.judgment_date),
    language_iso            = EXCLUDED.language_iso,
    originating_body        = EXCLUDED.originating_body,
    extracted_app_no        = EXCLUDED.extracted_app_no,
    type_description        = EXCLUDED.type_description,
    respondent              = EXCLUDED.respondent,
    kp_date                 = EXCLUDED.kp_date,
    document_collection_id  = EXCLUDED.document_collection_id,
    document_collection_id2 = EXCLUDED.document_collection_id2,
    is_placeholder          = EXCLUDED.is_placeholder,
    -- a text once loaded stays; a slice without it must not erase it
    full_text               = COALESCE(EXCLUDED.full_text, echr_cases.full_text)
RETURNING (xmax = 0) AS inserted
"""


def _date(kpdate: str | None) -> datetime.date | None:
    if not kpdate:
        return None
    try:
        return datetime.date.fromisoformat(kpdate[:10])
    except ValueError:
        return None


def _int(value) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def row_for(record: dict) -> dict:
    """The echr_cases row for one exported record ({"meta": HUDOC fields, "full_text": ...})."""
    m = record.get("meta") or {}
    text = record.get("full_text")
    return {
        "item_id": m["itemid"],
        "app_no": m.get("appno") or None,
        "doc_name": m.get("docname") or None,
        "doc_type": m.get("doctype") or None,
        "conclusion": m.get("conclusion") or None,
        "ecli": m.get("ecli") or None,
        "importance": _int(m.get("importance")),
        "judgment_date": _date(m.get("kpdate")),
        "language_iso": m.get("languageisocode") or None,
        "originating_body": m.get("originatingbody") or None,
        "extracted_app_no": m.get("extractedappno") or None,
        "type_description": m.get("typedescription") or None,
        "respondent": m.get("respondent") or None,
        "kp_date": m.get("kpdate") or None,
        "document_collection_id": m.get("documentcollectionid") or None,
        "document_collection_id2": m.get("documentcollectionid2") or None,
        "is_placeholder": str(m.get("isplaceholder", "")).lower() == "true",
        "full_text": text if text else None,
    }


def records(path: pathlib.Path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def _batches(iterable, size: int):
    batch = []
    for item in iterable:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


_ROW_ERRORS = (KeyError, psycopg.DataError, psycopg.IntegrityError)


def _apply(conn, batch: list[dict], isolate: bool) -> list[tuple[dict, dict | None, bool, Exception | None]]:
    """Upsert a batch in one transaction. With isolate=False a bad row
    raises and the whole batch rolls back (the fast path: no savepoints);
    with isolate=True each row sits in its own savepoint and a bad row
    is returned with its error instead."""
    out = []
    with conn.transaction():
        for record in batch:
            try:
                row = row_for(record)
                if isolate:
                    with conn.transaction():
                        result = conn.execute(_UPSERT, row).fetchone()
                else:
                    result = conn.execute(_UPSERT, row).fetchone()
            except _ROW_ERRORS as exc:
                if not isolate:
                    raise
                out.append((record, None, False, exc))
                continue
            inserted = result["inserted"] if isinstance(result, dict) else result[0]
            out.append((record, row, bool(inserted), None))
    return out


def run(settings: Settings, path: pathlib.Path) -> EchrImportReport:
    report = EchrImportReport()
    conn = db.connect(settings)
    try:
        # One commit per BATCH rows and no savepoints on the normal path;
        # a batch with a refused row is rolled back and redone row by row
        # under savepoints, so the bad row alone is lost.
        for batch in _batches(records(path), BATCH):
            try:
                results = _apply(conn, batch, isolate=False)
            except _ROW_ERRORS:
                results = _apply(conn, batch, isolate=True)
            for record, row, inserted, exc in results:
                report.read += 1
                if exc is not None:
                    log.error("record %d (%s): %s", report.read, (record.get("meta") or {}).get("itemid"), exc)
                    report.errors += 1
                    continue
                report.upserted += 1
                report.inserted += int(inserted)
                report.with_text += int(row["full_text"] is not None)
                why = record.get("why") or "?"
                report.by_why[why] = report.by_why.get(why, 0) + 1
            if report.read % 1000 < BATCH:
                log.info("read=%d upserted=%d inserted=%d errors=%d", report.read, report.upserted,
                         report.inserted, report.errors)
    finally:
        conn.close()
    return report


def main() -> EchrImportReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. CHPIPE_ECHR_FILE names the slice."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    path = os.environ.get("CHPIPE_ECHR_FILE")
    if not path:
        raise SystemExit("CHPIPE_ECHR_FILE is not set: the slice scripts/echr_export_subset.py wrote")
    result = run(Settings.from_env(), pathlib.Path(path))
    log.info("echr-import file=%s read=%d upserted=%d inserted=%d with_text=%d errors=%d by_why=%s",
             path, result.read, result.upserted, result.inserted, result.with_text,
             result.errors, result.by_why)
    return result


if __name__ == "__main__":
    main()
