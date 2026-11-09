# Attorney CRM Poland (attorney.lawrider.pl) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a second, English, lawrider-branded tenant of the attorney CRM at attorney.lawrider.pl over a `pl_lawyers` table filled by a polite collector from the Polish bar registers and the KIRP directory.

**Architecture:** `attorney_crm/` becomes tenant-aware: a `Tenant` object (brand, strings, timezone, registry SQL adapter, practice taxonomy, feature flags) is chosen by `ATTORNEY_CRM_TENANT` and threaded through config, repos, routes and views; the `ua` tenant reproduces today's output byte for byte. The collector is a second entrypoint in the same image, run as a long-lived service in the `lawrider` compose stack next to the CRM container, egressing through a `pl-egress` SSH sidecar to a Warsaw VM. Ingress is a new hostname on the existing Cloudflare tunnel.

**Tech Stack:** Node 20, TypeScript, Express 4, pg, jest + ts-jest + supertest (existing); Node 20 built-in `fetch` + `undici` `ProxyAgent` for the collector; Postgres 15 (`pg-lawrider`); docker compose; Cloudflare API; gcloud.

**Spec:** `docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md` (and its predecessor `docs/superpowers/specs/2026-11-07-attorney-crm-design.md`).

## Global Constraints

- `ATTORNEY_CRM_TENANT` defaults to `ua`; with it unset every existing test passes unchanged and the UA HTML is identical.
- English UI strings for `pl`; Polish proper names and register wording shown as in the source. Ukrainian strings for `ua` unchanged.
- Collector: `Crawl-delay` 10 s on rejestradwokatow.pl, 1 s on rejestrradcow.pl, 2 s on szukajradcy.pl; never `/search` on szukajradcy.pl, never the search forms; User-Agent `lawrider.pl attorney-crm collector (+https://lawrider.pl; vladimir@lawrider.pl)`; stop after 5 consecutive failures; exponential back-off on 429/5xx.
- Collector writes only `public.pl_lawyers` and `public.pl_lawyers_crawl`; never `attorney_crm_*`.
- CRM tables for `pl` live in schema `attorney_crm_pl` (`search_path=attorney_crm_pl,public`); `pl_lawyers` is always addressed as `public.pl_lawyers`.
- Image tag `attorney-crm-pl:latest`; compose project `lawrider`; `ATTORNEY_CRM_SESSION_SECRET` read with `:-` (never `:?`).
- Lead keys: `attorney_crm_leads.advocate_source_id = pl_lawyers.lawyer_id` (`adw:<id>` | `radca:<entry number>`).
- No changes to the UA deployment files other than those forced by the shared code (`attorney_crm/**`).

## Review Focus

1. A radca without any contact (41K of them) opens and lists cleanly: the Contacts cell shows "No public contact", the Today page still lists the lead if a date was set. (Task 4 test `renders "No public contact" when phone and email are null`.)
2. `do_not_contact` sticks: the Today query excludes the lead even when `next_contact_at` is overdue, and the list row shows the badge. (Task 5 tests.)
3. A collector re-run never downgrades a row: a profile fetch that fails to parse a phone leaves the existing phone untouched (`COALESCE(EXCLUDED.phone, pl_lawyers.phone)` only for fields the parser reports as unknown, never clearing). (Task 8 test `upsert keeps the old phone when the new fetch has none`.)
4. Entry numbers with inconsistent spacing or case between the register (`WR-4293`) and the directory (`Numer uprawnień: WA-17979`, sometimes `wa 17979`) still join. (Task 7 test `normaliseEntryNumber`.)
5. Starting the `pl` container against an empty database creates the schema, applies only 002 and 004 plus the `pl_lawyers` DDL, and never touches `edrsr_*`. (Task 6 test `pl tenant applies 002, 004 and pl_001 only`.)

---

## File structure

```
attorney_crm/src/tenant/types.ts        Tenant, Strings, RegistryAdapter interfaces
attorney_crm/src/tenant/ua.ts           the Ukrainian tenant (today's values)
attorney_crm/src/tenant/pl.ts           the Polish tenant
attorney_crm/src/tenant/index.ts        loadTenant(env), setTenant/tenant()
attorney_crm/src/i18n/uk.ts, en.ts      Strings dictionaries
attorney_crm/src/tenant/pl-practices.ts 27 NRA codes, EN/PL labels, szukajradcy tag map
attorney_crm/src/advocates/registry-sql.ts   UA adapter (existing constants, wrapped)
attorney_crm/src/advocates/registry-pl.ts    PL adapter over public.pl_lawyers
attorney_crm/src/advocates/query.ts, repo.ts  take the adapter from tenant()
attorney_crm/src/leads/repo.ts          overrides, do_not_contact, tenant tz, registry joins via adapter
attorney_crm/sql/004_contact_overrides.sql
attorney_crm/sql/pl/001_pl_lawyers.sql  (applied for the pl tenant only)
attorney_crm/src/collector/http.ts      fetchText with proxy, UA, per-host delay, back-off, failure counter
attorney_crm/src/collector/normalise.ts normaliseEntryNumber, normalisePhone, statusFromRaw
attorney_crm/src/collector/parse-adwokaci.ts, parse-radcowie.ts, parse-szukajradcy.ts
attorney_crm/src/collector/store.ts     upsertLawyers, cursor get/set, markUnseen
attorney_crm/src/collector/jobs.ts      adwokaciList, adwokaciDetails, radcowieList, szukajradcy, probe
attorney_crm/src/collector/cli.ts       `node dist/collector/cli.js daemon | once <job> [--no-proxy]`
attorney_crm/src/__tests__/fixtures/pl/ the 8 recon files (moved from scripts/pl-lawyers/fixtures)
attorney_crm/static/logo-lawrider.png   copy of deployment/lawrider/site/apple-touch-icon.png
deployment/lawrider-cthulhu/docker-compose.yml   + attorney-crm-pl, attorney-crm-pl-collector, pl-egress
deployment/lawrider-cthulhu/nginx/edge.conf      + attorney.lawrider.pl block
deployment/lawrider-cthulhu/README.md            + CRM section
.github/workflows/deploy-lawrider-cthulhu.yml    + paths, build, health
```

---

### Task 1: Tenant and strings modules

