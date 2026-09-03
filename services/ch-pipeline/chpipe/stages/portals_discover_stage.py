"""Discovery for the portal spiders (chpipe/portals): each portal's listing
into ch_court_decisions at stage 'indexed', where fetch / extract / ocr /
load / citations pick the rows up exactly as they do entscheidsuche's
(LEXAI-2039, gap plan phase 2).

Upsert on ecli (`ECLI:CH:{spider}:{doc_id}`). Metadata is refreshed on
every walk; the stage is not touched unless the document's URL changed,
in which case the row goes back to 'indexed' with a fresh attempt budget
so fetch re-downloads it. A row the listing no longer shows is left alone
and counted as `stale` -- a portal that reorganises its page must not
delete a corpus.

The title goes into `abstract`: that is the column ch_search_court_decisions
ranks on, and a regulator's decision has no Regeste of its own.

    ./run-stage.sh portals-discover            # every portal
    ./run-stage.sh portals-discover CH_ELCOM   # one

Politeness is per portal (their modules' delays); the Fetcher runs one
request at a time.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field

import psycopg

from .. import db, throttle
from ..config import Settings
from ..http import Fetcher
from ..portals import PORTALS
from ..portals.common import PortalDoc

log = logging.getLogger(__name__)

REQUEST_DELAY = 1.0     # seconds between a portal's requests (Fetcher concurrency is 1)


@dataclass
class PortalsDiscoverReport:
    spiders: list[str] = field(default_factory=list)
    discovered: int = 0          # docs the portals returned
    upserted: int = 0
    inserted: int = 0
    requeued: int = 0
    stale: int = 0
    errors: int = 0              # portals that could not be listed (an outage: exit status 1)
    doc_errors: int = 0          # single rows that failed to upsert (logged, the spider goes on)
    by_spider: dict[str, int] = field(default_factory=dict)


_UPSERT = """
WITH old AS (
    SELECT html_url, pdf_url FROM ch_court_decisions WHERE ecli = %(ecli)s
)
INSERT INTO ch_court_decisions
    (ecli, spider, doc_id, canton, court_code, court_name, chamber, decision_type,
     decision_date, docket_number, abstract, languages, metadata_json,
     html_url, pdf_url, text_source, stage, attempts, imported_at, updated_at)
VALUES
    (%(ecli)s, %(spider)s, %(doc_id)s, 'CH', %(court_code)s, %(court_name)s, %(chamber)s,
     %(decision_type)s, %(decision_date)s, %(docket_number)s, %(abstract)s, %(languages)s,
     %(metadata)s::jsonb, %(html_url)s, %(pdf_url)s, %(text_source)s, 'indexed', 0, now(), now())
