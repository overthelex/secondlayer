import os
import pathlib
import subprocess
import sys

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


def test_an_already_empty_article_that_disappears_is_not_repealed_again():
    """Symmetric with the already-empty-at-birth rule for "added": an eId
    that was already carrying no operative text (an earlier repeal marker,
    or a genuinely empty body) and later disappears entirely was never in
    force under that identifier at the moment it vanished -- there is
    nothing left to take out of force a second time."""
    assert d.diff([_a("art_9", "Aufgehoben")], []) == []
    assert d.diff([_a("art_9", "")], []) == []


def test_a_wholesale_container_shift_with_suffix_collisions_aligns_correctly():
    """Reproduces the real defect class measured on the live OR
    (2021-07-01 -> 2022-01-01): container 11's content moves wholesale into
    container 12, 12's into 13, 13's into 14 (Fedlex inserted a new block
    before 11), while container 10 keeps its own number and has exactly
    one real change inside it. Every one of these containers shares the
    same internal suffixes ("/art_1", "/art_2"), so a removed eId and an
    added eId collide on suffix alone with more than one candidate on each
    side -- a per-eId-suffix dictionary cannot resolve this (whichever
    candidate a dict iteration happens to visit last wins, and that order
    is not stable across processes). Whole-container alignment, scored on
    how much of EACH container's content matches, resolves it
    deterministically: every container finds its real predecessor/successor
    by content, and the single genuine change surfaces as exactly one row."""
    def art(container, suffix, text):
        return _a(f"disp_u{container}{suffix}", text)

    before = [
        art(10, "/art_1", "C10-A"), art(10, "/art_2", "C10-B"),
        art(11, "/art_1", "C11-A"), art(11, "/art_2", "C11-B"),
        art(12, "/art_1", "C12-A"), art(12, "/art_2", "C12-B"),
        art(13, "/art_1", "C13-A"), art(13, "/art_2", "C13-B"),
    ]
    after = [
        art(10, "/art_1", "C10-A-changed"), art(10, "/art_2", "C10-B"),
        art(12, "/art_1", "C11-A"), art(12, "/art_2", "C11-B"),
        art(13, "/art_1", "C12-A"), art(13, "/art_2", "C12-B"),
        art(14, "/art_1", "C13-A"), art(14, "/art_2", "C13-B"),
    ]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u10/art_1", "modified")]


def test_a_shift_that_also_loses_one_article_is_not_derailed():
    """A container shift and a genuine repeal inside the shifted container
    can land in the same edition: container 12's content moves wholesale
    into 13, but one of its articles ("/art_5") is not carried over.
    Scoring on HOW MANY suffixes two containers share (rather than how
    much of their CONTENT actually matches) lets an entirely unrelated
    decoy container that coincidentally reuses the same two suffix NAMES
    (but matches none of their content) outscore the container that lost
    one article yet still matches its remaining content byte-for-byte --
    verified this is not hypothetical: this exact input produces THREE
    fabricated rows against the code as committed before this fix
    (('disp_u13/art_1', 'added'), ('disp_u20/art_1', 'modified'),
    ('disp_u20/art_5', 'modified') -- the shift not recognised at all, and
    the decoy container diffed against unrelated content), confirmed by
    checking that version out and running it in isolation. The right
    answer is exactly one row: the genuine repeal, keyed on its eId under
    the shifted-FROM container number (the identifier it still had at the
    moment it was taken out of force) -- and the decoy container, once it
    is no longer stealing the real match, is correctly read as a brand-new,
    unrelated container in its own right."""
    before = [
        _a("disp_u12/art_1", "P"), _a("disp_u12/art_5", "Q"),
    ]
    after = [
        _a("disp_u13/art_1", "P"),  # shifted, "/art_5" genuinely repealed
        _a("disp_u20/art_1", "Z1"), _a("disp_u20/art_5", "Z2"),  # unrelated
    ]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [
        ("disp_u12/art_5", "repealed"),
        ("disp_u20/art_1", "added"),
        ("disp_u20/art_5", "added"),
    ]


