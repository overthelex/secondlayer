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
# size_categories: TODO — fill in once the prod build (Task 7) has written
# bench-{lang}.jsonl and build-report.json; item counts depend on how many
# eligible changes survive the per-act (50) and per-language (5,000) caps.
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

Built by Lawrider, Zurich. First build: 2026-08-25.

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

- **Modified, not added or removed.** Only `change_type = 'modified'` rows
  are used — an article that appears for the first time or disappears has no
  "before" or "after" counterpart to ask about.
- **Both texts are substantial.** After normalisation (see Scorer, below),
  each edition's article text must be at least 200 characters. This rules
  out stub or largely-repealed articles with near-empty bodies.
- **The texts actually differ.** `difflib.SequenceMatcher` on the two
  normalised texts must score below 0.9. This rules out a "change" that is
  only a re-typesetting of punctuation or whitespace, not a change in
  wording.
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
- **The edition pair has at least one discriminating unit.** Splitting both
  texts into paragraph- or sentence-level units (see Scorer), the edition
  valid on the query date must contain at least one unit that is *not* also
  present, word-for-word, in the other edition. If it doesn't — the whole
  visible change is something this scorer's unit-level matching cannot
  represent as a difference — the item is dropped (`no_discriminating_unit`)
  rather than shipped unscoreable.

A change that survives all of the above produces **two items**, `before` and
`after`:

- `before`: `as_of` = the change's `date_applicability` minus one day; gold
  = the edition valid before the change; distractor = the edition valid
  after it.
- `after`: `as_of` = the change's `date_applicability` itself; gold = the
  edition valid after the change; distractor = the edition valid before it.

Either half can still be dropped independently by the discriminating-unit
rule above, so a change can contribute 0, 1 or 2 items.

**Caps and sampling.** At most 50 changes are kept per act (so one heavily
amended act like the Code of Obligations cannot dominate the sample), and at
most 5,000 items per language in total. Selection above the caps is random,
seeded per language as `random.Random(f"{seed}:{lang}")` with
`seed = 20260825` — each language's sample depends only on its own seed and
its own eligible-change set, never on which other languages were built in
the same run or in what order. This makes `bench-fr.jsonl` byte-identical
regardless of whether French was built alongside German and Italian or on
its own.

Every skip reason above (`no_abbreviation`, `near_identical_or_short`,
`no_discriminating_unit`, plus `capped` for anything trimmed by the two
caps) is counted in `build-report.json`, per language, alongside
`changes_considered`, `selected` and `items`.

## Fields

Each line of `bench-{lang}.jsonl` is one JSON object:

| field | type | meaning |
|---|---|---|
| `id` | string | stable id, first 16 hex chars of `sha1(f"{lang}\|{sr_number}\|{e_id}\|{as_of}")` |
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
by chance.

**Partition.** The gold and distractor texts' units are compared against
each other and split three ways: **gold-only** (wording in gold but not in
distractor — evidence the answer quotes gold), **distractor-only** (the
mirror image), and **shared** (identical in both — present in both, so
finding it is evidence of neither). Coverage is the fraction of each
partition's units found in the answer; shared-coverage is reported for
diagnostics only and never decides the label.

**Discriminating pairs.** A Fedlex amendment often changes exactly one
number or short word and leaves the rest of the paragraph untouched (e.g.
"180 days" becomes "30 days"). Two such near-identical paragraphs can score
above 0.92 on plain string similarity even though they mean different
things. For any gold-only unit that has a distractor-only unit scoring
0.92 or higher against it (and vice versa), fuzzy matching is switched off
for that unit: it may only be found by an **exact** substring match in the
normalised answer, never by the fuzzy window match described next. This is
what lets the scorer catch the one-number-changed case, which is the hard
case the benchmark exists to test.

**Fuzzy window match (0.92).** For a unit that is not a discriminating
unit, if it does not occur verbatim in the normalised answer, the scorer
also checks whether some window of the answer roughly the unit's own
length matches it with `SequenceMatcher.ratio() >= 0.92`. This tolerates a
model re-typing a word slightly wrong, a stray OCR-style slip, or a typo,
while still rejecting a paragraph that is merely topically similar.

**Labels.** `grounded_correct` requires `gold_coverage >= 0.6` and
`distractor_coverage <= 0.2`. `grounded_wrong_version` is the mirror:
`distractor_coverage >= 0.6` and `gold_coverage <= 0.2`. Everything else —
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

## Known limits

- **Machine-readable Fedlex editions only, mostly from 2020 onward.**
  CH-PiT can only ask about a change where both adjacent editions exist as
  parsed Akoma Ntoso XML. Fedlex's XML consolidations do not go back
  further than roughly 2020 for most acts (SR 220's earliest German XML
  edition, for example, is dated 2021-01-01) — earlier amendment history
  exists on Fedlex only as PDF/HTML and is invisible to this benchmark.
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
- **No cantonal law.** CH-PiT covers only federal acts (the corpus this
  pipeline builds from Fedlex's federal SR collection); cantonal statutes
  are out of scope entirely.

## How to reproduce

From `services/ch-pipeline`:

```
python -m chpipe.bench.build --langs de,fr,it --out /data/ch-corpus/bench
python -m chpipe.bench.run_oracle --items /data/ch-corpus/bench --out /data/ch-corpus/bench
CHPIPE_BENCH_CONFIRM=1 python -m chpipe.bench.run_llm --items /data/ch-corpus/bench --out /data/ch-corpus/bench --sample-per-lang 300
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
