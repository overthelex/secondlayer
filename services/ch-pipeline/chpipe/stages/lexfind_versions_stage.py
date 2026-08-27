"""Materialise LexFind's registry (ch_cantonal_registry) into ch_act and
ch_act_version rows with source 'lexfind', stage 'discovered' and the
version's PDF as xml_url -- the discovery half of phase 2 of the cantonal
corpus. A separate PDF-text stage claims source IN ('lexfind',
'lexwork_pdf') at 'discovered' and downloads xml_url expecting a PDF.

No network: everything comes from versions_json, and the PDF route is a
function of the ids (lexfind_api.pdf_url; verified live 2026-08-26), so a
registry walked before pdf_urls existed is materialised as is.

Two scopes, CHPIPE_LEXFIND_SCOPE, defaulting per canton to the platform:

  all   (the 7 cantons without a Lexwork host: ZH VD TI NE GE JU SZ; prod
        2026-08-26: 8,488 acts / 67,710 versions, one language each)
        every act, every dated version, every language it has;
  gaps  (the 19 Lexwork cantons) only (a) acts with no ch_act at all for
        (jurisdiction, sr_number) -- prod: 3,407 registry acts, all but two
        abrogated, the host answers 404 -- and (b) on shared acts, versions
        dated before the act's earliest existing edition minus 7 days
        (prod: 17,059 of 19,073 LexFind-only dates are older than our
        history; 123 are within +-7 days and are date offsets, not
        editions). Nothing is ever written inside or after a host's
        history: those editions are the host's, and the nightly delta's.

In both scopes a version within +-7 days of an edition of another source
(same act, same language) is the same edition and is skipped, counted.

Act matching. sr_number is not unique even inside one canton's registry
(BE: 7 numbers carried by 2 tols each -- 322.1 is an abrogated
"Jugendrechtspflegegesetz" AND the active act the host serves under that
number), so a registry act is resolved in this order: its own row
(eli_work_uri 'lexfind:{tol_id}', or metadata_json.lexfind_tol_id), then
an act of another source with the same (jurisdiction, sr_number) --
unconditionally when the number names one tol in the registry (LexFind
and the host may disagree on the status of one act, that does not make
it two acts), and only on matching in-force status when the number is
shared, each foreign act claimed once per run. Anything else is a new
act. A matched foreign act is not rewritten: cantonal_acts_stage owns its
metadata and would overwrite ours weekly anyway.

Dates. version_active_since is the start; version_inactive_since exists
only on abrogated versions (2,495 in the 7 cantons) and is the abrogation
date, i.e. the day the edition STOPPED applying, so the inclusive end is
that minus one. info_badge_date says the same thing for every abrogated
or "removed" version (equal to version_inactive_since in all 2,495 cases
that have both; the only end date of the 599 removed -- renumbered --
acts whose newest version has none), and is read the same way, capped by
the successor rule. Otherwise an edition ends the day before its successor
starts -- the successor being the next dated version of the same act and
language, LexFind's or another source's, whichever comes first. Same-day
pairs are common (SZ: 955 of 3,238 versions; a "formless" correction is
listed next to the version it corrects, e.g. 172.113 ids 81436/81434 both
01.01.2014): the document-first entry is the corrected text and keeps the
range, the one it replaced gets end = start - 1, exactly cantonal_acts_
stage's rule for GR's formless corrections. The newest version of an
in-force act stays open (NULL), a future one included.

Idempotent: acts and versions are upserted on their stable keys, stage is
never touched on conflict, and a rerun reports versions_updated instead of
versions_inserted.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field, fields

from psycopg.rows import dict_row

from .. import cantons, db, lexfind_api, throttle
from ..config import Settings
from .lexfind_registry_stage import codes

log = logging.getLogger(__name__)

SCOPES = ("all", "gaps")
# LexFind and a host disagree on an edition's date by a few days in 123 of
# 19,073 prod cases (system clocks, publication vs entry into force); a
# version this close to an existing edition is that edition.
_OFFSET = datetime.timedelta(days=7)
_ONE_DAY = datetime.timedelta(days=1)


@dataclass
class Counts:
    acts_created: int = 0
    acts_matched: int = 0
    versions_inserted: int = 0
    versions_updated: int = 0
    versions_skipped_existing: int = 0
    versions_skipped_in_history: int = 0
    versions_unparseable_date: int = 0
    versions_no_pdf: int = 0
    versions_same_day_shadow: int = 0

    def add(self, other: "Counts") -> None:
        for f in fields(self):
            setattr(self, f.name, getattr(self, f.name) + getattr(other, f.name))

    def as_dict(self) -> dict[str, int]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass
class VersionsReport:
    cantons: list[str] = field(default_factory=list)
    scope: dict[str, str] = field(default_factory=dict)
    by_canton: dict[str, Counts] = field(default_factory=dict)
    errors: int = 0

    def total(self) -> Counts:
        total = Counts()
        for counts in self.by_canton.values():
            total.add(counts)
        return total


_REGISTRY = """
SELECT lexfind_tol_id, systematic_number, title, is_active, category, original_url, versions_json
  FROM ch_cantonal_registry
 WHERE canton = %(canton)s AND systematic_number IS NOT NULL
 ORDER BY systematic_number, is_active DESC NULLS LAST, lexfind_tol_id
