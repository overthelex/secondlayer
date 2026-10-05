# Polish corpus

Court decisions and legislation-with-history for Poland, into `secondlayer_prod`.

Everything except the database write runs on **local.lex** (16 cores, 123 GB RAM,
PyMuPDF/tesseract/pdftotext present). Prod is not used for fetching or parsing:
it keeps the harvest off the prod EIP pool, and traffic goes local → AWS, which
is ingress rather than paid egress.

```
PL_SSH_HOST=prod      # "" when running on the prod host itself
PG_CONTAINER=secondlayer-postgres-prod
PG_USER=secondlayer
PG_DB=secondlayer_prod
```

## State

| stage | script | status |
|---|---|---|
| 0 pin baseline | `pin_baseline.py` | **done** - runs in 89 s, 0 problems |
| 1 register + graph | `harvest_eli_register.py` | **done** - 164,213 acts, 732,983 edges, 0 failures |
| 2 snapshot chain | `build_pl_snapshots.sql` | **done** - 164,206 snapshots, 154,843 laws, 4,223 with >1 |
| 3+4 struct + text | `harvest_eli_texts.py` | **done** - 673,735 articles, 5.5M units, 7 unresolved of 39,106 |
| 5 incremental sync | `sync_eli_changes.py` | not written |
| 6 audit | `audit_pl_load.sh` | not written |
| courts | `harvest_ncourt.py`, `harvest_cbosa.py`, `harvest_sn_tk.py` | not written |
| legacy repair | `repair_legacy.py` | not written |

Parser: `pl_article_parser.py`, tests `test_pl_article_parser.py` (all passing).
Schema: `mcp_backend/src/migrations/190_pl_legislation.sql`, `191_pl_law_texts.sql`
(applied to prod 2026-08-14; 184/185 were already taken, hence 190/191),
plus `192_pl_indexes_concurrently.sql` **which the migration runner must not run**
(it wraps each file in one transaction and `CREATE INDEX CONCURRENTLY` cannot run
in one - same reason as `scripts/nl/179b_*`).

## Run

```bash
python3 scripts/pl/pin_baseline.py --out /data/pl_eli/baseline
python3 scripts/pl/harvest_eli_register.py --listings
python3 scripts/pl/harvest_eli_register.py --details --limit 500   # smoke first
python3 scripts/pl/harvest_eli_register.py --details
psql -f scripts/pl/build_pl_snapshots.sql
FIXTURES=/data/pl_eli/fixtures python3 scripts/pl/test_pl_article_parser.py --fetch
```

`WORKERS=4 RATE_MS=250` is ~6 req/s. The source sustained 11.5 req/s on details
and 4.1 req/s on `text.html` across ~700 probe requests with no 429, so this is
margin, not a limit it imposed. Details pass ≈ 7-8 h, text pass ≈ 3-4 h.

## What the source actually does

Measured 2026-08-14, not taken from documentation.

**There is no point-in-time service.** Only two kinds of text exist: the one
published on promulgation, and one per *obwieszczenie w sprawie ogłoszenia
jednolitego tekstu*. The consolidated text is served under the **obwieszczenie's**
ELI, not the base act's - `DU/1974/141/text.html` is the 1974 Kodeks pracy
(8 hits for `socjalistyczn`), `DU/2020/1320/text.html` is the 2020 consolidation
(0 hits). Hence snapshots + amendment graph, and no interpolation.

