"""Ticino flat page -> ch_act_article rows and plain text -- the TI twin of
cantonal_parse_stage, without the provenance half: the portal's footnotes
name the amending decree ("Modifica dell'art. 4 cpv. 1 approvata con
votazione popolare del 25.9.2016 ... in vigore dal 1.4.2018 - BU 2018, 81")
but there is no change-document index to link them to, so they are kept
as the article's notes (akn.Article.notes) and nothing else is claimed.

Per claimed row (stage 'fetched', source 'ti_rl'):
  1. ti_rl.parse_act(page) -> articles, full_text, meta;
  2. parse_akn_stage.store_articles() -- the same replace-not-upsert
     write the federal and Lexwork sides use;
  3. the act's date_document / date_entry_force from the page header and
     footer, COALESCE'd onto ch_act (the list gives date_document already;
     "Entrata in vigore" only the page has);
  4. complete_version(-> 'parsed', full_text=...).

A page that yields no article, or fewer than 200 characters of text, is
retired at once (max_attempts=1) with 'no_articles: ...' / 'short_text: ...'
as its reason: retrying the same page tomorrow does not grow it, and the
count is Gate F's business. A page the parser refuses outright (no content
div) fails with the parser's message and the normal retry budget, since
the fetch stage should not have stored it.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from .. import db, throttle, ti_rl
from ..config import Settings
from . import parse_akn_stage

log = logging.getLogger(__name__)

MIN_TEXT_CHARS = 200


@dataclass
class TiParseReport:
    parsed: int = 0
    articles: int = 0
    failed: int = 0
    no_articles: int = 0
    short_text: int = 0
    # (act_id, lang) of every edition promoted to 'parsed' -- what the
    # nightly delta narrows diff and project-legacy on.
    acts: set[tuple[int, str]] = field(default_factory=set)


_ACT_DATES = ("UPDATE ch_act SET date_document = COALESCE(date_document, %s), "
              "date_entry_force = COALESCE(date_entry_force, %s), updated_at = now() "
              "WHERE act_id = %s")


def run(settings: Settings, limit: int | None = None) -> TiParseReport:
    report = TiParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "ti-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="ti_rl")
            if not rows:
                break
            for row in rows:
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no page stored",
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    try:
                        articles, text, meta = ti_rl.parse_act(stored)
                    except ti_rl.TiParseError as exc:
                        db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
                        report.failed += 1
                        continue
                    if not articles:
                        db.fail_version(conn, row["version_id"],
                                        f"no_articles: {len(text)} chars of text, no 'Art. N' paragraph",
                                        max_attempts=1)
                        report.no_articles += 1
                        continue
                    if len(text) < MIN_TEXT_CHARS:
                        db.fail_version(conn, row["version_id"],
                                        f"short_text: {len(text)} chars, {len(articles)} article(s)",
                                        max_attempts=1)
                        report.short_text += 1
                        continue
                    with conn.transaction():
                        parse_akn_stage.store_articles(conn, row["version_id"], articles)
                        conn.execute(_ACT_DATES, (meta.get("date_document"),
                                                  meta.get("date_entry_force"), row["act_id"]))
                    db.complete_version(conn, row["version_id"], "parsed", full_text=text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: %s", row["version_id"], exc)
                    try:
                        db.fail_version(conn, row["version_id"], f"{exc}", settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("version %s: also failed recording the failure: %s",
                                  row["version_id"], fail_exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.acts.add((row["act_id"], row["lang"]))
                report.articles += len(articles)
            if remaining is not None:
                remaining -= len(rows)
            log.info("TI parsed=%d articles=%d failed=%d no_articles=%d short_text=%d",
                     report.parsed, report.articles, report.failed, report.no_articles,
                     report.short_text)
    finally:
        conn.close()
    return report


def main() -> TiParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. NICE_CPU: a CPU stage (lxml over every
    paragraph of ~600 pages); the capacity wait is in run()."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d failed=%d no_articles=%d short_text=%d", result.parsed,
             result.articles, result.failed, result.no_articles, result.short_text)
    if result.no_articles or result.short_text:
        log.warning("RETIRED: %d page(s) with no article and %d with under %d chars; "
                    "reasons in last_error, retry after fixing ti_rl.py",
                    result.no_articles, result.short_text, MIN_TEXT_CHARS)
    return result


if __name__ == "__main__":
    main()
