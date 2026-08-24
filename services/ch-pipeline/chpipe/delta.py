"""Daily delta for both Swiss corpora, run once a night once the backfill is
finished (spec section 10). Nothing here issues SQL of its own: every write
happens inside a stage that already has its own real-Postgres tests
(index_stage, fetch_stage, extract_stage, load_stage, acts_stage,
versions_stage, fetch_xml_stage, parse_akn_stage). This module only decides
which of those stages to call, and with what arguments.

Decisions: entscheidsuche publishes /docs/Snapshots/{date}.json with a
per-court counter map (`total`) and a grand total (`total_alle`). Comparing
today's map against the one we stored after the previous run tells us which
courts to re-walk -- far cheaper than re-listing all 54 spiders every night,
one of which (CH_BGer) is a 116 MB directory listing that takes over two
minutes to stream.

`total` is not flat. Plan 1's reports.completeness() measured it against the
live 2026-08-20 file and found three independent levels that each separately
sum to total_alle: a per-canton rollup (28 keys, e.g. "ZH"), a per-court-code
level (131 keys, e.g. "ZH_OG"), and a per-chamber level (360 keys, e.g.
"CH_BGer_001") -- and entscheidsuche's court-code spelling matches our spider
directory name for only 7 of our 54 spiders ("ZH_OG" is our
"ZH_Obergericht", "GE_CJ" is our "GE_Gerichte", and so on). Two separate
problems follow from that, and they are handled in two different places:

  * canton and chamber rows are pure noise for a "did a court change"
    question -- re-indexing "ZH" or "CH_BGer_001" is not a thing that can be
    done, they name no spider at any granularity. spiders_that_grew() drops
    them structurally (a bare two-letter code, or a trailing "_<digits>"
    chamber suffix), not by checking spider names -- see its docstring for
    why checking names there would be the same 7-of-54 bug relocated.

  * the remaining court-code keys are real signal, but most of them still
    do not spell one of our 54 spider directory names, and there is no
    verified name-translation table in this codebase to close that gap (see
    chpipe/reports.py's own docstring, which documents the same blind spot
    rather than papering over it). run_decisions() is the one place that
    needs an actual directory name -- it is what gets handed to
    index_stage.run(), which requests https://entscheidsuche.ch/docs/{name}/
    -- so THAT is where the ALL_SPIDERS filter belongs, and only changed
    keys that survive it are re-walked. Keys that changed but match no
    spider name are not silently dropped: they are logged at WARNING with
    their share of total_alle, every run, so a delta that is quietly missing
    most of the corpus never reads as a clean night.

Legislation: acts and versions are idempotent upserts over the whole graph
(fedlex_queries.py), and the whole graph is a few minutes of SPARQL -- far
cheaper than any attempt to filter by modification date, which Fedlex does
not reliably expose per spec section 7. Re-running both in full, then
draining whatever fetch-xml/parse-akn find newly discovered at stage
'discovered', is simpler and more reliable than tracking a watermark.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import pathlib
import re
from dataclasses import dataclass, field

from .config import Settings
from .http import Fetcher, FetchError
from .stages import (acts_stage, extract_stage, fetch_stage, fetch_xml_stage,
                     index_stage, load_stage, parse_akn_stage, versions_stage)

log = logging.getLogger(__name__)

SNAPSHOT_BASE = "https://entscheidsuche.ch/docs/Snapshots"
STATE_FILE = "snapshot-state.json"

# entscheidsuche's own scrapes finish overnight; a snapshot can lag its own
# date by a day or two when a run is late. Falling back this far is cheap --
# it is one more HTTP GET, not one more spider walk -- and it means a single
# slow night on their side does not turn into a missed delta on ours.
_SNAPSHOT_LOOKBACK_DAYS = 4

# The two noise levels documented above. A chamber key is a court code (or a
# spider name) with a numeric suffix segment ("CH_BGer_001", "CH_BGer_012");
# a canton rollup is exactly two letters and nothing else ("ZH"). Neither
# names anything index_stage can walk.
_CHAMBER_SUFFIX = re.compile(r"_\d+$")
_CANTON_ROLLUP = re.compile(r"^[A-Z]{2}$")


@dataclass
class DeltaReport:
    spiders: list[str] = field(default_factory=list)
    new_documents: int = 0
    new_versions: int = 0


def snapshot_url(day: datetime.date) -> str:
    return f"{SNAPSHOT_BASE}/{day.isoformat()}.json"


def spiders_that_grew(previous: dict, current: dict) -> list[str]:
    """Court-code-level keys whose counter moved, in either direction.

    A shrinking counter means the source withdrew documents -- a real
    change, and ignoring it would leave us serving decisions the court has
    taken down. A key present in `current` but not `previous` (a brand new
    court, or the first run with no stored state at all) counts as grown.

    Deliberately NOT filtered against a known-spider list: entscheidsuche's
    court-code spelling does not match our spider directory names for most
    of the corpus (see the module docstring), so filtering here would just
    make this function quietly agree with that mismatch instead of exposing
    it. This function only removes the two structurally-identifiable noise
    levels -- chamber breakdowns and canton rollups -- that mix into the
    same dict and independently sum to the same total; it is the caller's
    job to decide which of the remaining keys it can act on.
    """
    changed = [
        name for name, count in current.items()
        if not _CHAMBER_SUFFIX.search(name)
        and not _CANTON_ROLLUP.match(name)
        and previous.get(name) != count
    ]
    return sorted(changed)


def _today() -> datetime.date:
    """A seam for tests. datetime.date.today() itself is not something a
    test can hold still, and run_decisions' signature is fixed by the
    interface it implements -- no `today` parameter."""
    return datetime.date.today()


def _state_path(settings: Settings) -> pathlib.Path:
    return settings.raw_dir / STATE_FILE


def _load_state(settings: Settings) -> dict:
    path = _state_path(settings)
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_state(settings: Settings, snapshot: dict) -> None:
    path = _state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False))


async def _fetch_snapshot(url: str, fetcher_factory) -> dict:
    factory = fetcher_factory or (lambda: Fetcher(concurrency=1))
    async with factory() as fetcher:
        return await fetcher.json(url)


def _fetch_latest_snapshot(fetcher_factory) -> tuple[dict | None, datetime.date | None]:
    """The most recent published Snapshots file, trying today first and
    walking backwards. Returns (None, None) if nothing was found."""
    today = _today()
    for offset in range(_SNAPSHOT_LOOKBACK_DAYS):
        day = today - datetime.timedelta(days=offset)
        url = snapshot_url(day)
        try:
            snapshot = asyncio.run(_fetch_snapshot(url, fetcher_factory))
        except Exception as exc:                          # noqa: BLE001
            log.info("no snapshot at %s (%s)", url, exc)
            continue
        return snapshot, day
    return None, None


def run_decisions(settings: Settings, fetcher_factory=None) -> DeltaReport:
    snapshot, day = _fetch_latest_snapshot(fetcher_factory)
    if snapshot is None:
        log.warning(
            "no entscheidsuche snapshot published in the last %d days; "
            "skipping the decisions delta", _SNAPSHOT_LOOKBACK_DAYS)
        return DeltaReport()

    current = snapshot.get("total", {})
    total_alle = snapshot.get("total_alle")
    previous = _load_state(settings)
    grown = spiders_that_grew(previous, current)

    known = set(index_stage.ALL_SPIDERS)
    actionable = [name for name in grown if name in known]
    unmapped = [name for name in grown if name not in known]

    if unmapped:
        # Real signal we cannot act on by name -- see the module docstring.
        # Logged every time, at WARNING, specifically so this never reads as
        # a clean run: a delta that silently matches a handful of spiders by
        # name while dropping the rest would be worse than no delta at all.
        unmapped_docs = sum(current.get(name, 0) for name in unmapped)
        share = (unmapped_docs / total_alle * 100) if total_alle else None
        log.warning(
            "delta(%s): %d changed key(s) match no spider directory name and "
            "cannot be re-indexed by this run (~%d documents%s): %s",
            day, len(unmapped), unmapped_docs,
            f", ~{share:.1f}% of total_alle" if share is not None else "",
            ",".join(unmapped))

    if not actionable:
        _save_state(settings, current)
        return DeltaReport()

    log.info("delta(%s): %d spider(s) changed and are actionable: %s",
             day, len(actionable), ",".join(actionable))
    index_report = index_stage.run(settings, actionable)
    for spider in actionable:
        fetch_stage.run(settings, spider=spider)
        extract_stage.run(settings, spider=spider)
        load_stage.run(settings, spider=spider)

    _save_state(settings, current)
    return DeltaReport(spiders=actionable, new_documents=index_report.inserted)


def run_legislation(settings: Settings) -> DeltaReport:
    acts_stage.run(settings)
    versions = versions_stage.run(settings)
    # versions_stage inserts newly-discovered editions at stage 'discovered';
    # these two drain that queue in the same run rather than waiting for a
    # separately-scheduled pass, so a new consolidation is fetched and
    # parsed the same night it is found, not merely recorded as pending.
    fetch_xml_stage.run(settings)
    parse_akn_stage.run(settings)
    return DeltaReport(new_versions=versions.discovered)


def main() -> DeltaReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py's docstring for why this package standardised
    on that shape after index_stage's __main__ shipped unreachable-by-test
    selection logic once already.

    renice() lives here and not in run_decisions/run_legislation for the
    same reason every other stage keeps it out of run(): os.nice() is
    irreversible for a non-root process, so a run() that reniced would
    permanently drag down anything that imports this module (including the
    test suite). What is different here is that run_decisions/run_legislation
    call OTHER stages' run() directly rather than their main() -- so none of
    the individual renice() calls index_stage.main(), fetch_stage.main() etc.
    would normally make happen actually fire. This call is what stands in
    for all of them. NICE_IO and NICE_CPU are both 10 (see throttle.py), and
    every stage this module touches (index/fetch/extract/load on the
    decisions side, acts/versions/fetch-xml on the legislation side, plus
    parse-akn, the one CPU stage in the mix) resolves to one of those two
    values -- so a single renice(NICE_IO) here reproduces exactly what an
    unattended sequence of each stage's own main() would have set, without
    stacking os.nice()'s cumulative increment once per stage. wait_for_capacity
    is NOT called again here: it already lives inside extract_stage.run()
    and parse_akn_stage.run() themselves (the CPU-bound stages, and the only
    ones that check it even from main()), so calling run() directly still
    gets it -- only renice needed reproducing.
    """
    from . import throttle
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    settings = Settings.from_env()
    decisions = run_decisions(settings)
    legislation = run_legislation(settings)
    log.info("delta: spiders=%s new_documents=%d new_versions=%d",
             decisions.spiders, decisions.new_documents, legislation.new_versions)
    return DeltaReport(spiders=decisions.spiders,
                       new_documents=decisions.new_documents,
                       new_versions=legislation.new_versions)


if __name__ == "__main__":
    main()
