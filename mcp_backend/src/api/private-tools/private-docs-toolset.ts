/**
 * A read-only document folder exposed as MCP tools to the accounts granted it.
 *
 * The folder is a bind mount (read-only) of a host directory. Each toolset is a
 * prefix (`gorenichi_`) with three tools: list, search, read. Text comes from:
 *   - `<stem>.txt` next to an image or a scanned PDF (OCR output);
 *   - `.text/<relative path>.txt` for office documents and PDFs, extracted on the host;
 *   - the file itself for plain-text formats.
 * Titles come from `_rename-map.tsv` (new path → Ukrainian title) when present.
 *
 * These tools are NOT registered in the ToolRegistry, so no other door (REST, chat,
 * workflows) can reach them; see private-tools/index.ts for the grant check.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { ToolDefinition } from '../base-tool-handler.js';

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface PrivateToolResult {
  content: McpContent[];
  isError?: boolean;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
const PLAIN_EXT = new Set(['.txt', '.html', '.htm', '.eml', '.nfo', '.info', '.csv', '.md', '.json', '.xml', '']);
const HIDDEN = (name: string) =>
  name.startsWith('.') || name === '_rename-map.tsv' || name === '_index.json' || name === '_meta.json' ||
  name.startsWith('Thumbs.db') || name.endsWith('.part');

const INDEX_TTL_MS = 5 * 60_000;
const MAX_PLAIN_BYTES = 2_000_000;
const IMAGE_MAX_SIDE = 1568;

interface DocEntry {
  path: string; // relative, forward slashes
  docId: string; // catalog document id from _index.json, '' when not catalogued
  kind: 'image' | 'pdf' | 'office' | 'text' | 'archive' | 'other';
  size: number;
  title: string;
  text: string; // '' when no text is available
}

/** One logical document (often several page photos), from `_index.json`. */
export interface CatalogDoc {
  id: string;
  folder: string;
  title: string;
  date: string;
  kind: string;
  summary: string;
  files: string[];
}

interface Catalog {
  folders: Array<{ path: string; summary: string; documents: CatalogDoc[] }>;
  byId: Map<string, CatalogDoc>;
  byFile: Map<string, CatalogDoc>;
}

/** `<case>/<document>/_meta.json`, written by the cases toolset for every uploaded document. */
export interface DocMeta {
  case_number: string | null;
  court: string | null;
  doc_kind: string;
  doc_date: string | null;
  parties: string[];
  uploaded_by?: string;
  uploaded_at?: string;
  pages: Array<{ file: string; chars: number; ocr: 'vision' | 'none' | 'failed'; reason?: string }>;
}

export class PathOutsideRootError extends Error {}

/** Resolve a client-supplied relative path inside root; throws when it escapes (.., absolute, symlink). */
export async function resolveInsideRoot(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new PathOutsideRootError('invalid path');
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, cleaned);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) throw new PathOutsideRootError('path outside folder');
  const real = await fs.realpath(candidate);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new PathOutsideRootError('path outside folder');
  return real;
}

function kindOf(name: string): DocEntry['kind'] {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods'].includes(ext)) return 'office';
  if (['.zip', '.rar', '.7z'].includes(ext)) return 'archive';
  if (PLAIN_EXT.has(ext)) return 'text';
  return 'other';
}

/** UTF-8, falling back to Windows-1251 for old Cyrillic files. */
export function decodeText(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0 || bad < utf8.length / 1000) return utf8;
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8;
  }
}

async function readIfExists(p: string, maxBytes = MAX_PLAIN_BYTES): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return decodeText(await fs.readFile(p));
  } catch {
    return null;
  }
}

export class PrivateDocsToolset {
  private index: { at: number; entries: DocEntry[]; catalog: Catalog | null } | null = null;
  private building: Promise<DocEntry[]> | null = null;

  constructor(
    /** Tool name prefix, e.g. `gorenichi`. */
    readonly id: string,
    /** Absolute folder path inside the container. */
    readonly root: string,
    /** Human label used in tool descriptions. */
    readonly label: string
  ) {}

  toolNames(): string[] {
    return this.getToolDefinitions().map((t) => t.name);
  }

  /** Drop the cached index so the next call sees files written since. */
  invalidate(): void {
    this.index = null;
  }

