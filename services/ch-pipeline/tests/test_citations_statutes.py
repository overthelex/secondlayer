"""extract_statutes(): pure regex extraction of statute references, no DB.

Covers the three official languages (de/fr/it), article and paragraph lists,
letter/number qualifiers, language inference, abbreviation normalisation, the
negative cases that must NOT match, and the performance ceiling (a 2 MB text
must extract well inside CIT_PERF_BUDGET seconds).

Expected values are compared as `(abbr, article, paragraph, lang)` tuples.
"""
import os
import time

from chpipe.citations import StatuteRef, extract_statutes

# A wall-clock ceiling in a unit test is a machine-speed assertion, and a
# shared or throttled CI worker is exactly the machine that fails it while
# the extractor is perfectly linear. The point of these two tests is to catch
# an order-of-magnitude regression (a backtracking rewrite of one of the
# list regexes), not to measure this host -- so the default budget is far
# above the ~0.1s the extractor actually takes, and CHPIPE_CIT_PERF_BUDGET
# lets a slow box raise it further without touching the test.
CIT_PERF_BUDGET = float(os.environ.get("CHPIPE_CIT_PERF_BUDGET") or 5.0)


def refs(text: str) -> list[tuple[str, str, str | None, str]]:
    """extract_statutes() reduced to the comparable 4-tuple."""
    return [(r.abbr, r.article, r.paragraph, r.lang) for r in extract_statutes(text)]


# --------------------------------------------------------------------------
# German
# --------------------------------------------------------------------------

def test_de_article_with_absatz():
    assert refs("Art. 336 Abs. 1 OR") == [("OR", "336", "1", "de")]


def test_de_article_list_shares_the_abbreviation():
    assert refs("Art. 336 und 336a OR") == [
        ("OR", "336", None, "de"),
        ("OR", "336a", None, "de"),
    ]


def test_de_constitution_article():
    assert refs("Art. 29 Abs. 2 BV") == [("BV", "29", "2", "de")]


def test_de_litera_qualifier_is_not_a_paragraph():
    assert refs("Art. 95 lit. a BGG") == [("BGG", "95", None, "de")]


def test_de_folgende_marker_is_not_expanded():
    assert refs("Art. 8 ff. ZGB") == [("ZGB", "8", None, "de")]


def test_de_article_with_letter_suffix_paragraph_and_litera():
    assert refs("Art. 336c Abs. 1 lit. c OR") == [("OR", "336c", "1", "de")]


def test_de_article_list_joined_by_oder():
    """"oder" is as common as "und" in an article list, and dropping it lost
    BOTH endpoints, not just the second: the scanner never reached the shared
    abbreviation, so the whole reference was discarded."""
    assert refs("Art. 8 oder 9 ZGB") == [
        ("ZGB", "8", None, "de"),
        ("ZGB", "9", None, "de"),
    ]


def test_de_paragraph_list_joined_by_oder():
    assert refs("Art. 8 Abs. 1 oder 2 ZGB") == [
        ("ZGB", "8", "1", "de"),
        ("ZGB", "8", "2", "de"),
    ]


def test_fr_article_list_joined_by_ou():
    assert refs("art. 8 ou 9 CC") == [
        ("CC", "8", None, "fr"),
        ("CC", "9", None, "fr"),
    ]


def test_fr_paragraph_list_joined_by_ou():
    assert refs("art. 8 al. 1 ou 2 CC") == [
        ("CC", "8", "1", "fr"),
        ("CC", "8", "2", "fr"),
    ]


def test_it_article_list_joined_by_o():
    assert refs("art. 8 o 9 CO") == [
        ("CO", "8", None, "fr"),
        ("CO", "9", None, "fr"),
    ]


def test_it_paragraph_list_joined_by_o():
    assert refs("art. 8 cpv. 1 o 2 CO") == [
        ("CO", "8", "1", "it"),
        ("CO", "8", "2", "it"),
    ]


def test_de_paragraph_list_yields_one_ref_per_paragraph():
    assert refs("Art. 42 Abs. 1 und 2 BGG") == [
        ("BGG", "42", "1", "de"),
        ("BGG", "42", "2", "de"),
    ]


def test_de_ziffer_qualifier_is_not_a_paragraph():
    assert refs("Art. 6 Ziff. 1 EMRK") == [("EMRK", "6", None, "de")]


