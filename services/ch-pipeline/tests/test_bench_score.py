"""Tests for chpipe.bench.score: the point-in-time grounding scorer.

Fixture texts imitate Fedlex plain-text extraction: numbered paragraphs
("1 ... 2 ... 3 ..."), each paragraph a self-contained normative sentence.
GOLD and DISTRACTOR share paragraph 1 verbatim (unaffected by the amendment)
and diverge in paragraphs 2 and 3 (the amendment itself) -- the same shape
Task 3's builder will hand the scorer: two adjacent editions of one article.
"""
from difflib import SequenceMatcher

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


def test_normalise_folds_the_ellipsis_character_to_three_periods():
    """Same fold chpipe/diff_articles.normalise() applies: Fedlex writes a
    struck-out paragraph as U+2026 in one place and as three periods in
    another, inside the same act, so the two must compare equal."""
    assert s.normalise("Art. 5 …") == s.normalise("Art. 5 ...")
    assert "…" not in s.normalise("Aufgehoben …")


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


# --- Containment: an amendment that ADDS words to a paragraph --------------
#
# The commonest Fedlex amendment shape, and the one an equality-based
# partition got exactly backwards: the old paragraph is a substring of the
# new one, so an answer quoting the new (correct) wording verbatim also
# "contains" the old wording. Under set intersection the old paragraph was
# distractor-only, both coverages read 1.0, and a word-for-word correct
# answer was labelled `ungrounded` -- 1,097 items on the prod build. Under
# containment the old paragraph is shared and only the added wording
# discriminates. Modelled on a real case (SR 741.11 Art. 63, the
# Nachlaufteil paragraph).

DISTRACTOR_ADD = (
    "1 Der Anhänger darf nur an einem dafür ausgerüsteten Fahrrad "
    "mitgeführt werden.\n"
    "2 Kinder dürfen auf einem Nachlaufteil gemäss Artikel 210 Absatz 5 "
    "VTS an ein- und zweiplätzigen Fahrrädern mitgeführt werden."
)

GOLD_ADD = (
    "1 Der Anhänger darf nur an einem dafür ausgerüsteten Fahrrad "
    "mitgeführt werden.\n"
    "2 Kinder dürfen auf einem Nachlaufteil gemäss Artikel 210 Absatz 5 "
    "VTS an ein- und zweiplätzigen Fahrrädern mitgeführt werden, sofern "
    "sie das zwölfte Altersjahr noch nicht vollendet haben und einen "
    "Velohelm tragen."
)


def test_added_words_leave_the_old_paragraph_shared_not_distractor_only():
    gold_only, distractor_only, shared = s.discriminating_units(GOLD_ADD, DISTRACTOR_ADD)
    assert len(gold_only) == 1
    assert "velohelm tragen" in gold_only[0]
    # the old paragraph sits inside the new one, so it discriminates nothing
    assert distractor_only == []
    assert len(shared) == 2


def test_superset_gold_verbatim_is_grounded_correct():
    v = s.score(GOLD_ADD, GOLD_ADD, DISTRACTOR_ADD)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0
    # the correct answer contains every distractor unit too -- which is
    # precisely why distractor_all_coverage may only be consulted after the
    # gold test has already failed.
    assert v.distractor_all_coverage == 1.0


def test_superset_distractor_verbatim_is_grounded_wrong_version():
    v = s.score(DISTRACTOR_ADD, GOLD_ADD, DISTRACTOR_ADD)
    assert v.label == "grounded_wrong_version"
    assert v.gold_coverage == 0.0
    # nothing is distractor-only here, so the label rests entirely on the
    # all-units fallback
    assert v.distractor_coverage == 0.0
    assert v.distractor_all_coverage == 1.0


def test_superset_unrelated_prose_is_still_ungrounded():
    # The all-units fallback must not turn every non-gold answer into
    # "wrong version": it fires only when the distractor's own wording is
    # actually there.
    v = s.score(UNRELATED, GOLD_ADD, DISTRACTOR_ADD)
    assert v.label == "ungrounded"
    assert v.gold_coverage == 0.0
    assert v.distractor_all_coverage == 0.0


# --- Containment: the mirror case, a DELETED sentence ----------------------
#
# Gold is a strict subset of distractor, so gold has no discriminating unit
# at all and no fallback can rescue it: a correct answer is a fragment of
# the wrong one. The item is undecidable and build.make_items() drops it --
# see tests/test_bench_build.py's
# test_make_items_drops_the_half_whose_gold_is_a_subset_of_the_distractor.

GOLD_DEL = DISTRACTOR_ADD
DISTRACTOR_DEL = GOLD_ADD


def test_deleted_sentence_leaves_gold_with_no_discriminating_unit():
    gold_only, distractor_only, _shared = s.discriminating_units(GOLD_DEL, DISTRACTOR_DEL)
    assert gold_only == []
    assert len(distractor_only) == 1


