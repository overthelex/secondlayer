# UAE court-decision harvesters

Tools for building the `ae_court_decisions` corpus (DIFC, ADGM, Dubai Courts).

## Sources and what each needs

| Source | Format | Auth | Reachable from EU |
|---|---|---|---|
| DIFC Courts | HTML | none | yes |
| ADGM Courts | PDF | none | yes |
| Dubai Courts | HTML | none | **no — UAE IP required** |
| MOJ / Federal Supreme Court | JSON + PDF | none | yes |
| ADJD (Abu Dhabi) | HTML | **UAE Pass** | not obtainable |

DIFC, ADGM and the MOJ run anywhere. Dubai Courts geo-blocks non-UAE IPs, so its
requests go through a Lambda deployed in `me-central-1` (`lambda/uae_fetch.py`).

## Layout

```
harvest_difc.py        DIFC judgments for one year   -> JSONL
harvest_adgm.py        ADGM judgments (PDF)          -> JSONL
lambda/uae_fetch.py    UAE-resident proxy: fetch | walk | texts
index_chain.sh         chained index walk per litigation stage
texts_pipeline.sh      fan-out full-text fetch behind the index walk
fetch_batch.sh         one text batch through the Lambda (idempotent)
build_dubai_jsonl.py   join index metadata + texts   -> JSONL
moj/                   Federal Supreme Court (see below)
sql/01_create_table.sql
sql/02_load_difc_adgm.sql
sql/03_load_dubai.sql
sql/06_load_moj_fsc.sql
```

## Usage

```bash
# one-off, run anywhere
python3 harvest_difc.py 2026 difc_2026.jsonl
python3 harvest_adgm.py all adgm_all.jsonl

# Dubai: needs the Lambda deployed in me-central-1 and an AWS profile for it
export UAE_BUCKET=<harvest bucket>      # required
export UAE_PROFILE=uae UAE_REGION=me-central-1
UAE_STAGES="5 3" ./index_chain.sh       # index walk, stage by stage (5=cassation, 3=appeal, 1=first instance)
./texts_pipeline.sh                     # full texts for the indexed rows
python3 build_dubai_jsonl.py <index_dir> <texts_dir> ae_dubai.jsonl
```

Load with `psql -f sql/0X_....sql` after copying the JSONL to `/tmp` inside the
Postgres container. Loads are idempotent (`ON CONFLICT DO UPDATE`).

## Things that will bite you

**Dubai Courts is OutSystems, not a normal site.** Pagination goes through
`OsAjax`, which submits the whole form with three hidden fields: `__EVENTTARGET`,
`__AJAXEVENT` and — the one that is easy to miss — **`__AJAX`**, a plain
comma-joined click context
(`docW,docH,originId,offTop,offLeft,scrollTop,scrollLeft,mouseX,mouseY,`). No
token, no signature. Without `__AJAX` the server silently keeps returning page 1.
The response is an `OsJSONUpdate({...})` payload: rows arrive JSON-escaped under
`"outers"→"inner"`, the next state under `"hidden":{"__OSVSTATE":...}`.
In the anchor `onclick`, quotes are escaped as `&#39;` — a regex expecting `'`
matches nothing and pagination looks broken.

**Only the litigation-stage filter works.** Case year, main type and subtype are
accepted and ignored (`total_pages` is identical for every value), so the corpus
cannot be partitioned by query and each stage must be walked sequentially. Results
are not date-ordered either: one page mixes 2010-2026.

**Pagination cost grows with depth.** Measured: ~3.5 s/page at page 500, ~4.8 s at
page 900, ~7 s at page 1500 — roughly `1.7 + 0.0034 × page` seconds. Total walk
time is therefore quadratic in page count. Cassation (1356 pages) takes ~2 h;
first instance (9553 pages) would take ~2 days.

**Go slow or the portal drops you.** At 0.15 s between pages the server started
returning `RemoteDisconnected` after 20-50 pages. At 0.8 s it runs for the full
Lambda budget without a single drop. `index_chain.sh` also sleeps 60 s between
chunks.

