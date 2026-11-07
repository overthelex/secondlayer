# Attorney CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password-protected CRM at https://attorney.legal.org.ua/ listing active advocates from the НААУ registry with derived and manual practice areas, contact notes and a "today" page, deployed on cthulhu by the existing CI.

**Architecture:** One new service `attorney_crm/` (TypeScript, Express, server-rendered HTML from template-literal views, pg) sharing the prod Postgres. CRM tables are prefixed `attorney_crm_` and bootstrapped by the service from `attorney_crm/sql/*.sql`. The practice derivation already exists as SQL (`001_practice_derivation.sql`, running as a backfill); the service only drives it daily.

**Tech Stack:** Node 20, TypeScript 5, express 4, pg 8, jest + ts-jest for unit tests, no frontend framework, no Tailwind build (one hand-written stylesheet).

**Spec:** `docs/superpowers/specs/2026-11-07-attorney-crm-design.md`

## Global Constraints

- UI text in Ukrainian (uk-UA).
- Every route except `GET/POST /login`, `GET /healthz` and `/static/*` requires a valid session; unauthenticated requests get `302 /login`.
- All HTML output is escaped by default; raw HTML only through an explicit `raw()` helper.
- CRM rows key on `opendata_advocates.source_id` (text), never on its serial `id`.
- Active advocate = `status <> 'TRUE'` in `opendata_advocates` (the rule from `mcp_backend/src/api/tools/registry-catalog.ts`); suspended/terminated advocates are never listed.
- Password hashes: `scrypt$N$r$p$<salt b64>$<hash b64>` with N=32768, r=8, p=1, 16-byte salt, 64-byte hash.
- Session cookie `acrm_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days; value = random 32 bytes base64url; DB stores `sha256(value)`.
- Login rate limit: after 10 failed attempts for one e-mail within 15 minutes, respond 429 with the Ukrainian message «Забагато спроб. Спробуйте за 15 хвилин.»
- Service listens on `PORT` (default 3020); fails to start if `ATTORNEY_CRM_SESSION_SECRET` or `DATABASE_URL` is missing.
- Table pages: 50 rows per page.
- Manual practice tags must be members of `NAAU_PRACTICES` (59 strings from the spec); anything else is rejected with 400.
- Lead stages: `new | contacted | interested | declined | client`; note kinds: `call | email | meeting | other`.

## Review Focus

1. A surname filter containing `%`, `_` or `\` must be treated literally (prefix match), not as a LIKE wildcard. Test in Task 6.
2. An advocate with no row in `attorney_crm_leads` must still render on the advocate page and accept a first note/stage change (lead row created on demand). Test in Task 8.
3. A note body of only whitespace must be rejected (400), never saved as an empty note. Test in Task 8.
4. `next_contact_at` set in the past must appear on the Today page as overdue, before today's items. Test in Task 9.
5. A session whose `expires_at` has passed must be treated as logged out, and its cookie cleared. Test in Task 4.

---

### Task 1: Service skeleton, config and DB pool

**Files:**
- Create: `attorney_crm/package.json`, `attorney_crm/tsconfig.json`, `attorney_crm/jest.config.cjs`, `attorney_crm/.gitignore`
- Create: `attorney_crm/src/config.ts`, `attorney_crm/src/db.ts`
- Test: `attorney_crm/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` where `Config = { port: number; databaseUrl: string; sessionSecret: string; derivationLagDays: number; derivationBatch: number }`; throws `Error('ATTORNEY_CRM_SESSION_SECRET is required')` / `Error('DATABASE_URL is required')`.
- Produces: `createPool(databaseUrl: string): pg.Pool`.

- [ ] **Step 1: Write the failing test**

```ts
import { loadConfig } from '../config';
test('defaults port to 3020 and reads the secret', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', ATTORNEY_CRM_SESSION_SECRET: 's' });
  expect(c.port).toBe(3020); expect(c.sessionSecret).toBe('s'); expect(c.derivationLagDays).toBe(30); expect(c.derivationBatch).toBe(2000);
});
test('fails fast without the session secret', () => {
  expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow('ATTORNEY_CRM_SESSION_SECRET is required');
});
test('fails fast without DATABASE_URL', () => {
  expect(() => loadConfig({ ATTORNEY_CRM_SESSION_SECRET: 's' })).toThrow('DATABASE_URL is required');
});
```

- [ ] **Step 2: Run `cd attorney_crm && npm install && npx jest src/__tests__/config.test.ts`** — expected FAIL: cannot find module `../config`.

- [ ] **Step 3: Create package.json** (name `attorney-crm`, private, `"type": "commonjs"`, scripts `build: tsc`, `start: node dist/index.js`, `test: jest`, `dev: tsx src/index.ts`; dependencies `express@^4.19`, `pg@^8.12`; devDependencies `typescript@^5.5`, `@types/express@^4.17`, `@types/pg@^8.11`, `@types/node@^20`, `jest@^29`, `ts-jest@^29`, `@types/jest@^29`, `tsx@^4`), `tsconfig.json` (target ES2022, module commonjs, outDir dist, rootDir src, strict, esModuleInterop, exclude `src/__tests__`), `jest.config.cjs` (preset ts-jest, testEnvironment node, roots `<rootDir>/src`), `.gitignore` (`node_modules`, `dist`). Commit the generated `package-lock.json`.

- [ ] **Step 4: Implement `loadConfig` in `src/config.ts` and `createPool` in `src/db.ts`** (`ATTORNEY_CRM_DERIVATION_LAG_DAYS`, `ATTORNEY_CRM_DERIVATION_BATCH` optional overrides).

- [ ] **Step 5: Run the test** — expected PASS. Run `npx tsc --noEmit` — expected no errors.

- [ ] **Step 6: Commit** `git add attorney_crm && git commit -m "feat(attorney-crm): service skeleton, config and pg pool"`

---

### Task 2: Schema bootstrap

**Files:**
- Create: `attorney_crm/sql/002_crm_core.sql`, `attorney_crm/src/schema.ts`
- Test: `attorney_crm/src/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: `001_practice_derivation.sql` (already in repo; it is idempotent, so applying it again is safe, but it contains `DROP FUNCTION IF EXISTS` — fine on boot).
- Produces: `applySchema(pool: pg.Pool, sqlDir: string): Promise<string[]>` returns the filenames applied this run. Uses table `attorney_crm_schema_version(filename text primary key, applied_at timestamptz)`; applies `*.sql` in lexical order, each inside one transaction, skipping filenames already recorded. `001_practice_derivation.sql` is re-applied on every boot regardless (it is the only file listed in `ALWAYS_APPLY`), so function fixes ship without a new migration. Its `DROP FUNCTION` would abort a backfill batch running at that instant, so the first deploy waits until the tmux backfill on cthulhu reports done (Task 12).

