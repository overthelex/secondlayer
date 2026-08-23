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

diff() reconciles both by aligning whole CONTAINERS, not individual eIds:
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
    decided."""
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
        added_candidates: dict[str, dict]) -> tuple[set[str], set[str]]:
    """Beyond a single container's renumbering (see _match_containers), a
    provision can move to a container that never pairs with its origin at
    all: a container splits, sending part of its content elsewhere while
    the rest stays; two containers merge into one. In either shape the
    moved content's destination is not its origin container's structural
    continuation, so _match_containers() correctly declines to pair them
    (they are not the same container renumbered) -- and without this
    function, the moved content would be read as an unrelated repeal and
    an unrelated addition. Measured on a content-preserving split: one
    repealed row plus one added row where the correct answer is zero; on a
    content-preserving merge: two added plus two repealed where the
    correct answer is zero.

    The general rule, deliberately not scoped to "within one container
    pair": if a removed disp-scoped eId's normalised text reappears
    anywhere among the added disp-scoped candidates in the SAME diff()
    call, the provision moved -- no repeal, no addition, regardless of
    which containers are involved or whether any two of them pair.
    `removed_candidates`/`added_candidates` are therefore the FULL pool of
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

    Fingerprint identity, not similarity, is the signal: it is the exact
    value diff() already computes for every article to decide "did this
    change at all", so reusing it here costs nothing extra and, unlike a
    similarity threshold, can never merge two provisions that merely read
    alike.

    SCOPE: both sides are filtered to disp-scoped eIds only (see
    _disp_container()), never ordinary top-level articles. Matching
    content alone across top-level articles risks exactly what
    test_unrelated_articles_with_identical_new_text_are_not_merged_into_a_rename
    guards against -- two unrelated articles that happen to share
    coincidentally identical text (most plausibly a bare repeal marker)
    being silently merged into a false "nothing happened". Disp containers
    are the ones Fedlex is known, structurally, to reshuffle; ordinary
    articles are not, so this stays inside the boundary the rest of the
    module already draws.

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
    the disp-only scoping above exists to avoid (two DIFFERENT,
    similarly-but-not-identically-worded provisions merged). Left as a
    repeal and an addition -- conservative, but it never asserts a
    continuity this function cannot verify by exact content.

    AMBIGUITY: if a removed eId's text matches several added candidates,
    or several removed eIds share the same text, the shorter of the two
    candidate lists for that fingerprint is paired off against the other
    in SORTED eId order, deterministically, regardless of dict/set
    iteration order (the exact defect class the last two rounds of this
    module were sent back for). No judgement call is needed about WHICH
    physical eId "really" continues which: every eId sharing one
    fingerprint carries byte-identical (post-normalisation) text by
    definition, so which specific string labels which is genuinely
    arbitrary -- only the COUNT absorbed as "moved" (min of the two list
    lengths) matters, and any excess on the longer side is left to be
    judged a genuine repeal or addition on its own, exactly as if it had
    never had a same-text sibling at all.

    Returns the eIds consumed on each side, NOT Change objects: a moved
    provision produces no Change at all.
    """
    old_index = _index_by_fingerprint(
        {e_id: a for e_id, a in removed_candidates.items()
         if _disp_container(e_id) is not None})
    new_index = _index_by_fingerprint(
        {e_id: a for e_id, a in added_candidates.items()
         if _disp_container(e_id) is not None})

    moved_old: set[str] = set()
    moved_new: set[str] = set()
    for fp in sorted(old_index.keys() & new_index.keys()):
        for old_e_id, new_e_id in zip(old_index[fp], new_index[fp]):
            moved_old.add(old_e_id)
            moved_new.add(new_e_id)

    return moved_old, moved_new


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
        removed_candidates, added_candidates)

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
