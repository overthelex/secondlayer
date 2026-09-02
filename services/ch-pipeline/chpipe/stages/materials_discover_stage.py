"""Discovery of Federal Gazette materials -- Botschaften, Federal Council
reports and opinions, committee reports -- into ch_material (migration
209, LEXAI-2038).

One keyset walk of fedlex_queries.MATERIALS: every jolux:Act in /eli/fga/
whose typeDocument is one of the four material types, joined to its
de/fr/it expressions and each expression's pdf-a file. ~10.5K rows in
~16 pages of 2,000 (measured 2026-09-02: 3,527 works, 3,523 with a pdf-a
in every language), twenty seconds end to end -- cheap enough to run in
full every night rather than track a delta.

Every write is an upsert on (eli_work_uri, lang). Metadata is refreshed on
every walk; the queue stage is NOT -- a parsed row stays parsed unless the
pdf_url itself changed, in which case it goes back to 'discovered' so the
text stage re-fetches the new file. A row the walk no longer sees is left
alone.

as_id is looked up in ch_as_act by ELI at upsert time; that table is the
AS/BBl metadata as_bbl_stage walks, and the link is informational (NULL
when the walks are out of step), not load-bearing -- bbl_key is what the
serving side joins on.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .. import bbl, db, throttle
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import DEFAULT_PAGE_SIZE, SparqlClient

log = logging.getLogger(__name__)


@dataclass
class MaterialsDiscoverReport:
    rows: int = 0                 # bindings walked
    upserted: int = 0
    inserted: int = 0             # of those, new (eli, lang) pairs
    requeued: int = 0             # parsed/failed rows whose pdf_url changed
    skipped_lang: int = 0         # ENG/ROH expressions, not stored
    skipped_type: int = 0         # a typeDocument outside MATERIAL_TYPES (cannot happen by the query's FILTER)
    by_type: dict[str, int] = field(default_factory=dict)


# `old` reads the row as it was before this statement (a data-modifying
# statement's CTE sees the pre-statement snapshot), which is how RETURNING
# can say whether the pdf_url changed -- the new row alone cannot.
_UPSERT = """
WITH old AS (
    SELECT pdf_url FROM ch_material WHERE eli_work_uri = %(eli)s AND lang = %(lang)s
)
INSERT INTO ch_material
    (eli_work_uri, lang, material_type, type_uri, title, historical_id, bbl_key,
     memorial_year, memorial_page, date_document, publication_date, pdf_url, as_id,
     stage, updated_at)
VALUES
    (%(eli)s, %(lang)s, %(material_type)s, %(type_uri)s, %(title)s, %(historical_id)s,
     %(bbl_key)s, %(memorial_year)s, %(memorial_page)s, %(date_document)s,
     %(publication_date)s, %(pdf_url)s,
     (SELECT as_id FROM ch_as_act WHERE eli_uri = %(eli)s), 'discovered', now())
ON CONFLICT (eli_work_uri, lang) DO UPDATE SET
    material_type    = EXCLUDED.material_type,
    type_uri         = EXCLUDED.type_uri,
    title            = COALESCE(EXCLUDED.title, ch_material.title),
    historical_id    = COALESCE(EXCLUDED.historical_id, ch_material.historical_id),
    bbl_key          = COALESCE(EXCLUDED.bbl_key, ch_material.bbl_key),
    memorial_year    = COALESCE(EXCLUDED.memorial_year, ch_material.memorial_year),
    memorial_page    = COALESCE(EXCLUDED.memorial_page, ch_material.memorial_page),
    date_document    = COALESCE(EXCLUDED.date_document, ch_material.date_document),
    publication_date = COALESCE(EXCLUDED.publication_date, ch_material.publication_date),
    as_id            = COALESCE(EXCLUDED.as_id, ch_material.as_id),
    -- A new file means new text: back to the queue, and the text, score
    -- and receipt of the OLD file go with it -- ch_get_material must not
    -- serve yesterday's text under today's URL. Everything else keeps its
    -- stage, attempts and full_text.
    stage            = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN 'discovered' ELSE ch_material.stage END,
    attempts         = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN 0 ELSE ch_material.attempts END,
    full_text        = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN NULL ELSE ch_material.full_text END,
    text_quality     = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN NULL ELSE ch_material.text_quality END,
    pdf_bytes        = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN NULL ELSE ch_material.pdf_bytes END,
    fetched_at       = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN NULL ELSE ch_material.fetched_at END,
    last_error       = CASE WHEN ch_material.pdf_url IS DISTINCT FROM EXCLUDED.pdf_url
                            THEN NULL ELSE ch_material.last_error END,
    pdf_url          = EXCLUDED.pdf_url,
    updated_at       = now()
