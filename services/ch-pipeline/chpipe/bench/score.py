"""Point-in-time grounding scorer for the CH benchmark.

Given a model's ANSWER about "what does article X say as of date D", and the
two candidate article texts it could have quoted -- GOLD (the edition valid
on D) and DISTRACTOR (the adjacent edition, valid the day before or the day
after) -- `score()` decides which one the answer actually grounds in,
without touching a database, a network, or any other I/O. It is deterministic:
same three strings in, same Verdict out, always (see
test_score_is_deterministic).

WHY UNIT-LEVEL, NOT WHOLE-STRING, MATCHING
Comparing the whole answer to the whole gold/distractor text with one
similarity score cannot distinguish "quoted the right edition" from "quoted
the wrong edition that happens to share 90% of its wording with the right
one" -- two adjacent editions of a Swiss statute typically differ in one or
two paragraphs out of several, so a whole-string ratio is dominated by the
unchanged paragraphs and barely moves between the two candidates. Instead,
each candidate text is split into UNITS (paragraphs, falling back to
sentences -- see `units()`) and partitioned three ways relative to the
*other* candidate:

  * gold-only units    -- wording that appears in GOLD but not DISTRACTOR;
                           finding these is evidence the answer quoted GOLD.
  * distractor-only     -- the mirror image; evidence for DISTRACTOR.
  * shared units        -- wording identical in both editions (e.g. an
                           unamended paragraph); finding these is evidence
                           of neither, since both editions would satisfy it.

Coverage is computed separately for each partition (the fraction of that
partition's units found in the answer), and the label is decided from
gold_coverage and distractor_coverage alone -- shared_coverage is reported
for diagnostics (a run where shared_coverage is high but both
gold_coverage and distractor_coverage are low usually means the answer
paraphrased the unchanged parts of the article and never got near the
amendment) but never drives the label, since by construction it cannot
discriminate between the two editions.

LABEL THRESHOLDS: 0.6 / 0.2
`grounded_correct` requires gold_coverage >= 0.6 AND distractor_coverage
<= 0.2; `grounded_wrong_version` is the mirror (distractor_coverage >= 0.6,
gold_coverage <= 0.2). Everything else -- including an answer that clears
neither 0.6 floor, or one that clears 0.6 on one side but also leaks past
0.2 on the other -- is `ungrounded`. The two thresholds are deliberately
not complementary (0.6 + 0.2 = 0.8, not 1.0): an article can have as few as
one gold-only and one distractor-only unit, so coverage only ever takes
values in {0, 1} for a single-unit partition, and 0.6/0.2 is simply "found
it" (1.0 >= 0.6) versus "did not find it" (0.0 <= 0.2) in that common case,
with the gap between 0.2 and 0.6 reserved for partitions with several units
where the answer got some but not all of them right -- treated as
ungrounded rather than guessed at, because a partial match to one edition's
distinguishing wording is not evidence the model resolved the date
correctly; it is at best evidence it is reciting from memory. The 0.6/0.2
split point (rather than, say, 0.5/0.5) also builds in a bias toward
`ungrounded` over a confident label when coverage is ambiguous, since a
false `grounded_correct`/`grounded_wrong_version` corrupts an accuracy
metric a paper will cite, while an `ungrounded` false negative just costs
one datapoint.

WINDOW-MATCH THRESHOLD: 0.92
A unit is "found" if it occurs verbatim (post-normalise()) as a substring
of the normalised answer, OR -- for a unit not found that way -- if the
best-matching same-length(-ish) window of the answer scores >= 0.92 on
`difflib.SequenceMatcher.ratio()` (see `_window_found()`). 0.92 is picked to
tolerate the "typo, OCR slip, or a model re-typing two words slightly
wrong" case (a handful of single-character edits inside an
80-200-character paragraph easily clears 0.92) while rejecting a unit that
is merely topically similar or shares most words with the wrong number
substituted -- the case this scorer exists to catch (see
test_gold_with_typos_in_two_words_is_still_grounded_correct for the
positive case, and the GOLD/DISTRACTOR fixtures in
tests/test_bench_score.py, which differ only in a number per paragraph, for
the negative one: those substitutions were measured to drop well below
0.92 in an 80-character paragraph).

PERFORMANCE CAP
Window matching is O(len(answer) / step) SequenceMatcher calls per
not-found unit. For answers longer than 20,000 characters (well above the
p90 article length of ~2,200 characters this scorer was built against, so
this only fires on a degenerate/runaway answer) only substring matching is
attempted; window matching is skipped and such a unit counts as not found
unless it occurs verbatim. This is a deliberate trade: on a runaway answer,
recall on near-verbatim-but-typo'd units is sacrificed for the calculation
staying bounded.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# Grounding thresholds -- see module docstring "LABEL THRESHOLDS: 0.6 / 0.2".
_STRONG = 0.6
_WEAK = 0.2

# Window-match similarity floor -- see module docstring "WINDOW-MATCH
# THRESHOLD: 0.92".
_WINDOW_RATIO = 0.92

# Above this many characters in the normalised answer, window matching is
# skipped entirely -- see module docstring "PERFORMANCE CAP".
_MAX_WINDOW_ANSWER_LEN = 20_000

# A unit's normalised form shorter than this is discarded by units(): too
# short to discriminate one edition from another (a bare "a." list marker,
# a one-word repealed-paragraph stub), and short strings inflate
# SequenceMatcher ratios by chance.
_MIN_UNIT_LEN = 25

# Fedlex paragraph numbering: "1 ", "2 ", "1bis ", "3ter ", "4a " at the
# start of a line. The letter suffix is `[a-z]*` (not `[a-z]?`) because
# inserted paragraphs are numbered "1bis"/"1ter", not just a single letter.
_PARAGRAPH_MARKER = re.compile(r"(?m)^(\d+[a-z]*)\s+")

# Sentence-level fallback split, used when a text has no paragraph markers
# at all (a distractor snippet, a plain prose answer fragment): break after
# a period, semicolon or colon followed by whitespace, keeping the
# delimiter attached to the unit it ends.
_SENTENCE_SPLIT = re.compile(r"(?<=[.;:])\s+")

# Quote and dash families unified by normalise(). Grouped by kind (double-
# vs single-quote-like) rather than collapsed to one character, so an
# apostrophe inside a word ("l'article") does not turn into a stray double
# quote -- unify within a family, not across families.
_QUOTES = str.maketrans({
    "«": '"',  # « left guillemet
    "»": '"',  # » right guillemet
    "“": '"',  # " left double quotation mark
    "”": '"',  # " right double quotation mark
    "„": '"',  # „ double low-9 quotation mark
    "‟": '"',  # ‟ double high-reversed-9 quotation mark
    "‘": "'",  # ' left single quotation mark
    "’": "'",  # ' right single quotation mark
    "‚": "'",  # ‚ single low-9 quotation mark
    "‛": "'",  # ‛ single high-reversed-9 quotation mark
})
_DASHES = str.maketrans({
    "‐": "-",  # ‐ hyphen
    "‑": "-",  # ‑ non-breaking hyphen
    "‒": "-",  # ‒ figure dash
    "–": "-",  # – en dash
    "—": "-",  # — em dash
    "−": "-",  # − minus sign
})

_SOFT_HYPHEN = "­"
_WHITESPACE = re.compile(r"\s+")
_TRAILING_PUNCT = " \t.,;:!?"


@dataclass(frozen=True)
class Verdict:
    """The scorer's decision for one answer against one gold/distractor pair.

    `label` is one of "grounded_correct" (answer's article wording matches
    the edition valid on the query date), "grounded_wrong_version" (matches
    the adjacent edition instead) or "ungrounded" (neither, or a mix of
    both -- see module docstring). The three coverage fields are shares in
    [0.0, 1.0] of the corresponding unit partition found in the answer; a
    partition with zero units always reports coverage 0.0 (never NaN, never
    undefined), including shared_coverage.
    """

    label: str
    gold_coverage: float
    distractor_coverage: float
    shared_coverage: float


def normalise(s: str) -> str:
    """Fold cosmetic, re-typesetting-only variation out of a string.

    NFKC (folds compatibility variants, e.g. full-width Latin letters, to
    their canonical form) -> lower-case -> unify quote and dash characters
    (see _QUOTES/_DASHES above) -> drop soft hyphens (U+00AD, a Fedlex
    line-break artefact with no semantic content) -> collapse whitespace
    runs to a single space and strip the ends.

    This does NOT strip trailing punctuation from the *result* -- that is a
    per-unit step applied by units() after this function runs, since
    normalise() is also called on the whole answer, where stripping a
    trailing "." would be wrong (it would strip the actual end of the
    answer, not a unit boundary).
    """
    folded = unicodedata.normalize("NFKC", s or "")
    folded = folded.lower()
    folded = folded.translate(_QUOTES)
    folded = folded.translate(_DASHES)
    folded = folded.replace(_SOFT_HYPHEN, "")
    return _WHITESPACE.sub(" ", folded).strip()


def _split_paragraphs(text: str) -> list[str]:
    matches = list(_PARAGRAPH_MARKER.finditer(text))
    if not matches:
        return []
    chunks = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunks.append(text[start:end])
    return chunks


def units(text: str) -> list[str]:
    """Split TEXT into normalised, meaningful matching units.

    Tries paragraph-level splitting first, on Fedlex-style numbered
    markers ("1 ", "1bis ", "2 ", ... at line starts -- see
    _PARAGRAPH_MARKER). If no such marker is found at all (the text is
    plain prose: a distractor fragment, an unrelated snippet), falls back
    to sentence-level splitting on ". ", "; ", ": " (see _SENTENCE_SPLIT).

    Each candidate chunk is then normalise()'d, stripped of trailing
    punctuation, and kept only if at least _MIN_UNIT_LEN (25) characters
    long -- shorter than that (a lettered list marker "a.", a one-word
    repealed-paragraph stub) is not enough text to discriminate one
    article edition from another, and short strings inflate
    SequenceMatcher ratios by chance in the window-match step of score().

    Returns already-normalised strings (not the raw slices), since every
    caller (score()'s substring/window matching) needs the normalised form
    and normalising twice would be wasted, redundant work.
    """
    chunks = _split_paragraphs(text) or _SENTENCE_SPLIT.split(text)
    result = []
    for chunk in chunks:
        norm = normalise(chunk).rstrip(_TRAILING_PUNCT)
        if len(norm) >= _MIN_UNIT_LEN:
            result.append(norm)
    return result


def _window_found(unit: str, answer: str) -> bool:
    """True if some window of ANSWER, roughly the length of UNIT, matches
    UNIT with SequenceMatcher ratio >= _WINDOW_RATIO. Called only after a
    direct substring check has already failed. See module docstring
    "WINDOW-MATCH THRESHOLD: 0.92" and "PERFORMANCE CAP"."""
    if len(answer) > _MAX_WINDOW_ANSWER_LEN:
        return False
    unit_len = len(unit)
    if unit_len == 0:
        return False
    lo = max(1, round(unit_len * 0.8))
    hi = max(lo, round(unit_len * 1.2))
    step = max(1, unit_len // 4)
    best = 0.0
    for window_len in sorted({lo, unit_len, hi}):
        if window_len > len(answer):
            continue
        last_start = len(answer) - window_len
        starts = list(range(0, last_start + 1, step))
        if starts[-1] != last_start:
            starts.append(last_start)  # always probe the tail window too
        for start in starts:
            window = answer[start : start + window_len]
            ratio = SequenceMatcher(None, unit, window).ratio()
            if ratio > best:
                best = ratio
            if best >= _WINDOW_RATIO:
                return True
    return False


def _unit_found(unit: str, answer: str) -> bool:
    if unit in answer:
        return True
    return _window_found(unit, answer)


def _coverage(unit_set: set[str], answer: str) -> float:
    if not unit_set:
        return 0.0
    found = sum(1 for u in unit_set if _unit_found(u, answer))
    return found / len(unit_set)


def score(answer: str, gold: str, distractor: str) -> Verdict:
    """Decide whether ANSWER grounds in GOLD (the edition valid on the
    query date), DISTRACTOR (the adjacent edition), both, or neither.

    See the module docstring for the full reasoning; in short: units() both
    candidate texts, partitions the union into gold-only / distractor-only
    / shared, measures what fraction of each partition's units occur in
    ANSWER (verbatim or via a high-similarity window match), and applies
    the 0.6/0.2 thresholds to gold_coverage and distractor_coverage to pick
    a label.
    """
    norm_answer = normalise(answer)
    gold_units = set(units(gold))
    distractor_units = set(units(distractor))
    shared_units = gold_units & distractor_units
    gold_only = gold_units - shared_units
    distractor_only = distractor_units - shared_units

    gold_coverage = _coverage(gold_only, norm_answer)
    distractor_coverage = _coverage(distractor_only, norm_answer)
    shared_coverage = _coverage(shared_units, norm_answer)

    if gold_coverage >= _STRONG and distractor_coverage <= _WEAK:
        label = "grounded_correct"
    elif distractor_coverage >= _STRONG and gold_coverage <= _WEAK:
        label = "grounded_wrong_version"
    else:
        label = "ungrounded"

    return Verdict(
        label=label,
        gold_coverage=gold_coverage,
        distractor_coverage=distractor_coverage,
        shared_coverage=shared_coverage,
    )
