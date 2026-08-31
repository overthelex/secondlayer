/**
 * Court Decision Tools - Handlers for court decision retrieval and analysis
 *
 * 8 tools:
 * - get_court_decision
 * - get_case_documents_chain
 * - extract_document_sections
 * - load_full_texts
 * - bulk_ingest_court_decisions
 * - analyze_case_pattern
 * - count_cases_by_party
 * - get_decision_cited_norms
 */

import { EdsrLocalAdapter } from '../../adapters/edrsr-local-adapter.js';
import type { EdsrFtsService } from '../../services/edrsr-fts-service.js';
import { cleanEdrsrTextSql } from '../../services/edrsr-fts-service.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import type { IEmbeddingPort } from '../../domain/ports/index.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import type { CitationGraphService } from '../../services/citation-graph-service.js';
import { SectionType } from '../../types/index.js';

/** Preview kept on get_court_decision when the same text is already returned as sections. */
const FULL_TEXT_PREVIEW_CHARS = 2000;

/**
 * Per-section ceiling for get_court_decision.
 *
 * The sectionizer does not always segment: on doc 117473073 it returned ONE section of type
 * HEADER holding all 138,139 characters, so `depth` could not bound anything — asking for a
 * single section still returned the whole decision. Even after dropping the duplicated
 * full_text the response was 143K characters and still exceeded an MCP client's token limit.
 * Bounding each section keeps the response transportable whatever the sectionizer returns;
 * continuous text is available through load_full_texts.
 */
const SECTION_TEXT_CAP = 40000;
import { logger } from '../../utils/logger.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { generateCaseNumberVariations, extractSnippets, resolveCauseNumber, edrsrPool, formatCourtDate } from '../tool-utils.js';
import { detectDamagedCourtText, DAMAGED_TEXT_REASON } from '../../services/edrsr-text-integrity.js';

/** Chain rows carry `full_text` inline; keep the shape, refuse damaged content. */
function guardChainText(text: string): Record<string, unknown> {
  const kind = detectDamagedCourtText(text);
  return kind
    ? { text_unavailable: { kind, reason: DAMAGED_TEXT_REASON[kind] } }
    : { full_text: text };
}

/**
 * Resolve requested judgment-form names ("Рішення", "постанови") to the
 * judgment_code values present in a case. The registry has 8 forms (Вирок,
 * Постанова, Рішення, Судовий наказ, Ухвала, Окрема ухвала, Додаткове рішення,
 * Окрема думка), so matching on a stem of each word is unambiguous while still
 * absorbing LLM-supplied inflections — and "Рішення" deliberately also selects
 * "Додаткове рішення", "Ухвала" also "Окрема ухвала".
 */
function matchJudgmentCodes(requested: string[], names: Map<number, string>): number[] {
  const stem = (word: string) => word.slice(0, Math.max(4, word.length - 2));
  const wanted = requested
    .map(r => r.toLowerCase().trim())
    .filter(Boolean)
    .map(r => ({ full: r, stems: r.split(/\s+/).map(stem) }));

  const codes: number[] = [];
  for (const [code, rawName] of names) {
    const name = (rawName || '').toLowerCase().trim();
    if (!name) continue;
    const nameWords = name.split(/\s+/);
    const hit = wanted.some(w =>
      name.includes(w.full) || w.stems.every(s => nameWords.some(nw => nw.startsWith(s)))
    );
    if (hit) codes.push(code);
  }
  return codes;
}

export class CourtDecisionTools extends BaseToolHandler {
  constructor(
    private zoAdapter: EdsrLocalAdapter,
    private zoPracticeAdapter: EdsrLocalAdapter,
    private sectionizer: SemanticSectionizer,
    private embeddingService: IEmbeddingPort,
    private patternStore: LegalPatternStore,
    private db?: any,
    private ftsService?: EdsrFtsService,
    private citationGraphService?: CitationGraphService
  ) {
    super();
  }

  /**
   * Pool for the EDRSR corpus tables (edrsr_documents / edrsr_fulltext /
   * edrsr_courts / edrsr_judgment_forms). When EDRSR_DATABASE_URL is set
   * (stage → Brev edrsr_local), route these reads to the dedicated EDRSR pool.
   * Otherwise (prod, where the corpus is co-located in the main DB) fall back
   * to this.db — byte-identical to the previous behaviour.
   */
  private edrsrDb(): any {
    return edrsrPool(this.ftsService, this.db);
  }

