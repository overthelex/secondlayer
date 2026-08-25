"""chpipe.bench.run_llm: sampling, the cost estimate, the CHPIPE_BENCH_CONFIRM
gate, and per-item scoring/error/retry handling -- all pure or driven by a
fake client, no boto3, no network, no database. See run_oracle.py's tests
(test_bench_oracle.py) for the DB-backed sibling; this module never touches
Postgres.
"""
from __future__ import annotations

import collections
import datetime
import json
import math

import pytest

from chpipe.bench import run_llm

# Same fixture text as test_bench_oracle.py / test_bench_build_db.py:
# paragraph 1 unchanged, paragraphs 2/3 materially reworded, so score.score()
# reliably tells GOLD_TEXT and DISTRACTOR_TEXT apart (grounded_correct vs.
# grounded_wrong_version) once one of them is echoed back verbatim.
GOLD_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts anderes "
    "vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung innerhalb von 180 Tagen "
    "gerichtlich anfechten."
)
DISTRACTOR_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist richtet sich nach den Bestimmungen des "
    "Einzelarbeitsvertrags, sofern nichts anderes vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung nur durch eine schriftliche "
    "Klage beim zuständigen Gericht anfechten."
)


def _item(item_id, lang="de", kind="before", question=None, gold=GOLD_TEXT,
         distractor=DISTRACTOR_TEXT):
    return {
        "id": item_id,
        "lang": lang,
        "sr_number": "220",
        "abbreviation": "OR",
        "article_number": "336",
        "e_id": "art_336",
        "as_of": "2020-12-31",
        "kind": kind,
        "change_date": "2021-01-01",
        "question": question if question is not None else f"question-{item_id}?",
        "gold": {"eli": "https://x/gold", "text": gold},
        "distractor": {"eli": "https://x/distractor", "text": distractor},
        "source": "fedlex",
        "licence": "CC0",
    }


