/**
 * The `cases` private toolset: photographed court case files.
 *
 * Wraps a PrivateDocsToolset (read side: index / list / search / read, like gorenichi)
 * and adds three tools of its own:
 *   - cases_upload_pages    photos from the chat → JPEG + OCR text + _meta.json in the folder
 *   - cases_find_violations the document against the code's articles, as of the document date
 *   - cases_complaint_norms current article texts a complaint must follow (no LLM)
 *
 * External services (OCR, LLM, legislation, file download) come in through the
 * constructor so the unit tests run without Vision or Azure. The folder is writable.
 * See docs/superpowers/specs/2026-11-10-court-case-photos-toolset-design.md.
 */
import { promises as fs } from 'fs';
import dns from 'dns';
import { isIP } from 'net';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import type { ToolDefinition } from '../base-tool-handler.js';
import type { LegislationReference } from '../../services/legislation-service.js';
import { logger } from '../../utils/logger.js';
import { PrivateDocsToolset, PrivateToolResult, DocMeta } from './private-docs-toolset.js';
import { CASE_CODES, COMPLAINT_KINDS, DOC_KINDS, DocKind } from './case-checklists.js';

export interface FetchedFile {
  buffer: Buffer;
  mimeType: string;
}

export interface LlmCall {
  tier: 'quick' | 'deep';
  system: string;
  user: string;
  imageJpeg?: Buffer;
  json: boolean;
}

export interface CaseToolsetDeps {
  /** OCR of one page; '' when the page holds no text; throws when the service fails. */
  ocr: (image: Buffer, mimeType: string) => Promise<string>;
  /** Raw text of the model's answer. */
  llm: (call: LlmCall) => Promise<string>;
  legislation: { getMultipleArticles(radaId: string, numbers: string[], asOfDate?: string): Promise<LegislationReference[]> };
  /** Download of one chat file; defaults to fetchFileSafely. */
  fetchFile?: (url: string) => Promise<FetchedFile>;
  now?: () => Date;
}

const NOT_CONFIGURED = 'Сервіс аналізу справ не налаштовано на цьому сервері.';

const MAX_FILES = 15;
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const JPEG_MAX_SIDE = 2500;
const PARALLEL = 4;
const FETCH_TIMEOUT_MS = 30_000;
const NO_CASE_FOLDER = '_без-номера';
const UNSUPPORTED_FORMAT = 'формат не підтримується, збережіть як JPEG';

// ── naming ───────────────────────────────────────────────────────────────

/** Case number → folder: '369/1234/26' → '369_1234_26'; anything unusable → '_без-номера'. */
export function sanitizeCaseFolder(caseNumber: string | null | undefined): string {
  if (typeof caseNumber !== 'string') return NO_CASE_FOLDER;
  const cleaned = caseNumber.trim().replace(/\//g, '_').replace(/[^0-9A-Za-zА-ЯІЇЄҐа-яіїєґ_-]/g, '').slice(0, 60);
  if (!cleaned || cleaned.startsWith('.') || cleaned.startsWith('_') || !/[0-9A-Za-zА-ЯІЇЄҐа-яіїєґ]/.test(cleaned)) return NO_CASE_FOLDER;
  return cleaned;
}

function slug(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^0-9a-zа-яіїєґ]+/g, '-').replace(/^-+|-+$/g, '');
}

/** '<YYYY-MM-DD|без-дати>-<вид>-<суд>', at most 80 characters. */
export function documentFolderName(meta: { doc_date: string | null; doc_kind: string; court: string | null }): string {
  const parts = [meta.doc_date ?? 'без-дати', slug(meta.doc_kind) || 'інше', slug(meta.court)].filter(Boolean);
  return parts.join('-').slice(0, 80).replace(/-+$/, '');
}

// ── download ─────────────────────────────────────────────────────────────

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
    if (/^f[cd]/.test(lower)) return true; // fc00::/7
    return false;
  }
  return true; // not an IP at all: refuse
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