**Async Lambda invocations do not work here.** They are accepted with 202 and
never execute: zero `Invocations`, zero `Errors`, zero `AsyncEventsDropped`. It
cost two silent stalls (the index walk, then 3114 queued text batches that fetched
nothing). Everything uses synchronous invokes with `--cli-read-timeout 0`.

**Two failure modes that report success — check counts, not exit codes.**
`index_chain.sh` used to stop at its chunk cap and return 0, so an appeal walk that
was 385 pages short looked complete; it now returns 2 and logs `TRUNCATED`. And BSD
`xargs -I{}` with a long inline script dies with "command line cannot be assembled,
too long" while the surrounding pipeline happily logs that every batch was
launched — hence `fetch_batch.sh` as a separate file. Always compare the row count
you got against the count you expected.

**Resume is by saved session, not by re-walking.** Each chunk stores cookies +
`__OSVSTATE` + the next page target in S3, so the next invocation continues with
no fast-forward. Verify a deploy with `CodeSha256`, not `LastUpdateStatus` —
polling status returns the previous "Successful" and you end up testing stale code.

**Dates come in two languages.** The same portal serves `02 يناير 2011` and
`28 Jan 2014`; `build_dubai_jsonl.py` handles Arabic, Levantine and English month
names plus Arabic-Indic digits.

**The text extractor must anchor on `ut_verdict`, case-sensitively.** The judgment body
lives in `<div class="ut_verdict">`; `ut_VerdictWeb` is the small parties block and appears
*earlier* in the page, so a case-insensitive match silently returns ~150 characters instead
of the judgment. The original greedy `<div class="...content...">(.*)</div>` ran to the last
`</div>` on the page and swallowed the site nav and footer — **~3.7k identical characters per
document, 29% of the corpus**, which is harmless for a citation graph and ruinous for a
vector index. If you change this function, check the output length distribution, not just
that it returned something.

**Delete the invoke output file before every `lambda invoke`.** A failed invoke leaves the
previous response in place, and it reads exactly like a fresh one — this produced two
false "the fix doesn't work" diagnoses in a row.

## Federal legislation (uaelegislation.gov.ae)

```bash
# 1. enumerate + download: every act is a PDF at /ar/legislations/<id>/download
#    ids are contiguous 1000-4556; a missing id answers 200 with a ~650 KB HTML
#    shell, so validity is judged by the %PDF magic bytes, never by status code
#    (uae-fetch "grab" mode does this and puts each PDF in s3://$UAE_BUCKET/leg/)

# 2. OCR - the embedded text layer is unusable, see below
export TESSDATA_PREFIX=$PWD/tessdata OMP_THREAD_LIMIT=1
curl -sL -o tessdata/ara.traineddata \
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/ara.traineddata
./run_ocr.sh                       # 5 nice'd workers, 200 dpi

# 3. load
python3 build_leg.py legocr ae_legislation.jsonl
psql -f sql/04_create_legislation.sql && psql -f sql/05_load_legislation.sql
```

**The portal answers 403 to a plain request** and 200 once you send a full browser header
set (`Sec-Fetch-*`, `Accept-Language`, `Cache-Control`, `Upgrade-Insecure-Requests`). That
is bot protection, not a country block — it looked closed on first contact for this reason.
Listings and law text are injected by JS and the data endpoint is in neither the bundles nor
a sitemap, so the download route is the way in. `/print`, `/text` and `/articles` all return
the same not-found shell.

**Never trust this portal's PDF text layer.** Of 2 862 acts only 46 extract cleanly.
`pdftotext` emits `U+FFFD` where the font lacks a ToUnicode entry (`بعض` → `�عض`), and
PyMuPDF is worse: it loses nothing and maps the same glyphs to *wrong* codepoints
(`المخزون` → `اݝخزون`), so the text looks whole and is silently corrupt. NFKC over
presentation forms also reorders lam-alef (`الإمارات` → `اإلمارات`) in 1 668 of them.
`build_leg.py` records `glyph_loss`, `odd_script` and `extraction_ok` per row so a consumer
can always tell. OCR fixed all of it: 0 lost glyphs, 98.5% correct ligatures.

