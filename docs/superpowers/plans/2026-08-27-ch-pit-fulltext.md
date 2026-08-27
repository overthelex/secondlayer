# CH point-in-time full texts: Fedlex PDF era + decision→laws tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** For any Swiss court decision, serve the full text of every cited act in the edition that was in force on the decision date — by backfilling Fedlex's pre-XML-era consolidations (published as pdf-a back to ~1995–2001) and adding two MCP tools.

**Architecture:** The pipeline (services/ch-pipeline) gains a second discovery pass in the versions stage (pdf-a manifestations, only where no XML edition exists) and one new stage `fedlex-pdf-text` (download PDF → pdftotext → full_text on ch_act_version, no article split). The backend (mcp_backend) gains `ch_get_act_text` (full text of the edition valid at a date, sliced) and `ch_get_decision_legislation` (cited acts of a decision with the edition valid at its date). lexwebapp renders both in the right evidence panel.

**Tech stack:** Python 3 / psycopg 3 / httpx (chpipe), TypeScript (mcp_backend, lexwebapp), PostgreSQL.

**Spec:** no file — design approved in chat 2026-08-27. Measured facts the plan argues from:
- Fedlex serves pdf-a with a file URL for ~100% of pre-2021 consolidations (verified SR 220/210/311.0/831.10/741.01/272); earliest 1995–2001; text layer is clean digital text (pdftotext on 1995 StGB is correct German).
- Volume: ~28.8K editions per language have pdf-a vs ~12K with XML → ~17K net-new per lang, ~50K PDFs de/fr/it.
- Current edition-at-decision-date coverage (1% citation sample, prod): 99.6% for decisions from 2021, ~5% before 2021; 824,836 of 1.22M loaded decisions are pre-2021.
- 133,559 decisions carry placeholder decision_date=2021-01-01 (source-side; real date sometimes absent entirely).

## Global Constraints

- All user-facing tool descriptions / UI strings in Ukrainian (uk-UA).
- Edition-validity predicate everywhere (date_end_applicability is INCLUSIVE): `date_applicability <= D AND (D <= date_end_applicability OR date_end_applicability IS NULL)`.
- Never assemble Fedlex filestore URLs from string patterns — only `jolux:isExemplifiedBy` values from the graph.
- `ch_act.sr_number` is NOT unique; act identity is act_id / eli_work_uri. Tools resolving sr_number use `ORDER BY (in_force = 0) DESC ... LIMIT 1` as existing tools do.
- Text slicing in SQL: guard against the PG15/Alpine multibyte bug — never `left(coalesce(col),N)`; use `col || ''` inside the function (`substr(full_text || '', ...)`, `left(full_text || '', N)`).
- Migration 204 must be idempotent and valid both with and without unmerged migration 203 (prod already has 203 applied by hand: source CHECK = fedlex, lexwork, lexwork_pdf, lexfind, sil, ti_rl, zhlex).
- Python tests: `cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpit_test python -m pytest -q` (venv python: /private/tmp/claude-501/-Users-vovkes-SecondLayer/06b5c161-d89c-46fb-a721-9953f2e80e54/scratchpad/chpipe-venv/bin/python). TS pg tests: `CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/chpit_tools_test npx jest <pattern>` from mcp_backend. Frontend: `cd lexwebapp && npx vitest run src/hooks/chat/evidence/__tests__/ch.test.ts`.
- Commit per logical change; never touch files outside the listed set.

---

### Task 1: Migration 204 + pdf-a edition discovery in the versions stage

**Files:**
- Create: `mcp_backend/src/migrations/204_ch_fedlex_pdf.sql`
- Modify: `services/ch-pipeline/chpipe/fedlex_queries.py` (add VERSIONS_PDF)
- Modify: `services/ch-pipeline/chpipe/stages/versions_stage.py`
- Modify: `services/ch-pipeline/tests/conftest.py` (apply 204 after 201)
- Test: `services/ch-pipeline/tests/test_versions_stage.py` (extend)

**Interfaces produced:** ch_act_version rows with `source='fedlex_pdf'`, `stage='discovered'`, `xml_url=<pdf-a file URL>` (yes, the pdf URL goes in xml_url — the whole claim/fetch machinery keys on that column; do not add a new column).