- [ ] **Step 1: Write `002_crm_core.sql`** with, all `IF NOT EXISTS`:
  - `attorney_crm_users(id serial pk, email text unique not null, password_hash text not null, display_name text not null default '', created_at timestamptz default now(), last_login_at timestamptz)`
  - `attorney_crm_sessions(token_hash text pk, user_id int not null references attorney_crm_users(id) on delete cascade, created_at timestamptz default now(), expires_at timestamptz not null)` + index on `expires_at`
  - `attorney_crm_leads(advocate_source_id text pk, stage text not null default 'new' check (stage in ('new','contacted','interested','declined','client')), next_contact_at timestamptz, assigned_user_id int references attorney_crm_users(id), manual_practices text[] not null default '{}', updated_at timestamptz default now(), updated_by int references attorney_crm_users(id))` + index on `next_contact_at`
  - `attorney_crm_notes(id bigserial pk, advocate_source_id text not null, user_id int not null references attorney_crm_users(id), kind text not null check (kind in ('call','email','meeting','other')), body text not null, created_at timestamptz default now())` + index `(advocate_source_id, created_at desc)` + index `(created_at desc)`

- [ ] **Step 2: Write the failing test** (unit, with a fake pool that records `query` calls):

```ts
test('applies files in order, records them, skips recorded ones, always re-applies 001', async () => {
  const calls: string[] = []; const recorded = new Set(['002_crm_core.sql']);
  const pool = fakePool(calls, recorded);
  const applied = await applySchema(pool as any, path.join(__dirname, '../../sql'));
  expect(applied).toEqual(['001_practice_derivation.sql']);
  expect(calls.some(q => q.includes('CREATE TABLE IF NOT EXISTS attorney_crm_schema_version'))).toBe(true);
});
```

