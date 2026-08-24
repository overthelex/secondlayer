"""Per-article difference between two consecutive editions of one act.

Comparison is on a normalised fingerprint, not raw text: Fedlex re-typesets
editions, so whitespace, dash, quote and ellipsis variants differ between
editions of the same unchanged article. Both an en dash and an em dash occur
inside a single act, and treating either as an amendment would fabricate
changes by the thousand. Measured on one real edition of the OR: folding
these variants (plus the en/em/non-breaking dash and minus-sign folding
below, and stripping <authorialNote> footnotes out of the text this module
is handed -- see chpipe/akn.py) is not cosmetic tuning; an earlier version of
this module without it certified 165 of 408 "modified" rows as real
wording changes when they were re-typesetting noise -- see
chpipe/stages/diff_stage.py's module docstring for the measured breakdown.

Articles are matched on eId, never on article number: verified in the real OR
XML that 'art_7' and 'disp_u17/art_7' coexist with the number 7 -- 1,686
articles but only 1,604 distinct numbers in one real edition (measured
directly against the live 2026-01-01 German XML, not assumed), so 82 would
collide if keyed on the number instead.

eId is not stable across editions either, though, and that is a sharper
problem than a collision. Fedlex renumbers a transitional-provisions
container (an eId shaped "disp_u<N>/...") wholesale whenever a new block is
inserted before it: not just one container renamed, but every container from
the insertion point onward shifted up by one -- "disp_u11" becomes
"disp_u12", "disp_u12" becomes "disp_u13", and so on, all in the same
edition. Two consequences follow that a per-article rename lookup cannot
handle:

  * SUFFIX COLLISIONS. Every shifted container holds articles under the same
    internal suffixes ("/art_1", "/art_2", ...), so a removed eId
    ("disp_u11/art_1") and several added eIds ("disp_u12/art_1",
    "disp_u13/art_1", ...) can share the identical suffix. Measured on the
    real 2021-07-01 -> 2022-01-01 transition: 28 removed disp eIds share
    only 20 distinct suffixes, 8 of the 20 with two or more candidates.
    Resolving that by filling a dict from a set of removed eIds -- as an
    earlier version of this module did -- makes the result depend on
    Python's per-process string hash randomisation: which candidate wins a
    collision is not the same run to run. Measured across six
    PYTHONHASHSEED values on that exact transition: 354 or 355 total rows.
    A change log that differs between runs cannot be audited, and
    diff_stage's ON CONFLICT ... DO UPDATE would silently rewrite a stored
    change_type on every re-run, and orphan rows it stops emitting.
  * RE-POINTED eIds. A shift keeps most eId STRINGS alive while re-pointing
    them at a different provision: "disp_u12/art_1" is one provision before
    the shift and a completely different one (the provision that used to
    live at "disp_u11/art_1") after it. Because the string "disp_u12/art_1"
    exists on both sides, it never appears in an added/removed set at all --
    matched naively by eId, it goes straight through the same-eId path and
    is diffed against unrelated content, fabricating a "modified" row for
    every article in the shift.

Ordinary, non-disp articles are renumbered too, by a different mechanism
that produces the same re-pointing: Fedlex inserts new articles at the head
of a chapter and pushes the existing ones down a letter each. SR 220
2021-07-01 -> 2022-01-01 does exactly this -- art_964a..964f become
art_964d..964i, five of the six byte-identical -- and there the CONTAINER
(part_4/tit_32/chap_7) is the same on both sides while the articles inside
it shift, which is the inverse of the disp case and needs its own
mechanism. _shifted_article_pairs() below is it: exact content identity on
fingerprints that are unique on both sides, corroborated by at least three
consecutive pairs agreeing on one displacement in document order. Its
scope is precisely the eIds the container machinery excludes.

diff() reconciles the disp shifts by aligning whole CONTAINERS, not individual eIds:
_match_containers() scores every (before-container, after-container) pair by
how much of their content overlaps (shared internal suffixes, tie-broken by
how many of those are fingerprint-identical) and confirms a pairing only
when each side independently picks the other as its best match. That is
deterministic by construction -- every collection touched is iterated in
`sorted()` order and every tie is broken by an explicit numeric comparison,
never a bare dict/set iteration -- and it resolves a suffix collision by
CONTENT rather than by whichever candidate a hash-ordered walk visits last.
Once two containers are confirmed paired, their articles are aligned by
suffix (which is what "positionally" means here: the suffix is the stable
identifier for "this provision's place in the container", independent of
which container number holds it) and compared exactly like same-eId
articles. A rename that also carries a genuine wording change, or an actual
repeal, therefore still produces exactly one correctly-typed row -- never
silently dropped, never a fabricated repeal+addition pair. See
_match_containers() and diff() for the mechanism, and _disp_container() for
why this can only ever pair two disp-scoped containers against each other,
never an ordinary top-level article.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

_WHITESPACE = re.compile(r"\s+")
# Every dash variant the corpus has actually been observed to use, folded to
# a plain hyphen, plus a genuine non-breaking-space fold (U+00A0 -> U+0020;
# this table used to carry a "  " entry that read as that fold and
# was not one -- it mapped plain space to itself, a no-op that the
# whitespace-collapsing step below made invisible either way, since \s
# already treats U+00A0 as whitespace. Kept explicit here anyway, next to
# the other Unicode folds, rather than relying on that coincidence).
_DASHES = str.maketrans({
    "–": "-", "—": "-", "‐": "-", "‑": "-", "−": "-", " ": " ",
})
_QUOTES = str.maketrans({"«": '"', "»": '"', "„": '"', "“": '"', "”": '"',
                         "’": "'", "‘": "'"})

# An edition keeps the article and replaces its body with a repeal marker. That
# is a repeal, not a rewording, and the distinction is the point of the log.
_REPEAL_MARKERS = frozenset({
    "aufgehoben", "abrogé", "abrogée", "abrogato", "abrogata", "abroge",
})

# "disp_u15/art_1" -> (15, "/art_1"): a transitional-container eId split
# into its container number and the suffix that identifies WHICH provision
# this is within the container, independent of the container's own number.
# Anchored specifically to "disp_u<digits>/" so this can only ever group
# disp-scoped eIds -- an ordinary top-level article's eId (no disp_u prefix)
# never matches, and is never touched by the container-alignment machinery
# below.
_DISP_CONTAINER = re.compile(r"^disp_u(\d+)(/.+)$")


@dataclass(frozen=True)
class Change:
    e_id: str
    article_number: str | None
    change_type: str


def normalise(text: str) -> str:
    folded = unicodedata.normalize("NFC", text or "")
    folded = folded.translate(_DASHES).translate(_QUOTES)
    # Fedlex is not internally consistent about which ellipsis character it
    # uses for a struck-out paragraph -- a single U+2026 in one place, three
    # literal periods in another, inside the same act. Folding to one form
    # here is also what lets _is_repealed()'s ".strip(' .')" recognise a
    # body that is nothing BUT the elided-paragraph marker: once folded to
    # "...", stripping "." and " " from the ends leaves "", the same empty
    # string a genuinely blank body normalises to.
    folded = folded.replace("…", "...")
    return _WHITESPACE.sub(" ", folded).strip().lower()


def fingerprint(text: str) -> str:
    return hashlib.sha256(normalise(text).encode("utf-8")).hexdigest()


def _is_repealed(text: str) -> bool:
    """True for an explicit repeal marker ("Aufgehoben"/"Abrogé"/"Abrogato"),
    for Fedlex's ellipsis-only struck-paragraph marker (folded to "..." by
    normalise(), then stripped to "" here), AND for a genuinely empty body
    (normalises to ""). All three mean the article kept its eId and number
    but lost its wording -- a repeal, not a rewording, since there is no
    wording left to compare against the old text. This is the branch that
    catches an article going from real text to truly empty: 75 of 1,686
    articles in one real edition of the OR carry no marker word at all, just
    an empty body. An article that DISAPPEARS outright (its eId no longer
    occurs in the later edition) is a different case entirely, handled by
    diff()'s "in before, not in after" branch below -- and even there, an
    already-empty article is exempted too; see _repealed_change().
    """
    stripped = normalise(text).strip(" .")
    return stripped == "" or stripped in _REPEAL_MARKERS


def _disp_container(e_id: str) -> tuple[int, str] | None:
    match = _DISP_CONTAINER.match(e_id)
    return (int(match.group(1)), match.group(2)) if match else None


def _group_disp_containers(articles: dict[str, dict]) -> dict[int, dict[str, dict]]:
    """Every disp-scoped article in `articles`, grouped by container number
    and keyed within each container by its suffix (see _disp_container).
    An ordinary top-level article contributes nothing here."""
    groups: dict[int, dict[str, dict]] = {}
    for e_id, article in articles.items():
        parsed = _disp_container(e_id)
        if parsed is not None:
            n, suffix = parsed
            groups.setdefault(n, {})[suffix] = article
    return groups


def _container_score(old_group: dict[str, dict],
                     new_group: dict[str, dict]) -> tuple[int, int]:
    """(how many shared suffixes are fingerprint-IDENTICAL, total shared
    suffix count). Compared as a tuple with identical-content count FIRST,
    not shared-suffix count first: two disp containers routinely reuse the
    same small set of suffix names ("/art_1", "/art_2", ...) for entirely
    unrelated provisions, so a coincidental name-only overlap with zero
    matching content must never outscore a smaller but genuinely
    content-identical overlap. Measured: scoring shared-count first let a
    container that merely happened to share MORE suffix NAMES (but matched
    NONE of their content) beat the container that actually was the
    renumbered continuation -- the exact mechanism behind a real container
    losing an article (a genuine repeal riding along with a shift) being
    mismatched entirely, because losing that one suffix was enough for an
    unrelated same-named-but-different-content container to win on raw
    count. Prioritising identical content is robust to that: a container
    that lost one of several articles still has every OTHER article
    matching byte-for-byte, which no coincidental name collision can beat
    unless it is ALSO substantively identical. Zero shared suffixes is
    never a match."""
    shared = old_group.keys() & new_group.keys()
    if not shared:
        return (0, 0)
    identical = sum(
        1 for suffix in shared
        if fingerprint(old_group[suffix].get("text", "")) ==
           fingerprint(new_group[suffix].get("text", "")))
    return (identical, len(shared))


def _match_containers(old_disp: dict[int, dict[str, dict]],
                      new_disp: dict[int, dict[str, dict]]) -> list[tuple[int, int]]:
    """Pair a `before` disp-container number with an `after` one when their
    content overlaps enough to be confident they are the same container,
    possibly renumbered by a Fedlex wholesale shift -- see the module
    docstring. Mutual-best-match: a pair is confirmed only when each side
    independently picks the other as its own best-scoring candidate, which
    is what stops a coincidental single-suffix overlap from creating a
    false pairing.

    Deterministic by construction: `sorted()` drives every loop, and ties in
    _container_score are broken by two more explicit numeric comparisons
    (closest container number, then smallest container number) -- never a
    bare dict/set iteration, which is exactly what made the previous
    per-eId-suffix version's output depend on PYTHONHASHSEED.
    """
    def best_match(source: int, candidates: dict[int, dict[str, dict]],
                   score_of) -> int | None:
        best_n, best_key = None, None
        for candidate in sorted(candidates):
            score = score_of(candidate)
            if score == (0, 0):
                continue
            key = (score, -abs(candidate - source), -candidate)
            if best_key is None or key > best_key:
                best_key, best_n = key, candidate
        return best_n

    best_for_old = {
        n_b: best_match(n_b, new_disp, lambda n_a, n_b=n_b:
                        _container_score(old_disp[n_b], new_disp[n_a]))
        for n_b in sorted(old_disp)
    }
    best_for_new = {
        n_a: best_match(n_a, old_disp, lambda n_b, n_a=n_a:
                        _container_score(old_disp[n_b], new_disp[n_a]))
        for n_a in sorted(new_disp)
    }

    return [(n_b, n_a) for n_b, n_a in sorted(best_for_old.items())
            if n_a is not None and best_for_new.get(n_a) == n_b]


def _compare(e_id: str, article_number: str | None,
            old_text: str, new_text: str) -> Change | None:
    """The Change (if any) that explains `old_text` becoming `new_text`
    under `e_id`. Shared by the ordinary same-eId comparison and the
    container-alignment comparison -- the two cases differ only in WHICH
    eId's before/after text is being compared, not in how "changed" is
    decided.

    KNOWN AND ACCEPTED: a paragraph's <num> LABEL is inside the text this
    compares, so correcting a label alone scores as a change. The one real
    instance found is art_624, whose paragraph label reads "2 e 3" in one
    German file and "2 und 3" in another -- an Italian "e" that leaked into
    the German edition and was later corrected. This IS reachable from a
    real edition transition: against the manifestations Fedlex's own graph
    points at (the fileUrl VERSIONS binds and versions_stage stores),
    SR 220's 2025-10-01 -> 2026-01-01 diff carries art_624 as its eighth
    row, because the re-issue that fixed the label landed inside the
    2026-01-01 manifestation. (An earlier note here claimed the opposite; it
    was measured against a hand-built URL the pipeline never fetches.) So
    the cost is one spurious `modified` row per label correction per
    affected transition -- rare, but real and served. Left alone
    deliberately, on cost alone: excluding the label would mean
    separating paragraph numbering from operative text in chpipe/akn.py,
    which changes ch_act_article.text, hence full_text, hence the served
    ch_legislation rows and their full-text index, for every article in the
    corpus. That is a corpus-wide re-parse to remove one row per re-issue,
    and it is not a change to make without being able to re-run and measure
    it."""
    if fingerprint(old_text) == fingerprint(new_text):
        return None
    kind = "repealed" if (_is_repealed(new_text) and not _is_repealed(old_text)) \
        else "modified"
    return Change(e_id, article_number, kind)


def _added_change(article: dict) -> Change | None:
    """None for an eId with no prior existence at all whose body is already
    empty or a repeal marker the moment it first appears -- it never
    carried operative text under this identifier, so there is nothing to
    assert was added. Measured: 7 real rows in one edition of the OR were
    exactly this case."""
    text = article.get("text", "")
    if _is_repealed(text):
        return None
    return Change(article["e_id"], article.get("article_number"), "added")


def _repealed_change(article: dict) -> Change | None:
    """None for an eId that was ALREADY carrying no operative text (an
    earlier repeal marker, or a genuinely empty body) at the moment it
    disappears entirely -- there is nothing left to take out of force a
    second time. Symmetric with _added_change()'s already-empty-at-birth
    rule. Measured: 7 rows in an earlier version of this module were
    exactly this, 5 of them outside the disp cluster."""
    text = article.get("text", "")
    if _is_repealed(text):
        return None
    return Change(article["e_id"], article.get("article_number"), "repealed")


def _deduplicate(changes: list[Change], old: dict[str, dict],
                 new: dict[str, dict]) -> list[Change]:
    """No eId may appear twice in diff()'s output.

    It can, in principle, despite _match_containers()'s mutual-best-match:
    a container split or merge can pair OLD container A with NEW container
    B (producing a "repealed" row for a suffix A had that B does not)
    while SEPARATELY pairing some OTHER old container with NEW container A
    -- the SAME container NUMBER, now holding different, re-pointed
    content (producing an "added" row for a suffix that number gained).
    Both rows can legitimately name the exact same eId string, because the
    string itself never moved -- only what each side's alignment thinks it
    means did.

    When that happens, both container-derived guesses are discarded and
    the literal ground truth wins: the eId string exists in both `old` and
    `new` in exactly this scenario (it never stopped being a real key in
    either dict; the container grouping just routed it two different
    ways), so the two contradictory rows collapse into ONE direct
    _compare() of what that exact identifier held before and after,
    ignoring which container each side happened to be grouped into. That
    is always well-defined -- it never needs an arbitrary "repealed wins
    over added" rule, because there is a real answer sitting right there
    in `old`/`new`. Nothing else can produce a duplicate under this
    module's design (verified: within one confirmed pair each suffix maps
    to exactly one row and one eId; across pairs, each container number is
    claimed by at most one pair; the plain eId fallback only ever sees eIds
    excluded from every confirmed pair) -- but this runs unconditionally
    rather than trusting that proof to stay true as the module evolves.
    """
    by_id: dict[str, list[Change]] = {}
    for change in changes:
        by_id.setdefault(change.e_id, []).append(change)

    resolved: list[Change] = []
    for e_id, candidates in by_id.items():
        if len(candidates) == 1:
            resolved.append(candidates[0])
            continue
        old_article, new_article = old.get(e_id), new.get(e_id)
        if old_article is not None and new_article is not None:
            change = _compare(e_id, new_article.get("article_number"),
                              old_article.get("text", ""),
                              new_article.get("text", ""))
        elif new_article is not None:
            change = _added_change(new_article)
        elif old_article is not None:
            change = _repealed_change(old_article)
        else:
            change = None
        if change is not None:
            resolved.append(change)

    return resolved


def _index_by_fingerprint(articles: dict[str, dict]) -> dict[str, list[str]]:
    """fingerprint(text) -> the eIds carrying that exact (normalised) text
    among `articles`, sorted. Sorted so that any consumer matching against
    this index is deterministic regardless of dict iteration order --
    never trust a bare dict/set walk to be stable across processes; see
    _match_containers()'s docstring for why that matters here."""
    index: dict[str, list[str]] = {}
    for e_id, article in articles.items():
        index.setdefault(fingerprint(article.get("text", "")), []).append(e_id)
    for e_ids in index.values():
        e_ids.sort()
    return index