**`OMP_THREAD_LIMIT=1` when running tesseract in parallel.** It is OpenMP-multithreaded by
default, so 8 workers × 8 threads on an 8-core box means 64 threads: load average 32,
~13 s/page, 16 documents in 2.5 h. One thread per worker gives 1.3 s/page. On a shared
machine add `nice -n 19` and `ionice -c3` and leave cores for the app.

## Federal Supreme Court (moj.gov.ae)

```bash
cd moj
./fetch_index.sh index.json               # 4 469 records in one response
CONC=8 ./download_pdfs.sh index.json pdf  # resumable, %PDF-checked
python3 fetch_docx.py index.json txt      # the 3 records that are Word files
python3 extract_all.py pdf txt report.jsonl
./run_ocr.sh report.jsonl pdf txt         # only the documents the report flagged
python3 build_jsonl.py index.json txt report.jsonl ae_moj_fsc.jsonl
psql -f ../sql/06_load_moj_fsc.sql
```

**It was never geo-blocked — the endpoint just needed the right parameters.** The
listing widget posts to `services/AjaxHandler.asmx/LoadCategorizeAssetsList`; the
ASMX help page and `?WSDL` are disabled and any wrong parameter set answers a bare
500, which reads exactly like a block. The working body is
`{pageIndex, pageSize, languageId, languageCode, isArchived, thumbnailSizeFactor,
excludeItems}` from `fi.listing.js` merged with `{keyword, openDataTypeID,
categoryId, year, apiLink}` from `categorize-assets-listing.js` — note
`openDataTypeID`, capital `ID`, unlike every neighbouring key. `openDataTypeID`
450 is the Federal Supreme Court and **`pageSize: -1` returns all 4 469 records in
one 7 MB response**, so there is no pagination to walk. `isArchived: true` returns
the same set.

**Two PDF generations, two different kinds of damage.** Newer files store
logical-order Arabic but emit every lam-alef ligature reversed, as alef+lam:
`الأربعاء` arrives as `األربعاء` and `جلال` as `جالل`. Orthography cannot separate
that from the definite article `ال` — but geometry can, because **the decomposed
alef carries zero width** while a real article's alef does not. `moj_text.py`
drives the swap off the glyph boxes for that reason; a regex would eat every
article in the corpus. Older files (roughly 2011-2015) instead store presentation
forms plus kashidas the font maps to stray codepoints such as `ѧ`; NFKC and a
script filter fix those completely.

**Some documents carry the court's own bad OCR, and no decoder can save them.**
Letters are dropped and kashidas come through as doubled letters (`قاتل` →
`قاتاال`) — pdftotext and PyMuPDF agree, so it is the source. The rate of doubled
Arabic letters separates the populations cleanly, 5-11 per 1000 Arabic characters
for good documents against 20-170 for broken ones, so `extract_all.py` gates at 15
and `run_ocr.sh` re-OCRs whatever fails. Genuine gemination is written with shadda,
not by repeating the letter, which is why the measure works at all.

**The mime type in the index lies.** Three records are declared
`application/pdf` and link to `.docx`; go by the link extension.

## Amendment history (uaelegislation.gov.ae)

```bash
cd leg
python3 fetch_modifications.py ids.txt mods     # amendment pages, ~2.2 s/act
python3 fetch_law_meta.py need_meta.txt lawmeta # dates+status for acts never amended
python3 parse_modifications.py mods parsed
python3 parse_modifications.py lawmeta parsedmeta
python3 fetch_amendment_pdfs.py parsed/amendments.jsonl amendpdf
psql -f ../sql/07_create_amendments.sql && psql -f ../sql/08_load_amendments.sql
```

