"""LexFind's registry of every cantonal act and its versions, all 26
cantons, into ch_cantonal_registry.

Two jobs: (1) the independent side of Gate F -- LexFind and the Lexwork
hosts are separate systems, so "acts on both sides" and "versions whose
dates agree" are real checks, unlike a gate whose two sides share one
limitation (the lesson of Gate E's first version); (2) the driving set
that reaches ABROGATED acts, which a Lexwork host's lightweight_index
omits (BE: 712 listed against 1,129 in LexFind) -- cantonal_acts_stage
reads this table for the canton's numbers. For the seven cantons without
a Lexwork host it is, for now, all we hold.

Walk per canton: the systematics tree once without tols to learn its node
ids, then the same endpoint in chunks of 50 node ids to get the acts under
each node (inner nodes carry acts too, not only leaves), then
with-version-groups per act. ~33K acts across 26 cantons
at ~2-3 requests/s is a few hours; restartable and idempotent (every write
is an upsert on lexfind_tol_id), so an interrupted run is simply rerun.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field

from .. import cantons, db, lexfind_api, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)


@dataclass
class RegistryReport:
    cantons: list[str] = field(default_factory=list)
    acts: int = 0
    versions: int = 0
    errors: int = 0
    by_canton: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO ch_cantonal_registry
    (lexfind_tol_id, canton, systematic_number, title, is_active, category,
     original_url, versions_json, version_count, fetched_at)
VALUES (%(tol_id)s, %(canton)s, %(sysnr)s, %(title)s, %(is_active)s, %(category)s,
        %(original_url)s, %(versions)s, %(count)s, now())
ON CONFLICT (lexfind_tol_id) DO UPDATE SET
    canton            = EXCLUDED.canton,
    systematic_number = EXCLUDED.systematic_number,
    title             = EXCLUDED.title,
    is_active         = EXCLUDED.is_active,
    category          = EXCLUDED.category,
    original_url      = EXCLUDED.original_url,
    versions_json     = EXCLUDED.versions_json,
    version_count     = EXCLUDED.version_count,
    fetched_at        = now()
"""


def upsert(conn, canton: cantons.Canton, tol: dict, groups: dict) -> int:
    versions = lexfind_api.flatten_versions(groups)
    original = None
    for entry in groups.get("dta_urls") or []:
        if entry.get("original_url"):
            original = entry["original_url"]
            break
    conn.execute(_UPSERT, {
        "tol_id": tol["id"],
        "canton": canton.code,
        "sysnr": tol.get("systematic_number") or groups.get("systematic_number"),
        "title": tol.get("title"),
        "is_active": tol.get("is_active"),
        "category": tol.get("category"),
        "original_url": original,
        "versions": json.dumps(versions, ensure_ascii=False),
        "count": len(versions),
    })
    return len(versions)


def codes(selection: str | None) -> list[str]:
    if not selection:
        return sorted(cantons.ALL)
    out = [s.strip().upper() for s in selection.split(",") if s.strip()]
    unknown = [c for c in out if c not in cantons.ALL]
    if unknown:
        raise ValueError(f"not a canton: {', '.join(unknown)}")
    return out


async def _walk_canton(client: lexfind_api.LexfindClient, conn, canton: cantons.Canton,
                       report: RegistryReport, sem: asyncio.Semaphore) -> None:
    try:
        tree = await client.systematics(canton.lexfind_id)
        ids = lexfind_api.node_ids(tree)
        tols: list[dict] = []
        for start in range(0, len(ids), lexfind_api.LEAVES_PER_REQUEST):
            chunk = ids[start:start + lexfind_api.LEAVES_PER_REQUEST]
            tols.extend(lexfind_api.tols_of(await client.systematics(canton.lexfind_id, chunk)))
    except FetchError as exc:
        log.error("%s: LexFind systematics failed: %s", canton.code, exc)
        report.errors += 1
        return
    log.info("%s: %d nodes, %d acts in LexFind", canton.code, len(ids), len(tols))

    async def one(tol: dict) -> None:
        async with sem:
            try:
                groups = await client.with_version_groups(tol["id"])
                report.versions += upsert(conn, canton, tol, groups)
            except Exception as exc:                          # noqa: BLE001
                log.error("%s tol %s: %s", canton.code, tol.get("id"), exc)
                report.errors += 1
                return
        report.acts += 1
        report.by_canton[canton.code] = report.by_canton.get(canton.code, 0) + 1
        if report.acts % 500 == 0:
            log.info("registry acts=%d versions=%d errors=%d", report.acts,
                     report.versions, report.errors)

    for start in range(0, len(tols), 20):
        await asyncio.gather(*(one(t) for t in tols[start:start + 20]))


async def _run_async(settings: Settings, selected: list[str], transport) -> RegistryReport:
    report = RegistryReport(cantons=list(selected))
    conn = db.connect(settings)
    try:
        # One host (lexfind.ch) for all 26 cantons: cantonal_per_host is the
        # right cap here too, not http_concurrency.
        async with Fetcher(concurrency=settings.cantonal_per_host, transport=transport) as fetcher:
            client = lexfind_api.LexfindClient(fetcher)
            sem = asyncio.Semaphore(settings.cantonal_per_host)
            for code in selected:
                await _walk_canton(client, conn, cantons.ALL[code], report, sem)
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None, transport=None) -> RegistryReport:
    return asyncio.run(_run_async(settings, codes(canton_code), transport))


def main() -> RegistryReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), canton_code=os.environ.get("CHPIPE_CANTON") or None)
    log.info("cantons=%d acts=%d versions=%d errors=%d by_canton=%s", len(result.cantons),
             result.acts, result.versions, result.errors, result.by_canton)
    return result


if __name__ == "__main__":
    main()