def _write_items(items_dir, lang, items):
    items_dir.mkdir(parents=True, exist_ok=True)
    with (items_dir / f"bench-{lang}.jsonl").open("w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False))
            f.write("\n")


def _read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class FakeClient:
    """Answers keyed by the exact `question` text the item carries -- since
    every item's question is unique in these tests, that is enough to
    control per-item behaviour without threading the item id through
    `converse()`'s boto3-shaped signature.

    `raise_for`: {question: ExceptionInstanceOrClassCallable} -- raised on
    every call for that question (used for the "generic error" test).
    `throttle_for`: {question: n} -- the first N calls for that question
    raise a `ThrottlingException`-named error before succeeding (used for
    the retry test).
    """

    def __init__(self, answers=None, raise_for=None, throttle_for=None):
        self.answers = answers or {}
        self.raise_for = raise_for or {}
        self.throttle_for = dict(throttle_for or {})
        self.calls: list[str] = []

    def converse(self, modelId, system, messages, inferenceConfig):
        question = messages[0]["content"][0]["text"]
        self.calls.append(question)

        if question in self.raise_for:
            raise self.raise_for[question]

        remaining = self.throttle_for.get(question, 0)
        if remaining > 0:
            self.throttle_for[question] = remaining - 1
            raise type("ThrottlingException", (Exception,), {})("rate limited")

        text = self.answers.get(question, "")
        return {
            "output": {"message": {"content": [{"text": text}]}},
            "usage": {"inputTokens": 11, "outputTokens": 22},
        }


class NoCallClient:
    """Fails the test the moment `converse` is invoked -- proves the
    no-confirm path never touches the client at all."""

    def converse(self, *args, **kwargs):
        raise AssertionError("converse() must not be called without confirm=True")


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

def test_sample_items_is_deterministic_across_calls(tmp_path):
    items_dir = tmp_path / "items"
    items = (
        [_item(f"before-{i:02d}", kind="before") for i in range(20)]
        + [_item(f"after-{i:02d}", kind="after") for i in range(20)]
    )
    _write_items(items_dir, "de", items)

    first = run_llm.sample_items(items_dir, ("de",), sample_per_lang=10, seed=20260825)
    second = run_llm.sample_items(items_dir, ("de",), sample_per_lang=10, seed=20260825)

    assert [it["id"] for it in first] == [it["id"] for it in second]
    assert len(first) == 10


def test_sample_items_is_stratified_by_kind_roughly_balanced(tmp_path):
    items_dir = tmp_path / "items"
    items = (
        [_item(f"before-{i:02d}", kind="before") for i in range(20)]
        + [_item(f"after-{i:02d}", kind="after") for i in range(20)]
    )
    _write_items(items_dir, "de", items)

    sample = run_llm.sample_items(items_dir, ("de",), sample_per_lang=10, seed=20260825)
    counts = collections.Counter(it["kind"] for it in sample)

    assert counts == {"before": 5, "after": 5}


def test_sample_items_odd_sample_size_stays_within_one_of_balanced(tmp_path):
    items_dir = tmp_path / "items"
    items = (
        [_item(f"before-{i:02d}", kind="before") for i in range(20)]
        + [_item(f"after-{i:02d}", kind="after") for i in range(20)]
    )
    _write_items(items_dir, "de", items)

    sample = run_llm.sample_items(items_dir, ("de",), sample_per_lang=9, seed=20260825)
    counts = collections.Counter(it["kind"] for it in sample)

    assert sum(counts.values()) == 9
    assert abs(counts["before"] - counts["after"]) <= 1


def test_sample_items_caps_at_available_items(tmp_path):
    items_dir = tmp_path / "items"
    items = [_item("only-one", kind="before")]
    _write_items(items_dir, "de", items)

    sample = run_llm.sample_items(items_dir, ("de",), sample_per_lang=300, seed=20260825)

    assert len(sample) == 1


# ---------------------------------------------------------------------------
# Cost estimate
# ---------------------------------------------------------------------------

def test_estimate_matches_chars_over_four_token_approximation():
    question = "Q" * 7
    gold = "G" * 3
    items = [_item("i1", question=question, gold=gold, distractor="whatever")]

    result = run_llm.estimate(items, (run_llm.HAIKU,))

    expected_input_tokens = math.ceil((len(run_llm._SYSTEM_PROMPT) + len(question)) / 4)
    expected_output_tokens = math.ceil(len(gold) / 4) + 50
    price = run_llm._PRICES[run_llm.HAIKU]
    expected_usd = (expected_input_tokens / 1_000_000 * price["in"]
                    + expected_output_tokens / 1_000_000 * price["out"])

    assert result[run_llm.HAIKU]["items"] == 1
    assert result[run_llm.HAIKU]["input_tokens"] == expected_input_tokens
    assert result[run_llm.HAIKU]["output_tokens"] == expected_output_tokens
    assert result[run_llm.HAIKU]["usd"] == pytest.approx(expected_usd)
    assert result["total_usd"] == pytest.approx(expected_usd)


def test_estimate_sums_total_usd_across_models():
    items = [_item("i1", question="Q" * 40, gold="G" * 40, distractor="D" * 40)]

    result = run_llm.estimate(items, (run_llm.HAIKU, run_llm.SONNET))

    expected_total = result[run_llm.HAIKU]["usd"] + result[run_llm.SONNET]["usd"]
    assert result["total_usd"] == pytest.approx(expected_total)
    # Sonnet is priced strictly higher than Haiku for identical items.
    assert result[run_llm.SONNET]["usd"] > result[run_llm.HAIKU]["usd"]


# ---------------------------------------------------------------------------
# The confirm gate
# ---------------------------------------------------------------------------

def test_run_without_confirm_prints_estimate_and_never_calls_client(tmp_path, capsys):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    _write_items(items_dir, "de", [_item("i1"), _item("i2", kind="after")])

    client = NoCallClient()
    report = run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                         sample_per_lang=2, client=client, confirm=False)

    assert report.confirmed is False
    assert report.actual is None
    assert not out_dir.exists()

    printed = json.loads(capsys.readouterr().out.strip())
    assert run_llm.HAIKU in printed
    assert "total_usd" in printed


def test_main_returns_exit_code_2_without_confirm(tmp_path, monkeypatch, capsys):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    _write_items(items_dir, "de", [_item("i1"), _item("i2", kind="after")])
    monkeypatch.delenv("CHPIPE_BENCH_CONFIRM", raising=False)

    code = run_llm.main([
        "--items", str(items_dir), "--out", str(out_dir),
        "--langs", "de", "--models", run_llm.HAIKU, "--sample-per-lang", "2",
    ])

    assert code == 2
    capsys.readouterr()  # drain, not asserted on again


# ---------------------------------------------------------------------------
# The confirmed run: results, scoring, errors, retries
# ---------------------------------------------------------------------------