"""

_ACTS = """
SELECT act_id, sr_number, eli_work_uri, in_force,
       metadata_json ->> 'lexfind_tol_id' AS lexfind_tol_id
  FROM ch_act WHERE jurisdiction = %(canton)s
"""

_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number,
                    title_de, title_fr, title_it, title_rm,
                    enforcement_status, metadata_json, stage, updated_at)
VALUES (%(work)s, %(jurisdiction)s, %(sr)s,
        %(title_de)s, %(title_fr)s, %(title_it)s, %(title_rm)s,
        %(status)s, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    sr_number          = EXCLUDED.sr_number,
    title_de           = COALESCE(EXCLUDED.title_de, ch_act.title_de),
    title_fr           = COALESCE(EXCLUDED.title_fr, ch_act.title_fr),
    title_it           = COALESCE(EXCLUDED.title_it, ch_act.title_it),
    title_rm           = COALESCE(EXCLUDED.title_rm, ch_act.title_rm),
    enforcement_status = EXCLUDED.enforcement_status,
    metadata_json      = EXCLUDED.metadata_json,
    updated_at         = now()
RETURNING act_id, (xmax = 0) AS inserted
"""

# Editions of every OTHER source: the timeline a lexfind version must fit
# into. 'failed' rows count -- a host's PDF-only edition (retired by
# cantonal-fetch, reason pdf_only) is still an edition the host holds.
_FOREIGN_EDITIONS = """
SELECT lang, date_applicability FROM ch_act_version
 WHERE act_id = %(act_id)s AND source <> 'lexfind'
"""

# stage deliberately untouched on conflict: a row the PDF-text stage has
# fetched or parsed stays where it is; dates and the URL follow the registry.
_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, source, stage, updated_at)
VALUES (%(act_id)s, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
        %(xml_url)s, 'lexfind', 'discovered', now())
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = EXCLUDED.date_end_applicability,
    xml_url                = EXCLUDED.xml_url,
    updated_at             = now()