ON CONFLICT (ecli) DO UPDATE SET
    doc_id         = COALESCE(ch_court_decisions.doc_id, EXCLUDED.doc_id),
    court_name     = EXCLUDED.court_name,
    chamber        = COALESCE(EXCLUDED.chamber, ch_court_decisions.chamber),
    decision_type  = EXCLUDED.decision_type,
    decision_date  = COALESCE(EXCLUDED.decision_date, ch_court_decisions.decision_date),
    docket_number  = COALESCE(EXCLUDED.docket_number, ch_court_decisions.docket_number),
    abstract       = COALESCE(EXCLUDED.abstract, ch_court_decisions.abstract),
    languages      = COALESCE(EXCLUDED.languages, ch_court_decisions.languages),
    metadata_json  = COALESCE(ch_court_decisions.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
    -- A new file means a new text: back to the queue with a fresh budget.
    stage          = CASE WHEN ch_court_decisions.html_url IS DISTINCT FROM EXCLUDED.html_url
                            OR ch_court_decisions.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                          THEN 'indexed' ELSE ch_court_decisions.stage END,
    attempts       = CASE WHEN ch_court_decisions.html_url IS DISTINCT FROM EXCLUDED.html_url
                            OR ch_court_decisions.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                          THEN 0 ELSE ch_court_decisions.attempts END,
    last_error     = CASE WHEN ch_court_decisions.html_url IS DISTINCT FROM EXCLUDED.html_url
                            OR ch_court_decisions.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                          THEN NULL ELSE ch_court_decisions.last_error END,
    failed_stage   = CASE WHEN ch_court_decisions.html_url IS DISTINCT FROM EXCLUDED.html_url
                            OR ch_court_decisions.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                          THEN NULL ELSE ch_court_decisions.failed_stage END,
    html_url       = EXCLUDED.html_url,
    pdf_url        = EXCLUDED.pdf_url,
    text_source    = EXCLUDED.text_source,
    updated_at     = now()
RETURNING (xmax = 0) AS inserted,
          (xmax <> 0 AND ((SELECT html_url FROM old) IS DISTINCT FROM ch_court_decisions.html_url
                       OR (SELECT pdf_url FROM old) IS DISTINCT FROM ch_court_decisions.pdf_url)) AS requeued
"""

_KNOWN = "SELECT doc_id FROM ch_court_decisions WHERE spider = %s AND doc_id IS NOT NULL"


def row_for(portal, doc: PortalDoc) -> dict:
    return {
        "ecli": f"ECLI:CH:{portal.SPIDER}:{doc.doc_id}",
        "spider": portal.SPIDER,
        "doc_id": doc.doc_id,
        "court_code": portal.SPIDER,
        "court_name": portal.COURT_NAME,
        "chamber": doc.chamber,
        "decision_type": doc.decision_type or portal.DECISION_TYPE,
        "decision_date": doc.decision_date,
        "docket_number": doc.docket_number,
        "abstract": doc.title,
        "languages": [doc.lang] if doc.lang else None,
        "metadata": json.dumps({"portal": {**doc.extra, "title": doc.title, "url": doc.url},
                                **({"Sprache": doc.lang} if doc.lang else {})},
                               ensure_ascii=False, default=str),
        "html_url": doc.url if doc.text_source == "html" else None,
        "pdf_url": doc.url if doc.text_source == "pdf" else None,
        "text_source": doc.text_source,
    }


def upsert(conn, portal, doc: PortalDoc) -> tuple[bool, bool]:
    result = conn.execute(_UPSERT, row_for(portal, doc)).fetchone()
    if isinstance(result, dict):
        return bool(result["inserted"]), bool(result["requeued"])
    return bool(result[0]), bool(result[1])


class _PacedFetcher:
    """The Fetcher with a pause before every request -- the portals are
    federal offices with one server each, and 1 req/s is the pace the
    other open re-user of these sites runs at."""

    def __init__(self, fetcher: Fetcher, delay: float):
        self._f = fetcher
        self._delay = delay

    async def text(self, url):
        await asyncio.sleep(self._delay)
        return await self._f.text(url)

    async def post_json(self, url, data, headers=None):
        await asyncio.sleep(self._delay)
        return await self._f.post_json(url, data, headers)

    async def body(self, url):
        await asyncio.sleep(self._delay)
        return await self._f.body(url)


async def _run_async(settings: Settings, spiders: list[str], transport, delay: float) -> PortalsDiscoverReport:
    report = PortalsDiscoverReport(spiders=list(spiders))
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=1, transport=transport) as raw:
            fetcher = _PacedFetcher(raw, delay)
            for name in spiders:
                portal = PORTALS[name]
                with conn.cursor() as cur:
                    cur.execute(_KNOWN, (name,))
                    known = {r[0] if not isinstance(r, dict) else r["doc_id"] for r in cur.fetchall()}
                try:
                    docs = await portal.discover(fetcher, known)
                except Exception as exc:                  # noqa: BLE001
                    log.error("%s: discover failed: %s", name, exc)
                    report.errors += 1
                    continue
                # A portal's discover() logs and swallows a FetchError; nothing
                # back from a listing that always has rows is that outage. An
                # incremental walk (EMARK) returns only what is new: empty is fine.
                incremental = getattr(portal, "INCREMENTAL", False)
                if not docs and not incremental:
                    log.error("%s: listing returned nothing", name)
                    report.errors += 1
                    continue
                seen: set[str] = set()
                wrote = 0
                for doc in docs:
                    if doc.doc_id in seen:
                        continue
                    seen.add(doc.doc_id)
                    report.discovered += 1
                    try:
                        inserted, requeued = upsert(conn, portal, doc)
                    except (psycopg.DataError, psycopg.IntegrityError) as exc:
                        # This row's values (a date the column refuses, an ecli
                        # clash): logged, the spider goes on. A lost connection
                        # or a missing column is not a row's fault and propagates.
                        log.error("%s %s: upsert failed: %s", name, doc.doc_id, exc)
                        report.doc_errors += 1
                        continue
                    report.upserted += 1
                    wrote += 1
                    report.inserted += int(inserted)
                    report.requeued += int(requeued)
                report.by_spider[name] = len(seen)
                if seen and not wrote:
                    # Every row refused: not a row's fault either, and fetch must not run on nothing.
                    log.error("%s: none of %d rows could be written", name, len(seen))
                    report.errors += 1
                    continue
                # An incremental walk never re-lists what it knows: no stale accounting.
                if not incremental:
                    report.stale += len(known - seen)
                log.info("%s: discovered=%d new=%d known=%d", name, len(seen),
                         sum(1 for d in seen if d not in known), len(known))
    finally:
        conn.close()
    return report


def run(settings: Settings, spider: str | None = None, transport=None,
        delay: float = REQUEST_DELAY) -> PortalsDiscoverReport:
    if spider:
        unknown = [s for s in spider.split(",") if s.strip() and s.strip() not in PORTALS]
        if unknown:
            raise ValueError(f"not a portal spider: {', '.join(unknown)} (known: {', '.join(sorted(PORTALS))})")
        spiders = [s.strip() for s in spider.split(",") if s.strip()]
    else:
        spiders = sorted(PORTALS)
    return asyncio.run(_run_async(settings, spiders, transport, delay))


def main() -> PortalsDiscoverReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. CHPIPE_SPIDER selects one portal (or a
    comma-separated few), the way the decisions stages read it."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("portals-discover spiders=%s discovered=%d upserted=%d inserted=%d requeued=%d "
             "stale=%d errors=%d doc_errors=%d by_spider=%s",
             ",".join(result.spiders), result.discovered, result.upserted, result.inserted,
             result.requeued, result.stale, result.errors, result.doc_errors, result.by_spider)
    return result


if __name__ == "__main__":
    # A portal that could not be listed is an outage cron must see: the exit
    # status says so, and run-portals.sh carries it to its own status. A row
    # that failed to upsert is logged and does not hold the spider back.
    sys.exit(1 if main().errors else 0)
