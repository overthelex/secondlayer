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
| 5 incremental sync | `sync_eli_changes.py` | daily cron on cthulhu 04:30 |
| 5b PDF articles | `segment_eli_pdf.py` (parser `pl_pdf_segmenter.py`) | **done** 2026-11-15 - 903 of 3,395 PDF-only snapshots split, 80,369 articles; 2,490 have no `Art.` (rozporządzenia), 2 rejected |
| 5c PDF article vectors | `vectorize_pdf_articles.py` | 2026-11-15: 117,513 chunks of those articles into `pl_corpus_bge_cls` on CPU TEI (~5 chunks/s); each edition's whole-text `pl_act_text` points are dropped once its articles are in. One-off; later splits are picked up by 5d |
| 5d incremental vectors | `vectorize_incremental.py` + `run_vectorize_incremental.sh` | daily cron 08:30 (LEXAI-2253). Chunking/ids/payloads from `pl_chunk_export.py` (the bulk exporter of 10.11, now in the repo). Diff against Qdrant: only new or changed chunk texts are embedded |
| 5e decision citations | `build_decision_citations.py` (tests `test_build_decision_citations.py`) | **done** 2026-11-16 - 10.2M citations, 2.02M of 2.46M decisions (82 %) cite something, 99.99 % of cited ELIs are in `pl_acts`, 96.6 % of article citations resolve to an article; tool `pl_find_decisions_by_article` |
| 6 audit | `audit_pl_load.sh` | not written |
| courts: ncourt | `harvest_ncourt.py` | daily cron 07:15 |
| courts: SAOS | `harvest_saos.py --since-days 3` | daily cron 03:15; backfill done 08.11 (52,110 new) |
| courts: KIO | `harvest_kio.py` (re-lists last 120 days) | daily cron 03:30; backfill done 09.11 (16,610) |
| courts: TK | `harvest_tk.py` (OTK ZU, via SOCKS) | daily cron 04:00; backfill done 09.11 (4,299) |
| courts: NSA | `harvest_cbosa.py` | **manual only, never in cron**: NSA blocks scraping (policy) |
| registers | `load_pl_files.py` | weekly Sun 03:00 (mswia_sankcje, komornicy, kprm_wykaz, rzecznicy_patentowi), monthly 1st 02:30 (sady_*), quarterly (teryt_*); unchanged files are skipped by sha256 |
| matview | `pl_decision_meta` (migration 273) | Sundays 07:50 `REFRESH ... CONCURRENTLY` after the court harvesters (waits for the ncourt lock); no-op until the view exists |
| legacy repair | `repair_legacy.py` | not written |

Parser: `pl_article_parser.py`, tests `test_pl_article_parser.py` (all passing).
PDF parser: `pl_pdf_segmenter.py`, tests `test_pl_pdf_segmenter.py` (no PDF needed). It reads
article numbers from PyMuPDF span flags (bold heading + bracketed superscript), drops footnotes
by size but appends the ones an article cites (they say which of two printed versions is in
force), and checks the result against the previous HTML edition; verdict in
`pl_snapshot_texts.pdf_split` (migration 270).
Schema: `mcp_backend/src/migrations/190_pl_legislation.sql`, `191_pl_law_texts.sql`
(applied to prod 2026-08-14; 184/185 were already taken, hence 190/191),
plus `192_pl_indexes_concurrently.sql` **which the migration runner must not run**
(it wraps each file in one transaction and `CREATE INDEX CONCURRENTLY` cannot run
in one - same reason as `scripts/nl/179b_*`).

## Cron (cthulhu)

