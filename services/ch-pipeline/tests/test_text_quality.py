import random

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
                      "replacement_ratio", "score"}
