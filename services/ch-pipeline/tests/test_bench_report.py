"""chpipe.bench.report.summarise() / markdown(): pure aggregation over
already-scored result lines. No DB, no I/O.

test_bench_oracle.py covers the end-to-end path (build -> oracle -> report)
against a real database; this file covers the shapes summarise() has to get
right that an all-correct oracle run cannot exercise -- per-kind splits, the
gold_is_current split, error counting, and the resume dedupe.

The `--rescore`/main() tests at the bottom do touch the filesystem (tmp_path)
-- main() is a CLI entry point that reads results/items files and writes
report.json plus, under --rescore, a sibling `.rescored.jsonl` -- but stay
DB-free, same as the rest of this file.
"""
import json

from chpipe.bench import report


def _line(item_id, system="haiku-4-5", label="grounded_correct", lang="de",
          gold=1.0, distractor=0.0, **extra):
    line = {
        "id": item_id,
        "system": system,
        "lang": lang,
        "verdict": {
            "label": label,
            "gold_coverage": gold,
            "distractor_coverage": distractor,
            "shared_coverage": 0.5,
        },
    }
    line.update(extra)
    return line


def _item(item_id, kind="before", gold_is_current=False, lang="de"):
    return {"id": item_id, "lang": lang, "kind": kind,
            "gold_is_current": gold_is_current}


# --- per-kind grouping ------------------------------------------------------


def test_summarise_groups_by_kind_and_keeps_an_all_row():
    items = {
        "b1": _item("b1", kind="before"),
        "b2": _item("b2", kind="before"),
        "a1": _item("a1", kind="after"),
        "a2": _item("a2", kind="after"),
    }
    lines = [
        _line("b1", label="grounded_correct"),
        _line("b2", label="grounded_correct"),
        _line("a1", label="grounded_wrong_version", gold=0.0, distractor=1.0),
        _line("a2", label="ungrounded", gold=0.0, distractor=0.0),
    ]

    summary = report.summarise(lines, items)
    de = summary["de"]["haiku-4-5"]

    assert set(de) == {"all", "before", "after"}
    assert de["all"]["n"] == 4
    assert de["all"]["score"] == 0.5
    assert de["before"]["n"] == 2
    assert de["before"]["score"] == 1.0
    assert de["after"]["n"] == 2
    assert de["after"]["score"] == 0.0
    assert de["after"]["grounded_wrong_version"] == 1
    assert de["after"]["ungrounded"] == 1


def test_a_line_whose_item_is_unknown_lands_in_an_unknown_kind():
    lines = [_line("orphan")]
    summary = report.summarise(lines, {})
    de = summary["de"]["haiku-4-5"]
    assert de["all"]["n"] == 1
    assert de["unknown"]["n"] == 1


def test_summarise_items_by_id_defaults_to_empty():
    summary = report.summarise([_line("x")])
    assert summary["de"]["haiku-4-5"]["all"]["n"] == 1


# --- gold_is_current split --------------------------------------------------


def test_correct_share_is_split_by_gold_is_current():
    """An item whose gold edition is still the current wording can be
    answered correctly by a model that recites today's text and ignores the
    date; an item whose gold has been superseded cannot. The headline score
    must show both."""
    items = {
        "cur1": _item("cur1", kind="after", gold_is_current=True),
        "cur2": _item("cur2", kind="after", gold_is_current=True),
        "old1": _item("old1", kind="before", gold_is_current=False),
        "old2": _item("old2", kind="before", gold_is_current=False),
    }
    lines = [
        _line("cur1", label="grounded_correct"),
        _line("cur2", label="grounded_correct"),
        _line("old1", label="grounded_wrong_version", gold=0.0, distractor=1.0),
        _line("old2", label="grounded_correct"),
    ]

    stats = report.summarise(lines, items)["de"]["haiku-4-5"]["all"]

    assert stats["score"] == 0.75
    assert stats["n_gold_current"] == 2
    assert stats["correct_gold_current"] == 2
    assert stats["share_correct_gold_current"] == 1.0
    assert stats["n_gold_superseded"] == 2
    assert stats["correct_gold_superseded"] == 1
    assert stats["share_correct_gold_superseded"] == 0.5


