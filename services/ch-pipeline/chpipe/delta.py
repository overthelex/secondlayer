"""Daily delta for the three Swiss corpora, run once a night once the
backfill is finished (spec section 10). Every WRITE happens inside a stage
that already has its own real-Postgres tests (index_stage, fetch_stage,
extract_stage, load_stage, acts_stage, versions_stage, fetch_xml_stage,
parse_akn_stage, zefix_stage, shab_list_stage, shab_detail_stage) --
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
import os
import pathlib
import re
from dataclasses import dataclass, field

from . import db
from .config import Settings
from .http import Fetcher, FetchError
from .stages import (acts_stage, aliases_stage, citations_resolve_stage,
                     citations_stage, diff_stage, extract_stage, fetch_stage,
                     fetch_xml_stage, index_stage, load_stage,
                     parse_akn_stage, project_legacy_stage,
                     provenance_stage, shab_detail_stage, shab_list_stage,
                     versions_stage, zefix_stage)

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
    # Downstream of the newly parsed editions: the change log, the footnote
    # provenance, and the projection into the served ch_legislation table.
    new_changes: int = 0
    new_provenance: int = 0
    projected: int = 0
    # The cantonal (Lexwork) step: acts re-walked and editions discovered
    # tonight, and the cantons whose host did not answer.
    cantonal_acts: int = 0
    cantonal_versions: int = 0
    cantonal_failed: list[str] = field(default_factory=list)


@dataclass
class RegistriesReport:
    zefix: zefix_stage.ZefixReport = field(default_factory=zefix_stage.ZefixReport)
    shab_list: shab_list_stage.ShabListReport = field(
        default_factory=shab_list_stage.ShabListReport)
    shab_detail: shab_detail_stage.ShabDetailReport = field(
        default_factory=shab_detail_stage.ShabDetailReport)


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


CANTONAL_STATE_FILE = "cantonal-state.json"


def _state_path(settings: Settings, name: str = STATE_FILE) -> pathlib.Path:
    return settings.raw_dir / name


def _load_state(settings: Settings, name: str = STATE_FILE) -> dict:
    """The stored baseline, or {} when there is not a usable one.

    An unreadable or unparseable file is treated as "no baseline" -- but
    LOUDLY, and never as a crash. The two rejected alternatives say why:

      * letting json.loads raise takes down the whole nightly job over a
        file that a kill -9 mid-write could produce (which is exactly what
        _save_state below now makes impossible, but a full disk, a bad
        restore or a hand-edit still can). The decisions half would then not
        run again until a human read the traceback.
      * swallowing it silently is worse than the crash: {} means every
        snapshot key looks grown, so the run walks all 54 spiders. That is
        the SAFE direction -- an expensive night, not a lost document -- but
        an operator who is not told will read a full re-walk as a mystery.
    """
    path = _state_path(settings, name)
    if not path.exists():
        return {}
    try:
        state = json.loads(path.read_text())
    except (ValueError, OSError) as exc:
        log.warning(
            "%s is unreadable (%s: %s) -- continuing with NO baseline, which "
            "means every court reads as changed and tonight's run re-walks "
            "all of them. Not fatal and not silent: the file is rewritten at "
            "the end of this run, so this should not repeat.",
            path, type(exc).__name__, exc)
        return {}
    if not isinstance(state, dict):
        log.warning(
            "%s parsed as %s, not the counter map this file is -- continuing "
            "with NO baseline (every court reads as changed) rather than "
            "indexing into something that is not one",
            path, type(state).__name__)
        return {}
    return state


def _save_state(settings: Settings, snapshot: dict, name: str = STATE_FILE) -> None:
    """Write the baseline atomically: temp file, then os.replace().

    A direct write_text() truncates the existing file first, so a kill
    anywhere in the write leaves a half-written baseline -- and a baseline is
    the one piece of state in this job that decides which documents are
    retired unfetched. os.replace() is atomic within a filesystem, so the
    file a reader sees is always one complete run's map: the old one or the
    new one, never a prefix of either. The temp file is created beside it for
    the same reason -- a rename across filesystems is not atomic.
    """
    path = _state_path(settings, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(snapshot, ensure_ascii=False))
        os.replace(tmp, path)
    except BaseException:
        # Including KeyboardInterrupt/SystemExit: an abandoned .tmp beside
        # the real file would otherwise accumulate one per killed run.
        tmp.unlink(missing_ok=True)
        raise


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


def court_code_spider_map(conn) -> dict[str, tuple[str, ...]]:
    """Court-code-level key (e.g. "ZH_OG") -> the spider directory name(s)
    (e.g. ("ZH_Obergericht",)) that have loaded documents under it, built
    from documents already loaded rather than from a hand-maintained table.

    A tuple, not a string, because one stripped court code can legitimately
    belong to two spiders. Measured on the loaded prod corpus (24.08.2026,
    448K rows, all 54 spiders): VD_TC_004/013/002 are VD_FindInfo's chambers
    and VD_TC_031 is VD_Omni's, so "VD_TC" is both. Keeping "the first one"
    silently routed VD_Omni's growth to a VD_FindInfo re-index that could
    never contain it. Every spider under an ambiguous code is re-indexed
    instead: index is the cheap metadata stage, and a superfluous walk
    costs a listing, while a mis-routed one costs a court's growth.

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

    It is also partial in the other direction. `spider` in this table is
    whatever wrote the row, and a value that no longer names a directory
    under CHPIPE_RAW_DIR (a spider entscheidsuche renamed, a one-off import)
    would otherwise become a nightly re-index target for a listing that
    404s, forever. Entries are intersected with index_stage.ALL_SPIDERS, and
    a dropped one is logged rather than silently discarded -- the court code
    then falls through to run_decisions()'s unmapped WARNING, which is the
    honest place for "we saw growth we cannot act on".
    """
    known = set(index_stage.ALL_SPIDERS)
    # ORDER BY, so "first seen" below is a promise rather than whatever
    # order Postgres happened to return. DISTINCT dedupes exact pairs but
    # says nothing about the order they come back in, and a mapping that
    # differs between runs cannot be reasoned about at 3am.
    rows = conn.execute(
        "SELECT DISTINCT spider, court_code FROM ch_court_decisions "
        "WHERE court_code IS NOT NULL ORDER BY court_code, spider"
    ).fetchall()
    mapping: dict[str, tuple[str, ...]] = {}
    for row in rows:
        # db.connect() hands out dict_row in production; the test fixture's
        # own bare psycopg.connect() hands out tuples (same convention
        # index_stage.upsert() and versions_stage already follow) -- read
        # either shape rather than assuming one.
        spider, court_code = ((row["spider"], row["court_code"])
                              if isinstance(row, dict) else (row[0], row[1]))
        root = _CHAMBER_SUFFIX.sub("", court_code)
        if spider not in known:
            log.warning("court_code_spider_map: %r names spider %r, which is "
                        "not one of the %d spider directories this pipeline "
                        "walks; %r will not be re-indexed from it",
                        court_code, spider, len(known), root)
            continue
        existing = mapping.get(root, ())
        if spider in existing:
            continue
        if existing:
            # Two spiders under one stripped court code -- VD_TC on the real
            # corpus. Both are re-indexed when the code grows; said once per
            # run so the shape stays visible without becoming noise.
            log.info("court_code_spider_map: %r belongs to %r and %r; a "
                     "change on it re-indexes both", root, existing, spider)
        mapping[root] = tuple(sorted(existing + (spider,)))
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
    # spider -> EVERY snapshot key that resolved to it. A dict holding one
    # key per spider silently dropped all but the last: the real 2026-08-23
    # snapshot carries 131 court-code keys against 54 spiders, so several
    # grown keys resolving to one spider is the normal shape, not an edge
    # case ("AG_OG" and "AG_VG" both map to "AG_Gerichte"). The keys are
    # what the saved baseline is keyed by, so losing one means a failed
    # listing rolls back only the survivor and retires the other court's
    # growth as though it had been indexed.
    actionable: dict[str, list[str]] = {}
    for name in grown:
        spiders = (name,) if name in known else mapped.get(name, ())
        for spider in spiders:
            actionable.setdefault(spider, []).append(name)
    unmapped = [name for name in grown if name not in known and name not in mapped]

    # The baseline advances to `current` only for keys this run actually
    # walked. Everything else is held at its PREVIOUS value (or dropped, if
    # there was none) so tomorrow's comparison sees the same growth again
    # rather than retiring documents nobody fetched.
    next_state = dict(current)

    def hold_back(keys) -> None:
        for key in keys:
            if key in previous:
                next_state[key] = previous[key]
            else:
                next_state.pop(key, None)

    if unmapped:
        # Real signal we cannot act on -- see the module docstring. Logged
        # every run, at WARNING, so this can never read as a clean night.
        #
        # The number is the growth OUTSTANDING on those keys, not just
        # tonight's: their baseline is held back below, so `previous` for an
        # unmapped court is the last point at which it was actually walked,
        # and the figure therefore accumulates until either a spider or a
        # court_code row closes the gap. That is the escalating signal this
        # warning is for. (F9's finding still holds against what it was
        # written about: current.get(name, 0), the court's whole STOCK,
        # which is near-constant and says nothing about anything.)
        total_growth = _growth(previous, current, grown)
        missed_growth = _growth(previous, current, unmapped)
        share = f"{missed_growth / total_growth * 100:.0f}%" if total_growth else "n/a"
        log.warning(
            "delta(%s): %d changed key(s) resolve to no spider (by name or "
            "by the corpus-derived court_code map) and cannot be re-indexed "
            "tonight -- %d of %d detected new document(s) still unindexed "
            "(%s): %s",
            day, len(unmapped), missed_growth, total_growth, share,
            ",".join(unmapped))
    hold_back(unmapped)

    if not actionable:
        _save_state(settings, next_state)
        return DeltaReport()

    spiders = sorted(actionable)
    log.info("delta(%s): %d spider(s) changed and are actionable: %s",
             day, len(spiders), ",".join(spiders))
    index_report = index_stage.run(settings, spiders)
    for spider in spiders:
        fetch_stage.run(settings, spider=spider)
        extracted = extract_stage.run(settings, spider=spider)
        load_stage.run(settings, spider=spider)
        # citations_stage claims whatever just landed at `loaded` for this
        # spider -- run right after load, in the same per-spider lap, so a
        # decision's citation graph is only ever as many nights stale as its
        # text is, not built up as a separate backlog the resolve pass has
        # to wait on.
        citations_stage.run(settings, spider=spider)
        # extract sends an HTML card with a PDF behind it back to `indexed`
        # (db.requeue_for_pdf). Inside a single-lap run nothing came back
        # for it, so on the first nightly run 33 such rows sat in `indexed`
        # until the next night. One more lap, only when needed and only
        # once: a second requeue would mean the PDF was a phantom, and that
        # row retires through fetch's own attempts.
        if getattr(extracted, "requeued_for_pdf", 0):
            log.info("delta(%s): %s re-queued %d HTML card(s) for their PDF; "
                     "fetching those now rather than tomorrow",
                     day, spider, extracted.requeued_for_pdf)
            fetch_stage.run(settings, spider=spider)
            extract_stage.run(settings, spider=spider)
            load_stage.run(settings, spider=spider)
            citations_stage.run(settings, spider=spider)

    # index_stage.run() swallows a per-spider listing failure into
    # `failed_spiders` rather than raising -- deliberately, so one flaky
    # 116 MB CH_BGer listing does not abort the other 53 (index_stage.py).
    # But that means a spider whose listing never actually loaded tonight
    # must NOT have its snapshot counter advanced in the saved baseline:
    # doing so tells tomorrow's comparison nothing changed there, silently
    # retiring tonight's real growth forever. Roll back EVERY key that
    # resolved to the failed spider, not one of them -- see `actionable`.
    #
    # DOCUMENT-level failures need the identical treatment, and did not have
    # it. index_stage counts a document whose JSON 404s, decodes badly or
    # fails to write in report.failed and moves on -- correctly, one bad file
    # must not cost a court -- but the baseline then advanced over it anyway,
    # so those documents were dropped from the corpus permanently and in
    # silence. The snapshot counter is the only record that they were ever
    # supposed to be here. A spider is therefore held back if its listing
    # failed OR if any of its documents did.
    #
    # The cost is real and accepted: a document that fails PERMANENTLY (a
    # JSON entscheidsuche will never serve) keeps its court on the nightly
    # re-walk list until somebody looks. That is the escalating signal, the
    # same shape as the unmapped-key WARNING above -- and the alternative is
    # a corpus that quietly stops containing a decision. For a legal
    # database that is not a trade worth making.
    failed = set(index_report.failed_spiders)
    incomplete = {spider for spider, n in index_report.failed_per_spider.items()
                  if n}
    if incomplete - failed:
        log.warning(
            "delta(%s): %s had document-level failures (%s); their snapshot "
            "baselines are held back, so these courts are re-walked tomorrow "
            "rather than having tonight's growth retired unindexed",
            day, ",".join(sorted(incomplete - failed)),
            ",".join(f"{s}:{index_report.failed_per_spider[s]}"
                     for s in sorted(incomplete - failed)))
    for spider in sorted((failed | incomplete) & set(actionable)):
        hold_back(actionable[spider])

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
    parsed = parse_akn_stage.run(settings)

    # Parsing is not where a new edition becomes readable. `diff` is what
    # gives it a change log, `provenance` what gives its articles their
    # footnote record, and `project-legacy` what puts it in the table the
    # product actually serves. Stopping after parse_akn left a corpus where
    # every edition of an act had those three EXCEPT the newest -- the one a
    # reader is most likely to ask about -- and it stayed that way until
    # somebody happened to run the stages by hand.
    #
    # Narrowed to the acts that actually gained an edition tonight, and to
    # the languages they gained it in, rather than re-walking the whole
    # corpus: on a quiet night parsed.acts is empty and this costs one
    # already-incremental projection query. diff and provenance both re-do
    # an act WHOLE (every consecutive edition pair, every parsed edition) --
    # that is their unit of work and it is what makes them idempotent, so
    # the narrowing is by act, not by edition.
    report = DeltaReport(new_versions=versions.discovered)
    for act_id, lang in sorted(parsed.acts):
        report.new_changes += diff_stage.run(
            settings, lang=lang, act_id=act_id).changes
        report.new_provenance += provenance_stage.run(
            settings, lang=lang, act_id=act_id).rows
    # Unconditional: project_legacy_stage picks its own pending set (an
    # edition parsed but not yet projected), so on a night with nothing new
    # it is one query, and on a night where an EARLIER run parsed something
    # and died before projecting it, this is what recovers it.
    report.projected = project_legacy_stage.run(settings)
    return report


def run_registries(settings: Settings) -> RegistriesReport:
    """The third corpus this job keeps fresh: zefix (the company register,
    from LINDAS) and the two amtsblattportal.ch (SHAB) stages, which are its
    own delta on their own queues rather than a snapshot comparison like
    run_decisions or a re-run-the-whole-graph like run_legislation.

    zefix_stage.run() is a full walk of every municipality partition, but it
    is NOT a full re-fetch every night: `run()` resumes by run_date, so a
    prior run today that already finished a partition is skipped, and the
    common case -- one nightly run per run_date -- walks all ~2,100
    partitions once, measured at roughly 10-20 minutes end to end. Called
    with no `municipalities` filter, deliberately: that argument exists for
    a targeted re-run (CHPIPE_ZEFIX_MUNICIPALITIES), not for the nightly
    delta, which needs the whole register compared every night the same way
    run_decisions needs the whole snapshot.

    shab_list_stage.run(months=2) walks only the last two calendar months
    rather than the ~26 years the backfill covers -- a SHAB publication is
    never backdated, so anything older than the current and previous month
    is not going to change, and re-listing it every night would cost 2.5M
    rows of HTTP for zero new publications. Two months, not one, so a
    publication that lands in the last days of a month is still covered by
    the run that follows the month boundary.

    shab_detail_stage.run(budget_seconds=settings.shab_budget_seconds) drains
    the detail queue (rows shab_list wrote with no detail_fetched_at yet)
    under a clock, not a row count -- 90 minutes by default
    (CHPIPE_SHAB_BUDGET_SECONDS via Settings.shab_budget_seconds), because
    the queue this stage claims from is shared with the standalone backfill
    and can be arbitrarily large the first time this runs. The queue model
    (detail_fetched_at IS NULL AND detail_attempts < 3, FOR UPDATE SKIP
    LOCKED) is what makes stopping on a clock safe: nothing is left
    half-claimed, and tomorrow's run picks the same query up where tonight's
    left off.

    Order matters for one reason not obvious from the calls alone: zefix
    before shab-detail is what gives shab-detail's legal-form CODES a label
    at all (shab_detail_stage.legal_form_labels() reads them from
    ch_zefix_companies, populated by zefix -- see that function's own
    docstring). Calling shab-detail before zefix has ever run does not fail,
    it just leaves every legal_form holding a bare eCH-0097 code instead of
    its German label, which is why zefix runs first here even though the two
    stages write disjoint tables and neither depends on the other's rows to
    make progress.

    That ordering is a preference, not a dependency, which is why each of
    the three gets its own guard: they write disjoint tables and share no
    failure mode, so a LINDAS timeout used to cost the gazette a whole
    night -- shab-list and shab-detail never ran, and the queue they drain
    grew by another day's publications with nothing taking from it. Same
    shape as main()'s guard over its own three halves: every stage gets its
    turn, the failures are logged in full, and the FIRST one is re-raised
    afterwards so run-delta.sh's marker line cannot report OK on a night
    that lost a stage.
    """
    report = RegistriesReport()
    failures: list[BaseException] = []
    # The name is the RegistriesReport field the stage fills, so a stage that
    # fails leaves that field at its zero report and the rest of the run is
    # still described.
    for name, call in (
            ("zefix", lambda: zefix_stage.run(settings)),
            ("shab_list", lambda: shab_list_stage.run(settings, months=2)),
            ("shab_detail", lambda: shab_detail_stage.run(
                settings, budget_seconds=settings.shab_budget_seconds))):
        try:
            setattr(report, name, call())
        except Exception as exc:               # noqa: BLE001 -- see above
            log.exception("registries: the %s stage failed", name)
            failures.append(exc)
    if failures:
        raise failures[0]
    return report


# recent_changes pages carry the whole act record per entry (2.7 MB for 16
# entries on BE); only systematic_number and change_date are read. A quiet
# night is one page per canton; the cap is a backstop against a host that
# never reaches last_seen, not a budget.
_RECENT_CHANGES_PAGE_CAP = 200


async def changed_since(client, canton, last_seen: str) -> set[str]:
    """Systematic numbers of the acts a Lexwork host reports as changed on
    or after `last_seen` (ISO date), paging status/recent_changes newest
    first until a page's oldest entry is older than that."""
    changed: set[str] = set()
    offset = 0
    for _ in range(_RECENT_CHANGES_PAGE_CAP):
        page = await client.recent_changes(canton, offset)
        entries = page.get("entries") or []
        if not entries:
            break
        oldest = None
        for entry in entries:
            date = (entry.get("change_date") or "")[:10]
            sysnr = (entry.get("text_of_law") or {}).get("systematic_number")
            if date >= last_seen and sysnr:
                changed.add(sysnr)
            if date and (oldest is None or date < oldest):
                oldest = date
        if oldest is None or oldest < last_seen or not page.get("next_batch"):
            break
        offset += len(entries)
    else:
        log.warning("%s: recent_changes did not reach %s within %d pages; the weekly "
                    "full re-walk covers whatever this missed", canton.code, last_seen,
                    _RECENT_CHANGES_PAGE_CAP)
    return changed


