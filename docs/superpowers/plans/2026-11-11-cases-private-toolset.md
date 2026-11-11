# Приватний toolset `cases` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Три нові MCP-інструменти для акаунтів із грантом `cases`: завантажити фото сторінок судового документа у спільну папку з OCR-текстом, знайти в документі процесуальні порушення за чинними статтями кодексу, віддати ChatGPT чинні норми для скарги.

**Architecture:** Другий запис у `KNOWN` приватних toolset'ів (`api/private-tools`) створює `CaseToolset`, який обгортає `PrivateDocsToolset` (читання папки, як gorenichi) і додає `cases_upload_pages`, `cases_find_violations`, `cases_complaint_norms`. Зовнішні залежності (OCR, LLM, статті з бази, завантаження файлів) приходять у конструктор як функції, тому юніт-тести йдуть без Vision і Azure. Папка `/data/cases` змонтована `rw`.

**Tech Stack:** TypeScript (ESM, `.js`-імпорти), jest, sharp, Node `fetch`, Google Vision через `DocumentParser.parseImage`, Azure OpenAI через `getOpenAIManager().executeWithRetry`, `LegislationService.getMultipleArticles`.

**Spec:** `docs/superpowers/specs/2026-11-10-court-case-photos-toolset-design.md`

## Global Constraints

- Рядки для користувача українською.
- Приватні тули НЕ потрапляють у `ToolRegistry`; єдині двері — `executePrivateTool` у `routes/mcp-sse-routes.ts`.
- Імена тулів: `cases_get_index`, `cases_list_documents`, `cases_search_documents`, `cases_read_document`, `cases_upload_pages`, `cases_find_violations`, `cases_complaint_norms`.
- `cases_upload_pages`: до 15 файлів за виклик, до 20 МБ кожен, mime лише `image/jpeg|image/png|image/webp|image/heic|image/heif`; завантаження лише `https:`; хости, що резолвляться у приватні/loopback/link-local адреси, відхиляються; таймаут 30 с на файл; URL ніколи не логується і не повертається.
- Папка: `<номер справи або _без-номера>/<YYYY-MM-DD або без-дати>-<вид>-<суд>/01.jpg 01.txt … _meta.json`. Номер справи: `/` → `_`, дозволені символи `[0-9A-Za-zА-ЯІЇЄҐа-яіїєґ_-]`.
- Зображення зберігаються як JPEG до 2500 px по довгій стороні (оригінал не зберігається).
- Коди: `цпк`=1618-15, `гпк`=1798-12, `кас`=2747-15, `кпк`=4651-17, `купап`=8073-10; судовий збір 3674-17 ст. 4 (не для КПК і КУпАП).
- Моделі: назва папки і класифікація — tier `quick`; порівняння з нормами — tier `deep` (через `ModelSelector.getChatModel`).
- Жодних міграцій. Жодних інструментів перейменування/видалення.
- Відхилення від спеки (рішення плану): вартість LLM у CostTracker НЕ пишеться (у MCP-маршруті немає `requestContext`, а `recordRemoteServiceCall` приймає лише rada/openreyestr); замість цього `logger.info('[Cases] LLM call', { tier, model, promptTokens, completionTokens })`.

## Review Focus

1. Фото з `download_url`, що редіректить на `http:` або приватну адресу: тул має відмовити саме цій сторінці, а не піти за редіректом (Task 4: `fetchFileSafely` з `redirect: 'manual'`).
2. Відповідь моделі-іменувальника не JSON або з номером справи з `..`/слешами: документ лягає в `_без-номера/`, шлях лишається всередині root (Task 4: тест на сміття в JSON).
3. Повторне завантаження того самого документа: нова папка з суфіксом `-2`, стара не перезаписується (Task 4).
4. `cases_find_violations` з документом без `_meta.json` або без `doc_date`: береться поточна редакція і відповідь прямо каже «за поточною редакцією, дата документа невідома» (Task 5).
5. `cases_complaint_norms` для комбінації, якої в кодексі немає (касація під КУпАП): відмова з поясненням, без підбору «схожої» (Task 6).

---

### Task 1: `_meta` у ToolDefinition і запис у папку з боку PrivateDocsToolset

**Files:**
- Modify: `mcp_backend/src/api/base-tool-handler.ts:16-21`
- Modify: `mcp_backend/src/api/private-tools/private-docs-toolset.ts` (HIDDEN, `invalidate()`, `getIndex` без `_index.json`)
- Test: `mcp_backend/src/api/__tests__/private-tools.test.ts`

**Interfaces:**
- Produces: `ToolDefinition._meta?: Record<string, unknown>`; `PrivateDocsToolset.invalidate(): void` (скидає кеш індексу); `PrivateDocsToolset.getIndex` без `_index.json` будує огляд із `<папка>/<документ>/_meta.json` (формат `_meta.json` у Task 4).

- [ ] **Step 1: Write the failing tests** (додати в `describe('PrivateDocsToolset')`)

```ts
it('hides _meta.json and rebuilds the index after invalidate()', async () => {
  mkdirSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський'), { recursive: true });
  writeFileSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '_meta.json'),
    JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд м. Києва', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: ['Худик'], pages: [{ file: '01.jpg', chars: 0, ocr: 'none' }] }));
  writeFileSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '01.txt'), 'Ухвала про відкриття провадження');
  await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } })
    .jpeg().toFile(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '01.jpg'));
  expect(text(await toolset.execute('gorenichi_list_documents', { folder: 'sprava-x' }))).not.toContain('_meta.json');
  toolset.invalidate();
  expect(text(await toolset.execute('gorenichi_search_documents', { query: 'відкриття провадження' }))).toContain('sprava-x/');
});

it('serves an overview from _meta.json folders when there is no _index.json', async () => {
  const metaRoot = mkdtempSync(path.join(tmpdir(), 'pdocs-meta-'));
  mkdirSync(path.join(metaRoot, '369_1234_26', '2026-10-15-ухвала-святошинський'), { recursive: true });
  writeFileSync(path.join(metaRoot, '369_1234_26', '2026-10-15-ухвала-святошинський', '_meta.json'),
    JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: [], pages: [{ file: '01.jpg', chars: 120, ocr: 'vision' }] }));
  const t = new PrivateDocsToolset('cases', metaRoot, 'Справи');
  const out = text(await t.execute('cases_get_index', {}));
  expect(out).toContain('369_1234_26');
  expect(out).toContain('ухвала');
  expect(out).toContain('2026-10-15');
  const folder = text(await t.execute('cases_get_index', { folder: '369_1234_26' }));
  expect(folder).toContain('369_1234_26/2026-10-15-ухвала-святошинський');
  expect(folder).toContain('1 стор.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp_backend && npx jest src/api/__tests__/private-tools.test.ts -t "_meta.json" --no-cache`
