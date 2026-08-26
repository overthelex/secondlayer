# CH Registries (Zefix + SHAB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill `ch_zefix_companies` (all active Swiss companies, from LINDAS) and `ch_shab_publications` (every SHAB commercial-register and bankruptcy publication, from amtsblattportal.ch), keep both current nightly, and expose a Swiss due-diligence surface: `ch_search_companies` and `ch_get_company(uid)` joining Zefix, SHAB, FINMA, SECO and Kantonsblatt.

**Architecture:** Three new `chpipe` stages on the prod host (same venv, cron, `run-stage.sh`, delta): `zefix` walks LINDAS SPARQL municipality by municipality and upserts companies; `shab-list` pages the amtsblattportal list endpoint (metadata only, 2,000 per page) into `ch_shab_publications` with a per-month checkpoint; `shab-detail` is a queue stage that fetches each publication's XML for the UID, legal form, seat, purpose, capital and text, bankruptcies first. Two MCP handlers in `mcp_backend` read the tables directly (same pattern as `ChCourtTools`), registered in `tool-services.ts`, curated for MCP clients, labelled and rendered in the evidence panel.

**Tech Stack:** Python 3.11 (`chpipe`: psycopg 3, httpx, existing `chpipe/sparql.py` and `chpipe/http.py`), PostgreSQL 16, TypeScript (`mcp_backend`), Jest pg tests, Vitest.

**Spec:** Plane LEXAI-2005 plus the facts below (measured 2026-08-25/26). LINDAS: endpoint `https://lindas.admin.ch/query`, graph `<https://lindas.admin.ch/foj/zefix>`, class `https://schema.ld.admin.ch/ZefixOrganisation`, 792,332 organisations; predicates `schema:identifier` (one IRI per identifier: `.../UID/CHE242294601`, `.../CHID/CH03640617915`), `schema:legalName`, `schema:name` (optional), `schema:additionalType` (legal form IRI `https://ld.admin.ch/ech/97/legalforms/0107`), `https://schema.ld.admin.ch/municipality` (IRI `https://ld.admin.ch/municipality/371`), `schema:description` (purpose), `schema:address` / `locn:address`; licence "Provide-the-Source". amtsblattportal: `GET https://amtsblattportal.ch/api/v1/publications/xml?publicationStates=PUBLISHED&rubrics=HR|KK&publicationDate.start=YYYY-MM-DD&publicationDate.end=YYYY-MM-DD&pageRequest.size=2000&pageRequest.page=N` returns `<total>` and `<publication ref=".../publications/{id}/xml">` with `<meta>` only (id, rubric, subRubric, language, registrationOffice, publicationNumber, publicationDate, cantons, title in de/en/fr/it like "Mutation SwissMeo SA, Neuchâtel, neu …"); totals HR 2,293,215, KK 215,853; the per-publication XML carries `uid`, `name`, `legalForm`, `seat`, `purpose`, `nominal` (capital), `publicationText`, `lastFosc*`, and for KK `typeOfCirculation`, `remarks`, `legalRemedy`. No auth for PUBLISHED; no documented rate limit (use 10 requests/s). Existing tables: `ch_zefix_companies(uid PK, name, legal_form, legal_seat, register_office, status, purpose, capital, capital_currency, address, canton, chid, ehraid, shab_pub_date, metadata_json, imported_at, updated_at)` with indexes on name/canton/legal_form/status and an FTS index `idx_ch_zefix_fts` (migration 129); `ch_shab_publications(id serial, shab_id UNIQUE, publication_date, publication_type, rubric, sub_rubric, company_uid, company_name, canton, content, metadata_json, imported_at, updated_at)` (129); `ch_companies` (133) filled by the Kantonsblatt importer; `ch_finma_regulated(entity_name, authorization_type, status, city, canton, …)`; `ch_seco_sanctions`; `ch_kantonsblatt_publications`.

## Global Constraints

