"""Discovery of Official Compilation (AS) and Federal Gazette (BBl) acts into
ch_as_act.

jolux:Act -- see fedlex_queries.AS_ACTS's own comment for why this module
does not repeat a single-number claim about the corpus size: the numbers on
record disagree with each other by counting method, and this task's live
measurement was a bounded slice, not a full walk (see the report for what
that slice actually showed). Whatever the true total, this is the largest
stage in the corpus and it runs last, so nothing more useful queues behind
it while it works through the walk.

Titles are not fetched here: that would be a second query of comparable
size, and the titles are only worth having for the AS/BBl acts that turn
out to be referenced by something else in the corpus. Fetch them later, for
the subset ch_act_amendment_link and ch_article_provenance actually point
at -- migration 198's comment on ch_as_act records the same reasoning for
why this table carries no title_*/xml_url/pdf_url columns yet.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from .. import db, throttle
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import DEFAULT_PAGE_SIZE, SparqlClient

log = logging.getLogger(__name__)


@dataclass
class AsReport:
    discovered: int = 0
    # An ELI that is neither /eli/oc/ nor /eli/fga/ -- i.e. fq.collection_of()
    # returned None. AS_ACTS selects `?act a jolux:Act` with no collection
    # filter, so this is expected to be non-zero if the graph ever asserts
    # jolux:Act on something outside those two collections; it is counted
    # rather than silently dropped so that assumption stays checkable.
    skipped: int = 0
    by_collection: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO ch_as_act (eli_uri, collection, date_document, publication_date,
                       date_entry_force, document_type, metadata_json, updated_at)
VALUES (%(eli)s, %(collection)s, %(date_document)s, %(publication_date)s,
        %(date_entry_force)s, %(document_type)s, %(metadata)s, now())
ON CONFLICT (eli_uri) DO UPDATE SET
    date_document    = COALESCE(EXCLUDED.date_document, ch_as_act.date_document),
    publication_date = COALESCE(EXCLUDED.publication_date, ch_as_act.publication_date),
    date_entry_force = COALESCE(EXCLUDED.date_entry_force, ch_as_act.date_entry_force),
    document_type    = COALESCE(EXCLUDED.document_type, ch_as_act.document_type),
    metadata_json    = EXCLUDED.metadata_json,
    updated_at       = now()
RETURNING as_id
"""


def upsert_as_act(conn, row: dict) -> int | None:
    """Store one jolux:Act row, or return None -- not a coerced guess -- when
    its ELI belongs to neither the Official Compilation nor the Federal
    Gazette. collection is CHECK-constrained to ('AS', 'BBl') by migration
    198; returning None here is what keeps a /eli/cc/ row (or anything else
    unrecognised) from ever reaching that constraint and failing loudly
    mid-walk instead of being skipped up front."""
    eli = row.get("act")
    collection = fq.collection_of(eli)
    if not collection:
        return None
    params = {
        "eli": eli,
        "collection": collection,
        "date_document": (row.get("dateDocument") or "")[:10] or None,
        "publication_date": (row.get("publicationDate") or "")[:10] or None,
        "date_entry_force": (row.get("dateEntryForce") or "")[:10] or None,
        "document_type": row.get("typeDocument"),
        "metadata": json.dumps({k: v for k, v in row.items() if k != "act"},
                               ensure_ascii=False),
    }
    result = conn.execute(_UPSERT, params).fetchone()
    return result["as_id"] if isinstance(result, dict) else result[0]


def run(settings: Settings, page_size: int = DEFAULT_PAGE_SIZE) -> AsReport:
    """Keyset-walk AS_ACTS end to end and upsert every row. Restartable and
    idempotent, not resumable -- same shape as acts_stage.run(): a keyset
    walk always starts from the beginning, so an interrupted run redoes the
    whole walk, and the upserts make that safe, only not free.
    """
    report = AsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.keyset(fq.AS_ACTS, key="act", page_size=page_size):
            as_id = upsert_as_act(conn, row)
            if as_id is None:
                report.skipped += 1
                continue
            collection = fq.collection_of(row.get("act")) or "?"
            report.by_collection[collection] = \
                report.by_collection.get(collection, 0) + 1
            report.discovered += 1
            if report.discovered % 10000 == 0:
                log.info("as-bbl discovered=%d skipped=%d", report.discovered,
                         report.skipped)
    finally:
        conn.close()
        client.close()
    return report


def main() -> AsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py for the bug that shape already caused once.

    nice 10 (throttle.NICE_IO): a network walk over jolux:Act, the same
    shape as acts_stage/versions_stage, not a CPU stage -- so it gets the
    I/O priority those two use, not NICE_CPU. No wait_for_capacity(): like
    acts and versions, this stage is bounded by Fedlex's response times,
    not by this machine's cores, so there is nothing for a load-average
    ceiling to protect against here.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("discovered=%d skipped=%d by_collection=%s", result.discovered,
             result.skipped, result.by_collection)
    return result


if __name__ == "__main__":
    main()