Expected: FAIL (`toolset.invalidate is not a function`; «Каталог архіву ще не побудовано»).

- [ ] **Step 3: Implement**

`base-tool-handler.ts`: `_meta?: Record<string, unknown>;` у `ToolDefinition`.

`private-docs-toolset.ts`:
- `HIDDEN`: додати `name === '_meta.json'`.
- `invalidate(): void { this.index = null; }`.
- `export interface DocMeta { case_number: string | null; court: string | null; doc_kind: string; doc_date: string | null; parties: string[]; uploaded_by?: string; uploaded_at?: string; pages: Array<{ file: string; chars: number; ocr: 'vision' | 'none' | 'failed'; reason?: string }> }`.
- `private async loadMetaCatalog(): Promise<Catalog | null>`: обходить `<a>/<b>/_meta.json` (рівно два рівні), будує `Catalog` з `folders = [{ path: a, summary: 'Справа <case_number>', documents: [{ id: 'a/b', folder: a, title: '<doc_kind>, <court>', date: doc_date ?? '', kind: doc_kind, summary: parties.join(', '), files: pages.map(p => 'a/b/' + p.file) }] }]`; `null`, якщо жодного `_meta.json`.
- `loadCatalog()`: якщо `_index.json` немає → `return this.loadMetaCatalog()`.
- `readDocument(id)`: `byId` вже зберігає ключ у верхньому регістрі; шлях-ідентифікатор теж нормалізувати через `.toUpperCase()` з обох боків (поведінка Dnnn не змінюється).

- [ ] **Step 4: Run the whole file**

Run: `cd mcp_backend && npx jest src/api/__tests__/private-tools.test.ts --no-cache`
Expected: PASS, усі тести.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/base-tool-handler.ts mcp_backend/src/api/private-tools/private-docs-toolset.ts mcp_backend/src/api/__tests__/private-tools.test.ts
git commit -m "feat(private-tools): _meta on tool definitions, index from _meta.json folders, invalidate()"
```

---

### Task 2: Таблиці статей `case-checklists.ts`

**Files:**
- Create: `mcp_backend/src/api/private-tools/case-checklists.ts`
- Test: `mcp_backend/src/api/__tests__/case-checklists.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CaseCode = 'цпк' | 'гпк' | 'кас' | 'кпк' | 'купап';
  export type DocKind = 'ухвала' | 'рішення' | 'постанова' | 'вирок' | 'протокол' | 'інше';
  export type ComplaintKind = 'апеляційна скарга на рішення' | 'апеляційна скарга на ухвалу' | 'касаційна скарга' | 'скарга на постанову у справі про адмінправопорушення' | 'заява про перегляд за нововиявленими обставинами';
  export const CODE_RADA_ID: Record<CaseCode, string>;           // цпк 1618-15, гпк 1798-12, кас 2747-15, кпк 4651-17, купап 8073-10
  export const CODE_TITLE: Record<CaseCode, string>;             // 'ЦПК України' …
  export const COURT_FEE = { radaId: '3674-17', articles: ['4'] } as const;
  export function parseCode(s: unknown): CaseCode | null;        // 'ЦПК', 'цпк', 'КУпАП', 'kupap'… → код; інакше null
  export function violationArticles(docKind: DocKind, code: CaseCode): string[];   // [] коли комбінації немає
  export function complaintArticles(code: CaseCode, kind: ComplaintKind): { articles: string[]; fee: boolean } | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { violationArticles, complaintArticles, parseCode, CODE_RADA_ID } from '../private-tools/case-checklists.js';