- Stages follow the `chpipe` conventions: `run(settings, ...) -> Report` dataclass, `main()`, `db.connect(settings)` autocommit dict_row, `throttle.wait_for_capacity` only for CPU stages (none here), `run-stage.sh` dispatch by module name, logs in `/data/ch-corpus/logs`.
- Every migration idempotent; numbering continues after the citation-state migration 200 (use `201_ch_registries.sql`; if 200 is not merged yet when this lands, keep 201 anyway).
  - **Renumbered on merge:** cantonal legislation (PR #2351) landed 201 on main first, so what shipped here is `202_ch_registries.sql` with `tests/test_migration_202.py` and `conftest.apply_migration_202`. Every "201" below means 202.
- HTTP: reuse `chpipe/http.py` `Fetcher` (concurrency cap, bounded retries, User-Agent) for amtsblattportal; SPARQL via `chpipe/sparql.py` `SparqlClient`. Rate limits: SPARQL one query at a time; amtsblattportal ≤ 10 requests per second (setting `CHPIPE_SHAB_RPS`, default 10).
- Checkpoint/resume everywhere: `shab-list` per (rubric, month) in `ch_shab_progress`; `shab-detail` per row (`detail_fetched_at`), claimed with `FOR UPDATE SKIP LOCKED`, bankruptcies (KK) before HR, newest first; `zefix` per municipality in `ch_zefix_progress(run_date, municipality_id)`.
- Tests: pure parsers with fixtures (XML/CSV/JSON files under `tests/fixtures/registries/`), stage tests with fake transports (httpx `MockTransport`, a fake SPARQL client), DB tests env-gated on `CHPIPE_TEST_DSN` applying the migration file; never a live HTTP call in tests.
- Tools: Ukrainian descriptions, parameterised SQL, limit default 20 max 50, `wrapSearchResults`/`wrapResponse`, pg tests against a real Postgres (`CH_TEST_DATABASE_URL`, name must contain "test") applying migrations 129/132/133/201.
- Branch `feat/ch-registries`, worktree `~/SecondLayer-worktrees/ch-registries`; commit after each task.
- Run Python tests: `cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test $VENV/python -m pytest -q` with `$VENV=/private/tmp/claude-501/-Users-vovkes-SecondLayer/06b5c161-d89c-46fb-a721-9953f2e80e54/scratchpad/chpipe-venv`; TS: `cd mcp_backend && CH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ch_tools_test npx jest <name>`; `npx tsc --noEmit -p . 2>&1 | grep -v core-loader` empty.

## Design

### Migration 201

```sql
SET lock_timeout = '3s';
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS municipality_id integer;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS legal_form_code text;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS seen_at timestamptz;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS source_iri text;
CREATE TABLE IF NOT EXISTS ch_zefix_municipality (id integer PRIMARY KEY, name text NOT NULL, canton text, iri text NOT NULL);
CREATE TABLE IF NOT EXISTS ch_zefix_progress (run_date date NOT NULL, municipality_id integer NOT NULL, companies integer NOT NULL DEFAULT 0, done_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_date, municipality_id));
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS publication_number text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS title text;             -- title in the publication language
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS registration_office text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS legal_form text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS seat text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_fetched_at timestamptz;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_error text;
CREATE INDEX IF NOT EXISTS idx_ch_shab_uid ON ch_shab_publications (company_uid) WHERE company_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_shab_date ON ch_shab_publications (publication_date);
CREATE INDEX IF NOT EXISTS idx_ch_shab_detail_queue ON ch_shab_publications (rubric, publication_date DESC) WHERE detail_fetched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ch_shab_name_trgm ON ch_shab_publications USING gin (company_name gin_trgm_ops);  -- guarded: only if pg_trgm exists
CREATE TABLE IF NOT EXISTS ch_shab_progress (rubric text NOT NULL, month date NOT NULL, total integer, fetched integer, done_at timestamptz, PRIMARY KEY (rubric, month));
```

### Stage `zefix` (`chpipe/stages/zefix_stage.py`, helpers in `chpipe/zefix.py`)

1. Municipalities: `SELECT ?m ?name ?canton WHERE { ?m a <https://schema.ld.admin.ch/Municipality> ; schema:name ?name . OPTIONAL { ?m <https://schema.ld.admin.ch/canton> ?c . ?c schema:alternateName ?canton } }` (the implementer verifies the exact predicates with one live probe and records them in the module docstring); upsert `ch_zefix_municipality`.
2. Per municipality (ordered by id), one query for its organisations: identifiers (UID, CHID), legalName, name, legal form IRI, description, address parts; parse `CHE\d{9}` from the UID IRI into `CHE-123.456.789` form (canonical with dots and hyphen, as in Zefix); legal form code = last path segment, mapped to a label for the common codes (0101 Einzelunternehmen, 0103 Kollektivgesellschaft, 0104 Kommanditgesellschaft, 0106 AG, 0107 GmbH, 0108 Genossenschaft, 0109 Verein, 0110 Stiftung, 0111 Zweigniederlassung, others keep the code).
3. Upsert `ch_zefix_companies` (uid PK): name, legal_form (label), legal_form_code, legal_seat (municipality name), canton, purpose, chid, address, municipality_id, source_iri, status 'active', seen_at = run timestamp, metadata_json = the raw bindings; `ON CONFLICT (uid) DO UPDATE` all fields.
4. After a complete run (all municipalities done for `run_date`): `UPDATE ch_zefix_companies SET status = 'inactive' WHERE seen_at < run_start AND status = 'active'` (companies that left the active set).
5. Report: municipalities, companies_seen, upserted, inactivated. Resume: municipalities with a `ch_zefix_progress` row for today's run_date are skipped.

### Stage `shab-list` (`chpipe/stages/shab_list_stage.py`, parser in `chpipe/shab.py`)

For each rubric in (KK, HR) and each month from `CHPIPE_SHAB_FROM` (default 2000-01) to the current month, unless `ch_shab_progress` marks it done: page the list endpoint (size 2000) with `publicationDate.start/end` = month bounds; upsert rows keyed by `shab_id` (the publication id): publication_date, rubric, sub_rubric, language, publication_number, canton (first of `cantons`), title (in `language`), company_name and seat parsed from the title with the pattern `^(Neueintragung|Mutation|Löschung|Change|Deletion|Nouvelle inscription|Radiation|Cambiamenti|Cancellazione|Nuova iscrizione|Konkurs.*?|…)\s+(?P<name>.+?),\s+(?P<seat>[^,]+?)(,\s+(neu|new|nouveau|nuovo)\s+.*)?$` (implementer refines against 50 real titles kept as a fixture), registration_office, metadata_json = the meta block; `publication_type` = sub_rubric label map (HR01 Neueintragung, HR02 Mutation, HR03 Löschung, KK01 Konkurseröffnung, KK02 …; the implementer fetches the list of subRubrics observed and documents them). Mark the month done with total/fetched. Nightly delta: only the current and previous month.

### Stage `shab-detail` (`chpipe/stages/shab_detail_stage.py`)

Claim `LIMIT 500` rows `WHERE detail_fetched_at IS NULL AND detail_attempts < 3 ORDER BY (rubric = 'KK') DESC, publication_date DESC FOR UPDATE SKIP LOCKED`; fetch `/publications/{id}/xml` through `Fetcher` at ≤ `CHPIPE_SHAB_RPS`; parse `uid` → `company_uid` (canonical CHE form), `name` → company_name (overrides the title parse), `legalForm`, `seat`, `purpose`, `nominal` → metadata_json.capital, `publicationText` → content (plain text, tags stripped), KK: `typeOfCirculation`, `remarks` into metadata_json; set `detail_fetched_at`; on HTTP/parse error increment `detail_attempts`, store `detail_error`. Optional time budget `CHPIPE_SHAB_BUDGET_SECONDS` so the nightly delta stops after N seconds; the backfill runs without a budget under tmux.

### Tools (`mcp_backend/src/api/tools/ch-registry-tools.ts`)

- `ch_search_companies { query: string, canton?: string, legal_form?: string, status?: 'active'|'inactive'|'all' (default active), limit?, offset? }` → rows from `ch_zefix_companies` (name ILIKE with word boundary for short queries as in ch_search_legislation, or `uid` exact when the query matches `CHE-?\d{3}\.?\d{3}\.?\d{3}`), each with `{ uid, name, legal_form, legal_seat, canton, status, purpose (first 300 chars), shab_count (count of ch_shab_publications by uid), last_shab_date, bankruptcy (true if any KK publication) }`; falls back to `ch_shab_publications.company_name` matches (companies not in Zefix, e.g. deleted) flagged `source: 'shab'`.
- `ch_get_company { uid: string }` → `{ company: <zefix row>, shab: [ { shab_id, publication_date, rubric, sub_rubric, publication_type, title, content (first 2000 chars) } ] (max 100, newest first), bankruptcies: [KK rows], finma: [ch_finma_regulated rows matched by normalised name (lower, no legal-form suffix) ], seco: [ch_seco_sanctions matched by normalised name], kantonsblatt: [ch_kantonsblatt_publications by uid or name] (max 50) }` plus `{ error: 'not_found' }`.
- Registration in `tool-services.ts`, names in `V2_TOOL_NAMES`, labels ("Пошук компаній Швейцарії (Zefix)", "Компанія Швейцарії: реєстр, SHAB, FINMA, SECO"), evidence extractor mapping to `VaultDocument`/registry items as `registry.ts` does for `openreyestr_*`.

---

### Task 1: Migration 201 and its test

**Files:** Create `mcp_backend/src/migrations/201_ch_registries.sql`, `services/ch-pipeline/tests/test_migration_201.py`.

- [ ] Failing test: applies 129 (only the ch_zefix/ch_shab/ch_finma/ch_seco parts are needed: create minimal versions of `ch_zefix_companies` and `ch_shab_publications` with the 129 columns in the fixture) then 201; asserts the new columns, the three tables, the partial index; idempotent; the trigram index creation is skipped without pg_trgm (guard with `DO $$ … IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')`).
- [ ] Implement, run, commit `feat(ch): registries migration 201`.

### Task 2: Zefix stage

**Files:** Create `chpipe/zefix.py` (SPARQL queries as constants, parsers: `uid_from_iri`, `legal_form_label`, `municipality_from_iri`, `company_row(bindings, seen_at)`), `chpipe/stages/zefix_stage.py`, `tests/test_zefix.py` (pure), `tests/test_zefix_stage.py` (DB + fake SPARQL client returning fixture rows), `tests/fixtures/registries/lindas_municipalities.csv`, `lindas_orgs_371.csv` (captured live by the implementer with one probe each, ≤ 20 rows).

- [ ] Failing tests: parsers; stage upserts two companies for municipality 371, writes progress, second run skips the municipality; a company missing from the second full run becomes inactive; report counts.
- [ ] Implement with `SparqlClient` (see `chpipe/sparql.py` for the keyset helpers; here the partition is the municipality) and `db.connect`; `main()`; run-stage.sh entry `zefix` (no argument).
- [ ] Commit `feat(ch): zefix stage from LINDAS`.

### Task 3: SHAB list stage

**Files:** Create `chpipe/shab.py` (`parse_list_page(xml) -> (total, [meta dicts])`, `parse_title(title, lang) -> (company_name, seat)`, `sub_rubric_label(code)`), `chpipe/stages/shab_list_stage.py`, `tests/test_shab.py`, `tests/test_shab_list_stage.py`, fixtures `shab_list_hr.xml`, `shab_list_kk.xml` (captured, 3 publications each), `shab_titles.txt` (50 real titles with expected name/seat).

- [ ] Failing tests: parsers (all 50 titles), paging over a fake transport (two pages), upsert idempotent, progress rows, month iteration bounds, delta mode (`months=2`).
- [ ] Implement with `Fetcher` (async, concurrency 4, rate limited), `main()`, run-stage.sh entry `shab-list [months]`.
- [ ] Commit `feat(ch): shab list stage`.

### Task 4: SHAB detail stage

**Files:** Create `chpipe/stages/shab_detail_stage.py`, extend `chpipe/shab.py` with `parse_detail(xml, rubric) -> dict`, tests `tests/test_shab_detail_stage.py`, fixtures `shab_detail_hr.xml`, `shab_detail_kk.xml` (captured).

- [ ] Failing tests: parse_detail extracts uid (canonical), name, legal form, seat, purpose, capital, text, KK fields; the stage claims KK before HR, newest first; sets detail_fetched_at; an HTTP 500 increments attempts and stores the error, a third failure stops retries; the time budget stops the loop; rate limit respected (fake clock).
- [ ] Implement; `main()`; run-stage.sh entry `shab-detail`.
- [ ] Commit `feat(ch): shab detail stage`.

### Task 5: Registry tools

**Files:** Create `mcp_backend/src/api/tools/ch-registry-tools.ts`, `mcp_backend/src/api/tools/__tests__/ch-registry-tools.pg.test.ts`; modify `tool-services.ts`, `curated-mcp-tools.ts`, `lexwebapp/src/hooks/chat/tool-labels.ts`, `lexwebapp/src/hooks/chat/evidence/ch.ts` (+ its test) for the two new tools.

- [ ] Failing pg test: fixtures for one AG in ZH with three SHAB rows (HR01, HR02, KK01), one FINMA row with the same name, one SECO row; search by name, by UID, by canton, inactive filter; get returns all sections; not found.
- [ ] Implement; tsc clean; vitest for the extractor; commit `feat(ch): Swiss company search and due-diligence tools`.

### Task 6: Wiring, delta, docs

**Files:** `run-stage.sh` (entries), `chpipe/delta.py` (a `run_registries()` half: zefix nightly, shab-list months=2, shab-detail with a 90-minute budget; guarded like the other halves; tests in `test_delta.py`), `README.md` (stages, env vars, backfill order).

- [ ] Failing delta tests; implement; commit `feat(ch): registries in the nightly delta`.

### Task 7: Prod backfill (controller)

- Deploy applies 201; `run-stage.sh zefix` (expect ~792K, watch the municipality progress), `run-stage.sh shab-list` (all months; expect ~2.5M rows), `run-stage.sh shab-detail` under tmux (KK first, then HR; ~10 rps → KK in ~6 h, HR over days), tools E2E: search "SwissMeo", get its UID (bankruptcy/liquidation visible), a FINMA-regulated bank, a SECO-listed name.
