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
import type { ToolDefinition } from '../base-tool-handler.js';
import type { LegislationReference } from '../../services/legislation-service.js';
import { PrivateDocsToolset, PrivateToolResult } from './private-docs-toolset.js';
import { CASE_CODES, COMPLAINT_KINDS, DOC_KINDS } from './case-checklists.js';

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

  private async upload(_args: Record<string, any>): Promise<PrivateToolResult> {
    throw new Error('not implemented');
  }

  private async findViolations(_args: Record<string, any>): Promise<PrivateToolResult> {
    throw new Error('not implemented');
  }

  private async complaintNorms(_args: Record<string, any>): Promise<PrivateToolResult> {
    throw new Error('not implemented');
  }
}

function err(text: string): PrivateToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