Migration 204 (idempotent, superset of 203's list):

```sql
-- 204_ch_fedlex_pdf.sql
-- Widen ch_act_version.source for the federal PDF-era backfill. Written to
-- work whether or not 203 (feat/ch-cantonal-phase2, applied on prod by hand)
-- is present: DROP IF EXISTS + ADD NOT VALID + VALIDATE.
ALTER TABLE public.ch_act_version DROP CONSTRAINT IF EXISTS ch_act_version_source_chk;
ALTER TABLE public.ch_act_version ADD CONSTRAINT ch_act_version_source_chk
  CHECK (source IN ('fedlex','fedlex_pdf','lexwork','lexwork_pdf','lexfind','sil','ti_rl','zhlex')) NOT VALID;
ALTER TABLE public.ch_act_version VALIDATE CONSTRAINT ch_act_version_source_chk;
```

`VERSIONS_PDF` in fedlex_queries.py: identical to `VERSIONS` except `jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/pdf-a>`. Verified live 2026-08-27 in exactly the stage's `VALUES ?work {...}` batch form: SR 220 work returns 205 rows (DEU 53, FRA 55, ITA 53, ENG/ROH skipped by LANGUAGE_MAP as usual).

versions_stage changes:
- New `_UPSERT_PDF_VERSION` SQL. Semantics: insert `source='fedlex_pdf', stage='discovered'` ONLY when no XML row exists for that (consolidation, lang); never touch a non-pdf row; re-walking an existing pdf row updates dates with the same COALESCE semantics as `_UPSERT_VERSION`:

```sql
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, stage, source, updated_at)
SELECT a.act_id, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
       %(file_url)s, 'discovered', 'fedlex_pdf', now()
  FROM ch_act a WHERE a.eli_work_uri = %(work)s
   AND NOT EXISTS (SELECT 1 FROM ch_act_version v
                    WHERE v.eli_consolidation_uri = %(consolidation)s
                      AND v.lang = %(lang)s AND v.source <> 'fedlex_pdf')
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = COALESCE(EXCLUDED.date_end_applicability,
                                      ch_act_version.date_end_applicability),
    xml_url                = COALESCE(EXCLUDED.xml_url, ch_act_version.xml_url),
    updated_at             = now()
  WHERE ch_act_version.source = 'fedlex_pdf'
RETURNING version_id
```

  CAREFUL: "INSERT ... SELECT returned no row" now has THREE meanings: work missing (orphaned), xml row exists (skip — the desired outcome), or conflict-update filtered out. Write a dedicated `upsert_pdf_version(conn, row) -> str` returning one of 'upserted' | 'skipped_has_xml' | 'orphaned': check the INSERT result first; on None, one cheap `SELECT 1 FROM ch_act_version WHERE eli_consolidation_uri=.. AND lang=.. AND source <> 'fedlex_pdf'` distinguishes skipped_has_xml from orphaned. (The DO UPDATE ... WHERE source='fedlex_pdf' arm can only filter rows that the NOT EXISTS already let through, so in practice a conflicting row here is always fedlex_pdf and updates fine — but the classification query keeps the accounting honest regardless.)
- `run()` gains a second batched pass (after the xml pass, same works list, same per-row guard) over `fq.VERSIONS_PDF`; report gains `pdf_discovered: int`, `pdf_skipped_has_xml: int` counters (log line included).
- IMPORTANT ORDER: within one run, the xml pass MUST complete before the pdf pass (a consolidation with both formats must land as xml). This is already the natural order — assert nothing, just keep the loop order and say so in a comment.

Test cases (TDD, red first; use the existing conftest fixtures/DSN):
1. pdf row for a consolidation that already has an xml row → xml row unchanged (source stays 'fedlex', xml_url stays the xml URL), returns 'skipped_has_xml'.
2. new pdf row → inserted with source='fedlex_pdf', stage='discovered', xml_url = the pdf URL.
3. re-walk of the same pdf row with dateEnd now present → updated (COALESCE semantics), still 'upserted'.
4. work absent from ch_act → 'orphaned'.
5. `run()` with a fake SPARQL client returning one xml row then the same consolidation from the pdf query → one row total, source='fedlex'; report.pdf_skipped_has_xml == 1.
6. conftest now applies 204: assert INSERT with source='fedlex_pdf' passes the CHECK.

Commit: `feat(ch): discover Fedlex pdf-a editions where no XML exists (migration 204)`

### Task 2: fedlex-pdf-text stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/fedlex_pdf_text_stage.py`
- Modify: `services/ch-pipeline/run-stage.sh` (add `fedlex-pdf-text` to the no-second-arg case)
- Test: `services/ch-pipeline/tests/test_fedlex_pdf_text_stage.py`

**Interfaces:**
- Consumes: rows from Task 1 (`stage='discovered'`, `source='fedlex_pdf'`, xml_url = pdf URL); `db.claim_versions(conn, stage='discovered', limit, source='fedlex_pdf')`; `text_extract.from_pdf(path)`; `text_quality.score(text, [lang])` and `ACCEPT_THRESHOLD`.
- Produces: those rows with `full_text` set, `stage='parsed'`, `article_count` left NULL (no article split in this task), `fetched_at=now()`; failures → `stage='failed'` after max attempts with `failed_stage` and `last_error`, following exactly the state discipline of `fetch_xml_stage` (read it first and mirror its claim/mark helpers, batch loop, budget handling via `settings`, and report dataclass shape).

Stage behaviour:
- Claim in batches (BATCH_SIZE 50), download each pdf with the module-level Fetcher/httpx client used by fetch_xml_stage (same UA, retries, timeout), stream to a NamedTemporaryFile, hard cap 80 MB (over-cap → failure, last_error='pdf_too_large').
- `text = from_pdf(tmp_path)`; empty → failure `last_error='empty_text_layer'`. `q = text_quality.score(text, [lang])`; `q < ACCEPT_THRESHOLD` → failure `last_error=f'quality {q:.2f}'`. Success → UPDATE full_text, stage='parsed', fetched_at, stage_updated_at, attempts untouched.
- Progress log every 200 rows; final report logged (claimed, parsed, failed, empty, low_quality, bytes_downloaded).
- Respect `CHPIPE_BUDGET_SECONDS` the same way fetch_xml_stage does (if it does); do not invent new env vars beyond an optional `CHPIPE_PDF_CONCURRENCY` ONLY if fetch_xml_stage already has a concurrency knob to mirror — otherwise sequential is fine (50K docs × ~0.3 s download + 60 ms pdftotext ≈ 5 h; acceptable, backfill runs supervised with several processes only if needed — do NOT build multi-worker claiming logic, FOR UPDATE SKIP LOCKED already allows N parallel processes).
- pdftotext failure modes: `PdfToolMissing` must abort the run loudly (not mark rows failed).

Tests (use conftest DB + httpx MockTransport; a tiny valid PDF fixture — check tests/ for an existing sample PDF from the decisions pipeline and reuse it; if none exists, embed the minimal 2-page "%PDF-1.4" fixture bytes in the test file):
1. happy path: discovered fedlex_pdf row → parsed, full_text non-empty, article_count IS NULL, source unchanged.
2. HTTP 404 → attempts+1, row re-claimable until max_attempts, then stage='failed', failed_stage='fetched'.
3. empty text layer → failure with last_error='empty_text_layer'.
4. a claimed row with source='fedlex' is never touched (claim filter) — seed one xml row, run, assert untouched.
5. run-stage.sh: `bash -n` passes and the case arm dispatches to `chpipe.stages.fedlex_pdf_text_stage` (assert via the existing run-stage tests if any; otherwise a grep-style test is fine).

Commit: `feat(ch): fedlex-pdf-text stage — full text for PDF-era editions`

### Task 3: nightly delta wiring

**Files:**
- Modify: `services/ch-pipeline/chpipe/delta.py` (run_legislation: call `fedlex_pdf_text_stage.run(settings)` right after `fetch_xml_stage.run(settings)`; add its numbers to DeltaReport the same way fetch is reported)
- Test: extend the existing delta tests (find the test that asserts run_legislation's stage order and add the new stage to it).

Rationale line for the code comment: new editions going forward are XML-era, so this is normally a no-op; it exists so a future Fedlex PDF-only edition (or a re-queued failure) drains nightly instead of rotting.

Commit: `feat(ch): drain fedlex_pdf rows in the nightly legislation delta`

### Task 4: ch_get_act_text tool

**Files:**
- Modify: `mcp_backend/src/api/tools/ch-legislation-tools.ts` (new tool definition + handler in ChLegislationTools)
- Modify: `mcp_backend/src/api/curated-mcp-tools.ts` (V2_TOOL_NAMES + CH block)
- Modify: `mcp_backend/src/api/__tests__/ch-tools-registration.test.ts` (name lists)
- Test: `mcp_backend/src/api/tools/__tests__/ch-legislation-tools.pg.test.ts` (extend; ALSO add migration 204 to the applied-migrations list there and in any other ch pg test that applies migrations)
- Test: `mcp_backend/src/api/tools/__tests__/ch-legislation-tools.test.ts` (unit: validation errors)

Input schema (Ukrainian description: «Повний текст швейцарського акта в редакції, чинній на задану дату»):
- `act_id` (number) OR `sr_number` (string) — exactly one required; sr_number resolves like existing tools (ORDER BY in_force, LIMIT 1).
- `as_of` (string, date, required), `lang` (enum de/fr/it, default 'de'), `offset` (int ≥0, default 0), `max_chars` (int, default 50000, cap 200000).

Handler logic:
- Edition pick, ONE SQL, lang preference then fallback: pick the best edition among all langs with `ORDER BY (lang = $lang) DESC, (lang = 'de') DESC, date_applicability DESC LIMIT 1` over rows satisfying `stage='parsed' AND act_id=$1 AND` the Global-Constraints validity predicate, and requiring text availability: `(full_text IS NOT NULL OR EXISTS (SELECT 1 FROM ch_act_article aa WHERE aa.version_id = v.version_id))`.
- If no row: fallback query for the NEAREST parsed edition: ORDER BY lang prefs, then (date_applicability <= as_of) DESC, then abs distance between date_applicability and as_of ASC; label from the served row: date_applicability <= as_of -> 'nearest_earlier_edition', else 'nearest_later_edition' (and the same text machinery); if the act has no parsed editions at all → `wrapResponse({ error:'no_edition_for_date', act_id, earliest_edition:null })`.
- Text: if `full_text` present, slice it; else build from articles: `SELECT string_agg(...)` over ch_act_article for the version, ordered by its natural order column (read migration 197 for the exact columns — there is a position/seq column; use it, never order by article number strings). Build the full string in SQL and slice in SQL: `substr(txt || '', $offset+1, $max_chars)` plus `length(txt || '')` as total. NEVER select the whole full_text into Node when offset+max_chars bounds it — slice in SQL.
- Response: `{ act_id, sr_number, title, lang: <lang of served edition>, requested_lang, as_of, retrieval_status: 'edition_at_date'|'nearest_earlier_edition'|'nearest_later_edition', edition: { date_applicability, date_end_applicability, source }, text, text_offset, text_total_chars, truncated }`.

pg tests: edition at date (xml-era act with articles, no full_text → text built from articles); pdf-era edition (full_text set, no articles) served with slicing (offset/max_chars/truncated flags); as_of before earliest → nearest_later_edition status; unknown act → no_edition_for_date; lang fallback (fr requested, only de edition exists → serves de, response says lang:'de', requested_lang:'fr').

Commit: `feat(ch): ch_get_act_text — повний текст акта на дату`

### Task 5: ch_get_decision_legislation tool

**Files:** same registration set as Task 4 (ch-legislation-tools.ts, curated-mcp-tools.ts, ch-tools-registration.test.ts, both test files).

Input schema (description: «Всі акти, цитовані судовим рішенням, з редакцією, чинною на дату рішення»):
- `ecli` (string, required), `as_of` (string, date, optional override), `limit` (int, default 20, cap 50).

Handler logic:
- Decision lookup: `SELECT ecli, decision_date, <LANG_EXPR> AS lang FROM ch_court_decisions WHERE ecli=$1 AND stage='loaded'` — copy LANG_EXPR verbatim from ch-court-tools.ts:38 (metadata_json->>'Sprache' with languages[1] fallback). Not found → wrapError shape consistent with ch_get_court_decision's not_found handling.
- `effective_date = as_of ?? decision_date`; `date_unreliable = (decision_date === '2021-01-01' && !as_of)` — include the flag and a Ukrainian `date_note` explaining the placeholder when true.
- Cited acts: group ch_legislation_citations by act_id (`WHERE from_ecli=$1 AND act_id IS NOT NULL`), `count(*) AS citations_count`, `array_agg(DISTINCT article ORDER BY article) FILTER (WHERE article <> '')` capped to 15 per act in the response (with `articles_truncated` flag), `ORDER BY citations_count DESC LIMIT $limit`; also return `total_cited_acts` (separate count) and `acts_truncated`.
- Per act LATERAL: act meta (title/abbr the same way ch_search_legislation selects them; jurisdiction) + best edition at effective_date with the exact Task-4 preference ordering and text-availability condition; when none, LATERAL falls back to the NEAREST parsed edition in time (last edition starting <= date preferred, else earliest later one), labelled nearest_earlier_edition / nearest_later_edition from the served row. Per-act output: `{ act_id, sr_number, title, abbreviation, jurisdiction, citations_count, articles_cited, edition: {...}|null, retrieval_status: 'edition_at_date'|'nearest_earlier_edition'|'nearest_later_edition'|'no_text', next: { tool:'ch_get_act_text', act_id, as_of: effective_date, lang } }`.
- Unresolved tail: also return `unresolved: { count, top_abbrs: [...] }` from the same decision's rows with act_id IS NULL (top 5 by count) — the honest remainder, mostly cantonal.
- Response top level: `{ ecli, decision_date, effective_date, date_unreliable, lang, acts: [...], total_cited_acts, acts_truncated, unresolved }`.

pg tests: decision with citations to two acts (one covered at date, one only later editions) → statuses correct, ordering by citations_count; placeholder date sets date_unreliable and as_of override clears it; unresolved tail counted; ecli not found; limit/truncation flags.

Commit: `feat(ch): ch_get_decision_legislation — акти рішення в редакції на його дату`

### Task 6: evidence panel + labels

**Files:**
- Modify: `lexwebapp/src/hooks/chat/tool-labels.ts` — `ch_get_decision_legislation: 'Законодавство до рішення (Швейцарія)'`, `ch_get_act_text: 'Текст акта на дату (Швейцарія)'`.
- Modify: `lexwebapp/src/hooks/chat/evidence/ch.ts` — add both names to `CH_LEGISLATION_TOOLS`; in `extractChLegislationEvidence`: for `ch_get_decision_legislation` build one Citation per act (title, sr_number/cantonal number label as existing code does, edition dates in the snippet, «редакція на …» / «⚠ найближча редакція (рання/пізніша)» according to retrieval_status / «текст недоступний» status text, citations_count); for `ch_get_act_text` build a VaultDocument with the text (title = act title + edition range, honour truncated flag with «показано N з M символів»).
- Test: `lexwebapp/src/hooks/chat/evidence/__tests__/ch.test.ts` — describe block per tool: happy path, nearest_later flag wording, truncated wording, negative (unrelated tool untouched).

All strings Ukrainian. Results render in the right panel only (Citations/VaultDocument — never chat text).

Commit: `feat(ch): evidence панель для decision-legislation і act-text`

---

## Not in this branch (ops phase, controller by hand after merge+deploy)
Deploy applies 204 via migrate-prod. Then on prod, supervised: `run-stage.sh versions` (discovers ~50K pdf rows, ~15–30 min), `run-stage.sh fedlex-pdf-text` under tmux (~50K PDFs, est 4–6 h single process; check /data free space first — expect roughly +10 GB table growth), re-run the year-bucket coverage measurement, tools E2E via the node-fetch recipe in the app container, memory + Plane.
