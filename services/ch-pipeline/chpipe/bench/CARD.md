---
license: other
license_name: fedlex-open-data
license_link: https://www.fedlex.admin.ch/
language:
- de
- fr
- it
task_categories:
- question-answering
pretty_name: "Swiss Point-in-Time Law (CH-PiT)"
size_categories:
- 10K<n<100K
---

# Swiss Point-in-Time Law (CH-PiT)

## Summary

CH-PiT asks one question about a system's answer: **was it grounded in the
version of the Swiss federal article that was actually in force on the date
asked?**

Swiss federal law is amended constantly, and Fedlex keeps every consolidated
edition of every act. A system with no notion of time will happily quote the
current wording of an article even when asked about a date years before that
wording existed, or years after it was replaced. CH-PiT turns real amendment
events into paired questions — "what did Art. X of act Y say as of date
D?" — where the correct answer is one specific edition's text and the wrong
answer is the adjacent edition's text, and it ships a deterministic scorer
that tells the two apart from a free-text answer, not from a multiple-choice
label.

Built by Lawrider, Zurich. First build: 2026-08-25 (v2). Current build:
**v2026.09** (2026-09-04, v3): federal acts only, Fedlex XML editions
only, plus the fixed `core` subset every published baseline runs on.

## Source and licence

Every item is derived from **Fedlex** (the Swiss federal law portal,
fedlex.admin.ch), specifically from consolidated Akoma Ntoso XML editions of
federal acts (`ch_act_version` with `stage = 'parsed'` in this pipeline's own
database — see `services/ch-pipeline/README.md`, "What this corpus does not
contain," item 1). Fedlex publishes machine-readable XML consolidations only
for a subset of acts, and only from the point each act's editor started
producing XML at all — that start date differs per act (for SR 220, the
Code of Obligations, the earliest German XML edition is dated 2021-01-01;
other acts differ). CH-PiT inherits that boundary: it can only ask about a
change if both the edition before and the edition after it exist as parsed
XML in this pipeline's database.

Fedlex data may be reused free of charge, provided the source is
acknowledged ("Fedlex data may be reused free of charge with source
attribution" — the exact licence note stamped on every item's `licence`
field). This card and every item's `source`/`licence` fields carry that
attribution forward. See https://www.fedlex.admin.ch/ for Fedlex's own terms.

## Construction

Source table: `ch_act_change`, one row per (act, article, language) pair of
consecutive parsed editions that differ. A change becomes a benchmark item
pair only if all of the following hold:

- **A federal act.** `ch_act.jurisdiction = 'CH'`. The same tables now
  also hold the 26 cantons' legislation; CH-PiT asks about the federal SR
  collection only.
- **Both editions are Fedlex XML.** `ch_act_version.source = 'fedlex'` on
  both sides of the change (the `--sources` flag; `build-report.json`
  records what was used). The pipeline also holds Fedlex's pdf-a
  consolidations for roughly 1995-2020 (`source = 'fedlex_pdf'`), whose
  article text still carries footnote apparatus -- see Known limits. Every
  item records the source of each edition in `gold.source` /
  `distractor.source`.
- **Modified, not added or removed.** Only `change_type = 'modified'` rows
  are used — an article that appears for the first time or disappears has no
  "before" or "after" counterpart to ask about.
- **Both texts are substantial.** After normalisation (see Scorer, below),
  each edition's article text must be at least 200 characters. This rules
  out stub or largely-repealed articles with near-empty bodies.
- **The texts actually differ.** The two normalised texts must not be the
  same string. This rules out a "change" that is only a re-typesetting of
  whitespace, soft hyphens or quote/dash characters, and nothing else.
  Deliberately **not** a similarity threshold: an earlier version of this
  rule required a `difflib.SequenceMatcher` ratio below 0.9, which threw
  away precisely the amendment CH-PiT exists to ask about — a change that
  swaps one figure leaves a multi-paragraph article ~0.98 similar to its
  predecessor, so the gate kept only wholesale rewrites and silently
  dropped every one-token amendment. Whether the pair can be *scored* apart
  is a separate question, answered separately and at the unit level by the
  discriminating-unit rule below, where a one-digit difference is visible.
- **The act is in force.** `ch_act.enforcement_status = 0`. An act that has
  been repealed entirely is excluded — the benchmark asks about the live
  body of law, not archived history.
- **An abbreviation exists for the language.** German reads
  `ch_act.abbreviation` directly. French and Italian look up
  `ch_act_alias(lang, sr_number, abbr, source)`, preferring a `curated` row
  over a `title_paren`-sourced one when both exist. A change whose act has
  no abbreviation for that language is skipped (`no_abbreviation`) — the
  question templates always name the act by its abbreviation and SR number,
  never by its full title.
- **The article number is unambiguous.** The question can only name an
  article by its number ("Wie lautet Art. 7 OR …?"), and a system resolving
  that number back to a text has to pick one row. Swiss acts routinely
  carry the same article number twice inside one edition — a top-level
  `art_7` and an `art_7` nested in a transitional-provisions block
  (`disp_u17/art_7`). For such a number the question is genuinely
  ambiguous: two different texts answer it. Changes on a nested `e_id` (one
  containing `/`), and changes on any number that some other `e_id` in
  either edition also carries, are excluded and counted as
  `ambiguous_article`.
- **The article number parsed at all.** A change whose `article_number` is
  NULL cannot be named by any question template, and the ambiguity test
  above cannot see it either (SQL NULL compares equal to nothing, so both
  duplicate-number subqueries come up empty and the change looks
  unambiguous). Excluded first, counted as `no_article_number`.
- **Both editions are `parsed`.** The resolver a system is measured against
  only ever returns a `parsed` edition, so a change built on an edition
  that never reached that stage would be scored as a system failure on an
  item the corpus cannot express. Both version joins require it, so builder
  and oracle share one edition population.
- **The two editions do not overlap.** The old edition's
  `date_end_applicability` must be NULL, or strictly earlier than the new
  edition's `date_applicability`. Fedlex sometimes re-issues a
  consolidation without retracting the previous edition's end date, leaving
  two editions that both claim the same day (or days) as in force. Since
  `date_end_applicability` is inclusive, an end date equal to the new
  edition's start date is already an overlap. For such a change there is no
  date the `before` question can ask about: a covering lookup on the old
  edition's own last day returns the NEWER edition, and the item's gold
  answer scores `grounded_wrong_version` against its own gold (13 items on
  the prod build before this rule). Both halves are dropped, not just
  `before` — the same overlap makes the change date itself ambiguous, with
  only the resolver's ordering deciding which edition wins. Counted as
  `overlapping_editions`.
- **The edition pair has at least one discriminating unit.** Splitting both
  texts into paragraph- or sentence-level units (see Scorer), the edition
  valid on the query date must contain at least one unit that is *not*
  contained, word-for-word, anywhere in the other edition's text. If it
  doesn't — the whole visible change is something this scorer's unit-level
  matching cannot represent as a difference — the item is dropped
  (`no_discriminating_unit`) rather than shipped unscoreable.

  **Pure deletions are not benchmarkable this way.** When an amendment only
  removes wording — a sentence struck from a paragraph, with nothing added —
  the shorter edition's text is entirely contained in the longer one's, so
  the half whose gold is the shorter edition has no discriminating unit and
  is dropped. This is not a scorer limitation to be tuned away: a correct
  answer is textually a fragment of the wrong answer, so nothing an answer
  *contains* can prove which of the two it meant. (The half whose gold is
  the longer edition is unaffected and is kept, so a deletion still
  contributes one item, not two.)

A change that survives all of the above produces **two items**, `before` and
`after`:

- `before`: `as_of` = the gold edition's **last day in force** — its
  `date_end_applicability`, which is inclusive. This is usually the change
  date minus one day, but not always: consecutive parsed editions can leave
  a gap, since Fedlex did not publish XML for every consolidation, and the
  day before the change can fall in that gap where no edition exists to
  answer the question at all. Only when the old edition carries no
  `date_end_applicability` does the builder fall back to the change date
  minus one day. Gold = the edition valid before the change; distractor =
  the edition valid after it.
- `after`: `as_of` = the change's `date_applicability` itself; gold = the
  edition valid after the change; distractor = the edition valid before it.

Either half can still be dropped independently by the discriminating-unit
rule above, so a change can contribute 0, 1 or 2 items.

**Caps and sampling.** At most 50 changes are kept per act (so one heavily
amended act like the Code of Obligations cannot dominate the sample), and at
most 5,000 items per language in total. The language cap is on ITEMS, and
the builder consumes eligible changes until it is reached — a change yields
one item or two, never a fixed number, so budgeting changes instead would
leave the cap unfilled. Selection above the caps is random,
seeded per language as `random.Random(f"{seed}:{lang}")` with
`seed = 20260825` — each language's sample depends only on its own seed and
its own eligible-change set, never on which other languages were built in
the same run or in what order. This makes `bench-fr.jsonl` byte-identical
regardless of whether French was built alongside German and Italian or on
its own.

**The `core` subset.** The full build is 5,000 items per language; the
scorer is free, so the only cost a baseline has is its model calls, and
without one fixed sample every reproduction picks its own subset and the
numbers stop being comparable. `core` is the sample every published
baseline runs on: **500 items per language**, chosen by
`chpipe/bench/core_split.py` with `random.Random(f"{seed}:{lang}:core")`.
It takes an equal share of each `as_of` year present in that language's
items (remainder to the earliest years), and within a year fills the four
(`kind`, `gold_is_current`) cells round-robin, so `before`/`after` and
current/superseded gold are each as even as the year's pool allows. A year
too thin for its share (2011 has a few dozen items, only in French and
Italian) keeps what it has and the shortfall is filled from the other
years, again round-robin. Note that a `before` item's gold is the edition
the change replaced, which is current only in the rare case where the old
edition never received an end date, so the current/superseded balance is
really an `after` property. `core-{lang}.jsonl` holds the subset and every
item in `bench-{lang}.jsonl` carries `core: true/false`. Per-year and
per-cell counts are in `build-report.json` under `{lang}.core`.

Every skip reason above (`no_abbreviation`, `identical_or_short`,
`ambiguous_article`, `overlapping_editions`, `no_discriminating_unit`, plus
`capped` for anything left unused by the two caps) is counted in `build-report.json`, per
language, alongside `changes_considered`, `selected` and `items`.
`changes_considered` is every `modified` change on an in-force act in that
language, including the ones excluded in SQL, so the skip counts account
for the whole difference rather than the exclusions shrinking the total.

## Fields

Each line of `bench-{lang}.jsonl` is one JSON object:

| field | type | meaning |
|---|---|---|
| `build` | string | the build this item was first published in, e.g. `"v2026.09"` -- items are frozen at publication and later builds only add |
| `core` | boolean | true for the 500-per-language `core` subset every published baseline runs on (see Construction) |
| `id` | string | stable id, first 16 hex chars of `sha1(f"{lang}\|{act_id}\|{sr_number}\|{e_id}\|{as_of}")` — `act_id` is in the payload because more than one act can share an SR number, and two such acts amended in the same article on the same date would otherwise collide on one id |
| `lang` | string | `de`, `fr`, or `it` |
| `act_id` | integer | the exact `ch_act` row this item's editions come from — resolve editions by this, not by `sr_number` alone, since more than one act can share a SR number (a predecessor act and its successor filed under the same number) |
| `sr_number` | string | the act's Systematische Rechtssammlung number (e.g. `"220"`) |
| `abbreviation` | string | the act's abbreviation in this language (e.g. `"OR"`, `"CO"`) |
| `article_number` | string | the article number asked about (e.g. `"336"`) |
| `e_id` | string | the article's element id in the Akoma Ntoso structure, used to join editions |
| `as_of` | string (ISO date) | the date the question asks about |
| `kind` | string | `before` or `after` — which side of the change `as_of` falls on |
| `change_date` | string (ISO date) | the `ch_act_change` row's `date_applicability` this item pair is derived from |
| `question` | string | the rendered natural-language question, in `lang` |
| `gold_is_current` | boolean | true when `gold.date_end_applicability` is null, i.e. the gold edition is still the wording in force today. An item where this is true can be answered correctly by a system that simply recites the current text and ignores the date; only the `false` items measure point-in-time grounding. The report splits the correct-answer share on this flag |
| `gold` | object | the edition valid on `as_of` — see below |
| `distractor` | object | the adjacent edition (the other side of the same change) — see below |
| `source` | string | always `"Fedlex (fedlex.admin.ch)"` |
| `licence` | string | always `"Fedlex data may be reused free of charge with source attribution"` |

`gold` and `distractor` share the same shape:

| field | type | meaning |
|---|---|---|
| `version_id` | integer | the `ch_act_version` row id |
| `date_applicability` | string (ISO date) | the date this edition took effect |
| `date_end_applicability` | string (ISO date) or null | the LAST DAY this edition was in force (inclusive), or null if still current -- the next edition's `date_applicability` is this date + 1 day |
| `eli` | string | the edition's `eli_consolidation_uri`, Fedlex's own permanent identifier for it |
| `source` | string | where the edition's text came from: `fedlex` (Akoma Ntoso XML) -- the only value in this build; `fedlex_pdf` (pdf-a consolidation) is reserved for a later build |
| `text` | string | the article's text in this edition, verbatim from `ch_act_article.text` — no normalisation applied at build time |

## Scorer

`chpipe/bench/score.py` decides, given a free-text answer and the item's
`gold.text` / `distractor.text`, whether the answer is grounded in the
correct edition, the wrong one, or neither. It is pure and deterministic:
no database, no network, same three strings in, same verdict out.

**Normalisation** (`normalise()`): NFKC fold, lower-case, unify quote
characters (guillemets, curly quotes) to `"`/`'` and dash characters (en
dash, em dash, minus sign, non-breaking hyphen) to `-`, drop soft hyphens
(a Fedlex line-break artefact), collapse whitespace runs to a single space.
This folds cosmetic re-typesetting differences out without touching actual
wording.

**Units** (`units()`): each candidate text is split into paragraph-level
units on Fedlex's numbered-paragraph markers (`1 `, `1bis `, `2 `, …), or,
if the text has no such markers, into sentence-level units on `.`/`;`/`:`.
A unit shorter than 25 normalised characters is discarded — too short to
tell one edition from another, and short strings inflate similarity scores
by chance. This 25-char floor is the default used everywhere in the scorer
except one case: `distractor_all_coverage` (see below) is computed with an
8-char floor instead, so a short but real distractor paragraph is not
dropped out of that one computation.

**Partition.** The gold and distractor texts' units are compared against
each other and split three ways: **gold-only** (a unit of gold whose
normalised form does not occur anywhere in the distractor's normalised
text — evidence the answer quotes gold), **distractor-only** (the mirror
image), and **shared** (everything else: a unit contained in the other
edition's text, so finding it is evidence of neither). Coverage is the
fraction of each partition's units found in the answer; shared-coverage is
reported for diagnostics only and never decides the label.

The test is **containment, not equality**, and that matters for the
commonest amendment shape there is. When an amendment adds words to a
paragraph, the old paragraph is a substring of the new one: the two units
are not equal, but every answer quoting the new (correct) wording verbatim
necessarily contains the old wording too. Treating the old paragraph as
distractor-only therefore scored word-for-word correct answers as
`ungrounded` — 1,097 items on the first full build did exactly that.
Under containment the old paragraph is shared, and only the added wording
discriminates.

**`distractor_all_coverage`.** Containment has a consequence: for an
amendment that only adds wording, *no* unit is distractor-only, so
`distractor_coverage` is 0.0 by construction and an answer reciting the old
edition could never be caught as wrong-version. So the scorer also reports
`distractor_all_coverage`, the share of **all** the distractor's units —
distractor-only and shared alike — found in the answer, and uses it as the
wrong-version signal in exactly that case (see Labels). It is a diagnostic
everywhere else: on such an item a correct answer scores 1.0 on it too,
which is why it is only ever consulted after the gold-side test has already
failed.

This one computation uses a **lower unit-length floor: 8 normalised
characters, not the usual 25.** Reusing the normal 25-char floor here
reintroduced a version of the same bug this fallback exists to close: when
the amendment's *old* (distractor) paragraph is itself short — e.g. a
two-paragraph article where paragraph 2 changes from "Er ist zu
begründen." (20 chars) to "Er ist zu begründen und zu unterzeichnen." — the
25-char floor drops that paragraph out of the set entirely, leaving only
the unrelated, unchanged paragraph 1. An answer that quotes *only* that
unchanged paragraph then found the one unit that survived the filter,
scored `distractor_all_coverage` 1.0, and was labelled
`grounded_wrong_version` despite never touching the amendment. With the
8-char floor the short paragraph is back in the set, and that same answer
now scores 0.5 (one of two units found) — which is also why the fallback's
own threshold was raised to 0.8 (see Labels): on a two-unit set, 0.5 still
clears the normal 0.6 floor.

**Discriminating pairs.** A Fedlex amendment often changes exactly one
number or short word and leaves the rest of the paragraph untouched (e.g.
"180 days" becomes "30 days"). Two such near-identical paragraphs can score
above 0.92 on plain string similarity even though they mean different
things. The rule, in one sentence: **if fuzzy matching would find this unit
in the other edition, fuzzy matching is not allowed for it.** Such a unit
is *discriminating*: it may only be found by an **exact** substring match
in the normalised answer, never by the fuzzy window match described next.
This is what lets the scorer catch the one-number-changed case, which is
the hard case the benchmark exists to test.

A unit is flagged discriminating when either test fires:

- **Window test.** The unit is run through the *same* fuzzy window match
  (same window lengths, same 0.92 threshold) against the other edition's
  whole normalised text. Asking the flag question with the matching
  function is what makes the scorer self-consistent rather than merely
  stricter: against an answer that quotes the other edition verbatim, the
  flag test and the match test are the same computation on the same string,
  so the unit is either flagged (exact-only, correctly not found) or
  unflagged (and the window match correctly fails too). Either way the
  cross-edition false positive cannot happen. Without this test, 222+ items
  on the prod oracle run scored `ungrounded` on a word-for-word correct
  answer — e.g. SR 142.203 Art. 3, where an amendment both rewords a phrase
  and appends a clause, leaving a distractor-only sentence that scores only
  0.84 pairwise against the gold sentence but window-matches inside the gold
  text above 0.92.
- **Unit-pair test.** The unit scores 0.92 or higher against **any** of the
  other edition's units, shared ones included. This is kept alongside the
  window test, not replaced by it: the window match only probes windows of
  roughly 0.8x, 1.0x and 1.2x the unit's length, so when the other
  edition's whole text is *shorter* than 0.8x the unit — a one-paragraph
  article with a clause appended — no window exists and the test cannot
  fire, on a pair that is 0.96 similar unit to unit. The comparison runs
  against all of the other edition's units, shared ones included, because
  containment files a unit as shared exactly when it sits inside the other
  edition's text, which is itself the near-duplicate relationship this
  guard exists to catch.

**Fuzzy window match (0.92).** For a unit that is not a discriminating
unit, if it does not occur verbatim in the normalised answer, the scorer
also checks whether some window of the answer roughly the unit's own
length matches it with `SequenceMatcher.ratio() >= 0.92`. This tolerates a
model re-typing a word slightly wrong, a stray OCR-style slip, or a typo,
while still rejecting a paragraph that is merely topically similar.

**Cost of the exact-match rule.** Switching fuzzy matching off for
discriminating units is what makes the one-number case scoreable at all,
and it is not free. Four consequences to read a CH-PiT number with:

- **One character wrong in a discriminating unit means "not found."** An
  answer that gets the amended figure exactly right but mistypes a word
  elsewhere in the *same* paragraph scores that unit as missed. There is no
  partial credit inside a discriminating unit.
- **A long single-paragraph article is effectively a verbatim-only item.**
  Units are paragraphs; an article that is one long paragraph is one long
  unit, and if that unit is discriminating, the whole item can only be
  scored `grounded_correct` by an answer that reproduces the entire
  paragraph character-for-character after normalisation. Such items measure
  verbatim recall as much as they measure date grounding.
- **Answers over 20,000 characters get substring matching only.** Window
  matching is skipped above that length (a bounded-calculation trade — see
  the performance cap in `score.py`), so a runaway answer loses
  near-verbatim credit even on non-discriminating units.
- **A correct answer in the wrong language scores `ungrounded`.** Units are
  compared against the item's own `gold.text`, which is in the item's
  `lang`. A model that answers the German question with a correct French
  quotation of the same article shares no units with either candidate and
  is scored as grounding in neither — not as correct.

**Labels.** `grounded_correct` requires `gold_coverage >= 0.6` and
`distractor_coverage <= 0.2`, and is tested first. `grounded_wrong_version`
requires `gold_coverage <= 0.2` and either `distractor_coverage >= 0.6` or —
when there are no distractor-only units at all, the pure-addition case above
— `distractor_all_coverage >= 0.8` **and** the answer containing at least
one unit the distractor edition has and the gold text does not (the
amendment's old wording, at the same 8-char floor). That fallback threshold
is deliberately higher than the 0.6 used everywhere else, in exchange for
the lower 8-char unit floor described above; the extra unit condition is
what stops a long article's shared paragraphs from carrying the 0.8 share
on their own (five shared paragraphs out of six units is 0.833). "Has and
gold does not" is unit-set membership, not substring containment: a
distractor paragraph nested inside a gold paragraph ("Er ist zu
begründen." inside "Er ist zu begründen und zu unterzeichnen.") is exactly
the wrong-version answer this fallback exists to catch. When no such unit
exists at all — every distractor paragraph is also a gold paragraph, the
amendment only appended text — the fallback cannot fire. Everything else —
including an answer that clears neither floor, or one that clears 0.6 on
one side while also leaking past 0.2 on the other — is `ungrounded`.

**Why 0.6 / 0.2, not 0.5 / 0.5.** Many changes have as few as one gold-only
and one distractor-only unit, so coverage on that partition can only be 0.0
or 1.0 — 0.6/0.2 is simply "found it" versus "did not find it" in that
common case. The gap between 0.2 and 0.6 is reserved for partitions with
several units, where an answer that got some but not all of the
discriminating wording right is scored `ungrounded` rather than guessed
at: a partial match to one edition's distinguishing wording is not
evidence the model resolved the date correctly, and treating it as such
would let a benchmark that exists to measure date-grounding reward
recitation-by-memory instead. The split is also deliberately asymmetric in
effect: it biases toward `ungrounded` over a confident label whenever
coverage is ambiguous, because a false `grounded_correct` or
`grounded_wrong_version` corrupts an accuracy number a paper would cite,
while an `ungrounded` false negative only costs one data point.

## Baselines

**Oracle** (`run_oracle.py`): answers every item straight from the
database, resolving act → edition → article the same way the product tool
(`ch_get_act_article`) does, with no LLM involved. Its only purpose is to
prove the builder and the scorer agree with each other — the oracle **must**
score 100% `grounded_correct`. Anything less means a bug in `build.py` or
`score.py`, not that "the database got the date wrong."

**Bedrock models** (`run_llm.py`): asks a model the exact `question` field
from the item, with **no retrieval** — the model has no access to the
gold or distractor text, only the act, article number and date, exactly as
a chat user would type it. System prompt, verbatim:

> You are a Swiss legal database. Answer with the verbatim text of the
> requested article as in force on the given date, in the language of the
> question, nothing else.

Sampling is 300 items per language, stratified by `kind` (`before`/`after`)
so a systematic bias toward one side of a cutoff date cannot hide inside an
unbalanced sample, seeded the same way item selection is
(`random.Random(f"{seed}:{lang}:llm")`). Temperature 0, max 2048 output
tokens. Every Bedrock call costs money; `run_llm.py` refuses to run without
`CHPIPE_BENCH_CONFIRM=1`, printing a cost estimate first — see the README's
bench section for the exact commands.

**Reading the report.** `report.py` reduces a run to one row per (language,
system, `kind`) plus an `all` row per (language, system), and reports on
each row the label shares, the mean coverages, an `errors` count (result
lines the system failed on — a Bedrock exception, or an oracle resolution
step that came up empty), and the correct-answer share split on
`gold_is_current`. Read the `gold_is_current = false` share, not the
headline `score`, as the point-in-time grounding number.

## Results

Current build: **v2026.09**, 2026-09-04 10:22 UTC -- federal acts, Fedlex
XML editions, 5,000 items per language plus the 500-per-language `core`
subset. Oracle on all 15,000 items: 1.000 in German, French and Italian,
0 errors (see `RESULTS.md`, "v2026.09"). Model baselines on `core` are
run via OpenRouter and reported there as they land. The paragraph below
describes the v2 run of 2026-08-25, kept for history.

Previous build and run: 2026-08-25 23:24 UTC, commit `28618f7d` (v2 --
item ids include the source act's `act_id`, parsed editions only, adds the
`no_article_number` skip). A first run on the previous build (v1, item ids
without `act_id`, 2026-08-25 19:56 UTC) gave identical headline numbers.
Full numbers, per-language and per-`kind` tables (now including mean gold
and mean distractor coverage), the year distribution of `as_of` dates, the
runner settings, actual spend for both runs, and a qualitative read of the
model answers are all in [`RESULTS.md`](./RESULTS.md). Headline numbers:

- **Oracle**: 1.000 (`grounded_correct`) in German, French and Italian, the
  builder and the scorer agree with each other.
- **Haiku 4.5** (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`, no
  retrieval): 0.000 in all three languages.
- **Sonnet 4.6** (`eu.anthropic.claude-sonnet-4-6`, no retrieval): 0.003 in
  German (0.007 on `after` items, 0.000 on `before`), 0.000 in French and
  Italian.

Without point-in-time retrieval, a general-purpose model's verbatim recall
of the specific dated edition is effectively zero. CH-PiT is measuring
whether a system has a retrieval layer that finds the right edition, not
how good the underlying language model is.

### Dates

The `as_of` year distribution in the current build includes 191 items in
2027, 13 in 2028 and 11 in 2029, all after the 2026-08-25 23:24 UTC build
date. These are not placeholder or malformed dates: they are editions
Fedlex has already published with a future in-force date (an amendment
enacted now that takes effect on a later date), and CH-PiT asks about the
edition valid on the date it takes effect, which can be after the date the
benchmark was built. See `RESULTS.md` for the full year-by-year table.

## Known limits

- **Fedlex XML editions only, mostly from 2021 onward.** CH-PiT asks
  only about changes where both adjacent editions are parsed Akoma Ntoso
  XML (`source = 'fedlex'`). Fedlex's XML consolidations do not go back
  further than roughly 2020 for most acts (SR 220's earliest German XML
  edition is dated 2021-01-01). The pipeline does hold Fedlex's pdf-a
  consolidations for roughly 1995-2020, split into articles, and
  `ch_act_change` has ~166K federal German "modified" changes for
  2000-2019 built from them -- but on a 100-pair hand-read sample of those
  changes that pass this builder's filters, about 85% were footnote
  apparatus surviving in the article text (three-digit footnote
  references glued to words, footnote bodies where no running header
  marked the page), not amendments. Until the PDF splitter strips that
  apparatus (tracked as LEXAI-2046), the pre-2021 history stays out; the
  `--sources` flag and the per-edition `source` field are how it comes
  back in a later build without changing the item shape.
- **Three languages, no Romansh.** German, French and Italian only — Fedlex
  does not publish Romansh consolidations for these acts.
- **In-force acts only.** An act with `enforcement_status != 0` (repealed
  entirely) contributes no items, even if its amendment history is
  otherwise well covered.
- **The hard case is a single number or short word changing.** Most real
  Fedlex amendments change one figure or phrase in an otherwise unchanged
  paragraph (see Scorer, "Discriminating pairs"). This is the case the
  benchmark is designed to catch and the case a system with no real
  point-in-time grounding is most likely to get wrong by reciting the
  current wording from memory.
- **The `2021-01-01` "placeholder date" used elsewhere in this repo does
  not apply here.** `services/ch-pipeline`'s decisions pipeline treats
  `decision_date = '2021-01-01'` as a source placeholder meaning "no date
  known" for a subset of court decisions (see the README's "The
  `2021-01-01` placeholder" section). CH-PiT's `as_of` and
  `change_date` fields are real dates read from `ch_act_version` and
  `ch_act_change` — 2021-01-01 appearing in an item is a real change date,
  never a stand-in for "unknown."
- **Long unsegmented articles are near-unscoreable in practice.** The
  scorer works on paragraph units. An article Fedlex publishes as a single
  unnumbered block becomes one unit, so `grounded_correct` demands a
  character-exact reproduction of the whole thing (see Scorer, "Cost of the
  exact-match rule"). Such items are kept — they are real questions — but a
  system's score on them reflects verbatim recall more than date
  resolution, and a per-item length breakdown is worth looking at before
  reading a headline number as a grounding measurement.
- **Some items have a still-current gold edition** (11% of v2026.09:
  1,657 of 15,000; a third of `core`'s `after` items by construction). The
  `after` half of a pair whose change is the most recent one asks for
  wording that is also today's wording, and reciting the current text
  answers it correctly with no date reasoning at all. This is why every item carries
  `gold_is_current` and the report splits the correct-answer share on it;
  the `gold_is_current = false` share is the one that measures what the
  benchmark is named after.
- **Amendments that only delete wording contribute one item, not two.**
  See Construction: the half whose gold is the shorter edition has no
  wording of its own to find and is dropped. A benchmark built this way
  therefore under-represents repeals relative to their share of real
  amendment traffic.
- **The `distractor_all_coverage` fallback is a coarser signal than
  `distractor_coverage`.** Its share is measured over *all* of distractor's
  units (8-char floor, 0.8 threshold — see Scorer), not just the unit the
  amendment actually touched, so on a long article the shared paragraphs
  dominate the arithmetic. The label no longer rests on that share alone —
  the fallback additionally requires the answer to reproduce a unit gold
  does not have, which is what makes it a statement about the amendment
  rather than about the article — but the share itself is still a blunt
  instrument next to `distractor_coverage`'s proper distractor-only
  partition, which is scoped to exactly the discriminating wording. The
  price of the extra condition is the pure-addition-of-whole-paragraphs
  shape: when every distractor paragraph is also a gold paragraph, no
  answer can be labelled `grounded_wrong_version` at all, and an answer
  reciting the old edition reads `ungrounded`.
- **`before` items are dated by the edition, not by the change.** An
  item's `as_of` is the gold edition's last day in force, which is the
  change date minus one day only when the two editions are contiguous.
  Where Fedlex's XML consolidations skip an edition, `as_of` sits further
  back — still a date on which the gold text was genuinely in force, but
  not always adjacent to `change_date`.
- **No cantonal law.** CH-PiT covers only federal acts (the corpus this
  pipeline builds from Fedlex's federal SR collection); cantonal statutes
  are out of scope entirely.

## How to reproduce

From `services/ch-pipeline`:

```
# 1. Build the items (v2026.09: federal acts, XML editions, 500-per-language core).
python -m chpipe.bench.build --langs de,fr,it --out /data/ch-corpus/bench-v3 \
    --build v2026.09 --core-per-lang 500        # --sources fedlex is the default

# 2. Oracle. Must come back 100% grounded_correct before step 3 spends anything.
python -m chpipe.bench.run_oracle --items /data/ch-corpus/bench --out /data/ch-corpus/bench

# 3a. Bedrock baselines, DRY RUN: prints a JSON cost estimate, calls nothing, exits 2.
python -m chpipe.bench.run_llm --items /data/ch-corpus/bench --out /data/ch-corpus/bench --sample-per-lang 300

# 3b. Only once that estimate looks reasonable, run for real.
CHPIPE_BENCH_CONFIRM=1 python -m chpipe.bench.run_llm --items /data/ch-corpus/bench --out /data/ch-corpus/bench --sample-per-lang 300

# 4. Report.
python -m chpipe.bench.report --results /data/ch-corpus/bench/results-oracle.jsonl /data/ch-corpus/bench/results-llm-haiku-4-5.jsonl /data/ch-corpus/bench/results-llm-sonnet-4-6.jsonl --items /data/ch-corpus/bench --out /data/ch-corpus/bench/report.json
```

See `services/ch-pipeline/README.md`, "Point-in-time benchmark
(chpipe.bench)," for the full command reference, the cost gate, and what
each step writes.

## Citation

```bibtex
@misc{chpit2026,
  title  = {Swiss Point-in-Time Law (CH-PiT): A Benchmark for Date-Grounded Legal Question Answering},
  author = {Lawrider},
  year   = {2026},
  note   = {Built from Fedlex (fedlex.admin.ch) consolidated legislation},
  url    = {https://www.fedlex.admin.ch/}
}
```

## Contact

hello@lawrider.ch