  getToolDefinitions(): ToolDefinition[] {
    const p = this.id;
    const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    return [
      {
        name: `${p}_get_index`,
        description:
          `ПОЧИНАЙТЕ З ЦЬОГО. Каталог приватного архіву «${this.label}»: сторінки вже згруповано в документи ` +
          `(позов, ухвала, договір, витяг тощо) з датою, типом, кількістю сторінок і коротким змістом. ` +
          `Без folder — огляд усіх папок (що в кожній, скільки документів). З folder — усі документи цієї папки з ідентифікаторами Dnnn. ` +
          `Далі читайте документ цілком: ${p}_read_document з document_id.`,
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Відносний шлях папки з огляду. Порожньо — огляд архіву.' },
          },
        },
        annotations: { title: `${this.label}: каталог документів`, ...ro },
      },
      {
        name: `${p}_list_documents`,
        description:
          `Перелік документів приватного архіву «${this.label}» (фото сторінок, скани, PDF, Word). ` +
          `Повертає шлях, тип, розмір, назву українською і чи є розпізнаний текст. ` +
          `Без folder — уся структура папок; з folder — лише ця папка.`,
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Відносний шлях папки в архіві, напр. "20261026-Rudakovi-proti-nas". Порожньо — увесь архів.' },
          },
        },
        annotations: { title: `${this.label}: перелік документів`, ...ro },
      },
      {
        name: `${p}_search_documents`,
        description:
          `Повнотекстовий пошук в архіві «${this.label}»: у назвах файлів, назвах документів і розпізнаному тексті ` +
          `(OCR фото, текст PDF/Word). Усі слова запиту мають зустрітися в документі (без урахування регістру). ` +
          `Повертає шляхи з уривками; повний текст — через ${p}_read_document.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Слова для пошуку, напр. "договір іпотеки" або кадастровий номер.' },
            folder: { type: 'string', description: 'Обмежити пошук папкою (відносний шлях).' },
            limit: { type: 'number', description: 'Максимум результатів (1-100, типово 20).' },
          },
          required: ['query'],
        },
        annotations: { title: `${this.label}: пошук`, ...ro },
      },
      {
        name: `${p}_read_document`,
        description:
          `Прочитати документ з архіву «${this.label}». document_id (Dnnn з ${p}_get_index або пошуку) — увесь документ, ` +
          `текст усіх сторінок підряд з позначками сторінок. path — один файл; для фото це OCR-текст (можливі помилки) ` +
          `плюс саме зображення сторінки (include_image), щоб звірити з оригіналом. Довгий текст — частинами через offset.`,
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'string', description: 'Ідентифікатор документа з каталогу, напр. "D157".' },
            path: { type: 'string', description: 'Відносний шлях одного файлу в архіві (замість document_id).' },
            include_image: { type: 'boolean', description: 'Лише з path, для фото: додати зображення сторінки (типово true).' },
            offset: { type: 'number', description: 'З якого символу читати текст (типово 0).' },
            max_chars: { type: 'number', description: 'Скільки символів повернути (1000-100000, типово 30000).' },
          },
        },
        annotations: { title: `${this.label}: читати документ`, ...ro },
      },
    ];
  }

  async execute(name: string, args: Record<string, any>, _ctx?: { userId?: string }): Promise<PrivateToolResult> {
    try {
      if (name === `${this.id}_get_index`) return await this.getIndex(args.folder);
      if (name === `${this.id}_list_documents`) return await this.list(args.folder);
      if (name === `${this.id}_search_documents`) return await this.search(String(args.query ?? ''), args.folder, args.limit);
      if (name === `${this.id}_read_document`) {
        if (args.document_id) return await this.readDocument(String(args.document_id), args.offset, args.max_chars);
        if (!args.path) return err('Вкажіть document_id або path.');
        return await this.read(String(args.path), args.include_image !== false, args.offset, args.max_chars);
      }
      return err(`Невідомий інструмент: ${name}`);
    } catch (e: any) {
      if (e instanceof PathOutsideRootError || e?.code === 'ENOENT') return err('Файл або папку не знайдено в архіві.');
      throw e;
    }
  }

  // ── index ────────────────────────────────────────────────────────────────

  async entries(): Promise<DocEntry[]> {
    if (this.index && Date.now() - this.index.at < INDEX_TTL_MS) return this.index.entries;
    if (!this.building) {
      this.building = Promise.all([this.loadCatalog(), this.loadTitles()])
        .then(async ([catalog, titles]) => {
          const entries = await this.buildIndex(titles, catalog);
          this.index = { at: Date.now(), entries, catalog };
          return entries;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  async catalog(): Promise<Catalog | null> {
    await this.entries();
    return this.index?.catalog ?? null;
  }

  private async loadCatalog(): Promise<Catalog | null> {
    const raw = await readIfExists(path.join(this.root, '_index.json'), 50_000_000);
    if (!raw) return this.loadMetaCatalog();
    try {
      const data = JSON.parse(raw);
      const byId = new Map<string, CatalogDoc>();
      const byFile = new Map<string, CatalogDoc>();
      const folders = (data.folders || []).map((f: any) => {
        const documents: CatalogDoc[] = (f.documents || []).map((d: any) => ({
          id: String(d.id), folder: String(f.path ?? ''), title: String(d.title ?? ''), date: String(d.date ?? ''),
          kind: String(d.kind ?? ''), summary: String(d.summary ?? ''), files: (d.files || []).map(String),
        }));
        for (const d of documents) {
          byId.set(d.id.toUpperCase(), d);
          for (const file of d.files) byFile.set(file, d);
        }
        return { path: String(f.path ?? ''), summary: String(f.summary ?? ''), documents };
      });
      return { folders, byId, byFile };
    } catch {
      return null;
    }
  }

  /**
   * Catalog from `<case>/<document>/_meta.json` (exactly two levels), for folders the cases
   * toolset writes. The document id is its path, so no Dnnn numbering is needed.
   */
  private async loadMetaCatalog(): Promise<Catalog | null> {
    const byId = new Map<string, CatalogDoc>();
    const byFile = new Map<string, CatalogDoc>();
    const folders: Catalog['folders'] = [];
    let cases: string[];
    try {
      cases = (await fs.readdir(this.root, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
    } catch {
      return null;
    }
    for (const c of cases) {
      const documents: CatalogDoc[] = [];
      let subdirs: string[] = [];
      try {
        subdirs = (await fs.readdir(path.join(this.root, c), { withFileTypes: true }))
          .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
      } catch {
        continue;
      }
      let caseNumber = '';
      for (const d of subdirs) {
        const raw = await readIfExists(path.join(this.root, c, d, '_meta.json'), 1_000_000);
        if (!raw) continue;
        let meta: DocMeta;
        try {
          meta = JSON.parse(raw);
        } catch {
          continue;
        }
        const id = `${c}/${d}`;
        const pages = Array.isArray(meta.pages) ? meta.pages : [];
        const doc: CatalogDoc = {
          id,
          folder: c,
          title: [meta.doc_kind, meta.court].filter(Boolean).join(', ') || d,
          date: meta.doc_date ?? '',
          kind: String(meta.doc_kind ?? ''),
          summary: (Array.isArray(meta.parties) ? meta.parties : []).join(', '),
          files: pages.map((p) => `${id}/${p.file}`),
        };
        if (meta.case_number && !caseNumber) caseNumber = meta.case_number;
        documents.push(doc);
        byId.set(id.toUpperCase(), doc);
        for (const f of doc.files) byFile.set(f, doc);
      }
      if (documents.length === 0) continue;
      const listing = documents.map((d) => `${d.date || 'без дати'} ${d.kind || 'документ'}`).join('; ');
      folders.push({ path: c, summary: `${caseNumber ? `Справа № ${caseNumber}` : 'Документи без номера справи'}: ${listing}`, documents });
    }
    return folders.length ? { folders, byId, byFile } : null;
  }

  private async loadTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const raw = await readIfExists(path.join(this.root, '_rename-map.tsv'), 20_000_000);
    if (!raw) return titles;
    for (const line of raw.split('\n').slice(1)) {
      const [, newPath, title] = line.split('\t');
      if (newPath && title) titles.set(newPath, title);
    }
    return titles;
  }

  private async buildIndex(titles: Map<string, string>, catalog: Catalog | null): Promise<DocEntry[]> {
    const out: DocEntry[] = [];
    const walk = async (dirRel: string): Promise<void> => {
      const dirAbs = path.join(this.root, dirRel);
      const items = await fs.readdir(dirAbs, { withFileTypes: true });
      const names = new Set(items.map((i) => i.name));
      for (const it of items) {
        if (HIDDEN(it.name)) continue;
        const rel = dirRel ? `${dirRel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (!it.isFile()) continue;
        const kind = kindOf(it.name);
        const stem = it.name.slice(0, it.name.length - path.extname(it.name).length);
        // An OCR sidecar is shown through its image, not as a document of its own.
        if (path.extname(it.name).toLowerCase() === '.txt' &&
            [...names].some((n) => n !== it.name && n.startsWith(stem + '.') && ['image', 'pdf'].includes(kindOf(n)))) {
          continue;
        }
        const st = await fs.stat(path.join(dirAbs, it.name));
        out.push({
          path: rel,
          docId: catalog?.byFile.get(rel)?.id ?? '',
          kind,
          size: st.size,
          title: titles.get(rel) ?? '',
          text: (await this.textFor(rel, kind)) ?? '',
        });
      }
    };
    await walk('');
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private async textFor(rel: string, kind: DocEntry['kind']): Promise<string | null> {
    const abs = path.join(this.root, rel);
    const ext = path.extname(rel);
    const sidecar = abs.slice(0, abs.length - ext.length) + '.txt';
    const extracted = path.join(this.root, '.text', rel + '.txt');
    if (kind === 'image') return readIfExists(sidecar);
    if (kind === 'pdf') {
      const t = await readIfExists(extracted);
      if (t && t.replace(/\s/g, '').length >= 100) return t;
      return (await readIfExists(sidecar)) ?? t;
    }
    if (kind === 'office') return readIfExists(extracted);
    // Mail, archives and signature files get a text rendering on the host when they hold content
    // (an .eml with attachments is usually far over the plain-text size cap).
    const rendered = await readIfExists(extracted);
    if (rendered) return rendered;
    if (kind === 'text') return readIfExists(abs);
    return null;
  }

  // ── tools ────────────────────────────────────────────────────────────────

  private async list(folder?: string): Promise<PrivateToolResult> {
    const prefix = await this.folderPrefix(folder);
    const rows = (await this.entries()).filter((e) => !prefix || e.path.startsWith(prefix));
    if (rows.length === 0) return ok('Документів не знайдено.');
    const lines = rows.map((e) =>
      `${e.path}\t${e.docId || '-'}\t${e.kind}\t${fmtSize(e.size)}\t${e.text ? 'текст' : 'без тексту'}${e.title ? `\t${e.title}` : ''}`
    );
    return ok(`Файлів: ${rows.length}\nшлях\tдокумент\tтип\tрозмір\tтекст\tназва\n${lines.join('\n')}`);
  }

  private async search(query: string, folder?: string, limit?: number): Promise<PrivateToolResult> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return err('Порожній запит.');
    const max = Math.min(100, Math.max(1, Number(limit) || 20));
    const prefix = await this.folderPrefix(folder);
    const hits: string[] = [];
    let total = 0;
    const entries = await this.entries();
    const catalog = this.index?.catalog ?? null;
    for (const e of entries) {
      if (prefix && !e.path.startsWith(prefix)) continue;
      const doc = e.docId ? catalog?.byId.get(e.docId.toUpperCase()) : undefined;
      const hay = `${e.path}\n${e.title}\n${doc ? `${doc.title}\n${doc.summary}\n` : ''}${e.text}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      total++;
      if (hits.length >= max) continue;
      hits.push(`• ${e.docId ? `[${e.docId}] ` : ''}${e.path}${e.title ? ` — ${e.title}` : ''}\n  ${snippet(e.text, words[0])}`);
    }
    if (total === 0) return ok(`За запитом «${query}» нічого не знайдено.`);
    return ok(`Знайдено: ${total}${total > hits.length ? ` (показано ${hits.length})` : ''}\n\n${hits.join('\n')}`);
  }

  private async read(rel: string, includeImage: boolean, offset?: number, maxChars?: number): Promise<PrivateToolResult> {
    const abs = await resolveInsideRoot(this.root, rel);
    const relNorm = path.relative(await fs.realpath(this.root), abs).split(path.sep).join('/');
    if (relNorm.split('/').some(HIDDEN)) return err('Файл або папку не знайдено в архіві.');
    const st = await fs.stat(abs);
    if (!st.isFile()) return err('Це папка, а не файл. Використайте list_documents.');
    const kind = kindOf(abs);
    const entry = (await this.entries()).find((e) => e.path === relNorm);
    const text = entry?.text ?? (await this.textFor(relNorm, kind)) ?? '';
    const from = Math.max(0, Number(offset) || 0);
    const size = Math.min(100_000, Math.max(1000, Number(maxChars) || 30_000));
    const part = text.slice(from, from + size);
    const header =
      `Файл: ${relNorm}\nТип: ${kind}, ${fmtSize(st.size)}` +
      (entry?.title ? `\nНазва: ${entry.title}` : '') +
      (text ? `\nТекст: символи ${from}-${from + part.length} з ${text.length}` +
        (from + part.length < text.length ? ` (далі: offset=${from + part.length})` : '') : '\nТексту немає.') +
      (kind === 'image' && text ? '\n(Текст розпізнано автоматично з фото, можливі помилки.)' : '');
    const content: McpContent[] = [{ type: 'text', text: part ? `${header}\n\n${part}` : header }];
    if (kind === 'image' && includeImage) {
      const jpeg = await sharp(abs, { failOn: 'none' })
        .rotate()
        .resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      content.push({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
    }
    return { content };
  }

  private async getIndex(folder?: string): Promise<PrivateToolResult> {
    const catalog = await this.catalog();
    if (!catalog) return err('Каталог архіву ще не побудовано. Скористайтеся search_documents або list_documents.');
    const total = catalog.folders.reduce((n, f) => n + f.documents.length, 0);
    const years = (docs: CatalogDoc[]) => {
      const ys = docs.map((d) => d.date.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)).sort();
      return ys.length ? (ys[0] === ys[ys.length - 1] ? ys[0] : `${ys[0]}–${ys[ys.length - 1]}`) : 'без дат';
    };
    if (!folder || !String(folder).trim() || String(folder).trim() === '/') {
      const parts = catalog.folders.map((f) =>
        `## ${f.path || '(корінь архіву)'}\n${f.documents.length} док., ${years(f.documents)}. ${f.summary}`);
      return ok(`Архів «${this.label}»: ${total} документів у ${catalog.folders.length} папках.\n` +
        `Документи папки: get_index з folder. Документ цілком: read_document з document_id.\n\n${parts.join('\n\n')}`);
    }
    const want = String(folder).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const f = catalog.folders.find((x) => x.path === want);
    if (!f) return err(`Папку «${want}» не знайдено в каталозі. Викличте get_index без folder, щоб побачити папки.`);
    const sub = catalog.folders.filter((x) => x.path !== want && x.path.startsWith(want + '/')).map((x) => x.path);
    const lines = f.documents.map((d) =>
      `${d.id} | ${d.date || 'без дати'} | ${d.kind} | ${d.files.length} стор. | ${d.title}\n   ${d.summary}`);
    return ok(`# ${f.path || '(корінь архіву)'}\n${f.summary}\n` +
      (sub.length ? `Вкладені папки: ${sub.join(', ')}\n` : '') +
      `\nДокументів: ${f.documents.length}\n\n${lines.join('\n')}`);
  }

  private async readDocument(id: string, offset?: number, maxChars?: number): Promise<PrivateToolResult> {
    const catalog = await this.catalog();
    const doc = catalog?.byId.get(id.trim().toUpperCase());
    if (!doc) return err(`Документ «${id}» не знайдено в каталозі.`);
    const pages: string[] = [];
    for (let i = 0; i < doc.files.length; i++) {
      const file = doc.files[i];
      const entry = (await this.entries()).find((e) => e.path === file);
      const t = entry?.text ?? (await this.textFor(file, kindOf(file))) ?? '';
      pages.push(`=== стор. ${i + 1}/${doc.files.length}: ${file} ===\n${t.trim() || '(без тексту)'}`);
    }
    const text = pages.join('\n\n');
    const from = Math.max(0, Number(offset) || 0);
    const size = Math.min(100_000, Math.max(1000, Number(maxChars) || 30_000));
    const part = text.slice(from, from + size);
    const header =
      `Документ ${doc.id}: ${doc.title}\nДата: ${doc.date || 'невідома'}; тип: ${doc.kind}; сторінок: ${doc.files.length}; папка: ${doc.folder || '(корінь)'}\n` +
      `Зміст: ${doc.summary}\n` +
      `Текст: символи ${from}-${from + part.length} з ${text.length}` +
      (from + part.length < text.length ? ` (далі: offset=${from + part.length})` : '') +
      `\n(Текст фото розпізнано автоматично, можливі помилки; зображення сторінки — read_document з path.)`;
    return ok(`${header}\n\n${part}`);
  }

  private async folderPrefix(folder?: string): Promise<string> {
    if (!folder || !String(folder).trim() || String(folder).trim() === '/') return '';
    const abs = await resolveInsideRoot(this.root, String(folder));
    const rel = path.relative(await fs.realpath(this.root), abs).split(path.sep).join('/');
    return rel ? rel + '/' : '';
  }
}

function ok(text: string): PrivateToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): PrivateToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function snippet(text: string, word: string): string {
  if (!text) return '(без тексту, збіг у назві)';
  const i = text.toLowerCase().indexOf(word);
  const start = Math.max(0, (i < 0 ? 0 : i) - 120);
  return text.slice(start, start + 300).replace(/\s+/g, ' ').trim() + '…';
}