**Files:**
- Create: `attorney_crm/src/tenant/types.ts`, `attorney_crm/src/tenant/ua.ts`, `attorney_crm/src/tenant/index.ts`, `attorney_crm/src/i18n/uk.ts`, `attorney_crm/src/i18n/en.ts`
- Modify: `attorney_crm/src/config.ts`
- Test: `attorney_crm/src/__tests__/tenant.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Strings { /* every user-visible string, keyed; see Step 3 */ }
  export interface RegistryAdapter {
    table: string;                 // 'opendata_advocates a' | 'public.pl_lawyers a'
    idColumn: string;              // 'a.source_id' | 'a.lawyer_id'
    select: string;                // columns aliased to the AdvocateRow raw names
    activeWhere: string;
    surnameColumn: string; firstNameColumn: string; patronymicColumn: string | null;
    citySql: string; regionSql: string;            // region = oblast (ua) | chamber (pl)
    professionSql: string | null;                  // pl: 'a.profession'
    declaredPracticesSql: string | null;           // pl: 'a.practices'
    phoneSqlForToday: string; citySqlForToday: string;
  }
  export interface Tenant {
    id: 'ua' | 'pl'; lang: 'uk' | 'en'; timeZone: string; locale: string;   // 'uk-UA' | 'en-GB'
    brand: { name: string; domain: string; logo: string; tagline: string };  // logo = static file name
    strings: Strings; registry: RegistryAdapter;
    practices: readonly string[]; practiceLabel: (code: string) => string;
    derivedPractices: boolean; schema: string | null; sqlFiles: string[];   // basenames applied at boot
  }
  export function loadTenant(env: NodeJS.ProcessEnv): Tenant;   // 'ua' default; throws on unknown value
  export function setTenant(t: Tenant): void; export function tenant(): Tenant;
  ```
- `Config` gains `tenant: Tenant` (from `loadTenant(env)`).

- [ ] **Step 1: Write the failing test**

```ts
import { loadTenant } from '../tenant';
test('default tenant is ua with Ukrainian strings and Kyiv time', () => {
  const t = loadTenant({});
  expect(t.id).toBe('ua'); expect(t.timeZone).toBe('Europe/Kyiv');
  expect(t.strings.nav.today).toBe('Сьогодні'); expect(t.brand.domain).toBe('legal.org.ua');
  expect(t.derivedPractices).toBe(true); expect(t.schema).toBeNull();
  expect(t.sqlFiles).toEqual(['001_practice_derivation.sql', '002_crm_core.sql', '003_ctid_backfill.sql', '004_contact_overrides.sql']);
});
test('unknown tenant fails fast', () => { expect(() => loadTenant({ ATTORNEY_CRM_TENANT: 'de' })).toThrow(/ATTORNEY_CRM_TENANT/); });
```

- [ ] **Step 2: Run it** — `cd attorney_crm && npx jest src/__tests__/tenant.test.ts` — Expected: FAIL, cannot find module `../tenant`.

- [ ] **Step 3: Implement.** `Strings` keys (one object, nested): `nav {today, advocates, logout}`, `login {title, heading, email, password, submit, badCredentials, blocked}`, `list {title, countSuffix, surnameStartsWith, surnamePlaceholder, city, region, all, derivedPractice, manualPractice, declaredPractice, profession, stage, show, reset, contacts, noContact, orgColumn, certColumn, practicesColumn, casesColumn, casesFor(name), stageColumn, nextContact, lastContact, contactWord, empty, prev, next, pageOf(page,pages,total)}`, `detail {back, registrySection, phone, email, address, cityRegion, org, council, certificate, decision, authority, status, registryId, from, practiceSection, noMentions, topCategories, declaredSection, declaredNone, otherTags, profileLink, directoryLink, leadSection, stageField, nextContactField, overdue, manualTags, save, notesSection, noteBody, addNote, noNotes, doNotContact, doNotContactReason, phoneOverride, emailOverride, manualMark, notFoundTitle, notFoundBody(id)}`, `today {title, callToday, nothingDue, date, name, city, phone, stage, lastNote, newNotes, noNotes, overdue}`, `stages: Record<Stage,string>`, `noteKinds: Record<NoteKind,string>`, `status: Record<string,string>` (ua: active/suspended/terminated; pl: active/inactive/former), `profession: Record<string,string>` (pl: adwokat → 'Adwokat', radca → 'Radca prawny'), `errors {notFound, serverError, serverErrorBody, unknownStage(s), unknownPractice(p), unknownNoteKind(k), emptyNote}`, `brandTagline`. `uk.ts` carries exactly the current literals from `views/*.ts`, `routes/auth.ts`, `leads/repo.ts`, `server.ts` (copy them, do not rephrase). `en.ts` is the English set. `ua.ts` builds the tenant from `uk`, the existing `registry-sql.ts` constants (wrapped into the adapter in Task 3; here `registry` may import the constants directly), `NAAU_PRACTICES`, `derivedPractices: true`, `schema: null`, `sqlFiles` as in the test. `index.ts`: `loadTenant` reads `ATTORNEY_CRM_TENANT` (`'ua'` default, `'pl'` resolved lazily in Task 4 by a registry map, unknown → throw `ATTORNEY_CRM_TENANT must be ua or pl, got "<v>"`), plus a module-level `let current: Tenant` with `setTenant`/`tenant()` (`tenant()` falls back to `loadTenant({})` when unset so existing tests run as ua). `config.ts`: `tenant: loadTenant(env)`.

- [ ] **Step 4: Run** `npx jest` — Expected: tenant tests PASS, all 69 existing tests PASS.
- [ ] **Step 5: Commit** `feat(attorney_crm): tenant and strings modules (ua unchanged)`.

### Task 2: Views and routes read strings, brand and timezone from the tenant

**Files:**
- Modify: `attorney_crm/src/views/layout.ts`, `advocates.ts`, `advocate.ts`, `today.ts`, `login.ts`, `attorney_crm/src/routes/auth.ts`, `advocate.ts`, `attorney_crm/src/server.ts`, `attorney_crm/src/leads/repo.ts` (messages + `endOfKyivDay` → `endOfLocalDay(tz)`), `attorney_crm/src/advocates/repo.ts` (`Вид ${k}` fallback via strings)
- Test: `attorney_crm/src/__tests__/views-tenant.test.ts`; existing `server.test.ts`, `html.test.ts`, `leads.test.ts` are the UA pin.