The whole PL schedule is `crontab.pl.fragment` (server time EET, absolute paths,
runs from the checkout `/home/vovkes/SecondLayer-pl` on main - `git pull` there
after a merge). Install: back up (`crontab -l > ~/lawrider/crontab.bak-$(date
+%Y%m%d-%H%M%S)`) and append only the lines that are not in `crontab -l` yet.
The psycopg2 harvesters (SAOS, KIO, TK) take `PG*` from `~/lawrider/pl-env.sh`
(127.0.0.1:5448); the plprod ones take `PL_SSH_HOST= PG_CONTAINER=pg-lawrider`.
Python is `/usr/bin/python3` with requests/openpyxl in the *user* site-packages,
so never `python3 -I`.

Order: SAOS 03:15, KIO 03:30, TK 04:00, ELI 04:30, KRS 05:15, Sejm 05:45,
SLPS 06:15, BZP 06:45, ncourt 07:15, pl_decision_meta Sun 07:50, vectors 08:30.

## Incremental vectors

`run_vectorize_incremental.sh`: export on the host (rows changed since the
cursors in `~/lawrider/pl-vectors/incremental/state.json`) -> `batch.ndjson`,
then a throwaway `python:3.12-slim` container on the `lawrider` network
(`pl-vec-incr`, requests from `~/lawrider/pl-vectors/pydeps`) diffs it against
Qdrant and embeds on `tei-bge-m3-lawrider`. Streams and their cursors:
decisions `greatest(imported_at, updated_at)`, editions
`pl_snapshot_texts.fetched_at` plus new PDF splits (a set: `segment_eli_pdf.py`
does not touch `fetched_at`), BZP `fetched_at` plus the update notices of the
same procedures (CPV filled later), Sejm `fetched_at`, open-data source reloads.
The first cursor is the bulk export start (2026-11-10 17:58 UTC).

- Every expected point is looked up by id first; unchanged text = no embedding,
  changed payload only = payload overwrite. Re-running a batch costs lookups.
- An edition is replaced as a unit (its other points deleted, `must_not has_id`);
  an edition with no text yet is never emptied. PDF-split editions get articles
  only (their whole-text points go), HTML editions keep articles + whole text,
  as in the bulk export.
- `is_current` is set per act by filter after its editions: latest snapshot true,
  the rest false (bulk rule: the latest snapshot is current even with no text).
- Caps: `--max-chunks 40000` per export (cursor stays at the last unit taken),
  `--max-seconds 7200` per load (the rest of the batch runs next day; no new
  export while a batch is pending).
- While `pl-pdf-vec` runs, legislation is skipped (both would rewrite
  `pl_act_text` points of the same editions).

Volume (measured 10-15.11): ~70 ncourt + ~45 SAOS decisions a day at ~19 chunks
each, ~2,500 BZP notices (one short chunk), Sejm refetches 3-30K objects
(titles, almost all unchanged). On the live CPU TEI next to other load:
~1.2 decision chunks/s (CPU-bound, the same with 1 x 4 or 2 x 8 texts in flight), so a normal day is 40-60 min.

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
- **Court names and case numbers are often not in their columns.** hf-pl-nsa and
  hf-pl-court-raw keep the case number in `metadata_json->>'docket_number'`;
  426K SAOS common-court rows and every ncourt row have no `court_name`, only the
  8-digit court code that opens the feed id. `pl_court_codes` (migration 271)
  maps the code to the name read off the rows that do have both, and the tools
  resolve both at read time (`courtNameSql`, `caseNumberSql` in
  `pl-legal-tools.ts`). Do not backfill the columns with an UPDATE: it is not a
  HOT update and re-inserts every row into the full-text GIN index.
- **Sejm `fetched_at` moves on every refetch** (27K objects on 15.11), so the
  Sejm stream is mostly lookups; do not count its rows as daily new data.
- **`/data/pl_kio` does not exist on cthulhu**: KIO keeps PDFs under
  `~/lawrider/kio/raw` (the default now).
- **TK needs the SOCKS tunnel**: if tmux `socks` is down the TK cron logs curl
  retries and gives up; restart with `tmux new -d -s socks ~/lawrider/socks-mail2.sh`.