def test_de_spelled_out_head_word():
    assert refs("Artikel 8 ZGB") == [("ZGB", "8", None, "de")]


# --------------------------------------------------------------------------
# French
# --------------------------------------------------------------------------

def test_fr_alinea_and_lettre():
    assert refs("art. 77 al. 1 let. b LTF") == [("LTF", "77", "1", "fr")]


def test_fr_paragraph_list_yields_one_ref_per_paragraph():
    assert refs("art. 399 al. 1 et 3 CPP") == [
        ("CPP", "399", "1", "fr"),
        ("CPP", "399", "3", "fr"),
    ]


def test_fr_trailing_rs_number_is_not_an_abbreviation():
    assert refs("art. 28 al. 2 let. d EIMP (RS 351.1)") == [
        ("EIMP", "28", "2", "fr"),
    ]


def test_fr_chiffre_qualifier_is_not_a_paragraph():
    assert refs("art. 6 ch. 1 CEDH") == [("CEDH", "6", None, "fr")]


def test_fr_paragraphe_keyword_behaves_like_alinea():
    assert refs("art. 6 par. 1 CEDH") == [("CEDH", "6", "1", "fr")]


def test_fr_suivants_marker_without_a_full_stop():
    assert refs("art. 8 ss CO") == [("CO", "8", None, "fr")]
    assert refs("art. 8 et ss CO") == [("CO", "8", None, "fr")]


def test_fr_abbreviation_keeps_its_own_full_stop():
    assert refs("art. 8 Cst.") == [("Cst.", "8", None, "fr")]


def test_fr_spelled_out_plural_head_word_with_article_list():
    assert refs("Articles 8 et 9 CC") == [
        ("CC", "8", None, "fr"),
        ("CC", "9", None, "fr"),
    ]


def test_fr_full_sentence_with_rs_tail():
    text = (
        "art. 399 al. 1 et 3 CPP; Code de procédure pénale suisse "
        "du 5 octobre 2007, RS 312.0"
    )
    assert refs(text) == [
        ("CPP", "399", "1", "fr"),
        ("CPP", "399", "3", "fr"),
    ]


# --------------------------------------------------------------------------
# Italian
# --------------------------------------------------------------------------

def test_it_capoverso_then_bare_article():
    assert refs("gli art. 207 cpv. 2 e 228 LT") == [
        ("LT", "207", "2", "it"),
        ("LT", "228", None, "it"),
    ]


def test_it_two_articles_each_with_its_own_capoverso():
    assert refs("art. 134 cpv. 2 e 142 cpv. 4 LIFD") == [
        ("LIFD", "134", "2", "it"),
        ("LIFD", "142", "4", "it"),
    ]


def test_it_double_t_head_word_infers_italian():
    assert refs("artt. 134 e 142 LIFD") == [
        ("LIFD", "134", None, "it"),
        ("LIFD", "142", None, "it"),
    ]


def test_it_constitution_abbreviation_keeps_its_full_stop():
    assert refs("art. 8 Cost.") == [("Cost.", "8", None, "it")]


def test_it_full_sentence_with_two_heads():
    text = (
        "visti gli art. 207 cpv. 2 e 228 LT, come pure gli art. 134 cpv. 2 "
        "e 142 cpv. 4 LIFD"
    )
    assert refs(text) == [
        ("LT", "207", "2", "it"),
        ("LT", "228", None, "it"),
        ("LIFD", "134", "2", "it"),
        ("LIFD", "142", "4", "it"),
    ]


# --------------------------------------------------------------------------
# Ranges: endpoints only, never expanded
# --------------------------------------------------------------------------

def test_range_yields_the_two_endpoints_only():
    assert refs("Art. 8-10 ZGB") == [
        ("ZGB", "8", None, "de"),
        ("ZGB", "10", None, "de"),
    ]


# --------------------------------------------------------------------------
# Abbreviation normalisation
# --------------------------------------------------------------------------

def test_trailing_sentence_dot_is_stripped_from_a_plain_abbreviation():
    assert refs("Le Tribunal applique l'art. 8 CC.") == [("CC", "8", None, "fr")]