def test_confirmed_run_writes_one_scored_result_line_per_item(tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [
        _item("gold-1", kind="before", question="q-gold-1"),
        _item("gold-2", kind="after", question="q-gold-2"),
        _item("distractor-1", kind="before", question="q-distractor-1"),
        _item("distractor-2", kind="after", question="q-distractor-2"),
    ]
    _write_items(items_dir, "de", items)

    answers = {
        "q-gold-1": GOLD_TEXT, "q-gold-2": GOLD_TEXT,
        "q-distractor-1": DISTRACTOR_TEXT, "q-distractor-2": DISTRACTOR_TEXT,
    }
    client = FakeClient(answers=answers)
    now = datetime.datetime(2026, 8, 25, 12, 0, 0, tzinfo=datetime.timezone.utc)

    report = run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                         sample_per_lang=4, client=client, confirm=True, now=now)

    assert report.confirmed is True
    assert report.sample_size == 4

    results = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")
    assert len(results) == 4
    by_id = {r["id"]: r for r in results}

    for rid in ("gold-1", "gold-2"):
        r = by_id[rid]
        assert r["system"] == "haiku-4-5"
        assert r["model"] == run_llm.HAIKU
        assert r["lang"] == "de"
        assert r["answer"] == GOLD_TEXT
        assert r["input_tokens"] == 11
        assert r["output_tokens"] == 22
        assert isinstance(r["latency_s"], float)
        assert r["retries"] == 0
        assert "error" not in r
        assert r["verdict"]["label"] == "grounded_correct"

    for rid in ("distractor-1", "distractor-2"):
        r = by_id[rid]
        assert r["verdict"]["label"] == "grounded_wrong_version"
        assert "error" not in r

    report_json = json.loads((out_dir / "llm-run-report.json").read_text())
    assert report_json["started"] == run_llm._iso(now)
    assert report_json["finished"] == run_llm._iso(now)
    assert report_json["actual"][run_llm.HAIKU]["answered"] == 4
    assert report_json["actual"][run_llm.HAIKU]["errors"] == 0
    assert report_json["actual"][run_llm.HAIKU]["input_tokens"] == 44
    assert report_json["actual"][run_llm.HAIKU]["output_tokens"] == 88
    assert "estimate" in report_json


def test_generic_client_error_is_recorded_per_item_and_run_continues(tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [
        _item("ok-1", kind="before", question="q-ok-1"),
        _item("broken", kind="after", question="q-broken"),
    ]
    _write_items(items_dir, "de", items)

    client = FakeClient(
        answers={"q-ok-1": GOLD_TEXT},
        raise_for={"q-broken": ValueError("boom")},
    )

    report = run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                         sample_per_lang=2, client=client, confirm=True)

    assert report.confirmed is True
    results = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")
    assert len(results) == 2  # the run did not abort on the broken item

    by_id = {r["id"]: r for r in results}
    ok = by_id["ok-1"]
    assert "error" not in ok
    assert ok["verdict"]["label"] == "grounded_correct"

    broken = by_id["broken"]
    assert broken["answer"] == ""
    assert broken["error"] == "ValueError: boom"
    assert broken["verdict"]["label"] == "ungrounded"

    report_json = json.loads((out_dir / "llm-run-report.json").read_text())
    assert report_json["actual"][run_llm.HAIKU]["answered"] == 1
    assert report_json["actual"][run_llm.HAIKU]["errors"] == 1


def test_throttling_error_retries_then_succeeds(tmp_path, monkeypatch):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [_item("throttled", kind="before", question="q-throttled")]
    _write_items(items_dir, "de", items)

    sleeps: list[float] = []
    monkeypatch.setattr(run_llm.time, "sleep", lambda s: sleeps.append(s))

    client = FakeClient(
        answers={"q-throttled": GOLD_TEXT},
        throttle_for={"q-throttled": 2},
    )

    report = run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                         sample_per_lang=1, client=client, confirm=True)

    assert report.confirmed is True
    results = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")
    assert len(results) == 1
    result = results[0]

    assert "error" not in result
    assert result["answer"] == GOLD_TEXT
    assert result["verdict"]["label"] == "grounded_correct"
    assert result["retries"] == 2
    assert len(client.calls) == 3  # 2 throttled + 1 success
    assert sleeps == [1, 2]  # exponential backoff schedule, first two steps