- [ ] **Step 3: Run it** — expected FAIL (module missing).
- [ ] **Step 4: Implement `applySchema`** in `src/schema.ts` (`fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort()`; `BEGIN` … `COMMIT`, `ROLLBACK` on error and rethrow with the filename).
- [ ] **Step 5: Run the test** — PASS.
- [ ] **Step 6: Commit** `feat(attorney-crm): CRM core schema and bootstrap`

---

### Task 3: Password hashing and the set-password CLI

**Files:**
- Create: `attorney_crm/src/auth/password.ts`, `attorney_crm/src/cli.ts`
- Test: `attorney_crm/src/__tests__/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, stored: string): Promise<boolean>` (constant-time compare via `crypto.timingSafeEqual`; returns false, never throws, on a malformed `stored`).
- Produces: `upsertUser(pool, email: string, password: string, displayName?: string): Promise<void>` in `src/auth/users.ts` (INSERT … ON CONFLICT (email) DO UPDATE SET password_hash).
- CLI: `node dist/cli.js set-password <email> <password> [display name]` → prints `ok <email>`; exit 2 on bad args.

- [ ] **Step 1: Write the failing tests**

```ts
test('hash has the documented shape and verifies', async () => {
  const h = await hashPassword('correct horse');
  expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
  expect(h.split('$')).toHaveLength(6);
  expect(await verifyPassword('correct horse', h)).toBe(true);
  expect(await verifyPassword('wrong', h)).toBe(false);
});
test('two hashes of the same password differ (random salt)', async () => {
  expect(await hashPassword('x')).not.toEqual(await hashPassword('x'));
});
test('malformed stored hash verifies false', async () => {
  expect(await verifyPassword('x', 'garbage')).toBe(false);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `crypto.scrypt` (`maxmem` raised to 64 MiB for N=32768). **Step 4: Run** — PASS.
- [ ] **Step 5: Implement `src/cli.ts`** (loads config, `applySchema`, `upsertUser`, exits).
- [ ] **Step 6: `npx tsc --noEmit`** clean. **Commit** `feat(attorney-crm): scrypt passwords and set-password CLI`

---

### Task 4: Sessions, login rate limit, auth middleware

**Files:**
- Create: `attorney_crm/src/auth/session.ts`, `attorney_crm/src/auth/rate-limit.ts`, `attorney_crm/src/auth/middleware.ts`
- Test: `attorney_crm/src/__tests__/session.test.ts`, `attorney_crm/src/__tests__/rate-limit.test.ts`

**Interfaces:**
- Produces (session.ts): `createSession(pool, userId: number, now?: Date): Promise<string>` returns the cookie value; `resolveSession(pool, cookieValue: string | undefined, now?: Date): Promise<{ id: number; email: string; displayName: string } | null>` (deletes the row and returns null when expired); `destroySession(pool, cookieValue: string): Promise<void>`; `COOKIE_NAME = 'acrm_session'`; `cookieOptions(): express.CookieOptions` (httpOnly, secure, sameSite 'lax', path '/', maxAge 30 days).
- Produces (rate-limit.ts): `class LoginRateLimit { constructor(limit = 10, windowMs = 15*60*1000); isBlocked(email: string, now?: number): boolean; recordFailure(email: string, now?: number): void; reset(email: string): void }`.
- Produces (middleware.ts): `requireLogin(pool)` Express middleware setting `res.locals.user`, redirecting to `/login` otherwise; `attachUser(pool)` (same lookup, no redirect, for `/login`).

- [ ] **Step 1: Write the failing tests** — session: with a fake pool, `createSession` inserts `sha256(value)` not the value; `resolveSession` on an expired row calls DELETE and returns null (Review Focus 5); `resolveSession(undefined)` returns null without querying. rate-limit: 10 failures within the window block the 11th check; the 10 failures spread beyond 15 min do not; `reset` unblocks.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(attorney-crm): cookie sessions, login rate limit, auth middleware`

