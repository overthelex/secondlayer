"""The A/B comparison function (no DB) on the committed hard-wrap fixture."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import clean_text_ab as ab  # noqa: E402

FIX = pathlib.Path(__file__).parent / "fixtures" / "pdftext_decision_gr_hardwrap.txt"


def test_cleaning_loses_no_statutes_or_cases_on_fixture():
    raw = FIX.read_text(encoding="utf-8")
    d = ab.compare_text(raw, ["de"])
    assert d["statutes_before"] > 0
    assert d["statutes_lost"] == []
    assert d["cases_lost"] == []
    assert d["statutes_after"] >= d["statutes_before"]
    assert ab.verdict(ab.aggregate([d])) == []


def test_verdict_flags_citation_loss():
    agg = {"citations_before": 100, "citations_after": 90,
           "quality_before": 0.8, "quality_after": 0.8}
    assert ab.verdict(agg)
