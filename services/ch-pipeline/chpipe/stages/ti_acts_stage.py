"""Discovery of Ticino's acts from the Raccolta delle leggi list -- the TI
twin of cantonal_acts_stage, with one page instead of a per-act API and one
open edition per act instead of a version history.

Driving set: elenco-atti (chpipe.ti_rl.parse_list), the portal's own list
of the acts in force; 623 on 2026-08-26, the same number LexFind has active
for TI. The registry (ch_cantonal_registry, canton TI) is joined to each
list entry by the portal id in LexFind's original_url first (622 of 623
matched that way on 2026-08-26) and by systematic number second (the one
act the portal renumbered, 813.660 -> 813.720, keeps its id). An entry the
registry does not know (id 870 on that day) is loaded anyway and counted.

Per act: one ch_act row keyed on the act's UI page (legge/num/{id}, the
same URL LexFind stores), title_it from the list (the flat page's <title>
is junk on some acts), in_force from LexFind's is_active when matched and
in force otherwise -- the list IS the in-force collection; and exactly one
ch_act_version row, lang 'it', source 'ti_rl', stage 'discovered',
eli_consolidation_uri 'ti_rl:num/{id}' (the id is the stable key: the
systematic number can change), xml_url the flat page.

date_applicability: the registry's current version_active_since when the
act matched (dates_from_registry), else the day of the run
(dates_from_run_date) -- LexFind's date is that version's "stato" date,
which is what Gate F compares, and the run date is an honest "as seen on"
for the handful the registry lacks. On a rerun the registry date wins and,
when it moved, the row goes back to 'discovered' so the flat page is
fetched again (a new date means a new consolidated text); a run-date row
keeps its first date so a nightly rerun does not refetch it for nothing.
Idempotent: every write is an upsert, a rerun creates no second row.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import re
from dataclasses import dataclass, field

from psycopg.rows import dict_row, tuple_row

from .. import cantons, db, throttle, ti_rl
from ..config import Settings
from ..http import Fetcher

log = logging.getLogger(__name__)

CANTON = "TI"
_RL_ID = re.compile(r"/num/(\d+)/?$")
_SAMPLE_CAP = 12


@dataclass
class TiActsReport:
    list_count: int = 0
    registry_active: int = 0
    acts: int = 0
    versions: int = 0
    matched_by_id: int = 0
    matched_by_number: int = 0
    unmatched: int = 0
    unmatched_samples: list[str] = field(default_factory=list)
    # matched, but the portal's number differs from LexFind's (renumbered)
    number_changed: int = 0
    number_changed_samples: list[str] = field(default_factory=list)
    dates_from_registry: int = 0
    dates_from_run_date: int = 0
    # active in the registry, not on the list: dropped from the collection
    # since LexFind last looked, or a list outage -- read the number
    registry_active_not_listed: int = 0
    errors: int = 0


_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, title_it, date_document,
                    enforcement_status, metadata_json, stage, updated_at)
VALUES (%(work)s, 'TI', %(sr)s, %(title)s, %(date_document)s, %(status)s, %(metadata)s,
        'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    sr_number          = EXCLUDED.sr_number,
    title_it           = EXCLUDED.title_it,
    date_document      = COALESCE(EXCLUDED.date_document, ch_act.date_document),
    enforcement_status = EXCLUDED.enforcement_status,
    metadata_json      = EXCLUDED.metadata_json,
    updated_at         = now()
RETURNING act_id
"""

# stage is reset to 'discovered' only when a registry date moved: the page
# is the current text and a new "stato" date is a new edition to refetch.
_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability, date_end_applicability,
     xml_url, source, stage, updated_at)
VALUES (%(act_id)s, %(consolidation)s, 'it', %(date_app)s, NULL, %(xml_url)s,
        'ti_rl', 'discovered', now())
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability = CASE WHEN %(from_registry)s THEN EXCLUDED.date_applicability
                              ELSE ch_act_version.date_applicability END,
    xml_url            = EXCLUDED.xml_url,
    stage              = CASE WHEN %(from_registry)s
                                   AND ch_act_version.date_applicability <> EXCLUDED.date_applicability
                              THEN 'discovered' ELSE ch_act_version.stage END,
    attempts           = CASE WHEN %(from_registry)s
                                   AND ch_act_version.date_applicability <> EXCLUDED.date_applicability
                              THEN 0 ELSE ch_act_version.attempts END,
    last_error         = CASE WHEN %(from_registry)s
                                   AND ch_act_version.date_applicability <> EXCLUDED.date_applicability
                              THEN NULL ELSE ch_act_version.last_error END,
    failed_stage       = CASE WHEN %(from_registry)s
                                   AND ch_act_version.date_applicability <> EXCLUDED.date_applicability
                              THEN NULL ELSE ch_act_version.failed_stage END,
    updated_at         = now()
