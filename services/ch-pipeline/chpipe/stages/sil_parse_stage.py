"""SIL page -> ch_act_article rows and plain text -- the SIL twin of
cantonal_parse_stage, without its provenance half: SIL pages carry no
modification table that names amending acts by id (GE's foot-of-page
table is free text and NE's footnotes are prose), so the notes stay on the
article (ch_act_article.notes) and no ch_article_provenance is written.

Per claimed row (stage 'fetched', source 'sil'):
  1. sil.parse_act(page) -> articles, full text, page dates;
  2. fewer than MIN_TEXT_CHARS of text, or no article at all, fails the
     row at once (max_attempts=1) with a counted reason -- 'short_text' /
     'no_articles' in Gate F's failed_by_reason. A page with prose but no
     "Art." (a treaty written as numbered paragraphs, a tariff that is one
     table) is exactly the row an operator should see listed, not one to
     retry tomorrow with the same parser;
  3. parse_akn_stage.store_articles() -- the same replace-not-upsert write,
     in one transaction -- then complete_version(-> 'parsed', full_text).
  4. When sil_acts_stage had to date the version with the run date
     (ch_act.metadata_json.sil_date_source = 'run') and the page prints
     an 'Etat au' / 'Dernières modifications au' date, date_applicability
     becomes that date and the source 'page'. eli_consolidation_uri keeps
     the discovery date: it is an identifier, not a claim.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from psycopg.rows import dict_row

from .. import db, sil, throttle
from ..config import Settings
from . import parse_akn_stage, sil_fetch_stage

log = logging.getLogger(__name__)

MIN_TEXT_CHARS = 200


@dataclass
class SilParseReport:
    parsed: int = 0
    articles: int = 0
    failed: int = 0
    short_text: int = 0
    no_articles: int = 0
    dates_from_page: int = 0
    # (act_id, lang) of every edition promoted to 'parsed', what the nightly
    # delta narrows diff and project-legacy on (cantonal_parse_stage's shape)
    acts: set[tuple[int, str]] = field(default_factory=set)


_LOAD = ("SELECT v.akn_xml, a.metadata_json FROM ch_act_version v JOIN ch_act a USING (act_id) "
         "WHERE v.version_id = %s")


def _refine_date(conn, row: dict, metadata: dict | None, parsed: sil.ParsedAct) -> bool:
    if (metadata or {}).get("sil_date_source") != "run" or not parsed.meta.get("date_state"):
        return False
    conn.execute("UPDATE ch_act_version SET date_applicability = %s WHERE version_id = %s",
                 (parsed.meta["date_state"], row["version_id"]))
    conn.execute("UPDATE ch_act SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || "
                 "jsonb_build_object('sil_date_source', 'page') WHERE act_id = %s",
                 (row["act_id"],))
    return True


def run(settings: Settings, canton_code: str | None = None,
        limit: int | None = None) -> SilParseReport:
    report = SilParseReport()
    prefix = sil_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            throttle.wait_for_capacity(settings.load_ceiling, "sil-parse")
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes,
                source="sil", url_prefix=prefix)
            if not rows:
                break
            for row in rows:
                try:
                    with conn.cursor(row_factory=dict_row) as cur:
                        cur.execute(_LOAD, (row["version_id"],))
                        loaded = cur.fetchone()
                    if not loaded or not loaded["akn_xml"]:
                        db.fail_version(conn, row["version_id"], "no payload", settings.max_attempts)
                        report.failed += 1
                        continue
                    parsed = sil.parse_act(loaded["akn_xml"])
                    if len(parsed.text) < MIN_TEXT_CHARS:
                        db.fail_version(conn, row["version_id"],
                                        f"short_text: {len(parsed.text)} chars", max_attempts=1)
                        report.short_text += 1
                        report.failed += 1
                        continue
                    if not parsed.articles:
                        db.fail_version(conn, row["version_id"],
                                        f"no_articles: {len(parsed.text)} chars of text, "
                                        "no Art. heading", max_attempts=1)
                        report.no_articles += 1
                        report.failed += 1
                        continue
                    with conn.transaction():
                        parse_akn_stage.store_articles(conn, row["version_id"], parsed.articles)
                        if _refine_date(conn, row, loaded["metadata_json"], parsed):
                            report.dates_from_page += 1
                    db.complete_version(conn, row["version_id"], "parsed", full_text=parsed.text)
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
                report.articles += len(parsed.articles)
            if remaining is not None:
                remaining -= len(rows)
            log.info("sil parsed=%d articles=%d failed=%d short_text=%d no_articles=%d "
                     "dates_from_page=%d", report.parsed, report.articles, report.failed,
                     report.short_text, report.no_articles, report.dates_from_page)
    finally:
        conn.close()
    return report


def main() -> SilParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 19 + capacity wait: lxml over Word
    HTML is a CPU stage, small as this corpus is (~1.7K pages)."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d failed=%d short_text=%d no_articles=%d dates_from_page=%d",
             result.parsed, result.articles, result.failed, result.short_text,
             result.no_articles, result.dates_from_page)
    return result


if __name__ == "__main__":
    main()
