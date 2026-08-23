from chpipe import diff_articles as d


def _a(e_id, text, number=None):
    return {"e_id": e_id, "article_number": number or e_id.split("_")[-1], "text": text}


def test_an_unchanged_article_produces_no_change():
    before = [_a("art_1", "Der Vertrag ist gültig.")]
    assert d.diff(before, list(before)) == []


def test_whitespace_only_differences_are_not_changes():
    before = [_a("art_1", "Der  Vertrag\nist gültig.")]
    after = [_a("art_1", "Der Vertrag ist gültig.")]
    assert d.diff(before, after) == []


def test_dash_variants_are_not_changes():
    """En and em dashes both occur inside a single Swiss act; treating a dash
    swap as an amendment would fabricate thousands of them."""
    assert d.diff([_a("art_1", "Art. 111–14 gilt.")],
                  [_a("art_1", "Art. 111—14 gilt.")]) == []


def test_a_real_wording_change_is_modified():
    changes = d.diff([_a("art_1", "Der Vertrag ist gültig.")],
                     [_a("art_1", "Der Vertrag ist nichtig.")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_1", "modified")]


def test_a_new_article_is_added():
    changes = d.diff([_a("art_1", "x")], [_a("art_1", "x"), _a("art_2", "y")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "added")]


def test_a_disappearing_article_is_repealed():
    changes = d.diff([_a("art_1", "x"), _a("art_2", "y")], [_a("art_1", "x")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_an_article_emptied_to_aufgehoben_is_repealed_not_modified():
    changes = d.diff([_a("art_2", "Der Text.")], [_a("art_2", "Aufgehoben")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_the_french_and_italian_repeal_markers_count_too():
    assert d.diff([_a("art_2", "Le texte.")], [_a("art_2", "Abrogé")])[0].change_type \
        == "repealed"
    assert d.diff([_a("art_2", "Il testo.")], [_a("art_2", "Abrogato")])[0].change_type \
        == "repealed"


def test_articles_sharing_a_number_are_distinguished_by_e_id():
    """'disp_u17/art_7' and 'art_7' are different articles with the same number."""
    before = [_a("art_7", "A", number="7"), _a("disp_u17/art_7", "B", number="7")]
    after = [_a("art_7", "A", number="7"), _a("disp_u17/art_7", "C", number="7")]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u17/art_7", "modified")]


def test_changes_come_back_in_a_stable_order():
    before = [_a("art_1", "x")]
    after = [_a("art_3", "z"), _a("art_2", "y"), _a("art_1", "x")]
    assert [c.e_id for c in d.diff(before, after)] == ["art_2", "art_3"]


def test_an_empty_before_makes_everything_added():
    changes = d.diff([], [_a("art_1", "x"), _a("art_2", "y")])
    assert {c.change_type for c in changes} == {"added"}


def test_an_article_emptied_to_nothing_at_all_is_repealed_too():
    """A repeal does not always leave a marker word behind -- some editions
    just empty the body outright (75 of 1,686 articles in one real edition
    of the OR). That must be caught by the same branch as the explicit
    "Aufgehoben" marker, not fall through to "modified" for want of a
    literal word to match."""
    changes = d.diff([_a("art_2", "Der Text.")], [_a("art_2", "")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]

    changes = d.diff([_a("art_2", "Der Text.")], [_a("art_2", "   ")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_ellipsis_variants_are_not_changes():
    """Fedlex renders a struck-out paragraph as an ellipsis, and the same
    edition is not always consistent about which ellipsis character it
    uses (a single U+2026 character vs three literal periods). Treating
    that as an amendment would be the same class of fabrication as the
    dash and quote variants above."""
    assert d.diff([_a("art_1", "Es gilt Art. 5 … 9.")],
                  [_a("art_1", "Es gilt Art. 5 ... 9.")]) == []


def test_a_body_of_only_the_struck_paragraph_ellipsis_is_repealed():
    """An article whose entire body is Fedlex's ellipsis-for-struck-
    paragraph marker (no marker word at all, just '…') carries no operative
    text, the same as an explicit "Aufgehoben" or a genuinely empty body."""
    changes = d.diff([_a("art_2", "Der Text.")], [_a("art_2", "…")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_non_breaking_space_and_extra_dash_variants_are_not_changes():
    assert d.diff([_a("art_1", "Der Vertrag ist gültig.")],
                  [_a("art_1", "Der Vertrag ist gültig.")]) == []
    assert d.diff([_a("art_1", "Art. 111‑114 gilt.")],
                  [_a("art_1", "Art. 111−114 gilt.")]) == []


def test_disp_container_renumbering_is_not_a_repeal_and_an_addition():
    """Fedlex renumbers a transitional-provisions container wholesale when
    a new block is inserted -- 'disp_u15/art_1' becomes 'disp_u16/art_1'
    with byte-identical text, and every article inside the container gets a
    new eId even though nothing about the law changed. Matching purely on
    eId (as the module docstring says to, for the collision reasons
    measured there) would read that as one article repealed and an
    unrelated one added; this must produce no change at all."""
    before = [_a("art_1", "x"), _a("disp_u15/art_1", "Übergangsbestimmung.")]
    after = [_a("art_1", "x"), _a("disp_u16/art_1", "Übergangsbestimmung.")]
    assert d.diff(before, after) == []


def test_disp_container_renumbering_with_a_wording_change_is_one_modified_row():
    """A container renumber and a genuine wording change can land in the
    same edition. Silently dropping the wording change (because the eId
    also changed) would hide a real amendment; recording it as an
    unrelated repeal+addition would fabricate a repeal that never
    happened. It must come back as exactly one 'modified' row, keyed on
    the eId the provision now has."""
    before = [_a("disp_u15/art_1", "Die alte Fassung.")]
    after = [_a("disp_u16/art_1", "Die neue Fassung.")]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u16/art_1", "modified")]


def test_disp_container_renumbering_into_a_repeal_is_recorded_as_repealed():
    """The same reconciliation must still call a real repeal a repeal: if
    the provision's text is a repeal marker under its new eId, that is a
    repeal riding along with the renumber, not a wording change."""
    before = [_a("disp_u15/art_1", "Die alte Fassung.")]
    after = [_a("disp_u16/art_1", "Aufgehoben")]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u16/art_1", "repealed")]


def test_unrelated_articles_with_identical_new_text_are_not_merged_into_a_rename():
    """A repealed top-level article and an unrelated new top-level article
    that happen to land on identical text must not be paired into a rename
    just because the content matches -- the reconciliation above is scoped
    to the disp_uN container-renumbering pattern specifically (a structural
    signal, checked on the eId shape), not to "any two articles with the
    same text", which would silently erase a genuine repeal sitting next to
    a genuine, unrelated addition. Neither eId here is disp_u-scoped, so
    neither can enter the reconciliation at all."""
    before = [_a("art_5", "Der alte Text.")]
    after = [_a("art_5", "Aufgehoben"), _a("art_9", "Gemeinsamer Wortlaut.")]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == \
        [("art_5", "repealed"), ("art_9", "added")]


def test_a_new_e_id_already_empty_at_first_appearance_produces_no_change():
    """An eId with no prior existence at all, whose body is already empty
    or a repeal marker the moment it first appears, never carried
    operative text under that identifier -- there is nothing to assert was
    added. Recording "added" would be as wrong as recording "repealed" for
    something that was never in force; recording nothing is the honest
    answer, the same stance as a pure container rename with unchanged
    text."""
    changes = d.diff([_a("art_1", "x")],
                     [_a("art_1", "x"), _a("art_9", "Aufgehoben"), _a("art_10", "")])
    assert changes == []