**Cloudflare here scores the TLS fingerprint, not the IP.** Plain `curl` with a
perfect browser header set gets 403 from a laptop, from prod and from the UAE
Lambda alike, which looks exactly like an IP ban and is not one; `curl_cffi` with
`impersonate` gets 200 from those same hosts. Profiles are scored individually
and inconsistently — `chrome` and `safari17_0` do not always agree, and the same
profile can pass then fail — so rotate profiles, warm a session on `/ar` first
and reuse it.

**The article-level history is not in the PDFs.** Only 2 of 2 862 downloaded
acts carry an inline "this text is per the latest amendment" note; the real
record is
`POST /ar/legislations/<id>/modifications/list` with `{_token, year}`, where the
token is scraped from the modifications page and must share that page's session.
It returns, per amending act, the new text of every article touched *beside the
text it replaced*. `/ar/materials/<id>/previous` gives the same per article.

**An act with no amendments has no modifications page and answers 500.** That is
the portal's way of saying "none", not a transient error — retrying it wastes the
whole budget. Publication metadata for those acts is on the act's own page
instead, which is why `fetch_law_meta.py` exists: without it, `status` and
`issue_date` would only ever describe the 8% of acts that were amended.

**Amendments are recorded even when the article bodies are not.** Repealed acts
in particular list the amending act, its date and its PDF with an empty body, so
count amendments and article changes separately — 427 amendments across 232 acts
produced 1 313 article changes across 166 acts.

## Judgment -> legislation citations

```bash
cd leg
./run_citations.sh citations.jsonl        # streams 3.9 GB out of Postgres, ~25 min
psql -f ../sql/10_load_citations.sql      # load + the two exact resolution passes
psql -f ../sql/11_resolve_citations.sql   # the relaxed passes, re-runnable
```

**Every gap in the citation pattern has to be optional.** Judgments name an act as
`<kind> رقم <n> لسنة <year>`, but the PDFs behind these texts glue words to numbers
(`رقم5 لسنة2012`) and scatter parentheses (`رقم ( 38 )لسنة 2022`), and Arabic-Indic
digits turn up. Acts cited by name alone (`قانون الإثبات`) are deliberately not
matched: without a number and year they cannot be resolved without a name index,
and guessing would put false edges in the graph.

**Do not break ties by how specific the instrument type is.** That rule resolves
everything and is confidently wrong: it turned the Arbitration Law 6/2018 into the
supplementary budget decree 6/2018, an edge that looks entirely plausible in the
data. The subject phrase the judgment gives beside the number (`بشأن التحكيم`) is
what actually distinguishes them.

**Use `word_similarity`, not `similarity`, to match that subject.** The subject is
a short phrase and the title is long, so plain trigram similarity drowns the
signal — on decree-law 33/2021 it scored the right act 0.095 against the wrong
one's 0.057, while `word_similarity` gave 0.42 against 0.16. The pass also
requires the winner to clear the runner-up by 40%, so an undecidable pair stays
unresolved instead of being decided by noise.

**A third of citations point at acts the corpus does not contain**, and that is
the real ceiling, not the matcher: Civil Procedure Law 11/1992 alone accounts for
29 322 of them. It was repealed and replaced by 42/2022, and the portal only
serves what is current. Emirate-level Dubai legislation is the other large block.

DIFC and ADGM contribute nothing here — they are English-language common-law
courts and the extractor only runs over `language = 'ar'`.

## Legal note

Dubai Courts' terms of use prohibit reproducing the service in whole or in part
**for commercial purposes** without written permission; they say nothing about
automated access or rate limits. UAE Copyright Law 38/2021 excludes judicial
decisions from copyright, but that does not displace the contractual term. A
written permission request was sent to `info@dc.gov.ae` on 2026-08-01 committing
to attribution, no redistribution of raw texts, respecting any rate limits they
specify, and deletion on request. Honour those commitments when using this data.
