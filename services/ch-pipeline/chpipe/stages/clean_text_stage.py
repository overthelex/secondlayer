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
ch_text_clean_state (migration 260); `CHPIPE_SEED=1` enrols the backlog
(db.seed_clean_state) and exits. The claim locks the state row only.

Load guard: this runs on a box that also serves live traffic, so it waits
for capacity before each batch and renices in main(), like extract_stage.
"""
from __future__ import annotations

import json
import logging
import os
import zlib
from dataclasses import dataclass

import psycopg

from .. import db, raw_text_archive, text_clean, text_quality, throttle
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


def clean_new_text_enabled() -> bool:
    """Kill switch for the nightly path: CHPIPE_CLEAN_NEW_TEXT=0 turns it off
    (default on). Off behaves exactly like a missing state table: raw text,
    no archive, no state write."""
    return (os.environ.get("CHPIPE_CLEAN_NEW_TEXT") or "1").strip() != "0"


def cleans_new_text(row, source: str) -> bool:
    """True for a PDF/OCR decision whose new text the nightly path cleans.
    HTML rows and the spiders that reflow their own text are untouched, and
    so is everything while the CHPIPE_CLEAN_NEW_TEXT=0 kill switch is set."""
    return (clean_new_text_enabled()
            and source != "html" and not row.get("cleaning_disabled")
            and row["spider"] not in text_clean.OWN_REFLOW_SPIDERS)


def state_table_present(conn) -> bool:
    """Deploy-order guard for extract/ocr: the code is rsynced before
    lawrider-migrate runs, and migration 260 may be missing (failed build,
    build_only dispatch). Without the table every stamp would fail."""
    row = conn.execute("SELECT to_regclass('public.ch_text_clean_state') AS t").fetchone()
    present = (row["t"] if isinstance(row, dict) else row[0]) is not None
    if not present:
        log.error("ch_text_clean_state (migration 260) is missing: cleaning is "
                  "DISABLED for this run; PDF text is stored raw, unarchived and "
                  "unstamped until the migration is applied")
    return present


def disable_cleaning(rows) -> None:
    """Mark claimed rows so cleans_new_text() leaves them alone."""
    for r in rows:
        r["cleaning_disabled"] = True


def clean_new_text(settings: Settings, row, raw: str,
                   source: str = "pdf") -> tuple[str, float, list[str] | None]:
    """The nightly extract/OCR path: (text to store, its quality, relabel)
    for freshly extracted `raw`.

    For a row cleans_new_text() leaves alone this is just the raw text and its
    score. Otherwise the text is cleaned and quality is scored on the CLEANED
    text. Only text that is about to be stored (accepted quality, non-empty)
    is archived -- raw_text_archive.save() first -- so a PDF queued for OCR
    never occupies the archive slot its OCR text will need. After a
    successful save the row dict gets `clean_sha256`, the marker
    complete_with_clean_state() uses to stamp the state row in the same
    transaction as the full_text write.

    When the archive cannot take this raw text (FileExistsError: a different
    archive exists; or the existing archive is unreadable) it is never
    overwritten and the new text is never lost: the raw text is returned
    uncleaned (and rescored as such), no marker is set so nothing is stamped,
    and the row dict gets `archive_conflict` = the reason (a string) for the caller to count and
    for complete_with_clean_state() to un-stamp the state row.
    """
    languages = list(row.get("languages") or [])
    if not cleans_new_text(row, source):
        quality, relabel = text_quality.score_with_relabel(raw, languages)
        return raw, quality, relabel
    clean = text_clean.clean_pdf_text(raw, languages_for(row))
    quality, relabel = text_quality.score_with_relabel(clean, languages)
    if quality < text_quality.ACCEPT_THRESHOLD or not raw.strip():
        return clean, quality, relabel
    try:
        sha = raw_text_archive.save(settings.raw_dir, row["spider"], row["doc_id"], raw)
    except (FileExistsError, EOFError, OSError, zlib.error, UnicodeDecodeError) as exc:
        # OSError covers gzip.BadGzipFile. ValueError (unsafe doc_id) is not
        # caught: that is a hard failure for the row.
        existed = raw_text_archive.path_for(
            settings.raw_dir, row["spider"], row["doc_id"]).exists()
        if not existed:
            # No archive to conflict with: writing a NEW one failed (ENOSPC,
            # EACCES, ...). Same handling -- raw stored uncleaned, unstamped;
            # the backfill archives and cleans it once the disk is fixed.
            log.error("%s/%s: archive write failed (%s: %s); storing the new "
                      "raw text uncleaned and unstamped", row["spider"],
                      row["doc_id"], type(exc).__name__, exc)
            reason = f"archive write failed ({type(exc).__name__}: {exc})"
        else:
            log.warning("%s/%s: archive conflict (%s: %s); storing the new raw "
                        "text uncleaned and unstamped", row["spider"],
                        row["doc_id"], type(exc).__name__, exc)
            reason = "re-extracted raw differs from archive"
        if existed and isinstance(exc, FileExistsError):
            try:
                reason += " sha=" + raw_text_archive.sha256_of(
                    raw_text_archive.load(settings.raw_dir, row["spider"],
                                          row["doc_id"]))[:12]
            except Exception:                                   # noqa: BLE001
                pass
        elif existed:
            reason = f"existing archive unreadable ({type(exc).__name__})"
        row["archive_conflict"] = ("archive conflict: " + reason
                                   if existed else reason)
        quality, relabel = text_quality.score_with_relabel(raw, languages)
        if quality < text_quality.ACCEPT_THRESHOLD:
            # The raw text is below the gate, so the row goes to ocr_pending
            # and full_text is NOT written: the old state stays true. No
            # un-stamp, and the caller must not count a conflict.
            row.pop("archive_conflict")
        return raw, quality, relabel
    row["clean_sha256"] = sha
    return clean, quality, relabel


def complete_with_clean_state(conn, row, next_stage: str, **fields) -> None:
    """db.complete(), plus -- when clean_new_text() archived this row's raw
    text -- the stamped ch_text_clean_state row, in ONE transaction: a crash
    cannot leave a stamp over an old full_text or the reverse. (complete()
    alone commits per statement on the autocommit connection.)"""
    sha = row.get("clean_sha256")
    conflict = row.get("archive_conflict")
    if conflict:
        # New raw text is stored uncleaned; the old stamp (and its raw_sha256,
        # which points at the OLD archive) must go in the same transaction.
        with conn.transaction():
            db.complete(conn, row["doc_id"], next_stage, **fields)
            db.mark_clean_conflict(conn, row["doc_id"], row["spider"], conflict)
        return
    if not sha:
        if ("full_text" in fields and not row.get("cleaning_disabled")
                and clean_new_text_enabled()):
            # New full_text stored WITHOUT cleaning (HTML re-extract,
            # own-reflow spider): a stamp left behind would claim the old
            # archive describes this text. Un-stamp in the same transaction.
            if row["spider"] in text_clean.OWN_REFLOW_SPIDERS:
                why = "own-reflow spider"
            else:
                why = "non-pdf source"
            with conn.transaction():
                db.complete(conn, row["doc_id"], next_stage, **fields)
                db.unstamp_clean_state(conn, row["doc_id"],
                                       f"rewritten without cleaning ({why})")
            return
        db.complete(conn, row["doc_id"], next_stage, **fields)
        return
    with conn.transaction():
        db.complete(conn, row["doc_id"], next_stage, **fields)
        db.ensure_clean_state_stamped(conn, row["doc_id"], row["spider"], sha,
                                      text_clean.CLEANER_VERSION)


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
    # Keyset cursor (spider, doc_id): rows left pending in THIS run (failed,
    # conflicting, skipped, transient) are unstamped and would come straight
    # back from the claim; the cursor moves past every claimed row, so none is
    # read twice and each claim is an index range scan from where the last
    # one ended. A later run starts from the beginning again.
    cursor: tuple[str, str] | None = None
    try:
        while True:
            throttle.wait_for_capacity(settings.load_ceiling, STAGE)
            size = batch if remaining is None else min(batch, remaining)
            if size <= 0:
                break
            rows = db.claim_for_clean(conn, size, spider=spider,
                                      max_attempts=settings.max_attempts,
                                      after=cursor)
            if not rows:
                break
            cursor = (rows[-1]["spider"], rows[-1]["doc_id"])
            for row in rows:
                try:
                    _process(conn, settings, row, report)
                except _Pending:
                    pass
                except psycopg.OperationalError as exc:
                    # Lock or statement timeout: not the row's fault, so no
                    # attempt is spent. Left unstamped for a later run.
                    log.warning("%s/%s: transient: %s", row["spider"], row["doc_id"], exc)
                    report.transient += 1
                except Exception as exc:                        # noqa: BLE001
                    # An existing archive that cannot be read (EOFError,
                    # BadGzipFile/OSError, zlib.error, UnicodeDecodeError),
                    # an unsafe doc_id (ValueError) or a cleaner bug: one
                    # attempt spent, the decision row and archive untouched.
                    log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
                    msg = f"{type(exc).__name__}: {exc}"
                    if (isinstance(exc, OSError)
                            and not raw_text_archive.path_for(
                                settings.raw_dir, row["spider"],
                                row["doc_id"]).exists()):
                        # No archive on disk: writing it failed (ENOSPC,
                        # EACCES, ...). Same wording as the nightly path.
                        msg = f"archive write failed ({msg})"
                    db.fail_clean(conn, row["doc_id"], msg)
                    report.failed += 1
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
