"""Discovery of cantonal acts, their versions and their amending acts from
the Lexwork hosts -- the cantonal twin of acts_stage + versions_stage in one
pass, because Lexwork's `texts_of_law/{sysnr}` record carries the version
list with the act.

Driving set per canton: the host's lightweight_index (in-force acts only),
the numbers named by its change_documents index, and every systematic
number LexFind registered for the canton (ch_cantonal_registry, filled by
lexfind_registry_stage) -- the last is what reaches the abrogated acts the
index leaves out. A registry number the host answers 404 to is counted as
not_on_host, not failed.

Per act: one ch_act row keyed on the act's canonical front-end URL, one
ch_act_change_document row per amending act, and one ch_act_version row per
(version, language of the canton) at stage 'discovered', source 'lexwork',
whose xml_url is the version's show_as_json endpoint. The languages are
cantons.py's expectation; a language the payload turns out not to have is
failed visibly in cantonal_parse_stage rather than guessed here.

Version dates are parsed from the UI strings; a string the parser does not
recognise is counted (dates_unparsed) and the version skipped -- a wrong
date on a point-in-time corpus is worse than a missing edition.

Restartable and idempotent, not resumable: every write is an upsert and a
rerun redoes the pass (same reasoning as versions_stage).

Hosts run concurrently with one another; within a host the per-host
semaphore in LexworkClient bounds the parallelism.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import cantons, db, lexwork, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..lexwork_api import LexworkClient

log = logging.getLogger(__name__)

_SAMPLE_CAP = 12
_DATE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")


@dataclass
class ActsReport:
    cantons: list[str] = field(default_factory=list)
    acts: int = 0
    versions: int = 0
    change_documents: int = 0
    # A registry number the host does not serve (404). Expected for the few
    # acts LexFind holds under an older numbering; a large count for one
    # canton means the numbering schemes disagree.
    not_on_host: int = 0
    # A version whose UI date string lexwork.parse_version_dates refused.
    # Zero is the only acceptable steady state; a non-zero count names a
    # string shape the parser has to learn, never a version to drop.
    dates_unparsed: int = 0
    dates_unparsed_samples: list[str] = field(default_factory=list)
    hosts_failed: list[str] = field(default_factory=list)
    errors: int = 0
    by_canton: dict[str, int] = field(default_factory=dict)


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, abbreviation,
                    title_de, title_fr, title_it, title_rm,
                    date_document, date_entry_force, date_no_longer_in_force,
                    enforcement_status, metadata_json, stage, updated_at)
VALUES (%(work)s, %(jurisdiction)s, %(sr)s, %(abbreviation)s,
        %(title_de)s, %(title_fr)s, %(title_it)s, %(title_rm)s,
        %(date_document)s, %(date_entry_force)s, %(date_no_longer)s,
        %(status)s, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    jurisdiction            = EXCLUDED.jurisdiction,
    sr_number               = EXCLUDED.sr_number,
    abbreviation            = COALESCE(EXCLUDED.abbreviation, ch_act.abbreviation),
    title_de                = COALESCE(EXCLUDED.title_de, ch_act.title_de),
    title_fr                = COALESCE(EXCLUDED.title_fr, ch_act.title_fr),
    title_it                = COALESCE(EXCLUDED.title_it, ch_act.title_it),
    title_rm                = COALESCE(EXCLUDED.title_rm, ch_act.title_rm),
    date_document           = COALESCE(EXCLUDED.date_document, ch_act.date_document),
    date_entry_force        = COALESCE(EXCLUDED.date_entry_force, ch_act.date_entry_force),
    date_no_longer_in_force = EXCLUDED.date_no_longer_in_force,
    enforcement_status      = EXCLUDED.enforcement_status,
    metadata_json           = EXCLUDED.metadata_json,
    updated_at              = now()
RETURNING act_id
"""

# date_end_applicability is EXCLUDED, not COALESCE'd, unlike versions_stage:
# on Lexwork the current version's end is genuinely absent and a former
# current version GAINS an end when it is superseded, so the newest
# observation must always win. stage is deliberately not touched on
# conflict: a version already fetched or parsed stays where it is.
_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, source, stage, updated_at)
VALUES (%(act_id)s, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
        %(xml_url)s, 'lexwork', 'discovered', now())
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = EXCLUDED.date_end_applicability,
    xml_url                = EXCLUDED.xml_url,
    updated_at             = now()
RETURNING version_id
"""

_UPSERT_CHANGE_DOCUMENT = """
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

