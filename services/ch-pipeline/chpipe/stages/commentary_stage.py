"""Open-access commentaries from onlinekommentar.ch into ch_commentary
(migration 208, LEXAI-2037).

Walk: for each language, every list page (8 of 50), then the detail of every
commentary whose listed `date` differs from the stored version_date -- the
listing already carries the date, so an unchanged commentary costs one
fiftieth of a request and the weekly run is ~32 requests, not ~1,600. The
first run fetches everything: 391 x 4 details at one request per second is
under half an hour.

Every write is an upsert on (source, source_id); a row that the listing no
longer mentions is left in place with its last_seen_at untouched and counted
as `stale` in the report -- nothing is deleted by a walk that may itself
have been the one that missed a page.

The act is resolved in two steps: the source's act uuid through
onlinekommentar.ACT_BY_UUID (23 acts, verified against ch_act), then the
abbreviation in the title through ch_act_alias (jurisdiction CH, the
record's language first, then the Fedlex abbreviations regardless of
language). A commentary that resolves neither way keeps sr_number NULL and
is counted as `unresolved` -- the text is still stored and searchable.

Politeness: sequential requests with CHPIPE_COMMENTARY_DELAY seconds between
them (default 1.0), the pace the site's other open re-user runs at. The
first live walk at 0.5 s drew two 429s in 391 requests, and the Fetcher's
three attempts with 1 s / 2 s back-off were not enough to outwait them, so a
detail that fails is retried once more here after CHPIPE_COMMENTARY_RETRY_WAIT
seconds (default 30) before it is counted as an error.

Env:
    CHPIPE_COMMENTARY_LANGS       comma-separated subset of de,fr,it,en (default all)
    CHPIPE_COMMENTARY_DELAY       seconds between requests (default 1.0)
    CHPIPE_COMMENTARY_RETRY_WAIT  seconds to wait before the one extra retry (default 30)
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import db, onlinekommentar, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)


@dataclass
class CommentaryReport:
    langs: list[str] = field(default_factory=list)
    listed: int = 0
    fetched: int = 0
    upserted: int = 0
    skipped_unchanged: int = 0
    unresolved: int = 0
    stale: int = 0
    retried: int = 0
    errors: int = 0
    by_lang: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO ch_commentary
    (source, source_id, lang, kind, sr_number, act_uuid, act_title, abbr, article_number,
     title, authors, editors, version_date, suggested_citation, content_html, content_text,
     legal_text, licence, source_url, pdf_url, content_hash, fetched_at, last_seen_at)
VALUES
    (%(source)s, %(source_id)s, %(lang)s, %(kind)s, %(sr_number)s, %(act_uuid)s, %(act_title)s,
     %(abbr)s, %(article_number)s, %(title)s, %(authors)s, %(editors)s, %(version_date)s,
     %(suggested_citation)s, %(content_html)s, %(content_text)s, %(legal_text)s, %(licence)s,
     %(source_url)s, %(pdf_url)s, %(content_hash)s, now(), now())
ON CONFLICT (source, source_id) DO UPDATE SET
    lang               = EXCLUDED.lang,
    kind               = EXCLUDED.kind,
    sr_number          = EXCLUDED.sr_number,
    act_uuid           = EXCLUDED.act_uuid,
    act_title          = EXCLUDED.act_title,
    abbr               = EXCLUDED.abbr,
    article_number     = EXCLUDED.article_number,
    title              = EXCLUDED.title,
    authors            = EXCLUDED.authors,
    editors            = EXCLUDED.editors,
    version_date       = EXCLUDED.version_date,
    suggested_citation = EXCLUDED.suggested_citation,
    content_html       = EXCLUDED.content_html,
    content_text       = EXCLUDED.content_text,
    legal_text         = EXCLUDED.legal_text,
    licence            = EXCLUDED.licence,
    source_url         = EXCLUDED.source_url,
    pdf_url            = EXCLUDED.pdf_url,
    content_hash       = EXCLUDED.content_hash,
    fetched_at         = now(),
    last_seen_at       = now()
"""

_TOUCH = "UPDATE ch_commentary SET last_seen_at = now() WHERE source = %s AND source_id = %s"

_STORED = """
SELECT source_id, to_char(version_date, 'YYYY-MM-DD') AS version_date
  FROM ch_commentary WHERE source = %s
"""

_ALIAS_LANG = """
SELECT DISTINCT sr_number FROM ch_act_alias
 WHERE jurisdiction = 'CH' AND abbr = %s AND (lang = %s OR lang = 'any')
"""
_ALIAS_FEDLEX = """
SELECT DISTINCT sr_number FROM ch_act_alias
 WHERE jurisdiction = 'CH' AND abbr = %s AND source = 'fedlex_abbreviation'
"""