RETURNING (xmax = 0) AS inserted,
          (xmax <> 0 AND (SELECT pdf_url FROM old) IS DISTINCT FROM ch_material.pdf_url) AS requeued
"""


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        return None


def upsert_material(conn, row: dict) -> tuple[bool, bool] | None:
    """Store one binding; None when it is not storable (a language outside
    de/fr/it, or a type outside the map -- both counted by the caller)."""
    lang = fq.language_code(row.get("lang"))
    if lang not in ("de", "fr", "it"):
        return None
    material_type = fq.MATERIAL_TYPES.get(row.get("typeDocument") or "")
    if not material_type:
        return None
    params = {
        "eli": row["act"],
        "lang": lang,
        "material_type": material_type,
        "type_uri": row["typeDocument"],
        "title": (row.get("title") or "").strip() or None,
        "historical_id": (row.get("historicalId") or "").strip() or None,
        # The footnote key: the expression's own citation where Fedlex gives one
        # (pre-2021, paginated), the ELI document number for the era that is
        # cited by number -- see chpipe/bbl.py.
        "bbl_key": bbl.bbl_key(row.get("historicalId")) or bbl.eli_key(row["act"]),
        "memorial_year": _int(row.get("memorialYear")),
        "memorial_page": (row.get("memorialPage") or "").strip() or None,
        "date_document": (row.get("dateDocument") or "")[:10] or None,
        "publication_date": (row.get("publicationDate") or "")[:10] or None,
        "pdf_url": row["fileUrl"],
    }
    result = conn.execute(_UPSERT, params).fetchone()
    if isinstance(result, dict):
        return bool(result["inserted"]), bool(result["requeued"])
    return bool(result[0]), bool(result[1])


def run(settings: Settings, page_size: int = DEFAULT_PAGE_SIZE,
        transport=None) -> MaterialsDiscoverReport:
    """Keyset-walk MATERIALS end to end. Restartable and idempotent, like
    as_bbl_stage.run(): an interrupted walk is simply rerun."""
    report = MaterialsDiscoverReport()
    client = SparqlClient(fq.ENDPOINT, transport=transport)
    conn = db.connect(settings)
    try:
        for row in client.keyset(fq.MATERIALS, key="act", page_size=page_size):
            report.rows += 1
            if not row.get("fileUrl") or not row.get("act"):
                continue
            outcome = upsert_material(conn, row)
            if outcome is None:
                if fq.language_code(row.get("lang")) not in ("de", "fr", "it"):
                    report.skipped_lang += 1
                else:
                    report.skipped_type += 1
                continue
            inserted, requeued = outcome
            report.upserted += 1
            report.inserted += int(inserted)
            report.requeued += int(requeued)
            kind = fq.MATERIAL_TYPES[row["typeDocument"]]
            report.by_type[kind] = report.by_type.get(kind, 0) + 1
            if report.upserted % 2000 == 0:
                log.info("materials-discover rows=%d upserted=%d inserted=%d",
                         report.rows, report.upserted, report.inserted)
    finally:
        conn.close()
        client.close()
    return report


def main() -> MaterialsDiscoverReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a network walk, like as_bbl_stage."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("materials-discover rows=%d upserted=%d inserted=%d requeued=%d "
             "skipped_lang=%d skipped_type=%d by_type=%s",
             result.rows, result.upserted, result.inserted, result.requeued,
             result.skipped_lang, result.skipped_type, result.by_type)
    return result


if __name__ == "__main__":
    main()