def test_gold_is_current_split_ignores_lines_with_no_item():
    stats = report.summarise([_line("orphan")], {})["de"]["haiku-4-5"]["all"]
    assert stats["n_gold_current"] == 0
    assert stats["n_gold_superseded"] == 0
    assert stats["share_correct_gold_current"] == 0.0
    assert stats["share_correct_gold_superseded"] == 0.0


# --- errors -----------------------------------------------------------------


def test_errors_count_covers_both_error_and_oracle_error():
    items = {"i1": _item("i1"), "i2": _item("i2"), "i3": _item("i3")}
    lines = [
        _line("i1"),
        _line("i2", label="ungrounded", gold=0.0,
              error="ThrottlingException: too many requests"),
        _line("i3", system="oracle", label="ungrounded", gold=0.0,
              oracle_error="article_not_found"),
    ]
    summary = report.summarise(lines, items)
    assert summary["de"]["haiku-4-5"]["all"]["errors"] == 1
    assert summary["de"]["haiku-4-5"]["all"]["n"] == 2
    assert summary["de"]["oracle"]["all"]["errors"] == 1


# --- resume dedupe ----------------------------------------------------------


def test_a_re_asked_item_supersedes_its_earlier_errored_line():
    """run_llm re-asks an item that errored on a previous run and appends
    the new answer, so the results file holds two lines for that id. The
    later, error-free one wins, and the item is counted once."""
    items = {"i1": _item("i1")}
    lines = [
        _line("i1", label="ungrounded", gold=0.0, error="ThrottlingException: x"),
        _line("i1", label="grounded_correct"),
    ]
    stats = report.summarise(lines, items)["de"]["haiku-4-5"]["all"]
    assert stats["n"] == 1
    assert stats["errors"] == 0
    assert stats["grounded_correct"] == 1


def test_an_error_free_line_wins_even_when_the_error_came_last():
    items = {"i1": _item("i1")}
    lines = [
        _line("i1", label="grounded_correct"),
        _line("i1", label="ungrounded", gold=0.0, error="ThrottlingException: x"),
    ]
    stats = report.summarise(lines, items)["de"]["haiku-4-5"]["all"]
    assert stats["n"] == 1
    assert stats["errors"] == 0
    assert stats["grounded_correct"] == 1


def test_an_id_with_only_errored_lines_is_still_counted_once():
    items = {"i1": _item("i1")}
    lines = [
        _line("i1", label="ungrounded", gold=0.0, error="ThrottlingException: a"),
        _line("i1", label="ungrounded", gold=0.0, error="ThrottlingException: b"),
    ]
    stats = report.summarise(lines, items)["de"]["haiku-4-5"]["all"]
    assert stats["n"] == 1
    assert stats["errors"] == 1


def test_the_same_id_under_two_systems_is_not_deduped_across_them():
    items = {"i1": _item("i1")}
    lines = [_line("i1", system="oracle"), _line("i1", system="haiku-4-5")]
    summary = report.summarise(lines, items)
    assert summary["de"]["oracle"]["all"]["n"] == 1
    assert summary["de"]["haiku-4-5"]["all"]["n"] == 1


# --- markdown ---------------------------------------------------------------


def test_markdown_has_a_kind_column_and_an_all_row_per_lang_system():
    items = {
        "b1": _item("b1", kind="before"),
        "a1": _item("a1", kind="after"),
    }
    lines = [_line("b1"), _line("a1")]
    md = report.markdown(report.summarise(lines, items))
    rows = md.strip().splitlines()

    assert rows[0].startswith("| lang | system | kind |")
    # header + separator + all/after/before
    assert len(rows) == 5
    body = rows[2:]
    assert [r.split("|")[3].strip() for r in body] == ["all", "after", "before"]
    assert "errors" in rows[0]