def _reconcile_moved_disp_articles(
        removed_candidates: dict[str, dict],
        added_candidates: dict[str, dict],
        old_disp: dict[int, dict[str, dict]],
        new_disp: dict[int, dict[str, dict]]) -> tuple[set[str], set[str]]:
    """Beyond a single container's renumbering (see _match_containers), a
    provision can move to a container that never pairs with its origin at
    all: a container splits, sending part of its content elsewhere while
    the rest stays; two containers merge into one. In either shape the
    moved content's destination is not its origin container's structural
    continuation, so _match_containers() correctly declines to pair them
    (they are not the same container renumbered) -- and without the move
    reconciliation below, the moved content would be read as an unrelated
    repeal and an unrelated addition. Measured on a content-preserving
    split: one repealed row plus one added row where the correct answer is
    zero; on a content-preserving merge: two added plus two repealed where
    the correct answer is zero.

    `removed_candidates`/`added_candidates` are the FULL pool of
    "old-only"/"new-only" disp articles this diff() call has produced so
    far, from every source: a confirmed container pair's own old-only/
    new-only suffixes (a merge's moved half surfaces exactly there, as a
    new-only suffix of the container it lands in) AND the plain fallback
    for containers with no pairing at all (a split's moved half surfaces
    exactly there, since its destination container has no old-side
    counterpart to pair with). Reconciling only one of those two sources
    -- as an earlier version of this function did, checking solely the
    fallback remainder -- misses exactly the merge shape, where the moved
    content's "added" candidate is generated from INSIDE a pair, never
    reaching the fallback at all.

    FINGERPRINT IDENTITY ALONE IS NOT EVIDENCE OF A MOVE -- this is the
    correction to an earlier version of this function, which matched on
    identity across the ENTIRE pool with no requirement that the two
    containers be related at all. Measured: a generic delegation clause
    ("Der Bundesrat regelt die Einzelheiten.") repeated verbatim in two
    completely unrelated transitional containers made that version call
    it a move and silently erase BOTH a genuine repeal and a genuine,
    unrelated addition -- worse than every earlier defect in this module,
    because a suppressed row leaves no trace to audit, where a fabricated
    one at least invites scrutiny. Boilerplate sentences are exactly what
    Swiss transitional provisions repeat; identical text is common, a
    genuine renumbering relationship between two specific containers is
    not, and conflating the two was the bug.

    A fingerprint match is now accepted as move evidence only with
    CORROBORATION -- independent evidence that the two containers
    involved are actually related, not just that one sentence happens to
    read alike:

      (a) the two containers already score above (0, 0) under
          _container_score() -- i.e. they share at least one OTHER suffix
          NAME structurally (see _match_containers()), which two
          containers that split/merged from/into each other routinely do
          even where _match_containers() itself declined to pair them
          outright (that decision is about being confident enough to
          treat the WHOLE container as a continuation; a single shared
          suffix name is a much lower bar, and exactly what corroboration
          needs); or
      (b) at least two INDEPENDENT fingerprint matches connect the SAME
          two containers -- two separate sentences each moving between
          the same origin and destination is not the kind of thing
          coincidental boilerplate produces twice in a row.

    Absent either, the match is rejected and both sides fall back to a
    genuine repeal and a genuine addition. That is the safe direction: an
    over-reported move across genuinely unrelated containers is visible to
    a reader and can be disputed; an under-reported repeal is invisible.

    EMPTY OR MARKER-ONLY TEXT CAN NEVER BE MOVE EVIDENCE, corroborated or
    not: an empty body or a bare "Aufgehoben"/"Abrogé"/"Abrogato" (see
    _is_repealed()) matches every other empty or marker body in the same
    comparison, so treating it as move evidence would pair up unrelated
    repeals by coincidence just as surely as boilerplate prose does.
    Filtered out of both indexes before any matching happens -- not relied
    upon to be harmless via _added_change()/_repealed_change()'s own
    already-empty suppression downstream, which happens to produce the
    same silence today but is a coincidence this function does not lean
    on.

    SCOPE: both sides are filtered to disp-scoped eIds only (see
    _disp_container()), never ordinary top-level articles. Matching
    content alone across top-level articles risks exactly what
    test_unrelated_articles_with_identical_new_text_are_not_merged_into_a_rename
    guards against, and the corroboration rules above are expressed in disp
    CONTAINER NUMBERS, which an ordinary article does not have. An earlier
    version of this paragraph also claimed ordinary articles are not
    reshuffled; that is false, and SR 220 2021-07-01 -> 2022-01-01 is the
    counter-example (art_964a..964f renumbered to art_964d..964i). It is
    handled by _shifted_article_pairs(), which covers exactly the eIds this
    function excludes -- the two scopes are disjoint by construction, so
    they never offer competing readings of one row.

    A MOVE THAT ALSO CARRIES A WORDING CHANGE is deliberately NOT caught
    here: its fingerprint changes, so it will not reappear verbatim on the
    other side. This module already has a mechanism for "moved and
    reworded" -- container-pairing itself (_match_containers() plus
    _compare() on the intersection suffixes), which is exactly how Fedlex
    actually produces that combination: the SAME container's content,
    whole, landing in a new container number, possibly with some articles
    reworded along the way (see test_disp_container_renumbering_with_a_wording_change_is_one_modified_row).
    A wording change riding along with a move to an entirely different,
    non-corresponding container -- a split or merge, not a renumber -- is
    a compound, much rarer event this function does not attempt to guess
    at by similarity: doing so would reopen the exact false-positive risk
    the corroboration requirement above exists to close (two DIFFERENT,
    similarly-but-not-identically-worded provisions merged). Left as a
    repeal and an addition -- conservative, but it never asserts a
    continuity this function cannot verify by exact content.

    AMBIGUITY: if a removed eId's text matches several added candidates,
    or several removed eIds share the same text, the shorter of the two
    candidate lists for that fingerprint is paired off against the other
    in SORTED eId order, deterministically, regardless of dict/set
    iteration order (the exact defect class two earlier rounds of this
    module were sent back for). No judgement call is needed about WHICH
    physical eId "really" continues which: every eId sharing one
    fingerprint carries byte-identical (post-normalisation) text by
    definition, so which specific string labels which is genuinely
    arbitrary -- only the COUNT absorbed as "moved" matters, and each
    pairing still individually needs its own corroboration above; an
    excess candidate, or a pairing that fails corroboration, is judged a
    genuine repeal or addition on its own.

    Returns the eIds consumed on each side, NOT Change objects: a moved
    provision produces no Change at all.
    """
    old_index = _index_by_fingerprint(
        {e_id: a for e_id, a in removed_candidates.items()
         if _disp_container(e_id) is not None
         and not _is_repealed(a.get("text", ""))})
    new_index = _index_by_fingerprint(
        {e_id: a for e_id, a in added_candidates.items()
         if _disp_container(e_id) is not None
         and not _is_repealed(a.get("text", ""))})

    candidate_pairs: list[tuple[str, str]] = []
    for fp in sorted(old_index.keys() & new_index.keys()):
        for old_e_id, new_e_id in zip(old_index[fp], new_index[fp]):
            candidate_pairs.append((old_e_id, new_e_id))

    # How many candidate pairs connect each SPECIFIC (origin, destination)
    # container pair -- corroboration (b) needs at least two independent
    # ones, so this is computed once up front rather than per-candidate.
    pair_counts: dict[tuple[int, int], int] = {}
    for old_e_id, new_e_id in candidate_pairs:
        old_n = _disp_container(old_e_id)[0]
        new_n = _disp_container(new_e_id)[0]
        pair_counts[(old_n, new_n)] = pair_counts.get((old_n, new_n), 0) + 1

    moved_old: set[str] = set()
    moved_new: set[str] = set()
    for old_e_id, new_e_id in candidate_pairs:
        old_n = _disp_container(old_e_id)[0]
        new_n = _disp_container(new_e_id)[0]
        structurally_related = _container_score(
            old_disp.get(old_n, {}), new_disp.get(new_n, {})) != (0, 0)
        multiply_corroborated = pair_counts[(old_n, new_n)] >= 2
        if structurally_related or multiply_corroborated:
            moved_old.add(old_e_id)
            moved_new.add(new_e_id)

    return moved_old, moved_new


