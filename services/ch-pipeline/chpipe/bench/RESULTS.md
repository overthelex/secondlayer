# CH-PiT: first results

Build date: 2026-08-25.

## Corpus

5,000 items per language (German, French, Italian), 15,000 items total.
Built from `ch_act_change` with the selection and sampling rules described
in `CARD.md` ("Construction"): modified articles only, on an in-force act,
with a resolvable abbreviation, an unambiguous article number, non-overlapping
editions, and at least one discriminating unit; capped at 50 changes per act
and 5,000 items per language, seeded `20260825`.

Skip counts from the build (`build-report.json`):

| language | changes considered | selected | items | ambiguous_article | no_abbreviation | identical_or_short | no_discriminating_unit | overlapping_editions | capped |
|---|---|---|---|---|---|---|---|---|---|
| de | 15,673 | 10,197 | 5,000 | 367 | 4,022 | 1,087 | 273 | 10 | 7,556 |
| fr | 20,090 | 11,860 | 5,000 | 839 | 6,316 | 1,075 | 262 | 6 | 9,226 |
| it | 15,731 | 11,219 | 5,000 | 292 | 3,083 | 1,137 | 292 | 12 | 8,567 |

The largest skip reason in every language is `no_abbreviation` for German,
and `capped` for all three once the per-language item cap of 5,000 is
reached, the builder stops even though more eligible changes remain.

## as_of year distribution (all 15,000 items)

| year | count |
|---|---|
| 2011 | 127 |
| 2012 | 1 |
| 2013 | 1 |
| 2015 | 4 |
| 2016 | 7 |
| 2017 | 67 |
| 2018 | 74 |
| 2019 | 77 |
| 2020 | 90 |
| 2021 | 1,898 |
| 2022 | 2,812 |
| 2023 | 3,059 |
| 2024 | 2,914 |
| 2025 | 2,233 |
| 2026 | 1,416 |
| 2027 | 199 |
| 2028 | 11 |
| 2029 | 10 |

Note: the build ran on 2026-08-25, so `as_of` dates in 2027, 2028 and 2029
are not future guesses. They are editions Fedlex has already published with
a future in-force date (an amendment enacted now to take effect on a later
date). The benchmark asks about those editions as of the date they take
effect, which can be after the build date.

## Runner settings

- 300 items per language, stratified by `kind` (`before`/`after`)
- seed `20260825` (same seeding scheme as item selection, with a `:llm`
  suffix)
- temperature 0, max output tokens 2048
- models: `eu.anthropic.claude-haiku-4-5-20251001-v1:0` and
  `eu.anthropic.claude-sonnet-4-6`, region `eu-central-1`
- system prompt (verbatim, from `run_llm.py`):

  > You are a Swiss legal database. Answer with the verbatim text of the
  > requested article as in force on the given date, in the language of the
  > question, nothing else.

No retrieval: the model sees only the item's `question` field (act
abbreviation, article number, date), never the gold or distractor text.

## Results

One row per language / system / kind. `correct`, `wrong version` and
`ungrounded` are label shares over `n`. `correct (gold current)` and
`correct (gold superseded)` split the correct share by whether the gold
edition is still today's wording (`gold_is_current`); the superseded column
is the one that actually measures point-in-time grounding, since a
current-wording item can be answered correctly by memory alone. `score` is
the headline `grounded_correct` share.

### German (de)

| system | kind | n | errors | correct | wrong version | ungrounded | correct, gold current | correct, gold superseded | score |
|---|---|---|---|---|---|---|---|---|---|
| oracle | all | 5,000 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (521/521) | 100.0% (4,479/4,479) | 1.000 |
| oracle | after | 2,555 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (520/520) | 100.0% (2,035/2,035) | 1.000 |
| oracle | before | 2,445 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (1/1) | 100.0% (2,444/2,444) | 1.000 |
| haiku-4-5 | all | 300 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/30) | 0.0% (0/270) | 0.000 |
| haiku-4-5 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/30) | 0.0% (0/120) | 0.000 |
| haiku-4-5 | before | 150 | 0 | 0.0% | 0.0% | 100.0% | n/a (0/0) | 0.0% (0/150) | 0.000 |
| sonnet-4-6 | all | 300 | 0 | 0.3% | 0.3% | 99.3% | 0.0% (0/30) | 0.4% (1/270) | 0.003 |
| sonnet-4-6 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/30) | 0.0% (0/120) | 0.000 |
| sonnet-4-6 | before | 150 | 0 | 0.7% | 0.7% | 98.7% | n/a (0/0) | 0.7% (1/150) | 0.007 |

### French (fr)

