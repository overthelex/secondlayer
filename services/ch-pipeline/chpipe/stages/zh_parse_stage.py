"""ZH-Lex Domino HTML -> ch_act_article rows and plain text: the ZH twin
of cantonal_parse_stage, minus provenance (the loose-leaf pages carry
footnotes, not a modification table; the footnotes travel as
akn.Article.notes).

Per claimed row (stage 'fetched', source 'zhlex', WebRT prefix):
zhlex.parse_webrt(akn_xml) -> parse_akn_stage.store_articles() (the same
replace-not-upsert write, in one transaction) -> complete_version(->
'parsed', full_text). akn_xml was decoded at fetch time and is UTF-8
text; it is re-encoded here so the parser sees one input type.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from .. import db, throttle, zhlex
from ..config import Settings
from . import parse_akn_stage

log = logging.getLogger(__name__)


@dataclass
class ParseReport:
    parsed: int = 0
    articles: int = 0
    failed: int = 0
    acts: set[tuple[int, str]] = field(default_factory=set)


def run(settings: Settings, limit: int | None = None) -> ParseReport:
    report = ParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "zh-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="zhlex", url_prefix=zhlex.WEBRT_PREFIX)
            if not rows:
                break
            for row in rows:
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no payload", settings.max_attempts)
                        report.failed += 1
                        continue
                    articles, text = zhlex.parse_webrt(stored.encode("utf-8"), "text/html; charset=utf-8")
                    parse_akn_stage.store_articles(conn, row["version_id"], articles)
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
                report.articles += len(articles)
                report.acts.add((row["act_id"], row["lang"]))
            if remaining is not None:
                remaining -= len(rows)
            log.info("zh parsed=%d articles=%d failed=%d", report.parsed, report.articles, report.failed)
    finally:
        conn.close()
    return report


def main() -> ParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a CPU stage."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d failed=%d", result.parsed, result.articles, result.failed)
    return result


if __name__ == "__main__":
    main()
