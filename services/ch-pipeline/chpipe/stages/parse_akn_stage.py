"""AKN XML -> ch_act_article rows plus a plain-text rendering of the edition.

Reads ch_act_version.akn_xml back out of Postgres as a Python str (a `text`
column round-trips through psycopg as str, not bytes) and re-encodes it as
UTF-8 before handing it to chpipe.akn. That re-encode is only safe because
of what fetch_xml_stage wrote in the first place: it re-serialises every
document through lxml with an explicit UTF-8 declaration before storing it
(see fetch_xml_stage's module docstring), so the declared encoding inside
the text this stage reads back always matches the UTF-8 bytes it produces
here. Without that normalisation at write time, a document that declared a
non-UTF-8 encoding would round-trip as a str correctly, but re-encoding it
as UTF-8 and handing it to a parser that honours the (still non-UTF-8)
prolog would double-decode the text -- the same class of corruption
fetch_stage.py's to_utf8() exists to prevent on the court-decisions side.
Conclusion: the round trip through the text column does not change the
bytes the parser sees, precisely because fetch_xml_stage already normalised
the encoding declaration before the column was ever written.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import akn, db
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ParseReport:
    parsed: int = 0
    articles: int = 0
    empty: int = 0
    failed: int = 0


def store_articles(conn, version_id: int, articles: list[akn.Article]) -> int:
    """Replace this version's articles. Replace rather than upsert: an
    edition's XML is immutable once fetched, so the only reason to parse it
    twice is that the *parser* changed -- and when that happens, every row
    from the old parse is stale, not just the ones whose e_id changed. An
    upsert-by-e_id would leave orphaned rows behind whenever the parser
    starts recognising an eId it used to miss, or stops recognising one it
    used to produce, so this deletes the version's rows outright and
    reinserts the full set inside the same call."""
    conn.execute("DELETE FROM ch_act_article WHERE version_id = %s", (version_id,))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO ch_act_article (version_id, e_id, article_number, "
            "marginal_note, text, ordinal, parent_e_id, notes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            [(version_id, a.e_id, a.article_number, a.marginal_note, a.text,
              a.ordinal, a.parent_e_id, list(a.notes)) for a in articles])
    conn.execute("UPDATE ch_act_version SET article_count = %s WHERE version_id = %s",
                 (len(articles), version_id))
    return len(articles)


def run(settings: Settings, limit: int | None = None) -> ParseReport:
    report = ParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            rows = db.claim_versions(conn, "fetched", limit=size,
                                     max_attempts=settings.max_attempts)
            if not rows:
                break
            for row in rows:
                # One bad edition -- a parser exception, a write failure --
                # must not abort a run over 12,033 of them. Same per-item
                # guard as extract_stage.run(): the whole per-row body is
                # wrapped, not just the parse call, so a failure on the
                # store_articles()/complete_version() write is caught the
                # same way as a failure inside chpipe.akn.
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no akn_xml",
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    # See the module docstring for why re-encoding as UTF-8
                    # here is safe given how fetch_xml_stage normalised the
                    # document before writing this column.
                    payload = stored.encode("utf-8")
                    articles = akn.parse_articles(payload)
                    text = akn.plain_text(payload)
                    store_articles(conn, row["version_id"], articles)
                    db.complete_version(conn, row["version_id"], "parsed",
                                        full_text=text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: %s", row["version_id"], exc)
                    try:
                        db.fail_version(conn, row["version_id"], f"{exc}",
                                        settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("version %s: also failed recording the "
                                  "failure: %s", row["version_id"], fail_exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.articles += len(articles)
                if not articles:
                    report.empty += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("parsed=%d articles=%d empty=%d failed=%d", report.parsed,
                     report.articles, report.empty, report.failed)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d empty=%d failed=%d", result.parsed,
             result.articles, result.empty, result.failed)