- **NSA/WSA metadata lives only in `metadata_json`.** hf-pl-nsa (1.9M rows) has
  empty `judges`/`keywords`/`legal_bases` columns; the bench, organ
  (`challenged_authority`), NSA symbols (`case_type_description`, an array:
  `"6110 Podatek od towarów i usług"`, padded with no-break spaces), finality and
  related cases are JSON keys, read at query time for a decision (`judgesSql`,
  `authoritySql`, ... in `pl-legal-tools.ts`). Do not filter on them in
  `pl_court_decisions` itself: `metadata_json` of an NSA row is ~8 KB compressed
  and sits in TOAST (44 GB of the table), so even with trigram expression
  indexes every candidate is detoasted on recheck - "odsetki" + organ took 37 s.
  The search filters go through the narrow materialized view `pl_decision_meta`
  (migration 273). It is a snapshot: after an import of hf-pl-nsa,
  hf-pl-court-raw, SAOS or ncourt rows run
  `REFRESH MATERIALIZED VIEW CONCURRENTLY pl_decision_meta` (the first build took 16 min; a concurrent refresh is longer, one full
  scan), and refresh it after a schema-only restore, which leaves it empty.
- **BZP update notices carry no CPV and no order type.** `harvest_bzp.py`
  copies both from another notice of the same `tender_id` after each run
  (`fill_updates`, last 120 days); the 2021-2026 backfill filled 304,005 of
  304,631.

- **Decision citations cite the edition, not the act.** NSA's legal bases point at the
  consolidated text in force at the time (PPSA is cited as DU/2012/270, DU/2017/1369,
  DU/2018/1302 ... while the act is DU/2002/1270). `pl_decision_citations.act_eli` folds them
  onto the base act through `pl_acts.consolidates_eli`; `cited_eli` keeps the edition. A query
  keyed on the cited ELI finds one edition's slice of the case law and looks complete.
  SAOS writes superscripts as `393(19)` or run together as `3935` (= 393^5); the run-together
  form is only resolved when the plain number is not an article of the act and exactly one
  split is. SAOS (`journalEntry: 0`) and ISAP (`WDU19740010000`, journal `poz. 0`) write position 0 for acts they could not place; those are skipped.
  One regex with an alternation of overlapping whitespace classes under `+` before `$` hung
  the first full run on a long run of spaces: whitespace is collapsed before parsing.

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

## Decision citations

`build_decision_citations.py` -> `pl_decision_citations` (migration 272): one row per decision,
cited edition and article, from the legal bases the sources carry (`hf-pl-nsa`,
`hf-pl-court-raw`: `metadata_json->'extracted_legal_bases'`; `saos`: `referenced_regulations`).
ncourt, cbosa, kio and otkzu have no structured legal bases and are not covered. Sharded by
source and month; a shard is replaced in one transaction and recorded in
`pl_decision_citation_shards`, so a killed run resumes by running it again (`--redo` rebuilds,
`--report` prints totals). The two lookup indexes were built with `CREATE INDEX CONCURRENTLY`
after the first load.

By source (2026-11-16): hf-pl-nsa 79.8 % of decisions with a citation (97.8 % of article
citations resolved), saos 90.3 % (95.8 %), hf-pl-court-raw 88.8 % (96.1 %; its keys are
`isap_id` / `art` / `address`). 3.2M rows cite a consolidated text and are folded onto the
base act. The unresolved articles are mostly real ones our editions do not carry: KPC 393^12,
385^1 etc. were repealed in 2005, before the oldest segmented consolidation (2014).
A full rebuild takes about 35 minutes.

Daily cron line (not installed):

```
30 7 * * * cd /home/vovkes/SecondLayer-pl/scripts/pl && PL_SSH_HOST= PG_CONTAINER=pg-lawrider flock -n /tmp/pl-citations.lock nice -n 10 /usr/bin/python3 build_decision_citations.py --since $(date -d '-60 days' +\%F) >> /home/vovkes/lawrider/pl-citations.log 2>&1
```
