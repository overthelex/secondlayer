"""Tests for chpipe.bench.score: the point-in-time grounding scorer.

Fixture texts imitate Fedlex plain-text extraction: numbered paragraphs
("1 ... 2 ... 3 ..."), each paragraph a self-contained normative sentence.
GOLD and DISTRACTOR share paragraph 1 verbatim (unaffected by the amendment)
and diverge in paragraphs 2 and 3 (the amendment itself) -- the same shape
Task 3's builder will hand the scorer: two adjacent editions of one article.
"""
from chpipe.bench import score as s

GOLD = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts anderes "
    "vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung innerhalb von 180 Tagen "
    "gerichtlich anfechten."
)

# Paragraphs 2 and 3 are reworded, not just re-numbered or single-word
# substitutions: swapping one short word for another of similar length
# ("drei" -> "sechs", "180" -> "30") is too small an edit for an ~80
# character string to reliably drop below the 0.92 window-match ratio --
# measured directly (SequenceMatcher on the real "drei"/"sechs" pair) at
# 0.924, just over the line, which would make this fixture unable to test
# what it is meant to test. A materially different clause, the way a real
# Fedlex amendment usually reads, is unambiguous instead.
DISTRACTOR = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist richtet sich nach den Bestimmungen des "
    "Einzelarbeitsvertrags, sofern nichts anderes vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung nur durch eine schriftliche "
    "Klage beim zuständigen Gericht anfechten."
)

UNRELATED = (
    "Die Katze sitzt auf der Matte und schläft den ganzen Tag lang, "
    "ohne sich um die Nachbarn zu kümmern."
)


def _paragraphs(text):
    return [p.split(" ", 1)[1] for p in text.strip().split("\n")]


def test_verbatim_gold_is_grounded_correct():
    v = s.score(GOLD, GOLD, DISTRACTOR)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_verbatim_distractor_is_grounded_wrong_version():
    v = s.score(DISTRACTOR, GOLD, DISTRACTOR)
    assert v.label == "grounded_wrong_version"
    assert v.distractor_coverage == 1.0
    assert v.gold_coverage == 0.0


def test_unrelated_prose_is_ungrounded():
    v = s.score(UNRELATED, GOLD, DISTRACTOR)
    assert v.label == "ungrounded"
    assert v.gold_coverage == 0.0
    assert v.distractor_coverage == 0.0


def test_gold_with_typos_in_two_words_is_still_grounded_correct():
    # "Kündigungsfrist" -> "Kündigunosfrist", "Arbeitnehmer" -> "Arbeitnehner":
    # one-letter typos, neither touching the discriminating wording (drei
    # months/sechs months; the reworded paragraph 3). Substring match
    # fails; window match (ratio >= 0.92) must not.
    typoed = GOLD.replace("Kündigungsfrist", "Kündigunosfrist").replace(
        "Arbeitnehmer", "Arbeitnehner"
    )
    assert typoed != GOLD
    v = s.score(typoed, GOLD, DISTRACTOR)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_gold_with_curly_quotes_whitespace_and_soft_hyphen_is_grounded_correct():
    gold2 = (
        'Der Arbeitgeber muss dem Arbeitnehmer ein Zeugnis mit dem Vermerk '
        '"ordentlich gekündigt" ausstellen und binnen zehn Tagen übermitteln.'
    )
    distractor2 = (
        'Der Arbeitgeber muss dem Arbeitnehmer ein Zeugnis mit dem Vermerk '
        '"fristlos entlassen" ausstellen und binnen zwanzig Tagen übermitteln.'
    )
    # Curly guillemets instead of straight quotes, a soft hyphen inserted
    # inside "Arbeitnehmer" (a Fedlex line-break artefact), and doubled
    # whitespace -- all cosmetic, none of it should survive normalise().
    answer = (
        "Der  Arbeitgeber muss dem Arbeit­nehmer ein Zeugnis mit dem "
        "Vermerk «ordentlich gekündigt» ausstellen und binnen "
        "zehn  Tagen übermitteln."
    )
    v = s.score(answer, gold2, distractor2)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_half_gold_half_distractor_is_ungrounded():
    gold_paras = _paragraphs(GOLD)
    distractor_paras = _paragraphs(DISTRACTOR)
    # shared paragraph 1 + gold paragraph 2 + distractor paragraph 3: one
    # gold-only unit found (of two), one distractor-only unit found (of two).
    answer = f"{gold_paras[0]} {gold_paras[1]} {distractor_paras[2]}"
    v = s.score(answer, GOLD, DISTRACTOR)
    assert v.label == "ungrounded"
    assert v.gold_coverage == 0.5
    assert v.distractor_coverage == 0.5