def test_dotted_abbreviation_keeps_its_dot_even_at_the_end_of_a_sentence():
    assert refs("Cela découle de l'art. 8 Cst.") == [("Cst.", "8", None, "fr")]


# --------------------------------------------------------------------------
# Language inference precedence
# --------------------------------------------------------------------------

def test_paragraph_keyword_wins_over_the_abbreviation_table():
    # CP is a French abbreviation in the table, but "cpv." is Italian.
    assert refs("art. 12 cpv. 3 CP") == [("CP", "12", "3", "it")]


def test_head_word_wins_over_the_abbreviation_table():
    # LT is in no table; the Italian head word decides.
    assert refs("Articolo 12 LT") == [("LT", "12", None, "it")]


def test_unknown_abbreviation_without_any_hint_defaults_to_german():
    assert refs("Art. 12 XYZG") == [("XYZG", "12", None, "de")]


# --------------------------------------------------------------------------
# Negative cases
# --------------------------------------------------------------------------

def test_law_spelled_out_in_words_is_not_an_abbreviation():
    assert refs("Art. 5 des Bundesgesetzes") == []


def test_clock_time_is_not_a_statute_reference():
    assert refs("Art. 12 Uhr") == []


def test_paragraph_keyword_alone_is_not_an_abbreviation():
    assert refs("Art. 5 Abs. 1") == []


def test_rs_and_sr_are_followed_by_a_number_not_an_abbreviation():
    assert refs("RS 312.0 et SR 210") == []
    assert refs("art. 5 RS 351.1") == []


def test_empty_text_returns_empty_list():
    assert extract_statutes("") == []


def test_head_word_inside_a_longer_word_is_not_a_head():
    assert refs("Die Arterie 8 OR") == []


# --------------------------------------------------------------------------
# Dedup and ordering
# --------------------------------------------------------------------------

def test_dedup_keeps_first_occurrence_and_its_context():
    filler = "x" * 300
    text = f"Siehe Art. 336 Abs. 1 OR hier. {filler} Nochmals Art. 336 Abs. 1 OR."
    out = extract_statutes(text)
    assert len(out) == 1
    assert "hier" in out[0].context
    assert "Nochmals" not in out[0].context


def test_order_follows_first_occurrence():
    text = "Art. 8 ZGB, Art. 41 OR und nochmals Art. 8 ZGB"
    assert refs(text) == [
        ("ZGB", "8", None, "de"),
        ("OR", "41", None, "de"),
    ]


# --------------------------------------------------------------------------
# List cap
# --------------------------------------------------------------------------

def test_article_list_is_capped_at_eight_items():
    """The 9th and 10th articles are dropped, but the abbreviation still binds."""
    out = refs("Art. 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ZGB")
    assert out == [("ZGB", str(n), None, "de") for n in range(1, 9)]


def test_paragraph_list_is_capped_at_eight_items():
    out = refs("Art. 5 Abs. 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 BV")
    assert out == [("BV", "5", str(n), "de") for n in range(1, 9)]


# --------------------------------------------------------------------------
# StatuteRef shape
# --------------------------------------------------------------------------

def test_statuteref_is_frozen_and_carries_context():
    out = extract_statutes("Der Vertrag folgt aus Art. 1 OR und weiter.")
    assert len(out) == 1
    ref = out[0]
    assert isinstance(ref, StatuteRef)
    assert "Art. 1 OR" in ref.context
    try:
        ref.abbr = "ZGB"
    except AttributeError:
        pass
    else:
        raise AssertionError("StatuteRef should be frozen")


# --------------------------------------------------------------------------
# Spelled-out qualifiers: never the act abbreviation, never a paragraph
# --------------------------------------------------------------------------

def test_de_satz_qualifier_is_not_the_abbreviation():
    assert refs("Art. 5 Abs. 1 Satz 2 BV") == [("BV", "5", "1", "de")]


def test_de_satz_qualifier_after_a_paragraph_keeps_the_paragraph():
    assert refs("Art. 336 Abs. 2 Satz 1 OR") == [("OR", "336", "2", "de")]


def test_de_spelled_out_absatz_and_buchstabe():
    assert refs("Art. 12 Absatz 3 Buchstabe b BV") == [("BV", "12", "3", "de")]


def test_de_spelled_out_ziffer():
    assert refs("Art. 8 Ziffer 1 EMRK") == [("EMRK", "8", None, "de")]