def test_deleted_sentence_gold_verbatim_cannot_be_scored_correct():
    # Not a defect in the scorer: with nothing in gold that is not also in
    # distractor there is no evidence to find. Documented as a known limit
    # (CARD.md, "Construction") and dropped at build time rather than
    # shipped as an item no system could pass.
    v = s.score(GOLD_DEL, GOLD_DEL, DISTRACTOR_DEL)
    assert v.gold_coverage == 0.0
    assert v.label == "ungrounded"


def test_deleted_sentence_distractor_verbatim_is_grounded_wrong_version():
    v = s.score(DISTRACTOR_DEL, GOLD_DEL, DISTRACTOR_DEL)
    assert v.label == "grounded_wrong_version"
    assert v.distractor_coverage == 1.0


# --- Containment must not disarm the discriminating-pair guard -------------
#
# A short appended clause makes the old paragraph a substring of the new one
# (so it is SHARED, not distractor-only) AND leaves the pair ~0.95 similar.
# If the guard only cross-compared the two "only" sets, the gold unit would
# have nothing to be flagged against, fuzzy window matching would stay on,
# and an answer reciting the OLD paragraph could window-match the NEW one --
# scoring the wrong edition as `grounded_correct`, the exact bug the guard
# was written for, reintroduced through the other door. Measured on the
# fixtures below: with the guard restricted to the "only" sets,
# gold_coverage comes out 1.0 for an answer that quotes only the old
# wording. The guard therefore compares against ALL of the other edition's
# units.

DISTRACTOR_SHORT_ADD = (
    "1 Wer eine Sache, die ihm anvertraut worden ist, unrechtmässig in "
    "seinem oder eines anderen Nutzen verwendet, wird mit Freiheitsstrafe "
    "bis zu fünf Jahren oder Geldstrafe bestraft."
)
GOLD_SHORT_ADD = DISTRACTOR_SHORT_ADD[:-1] + " und zu begründen."

# The old wording plus a little prose -- long enough that a full-unit-length
# window exists for the fuzzy matcher to work with, which is what makes this
# shape dangerous and a bare quotation of the old paragraph harmless.
DISTRACTOR_SHORT_ADD_IN_PROSE = DISTRACTOR_SHORT_ADD + " Diese Fassung galt damals."


def test_short_addition_flags_the_gold_unit_as_discriminating():
    gold_only, distractor_only, shared = s.discriminating_units(
        GOLD_SHORT_ADD, DISTRACTOR_SHORT_ADD)
    assert len(gold_only) == 1 and distractor_only == [] and len(shared) == 1
    # nothing in the distractor-only set to pair against -- the flag can
    # only come from the shared unit, i.e. from comparing against ALL units
    disc_gold, _disc_distractor = s._discriminating_units(
        set(gold_only), set(distractor_only),
        set(s.units(GOLD_SHORT_ADD)), set(s.units(DISTRACTOR_SHORT_ADD)),
        s.normalise(GOLD_SHORT_ADD), s.normalise(DISTRACTOR_SHORT_ADD))
    assert disc_gold == set(gold_only)


def test_short_addition_flag_comes_from_the_unit_pair_test_not_the_window_test():
    """The window test cannot see this pair, which is why the unit-pair
    test is kept OR-ed alongside it rather than replaced by it.

    The gold unit is longer than the distractor's WHOLE text, and
    `_window_found` only probes windows of ~0.8x/1.0x/1.2x the unit's
    length: 1.0x and 1.2x do not fit in the distractor text at all, and the
    0.8x window can only ever cover 80% of a unit that is otherwise
    identical, which caps its ratio below 0.92. Pairwise the same two
    strings score 0.96."""
    gold_unit = s.units(GOLD_SHORT_ADD)[0]
    norm_distractor = s.normalise(DISTRACTOR_SHORT_ADD)
    assert len(gold_unit) > len(norm_distractor)
    assert s._window_found(gold_unit, norm_distractor) is False
    distractor_unit = s.units(DISTRACTOR_SHORT_ADD)[0]
    assert SequenceMatcher(None, gold_unit, distractor_unit).ratio() >= s._WINDOW_RATIO


def test_short_addition_old_wording_in_prose_is_not_scored_correct():
    v = s.score(DISTRACTOR_SHORT_ADD_IN_PROSE, GOLD_SHORT_ADD, DISTRACTOR_SHORT_ADD)
    assert v.gold_coverage == 0.0
    assert v.label == "grounded_wrong_version"


def test_short_addition_gold_verbatim_is_still_grounded_correct():
    v = s.score(GOLD_SHORT_ADD, GOLD_SHORT_ADD, DISTRACTOR_SHORT_ADD)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


