"""Tests for chpipe.bench.core_split: the deterministic, stratified `core`
subset of one language's items. Pure, no DB."""
import random

from chpipe.bench import core_split


def _item(i: int, year: int, kind: str, current: bool) -> dict:
    return {
        "id": f"{i:06d}",
        "lang": "de",
        "as_of": f"{year}-06-01",
        "kind": kind,
        "gold_is_current": current,
    }


def _pool() -> list[dict]:
    """Years 2021-2024, every (kind, gold_is_current) cell 30 deep, plus a
    thin 2011 with only 3 `before`/superseded items."""
    items = []
    i = 0
    for year in (2021, 2022, 2023, 2024):
        for kind in ("before", "after"):
            for current in (False, True):
                for _ in range(30):
                    items.append(_item(i, year, kind, current)); i += 1
    for _ in range(3):
        items.append(_item(i, 2011, "before", False)); i += 1
    return items


def test_select_core_is_deterministic_and_a_subset():
    pool = _pool()
    a, _ = core_split.select_core(pool, per_lang=100, rng=random.Random("s"))
    b, _ = core_split.select_core(list(reversed(pool)), per_lang=100, rng=random.Random("s"))
    assert [x["id"] for x in a] == [x["id"] for x in b]
    ids = {x["id"] for x in pool}
    assert all(x["id"] in ids for x in a)
    assert len({x["id"] for x in a}) == 100


def test_select_core_balances_years_then_cells():
    pool = _pool()
    core, report = core_split.select_core(pool, per_lang=100, rng=random.Random(1))
    per_year = report["per_year"]
    # 5 years present -> 20 each; 2011 only has 3, its shortfall is filled
    # from the other years (100 total still).
    assert per_year["2011"] == 3
    assert sum(per_year.values()) == 100
    assert max(per_year[y] for y in ("2021", "2022", "2023", "2024")) - \
        min(per_year[y] for y in ("2021", "2022", "2023", "2024")) <= 1
    # within a full year the four cells are round-robin filled, so the
    # kind and gold_is_current splits are each within one of half
    y21 = [x for x in core if x["as_of"].startswith("2021")]
    n_before = sum(1 for x in y21 if x["kind"] == "before")
    n_current = sum(1 for x in y21 if x["gold_is_current"])
    assert abs(n_before - len(y21) / 2) <= 1
    assert abs(n_current - len(y21) / 2) <= 1


def test_select_core_returns_everything_when_the_pool_is_small():
    pool = _pool()[:7]
    core, report = core_split.select_core(pool, per_lang=100, rng=random.Random(0))
    assert len(core) == 7 and report["items"] == 7


def test_select_core_output_is_sorted_by_id():
    core, _ = core_split.select_core(_pool(), per_lang=50, rng=random.Random(0))
    assert [x["id"] for x in core] == sorted(x["id"] for x in core)
