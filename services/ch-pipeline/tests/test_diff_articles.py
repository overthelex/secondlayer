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


def test_a_content_preserving_split_produces_no_change():
    """A container split where the moved half's content is UNCHANGED --
    not the reworded-and-shifted shape covered above, but a plain
    relocation -- must produce no rows at all. "disp_u11" keeps "/art_1"
    and loses "/art_2" to a brand-new "disp_u12"; the content itself never
    changed, only which container number holds it. Verified this is not
    hypothetical: this exact input produces
    [('disp_u11/art_2', 'repealed'), ('disp_u12/art_2', 'added')] against
    the code as committed before this fix (confirmed by checking that
    version out and running it in isolation) -- fabricated rows, not
    contradictory ones (_deduplicate had nothing to catch here), which is
    why this needed the cross-candidate move reconciliation, not just the
    de-duplication safety net."""
    before = [_a("disp_u11/art_1", "X"), _a("disp_u11/art_2", "Y")]
    after = [_a("disp_u11/art_1", "X"), _a("disp_u12/art_2", "Y")]
    assert d.diff(before, after) == []


def test_a_content_preserving_merge_produces_no_change():
    """The mirror shape: two containers merge into one, and the joining
    half's content is unchanged. "disp_u11" keeps "/art_1" and gains
    "/art_5" (unchanged content moved in from "disp_u12", which then has
    nothing left). Verified this is not hypothetical: this exact input
    produces [('disp_u11/art_5', 'added'), ('disp_u12/art_1', 'repealed')]
    against the pre-fix code. This shape specifically needs the moved-
    article pool to include candidates generated FROM INSIDE a confirmed
    container pair (here, "disp_u11/art_5" is a new-only suffix of the
    pair that already matched "disp_u11" to itself) -- reconciling only
    the plain fallback remainder, as an earlier version of this
    mechanism did, would never see it, since it never reaches the
    fallback at all."""
    before = [_a("disp_u11/art_1", "X"), _a("disp_u12/art_1", "Y")]
    after = [_a("disp_u11/art_1", "X"), _a("disp_u11/art_5", "Y")]
    assert d.diff(before, after) == []


def test_a_move_across_unrelated_containers_with_a_wording_change_stays_two_rows():
    """Decision, not a regression fix: this input already produced these
    same two rows before this round's change (nothing prior ever merged
    unmatched, differently-worded content), so this locks the DECISION in
    rather than demonstrating a bug fix. A provision that moves AND is
    reworded in the same edition, landing in a container with no
    structural correspondence to its origin (not a renumbered continuation
    of the same container -- see
    test_disp_container_renumbering_with_a_wording_change_is_one_modified_row
    for that case, which already produces one "modified" row via
    container-pairing), is NOT collapsed into one row here. Its
    fingerprint changed, so exact-identity matching correctly does not
    claim it moved; pairing it by similarity instead would risk merging
    two DIFFERENT, merely similarly-worded provisions elsewhere in a
    17,293-act corpus, which is a worse failure than the conservative
    answer: a real repeal of the old identifier and a real addition of
    the new one, asserting no continuity this module cannot verify."""
    before = [_a("disp_u50/art_m", "Old wording")]
    after = [_a("disp_u60/art_n", "New wording")]
    assert [(c.e_id, c.change_type) for c in d.diff(before, after)] == [
        ("disp_u50/art_m", "repealed"),
        ("disp_u60/art_n", "added"),
    ]


def test_coincidental_boilerplate_is_not_evidence_of_a_move():
    """The finding that closed this sequence: fingerprint identity ALONE
    is not evidence of a move -- it is evidence of identical text, which a
    generic delegation clause ("Der Bundesrat regelt die Einzelheiten.",
    exactly the kind of sentence Swiss transitional provisions repeat
    verbatim) produces routinely between containers that have nothing to
    do with each other. Container 10 vanishes entirely; container 30 is
    brand new; they share no suffix and never come near
    _match_containers(). Verified this is not hypothetical: this exact
    input produced [] against an earlier version of this function that
    matched on identity alone, silently erasing a genuine repeal AND a
    genuine, unrelated addition with no trace -- the inverse of every
    other defect in this module's history, and worse: a fabricated row is
    auditable, a suppressed one is invisible. With no corroboration (the
    two containers share no other suffix, and there is only one match
    connecting them), the fix correctly falls back to reporting both."""
    before = [_a("disp_u10/art_1", "Der Bundesrat regelt die Einzelheiten.")]
    after = [_a("disp_u30/art_9", "Der Bundesrat regelt die Einzelheiten.")]
    assert [(c.e_id, c.change_type) for c in d.diff(before, after)] == [
        ("disp_u10/art_1", "repealed"),
        ("disp_u30/art_9", "added"),
    ]