_REGISTRY_NUMBERS = ("SELECT DISTINCT systematic_number FROM ch_cantonal_registry "
                     "WHERE canton = %s AND systematic_number IS NOT NULL")

_TITLE_COLUMN = {"de": "title_de", "fr": "title_fr", "it": "title_it", "rm": "title_rm"}


def _date(text: str | None):
    """First dd.mm.yyyy in a UI string, or None. Used for the strings the
    API does not also give in ISO form (change documents, abrogation)."""
    m = _DATE.search(text or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def _iso(value: str | None) -> str | None:
    return value[:10] if value else None


def upsert_act(conn, canton: cantons.Canton, tol: dict, titles: dict[str, str]) -> int:
    sysnr = tol["systematic_number"]
    metadata = {
        "platform": "lexwork",
        "host": canton.host,
        "lexwork_version_uid": tol.get("version_uid"),
        "current_version_id": (tol.get("current_version") or {}).get("id"),
        "structured_document_id": (tol.get("current_version") or {}).get("structured_document_id"),
        "text_of_law_type_id": tol.get("text_of_law_type_id"),
        "abrogated_scheduled": tol.get("abrogated_scheduled"),
        "abrogated_dates_str": tol.get("abrogated_dates_str"),
    }
    params = {
        "work": cantons.canonical_link(canton, sysnr),
        "jurisdiction": canton.code,
        "sr": sysnr,
        "abbreviation": tol.get("abbreviation") or None,
        "date_document": _iso(tol.get("date_of_decision")),
        "date_entry_force": _iso(tol.get("enactment")),
        "date_no_longer": _date(tol.get("abrogated_dates_str")) if tol.get("abrogated") else None,
        # Fedlex's vocabulary, reused so in_force (GENERATED) means the same
        # thing in both jurisdictions: 0 in force, 3 no longer in force.
        "status": 3 if tol.get("abrogated") else 0,
        "metadata": json.dumps(metadata, ensure_ascii=False),
    }
    for lang, column in _TITLE_COLUMN.items():
        params[column] = titles.get(lang) or None
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UPSERT_ACT, params)
        return cur.fetchone()[0]


def upsert_change_documents(conn, canton: cantons.Canton, act_id: int,
                            docs: list[dict]) -> int:
    written = 0
    for doc in docs:
        if doc.get("id") is None:
            continue
        conn.execute(_UPSERT_CHANGE_DOCUMENT, {
            "act_id": act_id,
            "jurisdiction": canton.code,
            "source_id": doc["id"],
            "number": doc.get("number") or None,
            "title": doc.get("document_title") or None,
            "date_publication": _date(doc.get("date_of_publication_string")
                                      or doc.get("date_string")),
            # "(Änderung vom 27.11.2023)" is the decision date in the title;
            # date_of_decision_string is "????" on every record seen.
            "date_decision": _date(doc.get("document_title")),
            "pdf_url": doc.get("pdf_link") or None,
            "metadata": json.dumps({
                "identifier_1": doc.get("identifier_1"),
                "identifier_2": doc.get("identifier_2"),
                "materials": len(doc.get("materials") or []),
                "external_links": doc.get("external_links") or [],
            }, ensure_ascii=False),
        })
        written += 1
    return written


def _versions_of(tol: dict) -> list[dict]:
    out = []
    current = tol.get("current_version")
    if current:
        out.append(current)
    out.extend(tol.get("old_versions") or [])
    out.extend(tol.get("future_versions") or [])
    return [v for v in out if v.get("id") is not None]


def upsert_versions(conn, canton: cantons.Canton, act_id: int, tol: dict,
                    report: ActsReport) -> int:
    sysnr = tol["systematic_number"]
    written = 0
    for version in _versions_of(tol):
        try:
            dates = lexwork.parse_version_dates(version.get("version_dates_str") or "")
        except lexwork.LexworkParseError:
            report.dates_unparsed += 1
            _sample(report.dates_unparsed_samples,
                    f"{canton.code} {sysnr} v{version['id']}: {version.get('version_dates_str')!r}")
            continue
        for lang in canton.langs:
            conn.execute(_UPSERT_VERSION, {
                "act_id": act_id,
                "consolidation": cantons.deep_link(canton, sysnr, version["id"]),
                "lang": lang,
                "date_app": dates.date_applicability,
                "date_end": dates.date_end_applicability,
                "xml_url": cantons.show_as_json_url(canton, sysnr, version["id"]),
            })
            written += 1
    return written