**`legalStatusDate`** ("stan prawny na dzień") is on consolidating obwieszczenia
and is what makes the temporal answer computable. Absent on the oldest ones
(KP's `DU/1998/94`), hence `exact_on_src`.

**`valid_to` is derived, not taken.** The source's `expirationDate` is when the
*obwieszczenie* was superseded, so consecutive texts overlap: three of the ten KP
consolidations overlap the next by 28-55 days. `source_expiration` is stored
beside the derived value so the disagreement stays visible.

**Coverage.** DU 97,681 acts (105 year listings, sum matches the declared
`actsCount`), 39,110 with HTML. By era: 1918-1989 11.3 %, 1990-1999 15.7 %,
2000-2011 16.9 %, 2012-2023 99.7 %, 2024 100 %, **2025-2026 0 %**. That recent
zero is a publication lag, so the incremental sync must re-poll acts recorded as
HTML-less instead of trusting `text_html` once.

**Monitor Polski has no HTML at all** - 0 of 66,532 across all 92 years. MP is a
register-and-graph corpus; no text pipeline is built for it.

**`/references` is redundant.** The act detail inlines the same edges,
byte-identical on DU/1964/93 across all five categories (223 / 113 / 11 / 25 / 1).
Not calling it saves 164,213 requests.

**Konstytucja RP `DU/1997/483` has no machine-readable text** - `textHTML:false`,
`/struct` 404, `text.html` 200-with-zero-bytes, 13.2 MB PDF only. It is carried
as a negative landmark (verdict `903`) rather than an assertion that cannot hold.
Any pipeline assuming "act ⇒ HTML" loses the most recognisable act in the corpus
without noticing.

## Traps

- **Charset.** Documents declare it twice in one attribute
  (`text/html; charset=UTF-8; charset=UTF-8`) and lxml falls back to latin-1.
  Struct ids contain Polish letters (`bran_piąty-chpt_I-arti_114`), so a
  mis-decoded id stops matching struct and the article is silently dropped -
  134 of 305 lost on Kodeks pracy while every anchor count still looked right.
  Always parse with an explicit `HTMLParser(encoding="utf-8")`.
- **Footnotes.** Rendered inline as
  `<a class="gloss-link"><sup>3)</sup><span class="tooltip-text">…prose…</span></a>`.
  Left in, they put 21,332 characters of editorial note into the provisions of
  DU/2020/1320 (1.6 % of the body), and the marker sitting after an article
  number turns `Art. 47` into `Art. 47^6`.
- **Numbering has three levels plus a range form:** `arti_415` → `415`,
  `arti_304_4` → `304^4`, `arti_18_3_a` → `18^3a` (24 of 494 articles in the KP
  consolidation), `arti_266-280` → `266-280` (a repealed span as one unit, with
  an empty body - which is a fact, not a missing value).
- **Struct ids repeat** (DU/1964/93 has 2,290 nodes / 2,289 distinct), so the
  article PK ends in `ord` and DOM lookup consumes the k-th occurrence.
  Struct ids are also **not stable across snapshots** (`book_trzecia` →
  `book_TRZECIA`), so cross-snapshot identity keys on `art_no`, never the path.
- **Do not use `prod_writer.copy_into` for text.** Its `_escape_copy` maps
  newline to a space; `plprod.esc` emits a literal `\n` that COPY decodes back.
- **`pl_court_decisions` already holds 2,864,093 rows / 105 GB** from three
  snapshot sources. It is stale (hf-pl-nsa stops 2025-02-26), its ids are built
  from parquet row positions so a re-import duplicates rather than updates, and
  it loaded with `ON CONFLICT DO NOTHING` so bad text cannot be repaired. A
  full-table aggregate on it times out at 300 s - shard audits by source/year.

## Validation rules for article extraction

- **V1 exact struct coverage.** `extracted == struct declares, in scope`. Not a
  ratio. DU/2020/1320 has 497 `unit_arti` anchors for a 494-article code; the
  three extras are articles quoted inside the obwieszczenie's own passages, and
  no threshold would catch that.
- **V2 label agreement** between the DOM heading and the struct symbol. Catches
  mis-pairing of repeated ids.
- **V3 monotonicity, reported not enforced.** It earns its place: DU/1964/93
  labels the article at position 536 `Art. 538.` in **both** struct and the DOM
  while its text is the real 536. V2 structurally cannot see that - both sides
  agree and are both wrong. A non-zero `nonmonotonic` is a finding to surface,
  not a number expected to be zero.
- **V4 substance**: ≥95 % of articles ≥10 chars.