# How many byte-identical, uniquely-fingerprinted pairs must agree on ONE
# offset before a renumbering is believed. Three is the smallest number that
# cannot be produced by a single coincidence plus its neighbour; the real
# case that motivated this carries five.
_MIN_SHIFT_IDENTICAL = 3


def _shifted_article_pairs(before: list[dict],
                           after: list[dict]) -> list[tuple[dict, dict]]:
    """(old_article, new_article) pairs consumed by a confirmed renumbering
    of ORDINARY, non-disp articles.

    The module docstring says Fedlex renumbers transitional containers
    wholesale, and _match_containers() handles that. It is not only
    transitional containers. SR 220 2021-07-01 -> 2022-01-01 inserts three
    new articles at the head of one chapter and pushes the six that were
    there down by three: art_964_a..964_f become art_964_d..964_i, five of
    the six byte-identical after normalisation. Every one of those eId
    STRINGS exists on both sides, so none reaches the added/removed pools --
    they go straight through the same-eId path and are diffed against
    unrelated content. Measured on the real transition: six "modified" rows
    for provisions whose text never changed, plus three "added" at eIds that
    are old provisions renumbered. Six of fifteen rows, 40% of that
    transition's change log, false.

    Why this and not the two mechanisms already here. _match_containers()
    aligns whole disp containers by their NUMBER, on the premise that the
    container number shifts while the internal suffixes stay put; here the
    container (part_4/tit_32/chap_7) is the same on both sides and it is the
    ARTICLES inside it that shift, so the premise is inverted and there is
    no container number to align. _reconcile_moved_disp_articles() is the
    right shape -- content identity plus corroboration -- but it only ever
    sees the added/removed pools, which a re-pointed eId never enters, and
    its corroboration rules are expressed in disp container numbers. So this
    is the same idea (identity, corroborated) applied to the half of the eId
    space the other two deliberately exclude, not a third opinion competing
    with them on the same rows: the scopes are disjoint by construction.

    Evidence required, all of it:

      * FINGERPRINT IDENTITY, on a fingerprint that is UNIQUE on both sides.
        A text occurring twice on either side is not evidence of anything --
        that is the boilerplate trap _reconcile_moved_disp_articles()'s
        docstring measured, and the cheapest way to stay out of it is to
        refuse ambiguous fingerprints outright rather than pair them off.
        Empty and repeal-marker bodies are excluded for the same reason.
      * A CONSTANT OFFSET shared by at least _MIN_SHIFT_IDENTICAL such
        pairs, whose positions are CONTIGUOUS in document order. One
        provision reappearing verbatim elsewhere is a coincidence; three
        consecutive ones landing at the same displacement is a shift.
      * Nothing else claiming either side.

    A confirmed run is then extended outwards, one position at a time at the
    same offset, but ONLY while both candidates are unaccounted for --
    neither the old text occurring anywhere in `after`, nor the new text
    anywhere in `before`. That is what catches the sixth article of a
    six-article shift when it was reworded on the way (old art_964_f -> new
    art_964_i, the one pair whose fingerprints differ), and it is what stops
    the run at the first unchanged neighbour, whose text trivially occurs on
    both sides. An extended pair is NOT silently consumed: its content
    really did change, so it yields a `modified` at the new eId. Without the
    extension that provision's old text simply vanishes and its eId reads as
    a repeal, which is a fabricated row of exactly the kind this function
    exists to remove.

    Document order is load-bearing here, and it is real: diff_stage reads
    articles `ORDER BY ordinal`, and akn.parse_articles() emits them in
    document order.
    """
    old_list = [a for a in before if _disp_container(a["e_id"]) is None]
    new_list = [a for a in after if _disp_container(a["e_id"]) is None]

    def unique_fingerprints(articles: list[dict]) -> dict[str, int]:
        seen: dict[str, list[int]] = {}
        for position, article in enumerate(articles):
            text = article.get("text", "")
            if _is_repealed(text):
                continue
            seen.setdefault(fingerprint(text), []).append(position)
        return {fp: positions[0] for fp, positions in seen.items()
                if len(positions) == 1}

    old_unique = unique_fingerprints(old_list)
    new_unique = unique_fingerprints(new_list)

    # offset -> the old positions that reappear, verbatim, that far along.
    by_offset: dict[int, list[int]] = {}
    for fp in sorted(old_unique.keys() & new_unique.keys()):
        old_position, new_position = old_unique[fp], new_unique[fp]
        if old_list[old_position]["e_id"] == new_list[new_position]["e_id"]:
            continue
        by_offset.setdefault(new_position - old_position, []).append(old_position)

    old_texts = {fingerprint(a.get("text", "")) for a in old_list}
    new_texts = {fingerprint(a.get("text", "")) for a in new_list}

    pairs: list[tuple[dict, dict]] = []
    claimed_old: set[int] = set()
    claimed_new: set[int] = set()
    for offset in sorted(by_offset, key=lambda k: (-len(by_offset[k]), k)):
        if offset == 0:
            continue
        positions = sorted(by_offset[offset])
        # Every same-offset verbatim reappearance, not just this run's. The
        # extension walk below may absorb members of a NEIGHBOURING
        # sub-threshold run: a reworded member in the middle of one displaced
        # block splits the byte-identical positions into two runs, and gating
        # each run alone fabricated `repealed`+`added` rows for the far,
        # shorter half -- its text survives verbatim three positions along,
        # which unaccounted() correctly refuses to walk over. A position that
        # reappears verbatim at THIS offset is exactly the evidence the run
        # itself is made of, so the walk may cross it; the threshold still
        # applies to the seed run, so no pairing starts from thin air.
        offset_positions = set(positions)
        runs: list[list[int]] = []
        for position in positions:
            if runs and position == runs[-1][-1] + 1:
                runs[-1].append(position)
            else:
                runs.append([position])
        for run in runs:
            if len(run) < _MIN_SHIFT_IDENTICAL:
                continue
            members = list(run)

            def free(position: int) -> bool:
                return (0 <= position < len(old_list)
                        and 0 <= position + offset < len(new_list)
                        and position not in claimed_old
                        and position + offset not in claimed_new)

            def unaccounted(position: int) -> bool:
                """Neither side's text occurs anywhere on the other side --
                so nothing else can explain either of them."""
                old_text = old_list[position].get("text", "")
                new_text = new_list[position + offset].get("text", "")
                if _is_repealed(old_text) or _is_repealed(new_text):
                    return False
                return (fingerprint(old_text) not in new_texts
                        and fingerprint(new_text) not in old_texts)

            for step, edge in ((1, run[-1]), (-1, run[0])):
                position = edge + step
                while free(position) and (position in offset_positions
                                          or unaccounted(position)):
                    members.append(position)
                    position += step

            if any(position in claimed_old or position + offset in claimed_new
                   for position in members):
                continue
            for position in sorted(members):
                claimed_old.add(position)
                claimed_new.add(position + offset)
                pairs.append((old_list[position], new_list[position + offset]))

    return pairs