def test_boilerplate_collision_is_rejected_even_with_a_stable_sibling():
    """Rules out the narrower theory that the bug above only fires when a
    container disappears/appears wholesale: container 10 here keeps an
    unrelated, unchanged article ("/art_5") on both sides, ruling out any
    "whole container vanished" coincidence, and the boilerplate match
    (container 10's "/art_1" vs container 30's "/art_9") still has no
    corroboration of its own -- the two containers share no suffix NAME at
    all ("/art_1"/"/art_5" vs "/art_9"), and only one sentence connects
    them. Still rejected, still two rows."""
    before = [
        _a("disp_u10/art_1", "Der Bundesrat regelt die Einzelheiten."),
        _a("disp_u10/art_5", "Stabiler Text."),
    ]
    after = [
        _a("disp_u10/art_5", "Stabiler Text."),
        _a("disp_u30/art_9", "Der Bundesrat regelt die Einzelheiten."),
    ]
    assert [(c.e_id, c.change_type) for c in d.diff(before, after)] == [
        ("disp_u10/art_1", "repealed"),
        ("disp_u30/art_9", "added"),
    ]


def test_ambiguous_moves_are_paired_off_deterministically_when_corroborated():
    """Decision: when a removed eId's text matches more than one added
    candidate, the shorter candidate list is paired against the other in
    SORTED eId order -- but each individual pairing still needs its own
    corroboration (see _reconcile_moved_disp_articles()'s docstring); an
    ambiguous match that happens to lack it is rejected like any other
    uncorroborated one, not waved through because some OTHER candidate
    with the same text was legitimate.

    Two candidate pairings share the text "SAME": containers 30 -> 40 and
    31 -> 41. 30 -> 40 also share a SECOND, independent match ("OTHER"),
    corroborating them via two matches connecting the same two containers
    -- both moves accepted, no rows. 31 -> 41 have only the one "SAME"
    match, share no suffix name, and are corroborated by nothing -- that
    pairing is rejected, and both sides fall back to a genuine repeal and
    a genuine addition, exactly the safe-direction behaviour the
    coincidental-boilerplate tests above establish, now shown alongside a
    pairing that IS legitimately reconciled in the same call."""
    before = [
        _a("disp_u30/art_x", "SAME"), _a("disp_u30/art_y", "OTHER"),
        _a("disp_u31/art_m", "SAME"),
    ]
    after = [
        _a("disp_u40/art_p", "SAME"), _a("disp_u40/art_q", "OTHER"),
        _a("disp_u41/art_r", "SAME"),
    ]
    assert [(c.e_id, c.change_type) for c in d.diff(before, after)] == [
        ("disp_u31/art_m", "repealed"),
        ("disp_u41/art_r", "added"),
    ]



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


# --- Final gate B6: an ordinary-article renumbering ----------------------
#
# The real transition, SR 220 2021-07-01 -> 2022-01-01: three new articles
# are inserted at the head of one chapter, pushing art_964a..964f down to
# art_964d..964i. Five of the six are byte-identical after normalisation;
# the sixth was reworded on the way. Before this fix the shipped diff() emitted
# six "modified" rows for provisions whose text never changed plus three
# "added" at eIds that are old provisions renumbered -- 6 of 15 rows, 40% of
# that transition's change log, false.

