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

  * gold-only units    -- wording that appears in GOLD and is NOT contained
                           anywhere in DISTRACTOR's text; finding these is
                           evidence the answer quoted GOLD.
  * distractor-only     -- the mirror image; evidence for DISTRACTOR.
  * shared units        -- everything else: a unit of one edition that is
                           contained, word for word, in the other edition's
                           text. Finding one is evidence of neither, since
                           an answer quoting either edition contains it.

CONTAINMENT, NOT EQUALITY (why "shared" is not just set intersection)
The partition tests SUBSTRING CONTAINMENT of a unit in the *other
edition's whole normalised text*, not equality between the two unit sets.
An earlier version intersected the sets, and got the commonest Fedlex
amendment shape exactly backwards: when an amendment ADDS words to a
paragraph, the old paragraph is a strict prefix/substring of the new one,
so the two units are not equal and the old one was filed as
"distractor-only" -- yet every correct answer, which quotes the new
paragraph verbatim, necessarily CONTAINS the old wording too. Both
coverages then read 1.0 and the verbatim-gold answer was labelled
`ungrounded`. Measured on the prod build: 1,097 items scored that way, all
of them answers that were word-for-word correct. Under containment the old
paragraph is `shared` instead, so quoting gold no longer counts as
evidence for the distractor.

Coverage is computed separately for each partition (the fraction of that
partition's units found in the answer), and the label is decided from
gold_coverage and distractor_coverage (plus distractor_all_coverage in the
one case below) -- shared_coverage is reported for diagnostics (a run
where shared_coverage is high but both gold_coverage and
distractor_coverage are low usually means the answer paraphrased the
unchanged parts of the article and never got near the amendment) but never
drives the label, since by construction it cannot discriminate between the
two editions.

WRONG-VERSION DETECTION WHEN THE DISTRACTOR-ONLY SET IS EMPTY
Containment has a direct consequence: for a pure-addition amendment (gold
is a strict superset of distractor) NO distractor unit is distractor-only,
so distractor_coverage is 0.0 by construction and could never reach the
0.6 floor -- an answer that recites the OLD wording would fall through to
`ungrounded` instead of being caught as wrong-version, which is the single
thing this benchmark exists to detect. So a second signal is computed:
`distractor_all_coverage`, the share of ALL of DISTRACTOR's units (not just
the distractor-only ones) found in the answer. It is used only as a
fallback, and only when the distractor-only set is empty -- see "LABEL
THRESHOLDS" below. It cannot be used unconditionally, because in the
superset case a perfectly correct gold answer also contains every
distractor unit; that is why the gold-side test is checked first and the
wrong-version test additionally requires gold_coverage <= 0.2 (an answer
holding the added wording is grounded in gold, whatever else it contains).