RETURNING (xmax = 0) AS inserted
"""

_TITLE_COLUMN = {"de": "title_de", "fr": "title_fr", "it": "title_it", "rm": "title_rm"}


def consolidation_uri(version_id: int, lang: str) -> str:
    return f"lexfind:{int(version_id)}/{lang}"


def work_uri(tol_id: int) -> str:
    return f"lexfind:{int(tol_id)}"


def _date(text) -> datetime.date | None:
    """LexFind's dd.mm.yyyy, or None. Every one of the 67,710 versions of
    the 7 cantons on prod parses; the counter exists for the day one does not."""
    if not isinstance(text, str):
        return None
    try:
        return datetime.datetime.strptime(text.strip(), "%d.%m.%Y").date()
    except ValueError:
        return None


@dataclass
class _Version:
    order: int                     # document index: 0 is the newest
    entry: dict
    since: datetime.date
    until: datetime.date | None    # exclusive: the abrogation date
    langs: list[str]


def _parse_versions(entries: list[dict], counts: Counts) -> list[_Version]:
    parsed = []
    for order, entry in enumerate(entries):
        since = _date(entry.get("version_active_since"))
        if since is None:
            counts.versions_unparseable_date += 1
            continue
        until = _date(entry.get("version_inactive_since"))
        if until is None and entry.get("info_badge") in ("abrogated", "removed"):
            until = _date(entry.get("info_badge_date"))
        if until is not None and until <= since:
            # 8 of 2,495 on prod: an end dated at or before the start.
            # Not a range; let the successor rule (or nothing) close it.
            until = None
        langs = [lang for lang in entry.get("languages") or [] if lang]
        if not langs or entry.get("id") is None:
            counts.versions_no_pdf += 1
            continue
        parsed.append(_Version(order, entry, since, until, langs))
    # Oldest first; on the same day the document-LATER entry (the text that
    # was replaced) comes first so the document-first one is its successor.
    parsed.sort(key=lambda v: (v.since, -v.order))
    return parsed


def _title_lang(canton: cantons.Canton, versions: list[_Version]) -> str:
    """The registry title's language: the canton's first language for a
    Lexwork canton (the registry is walked through /api/fe/de and a
    bilingual host's German title comes back), else the language its
    versions are in (GE/JU/NE/VD fr, TI it, ZH/SZ de)."""
    if canton.langs:
        return canton.langs[0]
    seen = Counter(lang for v in versions for lang in v.langs)
    return seen.most_common(1)[0][0] if seen else "de"


class _ActIndex:
    """The canton's ch_act rows, resolved per registry tol as the module
    docstring describes. Foreign acts are claimed once per run."""

    def __init__(self, rows: list[dict], tols_per_number: Counter):
        self.by_eli = {r["eli_work_uri"]: r for r in rows}
        self.by_tol = {r["lexfind_tol_id"]: r for r in rows if r["lexfind_tol_id"]}
        self.foreign = defaultdict(list)
        for r in rows:
            if not r["eli_work_uri"].startswith("lexfind:") and not r["lexfind_tol_id"]:
                self.foreign[r["sr_number"]].append(r)
        for candidates in self.foreign.values():
            candidates.sort(key=lambda r: (not r["in_force"], r["act_id"]))
        self.tols_per_number = tols_per_number
        self.claimed: set[int] = set()

    def resolve(self, tol_id: int, sysnr: str, is_active) -> dict | None:
        own = self.by_eli.get(work_uri(tol_id)) or self.by_tol.get(str(tol_id))
        if own:
            return own
        candidates = [r for r in self.foreign.get(sysnr, []) if r["act_id"] not in self.claimed]
        if not candidates:
            return None
        same_status = [r for r in candidates if r["in_force"] is bool(is_active)]
        if same_status:
            act = same_status[0]
        elif self.tols_per_number[sysnr] == 1:
            act = candidates[0]
        else:
            return None
        self.claimed.add(act["act_id"])
        return act


def _upsert_act(conn, canton: cantons.Canton, row: dict, title_lang: str) -> tuple[int, bool]:
    params = {
        "work": work_uri(row["lexfind_tol_id"]),
        "jurisdiction": canton.code,
        "sr": row["systematic_number"],
        # Fedlex's vocabulary, as cantonal_acts_stage: 0 in force, 3 not.
        "status": None if row["is_active"] is None else (0 if row["is_active"] else 3),
        "metadata": json.dumps({
            "platform": "lexfind",
            "lexfind_tol_id": row["lexfind_tol_id"],
            "category": row["category"],
            "original_url": row["original_url"],
        }, ensure_ascii=False),
        "title_de": None, "title_fr": None, "title_it": None, "title_rm": None,
    }
    params[_TITLE_COLUMN.get(title_lang, "title_de")] = row["title"] or None
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_UPSERT_ACT, params)
        got = cur.fetchone()
        return got["act_id"], got["inserted"]


def _foreign_editions(conn, act_id: int) -> dict[str, list[datetime.date]]:
    out: dict[str, list[datetime.date]] = defaultdict(list)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_FOREIGN_EDITIONS, {"act_id": act_id})
        for r in cur.fetchall():
            out[r["lang"]].append(r["date_applicability"])
    for dates in out.values():
        dates.sort()
    return out


def _write_versions(conn, act_id: int, versions: list[_Version], scope: str,
                    foreign: dict[str, list[datetime.date]], counts: Counts) -> None:
    langs = sorted({lang for v in versions for lang in v.langs})
    for lang in langs:
        chain = [v for v in versions if lang in v.langs]
        theirs = foreign.get(lang, [])
        earliest = theirs[0] if theirs else None
        for index, version in enumerate(chain):
            if any(abs(version.since - d) <= _OFFSET for d in theirs):
                counts.versions_skipped_existing += 1
                continue
            if scope == "gaps" and earliest is not None and version.since >= earliest - _OFFSET:
                counts.versions_skipped_in_history += 1
                continue
            end = version.until - _ONE_DAY if version.until else None
            if index + 1 < len(chain):
                successor = chain[index + 1].since
                if successor > version.since:
                    closing = successor - _ONE_DAY
                else:
                    closing = version.since - _ONE_DAY
                    counts.versions_same_day_shadow += 1
                end = closing if end is None else min(end, closing)
            later = [d for d in theirs if d > version.since]
            if later:
                closing = later[0] - _ONE_DAY
                end = closing if end is None else min(end, closing)
            pdf = (version.entry.get("pdf_urls") or {}).get(lang) \
                or lexfind_api.pdf_url(version.entry["id"], lang)
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(_UPSERT_VERSION, {
                    "act_id": act_id,
                    "consolidation": consolidation_uri(version.entry["id"], lang),
                    "lang": lang,
                    "date_app": version.since,
                    "date_end": end,
                    "xml_url": pdf,
                })
                if cur.fetchone()["inserted"]:
                    counts.versions_inserted += 1
                else:
                    counts.versions_updated += 1


def _run_canton(conn, canton: cantons.Canton, scope: str, report: VersionsReport) -> None:
    counts = Counts()
    report.by_canton[canton.code] = counts
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_REGISTRY, {"canton": canton.code})
        registry = cur.fetchall()
        cur.execute(_ACTS, {"canton": canton.code})
        acts = _ActIndex(cur.fetchall(), Counter(r["systematic_number"] for r in registry))
    log.info("%s: %d registry acts, %d ch_act rows, scope %s", canton.code,
             len(registry), len(acts.by_eli), scope)
    for row in registry:
        try:
            versions = _parse_versions(row["versions_json"] or [], counts)
            act = acts.resolve(row["lexfind_tol_id"], row["systematic_number"], row["is_active"])
            if act is not None:
                act_id = act["act_id"]
                counts.acts_matched += 1
            else:
                act_id, inserted = _upsert_act(conn, canton, row, _title_lang(canton, versions))
                if inserted:
                    counts.acts_created += 1
                else:
                    counts.acts_matched += 1
            _write_versions(conn, act_id, versions, scope, _foreign_editions(conn, act_id), counts)
        except Exception as exc:                          # noqa: BLE001
            log.error("%s tol %s (%s): %s", canton.code, row["lexfind_tol_id"],
                      row["systematic_number"], exc)
            report.errors += 1
    log.info("%s: %s", canton.code, counts.as_dict())


def scope_for(canton: cantons.Canton, requested: str | None) -> str:
    if requested:
        if requested not in SCOPES:
            raise ValueError(f"CHPIPE_LEXFIND_SCOPE must be one of {SCOPES}, got {requested!r}")
        return requested
    return "all" if canton.platform == "lexfind" else "gaps"


def run(settings: Settings, canton_code: str | None = None, scope: str | None = None) -> VersionsReport:
    """Materialise the named canton(s) (comma-separated; None means all 26).
    scope None follows the platform: 'all' for the 7 LexFind-only cantons,
    'gaps' for the 19 Lexwork ones."""
    selected = codes(canton_code)
    report = VersionsReport(cantons=list(selected))
    conn = db.connect(settings)
    try:
        for code in selected:
            canton = cantons.ALL[code]
            report.scope[code] = scope_for(canton, scope)
            _run_canton(conn, canton, report.scope[code], report)
    finally:
        conn.close()
    return report


def main() -> VersionsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(), canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 scope=os.environ.get("CHPIPE_LEXFIND_SCOPE") or None)
    log.info("cantons=%s scope=%s errors=%d total=%s", ",".join(result.cantons),
             result.scope, result.errors, result.total().as_dict())
    for code, counts in result.by_canton.items():
        log.info("%s: %s", code, counts.as_dict())
    return result


if __name__ == "__main__":
    main()