**Interfaces:**
- Consumes: `tenant()` from Task 1.
- Produces: `fmtDate(d, tz = tenant().timeZone, locale = tenant().locale)`, `isOverdue(d, now, tz = tenant().timeZone)`, `endOfLocalDay(now, tz)`, `parseLocalDate(s, tz)` (renamed from `parseKyivDate`; keep `parseKyivDate` as an alias export so its test still passes), `renderPage` uses `tenant().brand` and `<html lang="${tenant().lang}">`.

- [ ] **Step 1: Write the failing test**

```ts
import { setTenant, loadTenant } from '../tenant';
import { renderLogin } from '../views/login';
import { renderPage } from '../views/layout';
import { html } from '../views/html';
import { endOfLocalDay } from '../leads/repo';
afterEach(() => setTenant(loadTenant({})));
test('ua layout is unchanged', () => {
  const page = renderPage({ title: 'T', body: html`<p>x</p>` });
  expect(page).toContain('<html lang="uk">'); expect(page).toContain('CRM адвокатів'); expect(page).toContain('Сьогодні');
});
test('en strings flow through login when the tenant is English', () => {
  setTenant({ ...loadTenant({}), lang: 'en', strings: require('../i18n/en').en, brand: { name: 'lawrider', domain: 'lawrider.pl', logo: 'logo-lawrider.png', tagline: 'Lawyer CRM' } });
  const page = renderLogin({});
  expect(page).toContain('<html lang="en">'); expect(page).toContain('Sign in'); expect(page).not.toMatch(/[А-Яа-яІіЇїЄє]/);
});
test('endOfLocalDay respects the timezone', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  expect(endOfLocalDay(now, 'Europe/Kyiv').toISOString()).toBe('2026-11-08T22:00:00.000Z');
  expect(endOfLocalDay(now, 'Europe/Warsaw').toISOString()).toBe('2026-11-08T23:00:00.000Z');
});
```

- [ ] **Step 2: Run** `npx jest src/__tests__/views-tenant.test.ts` — Expected: FAIL (`endOfLocalDay` not exported; English text absent).
- [ ] **Step 3: Implement.** Replace every literal in the listed files with `tenant().strings.<key>`; `fmtDate/fmtDateTime/isOverdue/dateInput/parseLocalDate/endOfLocalDay` take the tenant timezone and locale; `dueToday(pool, now, tz = tenant().timeZone)`. `ValidationError` messages come from `strings.errors`. Keep the UA literals in `uk.ts` only.
- [ ] **Step 4: Run** `npx jest` — Expected: all PASS, including the untouched `server.test.ts` assertions on Ukrainian text.
- [ ] **Step 5: Commit** `refactor(attorney_crm): views and routes read strings, brand and timezone from the tenant`.

### Task 3: Registry adapter behind query, repo and leads

**Files:**
- Modify: `attorney_crm/src/advocates/registry-sql.ts` (export `UA_REGISTRY: RegistryAdapter` built from the existing constants), `query.ts`, `repo.ts`, `leads/repo.ts`
- Test: existing `advocate-query.test.ts`, `advocate-repo.test.ts`, `leads.test.ts` must pass unchanged; add to `advocate-query.test.ts`:

- [ ] **Step 1: Write the failing test**

```ts
import { buildAdvocateListQuery } from '../advocates/query';
test('the query is built from the adapter, not from hard-coded table names', () => {
  const adapter = { ...UA_REGISTRY, table: 'public.pl_lawyers a', idColumn: 'a.lawyer_id', activeWhere: "a.status = 'active'", surnameColumn: 'a.surname' };
  const q = buildAdvocateListQuery({}, adapter);
  expect(q.sql).toContain('FROM public.pl_lawyers a'); expect(q.sql).toContain("a.status = 'active'");
  expect(q.sql).toContain('ON l.advocate_source_id = a.lawyer_id'); expect(q.sql).not.toContain('opendata_advocates');
});
```

- [ ] **Step 2: Run** — Expected: FAIL (second argument ignored / `UA_REGISTRY` missing).
- [ ] **Step 3: Implement.** `buildAdvocateListQuery(f, r: RegistryAdapter = tenant().registry)`: `FROM ${r.table}`, joins on `${r.idColumn}`, `ORDER BY ${r.surnameColumn}`…, `WHERE ${r.activeWhere}`, city/region via `r.citySql/r.regionSql`; when `r.declaredPracticesSql` is set, filter `manualPractice` becomes `($n = ANY(l.manual_practices) OR $n = ANY(${r.declaredPracticesSql}))`; when `!tenant().derivedPractices` the `ps` lateral and `kind_summary` are replaced by `0 AS kind_cases, NULL AS kind_summary` and the `justiceKind` filter is ignored. `repo.ts`: `getAdvocate`, `distinctValues`, `getPracticeProfile` (returns empty when `!derivedPractices`) use the adapter; `mapRow` also reads `profession`, `declared_practices` (text[]), `practice_tags_raw`, `profile_url`, `directory_url`, `entry_number`, `entry_date`, `chamber` into new optional `AdvocateRow` fields. `leads/repo.ts`: `dueToday`/`recentNotes` join `${r.table}` on `${r.idColumn}` and select `${r.surnameColumn} AS family_name`, etc., `r.phoneSqlForToday`, `r.citySqlForToday`.
- [ ] **Step 4: Run** `npx jest` — Expected: PASS (existing SQL-shape assertions still hold for ua).
- [ ] **Step 5: Commit** `refactor(attorney_crm): registry adapter behind the advocate queries`.

### Task 4: The Polish tenant: `pl_lawyers` DDL, adapter, taxonomy, views

**Files:**
- Create: `attorney_crm/sql/pl/001_pl_lawyers.sql`, `attorney_crm/src/advocates/registry-pl.ts`, `attorney_crm/src/tenant/pl-practices.ts`, `attorney_crm/src/tenant/pl.ts`, `attorney_crm/static/logo-lawrider.png` (copy of `deployment/lawrider/site/apple-touch-icon.png`)
- Modify: `attorney_crm/src/tenant/index.ts` (register `pl`), `views/advocates.ts`, `views/advocate.ts` (profession column, declared chips, "No public contact", no cases column when `!derivedPractices`, profile/directory links)
- Test: `attorney_crm/src/__tests__/tenant-pl.test.ts`

