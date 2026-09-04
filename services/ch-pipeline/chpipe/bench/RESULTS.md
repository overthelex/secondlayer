# CH-PiT: results

## v2026.09 (v3) -- build 2026-09-04 10:22 UTC

What changed against v2: the selection now requires a **federal act**
(`ch_act.jurisdiction = 'CH'`; the tables gained the 26 cantons' law on
2026-08-26) and **Fedlex XML on both sides of the change**
(`ch_act_version.source = 'fedlex'`; the pdf-a consolidations backfilled
for 1995-2020 stay out, see CARD.md "Known limits" and LEXAI-2046). Every
item carries `build = "v2026.09"`, `core: true/false`, and the source of
each edition in `gold.source` / `distractor.source`. Same seed (20260825),
same caps (50 changes per act, 5,000 items per language).

### Corpus

| language | changes considered | selected | items | ambiguous_article | no_article_number | no_abbreviation | identical_or_short | no_discriminating_unit | overlapping_editions | capped |
|---|---|---|---|---|---|---|---|---|---|---|
| de | 15,401 | 10,047 | 5,000 | 336 | 68 | 3,923 | 1,027 | 273 | 8 | 7,407 |
| fr | 20,193 | 10,202 | 5,000 | 830 | 225 | 7,938 | 998 | 245 | 2 | 7,579 |
| it | 15,850 | 9,885 | 5,000 | 292 | 38 | 4,612 | 1,023 | 297 | 14 | 7,230 |

`gold_is_current` is true on 1,657 of the 15,000 items (de 566, fr 529,
it 562) -- the v2 card's "roughly half" was wrong for the XML era, where
only the newest edition of an act is open-ended.

`as_of` year distribution (all 15,000): 2011: 88, 2012-2018: 12,
2019: 43, 2020: 70, 2021: 1,895, 2022: 2,967, 2023: 3,214, 2024: 2,727,
2025: 2,186, 2026: 1,495, 2027: 248, 2028: 28, 2029: 23, 2032-2033: 4.
Dates after the build date are editions Fedlex has already published with
a future in-force date.

### The `core` subset (500 per language)

