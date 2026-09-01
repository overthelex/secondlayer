"""Seeds ch_act_alias (migrations 199 + 206) from four sources, idempotent
but NOT purely additive: the derived rows (sources title_paren and
cantonal_abbreviation, plus federal fedlex_abbreviation) are reconciled on
every run, so a row whose act no longer claims the abbreviation -- or whose
abbreviation has become ambiguous within its (jurisdiction, lang) -- is
DELETED before the current set is inserted. Curated rows are never removed.

Every alias row carries a jurisdiction (migration 206): 'CH' for federal,
the two-letter canton code otherwise. A cantonal abbreviation is only
unambiguous WITHIN its canton -- "LPJA" names a different act in BE, VS and
JU -- so ambiguity is judged per (jurisdiction, lang), and the resolver only
ever offers a citation its own canton's aliases (citations_resolve_stage).

  fedlex_abbreviation  ch_act.abbreviation on the FEDERAL acts, the German
                       abbreviation Fedlex supplies directly ("OR", "ZGB").
                       German only -- Fedlex does not carry an fr/it
                       equivalent column. Trusted per act (no ambiguity
                       rule): it is Fedlex's own assertion about one act.
                       The jurisdiction='CH' filter matters: before
                       migration 206 this pass read cantonal rows too and
                       leaked 5,934 cantonal abbreviations into the federal
                       alias set (measured on prod 2026-08-31), 517 of them
                       colliding with a federal act's sr_number.

  title_paren          the abbreviation the source puts in parentheses at
                       the end of title_de/title_fr/title_it, via
                       ch_aliases.aliases_from_title(). Applies to federal
                       and cantonal acts alike, each under its own
                       jurisdiction.

  cantonal_abbreviation  ch_act.abbreviation on the cantonal acts (the
                       Lexwork platforms supply it; ~5,900 acts carry one).
                       Unlike Fedlex's, these are scraped and demonstrably
                       duplicated WITHIN a canton (AG has 26 abbreviations
                       claimed by two acts each, ZG 27), so the ambiguity
                       rule applies to them too, pooled with the same
                       canton's title_paren candidates.

  curated              ch_aliases.CURATED, hand-maintained for the federal
                       acts whose title carries no parenthesised
                       abbreviation at all (OR, ZGB, StGB, Cst. ...).
                       Seeded unconditionally under jurisdiction 'CH'.

Every insert is `ON CONFLICT DO NOTHING` on (abbr, lang, sr_number,
jurisdiction), so re-running this stage after ch_act gains new acts costs
nothing beyond what actually changed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, throttle
from ..cantons import ALL as CANTONS
from ..ch_aliases import CURATED, aliases_from_title
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class AliasReport:
    inserted: int = 0
    total: int = 0


_FROM_ABBREVIATION = """
INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction)
SELECT abbreviation, 'de', sr_number, 'fedlex_abbreviation', 'CH'
  FROM ch_act
 WHERE jurisdiction = 'CH'
   AND abbreviation IS NOT NULL AND abbreviation <> '' AND sr_number IS NOT NULL
ON CONFLICT DO NOTHING
"""

# Reconcile for the federal abbreviation pass: a 'fedlex_abbreviation' row
# no federal act still asserts is stale. This is also what evicts the
# cantonal rows the pre-206 version of this pass leaked in as pseudo-federal
# (they were backfilled to jurisdiction='CH' by the migration, and no
# federal act claims them) -- the cantonal pass below then re-seeds them
# under their real canton.
_RECONCILE_ABBREVIATION = """
DELETE FROM ch_act_alias al
 WHERE al.source = 'fedlex_abbreviation' AND al.jurisdiction = 'CH'
   AND NOT EXISTS (SELECT 1 FROM ch_act a
                    WHERE a.jurisdiction = 'CH'
                      AND a.abbreviation = al.abbr
                      AND a.sr_number = al.sr_number)