**Interfaces:**
- Produces: `PL_PRACTICES: { code: string; pl: string; en: string }[]` (27 entries, codes: `general, administrative, arbitration, mediation, civil, human_rights, construction, eu, commercial, companies, criminal, medical, real_estate, consumer, environment, banking, tax, labour, press, family, damages, inheritance, transport, social_security, restructuring, ip, public_procurement`), `PL_TAG_MAP: Record<string, string>` (szukajradcy tag → code; at least `cywilne→civil, pracy→labour, rodzinne i opiekuńcze→family, karne→criminal, administracyjne (w tym postępowanie)→administrative, zamówienia publiczne→public_procurement, podatkowe→tax, nieruchomości→real_estate, prawo spółek handlowych→companies, działalność gospodarcza→commercial, konsumenckie→consumer, własność intelektualna→ip, spadkowe→inheritance, odszkodowania→damages, ubezpieczenia społeczne→social_security, medyczne→medical, budowlane→construction, ochrony środowiska→environment, bankowe→banking, arbitraż i mediacje→arbitration, transport i logistyka→transport, upadłościowe i restrukturyzacyjne→restructuring, prasowe→press, europejskie→eu, prawa człowieka→human_rights`), `mapPracticeTag(tag): string | null`, `nraLabelToCode(label): string | null` (Polish NRA label → code, exact match after trim).
- `PL_REGISTRY: RegistryAdapter` with `table: 'public.pl_lawyers a'`, `idColumn: 'a.lawyer_id'`, `activeWhere: "a.status = 'active'"`, `regionSql: 'a.chamber'`, `professionSql: 'a.profession'`, `declaredPracticesSql: 'a.practices'`, select aliasing `surname AS family_name, given_names AS first_name, '' AS patronymic, status, email, COALESCE(phone || CASE WHEN phone2 IS NOT NULL THEN ', ' || phone2 ELSE '' END, phone2) AS phone, address AS work_address, city, chamber AS region, office_name AS org_forms, entry_number AS certificate_num, entry_date AS certificate_date, profession, practices AS declared_practices, practice_tags_raw, profile_url, directory_url`.
- DDL exactly the spec's `pl_lawyers` and `pl_lawyers_crawl` (`CREATE TABLE IF NOT EXISTS public.pl_lawyers …`, indexes on `(status, surname)`, `(city)`, `(chamber)`, GIN on `practices`).

- [ ] **Step 1: Write the failing test**

```ts
import { loadTenant, setTenant } from '../tenant';
import { renderAdvocatesPage } from '../views/advocates';
import { mapPracticeTag, PL_PRACTICES } from '../tenant/pl-practices';
const pl = loadTenant({ ATTORNEY_CRM_TENANT: 'pl' });
beforeEach(() => setTenant(pl)); afterEach(() => setTenant(loadTenant({})));
test('pl tenant basics', () => {
  expect(pl.lang).toBe('en'); expect(pl.timeZone).toBe('Europe/Warsaw'); expect(pl.schema).toBe('attorney_crm_pl');
  expect(pl.sqlFiles).toEqual(['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql']);
  expect(pl.derivedPractices).toBe(false); expect(PL_PRACTICES).toHaveLength(27);
  expect(mapPracticeTag('zamówienia publiczne')).toBe('public_procurement'); expect(mapPracticeTag('coś innego')).toBeNull();
});
test('renders "No public contact" when phone and email are null, and the profession column', () => {
  const row = { sourceId: 'radca:WR-4293', fullName: 'ABBATELLI Wioletta', familyName: 'ABBATELLI', firstName: 'Wioletta', patronymic: '', status: 'active', statusDescription: null, email: null, phone: null, workAddress: null, city: 'WROCŁAW', region: 'OIRP WROCŁAW', orgForms: null, raName: null, certificateNum: 'WR-4293', certificateDate: null, decisionNum: null, decisionDate: null, authorityName: null, stage: 'new', nextContactAt: null, manualPractices: [], lastContact: null, kindCases: 0, kinds: [], profession: 'radca', declaredPractices: ['civil'], practiceTagsRaw: ['cywilne'], profileUrl: null, directoryUrl: null, doNotContact: false, phoneOverride: null, emailOverride: null } as any;
  const page = renderAdvocatesPage({ rows: [row], total: 1, page: 1, pageSize: 50, filters: {}, cities: [], regions: [], user: { id: 1, email: 'x', displayName: '' } as any });
  expect(page).toContain('No public contact'); expect(page).toContain('Radca prawny'); expect(page).toContain('Civil law and procedure');
  expect(page).not.toContain('Справ'); expect(page).toContain('<html lang="en">');
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`pl` tenant unknown).
- [ ] **Step 3: Implement** the files above. In `views/advocates.ts`: profession `<th>` and `<td>` only when `registry.professionSql`; the cases column only when `derivedPractices`; `practiceChips` renders declared codes via `tenant().practiceLabel` with class `chip` and title `strings.list.declaredPractice`, manual as today; empty contacts → `<span class="muted">${strings.list.noContact}</span>`; filter select "Practice area" lists `tenant().practices` with labels (ua: the 59 names as both). In `views/advocate.ts`: when `!derivedPractices` the second card is "Declared practice areas" listing labels, then raw tags under "Other tags", then links "Register profile" / "Directory profile" when present; status label from `strings.status`.
- [ ] **Step 4: Run** `npx jest` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(attorney_crm): Polish tenant (pl_lawyers adapter, NRA taxonomy, English views)`.

### Task 5: Do-not-contact flag and manual contact overrides (both tenants)

**Files:**
- Create: `attorney_crm/sql/004_contact_overrides.sql`
- Modify: `attorney_crm/src/leads/repo.ts` (Lead fields, `saveLead` patch, `dueToday` excludes `do_not_contact`), `routes/advocate.ts` (form fields `do_not_contact`, `do_not_contact_reason`, `phone_override`, `email_override`), `views/advocate.ts` (toggle + inputs), `views/advocates.ts` (badge `chip chip--dnc`, override shown with `strings.detail.manualMark`), `advocates/query.ts` + `repo.ts` (select `l.do_not_contact, l.phone_override, l.email_override`; effective phone = `COALESCE(l.phone_override, <registry phone>)`)
- Test: `attorney_crm/src/__tests__/leads.test.ts` (add), `server.test.ts` (add)

