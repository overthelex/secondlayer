"""The fedlex_pdf clean-text gate (scripts/fedlex_clean_check.py): its
measure on the committed excerpts, and on the five prod raw samples of the
2026-11 pilot when that file is present (it is prod data, kept out of git:
.superpowers/sdd/fedlex-margins/raw_samples.json, or FEDLEX_RAW_SAMPLES)."""
import json
import os
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import fedlex_clean_check as check  # noqa: E402

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
EXCERPTS = {
    "de": FIXTURES / "pdftext_fedlex_schkg_281_1_de_margins.txt",
    "fr": FIXTURES / "pdftext_fedlex_schkg_281_1_fr_margins.txt",
    "fr-cst": FIXTURES / "pdftext_fedlex_cst_101_fr_fee_rows.txt",
}
SAMPLES = pathlib.Path(os.environ.get(
    "FEDLEX_RAW_SAMPLES",
    pathlib.Path(__file__).resolve().parents[3] / ".superpowers/sdd/fedlex-margins/raw_samples.json"))


def _samples():
    if not SAMPLES.is_file():
        return {}
    return json.loads(SAMPLES.read_text())


@pytest.mark.parametrize("name", sorted(EXCERPTS))
def test_excerpt_loses_no_words_and_keeps_its_length(name):
    lang = name.split("-")[0]
    result = check.measure_raw(EXCERPTS[name].read_text(), lang)
    # the brief's 2%: in a three-page excerpt one running-header word that
    # occurs nowhere else ("Poursuite") is already 0.5% of the types
    assert result["word_loss"] <= check.WORD_LOSS_P95_MAX, result["missing"]
    assert result["length_ratio"] >= check.LENGTH_RATIO_MIN


@pytest.mark.parametrize("version_id", ["560275", "560210", "560211", "560212", "560213"])
def test_pilot_sample_loses_no_words_and_keeps_its_length(version_id):
    samples = _samples()
    if version_id not in samples:
        pytest.skip("raw samples not present (prod data, not in git)")
    sample = samples[version_id]
    result = check.measure_raw(sample["raw"], sample["lang"])
    assert result["word_loss"] <= check.WORD_LOSS_MAX, result["missing"][:40]
    assert result["length_ratio"] >= check.LENGTH_RATIO_MIN


def test_pilot_schkg_art_9_has_no_marginal_fragment_mid_sentence():
    samples = _samples()
    if "560275" not in samples:
        pytest.skip("raw samples not present (prod data, not in git)")
    from chpipe.fedlex_split import clean_fedlex_text
    text = clean_fedlex_text(samples["560275"]["raw"], "de")
    assert "Art. 9 F. Aufbewahrung von Geld oder Wertsachen\n\n" in text
    assert "haben Geldsummen, Wertpapiere und Wertsachen, über welche" in text
    for line in text.split("\n"):
        assert "Wert- oder Wertsachen" not in line
        assert "Wertsachen papiere" not in line
        # the heading, or its line in the table of contents at the end
        assert ("rung von Geld" not in line or line.startswith("Art. 9 F. Aufbewah")
                or line.endswith("Wertsachen Art. 9"))
        assert "Zwangsvollstrebetreibung" not in line
        assert "Verwal-1. Im Zivilpro-" not in line


def test_raw_word_types_drop_wrap_hyphen_fragments():
    raw = ("F. Aufbewah-        Die Konkursämter haben Geldsummen, Wert-\n"
           "rung von Geld\n"
           "oder Wertsachen     papiere und Wertsachen.\n")
    types = check.raw_word_types(raw)
    assert "Aufbewah" not in types
    assert {"Konkursämter", "Geldsummen", "Wertsachen"} <= types
    # "papiere" is the tail of a break the raw cannot see (the margin line
    # sits between): counted, but found inside "Wertpapiere"
    clean = ("Art. 9 F. Aufbewahrung von Geld oder Wertsachen\n\nDie Konkursämter "
             "haben Geldsummen, Wertpapiere und Wertsachen.")
    assert check.measure(raw, clean)["missing"] == []


def test_measure_counts_missing_words_hyphens_and_glued_refs():
    raw = "Konkursämter verwahren Geldsummen und Wertsachen sorgfältig.\n"
    result = check.measure(raw, "Konkursämter verwahren Geld- summen15 und Wert-\nsachen.")
    assert result["missing"] == ["Geldsummen", "Wertsachen", "sorgfältig"]
    assert result["hyphen_breaks"] > 0 and result["glued_refs"] > 0
    clean = check.measure(raw, "Konkursämter verwahren Geldsummen und Wertsachen sorgfältig.")
    assert clean["word_loss"] == 0 and clean["hyphen_breaks"] == 0
    # a suspended compound is not a wrap hyphen
    assert check.measure(raw, "Betreibungs- und Konkursämter")["hyphen_breaks"] == 0


def test_summary_and_gate():
    results = {v: {"word_loss": 0.0, "length_ratio": 0.97, "hyphen_breaks": 0.0, "glued_refs": 0.0}
               for v in range(1, 21)}
    results[7].update(word_loss=0.05, length_ratio=0.8, hyphen_breaks=2.0, glued_refs=1.0)
    results[9]["word_loss"] = 0.004
    summary = check.summarise(results)
    assert summary["n"] == 20 and summary["worst"][:2] == [7, 9]
    assert summary["word_loss"]["median"] == 0.0 and summary["word_loss"]["max"] == 0.05
    assert summary["hyphen_share"] == pytest.approx(1 / 20)
    assert check.gate_ok(summary)
    # one broken edition in twenty reaches the p95
    results[8]["word_loss"] = 0.05
    assert not check.gate_ok(check.summarise(results))
    results[8]["word_loss"] = 0.0
    for v in range(1, 12):
        results[v]["length_ratio"] = 0.85      # the median of a footnote-less run
    assert not check.gate_ok(check.summarise(results))
    assert not check.gate_ok(check.summarise({}))


def test_main_refuses_without_dsn(monkeypatch, capsys):
    monkeypatch.delenv("CHPIPE_DSN", raising=False)
    assert check.main([]) == 2


def test_words_only_in_running_headers_are_not_counted():
    raw = ("747.224.131\nVerordnung\nüber die Schifffahrt\n\nArt. 1\nDer Bund regelt Schiffe.\n\n"
           "2\nRheinschifffahrt                                    747.224.131\n\n"
           "Art. 2\nDie Kantone vollziehen Vorschriften.\n\n"
           "Neutralität und Rheinschifffahrt                    12\n\n"
           "Art. 3\nDie Kantone melden Vorschriften.\n\n"
           "Neutralität und Rheinschifffahrt                    14\n")
    types = check.raw_word_types(raw)
    assert "Rheinschifffahrt" not in types and "Neutralität" not in types
    assert {"Verordnung", "Schifffahrt", "Kantone", "vollziehen"} <= types
    # a table row that occurs once is content, whatever its shape
    assert "Turquie" in check.raw_word_types("1\nX\n\nTurquie         12 juin     1907\n")
