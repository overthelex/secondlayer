"""extract_statutes(): pure regex extraction of statute references, no DB.

Covers the three official languages (de/fr/it), article and paragraph lists,
letter/number qualifiers, language inference, abbreviation normalisation, the
negative cases that must NOT match, and the performance ceiling (a 2 MB text
must extract in under a second).

Expected values are compared as `(abbr, article, paragraph, lang)` tuples.
"""
import time

from chpipe.citations import StatuteRef, extract_statutes


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
# Performance: 2 MB of text in under a second
# --------------------------------------------------------------------------

def test_two_megabytes_extract_in_under_a_second():
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
    assert elapsed < 1.0, f"extract_statutes took {elapsed:.3f}s on 2 MB"