A SHARE OF THE DISTRACTOR'S UNITS IS NOT ENOUGH ON ITS OWN
Because that share counts SHARED paragraphs too, a long article can clear
the 0.8 bar without the answer ever reproducing the wording the amendment
replaced: five shared paragraphs out of six units is 0.833, and an answer
quoting only those five said nothing about which edition it read. So the
fallback carries a second condition -- the answer must contain at least one
unit the distractor edition has and the gold text does not, at the same
8-character floor ("the amendment's old wording"). Membership in gold's
unit set, NOT "is a substring of the gold text": those differ exactly for a
distractor paragraph nested inside a gold paragraph ("Er ist zu
begruenden." inside "Er ist zu begruenden und zu unterzeichnen."), which is
the commonest amendment shape and precisely the wrong-version answer this
fallback exists to catch. When no such unit exists -- every distractor
paragraph is also a gold paragraph, the amendment only appended text -- the
fallback cannot fire, and should not: nothing an answer can quote from the
old edition would fail to be explained by a partial quote of the new one.

TWO MINIMUM UNIT LENGTHS: 25 EVERYWHERE, 8 FOR THIS FALLBACK ONLY
`distractor_all_coverage` is computed over `units(distractor,
min_len=_MIN_FALLBACK_UNIT_LEN)` (8 normalised characters), not the normal
`units(distractor)` (25 -- see `_MIN_UNIT_LEN`). Reusing the 25-char set
here re-created a version of the same bug this fallback exists to close:
when the amendment's OLD paragraph is itself short -- e.g. a two-paragraph
article where paragraph 2 changes from "Er ist zu begründen." (20 chars)
to "Er ist zu begründen und zu unterzeichnen." (gold, a pure addition) --
the 25-char filter drops distractor's paragraph 2 out of `units(distractor)`
entirely, leaving only the unrelated, unchanged paragraph 1 in the set. An
answer that quotes ONLY that unchanged paragraph then scored
distractor_all_coverage 1.0 (the one distractor unit that survived the
filter was found) and was labelled `grounded_wrong_version`, despite never
touching the amendment. Lowering the minimum to 8 for this computation
(and only this one -- discriminating_units(), the gold-only/distractor-only
partition, and every other use of units() still apply the normal 25-char
floor) puts the short paragraph back in the set an answer has to actually
cover; see "LABEL THRESHOLDS" below for why the floor was also raised to
0.8 to go with it. 8, not some smaller number, because it is short enough
to admit a real short Fedlex paragraph like the "Er ist zu begründen."
example while still being long enough that a stray word or two of
unrelated prose in the answer cannot satisfy it by chance.

The mirror case -- a pure DELETION, gold is a strict subset of distractor
-- leaves the GOLD-only set empty, and no fallback can rescue it: a
correct answer is textually a fragment of the wrong answer, so nothing an
answer contains can prove it meant the shorter edition. Such an item is
undecidable by design, and build.make_items() drops it at build time
(`no_discriminating_unit`, via discriminating_units()) rather than shipping
it. Pure deletions of a whole sentence are therefore not benchmarkable this
way; see CARD.md, "Construction."

LABEL THRESHOLDS: 0.6 / 0.2, 0.8 FOR THE FALLBACK
`grounded_correct` requires gold_coverage >= 0.6 AND distractor_coverage
<= 0.2; `grounded_wrong_version` is the mirror (gold_coverage <= 0.2 AND
either distractor_coverage >= 0.6, or -- when there are no distractor-only
units at all, see "WRONG-VERSION DETECTION" above -- distractor_all_coverage
>= 0.8). The gold test is applied first, so an answer that clears both is
`grounded_correct`. Everything else -- including an answer that clears
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
correctly; it is at best evidence it is reciting from memory.

`distractor_all_coverage`'s fallback threshold is 0.8, not 0.6, because it
is measured over a set built with the lower 8-char floor (see "TWO MINIMUM
UNIT LENGTHS" above): once the short, amendment-adjacent unit is back in
the set alongside the unchanged paragraph(s) around it, an answer that
quotes only the unchanged part now scores below 1.0 on it -- but with two
units in the set, 0.5 (one of two found) still clears 0.2's mirror at 0.6.
Raising the fallback floor to 0.8 closes that gap: on a two-unit set,
finding only the unrelated unit reads 0.5, which no longer clears 0.8,
while an answer that recites the OLD wording in full (both the unchanged
paragraph and the short old wording) still reads 1.0 and clears it easily.
0.8 is deliberately higher than the 0.6 used everywhere else in this
scorer, in exchange for the lower 8-char admission floor.

The 0.6/0.2 split point (rather than, say, 0.5/0.5) also builds in a bias toward
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

DISCRIMINATING PAIRS: WHEN FUZZY MATCHING MUST NOT BE ALLOWED AT ALL
A Fedlex amendment often changes exactly one number, or one short word, and
leaves the rest of the paragraph untouched -- "180 Tagen" becomes "30
Tagen", nothing else in the sentence moves. That is precisely the case
window matching (see above) cannot reliably reject: an ~80-character
paragraph that differs from its counterpart by one digit still scores
around 0.92-0.98 on SequenceMatcher, because character-level similarity
does not know that "180" and "30" mean different things -- it only sees
that most of the string is unchanged. Measured directly on this pair: 0.98.
Left as-is, BOTH the gold-verbatim answer and the distractor-verbatim
answer would "window-match" the OTHER edition's unit too, both coverages
would read 1.0/1.0, and the label would come out `ungrounded` for a
perfectly-grounded answer -- exactly backwards, and worse than useless
for a benchmark whose entire point is catching this kind of amendment.

The fix, in one sentence: IF FUZZY MATCHING WOULD FIND THIS UNIT IN THE
OTHER EDITION, FUZZY MATCHING IS NOT ALLOWED FOR IT. Concretely, each
gold-only unit is put through `_window_found()` against the DISTRACTOR's
whole normalised text (and vice versa) -- the same function, the same
window lengths, the same 0.92 threshold that `_coverage()` will later use
against the answer. A unit that clears it is a DISCRIMINATING unit: for
that unit, and that unit only, fuzzy window matching is switched off, and
it may be found only by an exact substring match of its normalised form in
the normalised answer (see `_coverage()`'s `exact_only` parameter). Units
that do not are unaffected and keep the normal substring-or-window
behaviour.

Asking the flag question with the matching function is what makes the
scorer self-consistent instead of merely stricter: against an answer that
is the OTHER edition verbatim, the flag test and the match test are then
literally the same call on the same string, so a unit is either flagged
(exact-only, correctly not found) or unflagged (and the window match
correctly fails too). The cross-edition false positive cannot survive
either branch.

An earlier version asked a weaker question -- unit against the other
edition's UNITS, pairwise, `SequenceMatcher.ratio() >= _WINDOW_RATIO` --
and let 222+ prod-oracle items through: SR 142.203 art. 3, where an
amendment both rewords a phrase and appends a clause, leaves a
distractor-only sentence whose pairwise ratio to the gold sentence is 0.84
(below the line, so unflagged) but which window-matches inside the gold
text at >= 0.92. Gold-verbatim answers scored gold_coverage 1.0 AND
distractor_coverage 1.0, i.e. `ungrounded`.

The pairwise test is KEPT alongside the window test, OR-ed, because the
window test does not subsume it: `_window_found` only probes windows of
~0.8x/1.0x/1.2x the unit's length, so when the other edition's whole text
is shorter than 0.8x the unit -- a one-paragraph article with a clause
appended -- there is no window to probe and the test returns False on a
pair that is 0.96 similar unit to unit (measured: the GOLD_SHORT_ADD
fixture in tests/test_bench_score.py). The pairwise test also runs against
ALL of the other edition's units, shared ones included, because
containment (above) files a unit as shared exactly when it sits inside the
other edition's text, which is itself a near-duplicate relationship.

This has a real, deliberate cost: an answer that gets the discriminating
number exactly right but has an unrelated typo elsewhere in the SAME
paragraph now scores that unit as not found, where a non-discriminating
unit would have tolerated the typo (see
test_discriminating_unit_rejects_typos_even_though_number_is_right). That
trade is accepted on purpose -- for a pair this close, "probably the same
paragraph" is not a safe substitute for "quotes the discriminating wording
exactly," and silently allowing fuzzy matching here is precisely the bug
this section exists to close.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# Grounding thresholds -- see module docstring "LABEL THRESHOLDS: 0.6 / 0.2,
# 0.8 FOR THE FALLBACK".
_STRONG = 0.6
_WEAK = 0.2

# distractor_all_coverage's own, higher fallback threshold -- see module
# docstring "LABEL THRESHOLDS: 0.6 / 0.2, 0.8 FOR THE FALLBACK".
_FALLBACK_STRONG = 0.8

# Window-match similarity floor -- see module docstring "WINDOW-MATCH
# THRESHOLD: 0.92".
_WINDOW_RATIO = 0.92

# Above this many characters in the normalised answer, window matching is
# skipped entirely -- see module docstring "PERFORMANCE CAP".
_MAX_WINDOW_ANSWER_LEN = 20_000

# A unit's normalised form shorter than this is discarded by units(): too
# short to discriminate one edition from another (a bare "a." list marker,
# a one-word repealed-paragraph stub), and short strings inflate
# SequenceMatcher ratios by chance. This is units()'s default floor, used
# everywhere except the one case below.
_MIN_UNIT_LEN = 25

# The lower floor used ONLY for the distractor_all_coverage fallback (see
# module docstring "TWO MINIMUM UNIT LENGTHS: 25 EVERYWHERE, 8 FOR THIS
# FALLBACK ONLY"): a short but real amendment-adjacent paragraph must not be
# dropped out of that one computation, or an answer that quotes only an
# unrelated, unchanged unit can end up as the only thing left to "cover".
_MIN_FALLBACK_UNIT_LEN = 8

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
    both -- see module docstring). The four coverage fields are shares in
    [0.0, 1.0] of the corresponding unit set found in the answer; a set
    with zero units always reports coverage 0.0 (never NaN, never
    undefined), including shared_coverage.

    gold_coverage / distractor_coverage / shared_coverage are over the
    three-way partition (see module docstring "WHY UNIT-LEVEL...") built
    from units() at the normal 25-char minimum (`_MIN_UNIT_LEN`).
    `distractor_all_coverage` is different in TWO ways, not one: it is over
    ALL of the distractor's units, distractor-only and shared alike
    (overlapping the other two on purpose), AND those units are collected
    with a lower 8-char minimum (`_MIN_FALLBACK_UNIT_LEN`), so it can include
    a short distractor paragraph the 25-char partition above would have
    dropped. It exists as the wrong-version fallback for a pure-addition
    amendment where the distractor-only set is empty (see "WRONG-VERSION
    DETECTION WHEN THE DISTRACTOR-ONLY SET IS EMPTY" and "TWO MINIMUM UNIT
    LENGTHS" in the module docstring), and is judged against its own, higher
    0.8 threshold rather than the 0.6 used elsewhere. Read it as a
    diagnostic everywhere else -- on a gold-superset item a correct answer
    scores 1.0 on it too.
    """

    label: str
    gold_coverage: float
    distractor_coverage: float
    shared_coverage: float
    distractor_all_coverage: float = 0.0


def normalise(s: str) -> str:
    """Fold cosmetic, re-typesetting-only variation out of a string.

    NFKC (folds compatibility variants, e.g. full-width Latin letters, to
    their canonical form) -> lower-case -> unify quote and dash characters
    (see _QUOTES/_DASHES above) -> fold U+2026 HORIZONTAL ELLIPSIS to three
    periods -> drop soft hyphens (U+00AD, a Fedlex line-break artefact with
    no semantic content) -> collapse whitespace runs to a single space and
    strip the ends.

    The ellipsis fold is what chpipe/diff_articles.normalise() does too, and
    for the same reason: Fedlex is not internally consistent about which
    character it uses for a struck-out paragraph -- a single U+2026 in one
    place, three literal periods in another, inside the same act -- so an
    answer and the edition it quotes can disagree on it without disagreeing
    on any wording. NFKC already decomposes U+2026 this way; the explicit
    replace states the intent, and keeps this function's behaviour pinned to
    diff_articles' even if the unicodedata pass ahead of it ever changes.

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
    folded = folded.replace("…", "...")
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


def units(text: str, min_len: int = _MIN_UNIT_LEN) -> list[str]:
    """Split TEXT into normalised, meaningful matching units.

    Tries paragraph-level splitting first, on Fedlex-style numbered
    markers ("1 ", "1bis ", "2 ", ... at line starts -- see
    _PARAGRAPH_MARKER). If no such marker is found at all (the text is
    plain prose: a distractor fragment, an unrelated snippet), falls back
    to sentence-level splitting on ". ", "; ", ": " (see _SENTENCE_SPLIT).

    Each candidate chunk is then normalise()'d, stripped of trailing
    punctuation, and kept only if at least MIN_LEN characters long --
    shorter than that (a lettered list marker "a.", a one-word
    repealed-paragraph stub) is not enough text to discriminate one
    article edition from another, and short strings inflate
    SequenceMatcher ratios by chance in the window-match step of score().

    MIN_LEN defaults to _MIN_UNIT_LEN (25), the floor used for every normal
    partition (gold-only/distractor-only/shared). score() calls this a
    second time with min_len=_MIN_FALLBACK_UNIT_LEN (8) to build the set for
    distractor_all_coverage only -- see the module docstring "TWO MINIMUM
    UNIT LENGTHS: 25 EVERYWHERE, 8 FOR THIS FALLBACK ONLY" for why that one
    computation needs a lower floor.

    Returns already-normalised strings (not the raw slices), since every
    caller (score()'s substring/window matching) needs the normalised form
    and normalising twice would be wasted, redundant work.
    """
    chunks = _split_paragraphs(text) or _SENTENCE_SPLIT.split(text)
    result = []
    for chunk in chunks:
        norm = normalise(chunk).rstrip(_TRAILING_PUNCT)
        if len(norm) >= min_len:
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


def discriminating_units(gold: str, distractor: str) -> tuple[list[str], list[str], list[str]]:
    """Partition GOLD and DISTRACTOR's units() relative to each other.

    Public helper for chpipe.bench.build (Task 2): given the two candidate
    texts for one article edition pair, return (gold_only, distractor_only,
    shared) -- the same three-way partition score() computes internally to
    decide grounding (see module docstring "WHY UNIT-LEVEL, NOT
    WHOLE-STRING, MATCHING"). `gold_only` is the wording that makes GOLD
    distinguishable from DISTRACTOR at all; an empty `gold_only` means no
    answer, however well-grounded, could ever be told apart from one that
    quoted DISTRACTOR instead -- the caller (build.make_items) uses that to
    drop such a pair from the benchmark rather than ship an unscoreable
    item.

    A unit is "only" one edition's when its normalised form is NOT a
    substring of the OTHER edition's normalised text; anything contained in
    the other text is shared, even when the two units are not equal as
    strings (see module docstring "CONTAINMENT, NOT EQUALITY"). Since a
    unit is by construction a substring of its own text, two identical
    units still land in `shared`, exactly as an equality test would have
    put them -- containment is strictly the more inclusive rule, never the
    other way round. Note the asymmetry it allows, which an intersection
    cannot express: for a pure-addition amendment, the old paragraph is
    shared (it sits inside the new one) while the new paragraph is
    gold-only.

    Not to be confused with the private `_discriminating_units()` below,
    which does something different: given an already-computed gold_only/
    distractor_only split, it finds the near-duplicate *cross-pairs*
    between the two sides (e.g. "...180 Tagen." vs "...30 Tagen.") that
    score() must restrict to exact-match-only. This function runs the
    partition step that precedes that; it does not do the cross-pairing
    itself.

    Lists are sorted for a deterministic return order (the underlying sets
    have none); the elements themselves are already normalise()'d, per
    units().
    """
    gold_units = set(units(gold))
    distractor_units = set(units(distractor))
    norm_gold = normalise(gold)
    norm_distractor = normalise(distractor)
    gold_only = {u for u in gold_units if u not in norm_distractor}
    distractor_only = {u for u in distractor_units if u not in norm_gold}
    shared = (gold_units | distractor_units) - gold_only - distractor_only
    return sorted(gold_only), sorted(distractor_only), sorted(shared)


def _discriminating_units(
    gold_only: set[str], distractor_only: set[str],
    gold_units: set[str], distractor_units: set[str],
    norm_gold: str, norm_distractor: str,
) -> tuple[set[str], set[str]]:
    """Flag the "only" units for which fuzzy matching must be switched off
    -- see module docstring "DISCRIMINATING PAIRS". Those units may only be
    found by exact substring match; everything else keeps the normal
    substring-or-window behaviour.

    TWO TESTS, OR-ed. A unit is discriminating when EITHER holds. They are
    listed here in order of importance and evaluated in the opposite order,
    cheapest first -- `or` short-circuits and the result does not depend on
    which fires.

    1. WINDOW TEST (the primary one): `_window_found(unit, <the other
       edition's whole normalised text>)` -- i.e. the exact question "would
       the fuzzy matcher find this unit in the other edition?", asked with
       the very same function, window lengths and threshold that
       `_coverage()` will later use against the ANSWER. If the answer is
       yes, fuzzy matching is not allowed for this unit, because a verbatim
       quotation of the OTHER edition would then "find" it and the unit
       would prove nothing.

       Running the identical computation in both places is what makes the
       scorer self-consistent rather than merely stricter: for an answer
       that is the other edition verbatim, the flag test and the match test
       are the same call on the same string, so the unit is either flagged
       (and then exact-match-only, and correctly not found) or not flagged
       (and then the window match correctly fails too). Either way the
       cross-edition false positive cannot happen. Measured on the prod
       oracle run, 222+ items scored `ungrounded` on a word-for-word
       correct answer for want of exactly this test: SR 142.203 art. 3,
       where the distractor sentence is not a substring of gold (so it is
       distractor-only, not shared) but does window-match inside gold at
       >= 0.92, driving distractor_coverage to 1.0 alongside gold_coverage
       1.0.

    2. UNIT-PAIR TEST (kept, not subsumed): a near-duplicate (ratio >=
       _WINDOW_RATIO) among ALL of the other edition's units, shared ones
       included. It is tempting to think the window test covers this, and
       it does not: `_window_found` only probes windows of ~0.8x, 1.0x and
       1.2x the unit's length, so when the other edition's whole text is
       SHORTER than 0.8x the unit, no window exists at all and the window
       test returns False even for a pair that is 0.96 similar unit to
       unit. Measured on tests/test_bench_score.py's GOLD_SHORT_ADD /
       DISTRACTOR_SHORT_ADD fixture (a one-paragraph article with an 18-
       character clause appended): unit-pair ratio 0.96, window test False.
       Dropping this test would let an answer reciting the OLD paragraph
       inside a little extra prose window-match the NEW one and score
       `grounded_correct`.

    The unit-pair comparison runs against ALL of the other edition's units,
    not only its "only" ones. Containment (see "CONTAINMENT, NOT EQUALITY")
    files a unit as `shared` precisely when it sits inside the other
    edition's text, which is exactly the near-duplicate relationship this
    guard exists to catch: for an amendment that appends a short clause,
    the old paragraph is shared, the new one is gold-only, and the two are
    ~0.95 similar. Comparing only the "only" sets would leave that pair
    unguarded.

    NORM_GOLD / NORM_DISTRACTOR are the two editions' whole normalise()'d
    texts. `_window_found`'s _MAX_WINDOW_ANSWER_LEN cap applies to them
    unchanged and is deliberately not special-cased: an article text past
    20,000 characters would also be past the cap as an ANSWER, so window
    matching is off on both sides at once and the two stay consistent --
    which is the property this function exists to preserve. (Article texts
    are far below it: p90 ~2,200 characters.)

    Flagging is monotone -- OR-ing a second test can only add units, never
    remove them -- and adding a unit only ever turns a fuzzy match into an
    exact one, so no answer that was found before becomes lost unless it
    was found by fuzzy matching, which is precisely what is being withdrawn.
    A verbatim answer is unaffected either way.
    """
    # The cheap test first: `or` short-circuits, and the unit-pair test is
    # O(units) SequenceMatcher calls against the pairs of units where the
    # window test is O(text length / step). Same result either way; on the
    # commonest amendment shape (one number changed) the pair test fires
    # immediately and the window scan is never run. Measured on a
    # ten-paragraph article: 2 ms per score() this way, 22 ms with the
    # window test first.
    disc_gold = {
        g for g in gold_only
        if any(SequenceMatcher(None, g, d).ratio() >= _WINDOW_RATIO
               for d in distractor_units)
        or _window_found(g, norm_distractor)
    }
    disc_distractor = {
        d for d in distractor_only
        if any(SequenceMatcher(None, d, g).ratio() >= _WINDOW_RATIO
               for g in gold_units)
        or _window_found(d, norm_gold)
    }
    return disc_gold, disc_distractor


def _coverage(
    unit_set: set[str], answer: str, exact_only: frozenset[str] = frozenset()
) -> float:
    if not unit_set:
        return 0.0
    found = 0
    for u in unit_set:
        ok = (u in answer) if u in exact_only else _unit_found(u, answer)
        if ok:
            found += 1
    return found / len(unit_set)


def score(answer: str, gold: str, distractor: str) -> Verdict:
    """Decide whether ANSWER grounds in GOLD (the edition valid on the
    query date), DISTRACTOR (the adjacent edition), both, or neither.

    See the module docstring for the full reasoning; in short: units() both
    candidate texts, partitions the union into gold-only / distractor-only
    / shared by containment in the other text, measures what fraction of
    each partition's units occur in ANSWER (verbatim, or via a
    high-similarity window match unless the unit is part of a
    "discriminating pair" -- see module docstring "DISCRIMINATING PAIRS" --
    in which case only an exact match counts), and applies the 0.6/0.2
    thresholds to gold_coverage and distractor_coverage to pick a label,
    falling back to distractor_all_coverage -- measured over a SEPARATE,
    lower-floor (8-char, not 25) unit set, judged against its own 0.8
    threshold, AND requiring that the answer reproduce at least one unit
    the distractor edition has and the gold text does not -- for the
    wrong-version test when the distractor-only set is empty (a
    pure-addition amendment -- see "WRONG-VERSION DETECTION WHEN THE
    DISTRACTOR-ONLY SET IS EMPTY" and "TWO MINIMUM UNIT LENGTHS" in the
    module docstring, and the `amended_units` comment below for why the
    coverage share alone is not enough).
    """
    norm_answer = normalise(answer)
    norm_gold = normalise(gold)
    gold_only_list, distractor_only_list, shared_list = discriminating_units(gold, distractor)
    gold_only, distractor_only, shared_units = (
        set(gold_only_list),
        set(distractor_only_list),
        set(shared_list),
    )
    gold_units = set(units(gold))
    distractor_units = set(units(distractor))
    disc_gold, disc_distractor = _discriminating_units(
        gold_only, distractor_only, gold_units, distractor_units,
        norm_gold, normalise(distractor))

    gold_coverage = _coverage(gold_only, norm_answer, disc_gold)
    distractor_coverage = _coverage(distractor_only, norm_answer, disc_distractor)
    shared_coverage = _coverage(shared_units, norm_answer)
    # distractor_all_coverage fallback set: ALL of distractor's units, at
    # the lower _MIN_FALLBACK_UNIT_LEN floor -- see "TWO MINIMUM UNIT
    # LENGTHS" in the module docstring. disc_distractor stays valid as the
    # exact_only set here: it is a subset of distractor_only, itself a
    # subset of the normal (25-char) distractor_units, so every unit it
    # names is also a member of this wider set; anything present only
    # because of the lower floor is simply not in disc_distractor and keeps
    # the normal substring-or-window match.
    distractor_all_units = set(units(distractor, min_len=_MIN_FALLBACK_UNIT_LEN))
    distractor_all_coverage = _coverage(distractor_all_units, norm_answer, disc_distractor)

    # The fallback's second, non-negotiable condition: the answer must
    # reproduce at least one unit that belongs to the DISTRACTOR EDITION
    # ALONE -- the wording the amendment replaced -- and not merely the
    # paragraphs both editions share. distractor_all_coverage is a share of
    # ALL of the distractor's units at the 8-character floor, and on a long
    # article most of those are shared paragraphs; five shared paragraphs
    # out of six units is 0.833, so an answer that never touches the
    # amendment at all could clear the 0.8 bar and be filed as
    # `grounded_wrong_version` on the strength of text that says nothing
    # about which edition was read.
    #
    # "Belongs to the distractor alone" is membership in the distractor's
    # unit set but not in the gold text's, at the SAME 8-character floor --
    # not "is not a substring of the gold text". The two differ exactly for
    # a distractor paragraph that sits INSIDE a gold paragraph, which is the
    # commonest amendment shape there is: gold "Er ist zu begruenden und zu
    # unterzeichnen." against distractor "Er ist zu begruenden." An answer
    # quoting the latter reproduces the old edition verbatim and misses the
    # amendment -- the wrong-version answer this fallback exists to catch --
    # yet a substring test would call that unit shared and withdraw the
    # label. Paragraph identity is the right grain: the unit is the old
    # paragraph, and gold does not have it.
    #
    # When no such unit exists at all -- every distractor paragraph is also
    # a gold paragraph, i.e. the amendment only appended text and touched
    # nothing -- the fallback cannot fire, and should not: there is no
    # wording an answer could reproduce that quoting part of the gold text
    # would not equally explain.
    gold_all_units = set(units(gold, min_len=_MIN_FALLBACK_UNIT_LEN))
    amended_units = distractor_all_units - gold_all_units
    amended_found = any(
        (u in norm_answer) if u in disc_distractor else _unit_found(u, norm_answer)
        for u in amended_units
    )

    # Gold first: on a gold-superset item a correct answer scores 1.0 on
    # distractor_all_coverage as well, so the fallback below must never get
    # the chance to relabel it.
    if gold_coverage >= _STRONG and distractor_coverage <= _WEAK:
        label = "grounded_correct"
    elif gold_coverage <= _WEAK and (
        distractor_coverage >= _STRONG
        or (not distractor_only and distractor_all_coverage >= _FALLBACK_STRONG
            and amended_found)
    ):
        label = "grounded_wrong_version"
    else:
        label = "ungrounded"

    return Verdict(
        label=label,
        gold_coverage=gold_coverage,
        distractor_coverage=distractor_coverage,
        shared_coverage=shared_coverage,
        distractor_all_coverage=distractor_all_coverage,
    )
