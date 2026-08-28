"""Discovery of GE and NE acts from the SIL tables of contents -- the SIL
twin of cantonal_acts_stage, one TOC request per canton instead of one
record per act, because content.htm carries number, title and page URL for
every act in force (GE 863, NE 825 on 2026-08-26; exactly LexFind's
is_active counts, so the TOC is the in-force set and nothing else).

Per act: one ch_act row keyed on the act page URL (eli_work_uri), in
force (the TOC lists nothing else), title_fr from the TOC label, and
exactly ONE open ch_act_version (lang 'fr', source 'sil', stage
'discovered', xml_url = the page). SIL publishes the consolidated text
only -- no history, no version list -- so the version's date_applicability
has to come from somewhere else, in this order, and ch_act.metadata_json
.sil_date_source records which:
  'lexfind'  version_active_since of LexFind's current (is_active) version
             for (canton, systematic_number) in ch_cantonal_registry;
  'run'      today, when the registry has no such version. sil_parse_stage
             replaces a 'run' date with the 'Etat au' / 'Dernières
             modifications au' date printed on the page ('page').
ch_act_version has no free column for this, hence the act's metadata.

Re-runs are idempotent: an act that already has an OPEN sil version
(date_end_applicability IS NULL) keeps it -- xml_url is refreshed, the
row is not duplicated and its stage is not touched. Closing the old
version when the page changed (a real re-edition rule, keyed on the
'Etat au' date) is a documented follow-up, not done here.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
from dataclasses import dataclass, field

from psycopg.rows import dict_row, tuple_row

from .. import cantons, db, sil, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

_SAMPLE_CAP = 12


@dataclass
class SilActsReport:
    cantons: list[str] = field(default_factory=list)
    toc_entries: int = 0
    acts: int = 0
    versions_new: int = 0
    versions_kept: int = 0
    date_from_lexfind: int = 0
    date_from_run: int = 0
    # a TOC number LexFind's registry does not hold for the canton: the
    # two lists are meant to be the same set, so each one is worth a look
    not_in_registry: int = 0
    not_in_registry_samples: list[str] = field(default_factory=list)
    # a TOC label the number splitter refused; the act is skipped and
    # counted, never stored under a guessed number
    unnumbered: int = 0
    hosts_failed: list[str] = field(default_factory=list)
    errors: int = 0
    by_canton: dict[str, int] = field(default_factory=dict)


_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, title_fr,
                    enforcement_status, metadata_json, stage, updated_at)
VALUES (%(work)s, %(jurisdiction)s, %(sr)s, %(title_fr)s, 0, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    jurisdiction       = EXCLUDED.jurisdiction,
    sr_number          = EXCLUDED.sr_number,
    title_fr           = EXCLUDED.title_fr,
    enforcement_status = 0,
    metadata_json      = ch_act.metadata_json || EXCLUDED.metadata_json,
    updated_at         = now()
RETURNING act_id
"""

_OPEN_VERSION = """
SELECT version_id FROM ch_act_version
 WHERE act_id = %s AND source = 'sil' AND date_end_applicability IS NULL
 ORDER BY version_id LIMIT 1
"""

_INSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability,
     xml_url, source, stage, updated_at)
VALUES (%s, %s, 'fr', %s, NULL, %s, 'sil', 'discovered', now())
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET xml_url = EXCLUDED.xml_url, updated_at = now()
RETURNING version_id
"""

_REGISTRY = ("SELECT lexfind_tol_id, systematic_number, is_active, versions_json "
             "FROM ch_cantonal_registry WHERE canton = %s AND systematic_number IS NOT NULL")


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


def _ddmmyyyy(text: str | None) -> datetime.date | None:
    try:
        return datetime.datetime.strptime(text or "", "%d.%m.%Y").date()
    except ValueError:
        return None


def registry_dates(conn, canton_code: str) -> dict[str, dict]:
    """systematic_number -> {tol_id, is_active, current_since}: LexFind's
    current (is_active) version's version_active_since, the latest one when
    several are flagged. An active registry row wins over an inactive one
    that shares the number (the number is not unique per canton)."""
    out: dict[str, dict] = {}
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_REGISTRY, (canton_code,))
        for row in cur.fetchall():
            versions = row["versions_json"] if isinstance(row["versions_json"], list) else []
            dates = [d for d in (_ddmmyyyy(v.get("version_active_since"))
                                 for v in versions if v.get("is_active")) if d]
            entry = {"tol_id": row["lexfind_tol_id"], "is_active": bool(row["is_active"]),
                     "current_since": max(dates) if dates else None}
            key = row["systematic_number"]
            if key not in out or (entry["is_active"] and not out[key]["is_active"]):
                out[key] = entry
    return out


def consolidation_uri(canton_code: str, sr_number: str, date: datetime.date) -> str:
    """'sil:GE/A 1 01/2024-03-03': unique per (canton, act, discovery date)
    and stable across re-runs, which is all the column needs to be; it is
    not a URL (the page has no per-version address)."""
    return f"sil:{canton_code}/{sr_number}/{date.isoformat()}"


def upsert_act(conn, canton: cantons.Canton, entry: dict, url: str, reg: dict | None,
               date_source: str) -> int:
    metadata = {
        "platform": "sil",
        "host": canton.host,
        "url": url,
        "lexfind_tol_id": reg["tol_id"] if reg else None,
        "sil_date_source": date_source,
    }
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UPSERT_ACT, {
            "work": url, "jurisdiction": canton.code, "sr": entry["sr_number"],
            "title_fr": entry["title"] or None,
            "metadata": json.dumps(metadata, ensure_ascii=False)})
        return cur.fetchone()[0]


def ensure_version(conn, canton: cantons.Canton, act_id: int, sr_number: str, url: str,
                   date: datetime.date) -> bool:
    """True when a version was inserted, False when an open one was kept."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_OPEN_VERSION, (act_id,))
        existing = cur.fetchone()
        if existing:
            cur.execute("UPDATE ch_act_version SET xml_url = %s, updated_at = now() "
                        "WHERE version_id = %s", (url, existing[0]))
            return False
        cur.execute(_INSERT_VERSION, (act_id, consolidation_uri(canton.code, sr_number, date),
                                      date, url))
        return True