def resolve_sr(conn, act_uuid: str | None, abbr: str | None, lang: str) -> str | None:
    """SR number for a commentary: the curated uuid map first, the alias
    table second, and only an UNAMBIGUOUS alias hit counts -- "OR" is 220 in
    German and 511.11 as an Italian title abbreviation, so a multi-hit is
    None, not a guess."""
    if act_uuid and act_uuid in onlinekommentar.ACT_BY_UUID:
        return onlinekommentar.ACT_BY_UUID[act_uuid]
    if not abbr:
        return None
    if abbr in onlinekommentar.ABBR_FALLBACK:
        return onlinekommentar.ABBR_FALLBACK[abbr]
    # An explicit tuple cursor: db.connect() hands out dict rows, the test
    # suite's plain psycopg.connect() tuples, and this must read the same
    # either way.
    with conn.cursor(row_factory=tuple_row) as cur:
        for sql, params in ((_ALIAS_LANG, (abbr, lang)), (_ALIAS_FEDLEX, (abbr,))):
            rows = cur.execute(sql, params).fetchall()
            if len(rows) == 1:
                return rows[0][0]
    return None


def langs_from_env(raw: str | None) -> list[str]:
    if not raw:
        return list(onlinekommentar.LANGS)
    out = [s.strip().lower() for s in raw.split(",") if s.strip()]
    unknown = [l for l in out if l not in onlinekommentar.LANGS]
    if unknown:
        raise ValueError(f"not an onlinekommentar language: {', '.join(unknown)}")
    return out


async def _detail(client: onlinekommentar.OnlinekommentarClient, uuid: str,
                  report: CommentaryReport, retry_wait: float) -> dict:
    """One detail, with the one extra wait-and-retry the 429s call for."""
    try:
        return await client.detail(uuid)
    except FetchError as first:
        log.warning("%s: %s -- waiting %.0fs and retrying once", uuid, first, retry_wait)
        report.retried += 1
        await asyncio.sleep(retry_wait)
        return await client.detail(uuid)


async def _walk_lang(client: onlinekommentar.OnlinekommentarClient, conn, lang: str,
                     stored: dict[str, str | None], seen: set[str],
                     report: CommentaryReport, delay: float, retry_wait: float) -> None:
    page_no = 1
    while True:
        try:
            page = await client.list_page(lang, page_no)
        except FetchError as exc:
            log.error("%s page %d: %s", lang, page_no, exc)
            report.errors += 1
            return
        items = onlinekommentar.list_items(page)
        for item in items:
            uuid = item.get("id")
            if not uuid:
                continue
            report.listed += 1
            seen.add(uuid)
            listed_date = (item.get("date") or None)
            if uuid in stored and stored[uuid] == listed_date:
                conn.execute(_TOUCH, (onlinekommentar.SOURCE, uuid))
                report.skipped_unchanged += 1
                continue
            await asyncio.sleep(delay)
            try:
                detail = await _detail(client, uuid, report, retry_wait)
            except FetchError as exc:
                log.error("%s %s: %s", lang, uuid, exc)
                report.errors += 1
                continue
            report.fetched += 1
            row = onlinekommentar.record(detail, lang)
            row["sr_number"] = resolve_sr(conn, row["act_uuid"], row["abbr"], row["lang"])
            if row["sr_number"] is None:
                report.unresolved += 1
                log.warning("%s %s: act not resolved (uuid=%s abbr=%s title=%r)",
                            lang, uuid, row["act_uuid"], row["abbr"], row["title"])
            conn.execute(_UPSERT, row)
            report.upserted += 1
            report.by_lang[lang] = report.by_lang.get(lang, 0) + 1
            if report.upserted % 100 == 0:
                log.info("commentary listed=%d fetched=%d upserted=%d skipped=%d unresolved=%d",
                         report.listed, report.fetched, report.upserted,
                         report.skipped_unchanged, report.unresolved)
        if page_no >= onlinekommentar.last_page(page) or not items:
            return
        page_no += 1
        await asyncio.sleep(delay)


async def _run_async(settings: Settings, langs: list[str], transport, delay: float,
                     retry_wait: float) -> CommentaryReport:
    report = CommentaryReport(langs=list(langs))
    conn = db.connect(settings)
    try:
        with conn.cursor(row_factory=tuple_row) as cur:
            stored = {sid: vd for sid, vd in cur.execute(_STORED, (onlinekommentar.SOURCE,)).fetchall()}
        seen: set[str] = set()
        async with Fetcher(concurrency=1, transport=transport) as fetcher:
            client = onlinekommentar.OnlinekommentarClient(fetcher)
            for lang in langs:
                await _walk_lang(client, conn, lang, stored, seen, report, delay, retry_wait)
        report.stale = len(set(stored) - seen)
    finally:
        conn.close()
    return report


def run(settings: Settings, langs: list[str] | None = None, transport=None,
        delay: float = 1.0, retry_wait: float = 30.0) -> CommentaryReport:
    return asyncio.run(_run_async(settings, langs or list(onlinekommentar.LANGS), transport,
                                  delay, retry_wait))


def main() -> CommentaryReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 langs=langs_from_env(os.environ.get("CHPIPE_COMMENTARY_LANGS")),
                 delay=float(os.environ.get("CHPIPE_COMMENTARY_DELAY") or 1.0),
                 retry_wait=float(os.environ.get("CHPIPE_COMMENTARY_RETRY_WAIT") or 30.0))
    log.info("commentary langs=%s listed=%d fetched=%d upserted=%d skipped_unchanged=%d "
             "unresolved=%d stale=%d retried=%d errors=%d by_lang=%s",
             ",".join(result.langs), result.listed, result.fetched, result.upserted,
             result.skipped_unchanged, result.unresolved, result.stale, result.retried,
             result.errors, result.by_lang)
    return result


if __name__ == "__main__":
    main()
