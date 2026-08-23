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
problem than a collision: Fedlex renumbers a transitional-provisions
container (an eId shaped "disp_u<N>/...") wholesale whenever a new block is
inserted before it -- "disp_u15/art_1" becomes "disp_u16/art_1" in the very
next edition, with every article inside the container getting a new eId even
though nothing about the law moved. Matched naively on eId, that reads as one
article repealed and an unrelated one added. Measured on one real edition
transition of the OR: 17 of 30 in-edition "disp" repeals were exactly this,
container renumbering, not real repeals -- 11 of the 17 byte-identical, the
rest differing only by re-typesetting noise the fingerprint already absorbs.
diff() reconciles this before generating Change rows; see _disp_suffix() and
the reconciliation block inside diff() for the exact scope of that
reconciliation and why it is deliberately narrow (a structural signal, not
"any two articles with identical text").
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
    "–": "-", "—": "-", "‐": "-", "‑": "-", "−": "-", " ": " ",
})
_QUOTES = str.maketrans({"«": '"', "»": '"', "„": '"', "“": '"', "”": '"',
                         "’": "'", "‘": "'"})

# An edition keeps the article and replaces its body with a repeal marker. That
# is a repeal, not a rewording, and the distinction is the point of the log.
_REPEAL_MARKERS = frozenset({
    "aufgehoben", "abrogé", "abrogée", "abrogato", "abrogata", "abroge",
})

# "disp_u15/art_1" -> "/art_1": the part of a transitional-container eId
# that identifies WHICH provision this is, independent of the container's
# own number. Anchored specifically to "disp_u<digits>/" so this can only
# ever pair two disp-scoped eIds against each other -- an ordinary
# top-level article's eId (no disp_u prefix) never matches, and two
# articles that merely happen to share identical text are never paired
# either. See the module docstring for why that scope is deliberate.
_DISP_SUFFIX = re.compile(r"^disp_u\d+(/.+)$")


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
    diff()'s "in before, not in after" branch, unconditionally on text.
    """
    stripped = normalise(text).strip(" .")
    return stripped == "" or stripped in _REPEAL_MARKERS


def _disp_suffix(e_id: str) -> str | None:
    match = _DISP_SUFFIX.match(e_id)
    return match.group(1) if match else None


def _compare(e_id: str, article_number: str | None,
            old_text: str, new_text: str) -> Change | None:
    """The Change (if any) that explains `old_text` becoming `new_text`
    under `e_id`. Shared by the same-eId comparison and the disp-rename
    comparison below -- the two cases differ only in WHICH eId's before/after
    text is being compared, not in how "changed" is decided."""
    if fingerprint(old_text) == fingerprint(new_text):
        return None
    kind = "repealed" if (_is_repealed(new_text) and not _is_repealed(old_text)) \
        else "modified"
    return Change(e_id, article_number, kind)


def diff(before: list[dict], after: list[dict]) -> list[Change]:
    """Changes that turn `before` into `after`, ordered by eId for stability."""
    old = {a["e_id"]: a for a in before}
    new = {a["e_id"]: a for a in after}
    changes: list[Change] = []

    added_ids = new.keys() - old.keys()
    removed_ids = old.keys() - new.keys()

    # Reconcile Fedlex's transitional-container renumbering before treating
    # a disappearance as a repeal or an appearance as an addition. See the
    # module docstring and _disp_suffix() for what this does and does not
    # match.
    removed_by_suffix: dict[str, str] = {}
    for e_id in removed_ids:
        suffix = _disp_suffix(e_id)
        if suffix is not None:
            removed_by_suffix[suffix] = e_id
    renamed_to_from: dict[str, str] = {}
    for e_id in added_ids:
        suffix = _disp_suffix(e_id)
        if suffix is not None and suffix in removed_by_suffix:
            renamed_to_from[e_id] = removed_by_suffix[suffix]

    added_ids = added_ids - renamed_to_from.keys()
    removed_ids = removed_ids - set(renamed_to_from.values())

    for e_id in sorted(added_ids):
        article = new[e_id]
        text = article.get("text", "")
        if _is_repealed(text):
            # A brand-new eId whose body is already empty or a repeal
            # marker the moment it first appears never carried operative
            # text under this identifier -- there is nothing to assert was
            # added. Recording "added" here would be as wrong as recording
            # "repealed" for something that was never in force; recording
            # nothing is the honest answer, the same stance diff() takes
            # for a pure container rename with unchanged text below.
            # Measured: 7 real rows in one edition of the OR were exactly
            # this case.
            continue
        changes.append(Change(e_id, article.get("article_number"), "added"))

    for e_id in sorted(removed_ids):
        article = old[e_id]
        changes.append(Change(e_id, article.get("article_number"), "repealed"))

    # A renamed pair is the same provision under two eIds across one edition
    # transition -- compare its text across the rename exactly like an
    # ordinary same-eId comparison, keyed on the eId it now has. A pure
    # rename with unchanged text produces nothing (fingerprints match); a
    # rename riding alongside a genuine wording change or an actual repeal
    # still produces exactly one row, not the fabricated repeal+addition
    # pair the naive eId match would have produced.
    for new_e_id in sorted(renamed_to_from):
        old_e_id = renamed_to_from[new_e_id]
        change = _compare(new_e_id, new[new_e_id].get("article_number"),
                          old[old_e_id].get("text", ""),
                          new[new_e_id].get("text", ""))
        if change is not None:
            changes.append(change)

    for e_id in sorted(old.keys() & new.keys()):
        change = _compare(e_id, new[e_id].get("article_number"),
                          old[e_id].get("text", ""), new[e_id].get("text", ""))
        if change is not None:
            changes.append(change)

    return sorted(changes, key=lambda c: (c.e_id,))