"""

# lang -> the ch_act column that carries that language's title.
_TITLE_COLUMNS = {"de": "title_de", "fr": "title_fr", "it": "title_it"}

_INSERT_ALIAS = """
INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT DO NOTHING
"""

# The sources _reconcile() owns per (jurisdiction, lang): everything a run
# derives from ch_act itself. 'fedlex_abbreviation' has its own set-based
# reconcile above (it is not per-lang), and 'curated' is never removed.
_DERIVED_SOURCES = ("title_paren", "cantonal_abbreviation")


def _canton_abbr_lang(jurisdiction: str) -> str:
    """The language a canton's abbreviation column is recorded under: the
    canton's own primary language. Only ranks candidates in the resolver, so
    a bilingual canton's second language loses nothing. Cantons without a
    text platform have no abbreviation column at all; 'de' is the same
    default the extractor's language inference falls back to."""
    canton = CANTONS.get(jurisdiction)
    return canton.langs[0] if canton and canton.langs else "de"


def _reconcile(conn, jurisdiction: str, lang: str,
               target: set[tuple[str, str]]) -> None:
    """Delete the derived rows of (jurisdiction, lang) this run would not
    (re-)seed. A derived alias can go stale in two ways a later ch_act load
    exposes -- the abbreviation became ambiguous (a second act of the same
    jurisdiction now claims it too), or the act no longer carries it. `ON
    CONFLICT DO NOTHING` only guards against re-inserting a duplicate; it
    never removes a row, so without this a stale alias sits in ch_act_alias
    forever and citations keep resolving to the act that no longer uniquely
    owns it. `curated` and `fedlex_abbreviation` rows are untouched."""
    existing = conn.execute(
        "SELECT abbr, sr_number, source FROM ch_act_alias "
        "WHERE jurisdiction = %s AND lang = %s AND source = ANY(%s)",
        (jurisdiction, lang, list(_DERIVED_SOURCES))).fetchall()
    stale = [(r["abbr"], r["sr_number"], r["source"]) for r in existing
             if (r["abbr"], r["sr_number"]) not in target]
    if stale:
        with conn.cursor() as cur:
            cur.executemany(
                "DELETE FROM ch_act_alias WHERE abbr = %s AND lang = %s "
                "AND sr_number = %s AND jurisdiction = %s AND source = %s",
                sorted((abbr, lang, sr, jurisdiction, source)
                       for abbr, sr, source in stale))
        log.info("aliases: %s stale derived rows removed in %s/%s",
                 len(stale), jurisdiction, lang)