- [ ] **Step 1: Write the failing tests**

```ts
test('saveLead stores do_not_contact and overrides', async () => {
  const pool = fakePool(); await saveLead(pool, 'adw:1', { doNotContact: true, doNotContactReason: 'asked by phone', phoneOverride: '+48 600 000 000', emailOverride: null }, 1);
  const ins = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_leads'))!;
  expect(ins.text).toContain('do_not_contact'); expect(ins.values).toEqual(expect.arrayContaining([true, 'asked by phone', '+48 600 000 000']));
});
test('dueToday excludes do-not-contact leads', async () => {
  const pool = fakePool(); await dueToday(pool, new Date());
  expect(pool.calls[0].text).toMatch(/NOT l\.do_not_contact/);
});
// server.test.ts
test('the list shows the DNC badge and the manual phone', async () => { /* fixture row with do_not_contact: true, phone_override: '+48 600 000 000', phone: '111' → expect "Do not contact"|"Не турбувати" badge, href="tel:+48600000000", not tel:111 */ });
```

- [ ] **Step 2: Run** — Expected: FAIL (unknown fields).
- [ ] **Step 3: Implement.** SQL: `ALTER TABLE attorney_crm_leads ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS do_not_contact_reason TEXT, ADD COLUMN IF NOT EXISTS phone_override TEXT, ADD COLUMN IF NOT EXISTS email_override TEXT;`. `LeadPatch` gains the four fields (`undefined` = keep, `null` = clear); upsert uses the same `CASE WHEN $flag` pattern as `next_contact_at`. `dueToday` adds `AND NOT l.do_not_contact`. UA strings: `Не турбувати`, `Причина`, `Телефон (ручний)`, `E-mail (ручний)`, `ручний`; EN: `Do not contact`, `Reason`, `Phone (manual)`, `E-mail (manual)`, `manual`.
- [ ] **Step 4: Run** `npx jest` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(attorney_crm): do-not-contact flag and manual contact overrides`.

### Task 6: Schema per tenant, search_path, startup

**Files:**
- Modify: `attorney_crm/src/schema.ts` (`applySchema(pool, sqlDir, files: string[])`, `CREATE SCHEMA IF NOT EXISTS` when `tenant().schema`), `attorney_crm/src/db.ts` (`createPool(url, schema?)` sets `options: '-c search_path=<schema>,public'`), `attorney_crm/src/index.ts` (derivation only if `tenant.derivedPractices`, `setTenant(config.tenant)` first), `attorney_crm/src/cli.ts` (same)
- Test: `attorney_crm/src/__tests__/schema.test.ts` (add)

- [ ] **Step 1: Write the failing test**

```ts
test('pl tenant applies 002, 004 and pl_001 only, inside the schema', async () => {
  const pool = fakePool(calls, new Map());
  const applied = await applySchema(pool, sqlDir, ['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql'], 'attorney_crm_pl');
  expect(applied).toEqual(['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql']);
  expect(calls[0].text).toBe('CREATE SCHEMA IF NOT EXISTS attorney_crm_pl');
  expect(calls.some((c) => c.text.includes('edrsr_'))).toBe(false);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (signature).
- [ ] **Step 3: Implement** (`files` relative to `sqlDir`, lexical order as given; existing callers pass `tenant().sqlFiles`; the schema-version table is created in the current `search_path`, so each tenant has its own). `createPool`: `new Pool({ …, options: schema ? \`-c search_path=${schema},public\` : undefined })`.
- [ ] **Step 4: Run** `npx jest` and `npx tsc --noEmit -p .` — Expected: PASS / no errors.
- [ ] **Step 5: Commit** `feat(attorney_crm): tenant schema list and search_path`.

### Task 7: Collector HTTP client, normalisers and parsers

**Files:**
- Create: `attorney_crm/src/collector/http.ts`, `normalise.ts`, `parse-adwokaci.ts`, `parse-radcowie.ts`, `parse-szukajradcy.ts`; move `scripts/pl-lawyers/fixtures/*` → `attorney_crm/src/__tests__/fixtures/pl/`
- Modify: `attorney_crm/package.json` (dependency `undici` ^6; dev `@types/node` already present), `attorney_crm/jest.config.cjs` only if fixtures need `testPathIgnorePatterns`
- Test: `attorney_crm/src/__tests__/collector-parse.test.ts`, `collector-http.test.ts`

**Interfaces (Produces):**
```ts
// http.ts
export interface FetchOptions { proxyUrl?: string | null; userAgent: string; minDelayMs: Record<string, number>; maxConsecutiveFailures: number; sleep?: (ms:number)=>Promise<void>; fetchImpl?: typeof fetch; now?: () => number }
export class Collector { constructor(o: FetchOptions); get(url: string): Promise<string>; post(url: string, form: Record<string,string>): Promise<string>; readonly failures: number; }
// throws CollectorStopped after maxConsecutiveFailures; 429/5xx → back-off 10s,20s,40s,80s,160s then counts as a failure; per-host spacing = minDelayMs[host]
// normalise.ts
export function normaliseEntryNumber(s: string | null | undefined): string | null;  // 'wa 17979' → 'WA-17979', 'WAW/Adw/4' → 'WAW/ADW/4', trims, upper-cases, collapses [ ._] to '-'
export function normalisePhone(s: string): string | null;     // digits + leading '+'; 9 digits → '+48' prefix; '' → null
export function statusFromRaw(profession: 'adwokat'|'radca', raw: string): 'active'|'inactive'|'former';
// parse-adwokaci.ts
export interface AdwokatListRow { id: string; slug: string; profileUrl: string; surname: string; givenNames: string; city: string | null; chamber: string | null; statusRaw: string }
export function parseAdwokaciList(html: string): { rows: AdwokatListRow[]; lastPage: number | null };
export interface AdwokatDetail { entryNumber: string | null; statusRaw: string; entryDate: string | null; officeName: string | null; address: string | null; postcode: string | null; city: string | null; phone: string | null; phone2: string | null; email: string | null; practices: string[] /* NRA labels as printed */ }
export function parseAdwokatDetail(html: string): AdwokatDetail;
// parse-radcowie.ts
export interface RadcaRow { surname: string; givenNames: string; entryNumber: string; chamber: string; city: string | null; statusRaw: string }
export function parseRadcowieFragment(html: string): RadcaRow[];   // the 15 `row data1|data2` blocks, desktop columns only
// parse-szukajradcy.ts
export function parseCityPage(html: string): string[];  // profile URLs
export interface DirectoryProfile { name: string; city: string | null; office: string | null; email: string | null; phone: string | null; address: string | null; website: string | null; entryNumber: string | null; tags: string[]; similar: string[] }
export function parseDirectoryProfile(html: string): DirectoryProfile;
```

- [ ] **Step 1: Write the failing tests** (fixtures read with `fs.readFileSync(path.join(__dirname, 'fixtures/pl', …))`)

```ts
test('adwokaci list page 1', () => { const r = parseAdwokaciList(fx('adwokaci-list-page1.html')); expect(r.rows).toHaveLength(100); expect(r.lastPage).toBe(352);
  expect(r.rows[0]).toMatchObject({ surname: 'Abłażewicz', givenNames: 'Agnieszka', city: 'Czechowice-Dziedzice', chamber: 'Katowice', statusRaw: 'Wykonujący zawód' }); expect(r.rows[0].profileUrl).toMatch(/^https:\/\/rejestradwokatow\.pl\/adwokat\/[a-z0-9-]+-\d+$/); expect(r.rows[0].id).toMatch(/^\d+$/); });
test('adwokat detail without practices', () => { const d = parseAdwokatDetail(fx('adwokat-kowalski-jakub-82891.html'));
  expect(d).toMatchObject({ entryNumber: 'RAD/Adw/211', statusRaw: 'Wykonujący zawód', entryDate: '2018-05-23', officeName: 'Kancelaria Adwokacka', postcode: '26-900', city: 'Kozienice', phone: '512-017-377', email: null, practices: [] }); expect(d.address).toContain('Warszawska 34'); });
test('adwokat detail with practices', () => { const d = parseAdwokatDetail(fx('adwokat-adamczyk-andrzej-42384.html'));
  expect(d.entryNumber).toBe('WAW/Adw/4'); expect(d.entryDate).toBe('1988-02-04'); expect(d.phone).toBe('601355341');
  expect(d.practices).toEqual(['Praktyka ogólna', 'Prawo i postępowanie cywilne', 'Prawo i postępowanie karne', 'Prawo rodzinne i opiekuńcze', 'Prawo spadkowe']); });
test('radcowie fragment', () => { const rows = parseRadcowieFragment(fx('radcowie-getdataw-stan1-page1.html')); expect(rows).toHaveLength(15);
  expect(rows[0]).toEqual({ surname: 'ABBATELLI', givenNames: 'WIOLETTA MARIOLA', entryNumber: 'WR-4293', chamber: 'OIRP WROCŁAW', city: 'WROCŁAW', statusRaw: 'Wykonuje zawód' }); });
test('szukajradcy city page and profile', () => { expect(parseCityPage(fx('szukajradcy-city-warszawa.html'))).toHaveLength(24);
  const p = parseDirectoryProfile(fx('szukajradcy-lawyer-adam-krukowski.html'));
  expect(p).toMatchObject({ name: 'Adam Krukowski', city: 'Katowice', email: 'kancelaria@krukowski.legal', phone: '+48223008640', entryNumber: 'WA-17979' });
  expect(p.tags).toContain('zamówienia publiczne'); expect(p.tags).toHaveLength(11); expect(p.similar.length).toBeGreaterThanOrEqual(1); });
test('normaliseEntryNumber', () => { expect(normaliseEntryNumber(' wa 17979 ')).toBe('WA-17979'); expect(normaliseEntryNumber('WR-4293')).toBe('WR-4293'); expect(normaliseEntryNumber('')).toBeNull(); });
test('normalisePhone', () => { expect(normalisePhone('512-017-377')).toBe('+48512017377'); expect(normalisePhone('48 362 57 40')).toBe('+48483625740'.replace('+4848', '+48')); expect(normalisePhone('tel:+48223008640')).toBe('+48223008640'); });
// collector-http.test.ts
test('spacing per host, back-off on 429, stop after 5 failures', async () => { /* fake fetchImpl + recorded sleep; two GETs to rejestradwokatow.pl → sleep ≥ 10000 between; a 429 then 200 → sleeps 10000 then succeeds; five 500s → rejects CollectorStopped */ });
test('ProxyAgent is used when proxyUrl is set', async () => { /* fetchImpl receives init.dispatcher instanceof ProxyAgent */ });
```

- [ ] **Step 2: Run** — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Parsers use regexes over the fixtures' markup (no HTML library): list rows = `<tr>` with 8 `<td>` and the `icon_link` anchor; detail blocks keyed by the labels `Status:`, `Data wpisu w aktualnej izbie na listę adwokatów:`, `Adres do korespondencji:`, `Komórkowy:`, `Stacjonarny:`, `Email:`, `PREFEROWANA PRAKTYKA` (stop at `Izba Adwokacka w`); `entryNumber` from `\(([A-Z]+/Adw/\d+)\)`; the postcode/city from `(\d{2}-\d{3})\s+(.+)`. Radcowie: each `row data1|data2` block's six desktop `col-sm-2` divs in order. szukajradcy: `href="https://szukajradcy.pl/lawyers/…"` set; profile labels `Miasto:`, `Pracuje w:`, `E-mail:`, `Adres:`, `Numer uprawnień:`, `Obszary praktyki:`; `tel:` href; "Podobni radcowie" anchors. `normalisePhone('48 362 57 40')` → digits `483625740` (9 digits) → `+48483625740`? No: a 9-digit number gets `+48`; `48 362 57 40` is 9 digits → `+48483625740` is wrong by eye but is what the rule says; keep the rule simple and documented (landline with area code 48 is Radom's prefix, genuinely 9 digits).
- [ ] **Step 4: Run** `npx jest` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(attorney_crm): collector http client and register parsers (fixtures from 08.11 recon)`.

### Task 8: Collector store, jobs, daemon and CLI

**Files:**
- Create: `attorney_crm/src/collector/store.ts`, `jobs.ts`, `cli.ts`
- Test: `attorney_crm/src/__tests__/collector-jobs.test.ts`

**Interfaces (Produces):**
```ts
// store.ts
export interface LawyerUpsert { lawyerId: string; profession: 'adwokat'|'radca'; surname: string; givenNames: string; status: 'active'|'inactive'|'former'; statusRaw: string; chamber?: string|null; city?: string|null; postcode?: string|null; address?: string|null; officeName?: string|null; phone?: string|null; phone2?: string|null; email?: string|null; website?: string|null; contactSource?: 'register'|'szukajradcy'|null; entryNumber?: string|null; entryDate?: string|null; practices?: string[]; practiceTagsRaw?: string[]; profileUrl?: string|null; directoryUrl?: string|null; detailFetched?: boolean; raw?: unknown }
export async function upsertLawyers(pool: Queryable, rows: LawyerUpsert[], seenAt: Date): Promise<number>;
// undefined field → keep existing value (COALESCE(EXCLUDED.x, t.x) with EXCLUDED.x = NULL); explicit null is never sent for contacts, so a crawl can never clear a phone
export async function getCursor(pool: Queryable, source: string): Promise<Record<string, unknown> | null>;
export async function setCursor(pool: Queryable, source: string, cursor: Record<string, unknown>): Promise<void>;
export async function markUnseen(pool: Queryable, profession: 'adwokat'|'radca', walkStartedAt: Date, newStatus: 'former'|'inactive'): Promise<number>;
export async function findByEntryNumber(pool: Queryable, entryNumber: string): Promise<string | null>;  // lawyer_id
export async function findUniqueByName(pool: Queryable, surname: string, givenNames: string, city: string | null): Promise<string | null>;
// jobs.ts
export interface JobDeps { pool: Queryable; http: Collector; log: (line: string) => void; now?: () => Date }
export async function probe(d: JobDeps): Promise<{ host: string; status: number; ms: number }[]>;      // one GET per host; throws if any status ≥ 400
export async function adwokaciList(d: JobDeps): Promise<{ pages: number; rows: number }>;              // cursor {page}; at the end markUnseen(adwokat → 'former') only when every page succeeded
export async function adwokaciDetails(d: JobDeps, o: { maxAgeDays: number; limit: number }): Promise<{ fetched: number }>;   // active first, then others; sets detail_fetched_at
export async function radcowieList(d: JobDeps): Promise<{ pages: number; rows: number }>;              // POST GetDataW stan=0; cursor {page}; markUnseen(radca → 'inactive') when complete
export async function szukajradcy(d: JobDeps): Promise<{ profiles: number; matched: number; unmatched: number }>;  // BFS from pages-sitemap city URLs; visited set persisted in cursor
export function daemon(d: JobDeps, schedule?: Partial<Schedule>): { stop: () => void };               // runs probe once, then: lists weekly (Sun 02:00 local), details loop continuously (batches of 200, sleep 60 s when nothing to do), szukajradcy monthly (1st, 03:00)
```
CLI: `node dist/collector/cli.js daemon` | `once probe|adwokaci-list|adwokaci-details|radcowie-list|szukajradcy [--no-proxy] [--limit N]`. Env: `DATABASE_URL`, `ATTORNEY_CRM_SCHEMA` (unused by the collector but harmless), `HTTPS_PROXY` (used unless `--no-proxy`), `COLLECTOR_UA` default per Global Constraints.

- [ ] **Step 1: Write the failing tests**

```ts
test('upsert keeps the old phone when the new fetch has none', async () => {
  const pool = fakePool(); await upsertLawyers(pool, [{ lawyerId: 'adw:1', profession: 'adwokat', surname: 'A', givenNames: 'B', status: 'active', statusRaw: 'Wykonujący zawód' }], new Date());
  const q = pool.calls[0]; expect(q.text).toMatch(/phone\s*=\s*COALESCE\(EXCLUDED\.phone,\s*public\.pl_lawyers\.phone\)/); expect(q.text).toContain('INSERT INTO public.pl_lawyers'); });
test('adwokaciList walks from the cursor and marks unseen only after a full walk', async () => { /* fake http returning fixture page for every page with lastPage 2; cursor starts at {page:2}; expect GET page 2 only, then markUnseen UPDATE issued; a failing page → no UPDATE */ });
test('szukajradcy matches by entry number and falls back to unique name', async () => { /* fake http: city page → one profile (fixture); findByEntryNumber → 'radca:WA-17979' → upsert with contactSource 'szukajradcy' and directoryUrl; second profile with unknown number and findUniqueByName null → counted unmatched */ });
test('probe throws on a 403', async () => { /* fake http 403 for rejestrradcow.pl → rejects with message containing 'rejestrradcow.pl 403' */ });
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Delays via the `Collector`'s per-host map: `rejestradwokatow.pl: 10000, rejestrradcow.pl: 1000, szukajradcy.pl: 2000`. `adwokaciDetails` maps NRA labels → codes with `nraLabelToCode`, keeps the labels in `practice_tags_raw`, `contactSource: 'register'` when a phone or e-mail was found. `szukajradcy`: seeds = city URLs from `pages-sitemap.xml` (fetched live; the fixture list is the test seed), BFS queue persisted every 50 profiles in the cursor `{queue, visited}`; a matched profile upserts phone/email/website/address/tags onto the matched `lawyer_id` with `contactSource: 'szukajradcy'` **only when the row has no register contact**; unmatched profiles are logged, not stored.
- [ ] **Step 4: Run** `npx jest` and `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(attorney_crm): collector jobs, store, daemon and CLI`.

### Task 9: Deployment files

**Files:**
- Modify: `deployment/lawrider-cthulhu/docker-compose.yml`, `deployment/lawrider-cthulhu/nginx/edge.conf`, `deployment/lawrider-cthulhu/README.md`, `.github/workflows/deploy-lawrider-cthulhu.yml`, `attorney_crm/README.md`
- Test: `docker compose -f deployment/lawrider-cthulhu/docker-compose.yml --env-file <(printf 'POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nPOSTGRES_DB=d\nLAWRIDER_TUNNEL_TOKEN=t\n') config` validates; `nginx -t` on the edge happens in CI.

- [ ] **Step 1: Compose.** Services:
  - `attorney-crm-pl`: `build: {context: ../.., dockerfile: deployment/Dockerfile.attorney-crm}`, `image: attorney-crm-pl:latest`, `container_name: attorney-crm-pl`, `restart: unless-stopped`, env `NODE_ENV=production`, `PORT=3020`, `TZ=Europe/Warsaw`, `ATTORNEY_CRM_TENANT=pl`, `ATTORNEY_CRM_SCHEMA=attorney_crm_pl`, `ATTORNEY_CRM_DERIVATION=off`, `DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@pg-lawrider:5432/${POSTGRES_DB}`, `ATTORNEY_CRM_SESSION_SECRET=${ATTORNEY_CRM_PL_SESSION_SECRET:-}`; `depends_on: postgres: service_healthy`; healthcheck as the UA service; limits 512M / 1 cpu; `networks: [lawrider]`.
  - `attorney-crm-pl-collector`: `image: attorney-crm-pl:latest` (no build), `command: ["node", "dist/collector/cli.js", "daemon"]`, same DB env, `HTTPS_PROXY=http://pl-egress:8118`, `NO_PROXY=pg-lawrider`, `depends_on: [attorney-crm-pl, pl-egress]`, limits 256M.
  - `pl-egress`: `image: alpine:3.20`, `command: sh -c "apk add --no-cache openssh-client autossh >/dev/null && exec autossh -M 0 -N -g -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -i /run/pl-egress.key -L 0.0.0.0:8118:127.0.0.1:8888 egress@${PL_PROXY_HOST:-127.0.0.1}"`, volume `${HOME}/lawrider/pl-egress.key:/run/pl-egress.key:ro`, limits 64M, healthcheck `nc -z 127.0.0.1 8118`.
- [ ] **Step 2: edge.conf.** Add a `server` block for `attorney.lawrider.pl` modelled on the `mcp.lawrider.pl` block: `set $attorney_pl attorney-crm-pl; proxy_pass http://$attorney_pl:3020;` with the same headers, `proxy_buffering on`, `client_max_body_size 1m`, and update the header comment list.
- [ ] **Step 3: Workflow.** `paths` += `attorney_crm/**`, `deployment/Dockerfile.attorney-crm`; "Build image" step also `build attorney-crm-pl`; health step waits for `attorney-crm-pl` healthy and probes `docker exec lawrider-edge wget -q -O /dev/null --header 'Host: attorney.lawrider.pl' http://127.0.0.1/healthz`; the collector is not a gate (`pl-egress` may be down before the VM exists).
- [ ] **Step 4: README.** lawrider-cthulhu README: new section "Polish attorney CRM" (what, how to seed users, how to run a collector job by hand, the `ATTORNEY_CRM_PL_SESSION_SECRET` / `PL_PROXY_HOST` keys and `~/lawrider/pl-egress.key` in "Box state"). `attorney_crm/README.md`: tenants and the collector.
- [ ] **Step 5: Verify** `docker compose … config` prints without error; `npx jest` still green.
- [ ] **Step 6: Commit** `feat(lawrider-cthulhu): attorney.lawrider.pl CRM, collector and Polish egress sidecar`.

### Task 10: Operations (run by the executor on the boxes, in this order; nothing here is code)

- [ ] **Step 1: GCP VM.** From the MacBook: `gcloud compute addresses create pl-proxy-ip --region europe-central2`; `gcloud compute instances create pl-proxy --zone europe-central2-a --machine-type e2-micro --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 10GB --address pl-proxy-ip --metadata-from-file ssh-keys=<file with "egress:<pubkey>">` where the key pair is generated on cthulhu as `~/lawrider/pl-egress.key` (`ssh-keygen -t ed25519 -N '' -C pl-egress`). On the VM (`gcloud compute ssh`): `apt-get install -y tinyproxy`, set `Listen 127.0.0.1`, `Port 8888`, `Allow 127.0.0.1`, remove the `Allow 10.0.0.0/8` lines, restart. Expected: from cthulhu `ssh -i ~/lawrider/pl-egress.key egress@<ip> true` exits 0.
- [ ] **Step 2: Box state.** Append to `~/lawrider/.env.lawrider`: `ATTORNEY_CRM_PL_SESSION_SECRET=$(openssl rand -hex 32)`, `PL_PROXY_HOST=<ip>`.
- [ ] **Step 3: Cloudflare.** Zone `15d87750238c78dc9d5a2b70f506b674`: `POST dns_records {type: CNAME, name: attorney, content: 4e367b71-10c3-4354-8e89-58481e49d785.cfargotunnel.com, proxied: true}`; tunnel config: `GET /accounts/3d12eb41d9b2f6c0f8d40980e02535f5/cfd_tunnel/4e367b71-10c3-4354-8e89-58481e49d785/configurations`, insert `{hostname: attorney.lawrider.pl, service: http://lawrider-edge:80}` before the `http_status:404` rule, `PUT` the whole list back.
- [ ] **Step 4: Merge and deploy** (after the owner says "мерж"): PR squash-merged; `deploy-lawrider-cthulhu.yml` run green; `docker ps` shows `attorney-crm-pl` healthy; `curl -sI https://attorney.lawrider.pl/login` → 200.
- [ ] **Step 5: Users.** `docker exec attorney-crm-pl node dist/cli.js set-password <email> <pw> <name>` for the three accounts; passwords generated with `openssl rand -base64 18`, printed once in chat.
- [ ] **Step 6: Probe and first load.** `docker compose -p lawrider --env-file ~/lawrider/.env.lawrider run --rm attorney-crm-pl-collector node dist/collector/cli.js once probe` → three 200 lines with latencies. Then the daemon (already running) proceeds; check after an hour: `select profession, status, count(*) from public.pl_lawyers group by 1,2`.
- [ ] **Step 7: Memory.** Update `project_attorney_crm.md` (or a new `project_attorney_crm_pl.md`) with VM ip, key path, env keys, counts, and the GCP-IP probe result.

---

## Self-review notes

- Spec coverage: goals (tenant, users, table, practices, notes/today, collector) → Tasks 1–8; hosting/ingress/deploy → 9–10; overrides/DNC → 5; VM/sidecar/probe/fallback → 9–10; non-goals respected (no `/search`, no forms, no CEIDG).
- Type consistency: `RegistryAdapter`, `Tenant`, `LawyerUpsert`, `Collector`, `JobDeps` are defined once (Tasks 1, 7, 8) and consumed by name in later tasks.
- Review Focus 1–5 each has a named test in Tasks 4, 5, 8, 7, 6.
