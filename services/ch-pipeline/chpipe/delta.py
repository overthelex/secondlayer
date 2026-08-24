"""Daily delta for both Swiss corpora, run once a night once the backfill is
finished (spec section 10). Every WRITE happens inside a stage that already
has its own real-Postgres tests (index_stage, fetch_stage, extract_stage,
load_stage, acts_stage, versions_stage, fetch_xml_stage, parse_akn_stage) --
this module only decides which of those stages to call, and with what
arguments. It does issue one read of its own, court_code_spider_map()'s
`SELECT DISTINCT`, covered by its own real-Postgres tests below (round 1 of
this task shipped with no direct SQL at all; see that function's docstring
for why a query earns its way in here).

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
    do not spell one of our 54 spider directory names. There is no
    hand-maintained translation table for that in this codebase, and round 1
    of this task did not build one -- chpipe/reports.py's docstring documents
    the same blind spot rather than papering over it. What closes most of the
    gap instead is already sitting in the data: ch_court_decisions.court_code
    is entscheidsuche's own "Signatur" field (es_document.parse()), in the
    SAME vocabulary Snapshots/{date}.json uses, one level finer (chamber, not
    court-code) than what `total`'s "rest" keys need -- stripping the same
    "_<digits>" suffix recovers that level. court_code_spider_map() builds
    root-court-code -> spider from `SELECT DISTINCT spider, court_code`, so
    the table is only ever as complete as what has actually been indexed,
    and it is rebuilt fresh every run rather than trusted stale. A grown key
    that resolves through neither the exact-name check nor this map is real
    signal we still cannot act on, and it is not silently dropped:
    run_decisions() logs it at WARNING with how much of tonight's growth
    (not the courts' total stock -- see court_code_spider_map's own
    docstring and F9 in the round-1 review) it represents, every run, so a
    delta that is quietly missing part of the corpus never reads as a clean
    night.

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

from . import db
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

    A key present in `previous` but **gone entirely** from `current` --
    a court withdrawn so completely it no longer appears in the map at all,
    not just at a lower count -- is the maximal case of that same withdrawal
    and must be caught the same way. Iterating `current.items()` alone
    (the previous shape of this function) misses it: a name absent from
    `current` never becomes a loop variable, so it can never be compared.
    Iterating the union of both dicts' keys is what makes "gone" and
    "shrunk" the same code path instead of two.

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
        name for name in previous.keys() | current.keys()
        if not _CHAMBER_SUFFIX.search(name)
        and not _CANTON_ROLLUP.match(name)
        and previous.get(name) != current.get(name)
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
    """The most recent published, well-formed Snapshots file, trying today
    first and walking backwards. Returns (None, None) if nothing usable was
    found in the lookback window.

    Two failure shapes are handled differently on purpose:

      * FetchError (a 404, a timeout) means "not published yet" -- the
        expected, nightly-routine case while the lookback covers it. Logged
        at INFO.
      * anything else -- a bad fetcher_factory raising TypeError, a response
        that is not JSON at all -- is a real defect, not a quiet fact about
        publication timing, and reads at WARNING so it cannot be mistaken
        for the routine case (F13: `except Exception` at INFO made a broken
        fetcher indistinguishable from a normal 404 for all four attempts).
      * a response that parses as JSON but has no `total` dict -- a schema
        change, an HTML error page entscheidsuche served with a 200 -- is
        published, but not the shape this function knows how to read. It is
        NOT accepted as this night's snapshot (a malformed `total` silently
        becomes `{}` otherwise, which is byte-identical to "nothing grew"
        and would overwrite the stored baseline with it -- see run_decisions
        for why that must never happen). Logged at WARNING for the same
        reason as the line above: this is not a "not published yet" night.
    """
    today = _today()
    for offset in range(_SNAPSHOT_LOOKBACK_DAYS):
        day = today - datetime.timedelta(days=offset)
        url = snapshot_url(day)
        try:
            snapshot = asyncio.run(_fetch_snapshot(url, fetcher_factory))
        except FetchError as exc:
            log.info("no snapshot at %s (%s)", url, exc)
            continue
        except Exception as exc:                          # noqa: BLE001
            log.warning("snapshot fetch at %s raised %s: %s -- this is NOT "
                       "the routine 'not published yet' case, investigate",
                       url, type(exc).__name__, exc)
            continue
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("total"), dict):
            log.warning(
                "snapshot at %s parsed but has no usable 'total' map "
                "(top-level keys: %s) -- treating it as unusable rather "
                "than as a no-growth night", url,
                sorted(snapshot.keys()) if isinstance(snapshot, dict) else type(snapshot))
            continue
        return snapshot, day
    return None, None


def _growth(previous: dict, current: dict, names) -> int:
    """Net new documents across `names`, this night only -- current minus
    previous, floored at 0 per name so a withdrawal at one court does not
    cancel out growth at another in the same sum."""
    return sum(max(0, current.get(name, 0) - previous.get(name, 0)) for name in names)


def court_code_spider_map(conn) -> dict[str, str]:
    """Court-code-level key (e.g. "ZH_OG") -> our spider directory name
    (e.g. "ZH_Obergericht"), built from documents already loaded rather than
    from a hand-maintained table.

    ch_court_decisions.court_code is written from the document JSON's own
    "Signatur" field (es_document.parse(): `court_code=data.get("Signatur")`)
    -- entscheidsuche's own identifier for the court, in the SAME vocabulary
    Snapshots/{date}.json uses. But it is written at chamber granularity
    ("ZG_OG_001", matching the fixture in es_document.py's own docstring),
    one level finer than the court-code level `total`'s "rest" keys use
    ("ZG_OG") -- stripping the identical "_<digits>" suffix
    spiders_that_grew() already treats as chamber noise recovers exactly
    that level. Verified against the real 2026-08-23 snapshot: both "ZG_OG"
    and "CH_BGer" are members of its 131-key court-code level, the same
    level stripping produces here.

    This is necessarily partial, and grows only as documents already sit in
    the table: a spider we have never successfully indexed contributes no
    row and therefore no entry. That is the correct behaviour, not a bug to
    paper over with an invented one -- see run_decisions for how the
    remaining gap is reported, never silently assumed away.
    """
    rows = conn.execute(
        "SELECT DISTINCT spider, court_code FROM ch_court_decisions "
        "WHERE court_code IS NOT NULL"
    ).fetchall()
    mapping: dict[str, str] = {}
    for row in rows:
        # db.connect() hands out dict_row in production; the test fixture's
        # own bare psycopg.connect() hands out tuples (same convention
        # index_stage.upsert() and versions_stage already follow) -- read
        # either shape rather than assuming one.
        spider, court_code = ((row["spider"], row["court_code"])
                              if isinstance(row, dict) else (row[0], row[1]))
        root = _CHAMBER_SUFFIX.sub("", court_code)
        existing = mapping.get(root)
        if existing is not None and existing != spider:
            # Two different spiders reporting documents under the same
            # stripped court code is a real data anomaly worth a human
            # noticing, not a reason to crash a nightly job over. Keep the
            # first one seen (deterministic given ORDER BY is absent only
            # because DISTINCT already dedupes exact pairs; row order from
            # Postgres without an ORDER BY is not guaranteed stable, so
            # "first seen" is best-effort, not a promise) and say so.
            log.warning("court_code_spider_map: %r maps to both %r and %r; "
                       "keeping %r", root, existing, spider, existing)
            continue
        mapping[root] = spider
    return mapping


def run_decisions(settings: Settings, fetcher_factory=None) -> DeltaReport:
    snapshot, day = _fetch_latest_snapshot(fetcher_factory)
    if snapshot is None:
        log.warning(
            "no entscheidsuche snapshot published in the last %d days; "
            "skipping the decisions delta", _SNAPSHOT_LOOKBACK_DAYS)
        return DeltaReport()

    current = snapshot["total"]
    previous = _load_state(settings)
    grown = spiders_that_grew(previous, current)

    if not grown:
        _save_state(settings, current)
        return DeltaReport()

    conn = db.connect(settings)
    try:
        mapped = court_code_spider_map(conn)
    finally:
        conn.close()

    # Two ways a changed key becomes an actual re-index target: it already
    # spells one of our 54 directory names exactly (the 7-of-54 case), or
    # the corpus-derived mapping resolves it to one (see
    # court_code_spider_map). Keys reachable both ways are one spider, not
    # two -- dict-building on spider name dedupes that for free.
    known = set(index_stage.ALL_SPIDERS)
    actionable: dict[str, str] = {}     # spider -> the snapshot key that grew
    for name in grown:
        if name in known:
            actionable[name] = name
        elif name in mapped:
            actionable[mapped[name]] = name
    unmapped = [name for name in grown if name not in known and name not in mapped]

    if unmapped:
        # Real signal we cannot act on -- see the module docstring. Logged
        # every run, at WARNING, so this can never read as a clean night:
        # missed_growth/total_growth is THIS NIGHT's number (F9 -- the stock
        # of the unmapped courts is constant almost every night and says
        # nothing about tonight; the growth actually missed is the same two
        # dicts spiders_that_grew already compared).
        total_growth = _growth(previous, current, grown)
        missed_growth = _growth(previous, current, unmapped)
        share = f"{missed_growth / total_growth * 100:.0f}%" if total_growth else "n/a"
        log.warning(
            "delta(%s): %d changed key(s) resolve to no spider (by name or "
            "by the corpus-derived court_code map) and cannot be re-indexed "
            "tonight -- missed %d of %d new document(s) detected (%s): %s",
            day, len(unmapped), missed_growth, total_growth, share,
            ",".join(unmapped))

    if not actionable:
        _save_state(settings, current)
        return DeltaReport()

    spiders = sorted(actionable)
    log.info("delta(%s): %d spider(s) changed and are actionable: %s",
             day, len(spiders), ",".join(spiders))
    index_report = index_stage.run(settings, spiders)
    for spider in spiders:
        fetch_stage.run(settings, spider=spider)
        extract_stage.run(settings, spider=spider)
        load_stage.run(settings, spider=spider)

    # index_stage.run() swallows a per-spider listing failure into
    # `failed_spiders` rather than raising -- deliberately, so one flaky
    # 116 MB CH_BGer listing does not abort the other 53 (index_stage.py).
    # But that means a spider whose listing never actually loaded tonight
    # must NOT have its snapshot counter advanced in the saved baseline:
    # doing so unconditionally (the previous shape of this function) tells
    # tomorrow's comparison nothing changed there, silently retiring
    # tonight's real growth forever. Keep the OLD stored value (or, if there
    # was none, drop the key) so the very next run sees it as changed again.
    next_state = dict(current)
    failed = set(index_report.failed_spiders)
    for spider, key in actionable.items():
        if spider in failed:
            if key in previous:
                next_state[key] = previous[key]
            else:
                next_state.pop(key, None)

    _save_state(settings, next_state)
    return DeltaReport(spiders=spiders, new_documents=index_report.inserted)


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
    # The single-renice argument above only holds while the two constants
    # are equal. If they ever diverge, a silent renice(NICE_IO) here would
    # run parse_akn_stage -- the one CPU-bound stage in this job -- at the
    # wrong priority, os.nice() cannot be corrected back in-process, and
    # nothing else would fail. Make the premise loud instead of silent.
    assert throttle.NICE_IO == throttle.NICE_CPU, (
        "delta.main() renices once at NICE_IO on the assumption that it "
        "equals NICE_CPU; that has diverged, so this needs a real per-stage "
        "renice again, not one call standing in for all of them")
    throttle.renice(throttle.NICE_IO)
    settings = Settings.from_env()

    # The two corpora are independent -- entscheidsuche and Fedlex share no
    # table, no queue and no failure mode -- but a bare `run_decisions();
    # run_legislation()` couples them: one SPARQL timeout on the decisions
    # side and the legislation half does not run AT ALL that night, and
    # again every night after, until someone reads the traceback. Each half
    # gets its own guard so a bad night on one corpus costs that corpus
    # only.
    #
    # The failures are re-raised once both halves have had their turn, NOT
    # swallowed: run-delta.sh's marker line reports the exit status, and a
    # night where half the job died must not print OK. Raising the FIRST
    # failure (the others are logged in full above it) keeps the traceback
    # an operator sees pointing at a real cause rather than at a synthetic
    # wrapper exception.
    reports: dict[str, DeltaReport] = {}
    failures: list[tuple[str, BaseException]] = []
    for name, half in (("decisions", run_decisions),
                       ("legislation", run_legislation)):
        try:
            reports[name] = half(settings)
        except Exception as exc:               # noqa: BLE001 -- see above
            log.exception("delta: the %s half failed", name)
            failures.append((name, exc))
            reports[name] = DeltaReport()

    decisions, legislation = reports["decisions"], reports["legislation"]
    log.info("delta: spiders=%s new_documents=%d new_versions=%d failed=%s",
             decisions.spiders, decisions.new_documents,
             legislation.new_versions,
             ",".join(name for name, _ in failures) or "none")
    if failures:
        raise failures[0][1]
    return DeltaReport(spiders=decisions.spiders,
                       new_documents=decisions.new_documents,
                       new_versions=legislation.new_versions)


if __name__ == "__main__":
    main()
