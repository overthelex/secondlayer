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

from .. import db, es_document, es_listing, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)


@dataclass
class IndexReport:
    per_spider: dict[str, int] = field(default_factory=dict)
    inserted: int = 0
    updated: int = 0
    failed: int = 0
    # Spiders whose listing could not be read at all. Kept apart from
    # `failed`, which counts individual documents: "3 documents failed" and
    # "a whole court was never enumerated" are not the same finding, and
    # folding them together would hide the second inside the first.
    failed_spiders: list[str] = field(default_factory=list)


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
    -- A row that has already done work keeps it. Only 'loaded' was protected
    -- before, so re-running `index` -- which spec section 10 makes the normal
    -- ongoing operation for deltas -- threw every row at 'fetched',
    -- 'extracted' or 'ocr_pending' back to 'indexed' and forced a full
    -- re-download. write_body short-circuits the WRITE on a matching sha256
    -- but never the fetch, so the bytes come off the volunteer-run mirror
    -- again regardless. 'failed' and 'indexed' are deliberately NOT protected:
    -- a re-index is exactly the event that can give a failed row a body it
    -- did not have before.
    --
    -- last_error must key on the SAME final-stage expression as `stage`
    -- above, not on EXCLUDED.stage alone — otherwise a protected row can be
    -- stamped with an error message describing a stage it never entered, and
    -- a row recovering from 'failed' never gets its stale error cleared.
    stage         = CASE WHEN ch_court_decisions.stage IN
                              ('loaded','fetched','extracted','ocr_pending')
                         THEN ch_court_decisions.stage ELSE EXCLUDED.stage END,
    last_error    = CASE WHEN (CASE WHEN ch_court_decisions.stage IN
                                         ('loaded','fetched','extracted','ocr_pending')
                                    THEN ch_court_decisions.stage
                                    ELSE EXCLUDED.stage END) = 'failed'
                         THEN %(error)s ELSE NULL END,
    -- A row un-protected out of 'failed' is exactly db.complete()'s "moved
    -- forward" event (chpipe/db.py:143-144): the retry budget it exhausted
    -- getting here no longer describes anything, so it resets with
    -- failed_stage, the same pair complete() resets together. Keying this on
    -- the OLD stage being 'failed' -- not on "unprotected" generally --
    -- matters: a row already sitting at 'indexed' is also unprotected, but
    -- its attempts there can be a legitimate in-progress count owned by a
    -- concurrent fetch-stage claim, and clobbering that out from under it
    -- would be a second bug, not a fix.
    attempts      = CASE WHEN ch_court_decisions.stage = 'failed'
                         THEN 0 ELSE ch_court_decisions.attempts END,
    failed_stage  = CASE WHEN ch_court_decisions.stage = 'failed'
                         THEN NULL ELSE ch_court_decisions.failed_stage END,
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


async def _listing_inventory(fetcher: Fetcher, spider: str) -> dict[str, frozenset[str]]:
    """doc_id -> available extensions, streamed rather than buffered.

    Measured: the CH_BGer listing is 116,000,062 bytes and takes 132.9 s.
    Fetcher.text() holds all of it as one string and _HREF.findall then
    materialises ~400,000 more strings on top of that. Streaming holds one
    64 KB chunk plus the inventory itself, and the inventory's extension
    sets are interned down to eight shared frozensets.
    """
    bits: dict[str, int] = {}
    buffer = ""
    async for chunk in fetcher.stream_text(es_listing.listing_url(spider)):
        buffer += chunk
        for doc_id, bit in es_listing.iter_listing_entries([buffer]):
            bits[doc_id] = bits.get(doc_id, 0) | bit
        buffer = es_listing.carry_over(buffer)
    for doc_id, bit in es_listing.iter_listing_entries([buffer]):
        bits[doc_id] = bits.get(doc_id, 0) | bit
    return {doc_id: es_listing.extension_set(value) for doc_id, value in bits.items()}


async def _index_spider(fetcher: Fetcher, conn, spider: str, report: IndexReport) -> None:
    inventory = await _listing_inventory(fetcher, spider)
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
                # One failed listing must not discard the work already done
                # on the other 53. The listing fetch was bare and this loop
                # was unguarded, so a single FetchError -- on a 116 MB
                # download that takes 132.9 s and would be re-downloaded
                # from byte zero on a retry -- aborted the entire run.
                try:
                    await _index_spider(fetcher, conn, spider, report)
                except Exception as exc:               # noqa: BLE001
                    log.error("%s: listing failed, skipping this spider: %s",
                              spider, exc)
                    report.failed_spiders.append(spider)
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


def main(argv: list[str] | None = None) -> IndexReport:
    """Entry point. Kept as a function, not an `if __name__` block, so the
    spider-selection rule below is reachable from a test.

    argv wins when given, since it is the only way to pass more than one
    spider ("python -m chpipe.stages.index_stage A B C" -- genuinely useful
    and kept). Otherwise fall back to CHPIPE_SPIDER, the single-spider env
    var every other stage honours and the one run-stage.sh sets. Without
    that fallback, `./run-stage.sh index <spider>` silently ran over all 54
    spiders, because run-stage.sh invokes `python3 -m
    chpipe.stages.index_stage` with no extra argv at all -- it only ever
    exported CHPIPE_SPIDER, which the old block never read. That bug shipped
    once already and walked the whole corpus; it now has a test.
    """
    import os
    import sys
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    args = sys.argv[1:] if argv is None else argv
    if args:
        selected = list(args)
    elif os.environ.get("CHPIPE_SPIDER"):
        selected = [os.environ["CHPIPE_SPIDER"]]
    else:
        selected = None
    result = run(Settings.from_env(), selected)
    log.info("inserted=%d updated=%d failed=%d failed_spiders=%s",
             result.inserted, result.updated, result.failed,
             ",".join(result.failed_spiders) or "none")
    return result


if __name__ == "__main__":
    main()