RETURNING version_id
"""

_REGISTRY = ("SELECT lexfind_tol_id, systematic_number, is_active, original_url, versions_json "
             "FROM ch_cantonal_registry WHERE canton = %s")


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


def current_since(versions_json) -> datetime.date | None:
    """The registry's current version's version_active_since (DD.MM.YYYY),
    or the latest one when none is flagged active (an abrogated act)."""
    versions = versions_json if isinstance(versions_json, list) else json.loads(versions_json or "[]")
    dated = []
    for v in versions:
        m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", (v.get("version_active_since") or "").strip())
        if not m:
            continue
        try:
            dated.append((bool(v.get("is_active")), datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))))
        except ValueError:
            continue
    if not dated:
        return None
    active = [d for flag, d in dated if flag]
    return max(active) if active else max(d for _, d in dated)


def load_registry(conn) -> tuple[dict[int, dict], dict[str, dict]]:
    """(by portal id, by systematic number) for TI. by_number keeps the
    active row when LexFind holds one number twice (5 numbers on
    2026-08-26, an abrogated and a current act)."""
    by_id: dict[int, dict] = {}
    by_number: dict[str, dict] = {}
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_REGISTRY, (CANTON,))
        for row in cur.fetchall():
            m = _RL_ID.search(row.get("original_url") or "")
            if m:
                by_id[int(m.group(1))] = row
            number = row.get("systematic_number")
            if number and (number not in by_number or row["is_active"]):
                by_number[number] = row
    return by_id, by_number


def upsert_entry(conn, entry: dict, registry: dict | None, matched_by: str | None,
                 run_date: datetime.date, report: TiActsReport) -> None:
    date_app = current_since(registry["versions_json"]) if registry else None
    from_registry = date_app is not None
    if from_registry:
        report.dates_from_registry += 1
    else:
        date_app = run_date
        report.dates_from_run_date += 1
    metadata = {
        "platform": "ti_rl",
        "host": ti_rl.HOST,
        "url": entry["url"],
        "flat_url": entry["flat_url"],
        "rl_id": entry["rl_id"],
        "lexfind_tol_id": registry["lexfind_tol_id"] if registry else None,
        "lexfind_systematic_number": registry["systematic_number"] if registry else None,
        "matched_by": matched_by,
        "date_text": entry["date_text"],
    }
    # Fedlex's vocabulary: 0 in force, 3 no longer in force. The list is the
    # in-force collection, so an unmatched act is in force.
    status = 0 if registry is None or registry["is_active"] else 3
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UPSERT_ACT, {
            "work": entry["url"], "sr": entry["sr_number"] or None, "title": entry["title"] or None,
            "date_document": entry["date_document"], "status": status,
            "metadata": json.dumps(metadata, ensure_ascii=False)})
        act_id = cur.fetchone()[0]
        cur.execute(_UPSERT_VERSION, {
            "act_id": act_id, "consolidation": f"ti_rl:num/{entry['rl_id']}",
            "date_app": date_app, "xml_url": entry["flat_url"], "from_registry": from_registry})
    report.acts += 1
    report.versions += 1


async def _run_async(settings: Settings, transport, run_date: datetime.date) -> TiActsReport:
    report = TiActsReport()
    async with Fetcher(concurrency=1, transport=transport) as fetcher:
        page = await fetcher.text(ti_rl.LIST_URL)
    entries = ti_rl.parse_list(page)
    report.list_count = len(entries)
    conn = db.connect(settings)
    try:
        by_id, by_number = load_registry(conn)
        report.registry_active = sum(1 for r in by_id.values() if r["is_active"]) + sum(
            1 for r in by_number.values() if r["is_active"]
            and not _RL_ID.search(r.get("original_url") or ""))
        listed_ids = {e["rl_id"] for e in entries}
        report.registry_active_not_listed = sum(
            1 for rid, r in by_id.items() if r["is_active"] and rid not in listed_ids)
        for entry in entries:
            registry = by_id.get(entry["rl_id"])
            matched_by = "id" if registry else None
            if registry is None and entry["sr_number"] in by_number:
                registry = by_number[entry["sr_number"]]
                matched_by = "number"
            if matched_by == "id":
                report.matched_by_id += 1
                if registry["systematic_number"] != entry["sr_number"]:
                    report.number_changed += 1
                    _sample(report.number_changed_samples,
                            f"num/{entry['rl_id']} portal {entry['sr_number']} lexfind {registry['systematic_number']}")
            elif matched_by == "number":
                report.matched_by_number += 1
            else:
                report.unmatched += 1
                _sample(report.unmatched_samples, f"num/{entry['rl_id']} {entry['sr_number']}")
            try:
                upsert_entry(conn, entry, registry, matched_by, run_date, report)
            except Exception as exc:                          # noqa: BLE001
                log.error("TI num/%s %s: %s", entry["rl_id"], entry["sr_number"], exc)
                report.errors += 1
    finally:
        conn.close()
    return report


def run(settings: Settings, transport=None, run_date: datetime.date | None = None) -> TiActsReport:
    return asyncio.run(_run_async(settings, transport, run_date or datetime.date.today()))


def main() -> TiActsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: one page and a few hundred upserts."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("TI list=%d registry_active=%d acts=%d versions=%d matched_by_id=%d "
             "matched_by_number=%d unmatched=%d number_changed=%d dates_from_registry=%d "
             "dates_from_run_date=%d registry_active_not_listed=%d errors=%d",
             result.list_count, result.registry_active, result.acts, result.versions,
             result.matched_by_id, result.matched_by_number, result.unmatched,
             result.number_changed, result.dates_from_registry, result.dates_from_run_date,
             result.registry_active_not_listed, result.errors)
    if result.unmatched:
        log.warning("UNMATCHED: %d listed act(s) LexFind does not know, dated by the run: %s",
                    result.unmatched, " || ".join(result.unmatched_samples))
    if result.number_changed:
        log.warning("RENUMBERED: %d act(s) whose portal number differs from LexFind's: %s",
                    result.number_changed, " || ".join(result.number_changed_samples))
    return result


if __name__ == "__main__":
    main()