def test_gold_embedded_in_extra_prose_is_grounded_correct():
    answer = f"Gemäss Art. 336 OR gilt: {GOLD} Dies bedeutet etwas Wichtiges."
    v = s.score(answer, GOLD, DISTRACTOR)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_empty_answer_is_ungrounded_with_zero_coverage():
    v = s.score("", GOLD, DISTRACTOR)
    assert v.label == "ungrounded"
    assert v.gold_coverage == 0.0
    assert v.distractor_coverage == 0.0
    assert v.shared_coverage == 0.0


def test_score_is_deterministic():
    v1 = s.score(GOLD, GOLD, DISTRACTOR)
    v2 = s.score(GOLD, GOLD, DISTRACTOR)
    assert v1 == v2


def test_units_on_three_paragraph_article_returns_paragraph_level_units():
    article = (
        "1 Die Kündigung ist gültig, wenn sie schriftlich erfolgt und dem "
        "anderen Vertragspartner zugestellt wird.\n"
        "2 Ok.\n"
        "3 Der Widerspruch ist innerhalb von dreissig Tagen schriftlich zu "
        "begründen und einzureichen."
    )
    result = s.units(article)
    # paragraph 2 ("Ok.") normalises to 2 chars, well under the 25-char
    # floor, and must be dropped.
    assert len(result) == 2
    assert all(len(u) >= 25 for u in result)
    assert any("kündigung ist gültig" in u for u in result)
    assert any("widerspruch ist innerhalb" in u for u in result)
    assert not any(u.startswith(("1 ", "2 ", "3 ")) for u in result)


def test_normalise_nfkc_and_quotes():
    # NFKC folds the full-width "Ａ" to ASCII "A"; quotes/dashes unify;
    # the soft hyphen disappears; whitespace collapses.
    raw = "ARBEITＡEHMER — “Kündigung­ frist”\ttest"
    result = s.normalise(raw)
    assert result == 'arbeitaehmer - "kündigung frist" test'
    assert "­" not in result
    assert "—" not in result
    assert "“" not in result and "”" not in result


# --- Discriminating pairs: a gold-only/distractor-only unit pair that is
# itself near-identical (a single number changed, e.g. "180 Tagen" vs "30
# Tagen") is exactly the amendment shape this benchmark exists to catch.
# Regression fixture for the bug the fuzzy window match let through: a
# 0.98-ratio single-paragraph pair where BOTH the gold-verbatim and the
# distractor-verbatim answer used to "find" the other edition's unit too,
# via window matching, and score() returned ungrounded for both.

GOLD_DISC = "1 Die Frist beträgt innert 180 Tagen nach Zustellung des Entscheids an die Partei."
DISTRACTOR_DISC = "1 Die Frist beträgt innert 30 Tagen nach Zustellung des Entscheids an die Partei."


def test_discriminating_unit_gold_verbatim_is_grounded_correct():
    v = s.score(GOLD_DISC, GOLD_DISC, DISTRACTOR_DISC)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_discriminating_unit_distractor_verbatim_is_grounded_wrong_version():
    v = s.score(DISTRACTOR_DISC, GOLD_DISC, DISTRACTOR_DISC)
    assert v.label == "grounded_wrong_version"
    assert v.gold_coverage == 0.0
    assert v.distractor_coverage == 1.0


def test_discriminating_unit_survives_cosmetic_variation():
    # Doubled whitespace and a soft hyphen are cosmetic and normalise()
    # erases both (collapses whitespace, deletes the soft hyphen outright),
    # so the *normalised* form is still an exact match -- discriminating
    # units require exactness post-normalisation, not exactness of the raw
    # string. (Unlike inserted quote characters, which are real characters
    # with no cancelling rule and correctly break an exact match -- see
    # normalise()'s docstring on why quotes are unified, not deleted.)
    answer = (
        "1  Die  Frist beträgt innert 180 Tagen nach Zu­stellung des "
        "Entscheids an die Partei."
    )
    v = s.score(answer, GOLD_DISC, DISTRACTOR_DISC)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_discriminating_unit_rejects_typos_even_though_number_is_right():
    # Trade-off, deliberate and documented in the module docstring: once a
    # unit is flagged discriminating, fuzzy window matching is switched
    # off for it entirely, so an otherwise-harmless typo elsewhere in the
    # SAME paragraph now sinks the match even though the discriminating
    # number ("180 Tagen") is untouched and correct. Two one-letter typos,
    # in "Zustellung" and "Entscheids", neither anywhere near "180 Tagen".
    answer = GOLD_DISC.replace("Zustellung", "Zustollung").replace(
        "Entscheids", "Entscheeds"
    )
    assert answer != GOLD_DISC
    v = s.score(answer, GOLD_DISC, DISTRACTOR_DISC)
    assert v.label == "ungrounded"
    assert v.gold_coverage == 0.0
    assert v.distractor_coverage == 0.0
