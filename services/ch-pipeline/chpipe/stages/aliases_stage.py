"""Seeds ch_act_alias (migration 199) from three sources, all additive and
idempotent:

  fedlex_abbreviation  ch_act.abbreviation, the German abbreviation Fedlex
                       supplies directly on the act ("OR", "ZGB"). German
                       only -- Fedlex does not carry an fr/it equivalent
                       column, see the migration 197 note on that column.

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
 WHERE abbreviation IS NOT NULL AND sr_number IS NOT NULL
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
    """
    col = _TITLE_COLUMNS[lang]
    rows = conn.execute(
        f"SELECT sr_number, {col} AS title FROM ch_act "
        f"WHERE {col} IS NOT NULL AND sr_number IS NOT NULL").fetchall()
    pairs = set()
    for row in rows:
        abbr = aliases_from_title(row["title"])
        if abbr:
            pairs.add((abbr, lang, row["sr_number"], "title_paren"))
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