def test_de_anhang_qualifier():
    assert refs("Art. 4 Anhang 1 VwVG") == [("VwVG", "4", None, "de")]


def test_de_halbsatz_qualifier():
    assert refs("Art. 5 Halbsatz 2 BV") == [("BV", "5", None, "de")]


def test_fr_spelled_out_chiffre():
    assert refs("art. 8 chiffre 1 CEDH") == [("CEDH", "8", None, "fr")]


def test_it_spelled_out_cifra():
    assert refs("art. 8 cifra 1 CEDU") == [("CEDU", "8", None, "it")]


def test_it_spelled_out_numero_infers_italian():
    assert refs("art. 8 numero 1 LT") == [("LT", "8", None, "it")]


def test_bare_spelled_out_qualifier_is_not_an_abbreviation():
    assert refs("Art. 5 Absatz") == []
    assert refs("Art. 5 Satz") == []
    assert refs("Art. 5 Buchstabe") == []
    assert refs("Art. 5 Ziffer") == []
    assert refs("Art. 5 Anhang") == []


# --------------------------------------------------------------------------
# The head word must never fill the abbreviation slot
# --------------------------------------------------------------------------

def test_head_word_on_the_next_line_is_not_an_abbreviation():
    assert refs("Art. 5\nArt. 6\nArt. 7 ZGB") == [("ZGB", "7", None, "de")]


def test_head_word_on_the_same_line_is_not_an_abbreviation():
    assert refs("Art. 8 Abs. 1 Art. 9 Abs. 2 ZGB") == [("ZGB", "9", "2", "de")]


def test_spelled_out_head_word_is_not_an_abbreviation():
    assert refs("Art. 5 Artikel 6 ZGB") == [("ZGB", "6", None, "de")]


# --------------------------------------------------------------------------
# Letter lists after lit./let./lettre
# --------------------------------------------------------------------------

def test_de_bare_letter_list_after_litera():
    assert refs("Art. 8 Abs. 1 lit. a und b BGG") == [("BGG", "8", "1", "de")]


def test_de_repeated_litera_keyword_in_a_letter_list():
    assert refs("Art. 8 lit. a und lit. b BGG") == [("BGG", "8", None, "de")]


def test_de_three_item_letter_list():
    assert refs("Art. 8 lit. a, b und c BGG") == [("BGG", "8", None, "de")]


def test_fr_spelled_out_lettre():
    assert refs("art. 8 lettre b LTF") == [("LTF", "8", None, "fr")]


def test_letter_list_does_not_swallow_a_following_article():
    assert refs("Art. 8 lit. a und 9 lit. b OR") == [
        ("OR", "8", None, "de"),
        ("OR", "9", None, "de"),
    ]


def test_letter_list_does_not_swallow_an_ordinary_word():
    assert refs("Art. 8 lit. a und der Rest") == []


# --------------------------------------------------------------------------
# Genitive head word
# --------------------------------------------------------------------------

def test_de_genitive_head_word():
    assert refs("Artikels 8 ZGB") == [("ZGB", "8", None, "de")]


# --------------------------------------------------------------------------
# Performance: 2 MB of text inside the budget (order-of-magnitude guard)
# --------------------------------------------------------------------------

