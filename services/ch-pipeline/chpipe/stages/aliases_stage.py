"""Seeds ch_act_alias (migration 199) from three sources, all additive and
idempotent:

  fedlex_abbreviation  ch_act.abbreviation, the German abbreviation Fedlex
                       supplies directly on the act ("OR", "ZGB"). German
                       only -- Fedlex does not carry an fr/it equivalent
                       column (acts_stage writes only the German titleShort).

  title_paren          the abbreviation Fedlex puts in parentheses at the
                       end of title_de/title_fr/title_it, via
                       ch_aliases.aliases_from_title(). Covers most acts and
                       needs no maintenance as Fedlex adds new ones.

  curated               ch_aliases.CURATED, hand-maintained for the acts
                       whose title carries no parenthesised abbreviation at
                       all (the big codes: OR, ZGB, StGB, Cst. ...). Seeded
                       unconditionally, independent of what ch_act happens
                       to hold -- see ch_aliases.py's own docstring.

Every insert is `ON CONFLICT DO NOTHING` on (abbr, lang, sr_number), so
re-running this stage after ch_act gains new acts, or after CURATED grows,
costs nothing beyond what actually changed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, throttle
from ..ch_aliases import CURATED, aliases_from_title
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class AliasReport:
    inserted: int = 0
    total: int = 0


_FROM_ABBREVIATION = """
INSERT INTO ch_act_alias (abbr, lang, sr_number, source)
SELECT abbreviation, 'de', sr_number, 'fedlex_abbreviation'
  FROM ch_act
 WHERE abbreviation IS NOT NULL AND abbreviation <> '' AND sr_number IS NOT NULL
ON CONFLICT DO NOTHING
"""

# lang -> the ch_act column that carries that language's title.
_TITLE_COLUMNS = {"de": "title_de", "fr": "title_fr", "it": "title_it"}

_INSERT_ALIAS = """
INSERT INTO ch_act_alias (abbr, lang, sr_number, source)
VALUES (%s, %s, %s, %s)
ON CONFLICT DO NOTHING
"""


def _from_titles(conn, lang: str) -> int:
    """One language's title-parenthesis pass. A Python loop over the rows,
    not a SQL regexp: aliases_from_title() is already the tested source of
    truth for what counts as a trailing abbreviation (and what doesn't --
    a bare date in parentheses, no comma, no match), so re-deriving that
    logic in SQL would be a second implementation to keep in sync with the
    first.

    **An abbreviation two different acts both claim is not seeded at all.**
    "(KV)" ends the title of every cantonal constitution filed under SR
    131.xxx, so seeding it maps one abbreviation onto 26 acts -- and a Uri
    court's "Art. 12 KV" then resolves to whichever of them
    citations-resolve's ranking happens to reach first (it resolved to
    Appenzell's). An alias that names 26 acts identifies none of them: the
    citation is better left at `unresolved_abbr`, which is visible in
    reports_cit's top-unresolved list, than resolved to the wrong act, which
    is not visible anywhere. Ambiguity is per (abbr, lang) and per SR number:
    two rows of the same act are one act, and the same abbreviation in two
    languages is two independent aliases. The other two sources are
    unaffected -- `curated` is hand-checked and `fedlex_abbreviation` is
    Fedlex's own assertion about one act.
    """
    col = _TITLE_COLUMNS[lang]
    rows = conn.execute(
        f"SELECT sr_number, {col} AS title FROM ch_act "
        f"WHERE {col} IS NOT NULL AND sr_number IS NOT NULL").fetchall()
    claimed: dict[str, set[str]] = {}
    for row in rows:
        abbr = aliases_from_title(row["title"])
        if abbr:
            claimed.setdefault(abbr, set()).add(row["sr_number"])
    ambiguous = sorted(a for a, srs in claimed.items() if len(srs) > 1)
    if ambiguous:
        log.info("aliases: %s title_paren abbreviations ambiguous in %s, "
                 "not seeded: %s", len(ambiguous), lang,
                 ", ".join(ambiguous[:20]))
    pairs = {(abbr, lang, next(iter(srs)), "title_paren")
             for abbr, srs in claimed.items() if len(srs) == 1}

    # Reconcile: a title_paren row an earlier run inserted can go stale in
    # two ways a later ch_act load exposes -- the abbreviation it named
    # becomes ambiguous (a second act now claims it too), or the act's title
    # changed and no longer carries that abbreviation at all. `ON CONFLICT
    # DO NOTHING` below only guards against re-inserting a duplicate; it
    # never removes a row this pass would not (re-)seed, so without this a
    # stale alias sits in `ch_act_alias` forever and citations keep
    # resolving to the act that no longer uniquely owns it. `curated` and
    # `fedlex_abbreviation` rows are untouched -- this only ever deletes
    # `title_paren` rows for the language just computed.
    existing = conn.execute(
        "SELECT abbr, sr_number FROM ch_act_alias "
        "WHERE lang = %s AND source = 'title_paren'", (lang,)).fetchall()
    target = {(abbr, sr) for abbr, _lang, sr, _source in pairs}
    stale = {(r["abbr"], r["sr_number"]) for r in existing} - target
    if stale:
        with conn.cursor() as cur:
            cur.executemany(
                "DELETE FROM ch_act_alias WHERE abbr = %s AND lang = %s "
                "AND sr_number = %s AND source = 'title_paren'",
                sorted((abbr, lang, sr) for abbr, sr in stale))
        log.info("aliases: %s stale title_paren rows removed in %s",
                 len(stale), lang)

    if not pairs:
        return 0
    with conn.cursor() as cur:
        cur.executemany(_INSERT_ALIAS, sorted(pairs))
        return cur.rowcount


def _from_curated() -> list[tuple[str, str, str, str]]:
    rows = []
    for sr_number, langs in CURATED.items():
        for lang, abbrs in langs.items():
            for abbr in abbrs:
                rows.append((abbr, lang, sr_number, "curated"))
    return rows


def run(settings: Settings) -> AliasReport:
    report = AliasReport()
    conn = db.connect(settings)
    try:
        with conn.cursor() as cur:
            cur.execute(_FROM_ABBREVIATION)
            report.inserted += cur.rowcount

        for lang in _TITLE_COLUMNS:
            report.inserted += _from_titles(conn, lang)

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
    executemany over a table with dozens of rows, not a multi-hour CPU
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