# --- main() --rescore ---------------------------------------------------
#
# Same fixture shape as tests/test_bench_score.py's GOLD/DISTRACTOR: paragraph
# 1 unchanged, paragraphs 2/3 materially reworded, so score.score() reliably
# tells them apart once one is echoed back verbatim.

_GOLD_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts anderes "
    "vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung innerhalb von 180 Tagen "
    "gerichtlich anfechten."
)
_DISTRACTOR_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist richtet sich nach den Bestimmungen des "
    "Einzelarbeitsvertrags, sofern nichts anderes vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung nur durch eine schriftliche "
    "Klage beim zuständigen Gericht anfechten."
)

# Deliberately wrong: this is what a stale/buggy scorer run wrote to disk.
# The stored `answer` is GOLD_TEXT verbatim, which the current score()
# grades `grounded_correct` -- see test_bench_score.py's
# test_verbatim_gold_is_grounded_correct.
_WRONG_STORED_VERDICT = {
    "label": "ungrounded",
    "gold_coverage": 0.0,
    "distractor_coverage": 0.0,
    "shared_coverage": 0.0,
    "distractor_all_coverage": 0.0,
}


def _write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False))
            f.write("\n")


def _rescore_fixture(tmp_path):
    items_dir = tmp_path / "items"
    _write_jsonl(items_dir / "bench-de.jsonl", [{
        "id": "i1", "lang": "de", "kind": "after", "gold_is_current": False,
        "gold": {"text": _GOLD_TEXT},
        "distractor": {"text": _DISTRACTOR_TEXT},
    }])
    results_path = tmp_path / "results-haiku-4-5.jsonl"
    _write_jsonl(results_path, [{
        "id": "i1", "system": "haiku-4-5", "lang": "de",
        "answer": _GOLD_TEXT,
        "verdict": _WRONG_STORED_VERDICT,
    }])
    return items_dir, results_path


def test_rescore_uses_the_recomputed_verdict_for_the_summary(tmp_path):
    items_dir, results_path = _rescore_fixture(tmp_path)
    out_path = tmp_path / "report.json"

    summary = report.main([
        "--results", str(results_path),
        "--items", str(items_dir),
        "--out", str(out_path),
        "--rescore",
    ])

    stats = summary["de"]["haiku-4-5"]["all"]
    assert stats["grounded_correct"] == 1
    assert stats["score"] == 1.0


def test_without_rescore_the_wrong_stored_verdict_is_used(tmp_path):
    """Same fixture, no --rescore: the deliberately-wrong stored verdict
    drives the summary, proving the previous test's result comes from
    --rescore and not from score.score() disagreeing with the fixture by
    accident."""
    items_dir, results_path = _rescore_fixture(tmp_path)
    out_path = tmp_path / "report.json"

    summary = report.main([
        "--results", str(results_path),
        "--items", str(items_dir),
        "--out", str(out_path),
    ])

    stats = summary["de"]["haiku-4-5"]["all"]
    assert stats["grounded_correct"] == 0
    assert stats["ungrounded"] == 1


def test_rescore_writes_a_sibling_rescored_file_and_leaves_the_input_alone(tmp_path):
    items_dir, results_path = _rescore_fixture(tmp_path)
    out_path = tmp_path / "report.json"

    report.main([
        "--results", str(results_path),
        "--items", str(items_dir),
        "--out", str(out_path),
        "--rescore",
    ])

    rescored_path = tmp_path / "results-haiku-4-5.rescored.jsonl"
    assert rescored_path.exists()
    rescored_lines = [json.loads(line) for line in rescored_path.read_text().splitlines()]
    assert len(rescored_lines) == 1
    assert rescored_lines[0]["verdict"]["label"] == "grounded_correct"
    assert rescored_lines[0]["answer"] == _GOLD_TEXT  # everything else preserved

    # The original input file's stored (wrong) verdict is untouched.
    stored_lines = [json.loads(line) for line in results_path.read_text().splitlines()]
    assert stored_lines[0]["verdict"] == _WRONG_STORED_VERDICT
