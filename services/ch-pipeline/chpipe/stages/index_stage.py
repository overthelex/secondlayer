"""Stage 1: enumerate documents and write their metadata.

This stage also repairs history. The 678,165 rows already in the table were
written by an importer that read the date from the wrong place, so all of them
have decision_date NULL. Re-running index over every spider fills those in.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from .. import db, es_document, es_listing
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)


@dataclass
class IndexReport:
    per_spider: dict[str, int] = field(default_factory=dict)
    inserted: int = 0
    updated: int = 0
    failed: int = 0


_UPSERT = """
INSERT INTO ch_court_decisions
    (ecli, doc_id, spider, canton, court_code, chamber, decision_date,
     docket_number, abstract, languages, html_url, pdf_url, json_url,
     metadata_json, stage, last_error, stage_updated_at, updated_at)
VALUES (%(ecli)s, %(doc_id)s, %(spider)s, %(canton)s, %(court_code)s, %(chamber)s,
        %(decision_date)s, %(docket_number)s, %(abstract)s, %(languages)s,
        %(html_url)s, %(pdf_url)s, %(json_url)s, %(metadata_json)s,
        %(stage)s, %(error)s, now(), now())
ON CONFLICT (ecli) DO UPDATE SET
    doc_id        = EXCLUDED.doc_id,
    canton        = EXCLUDED.canton,
    court_code    = COALESCE(EXCLUDED.court_code, ch_court_decisions.court_code),
    chamber       = COALESCE(EXCLUDED.chamber, ch_court_decisions.chamber),
    decision_date = COALESCE(EXCLUDED.decision_date, ch_court_decisions.decision_date),
    docket_number = COALESCE(EXCLUDED.docket_number, ch_court_decisions.docket_number),
    abstract      = COALESCE(EXCLUDED.abstract, ch_court_decisions.abstract),
    languages     = COALESCE(EXCLUDED.languages, ch_court_decisions.languages),
    html_url      = COALESCE(EXCLUDED.html_url, ch_court_decisions.html_url),
    pdf_url       = COALESCE(EXCLUDED.pdf_url, ch_court_decisions.pdf_url),
    json_url      = EXCLUDED.json_url,
    metadata_json = EXCLUDED.metadata_json,
    -- A row that already finished stays finished. Anything else re-enters the
    -- queue at the stage this run assigns. last_error must key on the SAME
    -- final-stage expression as `stage` above, not on EXCLUDED.stage alone —
    -- otherwise a protected 'loaded' row can be stamped with an error message
    -- that describes a stage it never actually entered, and a row recovering
    -- from 'failed' never gets its stale error cleared.
    stage         = CASE WHEN ch_court_decisions.stage = 'loaded'
                         THEN 'loaded' ELSE EXCLUDED.stage END,
    last_error    = CASE WHEN (CASE WHEN ch_court_decisions.stage = 'loaded'
                                    THEN 'loaded' ELSE EXCLUDED.stage END) = 'failed'
                         THEN %(error)s ELSE NULL END,
    stage_updated_at = now(),
    updated_at    = now()
