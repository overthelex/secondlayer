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