def test_two_megabytes_extract_inside_the_budget():
    unit = (
        "Nach Art. 336 Abs. 1 OR und Art. 8 ff. ZGB, vgl. art. 77 al. 1 let. b "
        "LTF sowie gli art. 207 cpv. 2 e 228 LT; im Übrigen Art. 5 des "
        "Bundesgesetzes und Art. 12 Uhr, Arterienbefund ohne Belang. "
    )
    text = unit * (2_000_000 // len(unit) + 1)
    assert len(text) >= 2_000_000

    started = time.perf_counter()
    out = extract_statutes(text)
    elapsed = time.perf_counter() - started

    assert out, "the 2 MB fixture must still yield references"
    assert elapsed < CIT_PERF_BUDGET, \
        f"extract_statutes took {elapsed:.3f}s on 2 MB (budget {CIT_PERF_BUDGET}s)"


def test_two_megabytes_without_any_act_extract_inside_the_budget():
    """Every reference dangles: the head word must not stand in for an act."""
    text = "Art. 8 Abs. 1 " * (2_000_000 // 14 + 1)
    assert len(text) >= 2_000_000

    started = time.perf_counter()
    out = extract_statutes(text)
    elapsed = time.perf_counter() - started

    assert out == []
    assert elapsed < CIT_PERF_BUDGET, \
        f"extract_statutes took {elapsed:.3f}s on 2 MB (budget {CIT_PERF_BUDGET}s)"


# --------------------------------------------------------------------------
# Number-valued qualifier lists ("Ziff. 2 und 3") are ONE citation
# --------------------------------------------------------------------------

def test_de_ziffer_list_is_not_a_second_paragraph():
    assert refs("Art. 3 Abs. 1 Ziff. 2 und 3 VwVG") == [("VwVG", "3", "1", "de")]


def test_it_numero_list_is_not_a_second_paragraph():
    assert refs("art. 5 cpv. 1 n. 2 e 3 LIFD") == [("LIFD", "5", "1", "it")]


def test_de_satz_list_is_not_a_second_paragraph():
    assert refs("Art. 10 Abs. 1 Satz 2 und 3 BGG") == [("BGG", "10", "1", "de")]


def test_a_real_paragraph_list_is_still_one_ref_per_paragraph():
    """The other half of the same rule: a list that follows the *paragraph*
    keyword with nothing in between really is a second paragraph."""
    assert refs("Art. 42 Abs. 1 und 2 BGG") == [
        ("BGG", "42", "1", "de"),
        ("BGG", "42", "2", "de"),
    ]
    assert refs("art. 399 al. 1 et 3 CPP") == [
        ("CPP", "399", "1", "fr"),
        ("CPP", "399", "3", "fr"),
    ]


def test_fr_chiffre_list_after_an_alinea_keeps_the_whole_reference():
    """The conjunction alternation used to match the "e" of "et" and then
    read the "t" as the letter of a letter list, which left the abbreviation
    out of reach and dropped the reference entirely rather than just the
    extra chiffre."""
    assert refs("art. 5 al. 1 ch. 2 et 3 LTF") == [("LTF", "5", "1", "fr")]


# --------------------------------------------------------------------------
# A capitalised ordinary word is never an act abbreviation
# --------------------------------------------------------------------------

def test_capitalised_ordinary_word_after_an_article_is_not_an_act():
    """Every curated and title-derived abbreviation carries at least two
    uppercase letters (OR, ZGB, SchKG, LTF) or is Cst./Cost. A token that is
    one capital followed only by lowercase is an ordinary word -- the first
    word of the next sentence, which a line break makes look like the act
    slot."""
    assert refs("Art. 12\nJede Person hat Anspruch") == []
    assert refs("Art. 7\nSodann") == []


def test_the_two_dotted_constitution_abbreviations_survive_that_rule():
    assert refs("art. 8 Cst.") == [("Cst.", "8", None, "fr")]
    assert refs("art. 8 Cost.") == [("Cost.", "8", None, "it")]


# --------------------------------------------------------------------------
# Cantonal abbreviations: the "-VD" suffix belongs to the abbreviation
# --------------------------------------------------------------------------

def test_fr_cantonal_suffix_stays_part_of_the_abbreviation():
    """"LPA-VD" is the Vaud administrative-procedure act. Cut down to "LPA"
    it resolved to the federal animal-protection act (SR 455) -- a wrong act,
    not a missing one. Kept whole it matches no federal alias and stays
    unresolved, which is the truthful outcome for a cantonal act."""
    assert refs("art. 5 LPA-VD") == [("LPA-VD", "5", None, "fr")]


def test_fr_geneva_cantonal_suffix():
    assert refs("art. 60 LPA-GE") == [("LPA-GE", "60", None, "fr")]


def test_de_cantonal_suffix_of_a_german_canton_defaults_to_german():
    assert refs("Art. 3 VRG-ZH") == [("VRG-ZH", "3", None, "de")]


def test_a_two_letter_suffix_that_is_not_a_canton_is_not_kept():
    assert refs("Art. 5 LPA-XY") == [("LPA", "5", None, "de")]


def test_a_trailing_dash_is_not_a_cantonal_suffix():
    assert refs("Art. 8 ZGB- und weiter") == [("ZGB", "8", None, "de")]


# --------------------------------------------------------------------------
# Digit-suffixed ordinances ("OPP 2", "BVV 2")
# --------------------------------------------------------------------------

def test_fr_digit_suffixed_ordinance_keeps_its_digit():
    """"OPP 2" truncated to "OPP" resolved to an aviation ordinance."""
    assert refs("art. 13 OPP 2") == [("OPP 2", "13", None, "fr")]


def test_de_digit_suffixed_ordinance_keeps_its_digit():
    assert refs("Art. 27 BVV 2") == [("BVV 2", "27", None, "de")]


def test_a_year_after_the_abbreviation_is_not_a_digit_suffix():
    """The digit must be followed by a non-digit, so a four-digit year never
    becomes a one-digit suffix."""
    assert refs("Art. 5 OR 2019") == [("OR", "5", None, "de")]


def test_a_two_letter_abbreviation_takes_no_digit_suffix():
    assert refs("Art. 5 OR 2") == [("OR", "5", None, "de")]


def test_digit_suffix_at_the_end_of_a_sentence():
    assert refs("Cela découle de l'art. 13 OPP 2.") == [("OPP 2", "13", None, "fr")]


# --------------------------------------------------------------------------
# Commentary ranges: a wide range is a coverage description, not a citation
# --------------------------------------------------------------------------

def test_a_wide_range_drops_both_endpoints():
    """"Kommentar zu den Art. 308-327a ZPO" is a commentary's scope, not two
    articles the court applied."""
    assert refs("Kommentar zu den Art. 308-327a ZPO") == []
    assert refs("Art. 308-327a ZPO") == []


def test_a_narrow_range_still_yields_its_two_endpoints():
    assert refs("Art. 8-10 ZGB") == [
        ("ZGB", "8", None, "de"),
        ("ZGB", "10", None, "de"),
    ]


def test_a_range_of_exactly_five_is_still_a_citation():
    assert refs("Art. 8-13 ZGB") == [
        ("ZGB", "8", None, "de"),
        ("ZGB", "13", None, "de"),
    ]


def test_a_wide_range_drops_only_its_own_endpoints():
    assert refs("Art. 4, 308-327a ZPO") == [("ZPO", "4", None, "de")]


def test_a_wide_range_written_with_bis():
    assert refs("Art. 308 bis 327a ZPO") == []


def test_a_wide_list_that_is_not_a_range_is_untouched():
    assert refs("Art. 308 und 327a ZPO") == [
        ("ZPO", "308", None, "de"),
        ("ZPO", "327a", None, "de"),
    ]


# --------------------------------------------------------------------------
# A paragraph list that turns into an article list
# --------------------------------------------------------------------------

def test_fr_paragraph_list_stops_at_a_number_too_large_to_be_a_paragraph():
    """"art. 5 al. 1 et 2, 9, 26 et 36 Cst." cites five articles' worth of
    constitution, not a paragraph 36. 26 is past any real paragraph count, so
    the list is an article list from the comma that introduced it on."""
    assert refs("art. 5 al. 1 et 2, 9, 26 et 36 Cst.") == [
        ("Cst.", "5", "1", "fr"),
        ("Cst.", "5", "2", "fr"),
        ("Cst.", "9", None, "fr"),
        ("Cst.", "26", None, "fr"),
        ("Cst.", "36", None, "fr"),
    ]


def test_de_paragraph_list_without_a_comma_cuts_at_the_large_number():
    assert refs("Art. 5 Abs. 1 und 26 BV") == [
        ("BV", "5", "1", "de"),
        ("BV", "26", None, "de"),
    ]


def test_a_paragraph_list_of_plausible_numbers_is_still_paragraphs():
    assert refs("Art. 42 Abs. 1 und 2 BGG") == [
        ("BGG", "42", "1", "de"),
        ("BGG", "42", "2", "de"),
    ]
    assert refs("Art. 5 Abs. 1, 2 und 3 BV") == [
        ("BV", "5", "1", "de"),
        ("BV", "5", "2", "de"),
        ("BV", "5", "3", "de"),
    ]


def test_a_paragraph_of_exactly_twelve_is_still_a_paragraph():
    assert refs("Art. 5 Abs. 1 und 12 BV") == [
        ("BV", "5", "1", "de"),
        ("BV", "5", "12", "de"),
    ]