| system | kind | n | errors | correct | wrong version | ungrounded | correct, gold current | correct, gold superseded | score |
|---|---|---|---|---|---|---|---|---|---|
| oracle | all | 5,000 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (549/549) | 100.0% (4,451/4,451) | 1.000 |
| oracle | after | 2,545 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (549/549) | 100.0% (1,996/1,996) | 1.000 |
| oracle | before | 2,455 | 0 | 100.0% | 0.0% | 0.0% | n/a (0/0) | 100.0% (2,455/2,455) | 1.000 |
| haiku-4-5 | all | 300 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/33) | 0.0% (0/267) | 0.000 |
| haiku-4-5 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/33) | 0.0% (0/117) | 0.000 |
| haiku-4-5 | before | 150 | 0 | 0.0% | 0.0% | 100.0% | n/a (0/0) | 0.0% (0/150) | 0.000 |
| sonnet-4-6 | all | 300 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/33) | 0.0% (0/267) | 0.000 |
| sonnet-4-6 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/33) | 0.0% (0/117) | 0.000 |
| sonnet-4-6 | before | 150 | 0 | 0.0% | 0.0% | 100.0% | n/a (0/0) | 0.0% (0/150) | 0.000 |

### Italian (it)

| system | kind | n | errors | correct | wrong version | ungrounded | correct, gold current | correct, gold superseded | score |
|---|---|---|---|---|---|---|---|---|---|
| oracle | all | 5,000 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (571/571) | 100.0% (4,429/4,429) | 1.000 |
| oracle | after | 2,548 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (568/568) | 100.0% (1,980/1,980) | 1.000 |
| oracle | before | 2,452 | 0 | 100.0% | 0.0% | 0.0% | 100.0% (3/3) | 100.0% (2,449/2,449) | 1.000 |
| haiku-4-5 | all | 300 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/40) | 0.0% (0/260) | 0.000 |
| haiku-4-5 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/40) | 0.0% (0/110) | 0.000 |
| haiku-4-5 | before | 150 | 0 | 0.0% | 0.0% | 100.0% | n/a (0/0) | 0.0% (0/150) | 0.000 |
| sonnet-4-6 | all | 300 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/40) | 0.0% (0/260) | 0.000 |
| sonnet-4-6 | after | 150 | 0 | 0.0% | 0.0% | 100.0% | 0.0% (0/40) | 0.0% (0/110) | 0.000 |
| sonnet-4-6 | before | 150 | 0 | 0.0% | 0.0% | 100.0% | n/a (0/0) | 0.0% (0/150) | 0.000 |

Oracle is 1.000 in all three languages, confirming the builder and the
scorer agree with each other. Haiku 4.5 is 0.000 everywhere. Sonnet 4.6 is
0.003 in German (1 item scored `grounded_correct`, 1 scored
`grounded_wrong_version`, both in the `before` split) and 0.000 in French
and Italian.

## Subset check: items with as_of on or before 2024

To rule out the future-dated 2027 to 2029 items (which no model could
possibly answer, since they postdate the model's training and describe
editions that take effect after the question is theoretically askable)
skewing the headline number, the same 300-item-per-language LLM sample was
filtered to `as_of <= 2024-12-31` and re-scored. This leaves 658 items per
model (summed across the three languages). The result does not change:
Haiku 4.5 scores 0 correct, Sonnet 4.6 scores 1 correct (the same German
`before` item noted above). Restricting to older, unambiguously-in-the-past
dates does not move the number.

## Spend

Actual Bedrock spend for the full LLM run (both models, 900 items each,
all three languages): **USD 4.18** (`actual_total_usd` in
`llm-run-report.json`; Haiku 4.5 cost USD 0.91, Sonnet 4.6 cost USD 3.27).
The pre-run estimate was USD 6.36; actual spend came in lower, mostly
because actual output token counts were lower than the estimate assumed.

## Qualitative reading

Reading a sample of the raw model answers by hand turned up two recurring
failure modes, neither of which is "the model didn't know the law":

1. **Refusal citing an unknown future date.** For items whose `as_of` is
   after the model's knowledge cutoff, the model sometimes declines to
   answer at all, saying it cannot verify a law's text as of a date it
   has no information about. This showed up in roughly 7% of Sonnet 4.6's
   answers. This is a reasonable thing for a model to do, but it still
   scores `ungrounded` under this benchmark, since ungrounded means no
   verbatim match to either edition, not "declined to answer."
2. **Confident recitation of a different provision's text.** The model
   answers fluently and with the right kind of legal language, but quotes
   the wrong article entirely. For example, asked for Art. 44 VZV (the
   Swiss ordinance on admission to road traffic), one answer confidently
   recited the rules on the probationary driving licence
   ("Führerausweis auf Probe"), when Art. 44 actually concerns foreign
   driving licences. The model is not reciting an old or new edition of
   the right article; it is reciting a different article that it
   associates with the same general subject area.

## Interpretation

Without point-in-time retrieval, a general-purpose LLM's verbatim recall of
the specific edition of a Swiss federal article in force on a given date is
effectively zero, both models score at or near 0.000 across all three
languages, while an oracle that simply looks the edition up in the database
scores 1.000 on the same items with the same scorer. That gap is not a
statement about how good or bad these models are at law in general; it is
the expected result of asking for verbatim, dated text with no source
document in context. What CH-PiT actually measures, given these baselines,
is not model quality but whether a system has a retrieval layer that finds
the correct dated edition at all. A product that wires up point-in-time
retrieval should be expected to move this number close to the oracle's
1.000; a product that does not will look like these two baselines,
regardless of which model sits behind it.