_SHIFT_BEFORE = [
    _a("art_963", "Konzernrechnung."),
    _a("art_964_a", "Rohstoffzahlungen: Grundsatz.", number="964a"),
    _a("art_964_b", "Rohstoffzahlungen: Form.", number="964b"),
    _a("art_964_c", "Rohstoffzahlungen: Inhalt.", number="964c"),
    _a("art_964_d", "Rohstoffzahlungen: Umfang.", number="964d"),
    _a("art_964_e", "Rohstoffzahlungen: Veroeffentlichung.", number="964e"),
    _a("art_964_f", "Der Bundesrat kann Ausnahmen vorsehen.", number="964f"),
    _a("art_965", "Wertpapiere."),
]
_SHIFT_AFTER = [
    _a("art_963", "Konzernrechnung."),
    _a("art_964_a", "Nichtfinanzielle Belange: Grundsatz.", number="964a"),
    _a("art_964_b", "Nichtfinanzielle Belange: Inhalt.", number="964b"),
    _a("art_964_c", "Nichtfinanzielle Belange: Genehmigung.", number="964c"),
    _a("art_964_d", "Rohstoffzahlungen: Grundsatz.", number="964d"),
    _a("art_964_e", "Rohstoffzahlungen: Form.", number="964e"),
    _a("art_964_f", "Rohstoffzahlungen: Inhalt.", number="964f"),
    _a("art_964_g", "Rohstoffzahlungen: Umfang.", number="964g"),
    _a("art_964_h", "Rohstoffzahlungen: Veroeffentlichung.", number="964h"),
    _a("art_964_i", "Der Bundesrat kann im Rahmen eines international "
                    "abgestimmten Vorgehens Ausnahmen vorsehen.", number="964i"),
    _a("art_965", "Wertpapiere."),
]


def test_a_top_level_renumbering_is_not_diffed_as_content_change():
    changes = d.diff(_SHIFT_BEFORE, _SHIFT_AFTER)
    assert [(c.e_id, c.change_type) for c in changes] == [
        # genuinely new text under a reused identifier
        ("art_964_a", "added"),
        ("art_964_b", "added"),
        ("art_964_c", "added"),
        # art_964_d..art_964_h: the shift itself, no rows at all
        # the one member of the shift that was also reworded, at the eId the
        # provision now carries
        ("art_964_i", "modified"),
    ]


def test_the_shifted_provisions_produce_no_row_at_all():
    """Stated separately from the row list above because it is the actual
    claim: five provisions whose text did not change must not appear."""
    moved = {"art_964_d", "art_964_e", "art_964_f", "art_964_g", "art_964_h"}
    assert {c.e_id for c in d.diff(_SHIFT_BEFORE, _SHIFT_AFTER)} & moved == set()


def test_two_identical_pairs_are_not_enough_to_claim_a_renumbering():
    """Corroboration, not identity, is what licenses the claim. Two
    consecutive verbatim reappearances at one offset stay an ordinary
    modified/added/repealed reading."""
    before = [_a("art_1", "aaa"), _a("art_2", "bbb"), _a("art_3", "ccc")]
    after = [_a("art_1", "zzz"), _a("art_2", "aaa"), _a("art_3", "bbb")]
    kinds = {(c.e_id, c.change_type) for c in d.diff(before, after)}
    assert kinds == {("art_1", "modified"), ("art_2", "modified"),
                     ("art_3", "modified")}


def test_repeated_boilerplate_is_never_evidence_of_a_renumbering():
    """The trap _reconcile_moved_disp_articles() measured, in this half of
    the eId space: a text that occurs more than once on either side says
    nothing about which provision continues which, so an ambiguous
    fingerprint is refused outright rather than paired off against its first
    occurrence.

    Three DIFFERENT boilerplate sentences, each appearing twice on both
    sides, at three consecutive positions one step apart. Pairing each
    fingerprint's first occurrence would clear the corroboration bar with
    three same-offset "identical" pairs and claim a renumbering that did not
    happen. Nothing here moved that can be told apart from anything else."""
    x = "Der Bundesrat regelt die Einzelheiten."
    y = "Vorbehalten bleiben die kantonalen Vorschriften."
    z = "Das Verfahren richtet sich nach der ZPO."
    before = [_a("art_1", x), _a("art_2", y), _a("art_3", z),
              _a("art_4", x), _a("art_5", y), _a("art_6", z),
              _a("art_7", "Schlussbestimmung.")]
    after = [_a("art_1", "Ganz neuer Text."), _a("art_2", x), _a("art_3", y),
             _a("art_4", z), _a("art_5", x), _a("art_6", y), _a("art_7", z)]

    assert d._shifted_article_pairs(before, after) == []