def registry_numbers(conn, canton_code: str) -> set[str]:
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_REGISTRY_NUMBERS, (canton_code,))
        return {r[0] for r in cur.fetchall()}


async def _walk_canton(client: LexworkClient, conn, canton: cantons.Canton,
                       only: set[str] | None, report: ActsReport) -> None:
    try:
        status = await client.status(canton)
    except FetchError as exc:
        log.error("%s: host %s did not answer /status: %s", canton.code, canton.host, exc)
        report.hosts_failed.append(canton.code)
        return
    log.info("%s: %s in force, %s out of force on %s", canton.code,
             status.get("nof_tol_in_force"), status.get("nof_tol_out_of_force"), canton.host)

    numbers: set[str] = set()
    for tol in await client.lightweight_index(canton):
        if tol.get("systematic_number"):
            numbers.add(tol["systematic_number"])
    numbers |= registry_numbers(conn, canton.code)
    if only is not None:
        numbers &= set(only)
    ordered = sorted(numbers)
    log.info("%s: walking %d acts", canton.code, len(ordered))

    async def one(sysnr: str) -> None:
        try:
            tol = await client.text_of_law(canton, sysnr)
            if tol is None:
                report.not_on_host += 1
                return
            titles = {"de": tol.get("title")}
            for lang in canton.langs:
                if lang == "de":
                    continue
                try:
                    other = await client.text_of_law(canton, sysnr, lang=lang)
                except FetchError as exc:
                    log.warning("%s %s: no %s title: %s", canton.code, sysnr, lang, exc)
                    other = None
                if other and other.get("title"):
                    titles[lang] = other["title"]
            act_id = upsert_act(conn, canton, tol, titles)
            report.change_documents += upsert_change_documents(
                conn, canton, act_id, tol.get("change_documents") or [])
            report.versions += upsert_versions(conn, canton, act_id, tol, report)
        except Exception as exc:                          # noqa: BLE001
            log.error("%s %s: %s", canton.code, sysnr, exc)
            report.errors += 1
            return
        report.acts += 1
        report.by_canton[canton.code] = report.by_canton.get(canton.code, 0) + 1
        if report.acts % 100 == 0:
            log.info("acts=%d versions=%d change_documents=%d not_on_host=%d "
                     "dates_unparsed=%d errors=%d", report.acts, report.versions,
                     report.change_documents, report.not_on_host,
                     report.dates_unparsed, report.errors)

    # Bounded fan-out per host: the client's per-host semaphore limits the
    # requests in flight, this limits the coroutines waiting on it.
    for start in range(0, len(ordered), 20):
        await asyncio.gather(*(one(s) for s in ordered[start:start + 20]))


async def _run_async(settings: Settings, codes: list[str], only: set[str] | None,
                     transport) -> ActsReport:
    report = ActsReport(cantons=list(codes))
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            client = LexworkClient(fetcher, per_host=settings.cantonal_per_host)
            await asyncio.gather(*(
                _walk_canton(client, conn, cantons.LEXWORK[code], only, report)
                for code in codes))
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None,
        only: set[str] | None = None, transport=None) -> ActsReport:
    """Walk every act of the named canton(s) (comma-separated codes; None
    means all 19 Lexwork cantons), or only the systematic numbers in
    `only` -- the nightly delta's narrowing."""
    codes = cantons.lexwork_codes(canton_code)
    return asyncio.run(_run_async(settings, codes, only, transport))


def main() -> ActsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a network walk that holds a
    connection for the whole pass, same as acts/versions."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), canton_code=os.environ.get("CHPIPE_CANTON") or None)
    log.info("cantons=%s acts=%d versions=%d change_documents=%d not_on_host=%d "
             "dates_unparsed=%d hosts_failed=%s errors=%d by_canton=%s",
             ",".join(result.cantons), result.acts, result.versions,
             result.change_documents, result.not_on_host, result.dates_unparsed,
             ",".join(result.hosts_failed) or "-", result.errors, result.by_canton)
    if result.dates_unparsed:
        log.warning("DATES UNPARSED: %d version(s) skipped because their date "
                    "string was not recognised. Sample: %s", result.dates_unparsed,
                    " || ".join(result.dates_unparsed_samples))
    if result.hosts_failed:
        log.warning("HOSTS FAILED: %s did not answer; rerun for them", ", ".join(result.hosts_failed))
    return result


if __name__ == "__main__":
    main()
