"""The `core` subset: a small, fixed, stratified sample of one language's
benchmark items that every published baseline is run on.

Why a subset at all: the full build is 5,000 items per language, and the
only cost the scorer has is the LLM calls a baseline makes. Without a
fixed subset every reproduction picks its own 300 or 900 items and the
numbers stop being comparable. `core` is the one sample everyone runs.

Why stratified: the full build's `as_of` dates follow Fedlex's XML
history (almost everything 2021 onward), and roughly half the items have
a still-current gold edition, which a system can answer by reciting
today's text. A uniform sample would inherit both skews. `core` takes an
equal share per `as_of` year, and within a year fills the four
(kind, gold_is_current) cells round-robin, so `before`/`after` and
current/superseded are each as close to 50/50 as the year's pool allows.
A year too thin to fill its share (2011 has a handful of items) keeps
what it has and the shortfall is filled from the other years, again
round-robin, so the total is always min(per_lang, len(items)).

Pure: (items, per_lang, rng) in, (core_items, report) out. The caller
seeds the RNG per language (build.py uses random.Random(f"{seed}:{lang}:core"))
so a language's core depends only on its own items and seed.
"""
from __future__ import annotations

import random
from typing import Any, Mapping

_CELLS: tuple[tuple[str, bool], ...] = (
    ("before", False),
    ("after", False),
    ("before", True),
    ("after", True),
)


def _year(item: Mapping[str, Any]) -> str:
    return str(item["as_of"])[:4]


def select_core(items: list[Mapping[str, Any]], per_lang: int,
                rng: random.Random) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (core_items sorted by id, report).

    REPORT: {"items": n, "per_year": {year: n}, "per_cell": {"kind/current": n}}.
    """
    # Deterministic regardless of input order: sort by id, then shuffle
    # each cell with the caller's RNG.
    pools: dict[str, dict[tuple[str, bool], list[dict[str, Any]]]] = {}
    for item in sorted(items, key=lambda it: it["id"]):
        cell = (item["kind"], bool(item["gold_is_current"]))
        pools.setdefault(_year(item), {}).setdefault(cell, []).append(dict(item))
    years = sorted(pools)
    for year in years:
        for cell in _CELLS:
            if cell in pools[year]:
                rng.shuffle(pools[year][cell])

    total_available = sum(len(v) for y in pools.values() for v in y.values())
    target_total = min(per_lang, total_available)

    def _take(year: str, start_cell: int) -> tuple[dict[str, Any] | None, int]:
        """Pop one item from YEAR, trying cells round-robin from START_CELL."""
        for offset in range(len(_CELLS)):
            cell = _CELLS[(start_cell + offset) % len(_CELLS)]
            bucket = pools[year].get(cell)
            if bucket:
                return bucket.pop(), (start_cell + offset + 1) % len(_CELLS)
        return None, start_cell

    chosen: list[dict[str, Any]] = []
    cursor: dict[str, int] = {year: 0 for year in years}

    # Pass 1: an equal share per year (remainder to the earliest years).
    if years:
        share, rem = divmod(target_total, len(years))
        for index, year in enumerate(years):
            want = share + (1 if index < rem else 0)
            for _ in range(want):
                item, cursor[year] = _take(year, cursor[year])
                if item is None:
                    break
                chosen.append(item)

    # Pass 2: fill any shortfall round-robin over the years that still
    # have items, one at a time.
    while len(chosen) < target_total:
        progressed = False
        for year in years:
            if len(chosen) >= target_total:
                break
            item, cursor[year] = _take(year, cursor[year])
            if item is not None:
                chosen.append(item)
                progressed = True
        if not progressed:
            break

    chosen.sort(key=lambda it: it["id"])
    per_year: dict[str, int] = {}
    per_cell: dict[str, int] = {}
    for item in chosen:
        per_year[_year(item)] = per_year.get(_year(item), 0) + 1
        key = f"{item['kind']}/{'current' if item['gold_is_current'] else 'superseded'}"
        per_cell[key] = per_cell.get(key, 0) + 1
    report = {"items": len(chosen), "per_year": per_year, "per_cell": per_cell}
    return chosen, report
