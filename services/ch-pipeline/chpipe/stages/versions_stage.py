"""Discovery of consolidated editions into ch_act_version.

56,328 consolidations as of 2026-08-23, each realised in three to five
languages -- roughly 170,000 (consolidation, lang) rows. This is the table
the old flat ch_legislation could not express at all: its primary key was
(eli_uri, lang), which allows exactly one edition per act, so production
holds no amendment history whatsoever. The uniqueness this stage writes
against is (eli_consolidation_uri, lang) -- the same consolidation realised
in DEU, FRA and ITA is three rows, not one row overwritten twice.

Two further properties of the source data shape this module:

  * Fedlex returns the same consolidation from more than one named graph, so
    the same row is walked more than once. The second write of a row must
    update the first, not duplicate it -- see the ON CONFLICT clause below.
  * date_end_applicability is genuinely absent for the current edition of an
    act. That absence is meaningful (it is what marks a row as the current
    edition), so it is never defaulted to anything -- COALESCE only ever
    protects a value already on the row from being clobbered by a later,
    less-complete observation of the same consolidation.

The file URL is read from the graph (jolux:isExemplifiedBy on the XML
manifestation), never assembled from a string pattern. Building it by
pattern is the bug that filled 96% of production's ch_legislation with HTML
error pages instead of documents.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)

# A dozen offending URIs is enough for a human to act on; accumulating every
# one of a possible tens of thousands would just trade one silent problem
# (an unread count) for another (unbounded memory on a full 56k-edition walk).
_SAMPLE_CAP = 12


@dataclass
class VersionsReport:
    discovered: int = 0
    # orphaned: a version whose parent work is not in ch_act yet. Zero is the
    # only value that should ever survive a full run against a fully-seeded
    # ch_act -- anything above that means the acts stage and the versions
    # query disagree about what exists. See orphaned_works below.
    orphaned: int = 0
    orphaned_works: list[str] = field(default_factory=list)
    # skipped_language: a language Fedlex serves that fedlex_queries.LANGUAGE_MAP
    # does not cover. Not mapping a language is a decision, not an accident,
    # but it must stay visible rather than silently vanishing as a version
    # that was never even attempted.
    skipped_language: int = 0
    skipped_langs: list[str] = field(default_factory=list)
    by_lang: dict[str, int] = field(default_factory=dict)
    # One bad row (a malformed binding, a write error) must not abort a walk
    # of ~170,000 rows. Counted here instead, same shape as acts_stage.
    errors: int = 0


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, stage, updated_at)
SELECT a.act_id, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
       %(xml_url)s, 'discovered', now()
  FROM ch_act a WHERE a.eli_work_uri = %(work)s
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = COALESCE(EXCLUDED.date_end_applicability,
                                      ch_act_version.date_end_applicability),
    xml_url                = COALESCE(EXCLUDED.xml_url, ch_act_version.xml_url),
    updated_at             = now()
RETURNING version_id
"""


def upsert_version(conn, row: dict) -> int | None:
    """Returns the version_id, or None if the language is unmapped or the
    parent work has not been discovered yet (run the acts stage first)."""
    lang = fq.language_code(row.get("lang"))
    if not lang:
        return None
    params = {
        "work": row["work"],
        "consolidation": row["consolidation"],
        "lang": lang,
        "date_app": row["dateApplicability"][:10],
        "date_end": (row.get("dateEndApplicability") or "")[:10] or None,
        "xml_url": row.get("fileUrl"),
    }
    result = conn.execute(_UPSERT_VERSION, params).fetchone()
    if result is None:
        return None                     # the SELECT matched no act
    return result["version_id"] if isinstance(result, dict) else result[0]


def run(settings: Settings, page_size: int = 5000) -> VersionsReport:
    report = VersionsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.VERSIONS, page_size=page_size):
            # A single malformed row (or a write error on it) must not abort
            # a walk of ~170,000 rows -- log it, count it, move on. Follows
            # the same shape as acts_stage.run()'s per-row guard.
            try:
                lang = fq.language_code(row.get("lang"))
                if not lang:
                    report.skipped_language += 1
                    _sample(report.skipped_langs, row.get("lang") or "<missing>")
                    continue
                version_id = upsert_version(conn, row)
            except Exception as exc:                      # noqa: BLE001
                log.error("versions: %s: %s",
                          row.get("consolidation") or row.get("work"), exc)
                report.errors += 1
                continue

            if version_id is None:
                report.orphaned += 1
                _sample(report.orphaned_works, row.get("work") or "<unknown>")
                continue

            report.discovered += 1
            report.by_lang[lang] = report.by_lang.get(lang, 0) + 1
            if report.discovered % 5000 == 0:
                log.info("versions discovered=%d orphaned=%d skipped_language=%d",
                          report.discovered, report.orphaned, report.skipped_language)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("discovered=%d orphaned=%d skipped_language=%d errors=%d by_lang=%s",
             result.discovered, result.orphaned, result.skipped_language,
             result.errors, result.by_lang)
    # A non-zero orphaned count after a full acts run is a silent-gap signal,
    # not a footnote -- surface it (and who it is) at warning level so it
    # cannot be missed in a scrolled-past log.
    if result.orphaned:
        log.warning("ORPHANED: %d version(s) reference a work ch_act does not "
                    "have -- the acts and versions queries disagree about what "
                    "exists. Sample of %d: %s", result.orphaned,
                    len(result.orphaned_works), ", ".join(result.orphaned_works))
    if result.skipped_language:
        log.warning("SKIPPED LANGUAGE: %d version(s) in a language "
                    "fedlex_queries.LANGUAGE_MAP does not cover. Sample: %s",
                    result.skipped_language, ", ".join(result.skipped_langs))