  /** True when reads are routed to the dedicated EDRSR pool (stage). */
  private usingDedicatedEdrsr(): boolean {
    return !!this.ftsService?.getDedicatedPool();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'get_court_decision',
        annotations: { title: 'Судове рішення (повний текст)', readOnlyHint: true },
        description: `Завантаження повного тексту судового рішення та витяг секцій (ФАКТИ / МОТИВУВАННЯ / РІШЕННЯ)

Завантажує рішення за doc_id або номером справи, парсить HTML, витягує структуровані секції.
Використовуйте для глибокого аналізу конкретного рішення — аргументації суду, фактичних обставин, резолютивної частини.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: { type: ['string', 'number'] },
            case_number: { type: 'string' },
            depth: { type: 'number', default: 2 },
            reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'standard' },
            include_citations: {
              type: 'boolean',
              default: true,
              description: 'Додати зведення цитованих статей з графа цитувань (Neo4j). Активне лише коли CITATION_BACKEND=neo4j; інакше ігнорується.',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_case_documents_chain',
        annotations: { title: 'Ланцюг документів справи', readOnlyHint: true },
        description: `Отримання всіх пов'язаних документів справи через усі інстанції

Знаходить ВСІ судові документи за номером справи:
- Рішення першої інстанції
- Постанови апеляційної інстанції
- Постанови касаційної інстанції (КЦС/КГС/КАС/ККС ВС)
- Постанови Великої Палати ВС
- Ухвали (про відкриття, зупинення тощо)
- Рішення після нового розгляду

Повертає структурований список з групуванням за інстанціями.
Використовуйте для аналізу повної історії справи або відстеження позиції суду через інстанції.

ВАЖЛИВО про обсяг: у великих справах (банкрутство, тривалі провадження) буває кілька сотень документів,
а за один виклик повертається максимум 100. Тому:
- \`total_documents\` — СКІЛЬКИ ДОКУМЕНТІВ У СПРАВІ ВЗАГАЛІ, \`returned_documents\` — скільки повернуто зараз;
- якщо \`has_more: true\` — ти бачиш лише частину; \`summary\` рахується по ВСІЙ справі, не по вибірці;
- за замовчуванням (\`sort: "balanced"\`) повертається початок справи + найновіші документи, щоб було видно і початок, і чим справа закінчилась;
- для решти документів використовуй \`offset\` разом із \`sort: "asc"\`/\`"desc"\`;
- для звіту про результат розгляду фільтруй \`document_types: ["Рішення", "Постанова"]\` — в процесуальних справах 90%+ документів це ухвали, які лише засмічують контекст.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: {
              type: 'string',
              description: 'Номер справи (наприклад, "123/456/23")'
            },
            include_full_text: {
              type: 'boolean',
              default: false,
              description: 'Включити повний текст документів. Встановіть true коли потрібен текст рішення, аналіз аргументації або глибокий аналіз змісту. false повертає лише метадані (суд, дата, тип).'
            },
            max_docs: {
              type: 'number',
              default: 50,
              description: 'Макс. документів для повернення (1-100). Це ліміт вибірки, а не кількість документів у справі — див. total_documents.'
            },
            group_by_instance: {
              type: 'boolean',
              default: true,
              description: 'Групувати документи за інстанціями (перша/апеляція/касація)'
            },
            sort: {
              type: 'string',
              enum: ['balanced', 'asc', 'desc'],
              default: 'balanced',
              description: 'Порядок вибірки: "balanced" — початок справи + найновіші документи (за замовчуванням); "asc" — найдавніші; "desc" — найновіші (чим справа закінчилась). Для гортання разом з offset використовуй asc або desc.'
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Пропустити N документів (для гортання великих справ). Працює з sort=asc/desc.'
            },
            document_types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Фільтр за формою судового рішення: "Рішення", "Постанова", "Ухвала", "Вирок", "Судовий наказ". Для звіту про результат розгляду бери ["Рішення", "Постанова"].'
            },
          },
          required: ['case_number'],
        },
      },
      {
        name: 'extract_document_sections',
        annotations: { title: 'Витяг секцій рішення', readOnlyHint: true },
        description: `Витяг структурованих секцій із повного тексту судового рішення (ФАКТИ / МОТИВУВАННЯ / РІШЕННЯ)

Розбиває текст рішення на логічні блоки: встановлені обставини, мотивувальна частина, резолютивна частина.
При use_llm=false — швидкий парсинг за шаблонами. При use_llm=true — точна екстракція через LLM.
Використовуйте після get_court_decision або get_edrsr_decision_fulltext для структурного аналізу.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: ['string', 'number'],
              description: 'ID документа для завантаження повного тексту'
            },
            document_id: {
              type: 'string',
              description: 'Альтернативна назва для doc_id'
            },
            text: {
              type: 'string',
              description: 'Повний текст документа (якщо вже є)'
            },
            use_llm: { type: 'boolean', default: false, description: 'Використати LLM для точнішої екстракції секцій' },
          },
          required: [],
        },
      },
      {
        name: 'load_full_texts',
        annotations: { title: 'Завантаження текстів рішень' },
        description: `Завантаження повних текстів судових рішень у базу даних

Завантажує тексти рішень за масивом doc_id, перевіряє наявність у PostgreSQL/Redis кеші перед завантаженням.
Використовуйте для попереднього завантаження текстів перед масовим аналізом.

ВАЖЛИВО: за замовчуванням інструмент лише завантажує тексти в кеш і НЕ повертає їх — для читання кожного документа потрібен окремий get_court_decision, що витрачає бюджет викликів.
Встановіть return_texts=true, щоб одразу отримати ключові секції (мотивувальна + резолютивна частини + застосовані норми) усіх документів ОДНИМ викликом — це економить бюджет викликів і одразу дає позицію суду та застосовані норми. Саме початок рішення (шапка, історія розгляду) не повертається як малоінформативний.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Масив ID документів для завантаження (наприклад, [110679112, 110441965])'
            },
            max_docs: {
              type: 'number',
              default: 1000,
              description: 'Макс. документів для завантаження (захист від перевантаження)'
            },
            batch_size: {
              type: 'number',
              default: 100,
              description: 'Розмір батчу для обробки'
            },
            return_texts: {
              type: 'boolean',
              default: false,
              description: 'Повернути ключові секції (мотивувальна + резолютивна + застосовані норми) кожного документа одразу, замість окремих get_court_decision. Економить бюджет викликів.'
            },
            snippet_chars: {
              type: 'number',
              default: 4000,
              description: 'Макс. символів витягу на документ (лише коли return_texts=true). За замовчуванням 4000.'
            }
          },
          required: ['doc_ids'],
        },
      },
      {
        name: 'bulk_ingest_court_decisions',
        annotations: { title: 'Масова індексація рішень' },
        description: `Масове завантаження та індексація судових рішень (пагінація + векторизація)

Виконує повний цикл:
1) Пошук рішень за запитом (сторінки по 1000)
2) Завантаження повних текстів для нових документів
3) Витяг секцій (РІШЕННЯ + МОТИВУВАННЯ) + ембедінги + індексація в Qdrant

