"""The A/B comparison function (no DB) on the committed hard-wrap fixture."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import clean_text_ab as ab  # noqa: E402

FIX = pathlib.Path(__file__).parent / "fixtures" / "pdftext_decision_gr_hardwrap.txt"


def agg(**kw):
    base = {"n": 5, "errors": 0, "citations_before": 100, "citations_after": 100,
            "lost_total": 0, "quality_before": 0.8, "quality_after": 0.8}
    base.update(kw)
    return base


def doc(lost=0, **kw):
    d = {"doc_id": "x", "cases_before": 0, "cases_after": 0, "statutes_before": 0,
         "statutes_after": 0, "cases_lost": [], "statutes_lost": [("CO", str(i)) for i in range(lost)],
         "quality_before": 0.8, "quality_after": 0.8,
         "markers_before": {"glued_refs": 1}, "markers_after": {"glued_refs": 0}}
    d.update(kw)
    return d


def test_cleaning_loses_no_statutes_or_cases_on_fixture():
    raw = FIX.read_text(encoding="utf-8")
    d = ab.compare_text(raw, ["de"])
    assert d["statutes_before"] > 0
    assert d["statutes_lost"] == []
    assert d["cases_lost"] == []
    assert d["statutes_after"] >= d["statutes_before"]
    assert ab.verdict(ab.aggregate([d])) == []


def test_verdict_flags_citation_loss_with_reason():
    bad = ab.verdict(agg(citations_after=90))
    assert len(bad) == 1 and bad[0].startswith("citations 90 < 0.99 x 100")


def test_citation_boundary_exactly_099_passes():
    assert ab.verdict(agg(citations_after=99, lost_total=1)) == []
    assert ab.verdict(agg(citations_after=98, lost_total=2)) != []


def test_quality_drop_flagged():
    bad = ab.verdict(agg(quality_after=0.78))
    assert len(bad) == 1 and bad[0].startswith("mean quality")
    assert ab.verdict(agg(quality_after=0.795)) == []


def test_loss_masked_by_gain_is_caught():
    # net citations rise, but 10 keys vanished in some documents
    bad = ab.verdict(agg(citations_after=110, lost_total=10))
    assert len(bad) == 1 and bad[0].startswith("lost citation keys 10")


def test_empty_sample_fails():
    a = ab.aggregate([])
    assert a["n"] == 0
    assert any("empty sample" in r for r in ab.verdict(a))


def test_erroring_document_is_recorded_and_fails(monkeypatch):
    calls = []

    def fake(raw, langs):
        calls.append(raw)
        if raw == "boom":
            raise ValueError("bad")
        return doc()

    monkeypatch.setattr(ab, "compare_text", fake)
    docs, errors = ab.run([("a", "ok", ["de"]), ("b", "boom", ["de"]), ("c", "ok", ["de"])])
    assert [d["doc_id"] for d in docs] == ["a", "c"]
    assert errors == [{"doc_id": "b", "error": "ValueError: bad"}]
    a = ab.aggregate(docs, errors)
    assert a["errors"] == 1
    assert any("raised an error" in r for r in ab.verdict(a))


def test_worst_losses_ranked_by_lost_keys_not_net():
    big = doc(lost=3, statutes_before=5, statutes_after=9)   # net gain, 3 lost
    small = doc(lost=1, statutes_before=5, statutes_after=0)
    small["doc_id"] = "small"
    big["doc_id"] = "big"
    assert [d["doc_id"] for d in ab.worst_losses([small, big, doc()])] == ["big", "small"]
    assert ab.aggregate([small, big])["docs_with_loss"] == 2