def test_a_shift_stops_at_the_first_unchanged_neighbour():
    """The extension past the byte-identical run is what catches a member
    reworded on the way; it must not walk off into the rest of the act. An
    unchanged neighbour's text occurs on both sides, so it is accounted for
    and the run ends there -- art_965 keeps its own identity."""
    changes = d.diff(_SHIFT_BEFORE, _SHIFT_AFTER)
    assert "art_965" not in {c.e_id for c in changes}
    assert "art_963" not in {c.e_id for c in changes}


def test_a_shift_leaves_transitional_containers_to_the_disp_machinery():
    """Scopes are disjoint by construction: disp-scoped eIds are excluded
    from the shift detector entirely, so the two mechanisms can never offer
    competing readings of the same row."""
    before = [_a(f"disp_u11/art_{i}", f"t{i}") for i in range(1, 5)]
    after = [_a(f"disp_u12/art_{i}", f"t{i}") for i in range(1, 5)]
    assert d._shifted_article_pairs(before, after) == []
    assert d.diff(before, after) == []


def test_a_reworded_member_in_the_middle_of_the_block_splits_nothing():
    """The re-review's failing shape: the same six-article displacement as
    _SHIFT_BEFORE/_SHIFT_AFTER, but with the reworded member in the MIDDLE
    of the block instead of at its end. The byte-identical positions then
    fall into two runs -- three before the reworded member, two after -- and
    gating each run alone left the far pair unclaimed: its old eIds became
    `repealed` and its new eIds `added`, four fabricated rows for provisions
    whose text survives verbatim three positions along. A `repealed` row for
    a provision that still exists is a stronger wrong claim than the
    `modified` pair the shift detector exists to remove."""
    before = [
        _a("art_963", "Anwendbarkeit."),
        _a("art_964_a", "AAA text."),
        _a("art_964_b", "BBB text."),
        _a("art_964_c", "CCC text."),
        _a("art_964_d", "DDD old wording."),   # reworded on the way
        _a("art_964_e", "EEE text."),
        _a("art_964_f", "FFF text."),
        _a("art_965", "Wertpapiere."),
    ]
    after = [
        _a("art_963", "Anwendbarkeit."),
        _a("art_964_a", "New topic one."),     # genuinely new under reused ids
        _a("art_964_b", "New topic two."),
        _a("art_964_c", "New topic three."),
        _a("art_964_d", "AAA text."),
        _a("art_964_e", "BBB text."),
        _a("art_964_f", "CCC text."),
        _a("art_964_g", "DDD new wording."),   # the reworded member
        _a("art_964_h", "EEE text."),
        _a("art_964_i", "FFF text."),
        _a("art_965", "Wertpapiere."),
    ]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [
        ("art_964_a", "added"),
        ("art_964_b", "added"),
        ("art_964_c", "added"),
        ("art_964_g", "modified"),
    ]
    assert not any(c.change_type == "repealed" for c in changes), \
        "nothing was repealed: every displaced text survives verbatim"


def test_a_displaced_straggler_across_a_gap_is_not_repealed():
    """The same class, minimal form: one displaced article separated from
    the qualifying run by a member whose rewording keeps its text 'accounted
    for' on neither side -- the bridge is unaccounted, the straggler is a
    same-offset verbatim reappearance, and both belong to the one block."""
    before = [_a("art_1", "aaa"), _a("art_2", "bbb"), _a("art_3", "ccc"),
              _a("art_4", "old ddd"), _a("art_5", "eee"),
              _a("art_9", "tail")]
    after = [_a("art_0_a", "new head"),
             _a("art_1", "aaa"), _a("art_2", "bbb"), _a("art_3", "ccc"),
             _a("art_4", "new ddd"), _a("art_5", "eee"),
             _a("art_9", "tail")]
    # positions shift by +1; art_1..art_3 seed the run, art_4 is the
    # unaccounted bridge, art_5 the straggler beyond it.
    before2 = [_a(f"art_{n}", t) for n, t in
               (("1", "aaa"), ("2", "bbb"), ("3", "ccc"),
                ("4", "old ddd"), ("5", "eee"))]
    after2 = [_a(f"art_{n}", t) for n, t in
              (("1", "brand new"), ("2", "aaa"), ("3", "bbb"),
               ("4", "ccc"), ("5", "new ddd"), ("6", "eee"))]
    changes = d.diff(before2, after2)
    assert not any(c.change_type == "repealed" for c in changes)
    assert ("art_6", "added") not in {(c.e_id, c.change_type) for c in changes}