Selected by `chpipe/bench/core_split.py` (see CARD.md, "The `core`
subset"): an equal share per `as_of` year, round-robin over the
(`kind`, `gold_is_current`) cells inside each year, shortfalls filled
across years.

| language | after / superseded | after / current | before / superseded | before / current |
|---|---|---|---|---|
| de | 154 | 167 | 178 | 1 |
| fr | 141 | 145 | 214 | 0 |
| it | 143 | 155 | 200 | 2 |

Per year (de): 2021-2027 63-65 each, 2020: 22, 2019: 9, 2028: 8, 2029: 7,
2012/2013/2017/2018/2032/2033: 1-2 each. French and Italian additionally
carry 2011 (49 / 39 items, early XML editions that exist only in those
languages). A `before` item's gold is the superseded edition by
construction, so the current/superseded balance lives in the `after` half.

### Oracle

`run_oracle.py` over all 15,000 items: **answered 15,000, errors 0,
`grounded_correct` 1.000 in German, French and Italian** (mean gold
coverage 1.000, mean distractor coverage 0.000), on `gold_is_current`
true and false alike. Builder and scorer agree on the v3 item set.

### Model baselines

Run on `core` via OpenRouter; tables follow once the runs are in. The v2
Bedrock numbers below were measured on the v2 item set (same seed, but the
federal/XML filters change which changes are eligible, so v2 and v3 item
ids overlap only partially) and are kept as history, not as v3 rows.

---

## v2 (2026-08-25) -- kept for history

Build 2026-08-25 23:24 UTC, commit `28618f7d`. Item ids include the source
act's `act_id`; only parsed editions are used; the `no_article_number` skip
reason is applied. This is the v2 build. A first run on the previous build
(v1, item ids without `act_id`, 2026-08-25 19:56 UTC) gave identical
headline numbers; see "Spend" below.

## Corpus

5,000 items per language (German, French, Italian), 15,000 items total.
Built from `ch_act_change` with the selection and sampling rules described
in `CARD.md` ("Construction"): modified articles only, on an in-force act,
from a parsed edition, with a resolvable abbreviation, an unambiguous
article number, non-overlapping editions, and at least one discriminating
unit; capped at 50 changes per act and 5,000 items per language, seeded
`20260825`.

Skip counts from the build (`build-report.json`):

| language | changes considered | selected | items | ambiguous_article | no_article_number | no_abbreviation | identical_or_short | no_discriminating_unit | overlapping_editions | capped |
|---|---|---|---|---|---|---|---|---|---|---|
| de | 15,673 | 10,197 | 5,000 | 362 | 68 | 3,959 | 1,087 | 273 | 10 | 7,556 |
| fr | 20,090 | 10,139 | 5,000 | 830 | 225 | 7,906 | 990 | 302 | 16 | 7,480 |
| it | 15,731 | 9,812 | 5,000 | 292 | 38 | 4,577 | 1,012 | 307 | 10 | 7,154 |

The largest skip count in every language is still `capped` (de 7,556, fr
7,480, it 7,154): once the per-language item cap of 5,000 is reached the
builder stops, even though more eligible changes remain. The largest
non-cap reason is `no_abbreviation` in every language too (de 3,959, fr
7,906, it 4,577) -- an act this benchmark's question templates cannot name.

`changes_considered` is essentially unchanged from the v1 build (de 15,673,
fr 20,090, it 15,731 in both). `selected` moves in fr and it (11,860 to
10,139 in fr; 11,219 to 9,812 in it) because this build adds the
`no_article_number` skip and restricts to parsed editions only; de's
`selected` count happens to be unchanged (10,197 in both builds).

## as_of year distribution (all 15,000 items)

| year | count |
|---|---|
| 2011 | 119 |
| 2012 | 2 |
| 2013 | 2 |
| 2015 | 6 |
| 2017 | 2 |
| 2019 | 56 |
| 2020 | 82 |
| 2021 | 2,042 |
| 2022 | 2,936 |
| 2023 | 3,266 |
| 2024 | 2,680 |
| 2025 | 2,230 |
| 2026 | 1,362 |
| 2027 | 191 |
| 2028 | 13 |
| 2029 | 11 |

Note: the build ran on 2026-08-25 23:24 UTC, so `as_of` dates in 2027, 2028
and 2029 are not future guesses. They are editions Fedlex has already
published with a future in-force date (an amendment enacted now to take
effect on a later date). The benchmark asks about those editions as of the
date they take effect, which can be after the build date.

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

Full results, one row per language / system / kind (`all` sums `after` and
`before`), including the mean gold-text coverage and mean distractor-text
coverage of each answer:

| lang | system | kind | n | errors | correct % | wrong version % | ungrounded % | correct % (gold current) | correct % (gold superseded) | mean gold cov | mean distractor cov | score |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| de | haiku-4-5 | all | 300 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| de | haiku-4-5 | after | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| de | haiku-4-5 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| de | oracle | all | 5000 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| de | oracle | after | 2555 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| de | oracle | before | 2445 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| de | sonnet-4-6 | all | 300 | 0 | 0.3 | 0.0 | 99.7 | 0.0 | 0.4 | 0.003 | 0.000 | 0.003 |
| de | sonnet-4-6 | after | 150 | 0 | 0.7 | 0.0 | 99.3 | 0.0 | 0.8 | 0.007 | 0.000 | 0.007 |
| de | sonnet-4-6 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| fr | haiku-4-5 | all | 300 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| fr | haiku-4-5 | after | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| fr | haiku-4-5 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| fr | oracle | all | 5000 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| fr | oracle | after | 2547 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| fr | oracle | before | 2453 | 0 | 100.0 | 0.0 | 0.0 | 0.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| fr | sonnet-4-6 | all | 300 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.001 | 0.000 | 0.000 |
| fr | sonnet-4-6 | after | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.001 | 0.000 | 0.000 |
| fr | sonnet-4-6 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| it | haiku-4-5 | all | 300 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| it | haiku-4-5 | after | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| it | haiku-4-5 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| it | oracle | all | 5000 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| it | oracle | after | 2544 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| it | oracle | before | 2456 | 0 | 100.0 | 0.0 | 0.0 | 100.0 | 100.0 | 1.000 | 0.000 | 1.000 |
| it | sonnet-4-6 | all | 300 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.001 | 0.000 | 0.000 |
| it | sonnet-4-6 | after | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.000 |
| it | sonnet-4-6 | before | 150 | 0 | 0.0 | 0.0 | 100.0 | 0.0 | 0.0 | 0.002 | 0.000 | 0.000 |

Oracle: 15,000 answered, 0 errors, score 1.000 in German, French and
Italian -- the builder and the scorer agree with each other. Haiku 4.5 is
0.000 everywhere. Sonnet 4.6 is 0.003 in German (0.007 on `after` items,
0.000 on `before`), and 0.000 in French and Italian.

## Spend

Actual Bedrock spend for this run (both models, 900 items each, all three
languages, 1,800 answers total): **USD 4.28** (`actual_total_usd` in
`llm-run-report.json`).

A first run on the previous build (v1, item ids without `act_id`,
2026-08-25 19:56 UTC) gave identical headline numbers -- oracle 1.000 in
de/fr/it, Haiku 4.5 0.000 everywhere, Sonnet 4.6 0.003 in German -- for USD
4.18. The v1 build and run files are archived on the prod host under
`/data/ch-corpus/bench-v1`.

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