---

### Task 5: Views: layout, escaping, login page, static assets

**Files:**
- Create: `attorney_crm/src/views/html.ts`, `attorney_crm/src/views/layout.ts`, `attorney_crm/src/views/login.ts`
- Create: `attorney_crm/static/app.css`, copy `lexwebapp/public/logo-white.png` → `attorney_crm/static/logo-white.png`, `lexwebapp/public/favicon.svg` → `attorney_crm/static/favicon.svg`
- Test: `attorney_crm/src/__tests__/html.test.ts`

**Interfaces:**
- Produces: tagged template `html\`…\`` that escapes interpolations (`& < > " '`) unless wrapped in `raw(s)`; arrays are joined; `null/undefined` render as ''. `renderPage({ title, user, active, body }): string` wraps in the layout: header bar `#232F3C` with the logo (`/static/logo-white.png`, alt «legal.org.ua»), nav links «Сьогодні» (`/`), «Адвокати» (`/advocates`), user e-mail and «Вийти» (POST `/logout`); fonts Inter + Crimson Pro from Google Fonts; palette `#FAFAFA / #18181B / #71717A / #E4E4E7`.
- Produces: `renderLogin({ error?: string }): string` — form POST `/login` with `email`, `password`, button «Увійти», title «Вхід для менеджерів».

- [ ] **Step 1: Write the failing test**

```ts
test('escapes interpolations, keeps raw(), joins arrays', () => {
  expect(html`<b>${'<i>&"\''}</b>`).toBe('<b>&lt;i&gt;&amp;&quot;&#39;</b>');
  expect(html`${raw('<i>')}`).toBe('<i>');
  expect(html`${[1, 2].map(n => html`<li>${n}</li>`)}`).toBe('<li>1</li><li>2</li>');
  expect(html`${null}${undefined}`).toBe('');
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `html`, `raw`, `renderPage`, `renderLogin`, write `app.css`** (table styles: sticky header, zebra rows, `.chip` filled for derived kinds, `.chip--manual` outlined for manual tags, `.overdue` red text). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(attorney-crm): HTML layer, layout, login page, brand assets`

---

### Task 6: Advocate query builder and repository

**Files:**
- Create: `attorney_crm/src/practices.ts` (export `NAAU_PRACTICES: readonly string[]` — the 59 strings from the spec, in that order; `JUSTICE_KINDS: Record<number,string>` = {1:'Цивільне',2:'Кримінальне',3:'Господарське',4:'Адміністративне',5:'Адмінправопорушення'})
- Create: `attorney_crm/src/advocates/registry-sql.ts` (the select expressions and `ACTIVE_WHERE = "a.status <> 'TRUE'"` copied from `mcp_backend/src/api/tools/registry-catalog.ts` lawyers registry, aliased `a`)
- Create: `attorney_crm/src/advocates/query.ts`, `attorney_crm/src/advocates/repo.ts`
- Test: `attorney_crm/src/__tests__/advocate-query.test.ts`

