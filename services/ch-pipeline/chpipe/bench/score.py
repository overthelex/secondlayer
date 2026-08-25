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

The mirror case -- a pure DELETION, gold is a strict subset of distractor
-- leaves the GOLD-only set empty, and no fallback can rescue it: a
correct answer is textually a fragment of the wrong answer, so nothing an
answer contains can prove it meant the shorter edition. Such an item is
undecidable by design, and build.make_items() drops it at build time
(`no_discriminating_unit`, via discriminating_units()) rather than shipping
it. Pure deletions of a whole sentence are therefore not benchmarkable this
way; see CARD.md, "Construction."

LABEL THRESHOLDS: 0.6 / 0.2
`grounded_correct` requires gold_coverage >= 0.6 AND distractor_coverage
<= 0.2; `grounded_wrong_version` is the mirror (gold_coverage <= 0.2 AND
either distractor_coverage >= 0.6, or -- when there are no distractor-only
units at all, see "WRONG-VERSION DETECTION" above -- distractor_all_coverage
>= 0.6). The gold test is applied first, so an answer that clears both is
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

The fix: before matching, every gold-only unit is compared against ALL of
the distractor's units -- shared ones included, not just the
distractor-only ones -- with `SequenceMatcher.ratio()` on their normalised
forms, and vice versa (see `_discriminating_units()`). All of them,
because containment (above) files a unit as shared exactly when it sits
inside the other edition's text, which is itself a near-duplicate
relationship: append a short clause to a paragraph and the old paragraph
is shared, the new one gold-only, and the pair is ~0.95 similar with no
distractor-only unit anywhere to flag it against. Any unit with a
counterpart at or above `_WINDOW_RATIO` (0.92 -- the same constant, reused
rather than duplicated, since it is the same "these two strings are
suspiciously similar" test) is a DISCRIMINATING unit: for that unit, and that unit
only, fuzzy window matching is switched off, and it may be found only by
an exact substring match of its normalised form in the normalised answer
(see `_coverage()`'s `exact_only` parameter). Units with no
near-duplicate on the other side are unaffected and keep the normal
substring-or-window behaviour.

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
    both -- see module docstring). The four coverage fields are shares in
    [0.0, 1.0] of the corresponding unit set found in the answer; a set
    with zero units always reports coverage 0.0 (never NaN, never
    undefined), including shared_coverage.

    gold_coverage / distractor_coverage / shared_coverage are over the
    three-way partition (see module docstring "WHY UNIT-LEVEL...").
    `distractor_all_coverage` is over ALL of the distractor's units,
    distractor-only and shared alike; it overlaps the other two on purpose,
    and exists as the wrong-version fallback for a pure-addition amendment
    where the distractor-only set is empty (see "WRONG-VERSION DETECTION
    WHEN THE DISTRACTOR-ONLY SET IS EMPTY"). Read it as a diagnostic
    everywhere else -- on a gold-superset item a correct answer scores 1.0
    on it too.
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
) -> tuple[set[str], set[str]]:
    """Flag the "only" units that have a near-duplicate (ratio >=
    _WINDOW_RATIO) among the OTHER edition's units -- see module docstring
    "DISCRIMINATING PAIRS". Those units may only be found by exact
    substring match; everything else keeps the normal substring-or-window
    behaviour.

    The comparison is against ALL of the other edition's units, not only
    its "only" ones. Containment (see "CONTAINMENT, NOT EQUALITY") files a
    unit as `shared` precisely when it sits inside the other edition's
    text, which is exactly the near-duplicate relationship this guard
    exists to catch: for an amendment that appends a short clause, the old
    paragraph is shared, the new one is gold-only, and the two are ~0.95
    similar. Comparing only the "only" sets would leave that pair unguarded
    -- the gold unit would have no counterpart to be flagged against, and
    an answer reciting the OLD paragraph could window-match the new one and
    be scored `grounded_correct`. Which is the exact failure the guard was
    written for, reintroduced through the other door.
    """
    disc_gold = {
        g for g in gold_only
        if any(SequenceMatcher(None, g, d).ratio() >= _WINDOW_RATIO
               for d in distractor_units)
    }
    disc_distractor = {
        d for d in distractor_only
        if any(SequenceMatcher(None, d, g).ratio() >= _WINDOW_RATIO
               for g in gold_units)
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
    falling back to distractor_all_coverage for the wrong-version test when
    the distractor-only set is empty (a pure-addition amendment -- see
    "WRONG-VERSION DETECTION WHEN THE DISTRACTOR-ONLY SET IS EMPTY").
    """
    norm_answer = normalise(answer)
    gold_only_list, distractor_only_list, shared_list = discriminating_units(gold, distractor)
    gold_only, distractor_only, shared_units = (
        set(gold_only_list),
        set(distractor_only_list),
        set(shared_list),
    )
    gold_units = set(units(gold))
    distractor_units = set(units(distractor))
    disc_gold, disc_distractor = _discriminating_units(
        gold_only, distractor_only, gold_units, distractor_units)

    gold_coverage = _coverage(gold_only, norm_answer, disc_gold)
    distractor_coverage = _coverage(distractor_only, norm_answer, disc_distractor)
    shared_coverage = _coverage(shared_units, norm_answer)
    distractor_all_coverage = _coverage(distractor_units, norm_answer, disc_distractor)

    # Gold first: on a gold-superset item a correct answer scores 1.0 on
    # distractor_all_coverage as well, so the fallback below must never get
    # the chance to relabel it.
    if gold_coverage >= _STRONG and distractor_coverage <= _WEAK:
        label = "grounded_correct"
    elif gold_coverage <= _WEAK and (
        distractor_coverage >= _STRONG
        or (not distractor_only and distractor_all_coverage >= _STRONG)
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
