"""extract_cases() and _context(): pure regex extraction, no DB.

Covers the three CaseRef kinds (BGE/ATF/DTF volume citations, Federal Court
docket numbers, ECLI identifiers), their canonicalisation, dedup, and the
negative cases that must NOT match (a bare "Art. 142 III" is not a BGE;
a phone number is not a docket).
"""
from chpipe.citations import CaseRef, _context, extract_cases


# --------------------------------------------------------------------------
# BGE / ATF / DTF volume citations -> canonical "BGE {vol} {part} {page}"
# --------------------------------------------------------------------------

def test_atf_french_form_canonicalises_to_bge():
    refs = extract_cases("(ATF 142 IV 250 consid. 1.3)")
    assert len(refs) == 1
    assert refs[0].kind == "bge"
    assert refs[0].raw == "BGE 142 IV 250"


def test_bge_german_form_with_erwaegung_and_seite():
    refs = extract_cases("BGE 106 II 117 E. 1 S. 118")
    assert len(refs) == 1
    assert refs[0].kind == "bge"
    assert refs[0].raw == "BGE 106 II 117"


def test_dtf_italian_form_canonicalises_to_bge():
    refs = extract_cases("DTF 140 III 86 consid. 2")
    assert len(refs) == 1
    assert refs[0].kind == "bge"
    assert refs[0].raw == "BGE 140 III 86"


def test_bge_part_with_lowercase_suffix():
    refs = extract_cases("BGE 115 Ia 12")
    assert len(refs) == 1
    assert refs[0].kind == "bge"
    assert refs[0].raw == "BGE 115 Ia 12"


# --------------------------------------------------------------------------
# Federal Court docket numbers -> kept as written
# --------------------------------------------------------------------------

def test_modern_underscore_docket():
    refs = extract_cases("Urteil 4A_22/2017 vom 19. Juni 2017")
    assert len(refs) == 1
    assert refs[0].kind == "docket"
    assert refs[0].raw == "4A_22/2017"


def test_older_dot_series_docket_kept_as_written():
    refs = extract_cases("arrêt 5P.123/2004 du 3 mai 2004")
    assert len(refs) == 1
    assert refs[0].kind == "docket"
    assert refs[0].raw == "5P.123/2004"


def test_other_modern_underscore_dockets():
    refs = extract_cases("siehe 1C_656/2023 und 9C_12/2020 dazu")
    kinds_raw = [(r.kind, r.raw) for r in refs]
    assert ("docket", "1C_656/2023") in kinds_raw
    assert ("docket", "9C_12/2020") in kinds_raw


def test_other_older_dot_series_dockets():
    refs = extract_cases("vgl. 2A.45/2001 und 6S.20/2003")
    kinds_raw = [(r.kind, r.raw) for r in refs]
    assert ("docket", "2A.45/2001") in kinds_raw
    assert ("docket", "6S.20/2003") in kinds_raw


# --------------------------------------------------------------------------
# ECLI identifiers -> kept unchanged
# --------------------------------------------------------------------------

def test_ecli_bger_form_unchanged():
    refs = extract_cases("ECLI:CH:BGER:2017:4A.22.2017")
    assert len(refs) == 1
    assert refs[0].kind == "ecli"
    assert refs[0].raw == "ECLI:CH:BGER:2017:4A.22.2017"


def test_ecli_trailing_sentence_dot_is_stripped():
    refs = extract_cases("Vgl. ECLI:CH:BGER:2017:4A.22.2017.")
    assert len(refs) == 1
    assert refs[0].kind == "ecli"
    assert refs[0].raw == "ECLI:CH:BGER:2017:4A.22.2017"


def test_ecli_entscheidsuche_style_with_underscores_and_hyphens():
    text = "ECLI:CH:BGE:CH_BGE_004_BGE-115-II-300_1989"
    refs = extract_cases(text)
    assert len(refs) == 1
    assert refs[0].kind == "ecli"
    assert refs[0].raw == text


# --------------------------------------------------------------------------
# Dedup: same canonical key inside one text -> one ref, first context kept
# --------------------------------------------------------------------------

def test_dedup_keeps_first_occurrence_and_its_context():
    filler = "x" * 300
    text = f"See BGE 142 III 102 here. {filler} Later on, BGE 142 III 102 is cited again."
    refs = extract_cases(text)
    assert len(refs) == 1
    assert refs[0].raw == "BGE 142 III 102"
    assert "here" in refs[0].context
    assert "cited again" not in refs[0].context


def test_dedup_preserves_first_occurrence_order():
    text = "BGE 100 I 1 and BGE 101 II 2 and BGE 100 I 1 again"
    refs = extract_cases(text)
    assert [r.raw for r in refs] == ["BGE 100 I 1", "BGE 101 II 2"]


# --------------------------------------------------------------------------
# Negative cases
# --------------------------------------------------------------------------

def test_bare_article_reference_is_not_a_bge():
    refs = extract_cases("Art. 142 III")
    assert refs == []


def test_phone_number_is_not_a_docket():
    refs = extract_cases("Tel. 044 123 45 67")
    assert refs == []


def test_empty_text_returns_empty_list():
    assert extract_cases("") == []


# --------------------------------------------------------------------------
# _context()
# --------------------------------------------------------------------------

def test_context_collapses_whitespace_and_windows_around_the_match():
    text = "a" * 200 + "\n\n  BGE 142 III 102  \t\n" + "b" * 200
    start = text.index("BGE")
    end = start + len("BGE 142 III 102")
    ctx = _context(text, start, end, width=10)
    assert "  " not in ctx
    assert "BGE 142 III 102" in ctx


def test_context_clamps_to_text_bounds_near_start_and_end():
    text = "BGE 142 III 102"
    ctx = _context(text, 0, len(text), width=120)
    assert ctx == "BGE 142 III 102"


# --------------------------------------------------------------------------
# CaseRef is a frozen dataclass
# --------------------------------------------------------------------------

def test_caseref_is_frozen():
    ref = CaseRef(kind="bge", raw="BGE 142 III 102", context="...")
    try:
        ref.kind = "docket"
    except AttributeError:
        pass
    else:
        raise AssertionError("CaseRef should be frozen")
