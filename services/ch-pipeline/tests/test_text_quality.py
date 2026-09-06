import pathlib
import random

import pytest

from chpipe import text_quality

GOOD_DE = (
    "Das Bundesgericht hat in der Beschwerde des Beschwerdeführers gegen das "
    "Urteil des Obergerichts des Kantons Zug entschieden, dass die Beschwerde "
    "abzuweisen ist, soweit darauf einzutreten ist. Die Gerichtskosten werden "
    "dem Beschwerdeführer auferlegt. "
) * 6


def test_clean_german_scores_high():
    assert text_quality.score(GOOD_DE, ["de"]) > 0.7


def test_a_scrambled_text_layer_scores_low():
    """The failure mode this exists to catch: a PDF whose text layer is present
    but shredded into character soup."""
    junk = "B u n d e s g e r i c h t U r t e i l " * 40
    assert text_quality.score(junk, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_replacement_characters_drag_the_score_down():
    broken = GOOD_DE.replace("e", "�")
    assert text_quality.score(broken, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_a_page_of_digits_and_punctuation_scores_low():
    assert text_quality.score("12.3 45,6 78/9 " * 100, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_zero_content_noise_does_not_reach_the_accept_band():
    """300 random six-letter tokens are all-alpha, land exactly on the
    mean_word_length peak, and contain no U+FFFD or control characters — every
    component except dictionary_hit_rate maxes out, yet there isn't a single
    real word in it. Before the MIN_RAW_HIT_RATE floor this landed EXACTLY on
    ACCEPT_THRESHOLD (0.55); tidiness alone must not buy acceptance."""
    rng = random.Random(42)
    letters = "abcdefghijklmnopqrstuvwxyz"
    noise = " ".join("".join(rng.choice(letters) for _ in range(6)) for _ in range(300))
    assert text_quality.score(noise, ["de"]) <= text_quality.NO_DICTIONARY_SCORE_CAP


def test_a_question_mark_glyph_failure_scores_well_below_threshold():
    """A broken font CMap that renders every missing glyph as a literal "?"
    must not slip through replacement_ratio, which used to catch only U+FFFD
    and control characters and let this case land at 0.5585 — just above
    ACCEPT_THRESHOLD (0.55)."""
    broken = GOOD_DE.replace("e", "?")
    assert text_quality.score(broken, ["de"]) < text_quality.ACCEPT_THRESHOLD - 0.1


def test_empty_text_scores_zero():
    assert text_quality.score("", ["de"]) == 0.0


def test_a_very_short_text_scores_zero():
    """A two-word extraction is an empty scan, not a decision."""
    assert text_quality.score("Urteil vom", ["de"]) == 0.0


def test_french_is_scored_against_the_french_list():
    fr = ("Le Tribunal fédéral a rejeté le recours du recourant contre "
          "l arrêt de la Cour de justice du canton de Genève. ") * 8
    assert text_quality.score(fr, ["fr"]) > text_quality.score(fr, ["de"])


def test_an_unknown_language_falls_back_to_all_lists():
    assert text_quality.score(GOOD_DE, []) > 0.5


def test_breakdown_exposes_every_component():
    b = text_quality.breakdown(GOOD_DE, ["de"])
    assert set(b) == {"alpha_ratio", "mean_word_length", "dictionary_hit_rate",
                      "replacement_ratio", "mojibake_density", "score"}


# --- Mojibake guard: UTF-8 read as Latin-1 ---
#
# This is the exact damage that put 165,363 CH_BGer rows into this pipeline,
# and not one of the four weighted components can see it: mojibake is
# all-alpha, correctly word-lengthed, and contains no U+FFFD, no Cc and no
# "?", so it maxes every component the score measures. Measured on the real
# fixtures, mojibake scored HIGHER than the clean original (0.9850 vs
# 0.9820). Against the pre-fix code every assertion below fails.

FIXTURE_HTML = pathlib.Path(__file__).parent / "fixtures" / "decision_ch_bge.html"

# Legitimate French all-caps, which is the known false positive for a bare
# "Â" test: measured 24 bare "Â" in 2,568 characters and zero marker pairs.
LEGIT_FR = (
    "ARRÊT DE LA COUR DE JUSTICE. LIMITE D'ÂGE DES MAGISTRATS. "
    "Le recourant, âgé de soixante-cinq ans, conteste la décision du "
    "Conseil d'État relative à l'ÂGE de la retraite et à la nature de "
    "l'intérêt public en cause. "
) * 12

LEGIT_IT = (
    "LA CORTE D'APPELLO. Il ricorrente è stato condannato perché la "
    "società non ha più diritto all'indennità prevista dalla legge. "
) * 20


def _as_mojibake(text: str) -> str:
    """Exactly the corruption in the 165,363 rows: UTF-8 bytes read as Latin-1."""
    return text.encode("utf-8").decode("latin-1")


def test_clean_german_has_no_mojibake_markers():
    assert text_quality.mojibake_density(GOOD_DE) == 0.0
    assert text_quality.is_mojibake(GOOD_DE) is False


def test_legitimate_french_all_caps_age_is_not_flagged():
    """The known false positive. "ÂGE" puts a bare "Â" into perfectly good
    French, which is why the migration's bare-marker LIKE is not enough on
    its own: measured 24 bare "Â" here, and zero marker pairs."""
    assert LEGIT_FR.count("Â") >= 20, "the false-positive case must actually be present"
    assert text_quality.mojibake_density(LEGIT_FR) == 0.0
    assert text_quality.is_mojibake(LEGIT_FR) is False
    assert text_quality.score(LEGIT_FR, ["fr"]) > text_quality.ACCEPT_THRESHOLD


def test_legitimate_italian_is_not_flagged():
    assert text_quality.is_mojibake(LEGIT_IT) is False
    assert text_quality.score(LEGIT_IT, ["it"]) > text_quality.ACCEPT_THRESHOLD


def test_mojibake_german_is_detected_and_refused():
    damaged = _as_mojibake(GOOD_DE)
    assert "BeschwerdefÃ¼hrer" in damaged
    assert text_quality.is_mojibake(damaged) is True
    assert text_quality.score(damaged, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_mojibake_french_is_detected_and_refused():
    damaged = _as_mojibake(LEGIT_FR)
    assert text_quality.is_mojibake(damaged) is True
    assert text_quality.score(damaged, ["fr"]) < text_quality.ACCEPT_THRESHOLD


def test_a_single_stray_marker_pair_is_not_enough_to_condemn_a_document():
    """MOJIBAKE_MIN_MARKERS. One pair in a long clean document is noise, not
    a systematically mis-decoded body."""
    stray = GOOD_DE + "Ã©"
    assert text_quality.is_mojibake(stray) is False


@pytest.mark.skipif(not FIXTURE_HTML.exists(),
                    reason="decision_ch_bge.html fixture not captured")
def test_the_real_fixture_scores_high_clean_and_is_refused_as_mojibake():
    """The measurement that justifies the guard, on a real document: clean
    0.9820, mojibake 0.9850 -- the corrupted version scored HIGHER. Without
    the guard the threshold cannot tell them apart in either direction."""
    from lxml import html as lxml_html
    clean = lxml_html.fromstring(
        FIXTURE_HTML.read_bytes(),
        parser=lxml_html.HTMLParser(encoding="utf-8")).text_content()
    damaged = _as_mojibake(clean)

    assert text_quality.score(clean, ["de"]) > text_quality.ACCEPT_THRESHOLD
    assert text_quality.mojibake_density(clean) == 0.0
    assert text_quality.mojibake_density(damaged) > text_quality.MOJIBAKE_DENSITY
    assert text_quality.score(damaged, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_a_french_text_labelled_german_is_relabelled_not_retired():
    # ElCom lists its French decisions on the German page: label de, words fr
    assert text_quality.score(LEGIT_FR, ["de"]) <= text_quality.NO_DICTIONARY_SCORE_CAP
    quality, relabel = text_quality.score_with_relabel(LEGIT_FR, ["de"])
    assert quality > text_quality.ACCEPT_THRESHOLD and relabel == ["fr"]
    quality, relabel = text_quality.score_with_relabel(LEGIT_IT, ["de"])
    assert quality > text_quality.ACCEPT_THRESHOLD and relabel == ["it"]


def test_relabel_leaves_a_text_that_passes_under_its_own_label_alone():
    assert text_quality.score_with_relabel(GOOD_DE, ["de"])[1] is None
    assert text_quality.score_with_relabel(GOOD_DE, [])[1] is None          # unlabelled: all lists already
    # noise reads in no language: the labelled score comes back, no relabel
    noise = " ".join("".join(random.Random(i).choices("bcdfghjklmnpqrstvwxz", k=6)) for i in range(300))
    quality, relabel = text_quality.score_with_relabel(noise, ["de"])
    assert relabel is None and quality <= text_quality.NO_DICTIONARY_SCORE_CAP