За замовчуванням фільтрує date_from=today-3y. Використовуйте для побудови бази практики за конкретною темою.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (наприклад: "поновлення строку апеляції несвоєчасне отримання повного тексту")'
            },
            date_from: { type: 'string', description: 'YYYY-MM-DD (за замовчуванням today-3y)' },
            date_to: { type: 'string', description: 'YYYY-MM-DD (опціонально)' },
            max_docs: {
              type: 'number',
              default: 1000,
              description: 'Макс. унікальних doc_id для завантаження (ліміт безпеки)'
            },
            max_pages: {
              type: 'number',
              default: 50,
              description: 'Макс. сторінок пошуку (по 1000 результатів)'
            },
            page_size: {
              type: 'number',
              default: 1000,
              description: 'Розмір сторінки пошуку (макс. 1000)'
            },
            supreme_court_hint: {
              type: 'boolean',
              default: false,
              description: 'Додати фільтр ВС (Верховний Суд / КЦС / КГС / КАС / ККС / Велика Палата). false — максимальне охоплення.'
            }
          },
          required: ['query'],
        },
      },
      {
        name: 'analyze_case_pattern',
        annotations: { title: 'Аналіз патернів практики', readOnlyHint: true },
        description: `Аналіз патернів судової практики: аргументи, ризики, статистика результатів

Підтримує два методи:
- text (за замовчуванням) — пошук патернів за текстовим запитом
- embedding — семантичний пошук через векторні embeddings (знаходить success_arguments / risk_factors)

Аналізує існуючі справи в базі. Повертає: успішні аргументи, фактори ризику, статистику задоволення позовів.`,
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string', description: 'Текстовий опис наміру / ситуації для аналізу' },
            query: { type: 'string', description: 'Альтернативна назва для intent' },
            case_ids: { type: 'array', items: { type: 'string' }, description: 'ID справ для витягу нових паттернів' },
            documents: { type: 'array', items: { type: 'object' }, description: 'Документи для контексту (embedding метод)' },
            method: { type: 'string', enum: ['text', 'embedding', 'auto'], default: 'auto', description: 'Метод аналізу' },
          },
          required: ['intent'],
        },
      },
      {
        name: 'count_cases_by_party',
        annotations: { title: 'Кількість справ за стороною', readOnlyHint: true },
        description: `Підрахунок точної кількості судових справ за назвою сторони (позивач/відповідач)

Використовує пагінацію для точного підрахунку всіх справ.
Використовуйте для due diligence — перевірки судової активності компанії або особи.`,
        inputSchema: {
          type: 'object',
          properties: {
            party_name: {
              type: 'string',
              description: 'Назва компанії або ПІБ (наприклад, "Фінансова компанія Фангарант груп")'
            },
            party_type: {
              type: 'string',
              enum: ['plaintiff', 'defendant', 'any'],
              default: 'any',
              description: 'Тип сторони: позивач (plaintiff), відповідач (defendant), або будь-яка (any)'
            },
            date_from: {
              type: 'string',
              description: 'Дата початку періоду пошуку (YYYY-MM-DD)'
            },
            date_to: {
              type: 'string',
              description: 'Дата кінця періоду пошуку (YYYY-MM-DD)'
            },
            return_cases: {
              type: 'boolean',
              default: false,
              description: 'Повернути список справ разом з підрахунком'
            },
            max_cases_to_return: {
              type: 'number',
              default: 100,
              description: 'Макс. справ для повернення у списку (за замовчуванням 100)'
            }
          },
          required: ['party_name'],
        },
      },
      {
        name: 'get_decision_cited_norms',
        annotations: { title: 'Норми, цитовані рішенням', readOnlyHint: true, idempotentHint: true },
        description: `Перелік норм законодавства, на які фактично посилається судове рішення (граф цитувань legislation_citation_links)

Повертає розв'язані посилання рішення на статті законодавства: rada_id закону/кодексу та базовий номер статті, згруповані з кількістю згадок, плюс загальну кількість таких посилань.
total_resolved_links=0 означає відсутність даних графа для цього рішення, а НЕ відсутність цитувань у тексті.
Використовуйте для детермінованої перевірки, чи посилається рішення на конкретну норму («суд застосував ст. X у справі Y»).`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: { type: ['string', 'number'], description: 'doc_id рішення в ЄДРСР' },
          },
          required: ['doc_id'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'get_court_decision':
        return await this.getCourtDecision(args);
      case 'get_case_documents_chain':
        return await this.getCaseDocumentsChain(args);
      case 'extract_document_sections':
        return await this.extractDocumentSections(args);
      case 'load_full_texts':
        return await this.loadFullTexts(args);
      case 'bulk_ingest_court_decisions':
        return await this.bulkIngestCourtDecisions(args);
      case 'analyze_case_pattern':
      case 'analyze_legal_patterns': // backward-compat alias
        return await this.analyzeCasePattern(args);
      case 'count_cases_by_party':
        return await this.countCasesByParty(args);
      case 'get_decision_cited_norms':
        return await this.getDecisionCitedNorms(args);
      default:
        return null;
    }
  }

  /**
   * Deterministic norm-attribution lookup (CORE-103): which legislation articles a
   * decision actually cites, per the citation graph (legislation_citation_links,
   * resolved rows only, grouped to base article numbers). The chat verify phase uses
   * this to catch «суд застосував ст. X у справі Y» claims the decision's own
   * citation edges do not support. Fail-soft: any failure (missing table on local,
   * no DB) → total_resolved_links=0, which callers must read as "no graph data",
   * never as "the decision cites nothing".
   */
  private async getDecisionCitedNorms(args: any): Promise<ToolResult> {
    const docId = Number(args.doc_id);
    if (!Number.isFinite(docId) || docId <= 0) {
      return this.wrapResponse({
        error: `doc_id має бути додатним числом, отримано "${args.doc_id}"`,
        provided_value: args.doc_id,
      });
    }
    if (!this.db) {
      return this.wrapResponse({ doc_id: docId, total_resolved_links: 0, norms: [], note: 'database unavailable' });
    }
    try {
      const res = await this.db.query(
        `SELECT l.rada_id,
                lcl.legislation_id,
                split_part(lcl.article_number, '.', 1) AS article_base,
                count(*)::int AS links
           FROM legislation_citation_links lcl
           JOIN legislation l ON l.id = lcl.legislation_id
          WHERE lcl.doc_id = $1 AND lcl.resolved = true AND lcl.article_number IS NOT NULL
          GROUP BY l.rada_id, lcl.legislation_id, split_part(lcl.article_number, '.', 1)
          ORDER BY count(*) DESC
          LIMIT 300`,
        [docId]
      );
      const norms = res.rows.map((r: any) => ({
        rada_id: r.rada_id,
        legislation_id: r.legislation_id,
        article_base: r.article_base,
        links: r.links,
      }));
      return this.wrapResponse({
        doc_id: docId,
        total_resolved_links: norms.reduce((s: number, n: any) => s + n.links, 0),
        norms,
      });
    } catch (error: any) {
      logger.warn('[get_decision_cited_norms] lookup failed (fail-soft)', { docId, error: error?.message });
      return this.wrapResponse({ doc_id: docId, total_resolved_links: 0, norms: [], note: error?.message });
    }
  }

  private async getCourtDecision(args: any): Promise<ToolResult> {
    const docIdRaw = args.doc_id ?? args.document_id ?? args.case_id;
    const caseNumber = typeof args.case_number === 'string' ? args.case_number.trim() : '';
    const depth = Math.min(5, Math.max(1, Number(args.depth || 2)));
    const budget = args.reasoning_budget || 'standard';

    logger.info('[MCP Tool] get_court_decision started', {
      docId: docIdRaw,
      caseNumber,
      depth,
      budget
    });

    let docId: number | null = null;
    if (docIdRaw !== undefined && docIdRaw !== null && String(docIdRaw).trim().length > 0) {
      const n = Number(docIdRaw);
      if (!Number.isNaN(n) && Number.isFinite(n)) docId = n;
    }

    if (!docId && !caseNumber) {
      throw new Error('Provide doc_id (preferred) or case_number');
    }

    if (!this.db) {
      return this.wrapError('Database not configured');
    }

    let row: any = null;

    if (docId) {
      const result = await this.edrsrDb().query(`
        SELECT
          d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
          d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
          d.doc_url, d.status, d.date_publ,
          ${cleanEdrsrTextSql('f.full_text')} AS full_text
        FROM edrsr_documents d
        LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        WHERE d.doc_id = $1
      `, [docId]);

      if (result.rows.length > 0) {
        row = result.rows[0];
      } else {
        // Try fulltext-only
        const ftResult = await this.edrsrDb().query(
          `SELECT doc_id, ${cleanEdrsrTextSql('full_text')} AS full_text FROM edrsr_fulltext WHERE doc_id = $1`, [docId]
        );
        if (ftResult.rows.length > 0) {
          row = { doc_id: docId, full_text: ftResult.rows[0].full_text };
        }
      }
    } else if (caseNumber) {
      // Find most recent decision for this case number.
      // On the dedicated EDRSR pool (stage → huge partitioned edrsr_local) an
      // `ORDER BY adjudication_date LIMIT 1` over a `cause_num` filter makes the
      // planner scan every partition by the date index instead of the highly
      // selective cause_num index. Force the cause_num index by filtering in a
      // MATERIALIZED CTE (no ORDER BY/LIMIT inside), then order the tiny result.
      const byCauseSql = this.usingDedicatedEdrsr()
        ? `
        WITH docs AS MATERIALIZED (
          SELECT d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
                 d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
                 d.doc_url, d.status, d.date_publ
          FROM edrsr_documents d
          WHERE d.cause_num = $1
        )
        SELECT d.*, ${cleanEdrsrTextSql('f.full_text')} AS full_text
        FROM docs d
        LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        ORDER BY d.adjudication_date DESC NULLS LAST
        LIMIT 1`
        : `
        SELECT
          d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
          d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
          d.doc_url, d.status, d.date_publ,
          ${cleanEdrsrTextSql('f.full_text')} AS full_text
        FROM edrsr_documents d
        LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
        WHERE d.cause_num = $1
        ORDER BY d.adjudication_date DESC NULLS LAST
        LIMIT 1`;
      const result = await this.edrsrDb().query(byCauseSql, [caseNumber]);

      if (result.rows.length > 0) {
        row = result.rows[0];
      }
    }

    if (!row) {
      return this.wrapError(`Рішення не знайдено в ЄДРСР (doc_id=${docId || 'N/A'}, cause_num=${caseNumber || 'N/A'})`);
    }

    // Enrich with court/judge names
    const courtName = row.court_code ? await this.lookupName('edrsr_courts', 'court_code', row.court_code) : null;
    const judgmentForm = row.judgment_code ? await this.lookupName('edrsr_judgment_forms', 'judgment_code', row.judgment_code) : null;

    const fullText = row.full_text || '';
    const url = `https://reyestr.court.gov.ua/Review/${row.doc_id}`;

    // A stored registry overload page or latin1-mangled HTML carries the real case
    // metadata, so without this check the answer looks like a genuine decision and
    // only its content is garbage. Refuse the text (and the sections derived from it)
    // rather than pass it on — sectionising mojibake would only make it look parsed.
    // No text at all is the same failure in a quieter form: the payload used to come
    // back with empty sections and nothing saying why.
    const damage = fullText ? detectDamagedCourtText(fullText) : 'not_harvested';
    if (damage) {
      logger.warn('[MCP Tool] get_court_decision: damaged stored text', {
        docId: row.doc_id,
        kind: damage,
        textLength: fullText.length,
      });
      return this.wrapResponse({
        doc_id: row.doc_id,
        case_number: row.cause_num || caseNumber || undefined,
        judge: row.judge || undefined,
        court_name: courtName || undefined,
        judgment_form: judgmentForm || undefined,
        adjudication_date: formatCourtDate(row.adjudication_date),
        url,
        text_unavailable: { kind: damage, reason: DAMAGED_TEXT_REASON[damage] },
        sections: [],
        full_text_length: 0,
      });
    }

    const extractedSections = fullText
      ? await this.sectionizer.extractSections(fullText, budget === 'deep')
      : [];

    const sections = Array.isArray(extractedSections)
      ? extractedSections
          .filter((s: any) => s && typeof s.text === 'string')
          .slice(0, 10)
          .map((s: any) => {
            const text: string = s.text;
            return text.length > SECTION_TEXT_CAP
              ? {
                  type: s.type,
                  text: text.slice(0, SECTION_TEXT_CAP),
                  text_truncated: true,
                  text_length: text.length,
                }
              : { type: s.type, text };
          })
      : [];

    const payload: any = {
      doc_id: row.doc_id,
      case_number: row.cause_num || caseNumber || undefined,
      judge: row.judge || undefined,
      court_name: courtName || undefined,
      judgment_form: judgmentForm || undefined,
      adjudication_date: formatCourtDate(row.adjudication_date),
      url,
      depth,
      sections: sections.slice(0, depth),
      // When sections were extracted they already contain this text, so shipping full_text too
      // doubled the payload for zero information: doc 117473073 came back as 282K characters —
      // 139.7K of sections plus 139.6K of the same text again — and blew an MCP client's token
      // limit outright. Only ~0.4% of decisions exceed 60K chars, but the ones that do are
      // exactly the long cassation rulings worth opening.
      //
      // Safe to trim: chat never forwards full_text to the model (chat-result-compactor:
      // "Never sends full_text to LLM — extracts key sections instead") and reads it only as a
      // fallback when sections are missing. So keep it whole when there are no sections, and
      // reduce it to a preview when there are. Raw text remains available via load_full_texts.
      ...(sections.length > 0 && fullText.length > FULL_TEXT_PREVIEW_CHARS
        ? {
            full_text_preview: fullText.slice(0, FULL_TEXT_PREVIEW_CHARS),
            full_text_truncated: true,
            full_text_hint: 'Повний текст не дублюється тут, бо він уже розібраний у sections. Потрібен суцільний текст — використайте load_full_texts.',
          }
        : { full_text: fullText || undefined }),
      full_text_length: fullText.length,
    };

    // Best-effort citation-graph enrichment (Neo4j). Gated by CITATION_BACKEND=neo4j;
    // never blocks or breaks the primary decision response.
    if (args.include_citations !== false && this.citationGraphService?.isEnabled() && row.doc_id != null) {
      try {
        const summary = await this.citationGraphService.getDecisionCitationSummary(row.doc_id);
        if (summary.citedCount > 0) {
          payload.citation_graph = {
            backend: 'neo4j',
            cited_count: summary.citedCount,
            top_cited_articles: summary.topCitedArticles.map((a) => ({
              law: a.law,
              article: a.article,
              citation_type: a.citationType || undefined,
              popularity: a.popularity || undefined,
            })),
          };
        }
      } catch (error: any) {
        logger.warn('[get_court_decision] citation-graph enrichment failed (non-fatal)', {
          docId: row.doc_id,
          error: error?.message,
        });
      }
    }

    return this.wrapResponse(payload);
  }

  private static readonly ALLOWED_LOOKUP_TABLES: Record<string, Set<string>> = {
    edrsr_courts: new Set(['court_code']),
    edrsr_judgment_forms: new Set(['judgment_code']),
    edrsr_justice_kinds: new Set(['justice_kind']),
    edrsr_cause_categories: new Set(['cause_cat_code']),
  };

  private async lookupName(table: string, idColumn: string, id: number): Promise<string | null> {
    if (!this.db) return null;
    const allowed = CourtDecisionTools.ALLOWED_LOOKUP_TABLES[table];
    if (!allowed || !allowed.has(idColumn)) return null;
    try {
      const result = await this.edrsrDb().query(`SELECT name FROM ${table} WHERE ${idColumn} = $1 LIMIT 1`, [id]);
      return result.rows.length > 0 ? result.rows[0].name : null;
    } catch {
      return null;
    }
  }

  private async getCaseDocumentsChain(args: any): Promise<ToolResult> {
    const caseNumber = typeof args.case_number === 'string' ? args.case_number.trim() : '';
    const includeFullText = args.include_full_text === true;
    const maxDocs = Math.min(100, Math.max(1, Number(args.max_docs || 50)));
    const groupByInstance = args.group_by_instance !== false;
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const requestedTypes: string[] = Array.isArray(args.document_types)
      ? args.document_types.map((t: any) => String(t).trim()).filter(Boolean)
      : [];
    const sortArg = typeof args.sort === 'string' ? args.sort.trim().toLowerCase() : '';
    // `balanced` (default) shows the start of the case AND its latest documents.
    // A plain ASC LIMIT silently answered "how did this case end?" with the first
    // procedural rulings of a 300-document bankruptcy file (LEXAI, 2026-08-13).
    // Any explicit paging intent (offset) falls back to a sequential window.
    const sortMode: 'balanced' | 'asc' | 'desc' =
      sortArg === 'asc' || sortArg === 'desc' ? sortArg : offset > 0 ? 'asc' : 'balanced';

    if (!caseNumber) {
      throw new Error('case_number parameter is required');
    }

    if (!this.db) {
      throw new Error('Database connection not available for get_case_documents_chain');
    }

    logger.info('[MCP Tool] get_case_documents_chain started', {
      caseNumber,
      includeFullText,
      maxDocs,
      groupByInstance,
      sortMode,
      offset,
      documentTypes: requestedTypes,
    });

    // Resolve the procedural suffix first. The chat model strips it on the way in (asked
    // about 369/6892/15-ц, called with 369/6892/15), and the bare number matches no
    // cause_num at all, so the chain came back empty and the answer said the case does not
    // exist. resolveCauseNumber only rewrites when exactly one real case fits; an ambiguous
    // base is left alone rather than merged, since ~1 base in 700 covers two distinct cases.
    const resolution = await resolveCauseNumber(caseNumber, this.edrsrDb());
    const effectiveCaseNumber = resolution.resolved || caseNumber;

    const caseVariations = generateCaseNumberVariations(effectiveCaseNumber);
    logger.info('Generated case number variations', {
      variations: caseVariations,
      ...(resolution.resolved && resolution.resolved !== caseNumber
        ? { requested: caseNumber, resolved: resolution.resolved }
        : {}),
      ...(resolution.ambiguous ? { ambiguous: resolution.matches.map(m => m.cause_num) } : {}),
    });

    // Population stats BEFORE the window: the answer must be able to say how many
    // documents the case actually has. Reporting the window size as the total made
    // a 317-document bankruptcy file look like a 50-document one that ended in
    // January 2019 (LEXAI, 2026-08-13). Aggregated in Postgres over the cause_num
    // index — a handful of grouped rows, regardless of case size.
    const statsSql = `
      WITH docs AS MATERIALIZED (
        SELECT d.court_code, d.judgment_code, d.adjudication_date
        FROM edrsr_documents d
        WHERE d.cause_num = ANY($1)
      )
      SELECT c.instance_code, c.name AS court_name, d.judgment_code,
             count(*)::int AS n,
             min(d.adjudication_date) AS first_date,
             max(d.adjudication_date) AS last_date
      FROM docs d
      LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
      GROUP BY c.instance_code, c.name, d.judgment_code`;

    const statsResult = await this.edrsrDb().query(statsSql, [caseVariations]);
    const statsRows = statsResult.rows || [];
    const totalInCase = statsRows.reduce((sum: number, r: any) => sum + Number(r.n || 0), 0);

    logger.info('[MCP Tool] get_case_documents_chain case size', {
      caseNumber,
      variationsCount: caseVariations.length,
      totalInCase,
    });

    if (totalInCase === 0) {
      return this.wrapResponse({
        case_number: caseNumber,
        total_documents: 0,
        returned_documents: 0,
        has_more: false,
        documents: [],
        search_stats: { variations_tried: caseVariations },
        ...(resolution.ambiguous
          ? {
              ambiguous_case_number: {
                requested: caseNumber,
                candidates: resolution.matches.map(m => m.cause_num),
              },
            }
          : {}),
        message: resolution.ambiguous
          ? `Номер справи ${caseNumber} без суфікса відповідає кільком різним справам (${resolution.matches.map(m => m.cause_num).join(', ')}). Уточніть номер повністю.`
          : `Документів не знайдено за номером справи: ${caseNumber} (перевірено варіації: ${caseVariations.join(', ')})`,
      });
    }

    // Judgment-form names for every code in the case — needed both for the
    // document_types filter and for a summary that describes the whole case.
    const judgmentCodes = new Set<number>();
    for (const row of statsRows) {
      if (row.judgment_code != null) judgmentCodes.add(Number(row.judgment_code));
    }
    const judgmentMap = new Map<number, string>();
    if (judgmentCodes.size > 0) {
      try {
        const jfResult = await this.edrsrDb().query(
          'SELECT judgment_code, name FROM edrsr_judgment_forms WHERE judgment_code = ANY($1)',
          [Array.from(judgmentCodes)]
        );
        for (const r of jfResult.rows) {
          judgmentMap.set(Number(r.judgment_code), r.name);
        }
      } catch { /* non-critical */ }
    }

    const availableTypes = Array.from(new Set(Array.from(judgmentMap.values()).filter(Boolean)));

    let filterCodes: number[] | null = null;
    if (requestedTypes.length > 0) {
      filterCodes = matchJudgmentCodes(requestedTypes, judgmentMap);
      if (filterCodes.length === 0) {
        return this.wrapResponse({
          case_number: caseNumber,
          total_documents: totalInCase,
          returned_documents: 0,
          has_more: false,
          documents: [],
          search_stats: { variations_tried: caseVariations, source: 'edrsr_documents' },
          message:
            `У справі ${caseNumber} немає документів типу: ${requestedTypes.join(', ')}. ` +
            `Наявні форми судових рішень: ${availableTypes.join(', ') || 'невідомо'}.`,
        });
      }
    }

    const selectableTotal = filterCodes
      ? statsRows
          .filter((r: any) => r.judgment_code != null && filterCodes!.includes(Number(r.judgment_code)))
          .reduce((sum: number, r: any) => sum + Number(r.n || 0), 0)
      : totalInCase;

    // Query edrsr_documents directly with all case number variations
    const fulltextJoin = includeFullText
      ? 'LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id'
      : '';
    const fulltextField = includeFullText
      ? ', f.full_text'
      : '';
    const typeClause = filterCodes ? ' AND d.judgment_code = ANY($4)' : '';

    // On the dedicated EDRSR pool (stage → huge partitioned edrsr_local),
    // `ORDER BY adjudication_date LIMIT` over a `cause_num = ANY(...)` filter
    // makes the planner Merge-Append every partition by the date index instead
    // of the selective cause_num index (~82s). Filter by cause_num in a
    // MATERIALIZED CTE first (forces the cause_num index → a handful of rows),
    // then join/sort/limit that tiny set. Prod keeps the original query.
    const buildSql = (direction: 'ASC' | 'DESC') => this.usingDedicatedEdrsr()
      ? `
      WITH docs AS MATERIALIZED (
        SELECT d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
               d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
               d.doc_url, d.status, d.date_publ
        FROM edrsr_documents d
        WHERE d.cause_num = ANY($1)${typeClause}
      )
      SELECT d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
             d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
             d.doc_url, d.status, d.date_publ,
             c.name AS court_name, c.instance_code
             ${fulltextField}
      FROM docs d
      LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
      ${fulltextJoin}
      ORDER BY d.adjudication_date ${direction} NULLS LAST
      LIMIT $2 OFFSET $3
    `
      : `
      SELECT d.doc_id, d.cause_num, d.judge, d.court_code, d.justice_kind,
             d.judgment_code, d.category_code, d.adjudication_date, d.receipt_date,
             d.doc_url, d.status, d.date_publ,
             c.name AS court_name, c.instance_code
             ${fulltextField}
      FROM edrsr_documents d
      LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
      ${fulltextJoin}
      WHERE d.cause_num = ANY($1)${typeClause}
      ORDER BY d.adjudication_date ${direction} NULLS LAST
      LIMIT $2 OFFSET $3
    `;

    const runWindow = async (direction: 'ASC' | 'DESC', limit: number, skip: number) => {
      if (limit <= 0) return [] as any[];
      const params: any[] = [caseVariations, limit, skip];
      if (filterCodes) params.push(filterCodes);
      const res = await this.edrsrDb().query(buildSql(direction), params);
      return res.rows || [];
    };

    const dateValue = (row: any): number => {
      const t = row.adjudication_date ? new Date(row.adjudication_date).getTime() : NaN;
      return Number.isNaN(t) ? 0 : t;
    };

    let rows: any[];
    if (sortMode === 'balanced' && selectableTotal > maxDocs) {
      // Oldest half + newest half: the chain question is always "how did it start
      // and how did it end", and the end is what a plain ASC window drops.
      const headCount = Math.ceil(maxDocs / 2);
      const [head, tail] = await Promise.all([
        runWindow('ASC', headCount, 0),
        runWindow('DESC', maxDocs - headCount, 0),
      ]);
      const seen = new Set<string>();
      rows = [];
      for (const row of [...head, ...tail]) {
        const key = String(row.doc_id);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
      rows.sort((a, b) => dateValue(a) - dateValue(b));
    } else {
      rows = await runWindow(sortMode === 'desc' ? 'DESC' : 'ASC', maxDocs, offset);
    }

    logger.info('[MCP Tool] get_case_documents_chain DB result', {
      caseNumber,
      variationsCount: caseVariations.length,
      rowsFound: rows.length,
      totalInCase,
      selectableTotal,
    });

    if (rows.length === 0) {
      return this.wrapResponse({
        case_number: caseNumber,
        total_documents: totalInCase,
        returned_documents: 0,
        has_more: false,
        offset,
        documents: [],
        search_stats: { variations_tried: caseVariations, source: 'edrsr_documents' },
        // The case itself exists here (totalInCase > 0 above), so this is a paging
        // miss, not a lookup miss — ambiguity is reported by the not-found branch.
        message:
          offset >= selectableTotal
            ? `offset=${offset} перевищує кількість доступних документів (${selectableTotal}). Зменш offset.`
            : `Документів не знайдено за номером справи: ${caseNumber}`,
      });
    }

    const classifyInstance = (row: any): string => {
      const courtName = (row.court_name || '').toLowerCase();
      if (courtName.includes('велика палата')) return 'Велика Палата ВС';
      if (row.instance_code === 1) {
        if (courtName.includes('касаційний цивільний')) return 'Касація (КЦС ВС)';
        if (courtName.includes('касаційний господарський')) return 'Касація (КГС ВС)';
        if (courtName.includes('касаційний адміністративний')) return 'Касація (КАС ВС)';
        if (courtName.includes('касаційний кримінальний')) return 'Касація (ККС ВС)';
        return 'Касація';
      }
      if (row.instance_code === 2) return 'Апеляція';
      if (row.instance_code === 3) return 'Перша інстанція';
      return 'Невідомо';
    };

    const mappedDocs = rows.map((row: any) => ({
      doc_id: row.doc_id,
      case_number: row.cause_num || caseNumber,
      document_type: judgmentMap.get(row.judgment_code) || 'Невідомо',
      instance: classifyInstance(row),
      court: row.court_name || null,
      judge: row.judge,
      date: formatCourtDate(row.adjudication_date),
      url: `https://reyestr.court.gov.ua/Review/${row.doc_id}`,
      ...(includeFullText && row.full_text ? guardChainText(row.full_text) : {}),
    }));

    let groupedDocs: any = null;
    if (groupByInstance) {
      groupedDocs = {
        'Перша інстанція': [] as any[],
        'Апеляція': [] as any[],
        'Касація': [] as any[],
        'Велика Палата ВС': [] as any[],
        'Невідомо': [] as any[],
      };
      for (const doc of mappedDocs) {
        const instance = doc.instance || 'Невідомо';
        if (instance.startsWith('Касація')) {
          if (!groupedDocs['Касація']) groupedDocs['Касація'] = [];
          groupedDocs['Касація'].push(doc);
        } else if (groupedDocs[instance]) {
          groupedDocs[instance].push(doc);
        } else {
          groupedDocs['Невідомо'].push(doc);
        }
      }
      Object.keys(groupedDocs).forEach(key => {
        if (groupedDocs[key].length === 0) delete groupedDocs[key];
      });
    }

    // Summary describes the WHOLE case, not the returned window — otherwise a
    // window of early procedural rulings reads as "this case has no appeal".
    const populationInstances = { first_instance: 0, appeal: 0, cassation: 0, grand_chamber: 0 };
    const populationTypes = { decisions: 0, rulings: 0, orders: 0, other: 0 };
    let firstDate: Date | null = null;
    let lastDate: Date | null = null;
    for (const row of statsRows) {
      const n = Number(row.n || 0);
      const instance = classifyInstance(row);
      if (instance === 'Перша інстанція') populationInstances.first_instance += n;
      else if (instance === 'Апеляція') populationInstances.appeal += n;
      else if (instance.includes('Касація')) populationInstances.cassation += n;
      else if (instance === 'Велика Палата ВС') populationInstances.grand_chamber += n;

      const typeName = judgmentMap.get(Number(row.judgment_code)) || '';
      if (typeName === 'Рішення' || typeName === 'Вирок') populationTypes.decisions += n;
      else if (typeName === 'Постанова') populationTypes.rulings += n;
      else if (typeName.includes('Ухвала')) populationTypes.orders += n;
      else populationTypes.other += n;

      if (row.first_date) {
        const d = new Date(row.first_date);
        if (!firstDate || d < firstDate) firstDate = d;
      }
      if (row.last_date) {
        const d = new Date(row.last_date);
        if (!lastDate || d > lastDate) lastDate = d;
      }
    }

    const hasMore = sortMode === 'balanced'
      ? mappedDocs.length < selectableTotal
      : offset + mappedDocs.length < selectableTotal;

    const payload: any = {
      case_number: effectiveCaseNumber,
      // Same rewrite metadata check_precedent_status emits, spelled the same way, so a
      // client can detect a resolved suffix uniformly across both tools.
      ...(resolution.resolved && resolution.resolved !== caseNumber
        ? { resolved_case_number: resolution.resolved, requested_case_number: caseNumber }
        : {}),
      // Documents in the CASE. `returned_documents` is what fit into this window.
      total_documents: totalInCase,
      returned_documents: mappedDocs.length,
      has_more: hasMore,
      window: {
        sort: sortMode,
        offset,
        max_docs: maxDocs,
        ...(filterCodes ? { document_types: requestedTypes, matching_documents: selectableTotal } : {}),
      },
      documents: groupByInstance ? undefined : mappedDocs,
      grouped_documents: groupByInstance ? groupedDocs : undefined,
      search_stats: {
        variations_tried: caseVariations,
        source: 'edrsr_documents',
      },
      summary: {
        scope: 'вся справа',
        date_range: {
          from: formatCourtDate(firstDate),
          to: formatCourtDate(lastDate),
        },
        instances: populationInstances,
        document_types: {
          decisions: populationTypes.decisions,
          rulings: populationTypes.rulings,
          orders: populationTypes.orders,
          ...(populationTypes.other ? { other: populationTypes.other } : {}),
        },
        available_document_types: availableTypes,
      },
    };

    if (hasMore) {
      const shown = filterCodes
        ? `${mappedDocs.length} з ${selectableTotal} документів обраних типів (усього у справі — ${totalInCase})`
        : `${mappedDocs.length} з ${totalInCase} документів справи`;
      payload.coverage_warning =
        `УВАГА: показано ${shown}` +
        (sortMode === 'balanced'
          ? ' — найдавніші та найновіші. Проміжні документи не увійшли у вибірку.'
          : ` (sort=${sortMode}, offset=${offset}).`) +
        ' Не роби висновку про результат розгляду лише з цієї вибірки:' +
        ` для решти документів виклич цей інструмент ще раз з offset=${offset + mappedDocs.length} та sort=asc/desc,` +
        ' або звузь вибірку через document_types=["Рішення","Постанова"].';
    }

    // Best-effort precedent enrichment from the decision↔case graph (Neo4j, LEXAI-1777).
    // The document chain itself stays in Postgres (above); the graph adds the
    // precedent signal — how many decisions cite this case. Gated by
    // CITATION_BACKEND=neo4j; non-fatal.
    if (this.citationGraphService?.isEnabled()) {
      try {
        const stat = await this.citationGraphService.getCaseStats(caseVariations);
        if (stat && (stat.citingDecisions > 0 || stat.departedByDecision)) {
          const sampleCiting = await this.citationGraphService.getCaseCitedBy(stat.causeNum, 20);
          payload.citation_graph = {
            backend: 'neo4j',
            cited_by_decisions: stat.citingDecisions,
            documents_in_case: stat.memberCount || undefined,
            latest_doc_id: stat.latestDocId || undefined,
            sample_citing_decisions: sampleCiting,
            ...(stat.departedByDecision
              ? {
                  position_departed_from: {
                    by_grand_chamber_decision: stat.departedByDecision,
                    on: stat.departedOn || undefined,
                    note: 'Правову позицію у цій справі відступлено Великою Палатою ВС — прецедент може бути нечинним.',
                  },
                }
              : {}),
          };
        }
      } catch (error: any) {
        logger.warn('[get_case_documents_chain] citation-graph enrichment failed (non-fatal)', {
          caseNumber,
          error: error?.message,
        });
      }
    }

    return this.wrapResponse(payload);
  }

  private async extractDocumentSections(args: any): Promise<ToolResult> {
    let text = args.text;
    const docId = args.doc_id || args.document_id;

    if (!text && docId) {
      logger.info('Fetching document full text from DB', { docId });
      if (!this.db) {
        throw new Error('Database not available for document lookup');
      }
      try {
        const result = await this.db.query(
          `SELECT full_text, full_text_html FROM documents WHERE zakononline_id = $1 OR id::text = $1 LIMIT 1`,
          [String(docId)]
        );
        const row = result.rows?.[0];
        if (row?.full_text) {
          text = row.full_text;
        } else if (row?.full_text_html) {
          // Strip HTML tags as fallback
          text = row.full_text_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        } else {
          throw new Error(`Документ ${docId} не має повного тексту в базі. Спочатку завантажте текст через get_court_decision або load_full_texts.`);
        }
      } catch (error: any) {
        if (error.message.includes('не має повного тексту')) throw error;
        throw new Error(`Failed to fetch document ${docId}: ${error.message}`);
      }
    }

    if (!text) {
      throw new Error('Either "text" or "doc_id"/"document_id" must be provided');
    }

    const sections = await this.sectionizer.extractSections(text, args.use_llm || false);
    return this.wrapResponse({ sections });
  }

  private async loadFullTexts(args: any): Promise<ToolResult> {
    const docIds: number[] = args.doc_ids || [];
    const maxDocs = args.max_docs || 1000;
    const returnTexts = args.return_texts === true;
    const snippetChars = Math.min(20000, Math.max(500, Number(args.snippet_chars || 4000)));

    if (!docIds || docIds.length === 0) {
      throw new Error('doc_ids parameter is required and must be a non-empty array');
    }

    const uniqueDocIds = Array.from(new Set(docIds));
    const duplicatesRemoved = docIds.length - uniqueDocIds.length;

    if (duplicatesRemoved > 0) {
      logger.warn('Removed duplicate doc_ids', {
        totalProvided: docIds.length,
        uniqueCount: uniqueDocIds.length,
        duplicatesRemoved
      });
    }

    const startTime = Date.now();
    const docs = uniqueDocIds.slice(0, maxDocs).map(docId => ({ doc_id: docId }));
    await this.zoAdapter.saveDocumentsToDatabase(docs, maxDocs);
    const timeTaken = Date.now() - startTime;
    const estimatedCost = docs.length * 0.00714;

    const result: any = {
      requested_docs: docIds.length,
      unique_docs: uniqueDocIds.length,
      duplicates_removed: duplicatesRemoved,
      processed_docs: docs.length,
      limited_to: maxDocs,
      time_taken_ms: timeTaken,
      estimated_cost_usd: parseFloat(estimatedCost.toFixed(6)),
      note: 'Документы проверены на наличие в PostgreSQL и Redis кэше перед загрузкой. Загружены только отсутствующие документы.',
    };

    if (duplicatesRemoved > 0) {
      result.deduplication_note = `Обнаружено и удалено ${duplicatesRemoved} дубликатов doc_id из входного списка`;
    }
    if (uniqueDocIds.length > maxDocs) {
      result.warning = `Запрошено ${uniqueDocIds.length} уникальных документов, но обработано только ${maxDocs} из-за лимита безопасности`;
    }

    // When requested, return the key sections of each warmed document in a single
    // response so the model does not need a separate get_court_decision per doc
    // (which burns the tool-call budget and leaves warmed docs unread).
    if (returnTexts && this.db) {
      const processedIds = docs.map(d => d.doc_id);
      result.documents = await this.buildKeySectionExcerpts(processedIds, snippetChars);
    }

    return this.wrapResponse(result);
  }

  /**
   * For each doc_id, fetch metadata + full_text and extract the substantive
   * sections (застосовані норми + мотивувальна + резолютивна частини), which
   * carry the holding and the applied norms. The procedural header/facts at the
   * start of a decision are deliberately dropped as low-signal. Falls back to a
   * head-truncated full_text only when the sectionizer yields nothing.
   */
  private async buildKeySectionExcerpts(docIds: number[], snippetChars: number): Promise<any[]> {
    if (!this.db || docIds.length === 0) return [];

    const rows = (await this.db.query(`
      SELECT d.doc_id, d.cause_num, d.judge, d.adjudication_date, ${cleanEdrsrTextSql('f.full_text')} AS full_text
      FROM edrsr_documents d
      LEFT JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
      WHERE d.doc_id = ANY($1)
    `, [docIds])).rows;

    // Preserve caller ordering and cover fulltext-only docs missing from edrsr_documents.
    const byId = new Map<number, any>(rows.map((r: any) => [Number(r.doc_id), r]));
    const missing = docIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      const ftRows = (await this.db.query(
        `SELECT doc_id, ${cleanEdrsrTextSql('full_text')} AS full_text FROM edrsr_fulltext WHERE doc_id = ANY($1)`, [missing]
      )).rows;
      for (const r of ftRows) byId.set(Number(r.doc_id), { doc_id: r.doc_id, full_text: r.full_text });
    }

    // Priority order: applied norms first, then court reasoning, then the operative part.
    const KEY_SECTION_ORDER = [
      SectionType.LAW_REFERENCES,
      SectionType.MOTIVES,
      SectionType.COURT_REASONING,
      SectionType.DECISION,
    ];

    const out: any[] = [];
    for (const docId of docIds) {
      const row = byId.get(docId);
      if (!row) {
        out.push({ doc_id: docId, error: 'Текст не знайдено в базі' });
        continue;
      }
      const fullText: string = row.full_text || '';
      const url = `https://reyestr.court.gov.ua/Review/${row.doc_id}`;

      let excerpt = '';
      let source: 'sections' | 'truncated' | 'empty' = 'empty';

      if (fullText) {
        const sections = await this.sectionizer.extractSections(fullText, false);
        const keyParts: string[] = [];
        for (const t of KEY_SECTION_ORDER) {
          for (const s of sections) {
            if (s && s.type === t && typeof s.text === 'string' && s.text.trim()) {
              keyParts.push(`[${t}]\n${s.text.trim()}`);
            }
          }
        }
        if (keyParts.length > 0) {
          excerpt = keyParts.join('\n\n');
          source = 'sections';
        } else {
          // Fallback: sectionizer produced nothing (short ruling / atypical structure).
          excerpt = fullText;
          source = 'truncated';
        }
      }

      // Same guard as get_court_decision: this is the bulk path a report builds on,
      // so a stored overload page here would be quoted as the decision's content.
      const damage = fullText ? detectDamagedCourtText(fullText) : 'not_harvested';
      if (damage) {
        out.push({
          doc_id: row.doc_id,
          case_number: row.cause_num || undefined,
          judge: row.judge || undefined,
          adjudication_date: formatCourtDate(row.adjudication_date),
          url,
          text_unavailable: { kind: damage, reason: DAMAGED_TEXT_REASON[damage] },
        });
        continue;
      }

      const truncated = excerpt.length > snippetChars;
      out.push({
        doc_id: row.doc_id,
        case_number: row.cause_num || undefined,
        judge: row.judge || undefined,
        adjudication_date: formatCourtDate(row.adjudication_date),
        url,
        full_text_length: fullText.length,
        excerpt_source: source,
        truncated,
        text: truncated ? excerpt.slice(0, snippetChars) : excerpt,
      });
    }
    return out;
  }

  private async bulkIngestCourtDecisions(args: any): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query parameter is required');

    const defaultDateFrom = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 3);
      return d.toISOString().slice(0, 10);
    })();

    const dateFrom = args.date_from || defaultDateFrom;
    const dateTo = args.date_to;
    const maxDocs = Number(args.max_docs || 1000);
    const maxPages = Number(args.max_pages || 50);
    const pageSize = Math.min(1000, Math.max(1, Number(args.page_size || 1000)));
    const supremeCourtHint = args.supreme_court_hint === true;

    const scHints = supremeCourtHint
      ? ' Верховн КЦС КГС КАС ККС "Велика палата" "ВП ВС"'
      : '';
    const searchQuery = `${query}${scHints}`.trim();

    const startTime = Date.now();
    const seenDocIds = new Set<number>();
    let pagesFetched = 0;
    let offset = 0;
    let emptyPages = 0;

    while (pagesFetched < maxPages && seenDocIds.size < maxDocs) {
      const searchParams: any = {
        meta: { search: searchQuery },
        limit: pageSize,
        offset,
      };

      const rawResponse = await this.zoAdapter.searchCourtDecisions(searchParams);
      pagesFetched++;

      // Handle both array and { data: [...] } response formats
      const responseData = Array.isArray(rawResponse)
        ? rawResponse
        : (rawResponse?.data && Array.isArray(rawResponse.data) ? rawResponse.data : []);

      if (responseData.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) break; // Stop after 2 consecutive empty pages
        offset += pageSize;
        continue;
      }
      emptyPages = 0;

      const filtered = responseData.filter((doc: any) => {
        if (!doc?.doc_id) return false;
        const docDate = doc.adjudication_date ? new Date(doc.adjudication_date) : null;
        if (!docDate) return false;
        if (dateFrom && docDate < new Date(dateFrom)) return false;
        if (dateTo && docDate > new Date(dateTo)) return false;
        return true;
      });

      for (const doc of filtered) {
        if (typeof doc.doc_id !== 'number') continue;
        if (seenDocIds.size >= maxDocs) break;
        seenDocIds.add(doc.doc_id);
      }

      if (responseData.length < pageSize) break;
      offset += pageSize;
    }

    const docIds = Array.from(seenDocIds);
    const docs = docIds.map((docId) => ({ doc_id: docId }));
    await this.zoAdapter.saveDocumentsToDatabase(docs, maxDocs);

    const timeTaken = Date.now() - startTime;
    const costEstimateSearchUsd = pagesFetched * 0.00714;
    const costEstimateScrapeMaxUsd = docIds.length * 0.00714;

    return this.wrapResponse({
      query,
      search_query_used: searchQuery,
      date_from: dateFrom,
      ...(dateTo ? { date_to: dateTo } : {}),
      pages_fetched: pagesFetched,
      unique_doc_ids_collected: docIds.length,
      max_docs: maxDocs,
      max_pages: maxPages,
      time_taken_ms: timeTaken,
      cost_estimate_usd: {
        search_api: parseFloat(costEstimateSearchUsd.toFixed(6)),
        scrape_max: parseFloat(costEstimateScrapeMaxUsd.toFixed(6)),
      },
      note: 'Далее: документы будут сохранены в PostgreSQL, секции извлечены, DECISION+COURT_REASONING проиндексированы в Qdrant. Реальная стоимость ниже за счет кэша/уже загруженных документов.',
    });
  }

  private async analyzeCasePattern(args: any): Promise<ToolResult> {
    const intent = String(args.intent || args.query || '').trim();
    if (!intent) throw new Error('intent (or query) parameter is required');

    const method = args.method || 'auto';
    const docs = Array.isArray(args.documents) ? args.documents : [];
    const useEmbedding = method === 'embedding' || (method === 'auto' && docs.length > 0);

    // Text-based pattern search
    const patterns = await this.patternStore.findPatterns(intent);

    // Extract new patterns from case_ids if provided
    if (args.case_ids && args.case_ids.length > 0) {
      const newPattern = await this.patternStore.extractPatterns(args.case_ids, intent);
      if (newPattern) {
        await this.patternStore.savePattern(newPattern);
        patterns.unshift(newPattern);
      }
    }

    // Embedding-based analysis (merged from analyze_legal_patterns)
    let embeddingAnalysis: any = null;
    if (useEmbedding) {
      try {
        const queryText = intent || (docs.length > 0 ? JSON.stringify(docs[0]).slice(0, 500) : '');
        if (queryText) {
          const emb = await this.embeddingService.generateEmbedding(queryText);
          const matched = await this.patternStore.matchPatterns(emb, 'general_search');
          embeddingAnalysis = {
            success_arguments: matched.flatMap((p: any) => Array.isArray(p?.success_arguments) ? p.success_arguments : []).slice(0, 15),
            risk_factors: matched.flatMap((p: any) => Array.isArray(p?.risk_factors) ? p.risk_factors : []).slice(0, 15),
            confidence: matched.length > 0 ? 0.7 : 0.35,
          };
        }
      } catch (err: any) {
        logger.warn('Embedding-based analysis failed, falling back to text', { error: err.message });
      }
    }

    return this.wrapResponse({
      patterns,
      ...(embeddingAnalysis ? { embedding_analysis: embeddingAnalysis } : {}),
    });
  }

  private async countCasesByParty(args: any): Promise<ToolResult> {
    if (!this.ftsService || !this.db) return this.wrapError('FTS сервіс недоступний для підрахунку справ');

    const partyName: string = String(args.party_name || '').trim();
    if (!partyName) return this.wrapError('party_name є обов\'язковим');
    const partyType: 'plaintiff' | 'defendant' | 'any' = args.party_type || 'any';
    const returnCases = args.return_cases === true;
    const maxCasesToReturn = Math.min(Math.max(Number(args.max_cases_to_return) || 100, 1), 1000);

    // Strip leading legal-form prefix (ТОВ / ПАТ / ФОП …) and quotes so the phrase matches
    // the distinctive proper name — courts keep quoted proper names in the nominative case.
    const cleanedName = partyName
      .replace(/^(ТОВ|ПАТ|ПрАТ|ТДВ|ФОП|КП|ДП|АТ|ВАТ|ЗАТ)\s+/i, '')
      .replace(/[«»"]/g, '')
      .trim() || partyName;

    const startTime = Date.now();
    try {
      const counts = await this.ftsService.countByParty(
        cleanedName,
        partyType,
        this.db,
        { date_from: args.date_from, date_to: args.date_to, justice_kind: args.justice_kind },
        returnCases ? maxCasesToReturn : 0,
      );

      const topCourts = counts.by_court.slice(0, 30);
      const courtNames = await this.lookupCourtNames(topCourts.map(c => c.court_code));
      const by_court = topCourts.map(c => ({
        court_code: c.court_code,
        court_name: courtNames.get(c.court_code) || null,
        count: c.count,
      }));

      const result: any = {
        party_name: partyName,
        party_type: partyType,
        matched_name: cleanedName,
        // total_cases used to carry counts.total, which is a DOCUMENT count — it read as
        // 684 "справ" for ЕВЕРЛІҐАЛ against 591 real cases, because one case yields a
        // document at every instance it passes through.
        total_cases: counts.distinct_cases,
        total_documents: counts.total,
        courts_count: counts.by_court.length,
        by_court,
        time_taken_ms: Date.now() - startTime,
        method: 'fts_party_anchor',
        note: 'total_cases — кількість УНІКАЛЬНИХ справ (за номером справи); total_documents — кількість документів, вона завжди більша, бо одна справа дає документи в кожній інстанції. У by_court рахуються ДОКУМЕНТИ по судах, тому сума by_court дорівнює total_documents, а не total_cases. Назва/роль — це FTS-прив\'язка по тексту рішення, не структурний фільтр сторони. Точне визначення ролі — після впровадження parties-таблиці (LEXAI-1760).',
      };
      if (counts.capped) {
        // Never let a truncated aggregate read as an exact count.
        result.capped = true;
        result.candidate_cap = counts.candidate_cap;
        result.note += ` УВАГА: сторона має більше документів, ніж ліміт вибірки (${counts.candidate_cap}). total_cases, courts_count і розподіл by_court пораховані ЛИШЕ за ${counts.candidate_cap} НАЙНОВІШИМИ документами — це НИЖНІ МЕЖІ, а не точні значення, і розподіл по судах відображає свіжу практику, а не всю історію сторони; не подавайте жодне з них як остаточну цифру. Щоб отримати точний підрахунок, повторіть запит із date_from/date_to за коротший період (рік або два) — період звужує сам пошук, а не лише фільтрує результат.`;
      }
      if (args.date_from) result.date_from = args.date_from;
      if (args.date_to) result.date_to = args.date_to;
      if (returnCases && counts.sample) {
        result.cases = counts.sample.map(s => ({
          ...s,
          external_url: `https://reyestr.court.gov.ua/Review/${s.doc_id}`,
        }));
        result.cases_returned = counts.sample.length;
      }

      return this.wrapResponse(result);
    } catch (err: any) {
      logger.error('[CourtDecisionTools] countCasesByParty failed', { error: err.message });
      return this.wrapError(`Помилка підрахунку справ: ${err.message}`);
    }
  }

  private async lookupCourtNames(codes: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const ids = [...new Set(codes.filter((c): c is number => typeof c === 'number'))];
    if (ids.length === 0 || !this.db) return map;
    try {
      const res = await this.edrsrDb().query(`SELECT court_code, name FROM edrsr_courts WHERE court_code = ANY($1)`, [ids]);
      for (const row of res.rows) map.set(row.court_code, row.name);
    } catch { /* non-critical */ }
    return map;
  }
}
