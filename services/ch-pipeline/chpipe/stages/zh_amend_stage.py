"""ZH amendment documents: one ch_act_change_document per Nachtrag edition.

Zürich publishes no amending acts as documents of their own -- ZH-Lex
delivers a Nachtrag: the consolidated edition that replaced its
predecessor. The amendment record for ZH is therefore the successor
edition itself, and this stage materialises exactly that: for every act,
one ch_act_change_document per edition AFTER the act's first (the first is
the original enactment, not an amendment), keyed on
(jurisdiction 'ZH', source_id = a numeric encoding of the Nachtrag number,
act_id).

Everything it needs was already stored by zh_acts_stage: the per-edition
entries in ch_act.metadata_json.editions (page URL, text link and kind,
title, Erlassdatum, Publikationsdatum, Aufhebungsdatum) and the
ch_act_version rows (the derived start date, the version_id). No network.

What the source does NOT give (verified live on zh.ch, 2026-08-31, six
edition pages spanning 1869-2024 -- the description list is the same nine
fields on every era):

  * No OS reference (Offizielle Sammlung volume/page). The only OS
    citations in the collection sit inside the Domino text footnotes as
    the act's own publication reference, not per-Nachtrag. os_ref is
    stored as an explicit null so its absence reads as a fact about the
    source, never as a parse gap.
  * No decision date for a Nachtrag. The edition page's Erlassdatum is the
    SERIES' enactment date, repeated verbatim on every edition (101/129 of
    2024 says 27.02.2005). date_decision is therefore null -- except where
    the edition's Erlassdatum differs from its predecessor's, which is a
    re-enactment (101/051: the 2005 constitution replacing the 1869 one),
    and there the new Erlassdatum IS the decision date of the amending
    (total-revision) act.
  * No per-article modification table. Article-level linkage is the diff
    stage's job (ch_act_change, computed between consecutive parsed
    editions); the linkage here is edition-level ONLY:
    metadata_json.version_id / .consolidation name the ch_act_version the
    document introduced, so ch_act_change.to_version_id joins to its
    Nachtrag through them. No ch_article_provenance rows are written --
    ZH gives nothing to parse them from, and fabricating them from the
    diff would duplicate ch_act_change under a table whose contract is
    "parsed from the source's own notes".

date_publication is the Publikationsdatum (the day the edition took
effect; LexFind's version_active_since) and falls back to the version
row's derived date_applicability for the loose-leaf editions that have
none -- metadata_json.date_source says which of the two it was.

Idempotent replace per act: upsert on the key, then delete the act's ZH
documents this pass no longer produces (RETURNING, counted as `orphaned`
-- ch_article_provenance.change_document_id is ON DELETE SET NULL, so a
stale link degrades, never dangles).
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from .. import db, throttle, zhlex
from ..config import Settings
from .zh_acts_stage import consolidation_uri

log = logging.getLogger(__name__)

JURISDICTION = "ZH"
_SAMPLE_CAP = 12


@dataclass
class AmendReport:
    acts: int = 0
    documents: int = 0
    # Editions skipped as the act's original enactment, one per act walked.
    first_editions: int = 0
    # Successor editions whose Erlassdatum differs from their predecessor's:
    # a re-enactment, the one case where date_decision is known.
    reenactments: int = 0
    # Documents a previous run wrote for an edition this pass no longer
    # produces -- deleted, same argument as diff_stage's _CLEAR_CHANGES.
    orphaned: int = 0
    # ZH acts without metadata_json.editions at all: nothing to build from,
    # zh-acts has to have run first.
    no_editions: int = 0
    no_editions_samples: list[str] = field(default_factory=list)
    # Editions in the metadata without a ch_act_version row (a pages_failed
    # gap in zh-acts): the document is still written -- the edition is real
    # -- with a null version link.
    version_missing: int = 0
    version_missing_samples: list[str] = field(default_factory=list)
    # Successor editions with neither a Publikationsdatum nor a version row
    # to take the derived start from: date_publication stays null.
    date_missing: int = 0
    # metadata_json.editions keys that are not Nachtrag numbers: skipped,
    # sampled, never guessed at.
    bad_version_no: int = 0
    bad_version_no_samples: list[str] = field(default_factory=list)
    errors: int = 0


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


def source_id(version_no: str) -> int:
    """'129' -> 12900, '008b' -> 802: numeric, stable, monotone in Nachtrag
    order (zhlex.version_key), with room for the letter corrections
    (631.41's 008b) between two numbered deliveries."""
    number, letter = zhlex.version_key(version_no)
    return number * 100 + (ord(letter) - ord("a") + 1 if letter else 0)


_ACTS = ("SELECT act_id, sr_number, metadata_json FROM ch_act "
         "WHERE jurisdiction = %s ORDER BY sr_number")

_VERSIONS = ("SELECT version_id, eli_consolidation_uri, date_applicability "
             "FROM ch_act_version WHERE act_id = %s AND source = 'zhlex' AND lang = 'de'")

_UPSERT = """
INSERT INTO ch_act_change_document
    (act_id, jurisdiction, source_id, number, title, date_publication,
     date_decision, pdf_url, metadata_json, updated_at)
VALUES (%(act_id)s, %(jurisdiction)s, %(source_id)s, %(number)s, %(title)s,
        %(date_publication)s, %(date_decision)s, %(pdf_url)s, %(metadata)s, now())
ON CONFLICT (jurisdiction, source_id, act_id) DO UPDATE SET
    number           = EXCLUDED.number,
    title            = EXCLUDED.title,
    date_publication = EXCLUDED.date_publication,
    date_decision    = EXCLUDED.date_decision,
    pdf_url          = EXCLUDED.pdf_url,
    metadata_json    = EXCLUDED.metadata_json,
    updated_at       = now()
"""

# Keyed per act, not on the whole jurisdiction: an `only` run must never
# treat the acts it did not walk as orphans.
_CLEAR = ("DELETE FROM ch_act_change_document "
          "WHERE jurisdiction = %s AND act_id = %s AND NOT (source_id = ANY(%s)) "
          "RETURNING number")


def _one_act(conn, act_id: int, sr_number: str, metadata: dict | None,
             report: AmendReport) -> None:
    editions: dict = (metadata or {}).get("editions") or {}
    if not editions:
        report.no_editions += 1
        _sample(report.no_editions_samples, sr_number)
        return
    ordered = []
    for version_no in editions:
        try:
            key = zhlex.version_key(version_no)
        except zhlex.ZhlexParseError:
            report.bad_version_no += 1
            _sample(report.bad_version_no_samples, f"{sr_number}/{version_no}")
            continue
        ordered.append((key, version_no))
    ordered.sort()
    if not ordered:
        return

    versions: dict[str, dict] = {}
    for row in conn.execute(_VERSIONS, (act_id,)).fetchall():
        versions[row["eli_consolidation_uri"].rsplit("/", 1)[-1]] = row

    kept: list[int] = []
    with conn.transaction():
        previous_no = None
        for index, (_, no) in enumerate(ordered):
            if index == 0:
                report.first_editions += 1
                previous_no = no
                continue
            edition = editions[no] or {}
            version = versions.get(no)
            if version is None:
                report.version_missing += 1
                _sample(report.version_missing_samples, f"{sr_number}/{no}")
            publication = edition.get("publication")
            if publication:
                date_publication, date_source = publication, "publication"
            elif version is not None and version["date_applicability"] is not None:
                date_publication, date_source = version["date_applicability"], "derived"
            else:
                date_publication, date_source = None, None
                report.date_missing += 1
            enactment = edition.get("enactment")
            previous_enactment = (editions.get(previous_no) or {}).get("enactment")
            reenactment = bool(enactment and previous_enactment
                               and enactment != previous_enactment)
            if reenactment:
                report.reenactments += 1
            kind = edition.get("kind")
            sid = source_id(no)
            kept.append(sid)
            conn.execute(_UPSERT, {
                "act_id": act_id,
                "jurisdiction": JURISDICTION,
                "source_id": sid,
                "number": no,
                "title": edition.get("title"),
                "date_publication": date_publication,
                "date_decision": enactment if reenactment else None,
                "pdf_url": edition.get("text") if kind == "pdf" else None,
                "metadata": json.dumps({
                    "nachtrag": no,
                    # Verified live 2026-08-31: no era of zh.ch edition
                    # pages prints an OS reference. Explicit null, so the
                    # absence is the source's, not a parse gap.
                    "os_ref": None,
                    "page_url": edition.get("page"),
                    "kind": kind,
                    "text_url": edition.get("text"),
                    "version_id": version["version_id"] if version else None,
                    "consolidation": consolidation_uri(sr_number, no),
                    "reenactment": reenactment,
                    "date_source": date_source,
                }, ensure_ascii=False),
            })
            report.documents += 1
            previous_no = no
        stale = conn.execute(_CLEAR, (JURISDICTION, act_id, kept or [-1])).fetchall()
    report.orphaned += len(stale)
    report.acts += 1
    if report.acts % 200 == 0:
        log.info("acts=%d documents=%d orphaned=%d", report.acts,
                 report.documents, report.orphaned)


def run(settings: Settings, only: set[str] | None = None) -> AmendReport:
    """Build ZH's change documents from what zh-acts already stored; `only`
    narrows to a set of Ordnungsnummern (a pilot, a rerun)."""
    report = AmendReport()
    conn = db.connect(settings)
    try:
        acts = conn.execute(_ACTS, (JURISDICTION,)).fetchall()
        for row in acts:
            if only is not None and row["sr_number"] not in only:
                continue
            # One act with a malformed metadata blob must not kill the walk
            # over the other ~1,600 -- same guard as diff_stage's per-act body.
            try:
                _one_act(conn, row["act_id"], row["sr_number"],
                         row["metadata_json"], report)
            except Exception as exc:                        # noqa: BLE001
                log.error("ZH %s: %s", row["sr_number"], exc)
                report.errors += 1
    finally:
        conn.close()
    return report


def main() -> AmendReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. Pure DB pass over ~1,600 acts / ~6,700
    editions: cheap, but reniced like the other corpus walks.
    CHPIPE_ZH_ONLY narrows to a comma-separated list of numbers, the same
    contract as zh-acts."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    only_env = os.environ.get("CHPIPE_ZH_ONLY")
    only = {s.strip() for s in only_env.split(",") if s.strip()} if only_env else None
    result = run(Settings.from_env(), only=only)
    log.info("acts=%d documents=%d first_editions=%d reenactments=%d orphaned=%d "
             "no_editions=%d version_missing=%d date_missing=%d bad_version_no=%d errors=%d",
             result.acts, result.documents, result.first_editions, result.reenactments,
             result.orphaned, result.no_editions, result.version_missing,
             result.date_missing, result.bad_version_no, result.errors)
    if result.no_editions:
        log.warning("NO EDITIONS: %d ZH act(s) without metadata_json.editions -- run "
                    "zh-acts first. Sample: %s", result.no_editions,
                    " || ".join(result.no_editions_samples))
    if result.version_missing:
        log.warning("VERSION MISSING: %d edition(s) documented without a ch_act_version "
                    "row to link (a zh-acts pages_failed gap). Sample: %s",
                    result.version_missing, " || ".join(result.version_missing_samples))
    if result.bad_version_no:
        log.warning("BAD VERSION NO: %d metadata edition key(s) that are not Nachtrag "
                    "numbers, skipped. Sample: %s", result.bad_version_no,
                    " || ".join(result.bad_version_no_samples))
    return result


if __name__ == "__main__":
    main()
