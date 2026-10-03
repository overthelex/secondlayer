
# Swiss Vertical-Restraints Notice Audit, 2002–2022

The data behind *Announced, Then Practised: The Swiss Vertical-Restraints
Notice Against Its Own Record, 2002–2022* (Ovcharov, 2026, draft). The paper
audits every version of the Swiss Competition Commission's (WEKO) notice on
vertical agreements, the *Vertikalbekanntmachung*, and its explanatory notes
against the Swiss decisional record, after Schrepel and Jenny's computational
audit of the European Commission's draft merger guidelines. It asks two
questions of each proposition: did it **codify** a practice that existed when
it was first written, or **announce** one that came later; and is its wording
**imported** from the EU's vertical texts or WEKO's own?

Every number in the paper is generated from these files
(`raw/figures.json`); nothing here was edited by hand. The companion audit of
Ukraine's dominance methodology is
[`overthelex/ua-metodyka-audit`](https://huggingface.co/datasets/overthelex/ua-metodyka-audit).

## The instrument

| key | text |
|---|---|
| `2002-02-18` | Vertikalbekanntmachung of 18 February 2002 (RPW 2002/2, S. 404) |
| `2007-07-02` | Vertikalbekanntmachung of 2 July 2007 (RPW 2007/4, S. 675) |
| `2010-06-28` | Vertikalbekanntmachung of 28 June 2010 |
| `2017-05-22` | the same, Stand of 22 May 2017 |
| `2019-04-09` | Erläuterungen of 12 June 2017, **Stand of 9 April 2018** |
| `2022-12-12` | Vertikalbekanntmachung of 12 December 2022 |
| `2022-12-12-erl` | Erläuterungen of 12 December 2022 |

The key `2019-04-09` is a misnomer from the first download and is kept
because every file is keyed by it; the text is the 2018 Stand. For the time
axis the Erläuterungen are dated by their first issue, 12 June 2017.

## Load

```python
from datasets import load_dataset

props = load_dataset("overthelex/ch-vertbek-audit", "propositions", split="train")
m1 = load_dataset("overthelex/ch-vertbek-audit", "measure1", split="train")
```

## Configs

### `propositions` — 328 rows

Each version cut into propositions: a numbered Ziffer or Artikel down to its
lettered points, a recital of the notice (pid `E<n>`), or a paragraph of the
Erläuterungen. German text, cleaned of page furniture and footnotes.

| field | |
|---|---|
| `version`, `version_name`, `pid` | key; `(version, pid)` is unique |
| `part` | `operative`, `preamble`, … |
| `heading`, `lead`, `text` | the heading, the opening of the sentence a lettered point completes, the proposition |
| `track` | id linking the same proposition across versions (see `measure1`) |
| `label` | final: `supported`, `fragment`, `recites`, `absent` |
| `label_source` | `judges` (238), `human_gold` (50), `human_disputed` (40) |
| `label_claude`, `label_gemini` | each model's label |
| `provenance`, `eu_containment` | `imported` / `mixed` / `own`, and the share of word 5-grams found in the EU text (null for the 8 propositions under eight words) |

### `evidence` — 2,624 rows

The eight passages each proposition was read against, in the order they were
shown. Passages are **keyed, not quoted**: `ecli` + `ord` identify the passage,
`passage_sha256` is the SHA-256 of its UTF-8 text, so a rebuild can be checked
passage by passage. Also: `docket`, `spider` (source), `tier` (`agency`,
`federal_court`, `cantonal`, `other_federal`), `date`, `date_upper_bound`,
`date_source`, `lang`, `recital_share` (how much of the passage only repeats
the proposition), `cites_this`.

### `judgements` — 7,856 rows

Every model answer, one row per passage. `run` is `full` (all 328 plus 8
controls), `gold` (the 50 gold propositions plus controls, three models),
`before` and `before-erl` (the second reading of measurement 1, against the
record before the text). `judge`/`model`, `proposition_label`,
`passage_label` (`applies`, `partial`, `contradicts`, `recites`, `unrelated`),
`why` (the model's one-line reason), `quote` (the words it relies on; up to
~1,100 characters), `system_sha256` (SHA-256 of the system prompt, which is
`raw/protocol_v2.md` sent verbatim).

Models: Claude Opus 5.5 (`claude-opus-5-5`), Gemini 3.1 Pro (preview, Vertex
AI), DeepSeek V4 Pro (Azure AI Foundry, gold run only).

### `reader` — 102 rows

Every human label, with the reason written at the time (German). `round`:
`gold-development` (17, the propositions protocol v2 was written from),
`gold-test` (33), `disputed` (40), `before` (11), `before-erl` (1). One reader.

### `measure1` — 165 rows

Codification or announcement, per proposition followed across versions.
`first_version`, `first_pid`, `first_date`, `class` (`codification`,
`announcement`, `ungrounded`), `decided_by` (`step1`, `judges`, `human`),
`lag_years` (for announcements: to the first supporting decision among those
read, an upper bound), `versions` and `support` (JSON).

### `provenance` — 320 rows

Each proposition of eight words or more aligned with the EU vertical texts in
force when its version was written (Regulation 2790/1999 + 2000 Guidelines;
330/2010 + 2010 Guidelines; 2022/720 + 2022 Guidelines). `containment` is the
share of its word 5-grams found verbatim there; `own` means at or below the
99th percentile of the same measure against the EU's 2011 Horizontal
Guidelines (0.012), `imported` means 0.5 or more. `eu_window` is the
best-matching stretch of EU text.

### `corpus` — 2,828 rows

The manifest of the record: every document the passages were drawn from.
WEKO's decisions (RPW journal and entscheidsuche) and every decision of any
other court or authority in a 1.22-million-decision Swiss corpus whose text
contains *Kartellgesetz* or *Wettbewerbsabrede*; the notices themselves (RPW
part D1) excluded. `ecli`, `spider`, `tier`, `docket`, `date_exact`,
`date_upper_bound`, `date_source` (`record`, `text`, `issue`, `same_as`),
`chars`, `text_md5`, `passages`. 2,527 distinct decisions by docket and date:
a judgment can sit in several sources and languages.

## Files

`data/` holds the configs as parquet. `raw/` holds the protocols (v1, which
failed its blind check, and v2, frozen 2 October 2026), the final labels, the
gold set, both measurements as JSON, `figures.json`, and `checksums.txt`.

## What is and is not redistributed

The notice texts are official texts of a federal authority and are not
protected by copyright (Art. 5 para. 1 URG). The decisions are not
redistributed: they are public at their sources (weko.admin.ch,
entscheidsuche.ch, the courts), and the dataset carries their keys and hashes.
Short quotations from decisions appear in the models' and the reader's
reasons. `eu_window` quotes EU legislation, © European Union, reused under
Commission Decision 2011/833/EU. The annotations, labels and measurements are
released under CC BY 4.0.

## Limits

One human reader. Selection by two German words: French and Italian decisions
that never use them are not in the record. "Ungrounded" means no support in
the passages read, not proof that no decision applies a proposition. RPW
issue 1998/1 is not machine-readable.

## Code

[`scripts/weko-vertbek/`](https://github.com/overthelex/secondlayer/tree/main/scripts/weko-vertbek)
in the `secondlayer` repository; `export_hf.py` builds this dataset.

## Citation

```bibtex
@misc{ovcharov2026vertbek,
  author = {Volodymyr Ovcharov},
  title  = {Announced, Then Practised: The Swiss Vertical-Restraints Notice Against Its Own Record, 2002--2022},
  year   = {2026},
  note   = {Draft}
}
```