def test_latency_excludes_backoff_sleep_time(tmp_path, monkeypatch):
    """A deterministic fake clock: `converse()` itself advances it by a
    fixed amount per call, `time.sleep()` advances it by the sleep
    duration. If backoff sleeps leaked into `latency_s`, the recorded
    latency for the throttled item below would include the 1s + 2s backoff
    (3.0s+); it must not.
    """
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [_item("throttled", kind="before", question="q-throttled")]
    _write_items(items_dir, "de", items)

    clock = {"t": 0.0}
    monkeypatch.setattr(run_llm.time, "monotonic", lambda: clock["t"])

    def fake_sleep(seconds):
        clock["t"] += seconds

    monkeypatch.setattr(run_llm.time, "sleep", fake_sleep)

    class SlowFakeClient(FakeClient):
        def converse(self, *args, **kwargs):
            clock["t"] += 0.01  # each converse() call "takes" 10ms
            return super().converse(*args, **kwargs)

    client = SlowFakeClient(answers={"q-throttled": GOLD_TEXT}, throttle_for={"q-throttled": 2})

    run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
               sample_per_lang=1, client=client, confirm=True)

    result = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")[0]
    assert result["retries"] == 2
    # 3 converse() calls x 10ms each; the 1s + 2s backoff sleeps (3.0s
    # total, visible in clock["t"] ending at 3.03) must not be counted.
    assert result["latency_s"] == pytest.approx(0.03)
    assert clock["t"] == pytest.approx(3.03)


# ---------------------------------------------------------------------------
# Crash safety and resumability
# ---------------------------------------------------------------------------

class CrashOnNthCallClient:
    """Answers normally until the Nth `converse()` call, then raises
    KeyboardInterrupt -- simulates a real crash (Ctrl-C, an OOM kill), which
    is not `Exception` and therefore not caught anywhere in
    `_answer_item`/`_call_with_retries`: it propagates straight out of
    run(), which is exactly the scenario the incremental, flush-per-line
    writes exist to survive.
    """

    def __init__(self, answers, crash_on_call):
        self.answers = answers
        self.crash_on_call = crash_on_call
        self.calls: list[str] = []

    def converse(self, modelId, system, messages, inferenceConfig):
        question = messages[0]["content"][0]["text"]
        self.calls.append(question)
        if len(self.calls) == self.crash_on_call:
            raise KeyboardInterrupt("simulated crash")
        return {
            "output": {"message": {"content": [{"text": self.answers[question]}]}},
            "usage": {"inputTokens": 5, "outputTokens": 5},
        }


def test_crash_on_third_item_leaves_two_lines_already_on_disk(tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [
        _item("i1", kind="before", question="q1"),
        _item("i2", kind="after", question="q2"),
        _item("i3", kind="before", question="q3"),
    ]
    _write_items(items_dir, "de", items)

    client = CrashOnNthCallClient(
        answers={"q1": GOLD_TEXT, "q2": GOLD_TEXT, "q3": GOLD_TEXT}, crash_on_call=3)

    with pytest.raises(KeyboardInterrupt):
        run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                   sample_per_lang=3, client=client, confirm=True)

    results = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")
    assert len(results) == 2
    assert {r["id"] for r in results} == {"i1", "i2"}


def test_rerun_after_crash_skips_done_items_and_only_calls_client_for_the_rest(tmp_path):
    items_dir = tmp_path / "items"
    out_dir = tmp_path / "out"
    items = [
        _item("i1", kind="before", question="q1"),
        _item("i2", kind="after", question="q2"),
        _item("i3", kind="before", question="q3"),
    ]
    _write_items(items_dir, "de", items)

    crashing_client = CrashOnNthCallClient(
        answers={"q1": GOLD_TEXT, "q2": GOLD_TEXT, "q3": GOLD_TEXT}, crash_on_call=3)
    with pytest.raises(KeyboardInterrupt):
        run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                   sample_per_lang=3, client=crashing_client, confirm=True)

    resume_client = FakeClient(answers={"q3": GOLD_TEXT})
    report = run_llm.run(items_dir, out_dir, langs=("de",), models=(run_llm.HAIKU,),
                         sample_per_lang=3, client=resume_client, confirm=True)

    assert report.confirmed is True
    assert resume_client.calls == ["q3"]  # only the un-answered item was asked

    results = _read_jsonl(out_dir / "results-llm-haiku-4-5.jsonl")
    assert len(results) == 3
    assert {r["id"] for r in results} == {"i1", "i2", "i3"}

    report_json = json.loads((out_dir / "llm-run-report.json").read_text())
    assert report_json["actual"][run_llm.HAIKU]["answered"] == 3
    assert report_json["actual"][run_llm.HAIKU]["errors"] == 0