def store_toc(conn, canton: cantons.Canton, entries: list[dict], report: SilActsReport,
              today: datetime.date | None = None) -> None:
    today = today or datetime.date.today()
    registry = registry_dates(conn, canton.code)
    for entry in entries:
        report.toc_entries += 1
        if not entry["sr_number"]:
            report.unnumbered += 1
            log.warning("%s: no systematic number in TOC label %r", canton.code, entry["title"][:80])
            continue
        try:
            url = sil.act_url(canton.host, canton.code, entry["href"])
            reg = registry.get(entry["sr_number"])
            if reg is None:
                report.not_in_registry += 1
                _sample(report.not_in_registry_samples, f"{canton.code} {entry['sr_number']}")
            if reg and reg["current_since"]:
                date, source = reg["current_since"], "lexfind"
                report.date_from_lexfind += 1
            else:
                date, source = today, "run"
                report.date_from_run += 1
            act_id = upsert_act(conn, canton, entry, url, reg, source)
            if ensure_version(conn, canton, act_id, entry["sr_number"], url, date):
                report.versions_new += 1
            else:
                report.versions_kept += 1
        except Exception as exc:                          # noqa: BLE001
            log.error("%s %s: %s", canton.code, entry["sr_number"], exc)
            report.errors += 1
            continue
        report.acts += 1
        report.by_canton[canton.code] = report.by_canton.get(canton.code, 0) + 1


async def _walk_canton(fetcher: Fetcher, conn, canton: cantons.Canton,
                       report: SilActsReport) -> None:
    url = sil.toc_url(canton.host, canton.code)
    try:
        raw = await fetcher.bytes(url)
    except FetchError as exc:
        log.error("%s: TOC %s did not answer: %s", canton.code, url, exc)
        report.hosts_failed.append(canton.code)
        return
    entries = sil.parse_toc(sil.decode(raw))
    log.info("%s: %d acts in %s", canton.code, len(entries), url)
    if not entries:
        log.error("%s: TOC parsed to zero acts (%d bytes); not touching the tables",
                  canton.code, len(raw))
        report.hosts_failed.append(canton.code)
        return
    store_toc(conn, canton, entries, report)


async def _run_async(settings: Settings, codes: list[str], transport) -> SilActsReport:
    report = SilActsReport(cantons=list(codes))
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            for code in codes:
                await _walk_canton(fetcher, conn, cantons.SIL[code], report)
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None, transport=None) -> SilActsReport:
    """Walk the TOC of the named SIL canton(s); None means GE and NE."""
    codes = cantons.sil_codes(canton_code)
    return asyncio.run(_run_async(settings, codes, transport))


def main() -> SilActsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: two requests and ~1.7K upserts."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), canton_code=os.environ.get("CHPIPE_CANTON") or None)
    log.info("cantons=%s toc_entries=%d acts=%d versions_new=%d versions_kept=%d "
             "date_from_lexfind=%d date_from_run=%d not_in_registry=%d unnumbered=%d "
             "hosts_failed=%s errors=%d by_canton=%s",
             ",".join(result.cantons), result.toc_entries, result.acts, result.versions_new,
             result.versions_kept, result.date_from_lexfind, result.date_from_run,
             result.not_in_registry, result.unnumbered,
             ",".join(result.hosts_failed) or "-", result.errors, result.by_canton)
    if result.not_in_registry:
        log.warning("NOT IN REGISTRY: %d TOC act(s) LexFind does not list for the canton "
                    "(dated with today's date). Sample: %s", result.not_in_registry,
                    " || ".join(result.not_in_registry_samples))
    if result.hosts_failed:
        log.warning("HOSTS FAILED: %s; rerun for them", ", ".join(result.hosts_failed))
    return result


if __name__ == "__main__":
    main()
