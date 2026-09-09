"""scripts/echr_export_subset.py: the slice rule and the text rule."""
import gzip
import importlib.util
import json
import pathlib

SCRIPT = pathlib.Path(__file__).parent.parent / "scripts" / "echr_export_subset.py"
spec = importlib.util.spec_from_file_location("echr_export_subset", SCRIPT)
exp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exp)


def _meta(itemid, **kw):
    base = {"itemid": itemid, "appno": "1/01", "docname": "CASE OF X v. Y", "doctype": "HEJUD",
            "documentcollectionid2": "CASELAW;JUDGMENTS;CHAMBER;ENG", "importance": "4",
            "respondent": "TUR", "languageisocode": "ENG", "kpdate": "2010-06-29T00:00:00",
            "isplaceholder": "False"}
    base.update(kw)
    return base


def test_why_selects_swiss_respondents_and_leading_chamber_judgments():
    assert exp.why(_meta("a", respondent="CHE"), "CHE") == "respondent"
    assert exp.why(_meta("b", respondent="ITA;CHE", doctype="HFDEC", importance="4"), "CHE") == "respondent"
    assert exp.why(_meta("c", importance="1"), "CHE") == "importance"
    assert exp.why(_meta("d", importance="3", documentcollectionid2="CASELAW;JUDGMENTS;GRANDCHAMBER;FRE", doctype="HFJUD", languageisocode="FRE"), "CHE") == "importance"
    # a translation of a leading judgment is not a leading case on its own (it comes in only as a Swiss respondent's)
    assert exp.why(_meta("d2", importance="1", doctype="HJUDGER", documentcollectionid2="CASELAW;JUDGMENTS;CHAMBER;GER", languageisocode="GER"), "CHE") is None
    assert exp.why(_meta("d3", importance="1", doctype="HJUDGER", documentcollectionid2="CASELAW;JUDGMENTS;CHAMBER;GER", languageisocode="GER", respondent="CHE"), "CHE") == "respondent"
    # importance 4, a committee judgment, a decision of importance 1: not leading
    assert exp.why(_meta("e", importance="4"), "CHE") is None
    assert exp.why(_meta("f", importance="1", documentcollectionid2="CASELAW;JUDGMENTS;COMMITTEE;ENG"), "CHE") is None
    assert exp.why(_meta("g", importance="1", doctype="HEDEC", documentcollectionid2="CASELAW;DECISIONS;CHAMBER;ENG"), "CHE") is None
    # "CHE" must be a whole respondent code, not a substring
    assert exp.why(_meta("h", respondent="CHECHNYA"), "CHE") is None


def test_export_writes_the_slice_with_texts_and_counts(tmp_path):
    harvest = tmp_path / "all"
    (harvest / "meta").mkdir(parents=True)
    (harvest / "txt").mkdir()
    rows = [_meta("001-1", respondent="CHE"), _meta("001-2", importance="2"), _meta("001-3"),
            _meta("001-4", respondent="CHE", doctype="HFDEC"), _meta("001-1")]     # the last: a duplicate
    (harvest / "meta" / "metadata-ALL.ndjson").write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n")
    (harvest / "txt" / "001-1.txt").write_text("PROCEDURE\n" + "The applicant complained. " * 40)
    (harvest / "txt" / "001-4.txt").write_text("stub")
    out = tmp_path / "slice.ndjson.gz"
    counts = exp.export(harvest, out, "CHE", min_text_bytes=500)
    assert counts["rows"] == 3 and counts["respondent"] == 2 and counts["importance"] == 1
    assert counts["with_text"] == 1 and counts["text_too_short"] == 1 and counts["no_text"] == 1
    assert counts["bad_json"] == 1 and counts["dup_or_no_itemid"] == 1
    got = [json.loads(l) for l in gzip.open(out, "rt", encoding="utf-8")]
    by = {g["meta"]["itemid"]: g for g in got}
    assert by["001-1"]["full_text"].startswith("PROCEDURE") and by["001-1"]["why"] == "respondent"
    assert by["001-4"]["full_text"] is None and by["001-4"]["text_bytes"] == 4
    assert by["001-2"]["full_text"] is None and by["001-2"]["why"] == "importance"


def test_min_text_bytes_zero_still_treats_a_missing_file_as_no_text(tmp_path):
    harvest = tmp_path / "all"
    (harvest / "meta").mkdir(parents=True)
    (harvest / "txt").mkdir()
    (harvest / "meta" / "metadata-ALL.ndjson").write_text(json.dumps(_meta("001-9", respondent="CHE")) + "\n")
    counts = exp.export(harvest, tmp_path / "s.gz", "CHE", min_text_bytes=0)
    assert counts["rows"] == 1 and counts["no_text"] == 1