# --- The window test: "if fuzzy matching would find it in the other
# edition, fuzzy matching is not allowed for it" ---------------------------
#
# Regression fixture for the shape that cost 222+ items on the prod oracle
# run: SR 142.203 Art. 3, an amendment that both rewords a phrase and
# appends a clause. The distractor sentence is NOT a substring of gold (so
# it lands in distractor_only, not in shared, and containment does not save
# it), and pairwise it scores only 0.84 against the gold sentence -- under
# the line, so the old unit-pair-only guard left it unflagged. But it DOES
# window-match inside the gold text at >= 0.92, so a word-for-word correct
# answer scored gold_coverage 1.0 AND distractor_coverage 1.0: `ungrounded`.

DISTRACTOR_142203 = (
    "1 Diese Verordnung gilt nicht für EU- und EFTA-Angehörige und ihre "
    "Familienangehörigen, die unter das Freizügigkeitsabkommen fallen."
)
GOLD_142203 = (
    "1 Diese Verordnung gilt nicht für EU- und EFTA-Angehörige und ihre "
    "Familienangehörigen, die unter die Freizügigkeitsabkommen fallen, "
    "soweit diese Abkommen auf sie anwendbar sind."
)


def test_reworded_and_extended_sentence_is_distractor_only_and_below_the_pair_ratio():
    """Pins the fixture to the shape the bug needs: distractor_only is
    non-empty (containment does not file the old sentence as shared,
    because a word inside it changed too), the pairwise ratio is BELOW
    _WINDOW_RATIO (so the unit-pair test alone cannot flag it), and the
    window match against the other edition's text is ABOVE it (so the
    window test can, and must)."""
    gold_only, distractor_only, shared = s.discriminating_units(
        GOLD_142203, DISTRACTOR_142203)
    assert len(gold_only) == 1 and len(distractor_only) == 1 and shared == []
    assert SequenceMatcher(None, gold_only[0], distractor_only[0]).ratio() < s._WINDOW_RATIO
    assert s._window_found(distractor_only[0], s.normalise(GOLD_142203)) is True


def test_reworded_and_extended_gold_verbatim_is_grounded_correct():
    v = s.score(GOLD_142203, GOLD_142203, DISTRACTOR_142203)
    assert v.label == "grounded_correct"
    assert v.gold_coverage == 1.0
    assert v.distractor_coverage == 0.0


def test_reworded_and_extended_distractor_verbatim_is_grounded_wrong_version():
    v = s.score(DISTRACTOR_142203, GOLD_142203, DISTRACTOR_142203)
    assert v.label == "grounded_wrong_version"
    assert v.gold_coverage == 0.0
    assert v.distractor_coverage == 1.0


# --- Fedlex's literal "[tab]" token ----------------------------------------
#
# Some Fedlex plain-text extractions carry a literal five-character token
# "[tab]" where the XML had a tabulation, e.g. SR 312.1's articles, whose
# paragraphs read "[tab] 1 ...". normalise() leaves it verbatim -- it is
# not whitespace as far as Python is concerned, and there is no rule that
# would touch it. That is fine and deliberate: the token appears
# identically in BOTH editions of an article, so it cancels out of every
# comparison the scorer makes. Documented here so a future reader does not
# "fix" it and change every unit boundary in the corpus at once.

DISTRACTOR_TAB = (
    "[tab] 1 Die zuständige Behörde hört das Kind in geeigneter Weise "
    "persönlich an, sofern nicht sein Alter oder andere wichtige Gründe "
    "dagegen sprechen.\n"
    "[tab] 2 Über die Anhörung wird nur das für den Entscheid Wesentliche "
    "protokolliert."
)
GOLD_TAB = DISTRACTOR_TAB.replace(
    "in geeigneter Weise persönlich", "in angemessener Weise persönlich")


def test_normalise_keeps_the_literal_tab_token_verbatim():
    assert s.normalise("[tab] 1 Der Antrag ist zu begründen.") == (
        "[tab] 1 der antrag ist zu begründen.")
    assert "[tab]" in s.normalise(DISTRACTOR_TAB)


def test_tab_token_articles_still_score_both_ways():
    # The marker sits ahead of the paragraph number, so _PARAGRAPH_MARKER
    # (which anchors the number at the start of a line) does not fire and
    # units() falls back to sentence splitting. Both editions carry the
    # token identically, so it is inert either way.
    assert all(u.startswith("[tab]") for u in s.units(DISTRACTOR_TAB))
    assert s.score(GOLD_TAB, GOLD_TAB, DISTRACTOR_TAB).label == "grounded_correct"
    assert s.score(DISTRACTOR_TAB, GOLD_TAB, DISTRACTOR_TAB).label == (
        "grounded_wrong_version")
