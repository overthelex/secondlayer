"""Per-article difference between two consecutive editions of one act.

Comparison is on a normalised fingerprint, not raw text: Fedlex re-typesets
editions, so whitespace and dash variants differ between editions of the same
unchanged article. Both an en dash and an em dash occur inside a single act, and
treating either as an amendment would fabricate changes by the thousand.

Articles are matched on eId, never on article number: verified in the real OR
XML that 'art_7' and 'disp_u17/art_7' coexist with the number 7 -- 1,686
articles but only 1,176 distinct numbers in one real edition, so 510 would
collide if keyed on the number instead.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

_WHITESPACE = re.compile(r"\s+")
_DASHES = str.maketrans({"–": "-", "—": "-", "‐": "-", " ": " "})
_QUOTES = str.maketrans({"«": '"', "»": '"', "„": '"', "“": '"', "”": '"',
                         "’": "'", "‘": "'"})

# An edition keeps the article and replaces its body with a repeal marker. That
# is a repeal, not a rewording, and the distinction is the point of the log.
_REPEAL_MARKERS = frozenset({
    "aufgehoben", "abrogé", "abrogée", "abrogato", "abrogata", "abroge",
})


@dataclass(frozen=True)
class Change:
    e_id: str
    article_number: str | None
    change_type: str


def normalise(text: str) -> str:
    folded = unicodedata.normalize("NFC", text or "")
    folded = folded.translate(_DASHES).translate(_QUOTES)
    return _WHITESPACE.sub(" ", folded).strip().lower()


def fingerprint(text: str) -> str:
    return hashlib.sha256(normalise(text).encode("utf-8")).hexdigest()


def _is_repealed(text: str) -> bool:
    """True for an explicit repeal marker ("Aufgehoben"/"Abrogé"/"Abrogato")
    AND for a genuinely empty body (normalises to ""). Both mean the article
    kept its eId and number but lost its wording -- a repeal, not a
    rewording, since there is no wording left to compare against the old
    text. This is the branch that catches an article going from real text to
    truly empty: 75 of 1,686 articles in one real edition of the OR carry no
    marker word at all, just an empty body. An article that DISAPPEARS
    outright (its eId no longer occurs in the later edition) is a different
    case entirely, handled by the "in before, not in after" branch of
    diff() below, unconditionally on text.
    """
    stripped = normalise(text).strip(" .")
    return stripped == "" or stripped in _REPEAL_MARKERS


def diff(before: list[dict], after: list[dict]) -> list[Change]:
    """Changes that turn `before` into `after`, ordered by eId for stability."""
    old = {a["e_id"]: a for a in before}
    new = {a["e_id"]: a for a in after}
    changes: list[Change] = []

    for e_id in sorted(new.keys() - old.keys()):
        article = new[e_id]
        changes.append(Change(e_id, article.get("article_number"), "added"))

    for e_id in sorted(old.keys() - new.keys()):
        article = old[e_id]
        changes.append(Change(e_id, article.get("article_number"), "repealed"))

    for e_id in sorted(old.keys() & new.keys()):
        old_text, new_text = old[e_id].get("text", ""), new[e_id].get("text", "")
        if fingerprint(old_text) == fingerprint(new_text):
            continue
        kind = "repealed" if (_is_repealed(new_text) and not _is_repealed(old_text)) \
            else "modified"
        changes.append(Change(e_id, new[e_id].get("article_number"), kind))

    return sorted(changes, key=lambda c: (c.e_id,))