def _changed_since(settings: Settings, canton, last_seen: str, transport) -> set[str]:
    from .http import Fetcher
    from .lexwork_api import LexworkClient

    async def go():
        async with Fetcher(concurrency=settings.cantonal_per_host, transport=transport) as fetcher:
            return await changed_since(LexworkClient(fetcher, settings.cantonal_per_host),
                                       canton, last_seen)
    return asyncio.run(go())


def run_cantonal(settings: Settings, transport=None) -> DeltaReport:
    """The cantonal (Lexwork) twin of run_legislation, per canton.

    Narrowed by the host's own change log: status/recent_changes since the
    canton's last successful run, then cantonal-acts for just those numbers,
    then fetch, parse, diff for the acts that gained an edition, and one
    projection at the end. A canton with NO baseline is not walked: a first
    unattended walk is the whole corpus under the nightly flock, which the
    README says to do supervised instead -- its baseline is set to today
    with a warning, and the weekly full re-walk is what keeps it honest.
    A canton whose host fails keeps its old baseline and is retried the
    next night; the others are not held up by it.
    """
    from . import cantons
    from .stages import cantonal_acts_stage, cantonal_fetch_stage, cantonal_parse_stage

    report = DeltaReport()
    state = _load_state(settings, CANTONAL_STATE_FILE)
    today = _today().isoformat()
    touched = False
    for code in cantons.lexwork_codes(None):
        canton = cantons.LEXWORK[code]
        last_seen = state.get(code)
        if not last_seen:
            log.warning("%s: no cantonal baseline; NOT walking it unattended. Run the "
                        "supervised backfill (README), then this step picks up changes "
                        "from %s on.", code, today)
            state[code] = today
            continue
        try:
            changed = _changed_since(settings, canton, last_seen, transport)
            if changed:
                acts = cantonal_acts_stage.run(settings, code, only=changed, transport=transport)
                if acts.hosts_failed:
                    raise RuntimeError(f"{code}: host {canton.host} did not answer")
                report.cantonal_acts += acts.acts
                report.cantonal_versions += acts.versions
                cantonal_fetch_stage.run(settings, code, transport=transport)
                parsed = cantonal_parse_stage.run(settings, code)
                touched = True
                for act_id, lang in sorted(parsed.acts):
                    report.new_changes += diff_stage.run(settings, lang=lang, act_id=act_id).changes
            else:
                log.info("%s: no changes since %s", code, last_seen)
        except Exception:                           # noqa: BLE001 -- per canton
            log.exception("delta: canton %s failed; baseline kept at %s", code, last_seen)
            report.cantonal_failed.append(code)
            continue
        state[code] = today
    # Projection only when something was parsed: on a quiet night (and on
    # the baseline-setting first night) this step touches no database at all.
    if touched:
        report.projected = project_legacy_stage.run(settings)
    _save_state(settings, state, CANTONAL_STATE_FILE)
    return report


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
    every stage this module touches (index/fetch/extract/load/citations on
    the decisions side, acts/versions/fetch-xml on the legislation side,
    parse-akn, the one CPU stage in the mix, zefix/shab-list/shab-detail on
    the registries side, and citations-resolve after all three) resolves to
    one of those two values -- so a single renice(NICE_IO)
    here reproduces exactly what an unattended sequence of each stage's own
    main() would have set, without stacking os.nice()'s cumulative increment
    once per stage. wait_for_capacity
    is NOT called again here: it already lives inside extract_stage.run(),
    citations_stage.run() and parse_akn_stage.run() themselves (the
    CPU-bound stages, and the only ones that check it even from main()), so
    calling run() directly still gets it -- only renice needed reproducing.
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
                       ("legislation", run_legislation),
                       ("cantonal", run_cantonal)):
        try:
            reports[name] = half(settings)
        except Exception as exc:               # noqa: BLE001 -- see above
            log.exception("delta: the %s half failed", name)
            failures.append((name, exc))
            reports[name] = DeltaReport()

    # run_registries is a third, independent guarded step, not folded into
    # the loop above: it returns a RegistriesReport, not a DeltaReport, and
    # zefix/SHAB share no table, queue or failure mode with either corpus
    # above -- a LINDAS timeout or an amtsblattportal outage must cost the
    # registries half only, exactly like decisions and legislation cost only
    # themselves. Placed after both of them and before the alias
    # seed/citations-resolve pair below: those two are about the CITATION
    # graph over decisions and legislation, which run_registries neither
    # feeds nor depends on, so its only ordering requirement is internal
    # (zefix before shab-detail, inside run_registries itself) and it can
    # run anywhere in the tail without changing what either resolve step
    # sees.
    registries_report = RegistriesReport()
    try:
        registries_report = run_registries(settings)
        log.info("delta: registries zefix(upserted=%d inactivated=%d "
                 "sweep_skipped=%s) "
                 "shab_list(months=%d pages=%d upserted=%d) "
                 "shab_detail(claimed=%d fetched=%d failed=%d)",
                 registries_report.zefix.upserted,
                 registries_report.zefix.inactivated,
                 registries_report.zefix.sweep_skipped,
                 registries_report.shab_list.months,
                 registries_report.shab_list.pages,
                 registries_report.shab_list.upserted,
                 registries_report.shab_detail.claimed,
                 registries_report.shab_detail.fetched,
                 registries_report.shab_detail.failed)
    except Exception as exc:                    # noqa: BLE001 -- see above
        log.exception("delta: the registries half failed")
        failures.append(("registries", exc))

    # citations_resolve_stage is another independent guarded step -- not
    # folded into the loop above because it returns a ResolveReport, not a
    # DeltaReport, and because it belongs after BOTH halves regardless of
    # which one (if either) failed: ch_legislation_citations references acts
    # and ch_case_citations references decisions, so whatever raw edges
    # citations_stage already wrote -- this run or an earlier one -- are
    # worth resolving even on a night the legislation half died. Same guard
    # shape as the loop: logged in full, appended to `failures`, and never
    # allowed to swallow (or be swallowed by) the other two.
    #
    # aliases_stage comes immediately before it, guarded the same way and for
    # the same reason it exists at all: step 1 of resolution looks the
    # citation's abbreviation up in ch_act_alias, and the legislation half
    # that just ran may have discovered acts whose abbreviation is not in
    # that table yet. Seeding after the resolve instead of before it would
    # leave every citation of a newly discovered act stamped
    # 'unresolved_abbr' -- a TERMINAL state that no ordinary run revisits
    # (see citations_resolve_stage's docstring), so those citations would
    # stay unresolved until an operator ran CHPIPE_CIT_RESOLVE_ALL by hand.
    # Its own guard, not a shared one: a failing alias seed must still leave
    # the resolve pass to run over the edges already extracted.
    try:
        alias_report = aliases_stage.run(settings)
        log.info("delta: aliases inserted=%d total=%d",
                 alias_report.inserted, alias_report.total)
    except Exception as exc:                    # noqa: BLE001 -- see above
        log.exception("delta: the alias seed failed")
        failures.append(("aliases", exc))

    resolve_report = citations_resolve_stage.ResolveReport()
    try:
        resolve_report = citations_resolve_stage.run(settings)
    except Exception as exc:                    # noqa: BLE001 -- see above
        log.exception("delta: the citations-resolve half failed")
        failures.append(("citations-resolve", exc))

    decisions, legislation = reports["decisions"], reports["legislation"]
    cantonal = reports["cantonal"]
    log.info("delta: spiders=%s new_documents=%d new_versions=%d "
             "new_changes=%d new_provenance=%d projected=%d "
             "registries(zefix=%d shab_list=%d shab_detail=%d) "
             "cantonal(acts=%d versions=%d changes=%d projected=%d failed=%s) "
             "resolved(acts=%d editions=%d articles=%d cases=%d) failed=%s",
             decisions.spiders, decisions.new_documents,
             legislation.new_versions, legislation.new_changes,
             legislation.new_provenance, legislation.projected,
             registries_report.zefix.upserted,
             registries_report.shab_list.upserted,
             registries_report.shab_detail.fetched,
             cantonal.cantonal_acts, cantonal.cantonal_versions, cantonal.new_changes,
             cantonal.projected, ",".join(cantonal.cantonal_failed) or "none",
             resolve_report.acts, resolve_report.editions,
             resolve_report.articles, resolve_report.cases,
             ",".join(name for name, _ in failures) or "none")
    # A canton whose host failed is logged inside run_cantonal and retried
    # tomorrow; it is not a failed half, so it does not fail the night.
    if failures:
        raise failures[0][1]
    return DeltaReport(spiders=decisions.spiders,
                       new_documents=decisions.new_documents,
                       new_versions=legislation.new_versions,
                       new_changes=legislation.new_changes + cantonal.new_changes,
                       new_provenance=legislation.new_provenance,
                       projected=legislation.projected + cantonal.projected,
                       cantonal_acts=cantonal.cantonal_acts,
                       cantonal_versions=cantonal.cantonal_versions,
                       cantonal_failed=list(cantonal.cantonal_failed))


if __name__ == "__main__":
    main()