def _derived_for(conn, jurisdiction: str, lang: str) -> int:
    """One (jurisdiction, lang) derivation pass. A Python loop over the
    rows, not a SQL regexp: aliases_from_title() is already the tested
    source of truth for what counts as a trailing abbreviation (and what
    doesn't -- a bare date in parentheses, no comma, no match), so
    re-deriving that logic in SQL would be a second implementation to keep
    in sync with the first.

    **An abbreviation two different acts of the same jurisdiction both claim
    is not seeded at all.** "(KV)" ends the title of every cantonal
    constitution filed under SR 131.xxx, so seeding it maps one abbreviation
    onto 26 acts -- and a Uri court's "Art. 12 KV" then resolves to
    whichever of them citations-resolve's ranking happens to reach first (it
    resolved to Appenzell's). An alias that names 26 acts identifies none of
    them: the citation is better left at `unresolved_abbr`, which is visible
    in reports_cit's top-unresolved list, than resolved to the wrong act,
    which is not visible anywhere. Ambiguity is per (jurisdiction, lang) and
    per SR number: two rows of the same act are one act, the same
    abbreviation in two languages is two independent aliases, and the same
    abbreviation in two CANTONS is two independent aliases too -- the
    resolver never offers a citation another canton's aliases, so "LPJA"
    being one act in BE and a different one in VS is not a collision.

    For a cantonal jurisdiction, the canton's abbreviation column (in the
    canton's primary language) is pooled into the same claim map as its
    title_paren candidates: within-canton duplicates are real (AG 26, ZG 27
    on prod, 2026-08-31), so unlike Fedlex's federal column these are
    subject to the ambiguity rule. When both sources claim the same
    (abbr, sr), the platform's own abbreviation column wins the source tag.
    """
    col = _TITLE_COLUMNS[lang]
    abbr_lang = (jurisdiction != "CH"
                 and _canton_abbr_lang(jurisdiction) == lang)
    abbr_col = ", abbreviation" if abbr_lang else ""
    rows = conn.execute(
        f"SELECT sr_number, {col} AS title{abbr_col} FROM ch_act "
        f"WHERE jurisdiction = %s AND sr_number IS NOT NULL "
        f"AND ({col} IS NOT NULL{' OR abbreviation IS NOT NULL' if abbr_lang else ''})",
        (jurisdiction,)).fetchall()

    # abbr -> {sr -> source}; 'cantonal_abbreviation' outranks 'title_paren'
    # for the same (abbr, sr) -- the platform's own assertion.
    claimed: dict[str, dict[str, str]] = {}
    for row in rows:
        candidates: list[tuple[str, str]] = []
        abbr = aliases_from_title(row["title"]) if row["title"] else None
        if abbr:
            candidates.append((abbr, "title_paren"))
        if abbr_lang and row["abbreviation"]:
            candidates.append((row["abbreviation"], "cantonal_abbreviation"))
        for abbr, source in candidates:
            srcs = claimed.setdefault(abbr, {})
            if (source == "cantonal_abbreviation"
                    or row["sr_number"] not in srcs):
                srcs[row["sr_number"]] = source

    ambiguous = sorted(a for a, srs in claimed.items() if len(srs) > 1)
    if ambiguous:
        log.info("aliases: %s title_paren abbreviations ambiguous in %s/%s, "
                 "not seeded: %s", len(ambiguous), jurisdiction, lang,
                 ", ".join(ambiguous[:20]))
    pairs = {(abbr, lang, sr, source, jurisdiction)
             for abbr, srs in claimed.items() if len(srs) == 1
             for sr, source in srs.items()}

    _reconcile(conn, jurisdiction, lang,
               {(abbr, sr) for abbr, _lang, sr, _source, _jur in pairs})

    if not pairs:
        return 0
    with conn.cursor() as cur:
        cur.executemany(_INSERT_ALIAS, sorted(pairs))
        return cur.rowcount


def _from_curated() -> list[tuple[str, str, str, str, str]]:
    rows = []
    for sr_number, langs in CURATED.items():
        for lang, abbrs in langs.items():
            for abbr in abbrs:
                rows.append((abbr, lang, sr_number, "curated", "CH"))
    return rows


def run(settings: Settings) -> AliasReport:
    report = AliasReport()
    conn = db.connect(settings)
    try:
        with conn.cursor() as cur:
            cur.execute(_RECONCILE_ABBREVIATION)
            if cur.rowcount:
                log.info("aliases: %s stale fedlex_abbreviation rows removed",
                         cur.rowcount)
            cur.execute(_FROM_ABBREVIATION)
            report.inserted += cur.rowcount

        jurisdictions = ["CH"] + [
            r["jurisdiction"] for r in conn.execute(
                "SELECT DISTINCT jurisdiction FROM ch_act "
                "WHERE jurisdiction <> 'CH' ORDER BY 1").fetchall()]
        for jurisdiction in jurisdictions:
            for lang in _TITLE_COLUMNS:
                report.inserted += _derived_for(conn, jurisdiction, lang)

        with conn.cursor() as cur:
            cur.executemany(_INSERT_ALIAS, _from_curated())
            report.inserted += cur.rowcount

        report.total = conn.execute(
            "SELECT count(*) AS n FROM ch_act_alias").fetchone()["n"]
    finally:
        conn.close()
    return report


def main() -> AliasReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py for the bug that shape already caused once
    (run-stage.sh's wrapper is the only way any stage is actually invoked
    on prod).

    nice 10 (throttle.NICE_IO): a handful of set-based queries and a short
    executemany over a table with thousands of rows, not a multi-hour CPU
    stage -- so it takes the same I/O priority as basic-act and as-bbl, not
    throttle.NICE_CPU. No wait_for_capacity(): the work is bounded by
    ch_act's own size and the curated map, not by this machine's cores.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("aliases inserted=%d total=%d", result.inserted, result.total)
    return result


if __name__ == "__main__":
    main()