/** Download over https only, no redirects, never to a private/loopback/link-local address, capped in size and time. */
export async function fetchFileSafely(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<FetchedFile> {
  const maxBytes = opts?.maxBytes ?? MAX_BYTES;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('некоректна адреса файлу');
  }
  if (u.protocol !== 'https:') throw new Error('дозволено лише https');
  const addrs = await dns.promises.lookup(u.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('адреса файлу не дозволена');
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(opts?.timeoutMs ?? FETCH_TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) throw new Error('редірект не дозволено');
  if (!res.ok) throw new Error(`сервер відповів ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('файл більший за 20 МБ');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('файл більший за 20 МБ');
  const mimeType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  return { buffer, mimeType };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface IncomingPage {
  index: number; // 0-based
  buffer?: Buffer;
  mimeType?: string;
  failed?: string;
}

interface StoredPage {
  index: number;
  file: string;
  jpeg?: Buffer;
  text: string;
  ocr: 'vision' | 'none' | 'failed';
  reason?: string;
}

const NAMING_SYSTEM =
  'Ти визначаєш реквізити українського судового або адміністративного документа за розпізнаним текстом ' +
  'перших сторінок і фото першої сторінки. Поверни ЛИШЕ JSON без пояснень: ' +
  '{"case_number": "<номер справи, напр. 369/1234/26, або null>", "court": "<повна назва суду або органу, або null>", ' +
  '"doc_kind": "<одне з: ухвала, рішення, постанова, вирок, протокол, інше>", ' +
  '"doc_date": "<дата документа YYYY-MM-DD або null>", "parties": ["<сторони або особи>"]}. ' +
  'Не вигадуй: чого не видно, те null.';

function parseNaming(raw: string): Pick<DocMeta, 'case_number' | 'court' | 'doc_kind' | 'doc_date' | 'parties'> {
  const empty = { case_number: null, court: null, doc_kind: 'інше', doc_date: null, parties: [] as string[] };
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const j = JSON.parse(cleaned);
    if (!j || typeof j !== 'object') return empty;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const kind = str(j.doc_kind);
    return {
      case_number: str(j.case_number),
      court: str(j.court),
      doc_kind: kind && (DOC_KINDS as string[]).includes(kind) ? kind : 'інше',
      doc_date: typeof j.doc_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.doc_date) ? j.doc_date : null,
      parties: Array.isArray(j.parties) ? j.parties.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean) : [],
    };
  } catch {
    return empty;
  }
}

export class CaseToolset {
  readonly id: string;

  constructor(
    readonly docs: PrivateDocsToolset,
    private readonly deps: CaseToolsetDeps | null
  ) {
    this.id = docs.id;
  }

  toolNames(): string[] {
    return this.getToolDefinitions().map((t) => t.name);
  }

  getToolDefinitions(): ToolDefinition[] {
    const p = this.id;
    const label = this.docs.label;
    const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    return [
      ...this.docs.getToolDefinitions(),
      {
        name: `${p}_upload_pages`,
        description:
          `Завантажити фото сторінок ОДНОГО судового документа (ухвала, рішення, постанова, протокол) у папку справ «${label}». ` +
          `Передайте файли з чату у files; інші клієнти — pages_base64. Тул розпізнає текст (OCR), визначає номер справи, ` +
          `суд, вид і дату документа, кладе фото і текст поруч. До 15 сторінок за виклик. ` +
          `Далі: ${p}_find_violations з document із відповіді.`,
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: 'Файли, прикріплені в чаті (ChatGPT підставляє їх сам).',
              items: {
                type: 'object',
                properties: {
                  download_url: { type: 'string' },
                  file_id: { type: 'string' },
                  mime_type: { type: 'string' },
                  file_name: { type: 'string' },
                },
                required: ['download_url', 'file_id'],
              },
            },
            pages_base64: {
              type: 'array',
              description: 'Для клієнтів без передачі файлів: сторінки як base64 (JPEG/PNG/WEBP), у порядку сторінок.',
              items: {
                type: 'object',
                properties: { data: { type: 'string' }, mime_type: { type: 'string' } },
                required: ['data', 'mime_type'],
              },
            },
            case_hint: { type: 'string', description: 'Номер справи або підказка словами, якщо на фото його не видно.' },
            document_hint: { type: 'string', description: 'Вид документа, якщо відомий (ухвала, рішення, постанова, вирок, протокол).' },
          },
        },
        annotations: { title: `${label}: завантажити сторінки`, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        _meta: { 'openai/fileParams': ['files'] },
      },
      {
        name: `${p}_find_violations`,
        description:
          `Знайти процесуальні порушення в судовому документі з папки «${label}» (або у вставленому тексті): ` +
          `тул бере статті кодексу про зміст і порядок такого документа в редакції на дату документа, порівнює і повертає ` +
          `таблицю порушень із цитатами, окремо «не видно з фото», і повні тексти статей з датою редакції. Один виклик — один документ.`,
        inputSchema: {
          type: 'object',
          properties: {
            document: { type: 'string', description: `Шлях папки документа «<справа>/<документ>» з ${p}_get_index або з відповіді ${p}_upload_pages.` },
            text: { type: 'string', description: 'Текст документа, якщо він не в папці.' },
            code: { type: 'string', enum: CASE_CODES, description: 'Кодекс; без нього визначає модель.' },
            doc_kind: { type: 'string', enum: DOC_KINDS.filter((k) => k !== 'інше'), description: 'Вид документа; без нього визначає модель.' },
          },
        },
        annotations: { title: `${label}: процесуальні порушення`, ...ro },
      },
      {
        name: `${p}_complaint_norms`,
        description:
          `Чинні норми для скарги: право на оскарження, строк, форма і зміст скарги, куди подавати, судовий збір. ` +
          `Повні тексти статей з датою редакції. Саму скаргу складає модель; тул лише дає актуальні норми.`,
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: CASE_CODES },
            complaint_kind: { type: 'string', enum: COMPLAINT_KINDS },
          },
          required: ['code', 'complaint_kind'],
        },
        annotations: { title: `${label}: норми для скарги`, ...ro },
      },
    ];
  }

  async execute(name: string, args: Record<string, any>): Promise<PrivateToolResult> {
    const own = name === `${this.id}_upload_pages` || name === `${this.id}_find_violations` || name === `${this.id}_complaint_norms`;
    if (!own) return this.docs.execute(name, args);
    if (!this.deps) return err(NOT_CONFIGURED);
    if (name === `${this.id}_upload_pages`) return this.upload(args);
    if (name === `${this.id}_find_violations`) return this.findViolations(args);
    return this.complaintNorms(args);
  }

  // ── cases_upload_pages ─────────────────────────────────────────────────

  private async upload(args: Record<string, any>): Promise<PrivateToolResult> {
    const deps = this.deps!;
    const files: any[] = Array.isArray(args.files) ? args.files.filter((f) => f && typeof f.download_url === 'string') : [];
    const b64: any[] = Array.isArray(args.pages_base64) ? args.pages_base64.filter((f) => f && typeof f.data === 'string') : [];
    if (files.length + b64.length === 0) return err('Передайте фото сторінок у files (ChatGPT) або pages_base64.');
    if (files.length + b64.length > MAX_FILES) return err(`Не більше ${MAX_FILES} сторінок за один виклик: один виклик — один документ.`);

    // Base64 pages are checked up front: they are already in memory, so a bad one fails the call.
    const incoming: IncomingPage[] = [];
    for (const f of files) incoming.push({ index: incoming.length });
    for (const p of b64) {
      const mime = String(p.mime_type || '').toLowerCase();
      if (!ALLOWED_MIME.has(mime)) return err(`Сторінка ${incoming.length + 1}: ${UNSUPPORTED_FORMAT} (отримано ${mime || 'без типу'}).`);
      const buffer = Buffer.from(p.data, 'base64');
      if (buffer.length > MAX_BYTES) return err(`Сторінка ${incoming.length + 1}: файл більший за 20 МБ.`);
      incoming.push({ index: incoming.length, buffer, mimeType: mime });
    }

    // 1. Download everything first (parallel ×4); a failed page is marked, not fatal.
    const fetchFile = deps.fetchFile ?? fetchFileSafely;
    await mapLimit(files, PARALLEL, async (f, i) => {
      try {
        const got = await fetchFile(String(f.download_url));
        const mime = ALLOWED_MIME.has(got.mimeType) ? got.mimeType : String(f.mime_type || '').toLowerCase();
        if (!ALLOWED_MIME.has(mime)) {
          incoming[i].failed = UNSUPPORTED_FORMAT;
          return;
        }
        incoming[i].buffer = got.buffer;
        incoming[i].mimeType = mime;
      } catch (e: any) {
        incoming[i].failed = `не вдалося завантажити (${e?.message || 'помилка'})`;
      }
    });

    // 2. Normalise to JPEG and write to a staging folder so nothing is lost after this point.
    const staging = path.join(this.docs.root, `.incoming-${Date.now()}-${randomBytes(3).toString('hex')}`);
    await fs.mkdir(staging, { recursive: true });
    const pages: StoredPage[] = [];
    for (const p of incoming) {
      const file = `${String(p.index + 1).padStart(2, '0')}.jpg`;
      if (p.failed || !p.buffer) {
        pages.push({ index: p.index, file, text: '', ocr: 'failed', reason: p.failed || 'порожній файл' });
        continue;
      }
      try {
        const jpeg = await sharp(p.buffer, { failOn: 'none' })
          .rotate()
          .resize({ width: JPEG_MAX_SIDE, height: JPEG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        await fs.writeFile(path.join(staging, file), jpeg);
        pages.push({ index: p.index, file, jpeg, text: '', ocr: 'none' });
      } catch {
        pages.push({ index: p.index, file, text: '', ocr: 'failed', reason: UNSUPPORTED_FORMAT });
      }
    }
    const stored = pages.filter((p) => p.jpeg);
    if (stored.length === 0) {
      await fs.rm(staging, { recursive: true, force: true });
      return err(`Жодну сторінку не вдалося завантажити: ${pages.map((p) => `стор. ${p.index + 1}: ${p.reason}`).join('; ')}`);
    }

    // 3. OCR (parallel ×4), text next to each image, empty file for a blank page.
    await mapLimit(stored, PARALLEL, async (p) => {
      try {
        p.text = (await deps.ocr(p.jpeg!, 'image/jpeg')).trim();
        p.ocr = p.text ? 'vision' : 'none';
      } catch (e: any) {
        p.ocr = 'failed';
        p.reason = `OCR: ${e?.message || 'помилка'}`;
      }
      await fs.writeFile(path.join(staging, p.file.replace(/\.jpg$/, '.txt')), p.text, 'utf8');
    });

    // 4. One quick model call names the document; any failure lands it in _без-номера.
    let naming = parseNaming('');
    try {
      const sample = stored.slice(0, 3).map((p) => `=== стор. ${p.index + 1} ===\n${p.text.slice(0, 6000)}`).join('\n\n');
      const hints = [args.case_hint ? `Підказка щодо справи: ${String(args.case_hint).slice(0, 200)}` : '',
        args.document_hint ? `Підказка щодо виду документа: ${String(args.document_hint).slice(0, 200)}` : ''].filter(Boolean).join('\n');
      naming = parseNaming(await deps.llm({
        tier: 'quick', json: true, system: NAMING_SYSTEM,
        user: `${hints ? hints + '\n\n' : ''}Розпізнаний текст:\n${sample || '(текст не розпізнано, дивись фото)'}`,
        imageJpeg: stored[0].jpeg,
      }));
    } catch (e: any) {
      logger.warn('[Cases] Naming model failed, filing under _без-номера', { error: e?.message });
    }
    if (!naming.case_number && typeof args.case_hint === 'string' && /\d+\/\d+\/\d+/.test(args.case_hint)) {
      naming.case_number = args.case_hint.match(/\d+\/\d+\/\d+(?:-[\wа-яіїєґ]+)?/i)![0];
    }

    // 5. Final folder, never overwriting an earlier upload.
    const caseFolder = sanitizeCaseFolder(naming.case_number);
    const baseName = documentFolderName(naming);
    await fs.mkdir(path.join(this.docs.root, caseFolder), { recursive: true });
    let docFolder = baseName;
    for (let n = 2; await exists(path.join(this.docs.root, caseFolder, docFolder)); n++) docFolder = `${baseName}-${n}`;
    const rel = `${caseFolder}/${docFolder}`;
    const meta: DocMeta = {
      ...naming,
      uploaded_by: typeof args.__userId === 'string' ? args.__userId : undefined,
      uploaded_at: (deps.now ?? (() => new Date()))().toISOString(),
      pages: pages.map((p) => ({ file: p.file, chars: p.text.length, ocr: p.ocr, ...(p.reason ? { reason: p.reason } : {}) })),
    };
    await fs.writeFile(path.join(staging, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    await fs.rename(staging, path.join(this.docs.root, caseFolder, docFolder));
    this.docs.invalidate();

    const lines = pages.map((p) => {
      if (p.ocr === 'failed') return `стор. ${p.index + 1}: ${p.reason}`;
      if (p.ocr === 'none') return `стор. ${p.index + 1}: без тексту — перезніміть сторінку`;
      return `стор. ${p.index + 1}: ${p.text.length} символів`;
    });
    return ok(
      `Збережено: ${rel}\nСторінок: ${pages.length} (успішно ${stored.length})\n` +
      `Модель визначила: справа ${naming.case_number ?? 'не визначено'}, суд ${naming.court ?? 'не визначено'}, ` +
      `вид ${naming.doc_kind}, дата ${naming.doc_date ?? 'не визначено'}, сторони ${naming.parties.length ? naming.parties.join(', ') : 'не визначено'}\n` +
      `${lines.join('\n')}\n` +
      `Далі: ${this.id}_find_violations з document="${rel}".`
    );
  }

  private async findViolations(_args: Record<string, any>): Promise<PrivateToolResult> {
    throw new Error('not implemented');
  }

  private async complaintNorms(_args: Record<string, any>): Promise<PrivateToolResult> {
    throw new Error('not implemented');
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function ok(text: string): PrivateToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): PrivateToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