def test_a_container_split_does_not_produce_a_contradictory_duplicate():
    """A container split (or merge) can pair OLD container A with NEW
    container B (a rename, producing a "repealed" row for a suffix A had
    that B does not) while SEPARATELY pairing some OTHER old container
    with NEW container A -- the SAME container NUMBER, now holding
    different, re-pointed content (producing an "added" row for a suffix
    that number gained). Reproduced here: old "disp_u11" (four articles)
    shifts into "disp_u12", losing "/art_9" along the way; separately, old
    "disp_u10" (one article) shifts into "disp_u11", which happens to gain
    a brand-new "/art_9" of its own. Both rows legitimately name the
    identical eId string "disp_u11/art_9" -- verified this is not
    hypothetical: this EXACT input produces
    [('disp_u11/art_9', 'added'), ('disp_u11/art_9', 'repealed')] against
    the code as committed before this fix (confirmed by checking that
    version out and running it in isolation). One classification is not
    simply wrong; both are individually defensible from their own pair's
    point of view, which is exactly why this cannot be prevented by
    "picking a better pairing" alone -- the string itself is shared
    ground, not a mispairing. No eId may appear twice in the output; here
    it collapses to a single direct comparison of what "disp_u11/art_9"
    itself held before and after, which is a real "modified" (its
    departing content differs from what the number gained)."""
    before = [
        _a("disp_u10/art_1", "W"),
        _a("disp_u11/art_1", "X"), _a("disp_u11/art_2", "X2"),
        _a("disp_u11/art_3", "X3"), _a("disp_u11/art_9", "Y"),
    ]
    after = [
        _a("disp_u11/art_1", "W"), _a("disp_u11/art_9", "Z"),
        _a("disp_u12/art_1", "X"), _a("disp_u12/art_2", "X2"),
        _a("disp_u12/art_3", "X3"),
    ]
    changes = d.diff(before, after)
    ids = [c.e_id for c in changes]
    assert len(ids) == len(set(ids)), f"duplicate eId in output: {changes}"
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u11/art_9", "modified")]


_DETERMINISM_SCRIPT = """
import sys
sys.path.insert(0, sys.argv[1])
from chpipe import diff_articles as d


def _a(e_id, text):
    return {"e_id": e_id, "article_number": e_id.split("_")[-1], "text": text}


def art(container, suffix, text):
    return _a("disp_u%s%s" % (container, suffix), text)


# Two OLD containers (20, 21) disappear entirely -- neither container
# NUMBER survives into the after edition under any name -- while two NEW
# containers (30, 31) appear entirely fresh, and both pairs share the
# identical suffix "/art_1". This is deliberately NOT a shift chain where
# some container numbers persist (10, 12, 13 staying put, only 11 leaving
# and 14 arriving) -- that shape gives the old per-eId-suffix mechanism
# exactly one candidate per suffix, so its collision path never fires and
# a test built on it cannot be RED against the bug it claims to catch.
# Verified directly against round 2's actual removed_by_suffix dict (built
# from a bare set of removed eIds): this exact shape produces
# ('disp_u20/art_1', 'repealed') + ('disp_u30/art_1', 'modified') under one
# PYTHONHASHSEED and ('disp_u21/art_1', 'repealed') +
# ('disp_u31/art_1', 'modified') under another -- genuinely different
# output, not just a different row order.
before = [art(20, "/art_1", "A"), art(21, "/art_1", "B")]
after = [art(30, "/art_1", "A"), art(31, "/art_1", "B")]
changes = d.diff(before, after)
print([(c.e_id, c.change_type) for c in changes])
"""


def test_diff_is_deterministic_across_process_hash_seeds():
    """round 2's per-eId reconciliation filled removed_by_suffix by
    iterating removed_ids, a set of strings; Python randomises string
    hashing per process, so which of several same-suffix candidates won a
    collision was not the same run to run -- measured on the real
    2021-07-01 -> 2022-01-01 transition, 354 or 355 total rows depending on
    PYTHONHASHSEED.

    A round-3 version of this test used a shift-chain input (containers
    10-13 shifting to 12-14, container 10 staying put) that turned out to
    give round 2's mechanism only one candidate per suffix -- its
    collision path never fired, so the test passed against round 2's
    actual buggy code and proved nothing. Corrected: the script above uses
    two containers that disappear entirely and two that appear entirely,
    verified DIRECTLY against round 2's code (checked out from git,
    imported in isolation) to produce different output under different
    hash seeds before this test existed to catch it -- real RED evidence,
    not an assumption.

    Runs the same script under three different process hash seeds against
    the CURRENT code and checks the actual stdout is byte-identical -- not
    just "this test happens to pass in this process"."""
    chpipe_dir = str(pathlib.Path(__file__).parent.parent)
    outputs = set()
    for seed in ("0", "1", "42"):
        env = dict(os.environ)
        env["PYTHONHASHSEED"] = seed
        result = subprocess.run(
            [sys.executable, "-c", _DETERMINISM_SCRIPT, chpipe_dir],
            env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        outputs.add(result.stdout.strip())
    assert len(outputs) == 1, f"diff() output differs across hash seeds: {outputs}"