def diff(before: list[dict], after: list[dict]) -> list[Change]:
    """Changes that turn `before` into `after`, ordered by eId for stability."""
    old = {a["e_id"]: a for a in before}
    new = {a["e_id"]: a for a in after}
    changes: list[Change] = []

    old_disp = _group_disp_containers(old)
    new_disp = _group_disp_containers(new)
    container_pairs = _match_containers(old_disp, new_disp)

    matched_old_ids: set[str] = set()
    matched_new_ids: set[str] = set()

    # An ordinary-article renumbering, resolved before anything else looks at
    # these eIds: both sides of a shifted pair are accounted for here, so the
    # old eId's surviving string is free to be judged on its NEW content and
    # the new eId is not diffed against whatever used to live there. See
    # _shifted_article_pairs(). A pair whose content also changed on the way
    # keeps its row, at the eId the provision now carries.
    for old_article, new_article in _shifted_article_pairs(before, after):
        matched_old_ids.add(old_article["e_id"])
        matched_new_ids.add(new_article["e_id"])
        change = _compare(new_article["e_id"],
                          new_article.get("article_number"),
                          old_article.get("text", ""),
                          new_article.get("text", ""))
        if change is not None:
            changes.append(change)
    # Every "old-only" / "new-only" disp article this call produces, from
    # EVERY source (a confirmed pair's own old-only/new-only suffixes, and
    # the plain fallback below) -- collected rather than turned into
    # Change objects immediately, so _reconcile_moved_disp_articles() can
    # see the full pool and catch a split or merge whose two halves come
    # from different sources. See that function's docstring for why a
    # merge specifically requires this: its "added" half is generated
    # from inside a pair, never reaching the fallback on its own.
    removed_candidates: dict[str, dict] = {}
    added_candidates: dict[str, dict] = {}

    for n_b, n_a in container_pairs:
        old_group, new_group = old_disp[n_b], new_disp[n_a]
        matched_old_ids.update(a["e_id"] for a in old_group.values())
        matched_new_ids.update(a["e_id"] for a in new_group.values())

        for suffix in sorted(old_group.keys() - new_group.keys()):
            article = old_group[suffix]
            removed_candidates[article["e_id"]] = article

        for suffix in sorted(new_group.keys() - old_group.keys()):
            article = new_group[suffix]
            added_candidates[article["e_id"]] = article

        for suffix in sorted(old_group.keys() & new_group.keys()):
            old_a, new_a = old_group[suffix], new_group[suffix]
            change = _compare(new_a["e_id"], new_a.get("article_number"),
                              old_a.get("text", ""), new_a.get("text", ""))
            if change is not None:
                changes.append(change)

    # Everything not absorbed by a confirmed container pairing -- ordinary
    # top-level articles, and any disp container with no counterpart at all
    # on the other side -- goes through the plain eId comparison, unchanged
    # from before container alignment existed.
    old_remaining = {e_id: a for e_id, a in old.items() if e_id not in matched_old_ids}
    new_remaining = {e_id: a for e_id, a in new.items() if e_id not in matched_new_ids}

    for e_id in sorted(new_remaining.keys() - old_remaining.keys()):
        added_candidates[e_id] = new_remaining[e_id]

    for e_id in sorted(old_remaining.keys() - new_remaining.keys()):
        removed_candidates[e_id] = old_remaining[e_id]

    moved_old, moved_new = _reconcile_moved_disp_articles(
        removed_candidates, added_candidates, old_disp, new_disp)

    for e_id in sorted(removed_candidates.keys() - moved_old):
        change = _repealed_change(removed_candidates[e_id])
        if change is not None:
            changes.append(change)

    for e_id in sorted(added_candidates.keys() - moved_new):
        change = _added_change(added_candidates[e_id])
        if change is not None:
            changes.append(change)

    for e_id in sorted(old_remaining.keys() & new_remaining.keys()):
        change = _compare(e_id, new_remaining[e_id].get("article_number"),
                          old_remaining[e_id].get("text", ""),
                          new_remaining[e_id].get("text", ""))
        if change is not None:
            changes.append(change)

    return sorted(_deduplicate(changes, old, new), key=lambda c: (c.e_id,))