**Interfaces:**
- Produces: `type AdvocateFilters = { surnamePrefix?: string; city?: string; region?: string; justiceKind?: number; manualPractice?: string; stage?: string; sort?: 'surname'|'city'|'region'|'cases'|'last_contact'|'next_contact'; dir?: 'asc'|'desc'; page?: number }`.
- Produces: `buildAdvocateListQuery(f: AdvocateFilters): { sql: string; countSql: string; params: unknown[] }` — FROM `opendata_advocates a LEFT JOIN attorney_crm_leads l ON l.advocate_source_id = a.source_id LEFT JOIN LATERAL (SELECT max(created_at) last_contact FROM attorney_crm_notes n WHERE n.advocate_source_id = a.source_id) nt ON true LEFT JOIN LATERAL (SELECT coalesce(sum(cases),0) cases FROM attorney_crm_practice_stats s WHERE s.advocate_source_id = a.source_id AND ($k::int IS NULL OR s.justice_kind = $k)) ps ON true`, WHERE `ACTIVE_WHERE` + filters; `surnamePrefix` → `a.family_name ILIKE $n` with `escapeLike(prefix) + '%'` (Review Focus 1); `justiceKind` also requires `ps.cases > 0`; `manualPractice` → `$n = ANY(l.manual_practices)`; `stage='new'` → `(l.stage IS NULL OR l.stage='new')`; `LIMIT 50 OFFSET (page-1)*50`; sort `cases` orders `ps.cases DESC NULLS LAST` then surname.
- Produces: `escapeLike(s: string): string` (backslash-escapes `\ % _`).
- Produces (repo.ts): `listAdvocates(pool, f): Promise<{ rows: AdvocateRow[]; total: number; page: number }>`, `getAdvocate(pool, sourceId): Promise<AdvocateRow | null>` (same expressions, no active filter so a suspended advocate's page still opens with its status shown), `getPracticeProfile(pool, sourceId): Promise<{ kinds: {justiceKind:number; name:string; cases:number; firstYear:number|null; lastYear:number|null}[]; topCategories: {categoryCode:number; name:string; cases:number}[] }>` (joins `edrsr_cause_categories` for names, top 3 by cases), `listCities(pool): Promise<string[]>` and `listRegions(pool)` for the filter dropdowns (distinct non-empty values among active advocates, cached in memory for 1 h).

- [ ] **Step 1: Write the failing tests**

```ts
test('escapes LIKE wildcards in the surname prefix', () => {
  const q = buildAdvocateListQuery({ surnamePrefix: 'А%_\\' });
  expect(q.params).toContain('А\\%\\_\\\\%');
  expect(q.sql).toMatch(/a\.family_name ILIKE \$\d+/);
});
test('justice kind filter requires cases in that kind and sorts by it', () => {
  const q = buildAdvocateListQuery({ justiceKind: 2, sort: 'cases' });
  expect(q.sql).toContain('ps.cases > 0'); expect(q.sql).toContain('ORDER BY ps.cases DESC');
});
test('page 3 offsets by 100 and only active advocates are selected', () => {
  const q = buildAdvocateListQuery({ page: 3 });
  expect(q.sql).toContain('OFFSET 100'); expect(q.sql).toContain("a.status <> 'TRUE'");
});
test('NAAU_PRACTICES has 59 unique entries', () => {
  expect(new Set(NAAU_PRACTICES).size).toBe(59);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(attorney-crm): advocate list query builder and repository`

---

### Task 7: Advocates table page and routes; Express app factory; login/logout routes

**Files:**
- Create: `attorney_crm/src/views/advocates.ts`, `attorney_crm/src/routes/auth.ts`, `attorney_crm/src/routes/advocates.ts`, `attorney_crm/src/server.ts`, `attorney_crm/src/index.ts`
- Test: `attorney_crm/src/__tests__/server.test.ts` (uses `supertest`; add to devDependencies)

**Interfaces:**
- Produces: `createApp(deps: { pool: pg.Pool; config: Config; rateLimit: LoginRateLimit }): express.Express` — `express.urlencoded`, cookie parsing (hand-rolled `parseCookies(header)` in `src/auth/cookies.ts`, no extra dependency), `/static` served from `attorney_crm/static` with 1-day cache, `GET /healthz` → `{ ok: true }` (also `SELECT 1`), routes below, 404 page «Сторінку не знайдено».
- Routes: `GET /login`, `POST /login` (on success: `createSession`, set cookie, update `last_login_at`, `rateLimit.reset`, 302 `/`; on failure: `recordFailure`, re-render with «Невірний e-mail або пароль»; when blocked: 429), `POST /logout` (destroy, clear cookie, 302 `/login`), `GET /advocates` (query → `AdvocateFilters`, render table), `GET /` placeholder until Task 9 renders Today (temporarily 302 `/advocates`).
- `renderAdvocatesPage({ rows, total, page, filters, cities, regions })`: filter form (surname prefix input, city `<select>`, region `<select>`, justice kind `<select>`, manual practice `<select>` of `NAAU_PRACTICES`, stage `<select>`), column headers as sort links, columns per spec, chips for derived kinds («Кримінальне · 120») and manual tags, pagination «← Попередня / Наступна →» with `Сторінка N з M (всього K)`.
- `src/index.ts`: `loadConfig(process.env)` → `createPool` → `applySchema` → `createApp` → `listen(port)`; starts the derivation worker (Task 10) after listen.

- [ ] **Step 1: Write the failing tests** (supertest against `createApp` with a fake pool that answers the queries the routes make):
  - `GET /advocates` without cookie → 302 to `/login`.
  - `POST /login` with wrong password → 200 containing «Невірний e-mail або пароль»; after 10 failures → 429 containing «Забагато спроб».
  - `GET /healthz` → 200 `{ ok: true }` without a session.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(attorney-crm): express app, login/logout, advocates table`

---

### Task 8: Advocate page: profile, manual tags, stage, notes

**Files:**
- Create: `attorney_crm/src/leads/repo.ts`, `attorney_crm/src/views/advocate.ts`, `attorney_crm/src/routes/advocate.ts`
- Modify: `attorney_crm/src/server.ts` (mount)
- Test: `attorney_crm/src/__tests__/leads.test.ts`, extend `server.test.ts`

**Interfaces:**
- Produces (leads/repo.ts): `getLead(pool, sourceId): Promise<Lead | null>`; `saveLead(pool, sourceId, patch: { stage?: Stage; nextContactAt?: Date | null; manualPractices?: string[] }, userId): Promise<Lead>` (INSERT … ON CONFLICT DO UPDATE, so a first save creates the row — Review Focus 2; throws `ValidationError` for unknown stage or practice); `addNote(pool, sourceId, userId, kind: NoteKind, body: string): Promise<Note>` (throws `ValidationError('Порожня нотатка')` when `body.trim() === ''` — Review Focus 3); `listNotes(pool, sourceId): Promise<NoteWithAuthor[]>` newest first.
- Routes: `GET /advocates/:sourceId` (404 page if unknown), `POST /advocates/:sourceId/lead` (fields `stage`, `next_contact_at` as `YYYY-MM-DD` or empty, `manual_practices[]`), `POST /advocates/:sourceId/notes` (fields `kind`, `body`); both redirect back to the advocate page, 400 with the message on `ValidationError`.
- `renderAdvocatePage({ advocate, profile, lead, notes, user })`: registry card (all fields incl. status badge), practice profile («Кримінальне: 120 справ, 2024–2026», top 3 categories), manual tags multi-select, stage select + next-contact date input + «Зберегти», note form (`kind` radio: Дзвінок / Лист / Зустріч / Інше; textarea; «Додати нотатку»), note list (author, date, kind, body).

- [ ] **Step 1: Write the failing tests** — `saveLead` sends an INSERT with ON CONFLICT (fake pool) and rejects `manualPractices: ['Космічне право']`; `addNote` rejects `'   '`; route `POST /advocates/1/notes` with a blank body → 400.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(attorney-crm): advocate page with practice profile, tags, stage and notes`

---

### Task 9: Today page

**Files:**
- Create: `attorney_crm/src/views/today.ts`, `attorney_crm/src/routes/today.ts`
- Modify: `attorney_crm/src/leads/repo.ts` (add `dueToday`, `recentNotes`), `attorney_crm/src/server.ts`
- Test: extend `leads.test.ts`

**Interfaces:**
- Produces: `dueToday(pool, now: Date, tz = 'Europe/Kyiv'): Promise<DueRow[]>` — leads with `next_contact_at < end of today in tz` joined to the advocate's name, city, phone, stage, last note; ordered `next_contact_at ASC` so overdue come first (Review Focus 4); `recentNotes(pool, limit = 30): Promise<NoteWithAdvocate[]>`.
- Route `GET /`: `renderTodayPage({ due, notes, user })` — two sections «Подзвонити сьогодні» (overdue rows carry class `overdue` and the label «прострочено») and «Нові нотатки».

- [ ] **Step 1: Write the failing test** — `dueToday` SQL uses `next_contact_at <` an end-of-day bound and `ORDER BY next_contact_at ASC`; the view marks a row dated yesterday with «прострочено».
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(attorney-crm): today page`

---

### Task 10: Daily derivation worker

**Files:**
- Create: `attorney_crm/src/worker/practice-derivation.ts`
- Modify: `attorney_crm/src/index.ts`
- Test: `attorney_crm/src/__tests__/worker.test.ts`

**Interfaces:**
- Produces: `runDerivation(pool, opts: { years: number[]; batch: number; lagDays: number; pauseMs: number; log: (s: string) => void }): Promise<{ docs: number; hits: number }>` — `SELECT attorney_crm_refresh_stems()`, then for each year loops `SELECT * FROM attorney_crm_derive_batch($1,$2,$3)` with `SET LOCAL statement_timeout = '180s'` until `out_docs = 0`, pausing `pauseMs` between batches, then `REFRESH MATERIALIZED VIEW CONCURRENTLY attorney_crm_practice_stats`. `years` default = 2024 … current year.
- Produces: `scheduleDerivation(pool, config, log)` — runs once 60 s after boot, then every 24 h; skips a run if the previous one is still going; never throws out of the timer (logs instead). Disabled when `ATTORNEY_CRM_DERIVATION=off`.

- [ ] **Step 1: Write the failing test** — with a fake pool returning `out_docs: 2000` twice then `0`, `runDerivation` calls the batch function 3 times for one year and refreshes the view once; a batch error is logged and the year is abandoned without throwing.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(attorney-crm): daily ЄДРСР practice derivation worker`

---

### Task 11: Docker image, compose service, nginx, CI wiring

**Files:**
- Create: `deployment/Dockerfile.attorney-crm` (two-stage like `deployment/Dockerfile.opendata-sync`, but `npm ci` with the lockfile; copies `attorney_crm/sql` and `attorney_crm/static` into the runtime image; `EXPOSE 3020`; `CMD ["node","dist/index.js"]`)
- Modify: `deployment/docker-compose.local.yml` — add `attorney-crm-local` after `terminal-service-local`: build context `..`, dockerfile above, image `attorney-crm:latest`, container_name `attorney-crm-local`, `restart: unless-stopped`, network `secondlayer-local`, env `PORT=3020`, `DATABASE_URL=postgresql://${POSTGRES_USER:-secondlayer}:${POSTGRES_PASSWORD:-local_dev_password}@postgres-local:5432/${POSTGRES_DB:-secondlayer_local}`, `ATTORNEY_CRM_SESSION_SECRET=${ATTORNEY_CRM_SESSION_SECRET:?set in .env.local}`, `NODE_ENV=production`; `depends_on: postgres-local: condition: service_healthy`; healthcheck `wget --spider http://127.0.0.1:3020/healthz`; limits cpus 1.0, memory 512M.
- Modify: `deployment/nginx/conf.d/aws-migrated.conf` — add a `server` block for `attorney.legal.org.ua` modelled on the `agents.legal.org.ua` block (lines 134–162): `set $attorney_upstream http://attorney-crm-local:3020;`, no websocket headers needed, `proxy_read_timeout 60s`; add the host to the port-80 → https redirect block if that file keeps one per host.
- Modify: `.github/actions/detect-changes/action.yml` — `attorney_crm/*) ATTORNEY_CRM=true ;;` and `deployment/Dockerfile.attorney-crm) ATTORNEY_CRM=true; DEPLOYMENT=true ;;` (placed before the generic `deployment/*)` case); BUILD_LIST/DEPLOY_LIST entries `"attorney-crm"`; output `attorney_crm=$ATTORNEY_CRM`.
- Modify: `.github/workflows/ci-local-deploy.yml` — in `build-and-test`, after «Build platform»: step «Build and test attorney CRM» `if: needs.detect-changes.outputs.attorney_crm == 'true'` running `cd attorney_crm && npm ci --no-audit --no-fund && npm run build && npx jest --forceExit`; pass the new output through the `detect-changes` job outputs like `platform`.
- Test: `docker build -f deployment/Dockerfile.attorney-crm -t attorney-crm:test .` locally (or on cthulhu via the `local-build` runner is not available here — build locally); `docker compose -f deployment/docker-compose.local.yml --env-file deployment/.env.example config --services | grep attorney-crm-local`; nginx validation per `deployment/nginx/README.md` (`nginx -t` in a throwaway `nginx:alpine` with the patched conf.d).

- [ ] **Step 1: Write the Dockerfile, compose entry, nginx block, CI changes.**
- [ ] **Step 2: Verify** — docker build succeeds; compose `config` lists the service; `nginx -t` passes; re-read `action.yml` to confirm the `attorney_crm/*` case sits before the generic `deployment/*` case and the output is wired through the workflow.
- [ ] **Step 3: Commit** `feat(attorney-crm): image, compose service, nginx host, CI wiring`

---

### Task 12: Secret, deploy, seed users, verify on prod

**Files:** none in git.

- [ ] **Step 1:** On cthulhu add `ATTORNEY_CRM_SESSION_SECRET=<openssl rand -base64 48>` to `~/SecondLayer/deployment/.env.local` (append, chmod unchanged). Note in memory that it exists.
- [ ] **Step 2:** Push `feat/attorney-crm`, open the PR, wait for checks, merge (`gh pr merge --squash --admin`), watch `ci-local-deploy.yml`.
- [ ] **Step 3:** After deploy: `docker ps` shows `attorney-crm-local` healthy; `docker logs attorney-crm-local` shows schema applied; `curl -sI https://attorney.legal.org.ua/` → 302 to `/login`.
- [ ] **Step 4:** Generate two passwords (`openssl rand -base64 18` each), run `docker exec attorney-crm-local node dist/cli.js set-password vladimir@legal.org.ua '<pw1>' 'Володимир'` and the same for `igor@legal.org.ua` 'Ігор'. Print both passwords in chat once.
- [ ] **Step 5:** Log in through the browser (claude-in-chrome): Today page empty, Advocates table shows 53.6K total, filter «Кримінальне» sorts by cases, open an advocate, add a note, set next contact = today, confirm it appears on Today.
- [ ] **Step 6:** Update memory `project_attorney_crm.md` with the live state.
