"""clean-text stage: rewrite the full_text of loaded PDF/OCR decisions with
chpipe.text_clean, archiving the raw text first.

For these rows full_text is the ONLY copy of the raw pdftotext output (the
PDFs were deleted after extraction), so the order per row is fixed:

  0. NULL/empty full_text: fail_clean("empty full_text"), nothing archived.
  1. raw_text_archive.save() -- gzip, fsynced, never overwritten. If an
     archive A already exists and differs (FileExistsError), A is trusted
     only if the state row's raw_sha256 == sha256(A) (stamped from A before;
     a requeue keeps raw_sha256) -- then A is re-cleaned -- or the stored
     full_text == clean(A) (idempotent re-run: stamp). Otherwise the row got
     NEW raw text since A was written: fail_clean("archive conflict ..."),
     row and archive untouched, counted in `archive_conflict`. An archive
     that cannot be read is a hard failure: fail_clean(), nothing touched.
  2. clean = text_clean.clean_pdf_text(raw, languages).
  3. clean == stored full_text: stamp only (`unchanged`). Otherwise ONE
     transaction: a compare-and-set UPDATE of ch_court_decisions
     (`... AND full_text = <the text this run read>`) and stamp_clean(). A
     row the pipeline rewrote in between matches nothing; it is left alone,
     not stamped, and counted in `skipped_concurrent`.
  A psycopg.OperationalError (lock/statement timeout) spends no attempt: the
  row stays pending, counted in `transient`.

text_quality is not written here (measured separately). The queue is
ch_text_clean_state (migration 259); `CHPIPE_SEED=1` enrols the backlog
(db.seed_clean_state) and exits. The claim locks the state row only.

Load guard: this runs on a box that also serves live traffic, so it waits
for capacity before each batch and renices in main(), like extract_stage.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

import psycopg

from .. import db, raw_text_archive, text_clean, throttle
from ..config import Settings
from ..portals.common import LANGS, lang_from_name

log = logging.getLogger(__name__)

STAGE = "clean-text"
BATCH_SIZE = 200



@dataclass
class CleanTextReport:
    cleaned: int = 0
    unchanged: int = 0
    failed: int = 0
    skipped_concurrent: int = 0
    archive_conflict: int = 0
    transient: int = 0
    archived_bytes: int = 0
    with_replacement_chars: int = 0


def _code(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    if value.lower() in LANGS:
        return value.lower()
    return lang_from_name(value)


def languages_for(row) -> list[str]:
    """R6: the decision's own Sprache (metadata_json) when present and
    mappable, else the languages column. Sprache is a code ("de") or a name
    ("Deutsch", "Français", "Italiano"); names go through the portals'
    lang_from_name mapping. A JSON list stored there is read element-wise."""
    sprache = (row.get("sprache") or "").strip()
    if sprache:
        values = [sprache]
        if sprache.startswith("["):
            try:
                parsed = json.loads(sprache)
                values = [str(v) for v in parsed] if isinstance(parsed, list) else values
            except ValueError:
                pass
        codes: list[str] = []
        for v in values:
            c = _code(v)
            if c and c not in codes:
                codes.append(c)
        if codes:
            return codes
    return list(row.get("languages") or [])


class _Pending(Exception):
    """The row was deliberately left pending (already recorded in the
    report); the run skips it for the rest of this run."""


def _process(conn, settings: Settings, row, report: CleanTextReport) -> None:
    doc_id, spider = row["doc_id"], row["spider"]
    stored = row["full_text"]
    if not stored:
        # Nothing to archive and nothing to clean; never archive an empty raw.
        db.fail_clean(conn, doc_id, "empty full_text")
        report.failed += 1
        raise _Pending
    langs = languages_for(row)
    path = raw_text_archive.path_for(settings.raw_dir, spider, doc_id)
    existed = path.exists()
    raw = stored
    clean = None
    try:
        sha = raw_text_archive.save(settings.raw_dir, spider, doc_id, stored)
        if not existed:
            report.archived_bytes += path.stat().st_size
    except FileExistsError:
        # An archive A from an earlier run differs from the stored text. A
        # is the raw only if this row was stamped from it (raw_sha256 kept
        # across a requeue) or the stored text is exactly clean(A). Anything
        # else means the pipeline gave the row NEW raw text since A was
        # written: cleaning A would overwrite it, so leave both alone.
        archived = raw_text_archive.load(settings.raw_dir, spider, doc_id)
        sha = raw_text_archive.sha256_of(archived)
        if row.get("raw_sha256") != sha:
            clean = text_clean.clean_pdf_text(archived, langs)
            if clean != stored:
                db.fail_clean(conn, doc_id, "archive conflict: stored text not "
                              f"derived from archive sha={sha[:12]}")
                report.archive_conflict += 1
                log.error("%s/%s: archive conflict (sha=%s)", spider, doc_id, sha[:12])
                raise _Pending
        raw = archived
    if "\ufffd" in raw:   # U+FFFD: a lossy extraction; counted, cleaned anyway
        report.with_replacement_chars += 1

    if clean is None:
        clean = text_clean.clean_pdf_text(raw, langs)
    if clean == stored:
        db.stamp_clean(conn, doc_id, sha, text_clean.CLEANER_VERSION)
        report.unchanged += 1
        return
    with conn.transaction():
        cur = conn.execute(
            "UPDATE ch_court_decisions SET full_text = %s, updated_at = now() "
            "WHERE doc_id = %s AND full_text = %s",
            (clean, doc_id, stored))
        if cur.rowcount != 1:
            report.skipped_concurrent += 1
            log.warning("%s/%s: full_text changed since the claim; left alone",
                        spider, doc_id)
            raise _Pending
        db.stamp_clean(conn, doc_id, sha, text_clean.CLEANER_VERSION)
    report.cleaned += 1


def run(settings: Settings, limit: int | None = None, spider: str | None = None,
        batch: int = BATCH_SIZE) -> CleanTextReport:
    report = CleanTextReport()
    conn = db.connect(settings)
    remaining = limit
    # Rows left pending in THIS run (failed, conflicting, skipped, transient)
    # are unstamped and would come straight back from the claim; skip them
    # so the run moves on.
    seen_bad: set[str] = set()
    try:
        while True:
            throttle.wait_for_capacity(settings.load_ceiling, STAGE)
            size = batch if remaining is None else min(batch, remaining)
            if size <= 0:
                break
            rows = db.claim_for_clean(conn, size + len(seen_bad), spider=spider,
                                      max_attempts=settings.max_attempts)
            rows = [r for r in rows if r["doc_id"] not in seen_bad][:size]
            if not rows:
                break
            for row in rows:
                try:
                    _process(conn, settings, row, report)
                except _Pending:
                    seen_bad.add(row["doc_id"])
                except psycopg.OperationalError as exc:
                    # Lock or statement timeout: not the row's fault, so no
                    # attempt is spent. Left unstamped for a later run.
                    log.warning("%s/%s: transient: %s", row["spider"], row["doc_id"], exc)
                    report.transient += 1
                    seen_bad.add(row["doc_id"])
                except Exception as exc:                        # noqa: BLE001
                    # An existing archive that cannot be read (EOFError,
                    # BadGzipFile/OSError, zlib.error, UnicodeDecodeError),
                    # an unsafe doc_id (ValueError) or a cleaner bug: one
                    # attempt spent, the decision row and archive untouched.
                    log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
                    db.fail_clean(conn, row["doc_id"], f"{type(exc).__name__}: {exc}")
                    report.failed += 1
                    seen_bad.add(row["doc_id"])
            if remaining is not None:
                remaining -= len(rows)
            log.info("%s", report)
    finally:
        conn.close()
    return report


def main():
    """Entry point. CHPIPE_LIMIT, CHPIPE_SPIDER, CHPIPE_BATCH; CHPIPE_SEED=1
    enrols the backlog in ch_text_clean_state and exits (returns the count)."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    settings = Settings.from_env()
    if os.environ.get("CHPIPE_SEED") == "1":
        conn = db.connect(settings)
        try:
            added = db.seed_clean_state(conn)
        finally:
            conn.close()
        log.info("seeded %d row(s) into ch_text_clean_state", added)
        return added
    batch_env = (os.environ.get("CHPIPE_BATCH") or "").strip()
    result = run(settings,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None,
                 batch=int(batch_env) if batch_env else BATCH_SIZE)
    log.info("%s", result)
    return result


if __name__ == "__main__":
    main()
