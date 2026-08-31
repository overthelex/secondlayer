"""aliases_from_title() and the CURATED map. Pure functions/data, no DB."""
from chpipe.ch_aliases import CURATED, aliases_from_title


# --------------------------------------------------------------------------
# aliases_from_title()
# --------------------------------------------------------------------------

def test_extracts_a_bare_parenthesised_abbreviation():
    assert aliases_from_title(
        "Loi federale du 25 septembre 2020 sur la protection des "
        "donnees (LPD)") == "LPD"


def test_extracts_the_abbreviation_after_a_comma_separated_gloss():
    assert aliases_from_title(
        "Codice di procedura civile del 19 dicembre 2008 (Codice di "
        "procedura civile, CPC)") == "CPC"


def test_extracts_the_abbreviation_from_a_law_on_the_federal_court():
    assert aliases_from_title(
        "Loi federale du 17 juin 2005 sur le Tribunal federal (LTF)") == "LTF"


def test_a_title_without_parentheses_returns_none():
    assert aliases_from_title("Code civil suisse du 10 decembre 1907") is None


def test_a_trailing_date_in_parentheses_returns_none():
    assert aliases_from_title(
        "Codice penale svizzero del 21 dicembre 1937 "
        "(Stand am 1. Januar 2026)") is None


def test_empty_and_none_titles_return_none():
    assert aliases_from_title("") is None
    assert aliases_from_title(None) is None


def test_parentheses_not_at_the_end_are_ignored():
    """The regex is anchored with \\s*$: a parenthetical earlier in the
    title (not the trailing one) must not be mistaken for the abbreviation
    slot."""
    assert aliases_from_title(
        "Ordonnance du 1er janvier (provisoire) sur les choses") is None


# --------------------------------------------------------------------------
# CURATED
# --------------------------------------------------------------------------

def test_curated_covers_every_sr_number_the_brief_lists():
    expected = {
        "101", "210", "220", "272", "281.1", "311.0", "312.0", "173.110",
        "172.021", "173.32", "235.1", "830.1", "831.10", "831.20", "832.10",
        "832.20", "831.40", "837.0", "142.20", "142.31", "642.11", "641.20",
        "0.101", "351.1", "211.412.11", "221.229.1", "232.11", "241", "251",
        "741.01", "700", "814.01", "173.71", "152.3", "935.61",
    }
    assert set(CURATED) == expected


def test_641_10_the_cantonal_stg_is_deliberately_omitted():
    assert "641.10" not in CURATED


def test_every_entry_has_de_fr_it_as_non_empty_tuples():
    for sr_number, langs in CURATED.items():
        assert set(langs) == {"de", "fr", "it"}, sr_number
        for lang, abbrs in langs.items():
            assert isinstance(abbrs, tuple) and abbrs, (sr_number, lang)


def test_or_co_co_for_the_code_of_obligations():
    assert CURATED["220"] == {"de": ("OR",), "fr": ("CO",), "it": ("CO",)}


def test_bv_stores_both_dotted_and_undotted_cst_and_cost():
    assert CURATED["101"]["fr"] == ("Cst.", "Cst")
    assert CURATED["101"]["it"] == ("Cost.", "Cost")