RETURNING (xmax = 0) AS inserted
"""


def upsert(conn, fields: es_document.DocumentFields, available: set[str]) -> str:
    """Write one document's metadata. Returns 'inserted' or 'updated'.

    `available` is the extension set from the directory listing, which is the
    authority on what can actually be downloaded — the JSON payload sometimes
    names a PDF that is not mirrored.
    """
    has_body = bool(available & {"html", "pdf"})
    params = {
        "ecli": fields.ecli,
        "doc_id": fields.doc_id,
        "spider": fields.spider,
        "canton": fields.canton,
        "court_code": fields.court_code,
        "chamber": fields.chamber,
        "decision_date": fields.decision_date,
        "docket_number": fields.docket_number,
        "abstract": fields.abstract,
        "languages": fields.languages or None,
        "html_url": (es_listing.document_url(fields.spider, fields.doc_id, "html")
                     if "html" in available else None),
        "pdf_url": (es_listing.document_url(fields.spider, fields.doc_id, "pdf")
                    if "pdf" in available else None),
        "json_url": es_listing.document_url(fields.spider, fields.doc_id, "json"),
        "metadata_json": json.dumps(fields.metadata_json, ensure_ascii=False),
        "stage": "indexed" if has_body else "failed",
        "error": None if has_body else "no body: listing offers neither html nor pdf",
    }
    row = conn.execute(_UPSERT, params).fetchone()
    inserted = row["inserted"] if isinstance(row, dict) else row[0]
    return "inserted" if inserted else "updated"


async def _index_spider(fetcher: Fetcher, conn, spider: str, report: IndexReport) -> None:
    listing = await fetcher.text(es_listing.listing_url(spider))
    inventory = es_listing.parse_listing(listing)
    log.info("%s: %d documents in the listing", spider, len(inventory))
    report.per_spider[spider] = len(inventory)

    async def one(doc_id: str, available: set[str]) -> None:
        try:
            data = await fetcher.json(
                es_listing.document_url(spider, doc_id, "json"))
        except FetchError as exc:
            log.warning("%s/%s: %s", spider, doc_id, exc)
            report.failed += 1
            return
        # A malformed payload or a write error (e.g. a collision the ON CONFLICT
        # target does not cover) must not cancel the other 499 documents in this
        # slice, let alone the rest of the spider or the run. Log it — doc id and
        # exception both — and move on.
        try:
            fields = es_document.parse(spider, doc_id, data)
            outcome = upsert(conn, fields, available)
        except Exception as exc:
            log.error("%s/%s: %s", spider, doc_id, exc)
            report.failed += 1
            return
        if outcome == "inserted":
            report.inserted += 1
        else:
            report.updated += 1

    # Bounded by the fetcher's own semaphore; gather in slices so a spider with
    # 94,000 documents does not build a 94,000-entry task list at once.
    items = list(inventory.items())
    for start in range(0, len(items), 500):
        await asyncio.gather(*(one(d, e) for d, e in items[start:start + 500]))
        log.info("%s: %d/%d", spider, min(start + 500, len(items)), len(items))


async def _run_async(settings: Settings, spiders: list[str]) -> IndexReport:
    report = IndexReport()
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            for spider in spiders:
                await _index_spider(fetcher, conn, spider, report)
    finally:
        conn.close()
    return report


def run(settings: Settings, spiders: list[str] | None = None) -> IndexReport:
    return asyncio.run(_run_async(settings, spiders or ALL_SPIDERS))


# The 54 spiders present in the table on 2026-08-23. Discovered from the /docs/
# listing rather than hardcoded at runtime, but pinned here so a run is
# reproducible and a newly appearing spider is a visible diff, not a silent one.
ALL_SPIDERS = [
    "AG_Baugesetzgebung", "AG_Gerichte", "AG_Weitere", "AI_Aktuell", "AI_Bericht",
    "AR_Gerichte", "BE_Anwaltsaufsicht", "BE_BVD", "BE_Steuerrekurs",
    "BE_Verwaltungsgericht", "BE_Weitere", "BE_ZivilStraf", "BL_Gerichte", "BS_Omni",
    "CH_BGE", "CH_BGer", "CH_BPatG", "CH_BSTG", "CH_Bundesrat", "CH_BVGer",
    "CH_EDOEB", "CH_UNIBE", "CH_VB", "CH_WEKO", "FR_Gerichte", "GE_Gerichte",
    "GL_Omni", "GR_Gerichte", "JU_Gerichte", "LU_Gerichte", "NE_Omni", "NW_Gerichte",
    "OW_Gerichte", "SG_Gerichte", "SG_Publikationen", "SH_OG", "SO_Omni",
    "SZ_Gerichte", "SZ_Verwaltungsgericht", "TA_SST", "TG_OG", "TI_Gerichte",
    "UR_Gerichte", "VD_FindInfo", "VD_Omni", "VS_Gerichte", "XX_Upload",
    "ZG_Obergericht", "ZG_Verwaltungsgericht", "ZH_Baurekurs", "ZH_Obergericht",
    "ZH_Sozialversicherungsgericht", "ZH_Steuerrekurs", "ZH_Verwaltungsgericht",
]


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    selected = sys.argv[1:] or None
    result = run(Settings.from_env(), selected)
    log.info("inserted=%d updated=%d failed=%d", result.inserted, result.updated,
             result.failed)
