"""The phase C gate (scripts/cantonal_resplit_check.py): its loss measure,
the gate thresholds, the JSONL mode end to end on committed excerpts, and
the 83-edition prod sample of the rolled-back run when that file is present
(prod data, kept out of git: PHASEC_SAMPLE=/path/phasec_sample.jsonl)."""
import json
import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import cantonal_resplit_check as check  # noqa: E402

from chpipe import pdf_text_legacy, text_clean  # noqa: E402

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
SAMPLE = os.environ.get("PHASEC_SAMPLE")


def _legacy_numbers(raw: str) -> list[str]:
    articles, _ = pdf_text_legacy.split_text(text_clean.normalise_chars(raw))
    return [a.article_number for a in articles]


def test_lost_numbers_multiset_and_letter_suffix():
    assert check.lost_numbers(["1", "2", "2"], ["1", "2"]) == ["2"]
    assert check.lost_numbers(["43"], ["43a"]) == []
    assert check.lost_numbers(["43a"], ["43"]) == ["43a"]


def test_measure_counts_a_lost_article_and_a_kept_row():
    raw = (FIXTURES / "pdftext_ai_270_000_citation_list.txt").read_text()
    ok = check.measure(raw, "de", ["48", "50"])
    assert ok["lost"] == [] and ok["same_sequence"] and not ok["kept"]
    lossy = check.measure(raw, "de", ["48", "49", "50"])
    assert lossy["lost"] == ["49"] and lossy["lost_share"] == pytest.approx(1 / 3)
    # nothing split from a row that has articles: the stage keeps it
    kept = check.measure("Kein Artikel hier, nur Text.\n", "de", ["1", "2"])
    assert kept["kept"] and kept["lost"] == []


def _summary(losing: int, n: int = 100, share: float = 0.01, before: int = 1000,
             after: int = 1000) -> dict:
    results = {}
    for v in range(n):
        lost = ["1"] if v < losing else []
        results[v] = {"before": 10, "after": 10, "same_sequence": not lost, "kept": False,
                      "lost": lost, "lost_share": share if lost else 0.0, "gained": 0}
    summary = check.summarise(results)
    summary["total_ratio"] = after / before
    return summary


def test_gate_thresholds():
    assert check.gate_ok(_summary(0))
    assert check.gate_ok(_summary(1, share=0.05))             # 1% losing, small loss
    assert not check.gate_ok(_summary(2))                       # 2% of editions lose
    assert not check.gate_ok(_summary(1, share=0.5))            # one edition loses half
    assert not check.gate_ok(_summary(0, after=990))            # 1% of the articles gone
    assert not check.gate_ok(check.summarise({}))


def _jsonl(tmp_path, rows) -> str:
    path = tmp_path / "sample.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return str(path)


def _row(version_id, source, name, lang, before=None):
    raw = (FIXTURES / name).read_text()
    numbers = _legacy_numbers(raw) if before is None else before
    return {"version_id": version_id, "source": source, "lang": lang, "raw": raw,
            "before": [{"n": n, "e_id": f"a-{n}", "note": None, "text": ""} for n in numbers]}


def test_jsonl_mode_passes_when_nothing_is_lost(tmp_path, capsys):
    path = _jsonl(tmp_path, [
        _row(1, "zhlex", "pdftext_zh_181_10_indented_headings.txt", "de"),
        _row(2, "lexwork_pdf", "pdftext_ai_270_000_citation_list.txt", "de"),
        _row(3, "lexfind", "pdftext_ne_414_110_21_left_column.txt", "fr"),
        {"version_id": 4, "source": "zhlex", "lang": "de", "raw": "<!DOCTYPE HTML>\n<html>",
         "before": [{"n": "1"}]},
    ])
    assert check.main(["--jsonl", path]) == 0
    out = capsys.readouterr().out
    assert "GATE PASS" in out and "skipped (akn_xml is HTML, never resplit): 1" in out


def test_jsonl_mode_fails_on_a_lost_article(tmp_path, capsys):
    path = _jsonl(tmp_path, [
        _row(1, "lexwork_pdf", "pdftext_ai_270_000_citation_list.txt", "de", ["48", "49", "50"]),
    ])
    assert check.main(["--jsonl", path, "--source", "lexwork_pdf"]) == 1
    assert "GATE FAIL" in capsys.readouterr().out


def test_usage_error_without_a_source(monkeypatch):
    monkeypatch.delenv("CHPIPE_DSN", raising=False)
    assert check.main([]) == 2


@pytest.mark.skipif(not SAMPLE or not pathlib.Path(SAMPLE).is_file(),
                    reason="PHASEC_SAMPLE (prod sample of the rolled-back run) not given")
def test_prod_sample_of_the_rolled_back_run_passes():
    assert check.main(["--jsonl", SAMPLE]) == 0