describe('case-checklists', () => {
  it('maps КУпАП to the in-force code and parses spellings', () => {
    expect(CODE_RADA_ID['купап']).toBe('8073-10');
    expect(parseCode('КУпАП')).toBe('купап');
    expect(parseCode(' ЦПК ')).toBe('цпк');
    expect(parseCode('kupap')).toBe('купап');
    expect(parseCode('ПК')).toBeNull();
  });
  it('lists the articles to check for a ruling and an admin-offence record', () => {
    expect(violationArticles('ухвала', 'цпк')).toEqual(['260', '272', '128', '187']);
    expect(violationArticles('протокол', 'купап')).toEqual(['254', '256', '268', '277', '278', '280']);
    expect(violationArticles('постанова', 'купап')).toEqual(['268', '277', '278', '280', '283', '284', '285', '287', '289', '294']);
    expect(violationArticles('вирок', 'кпк')).toEqual(['110', '370', '371', '372', '373', '374']);
    expect(violationArticles('протокол', 'цпк')).toEqual([]);
  });
  it('gives complaint norms with the court fee except КПК and КУпАП, and refuses impossible combinations', () => {
    expect(complaintArticles('цпк', 'апеляційна скарга на рішення')).toEqual({ articles: ['352', '354', '355', '356', '357'], fee: true });
    expect(complaintArticles('кпк', 'касаційна скарга')).toEqual({ articles: ['424', '425', '426', '427'], fee: false });
    expect(complaintArticles('купап', 'скарга на постанову у справі про адмінправопорушення')).toEqual({ articles: ['287', '288', '289', '291', '294', '295'], fee: false });
    expect(complaintArticles('купап', 'касаційна скарга')).toBeNull();
    expect(complaintArticles('цпк', 'скарга на постанову у справі про адмінправопорушення')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-checklists.test.ts --no-cache`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `case-checklists.ts`** як чисті дані.

Таблиця порушень (вид × код):
- ухвала: цпк 260,272,128,187; кас 248,251; гпк 234,242; кпк 369,372.
- рішення: цпк 259,263,264,265,268,272,352,353,354; кас 242,243,244,245,246,295; гпк 236,237,238,254,255,256.
- постанова: кас як «рішення»; гпк як «рішення»; купап 268,277,278,280,283,284,285,287,289,294.
- вирок: кпк 110,370,371,372,373,374.
- протокол: купап 254,256,268,277,278,280.
- інше: [] для всіх.

Таблиця скарг: з таблиці у спеці (ЦПК/ГПК/КАС/КПК/КУпАП × 4 види; «скарга на постанову» лише КУпАП; касація і нововиявлені під КУпАП = `null`; для КПК «на рішення» і «на ухвалу» однакові 392,393,395,396). `fee: code !== 'кпк' && code !== 'купап'`.

`parseCode`: нижній регістр, trim, прибрати пробіли; латинські аліаси `cpk|cpc→цпк, gpk|hpk→гпк, kas→кас, kpk→кпк, kupap→купап`.

- [ ] **Step 4: Run to verify pass**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-checklists.test.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/private-tools/case-checklists.ts mcp_backend/src/api/__tests__/case-checklists.test.ts
git commit -m "feat(cases): article checklists for violations and complaint norms"
```

---

### Task 3: Каркас `CaseToolset`, реєстрація `cases` у KNOWN, інʼєкція залежностей

**Files:**
- Create: `mcp_backend/src/api/private-tools/case-toolset.ts`
- Modify: `mcp_backend/src/api/private-tools/index.ts`
- Test: `mcp_backend/src/api/__tests__/private-tools.test.ts` (describe `private tool grants`), `mcp_backend/src/api/__tests__/case-toolset.test.ts` (новий)

**Interfaces:**
- Produces (`case-toolset.ts`):
  ```ts
  export interface FetchedFile { buffer: Buffer; mimeType: string }
  export interface LlmCall { tier: 'quick' | 'deep'; system: string; user: string; imageJpeg?: Buffer; json: boolean }
  export interface CaseToolsetDeps {
    ocr: (image: Buffer, mimeType: string) => Promise<string>;            // '' коли тексту нема; кидає при збої сервісу
    llm: (call: LlmCall) => Promise<string>;                               // сирий текст відповіді
    legislation: { getMultipleArticles(radaId: string, numbers: string[], asOfDate?: string): Promise<LegislationReference[]> };
    fetchFile?: (url: string) => Promise<FetchedFile>;                     // типово fetchFileSafely (Task 4)
    now?: () => Date;
  }
  export class CaseToolset {
    constructor(readonly docs: PrivateDocsToolset, private readonly deps: CaseToolsetDeps | null);
    readonly id: string;                      // = docs.id
    toolNames(): string[];
    getToolDefinitions(): ToolDefinition[];   // docs' 4 + 3 own; cases_upload_pages має `_meta: { 'openai/fileParams': ['files'] }`
    execute(name: string, args: Record<string, any>): Promise<PrivateToolResult>;
  }
  ```
- Produces (`index.ts`):
  ```ts
  export interface PrivateToolset { readonly id: string; toolNames(): string[]; getToolDefinitions(): ToolDefinition[]; execute(name: string, args: Record<string, any>): Promise<PrivateToolResult> }
  export function setPrivateToolDeps(deps: CaseToolsetDeps | null): void;   // викликається з http-server до першого tools/list
  export function configuredToolsets(): Map<string, PrivateToolset>;
  export function setConfiguredToolsetsForTest(map: Map<string, PrivateToolset> | null): void;
  ```
  `KNOWN` → `[{ id: 'gorenichi', env: 'GORENICHI_DOCS_ROOT', label: 'Гореничі', kind: 'docs' }, { id: 'cases', env: 'CASES_DOCS_ROOT', label: 'Справи', kind: 'cases' }]`. Для `kind: 'cases'`: `new CaseToolset(new PrivateDocsToolset(id, root, label), privateToolDeps)`; якщо deps ще не задані — `logger.warn` і toolset усе одно створюється з `null` (тули завантаження/аналізу тоді відповідають помилкою «Сервіс аналізу справ не налаштовано на цьому сервері.»).

- [ ] **Step 1: Write the failing tests**

У `private-tools.test.ts` (`describe('private tool grants')`):
```ts
it('advertises cases_* with the upload tool carrying openai/fileParams, only to the cases grantee', async () => {
  const casesRoot = mkdtempSync(path.join(tmpdir(), 'cases-'));
  const cases = new CaseToolset(new PrivateDocsToolset('cases', casesRoot, 'Справи'), null);
  setConfiguredToolsetsForTest(new Map([['gorenichi', toolset], ['cases', cases]]));
  const db = { query: async (_s: string, p: unknown[]) => ({ rows: p[0] === 'u-cases' ? [{ toolset: 'cases' }] : [] }) };
  const defs = await privateToolDefinitionsFor(db, 'u-cases');
  expect(defs.map((d) => d.name).sort()).toEqual(['cases_complaint_norms', 'cases_find_violations', 'cases_get_index', 'cases_list_documents', 'cases_read_document', 'cases_search_documents', 'cases_upload_pages']);
  expect(defs.find((d) => d.name === 'cases_upload_pages')!._meta).toEqual({ 'openai/fileParams': ['files'] });
  expect(await privateToolDefinitionsFor(db, 'u-other')).toEqual([]);
  expect(isPrivateToolName('cases_upload_pages')).toBe(true);
  const r = await executePrivateTool(db, 'u-cases', 'cases_upload_pages', { files: [] });
  expect(r?.isError).toBe(true);
  expect(text(r)).toContain('не налаштовано');
});
```
Новий `case-toolset.test.ts` з фабрикою фейків, яку використовують Task 4–6:
```ts
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { CaseToolset, CaseToolsetDeps, LlmCall } from '../private-tools/case-toolset.js';
import { PrivateDocsToolset } from '../private-tools/private-docs-toolset.js';

export const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
export async function jpeg(w = 60, h = 90): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } }).jpeg().toBuffer();
}
export function makeToolset(over: Partial<CaseToolsetDeps> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cases-'));
  const calls: LlmCall[] = [];
  const deps: CaseToolsetDeps = {
    ocr: async () => 'УХВАЛА 15 жовтня 2026 року Святошинський районний суд м. Києва справа № 369/1234/26',
    llm: async (c) => { calls.push(c); return JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд м. Києва', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: ['Худик Б.І.'] }); },
    legislation: { getMultipleArticles: async (radaId, nums, asOf) => nums.map((n) => ({ rada_id: radaId, article_number: n, title: `Стаття ${n}`, full_text: `Текст статті ${n}`, url: `https://zakon.rada.gov.ua/laws/show/${radaId}#n${n}`, metadata: { edition_date: asOf ? asOf.replace(/-/g, '') : '20260101' } })) },
    fetchFile: async () => ({ buffer: await jpeg(), mimeType: 'image/jpeg' }),
    now: () => new Date('2026-11-11T10:00:00Z'),
    ...over,
  };
  return { root, calls, toolset: new CaseToolset(new PrivateDocsToolset('cases', root, 'Справи'), deps) };
}

describe('CaseToolset definitions', () => {
  it('exposes seven tools under the cases_ prefix', () => {
    const { toolset } = makeToolset();
    expect(toolset.toolNames()).toHaveLength(7);
    expect(toolset.toolNames().every((n) => n.startsWith('cases_'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/private-tools.test.ts src/api/__tests__/case-toolset.test.ts --no-cache`
Expected: FAIL, `case-toolset.js` not found.

- [ ] **Step 3: Implement `case-toolset.ts` (каркас) і правки `index.ts`**

`CaseToolset.getToolDefinitions()` = `[...this.docs.getToolDefinitions(), upload, violations, norms]`, де:
- `cases_upload_pages`: description «Завантажити фото сторінок ОДНОГО судового документа (ухвала, рішення, постанова, протокол) у папку справ «Справи». Передайте файли з чату у `files`; інші клієнти — `pages_base64`. Тул розпізнає текст (OCR), визначає номер справи, суд, вид і дату документа, кладе фото і текст поруч. До 15 сторінок за виклик.»; `inputSchema.properties`: `files` (array of object {download_url: string, file_id: string, mime_type: string, file_name: string}, required [download_url, file_id]), `pages_base64` (array of object {data: string, mime_type: string}, required both), `case_hint` (string), `document_hint` (string); без `required`; `_meta: { 'openai/fileParams': ['files'] }`; annotations `{ title: 'Справи: завантажити сторінки', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`.
- `cases_find_violations`: properties `document` (string, шлях папки документа `<справа>/<документ>` з get_index), `text` (string), `code` (string, enum ['цпк','гпк','кас','кпк','купап']), `doc_kind` (string, enum ['ухвала','рішення','постанова','вирок','протокол']); readOnly.
- `cases_complaint_norms`: properties `code` (enum як вище), `complaint_kind` (enum з 5 значень `ComplaintKind`); required обидва; readOnly.

`execute(name, args)`: `cases_upload_pages|cases_find_violations|cases_complaint_norms` → якщо `deps === null` → `err('Сервіс аналізу справ не налаштовано на цьому сервері.')`, інакше відповідні приватні методи (заглушки `throw new Error('not implemented')` до Task 4–6); решта → `this.docs.execute(name, args)`.

`index.ts`: інтерфейс `PrivateToolset`, `KNOWN` з `kind`, `let privateToolDeps: CaseToolsetDeps | null = null` + `setPrivateToolDeps`, створення `CaseToolset` для `kind === 'cases'`; типи `Map<string, PrivateToolset>` у `configured`, `grantedToolsets`, `setConfiguredToolsetsForTest`.

- [ ] **Step 4: Run to verify pass**

Run: `cd mcp_backend && npx jest src/api/__tests__/private-tools.test.ts src/api/__tests__/case-toolset.test.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/private-tools/case-toolset.ts mcp_backend/src/api/private-tools/index.ts mcp_backend/src/api/__tests__/private-tools.test.ts mcp_backend/src/api/__tests__/case-toolset.test.ts
git commit -m "feat(cases): CaseToolset skeleton, cases toolset in KNOWN, dependency injection"
```

---

### Task 4: `cases_upload_pages`

**Files:**
- Modify: `mcp_backend/src/api/private-tools/case-toolset.ts`
- Test: `mcp_backend/src/api/__tests__/case-toolset.test.ts`

**Interfaces:**
- Consumes: `CaseToolsetDeps` (Task 3), `DocMeta` і `invalidate()` (Task 1).
- Produces (експорти з `case-toolset.ts`, тестуються напряму):
  ```ts
  export function sanitizeCaseFolder(caseNumber: string | null | undefined): string;   // '369/1234/26' → '369_1234_26'; порожньо/сміття → '_без-номера'
  export function documentFolderName(meta: { doc_date: string | null; doc_kind: string; court: string | null }): string; // '2026-10-15-ухвала-святошинський-районний-суд-м-києва', ≤ 80 символів, 'без-дати' коли дати нема
  export async function fetchFileSafely(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<FetchedFile>; // https лише, redirect: 'manual' → помилка, dns.lookup → приватні діапазони відхиляються, 20 МБ
  export function isPrivateAddress(ip: string): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('cases_upload_pages', () => {
  it('sanitises folder names', () => {
    expect(sanitizeCaseFolder('369/1234/26')).toBe('369_1234_26');
    expect(sanitizeCaseFolder('../etc')).toBe('_без-номера');
    expect(sanitizeCaseFolder(null)).toBe('_без-номера');
    expect(documentFolderName({ doc_date: '2026-10-15', doc_kind: 'ухвала', court: 'Святошинський районний суд м. Києва' })).toBe('2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(documentFolderName({ doc_date: null, doc_kind: 'інше', court: null })).toBe('без-дати-інше');
  });
  it('refuses non-https and private download targets', async () => {
    await expect(fetchFileSafely('http://example.com/a.jpg')).rejects.toThrow(/https/);
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.5.5')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
  it('writes jpg + txt + _meta.json, names the folder from the model, and reports pages', async () => {
    const { root, toolset, calls } = makeToolset();
    const r = await toolset.execute('cases_upload_pages', { files: [
      { download_url: 'https://files.example/1', file_id: 'f1', mime_type: 'image/jpeg', file_name: 'IMG_1.jpg' },
      { download_url: 'https://files.example/2', file_id: 'f2' },
    ] });
    const dir = path.join(root, '369_1234_26', '2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(readdirSync(dir).sort()).toEqual(['01.jpg', '01.txt', '02.jpg', '02.txt', '_meta.json']);
    const meta = JSON.parse(readFileSync(path.join(dir, '_meta.json'), 'utf8'));
    expect(meta.case_number).toBe('369/1234/26');
    expect(meta.pages).toHaveLength(2);
    expect(meta.pages[0].ocr).toBe('vision');
    expect(meta.uploaded_at).toBe('2026-11-11T10:00:00.000Z');
    expect(calls[0].tier).toBe('quick');
    expect(calls[0].imageJpeg).toBeInstanceOf(Buffer);
    expect(calls[0].json).toBe(true);
    const out = text(r);
    expect(out).toContain('369_1234_26/2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(out).toContain('Сторінок: 2');
    expect(out).not.toContain('files.example');
    expect(text(await toolset.execute('cases_search_documents', { query: '369/1234/26' }))).toContain('369_1234_26/');
  });
  it('keeps the document when one page fails and marks pages without text', async () => {
    let n = 0;
    const { root, toolset } = makeToolset({
      fetchFile: async () => { n++; if (n === 2) throw new Error('boom'); return { buffer: await jpeg(), mimeType: 'image/jpeg' }; },
      ocr: async () => '',
    });
    const r = await toolset.execute('cases_upload_pages', { files: [1, 2, 3].map((i) => ({ download_url: `https://f/${i}`, file_id: `f${i}` })) });
    const out = text(r);
    expect(r.isError).toBeUndefined();
    expect(out).toContain('стор. 2');
    expect(out).toMatch(/не вдалося|помилка/i);
    expect(out).toContain('без тексту');
    const docDir = path.join(root, '369_1234_26', readdirSync(path.join(root, '369_1234_26'))[0]);
    const meta = JSON.parse(readFileSync(path.join(docDir, '_meta.json'), 'utf8'));
    expect(meta.pages.map((p: any) => p.ocr)).toEqual(['none', 'failed', 'none']);
    expect(existsSync(path.join(docDir, '02.jpg'))).toBe(false);
  });
  it('falls back to _без-номера when the model answer is not JSON or has junk in it', async () => {
    const { root, toolset } = makeToolset({ llm: async () => 'Не можу визначити' });
    await toolset.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(existsSync(path.join(root, '_без-номера'))).toBe(true);
    const { root: r2, toolset: t2 } = makeToolset({ llm: async () => JSON.stringify({ case_number: '../../x', court: null, doc_kind: 'ухвала', doc_date: 'вчора', parties: 'ні' }) });
    await t2.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(readdirSync(r2)).toEqual(['_без-номера']);
    expect(readdirSync(path.join(r2, '_без-номера'))[0]).toMatch(/^без-дати-ухвала/);
  });
  it('appends -2 instead of overwriting a document uploaded twice', async () => {
    const { root, toolset } = makeToolset();
    const args = { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] };
    await toolset.execute('cases_upload_pages', args);
    await toolset.execute('cases_upload_pages', args);
    expect(readdirSync(path.join(root, '369_1234_26')).sort()).toEqual([
      '2026-10-15-ухвала-святошинський-районний-суд-м-києва', '2026-10-15-ухвала-святошинський-районний-суд-м-києва-2']);
  });
  it('rejects empty input, more than 15 pages, unsupported mime and oversize files', async () => {
    const { toolset } = makeToolset();
    expect((await toolset.execute('cases_upload_pages', {})).isError).toBe(true);
    expect((await toolset.execute('cases_upload_pages', { files: Array.from({ length: 16 }, (_, i) => ({ download_url: 'https://f/x', file_id: `f${i}` })) })).isError).toBe(true);
    const bad = await toolset.execute('cases_upload_pages', { pages_base64: [{ data: 'JVBERi0=', mime_type: 'application/pdf' }] });
    expect(bad.isError).toBe(true);
    const big = await toolset.execute('cases_upload_pages', { pages_base64: [{ data: Buffer.alloc(21 * 1024 * 1024).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(big.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts -t upload --no-cache`
Expected: FAIL (exports missing / not implemented).

- [ ] **Step 3: Implement**

У `case-toolset.ts`:
- Константи: `MAX_FILES = 15`, `MAX_BYTES = 20 * 1024 * 1024`, `ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif'])`, `JPEG_MAX_SIDE = 2500`, `PARALLEL = 4`, `FETCH_TIMEOUT_MS = 30_000`.
- `isPrivateAddress(ip)`: IPv4 `10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8`; IPv6 `::1, fc00::/7, fe80::/10, ::ffff:<v4-приватна>`.
- `fetchFileSafely(url, opts)`: `new URL(url)`; `protocol !== 'https:'` → `throw new Error('дозволено лише https')`; `dns.promises.lookup(hostname, { all: true })` → будь-яка приватна адреса → throw; `fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })`; статус 3xx → throw «редірект не дозволено»; не 2xx → throw; `content-length > maxBytes` → throw; читати `arrayBuffer()`, перевірити розмір; `mimeType` з `content-type` (до `;`) або `'application/octet-stream'`.
- `sanitizeCaseFolder`: trim, `/`→`_`, залишити `[0-9A-Za-zА-ЯІЇЄҐа-яіїєґ_-]`; якщо результат порожній або починається з `.` або `_` (крім нашого `_без-номера`) → `'_без-номера'`. Довжина ≤ 60.
- `slug(s)`: нижній регістр, `[^0-9a-zа-яіїєґ]+` → `-`, обрізати `-` з країв. `documentFolderName`: `[date ?? 'без-дати', slug(doc_kind) || 'інше', slug(court)]` → filter(Boolean).join('-') → ≤ 80 символів.
- Приватний `upload(args)`:
  1. Зібрати вхід: `files[]` (елементи з рядковим `download_url`), `pages_base64[]`; порожньо → `err('Передайте фото сторінок у files (ChatGPT) або pages_base64.')`; разом > 15 → err.
  2. Для base64: `Buffer.from(data, 'base64')`, mime з поля; розмір > 20 МБ → помилка одразу (весь виклик), mime не в `ALLOWED_MIME` → помилка одразу.
  3. Завантажити всі `files` паралельно по 4 через `deps.fetchFile ?? fetchFileSafely`; збій → сторінка `failed` з причиною (без URL). Для файлів mime перевіряється після завантаження (`image/*` з `ALLOWED_MIME`, інакше `failed: 'формат не підтримується, збережіть як JPEG'`).
  4. Конвертувати кожну успішну сторінку: `sharp(buf, { failOn: 'none' }).rotate().resize({ width: 2500, height: 2500, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()`; збій sharp (HEIC без декодера) → `failed: 'формат не підтримується, збережіть як JPEG'`.
  5. Створити тимчасову папку `<root>/.incoming-<timestamp>-<random>` і записати `NN.jpg` для успішних сторінок (нумерація за вхідним порядком, пропущені номери не зсуваються).
  6. OCR паралельно по 4: `deps.ocr(jpeg, 'image/jpeg')`; `''` → `ocr: 'none'`, текст → `ocr: 'vision'`, кидок → `ocr: 'failed'`, причина `'OCR: ' + message`; записати `NN.txt` (порожній теж).
  7. LLM-іменування (`tier: 'quick'`, `json: true`, `imageJpeg` = перша успішна сторінка): system «Ти визначаєш реквізити українського судового документа…» з вимогою повернути лише JSON `{case_number, court, doc_kind, doc_date, parties}`; user = перші 3 сторінки OCR по ≤ 6000 символів + `case_hint`/`document_hint`, якщо є. Розбір: `JSON.parse` (перед тим обрізати ``` ``` ``` огородження); `case_number` → рядок або null; `doc_kind` ∈ `DocKind`, інакше `'інше'`; `doc_date` лише `^\d{4}-\d{2}-\d{2}$`, інакше null; `parties` лише масив рядків, інакше `[]`; будь-який кидок → усі null, `doc_kind: 'інше'`. Якщо `case_hint` схожий на номер справи (`/\d+\/\d+\/\d+/`) і модель дала null → взяти `case_hint`.
  8. Фінальний шлях: `<root>/<sanitizeCaseFolder(case_number)>/<documentFolderName(meta)>`, при існуванні додавати `-2`, `-3`…; `fs.rename` тимчасової папки; записати `_meta.json` (`DocMeta` + `uploaded_by: args.__userId ?? undefined`, `uploaded_at: now().toISOString()`); `this.docs.invalidate()`.
  9. Відповідь (текст): `Збережено: <справа>/<документ>\nСторінок: N (успішно K)\nМодель визначила: справа …, суд …, вид …, дата …, сторони …\nстор. 1: 1234 символів\nстор. 2: не вдалося завантажити (boom)\nстор. 3: без тексту — перезніміть сторінку\n` + рядок «Далі: cases_find_violations з document="<справа>/<документ>"». Якщо успішних сторінок 0 → видалити тимчасову папку і `err('Жодну сторінку не вдалося завантажити: …')`.

- [ ] **Step 4: Run to verify pass**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/private-tools/case-toolset.ts mcp_backend/src/api/__tests__/case-toolset.test.ts
git commit -m "feat(cases): cases_upload_pages — safe download, OCR, model-named folders, jpg+txt+_meta.json"
```

---

### Task 5: `cases_find_violations`

**Files:**
- Modify: `mcp_backend/src/api/private-tools/case-toolset.ts`
- Test: `mcp_backend/src/api/__tests__/case-toolset.test.ts`

**Interfaces:**
- Consumes: `violationArticles`, `parseCode`, `CODE_RADA_ID`, `CODE_TITLE` (Task 2); `resolveInsideRoot` (private-docs-toolset); `DocMeta` (Task 1).
- Produces: нічого нового назовні. Внутрішній контракт JSON від deep-моделі: `{ findings: Array<{ article: string; requirement: string; finding: 'порушення' | 'дотримано' | 'не видно з фото'; quote: string; page: number | null; severity: 'висока' | 'середня' | 'низька' }> }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('cases_find_violations', () => {
  async function uploaded() {
    const t = makeToolset();
    await t.toolset.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    return { ...t, doc: '369_1234_26/2026-10-15-ухвала-святошинський-районний-суд-м-києва' };
  }
  it('checks a stored ruling against ЦПК articles as of the document date and prints article texts', async () => {
    const { toolset, calls, doc } = await uploaded();
    const asked: Array<[string, string[], string | undefined]> = [];
    (toolset as any).deps.legislation = { getMultipleArticles: async (r: string, n: string[], d?: string) => { asked.push([r, n, d]); return n.map((x) => ({ rada_id: r, article_number: x, title: `Стаття ${x}`, full_text: `Текст ${x}`, url: `https://zakon.rada.gov.ua/laws/show/${r}#n${x}`, metadata: { edition_date: '20261001' } })); } };
    calls.length = 0;
    (toolset as any).deps.llm = async (c: LlmCall) => { calls.push(c); return JSON.stringify({ findings: [
      { article: '260', requirement: 'ухвала містить мотиви', finding: 'порушення', quote: 'без мотивів', page: 1, severity: 'висока' },
      { article: '272', requirement: 'вручення копії', finding: 'не видно з фото', quote: '', page: null, severity: 'середня' },
    ] }); };
    const out = text(await toolset.execute('cases_find_violations', { document: doc, code: 'цпк', doc_kind: 'ухвала' }));
    expect(asked[0]).toEqual(['1618-15', ['260', '272', '128', '187'], '2026-10-15']);
    expect(out).toContain('редакцією на 2026-10-15');
    expect(out).toContain('ст. 260');
    expect(out).toContain('Текст 260');
    expect(out).toContain('01.10.2026');
    expect(out).toContain('не видно з фото');
    expect(calls[0].tier).toBe('deep');
    expect(calls[0].user).toContain('Текст 260');
  });
  it('classifies code and kind with the quick model when not given, and says so when the date is unknown', async () => {
    const { toolset, calls } = makeToolset({ llm: async (c) => c.tier === 'quick'
      ? JSON.stringify({ code: 'купап', doc_kind: 'постанова' })
      : JSON.stringify({ findings: [] }) });
    const out = text(await toolset.execute('cases_find_violations', { text: 'ПОСТАНОВА про накладення адміністративного стягнення…' }));
    expect(calls.map((c) => c.tier)).toEqual(['quick', 'deep']);
    expect(out).toContain('за поточною редакцією');
    expect(out).toContain('КУпАП');
    expect(out).toContain('Порушень не знайдено');
  });
  it('refuses a document path outside the folder and an unknown combination', async () => {
    const { toolset } = makeToolset();
    expect((await toolset.execute('cases_find_violations', { document: '../x' })).isError).toBe(true);
    const r = await toolset.execute('cases_find_violations', { text: 'x', code: 'цпк', doc_kind: 'протокол' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('немає');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts -t violations --no-cache`
Expected: FAIL, not implemented.

- [ ] **Step 3: Implement приватний `findViolations(args)`**

1. Текст: `args.text` або `args.document` → `resolveInsideRoot(root, document)`; читати `_meta.json` (може бути відсутній) і всі `NN.txt` за зростанням; сторінки склеїти як `=== стор. N ===\n…`; порожньо → `err('У документі немає розпізнаного тексту.')`. Обрізати до `MAX_DOC_CHARS = 60_000` і запам'ятати, що обрізано.
2. `code = parseCode(args.code)`, `docKind = args.doc_kind` (валідний `DocKind`) або з `_meta.json`; чого бракує — одна quick-модель (`json: true`) з перших 4000 символів повертає `{code, doc_kind}`; невалідне → `err('Не вдалося визначити кодекс або вид документа. Вкажіть code і doc_kind.')`.
3. `articles = violationArticles(docKind, code)`; `[]` → `err('Для <вид> за <КОДЕКС> перевірок немає.')`.
4. `asOf = meta?.doc_date ?? undefined`; `refs = await deps.legislation.getMultipleArticles(CODE_RADA_ID[code], articles, asOf)`; статті, яких не повернулось, перелічити в відповіді як «не знайдено в базі».
5. Deep-модель (`tier: 'deep'`, `json: true`): system — «Ти перевіряєш український судовий документ на відповідність статтям кодексу. Для кожної статті дай finding ∈ {порушення, дотримано, не видно з фото}, короткий requirement, дослівну quote зі сторінки (page) або порожньо, severity. Поверни лише JSON {findings:[…]}.»; user — статті (`ст. N. <title>\n<full_text>`) + документ. Розбір JSON; збій → `err('Модель не повернула результат, спробуйте ще раз.')`.
6. Відповідь: рядок 1 — `Перевірено <вид> за <CODE_TITLE> у редакції на <doc_date>` або `… за поточною редакцією, дата документа невідома`; (якщо обрізано) `Текст документа обрізано до 60 000 символів.`; блок «Порушення» (tab-таблиця `ст.\tвимога\tцитата\tстор.\tвага`), або `Порушень не знайдено.`; блок «Не видно з фото» списком статей; блок «Тексти статей»: для кожної `ref` — `ст. <n>. <title> (редакція від DD.MM.YYYY, <url>)\n<full_text>`, дата з `metadata.edition_date` (`YYYYMMDD` → `DD.MM.YYYY`).

- [ ] **Step 4: Run to verify pass**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/private-tools/case-toolset.ts mcp_backend/src/api/__tests__/case-toolset.test.ts
git commit -m "feat(cases): cases_find_violations — checklist articles as of the document date, deep-model findings"
```

---

### Task 6: `cases_complaint_norms`

**Files:**
- Modify: `mcp_backend/src/api/private-tools/case-toolset.ts`
- Test: `mcp_backend/src/api/__tests__/case-toolset.test.ts`

**Interfaces:**
- Consumes: `complaintArticles`, `COURT_FEE`, `parseCode`, `CODE_RADA_ID`, `CODE_TITLE` (Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
describe('cases_complaint_norms', () => {
  it('returns the current texts of the complaint articles plus the court fee article', async () => {
    const { toolset, calls } = makeToolset();
    const out = text(await toolset.execute('cases_complaint_norms', { code: 'ЦПК', complaint_kind: 'апеляційна скарга на рішення' }));
    expect(calls).toHaveLength(0);
    for (const n of ['352', '354', '355', '356', '357']) expect(out).toContain(`ст. ${n}`);
    expect(out).toContain('3674-17');
    expect(out).toContain('Текст статті 4');
    expect(out).toMatch(/скаргу складає модель/i);
  });
  it('omits the fee for КУпАП and refuses combinations the code does not have', async () => {
    const { toolset } = makeToolset();
    const out = text(await toolset.execute('cases_complaint_norms', { code: 'купап', complaint_kind: 'скарга на постанову у справі про адмінправопорушення' }));
    expect(out).toContain('ст. 289');
    expect(out).not.toContain('3674-17');
    const r = await toolset.execute('cases_complaint_norms', { code: 'купап', complaint_kind: 'касаційна скарга' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('КУпАП');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts -t complaint --no-cache`
Expected: FAIL.

- [ ] **Step 3: Implement приватний `complaintNorms(args)`**

`parseCode` → null → `err('Невідомий кодекс. Допустимо: цпк, гпк, кас, кпк, купап.')`; `complaint_kind` не з `ComplaintKind` → err зі списком; `complaintArticles` → null → `err('У <CODE_TITLE> немає такого виду оскарження: <kind>.')`. `refs = getMultipleArticles(CODE_RADA_ID[code], articles)` (без дати = чинна), плюс `getMultipleArticles(COURT_FEE.radaId, COURT_FEE.articles)` коли `fee`. Відповідь: порада зверху «Скаргу складає модель; строки рахувати від дати вручення/проголошення з документа; нижче чинні норми.», потім нумерований список `N. ст. <n> <CODE_TITLE> — <title> (редакція від DD.MM.YYYY, <url>)\n<full_text>`, судовий збір окремим пунктом `Закон 3674-17 ст. 4 (судовий збір)`.

- [ ] **Step 4: Run all three test files**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-toolset.test.ts src/api/__tests__/case-checklists.test.ts src/api/__tests__/private-tools.test.ts --no-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/api/private-tools/case-toolset.ts mcp_backend/src/api/__tests__/case-toolset.test.ts
git commit -m "feat(cases): cases_complaint_norms — current complaint articles and court fee, no LLM"
```

---

### Task 7: Підключення на проді: залежності в http-server, compose, збірка, PR

**Files:**
- Modify: `mcp_backend/src/factories/core-services.ts` (експорт `legislationService`)
- Modify: `mcp_backend/src/http-server.ts:110-120` (виклик `setPrivateToolDeps`)
- Create: `mcp_backend/src/api/private-tools/case-deps.ts`
- Modify: `deployment/docker-compose.local.yml:148, 206`
- Test: `mcp_backend/src/api/__tests__/case-deps.test.ts`

**Interfaces:**
- Produces (`case-deps.ts`):
  ```ts
  export function buildCaseToolsetDeps(p: { documentParser: { parseImage(buf: Buffer, mime: string): Promise<{ text: string }> }; legislationService: CaseToolsetDeps['legislation'] }): CaseToolsetDeps;
  export async function callOpenAIVision(call: LlmCall): Promise<string>;   // через getOpenAIManager().executeWithRetry і ModelSelector.getChatModel(call.tier)
  ```
  `ocr` обгортає `parseImage` і повертає `''`, коли повідомлення помилки містить `No text detected`; інші помилки прокидає.
  `callOpenAIVision`: `messages = [{ role: 'system', content: system }, { role: 'user', content: imageJpeg ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageJpeg.toString('base64'), detail: 'high' } }] : user }]`, `response_format: json ? { type: 'json_object' } : undefined`, `max_completion_tokens: 4000`; після відповіді `logger.info('[Cases] LLM call', { tier, model, promptTokens, completionTokens })`; повертає `choices[0].message.content ?? ''`.
- `core-services.ts`: у `BackendCoreServices` додати `legislationService: LegislationService;` і повернути його.
- `http-server.ts` після `this.tools = createToolServices(...)`: `setPrivateToolDeps(buildCaseToolsetDeps({ documentParser: this.tools.documentParser, legislationService: this.services.legislationService }));`.
- compose: env `CASES_DOCS_ROOT: /data/cases` під `GORENICHI_DOCS_ROOT`; volume `- ${CASES_DOCS_DIR:-/mnt/bulk_storage/CASES}:/data/cases` (без `:ro`) з коментарем «writable: cases_upload_pages пише сюди».

- [ ] **Step 1: Write the failing test** (`case-deps.test.ts`)

```ts
import { buildCaseToolsetDeps } from '../private-tools/case-deps.js';
describe('buildCaseToolsetDeps', () => {
  it('turns "No text detected" into an empty OCR result and keeps other failures', async () => {
    const deps = buildCaseToolsetDeps({
      documentParser: { parseImage: async (_b, m) => { if (m === 'blank') throw new Error('No text detected in image via OCR'); if (m === 'down') throw new Error('quota'); return { text: 'ок' }; } },
      legislationService: { getMultipleArticles: async () => [] },
    });
    expect(await deps.ocr(Buffer.alloc(1), 'blank')).toBe('');
    expect(await deps.ocr(Buffer.alloc(1), 'image/jpeg')).toBe('ок');
    await expect(deps.ocr(Buffer.alloc(1), 'down')).rejects.toThrow('quota');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp_backend && npx jest src/api/__tests__/case-deps.test.ts --no-cache`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `case-deps.ts`, правки core-services, http-server, compose**

- [ ] **Step 4: Build and run the private-tools suites**

Run: `cd packages/shared && npm run build && cd ../../mcp_backend && npx tsc --noEmit -p . 2>&1 | grep -v "core-loader" | head; npx jest src/api/__tests__/case-deps.test.ts src/api/__tests__/case-toolset.test.ts src/api/__tests__/case-checklists.test.ts src/api/__tests__/private-tools.test.ts --no-cache`
Expected: tsc без нових помилок (3 відомі у core-loader лишаються), jest PASS.

- [ ] **Step 5: Commit, push, PR**

```bash
git add mcp_backend/src/api/private-tools/case-deps.ts mcp_backend/src/api/__tests__/case-deps.test.ts mcp_backend/src/factories/core-services.ts mcp_backend/src/http-server.ts deployment/docker-compose.local.yml docs/superpowers/specs/2026-11-10-court-case-photos-toolset-design.md docs/superpowers/plans/2026-11-11-cases-private-toolset.md
git commit -m "feat(cases): wire Vision OCR, Azure OpenAI and legislation into the cases toolset; mount /data/cases rw"
git push -u origin feat/cases-private-toolset
gh pr create --title "feat(cases): private toolset for photographed court case files" --body "<опис з посиланням на спеку; без email у тексті>"
```

---

### Task 8: Після мержу: папка, гранти, Refresh tools, живий тест

**Files:** немає (операції на cthulhu через `ssh local`).

- [ ] **Step 1: Папка** — `ssh local 'sudo mkdir -p /mnt/bulk_storage/CASES && sudo chown ubuntu /mnt/bulk_storage/CASES && ls -ld /mnt/bulk_storage/CASES'`. Деплой підхопить mount під час наступного `docker compose up` з пайплайна (цей PR змінює compose, тож контейнер перестворюється).
- [ ] **Step 2: Гранти** — SQL через файл + `docker exec -i secondlayer-postgres-local psql …`:
  `INSERT INTO private_tool_grants (user_id, toolset, note) SELECT id, 'cases', 'cases toolset 11.11.2026' FROM users WHERE email IN ('2408bbb@gmail.com','maximorus@gmail.com','shepherdvovkes@gmail.com') ON CONFLICT DO NOTHING;` Перевірити `SELECT email, toolset FROM private_tool_grants g JOIN users u ON u.id=g.user_id WHERE toolset='cases'` → 3 рядки.
- [ ] **Step 3: Перевірка на проді** — `docker logs secondlayer-app-local-<колір> | grep -i '\[PrivateTools\]'` не містить «Folder not mounted» для `cases`; у Claude Code (OAuth shepherdvovkes) з'являються `cases_*`.
- [ ] **Step 4: ChatGPT** — Settings → Plugins → SecondLayer Legal AI → Refresh tools; новий чат: прикріпити 2–3 фото ухвали з `~/Downloads` і попросити «завантаж ці сторінки через cases_upload_pages». Очікувано: у відповіді шлях `<справа>/<документ>`, на cthulhu `ls /mnt/bulk_storage/CASES/<справа>/<документ>` показує `01.jpg 01.txt … _meta.json`. Якщо ChatGPT не передає `files` (порожній аргумент або відмова) — це і є відповідь на відкрите питання про `openai/fileParams`; зафіксувати в пам'яті та повернутись до Ватта за рішенням про запасний вхід.
- [ ] **Step 5: `cases_find_violations` і `cases_complaint_norms`** з ChatGPT на завантаженому документі; виміряти час виклику (лог `[MCP] Private tool served … ms`).
