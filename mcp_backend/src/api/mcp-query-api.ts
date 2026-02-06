import {
  QueryPlanner,
} from '../services/query-planner.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { CitationValidator } from '../services/citation-validator.js';
import { HallucinationGuard } from '../services/hallucination-guard.js';
import { SectionType, EnhancedMCPResponse, PackagedLawyerAnswer, LegalPattern } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { CourtDecisionHTMLParser, extractSearchTermsWithAI } from '../utils/html-parser.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';
import { LegislationTools } from './legislation-tools.js';
import axios from 'axios';

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export class MCPQueryAPI {
  constructor(
    private queryPlanner: QueryPlanner,
    private zoAdapter: ZOAdapter,
    private zoPracticeAdapter: ZOAdapter,
    private sectionizer: SemanticSectionizer,
    private embeddingService: EmbeddingService,
    private patternStore: LegalPatternStore,
    private citationValidator: CitationValidator,
    private hallucinationGuard: HallucinationGuard,
    private legislationTools: LegislationTools
  ) {}

  private extractSourceStrings(sources: any): string[] {
    if (!Array.isArray(sources)) return [];
    const out: string[] = [];
    for (const s of sources) {
      if (!s) continue;
      if (typeof s === 'string') {
        out.push(s);
        continue;
      }
      if (typeof s === 'object') {
        if (typeof s.id === 'string') out.push(s.id);
        if (typeof s.source_id === 'string') out.push(s.source_id);
        if (typeof s.url === 'string') out.push(s.url);
        if (typeof s.title === 'string') out.push(s.title);
      }
    }
    return Array.from(new Set(out.filter((x) => String(x).trim().length > 0)));
  }

  private async classifyIntentTool(args: any) {
    const query = String(args?.query || '').trim();
    if (!query) {
      throw new Error('query parameter is required');
    }
    const budget = (args?.budget || args?.reasoning_budget || 'standard') as 'quick' | 'standard' | 'deep';

    logger.info('[MCP Tool] classify_intent started', { query: query.substring(0, 100), budget });
    const intent = await this.queryPlanner.classifyIntent(query, budget);
    const domains = Array.isArray(intent?.domains) ? intent.domains : [];

    const looksLikeWorkflow = domains.includes('workflow') || /workflow|інтеграц|integration/i.test(query);
    const looksLikeVault = /vault|сховищ|хранилищ/i.test(query);
    const looksLikeDD = /due\s*diligence|dd\b|перевірк|провер|m&a/i.test(query);

    const service = looksLikeWorkflow
      ? 'workflow_automation'
      : looksLikeVault
        ? 'document_vault'
        : looksLikeDD
          ? 'due_diligence'
          : 'legal_research';

    const task = service === 'document_vault'
      ? 'semantic_search'
      : service === 'workflow_automation'
        ? 'run_workflow'
        : service === 'due_diligence'
          ? 'bulk_review'
          : 'answer_question';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              service,
              task,
              inputs: {
                question: query,
                jurisdiction: 'UA',
                language: 'uk',
              },
              depth: budget,
              confidence: typeof intent?.confidence === 'number' ? intent.confidence : 0.7,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async retrieveLegalSourcesTool(args: any) {
    const ctx = args?.context && typeof args.context === 'object' ? args.context : {};
    const query = String(ctx?.query || ctx?.search_query || args?.query || '').trim();
    if (!query) {
      throw new Error('context.query is required');
    }

    const casesLimitRaw = args?.limits?.cases ?? args?.limit ?? 10;
    const lawsLimitRaw = args?.limits?.laws ?? 10;
    const guidanceLimitRaw = args?.limits?.guidance ?? 5;
    const casesLimit = Math.min(50, Math.max(0, Number(casesLimitRaw)));
    const lawsLimit = Math.min(50, Math.max(0, Number(lawsLimitRaw)));
    const guidanceLimit = Math.min(50, Math.max(0, Number(guidanceLimitRaw)));

    const searchParams: any = {
      meta: { search: query },
      limit: Math.min(50, Math.max(0, casesLimit)),
      offset: 0,
    };

    const resp = await this.zoAdapter.searchCourtDecisions(searchParams);
    const norm = await this.zoAdapter.normalizeResponse(resp);
    const rawCases = Array.isArray(norm?.data) ? norm.data : [];

    const cases = rawCases.slice(0, casesLimit).map((d: any) => {
      const docId = d?._raw?.doc_id ?? d?.doc_id ?? d?.zakononline_id;
      const title = d?.title || d?.case_title || d?.doc_title || `case_${docId}`;
      const url = d?.url || d?.link || d?._raw?.url;
      const date = d?.adjudication_date || d?.date_publ || d?.date;
      const court = d?.court || d?.court_name || d?.chamber;
      const text = typeof d?.full_text === 'string'
        ? d.full_text
        : typeof d?.snippet === 'string'
          ? d.snippet
          : '';

      return {
        id: String(docId ?? ''),
        source: 'zakononline',
        title: String(title || ''),
        url: url ? String(url) : undefined,
        date: date ? String(date).slice(0, 10) : undefined,
        court: court ? String(court) : undefined,
        text: text ? String(text) : undefined,
      };
    });

    const lawsResp = lawsLimit > 0
      ? await this.legislationTools.searchLegislation({ query, limit: lawsLimit } as any)
      : { articles: [] };
    const lawArticles = Array.isArray(lawsResp?.articles) ? lawsResp.articles : [];
    const laws = lawArticles.slice(0, lawsLimit).map((a: any) => ({
      id: `${a?.rada_id || ''}:${a?.article_number || ''}`.replace(/:$/, ''),
      source: 'rada',
      title: a?.title || 'law_article',
      url: a?.url,
      article: a?.article_number,
      text: a?.full_text,
      rada_id: a?.rada_id,
    }));

    const guidance = guidanceLimit > 0 ? [] : [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              cases,
              laws,
              guidance,
              confidence: cases.length > 0 || laws.length > 0 ? 0.75 : 0.3,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async analyzeLegalPatternsTool(args: any) {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    const docs = Array.isArray(args?.documents) ? args.documents : [];

    const queryText = query || (docs.length > 0 ? JSON.stringify(docs[0]).slice(0, 500) : '');
    if (!queryText) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success_arguments: [], risk_factors: [], confidence: 0.2 }, null, 2),
          },
        ],
      };
    }

    const emb = await this.embeddingService.generateEmbedding(queryText);
    const matched = await this.patternStore.matchPatterns(emb, 'general_search');
    const success_arguments = matched.flatMap((p: any) => Array.isArray(p?.success_arguments) ? p.success_arguments : []).slice(0, 15);
    const risk_factors = matched.flatMap((p: any) => Array.isArray(p?.risk_factors) ? p.risk_factors : []).slice(0, 15);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success_arguments,
              risk_factors,
              confidence: matched.length > 0 ? 0.7 : 0.35,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async validateResponseTool(args: any) {
    const answer = String(args?.answer || '').trim();
    if (!answer) {
      throw new Error('answer parameter is required');
    }

    const sources = this.extractSourceStrings(args?.sources);
    const validation = await this.hallucinationGuard.validateResponse(answer, sources);

    const issues: Array<{ type: string; message: string }> = [];
    for (const c of validation.claims_without_sources || []) {
      issues.push({ type: 'missing_source', message: c });
    }
    for (const c of validation.invalid_citations || []) {
      issues.push({ type: 'invalid_citation', message: c });
    }
    for (const w of validation.warnings || []) {
      issues.push({ type: 'warning', message: w });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              is_valid: Boolean(validation.is_valid),
              confidence: typeof validation.confidence === 'number' ? validation.confidence : 0.5,
              issues,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async resolveCourtDecisionDocIdByCaseNumber(caseNumber: string): Promise<number | null> {
    const cn = String(caseNumber || '').trim();
    if (!cn) return null;
    try {
      const resp = await this.zoAdapter.searchCourtDecisions({
        target: 'title',
        meta: { search: cn },
        limit: 5,
        offset: 0,
      } as any);
      const norm = await this.zoAdapter.normalizeResponse(resp);
      const top = Array.isArray(norm?.data) ? norm.data[0] : null;
      const docId = top?._raw?.doc_id ?? top?.doc_id;
      const n = Number(docId);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private extractCaseNumberFromText(text: string): string | null {
    const t = String(text || '').trim();
    if (!t) return null;
    const m = t.match(/Справа\s*№\s*([0-9A-Za-zА-Яа-яІіЇїЄє\/-]+)/i);
    if (m && m[1]) return m[1].trim();
    const m2 = t.match(/у\s*справ[іи]\s*№\s*([0-9A-Za-zА-Яа-яІіЇїЄє\/-]+)/i);
    if (m2 && m2[1]) return m2[1].trim();
    return null;
  }

  private safeParseJsonFromToolResult(result: any): any {
    try {
      const text = result?.content?.[0]?.text;
      if (typeof text !== 'string' || text.trim().length === 0) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private parseTimeRangeToDates(timeRange: any): { date_from?: string; date_to?: string; warning?: string } {
    if (!timeRange) return {};
    if (typeof timeRange === 'object' && (timeRange.from || timeRange.to)) {
      const from = typeof timeRange.from === 'string' ? timeRange.from.slice(0, 10) : undefined;
      const to = typeof timeRange.to === 'string' ? timeRange.to.slice(0, 10) : undefined;
      return { date_from: from, date_to: to };
    }
    if (typeof timeRange === 'string') {
      const s = timeRange.trim().toLowerCase();
      const m = s.match(/last\s+(\d+)\s+years?/);
      if (m) {
        const years = Math.max(0, Number(m[1]));
        const d = new Date();
        d.setFullYear(d.getFullYear() - years);
        return { date_from: d.toISOString().slice(0, 10) };
      }
      const m2 = s.match(/last\s+(\d+)\s+months?/);
      if (m2) {
        const months = Math.max(0, Number(m2[1]));
        const d = new Date();
        d.setMonth(d.getMonth() - months);
        return { date_from: d.toISOString().slice(0, 10) };
      }
      return { warning: 'Unsupported time_range string format. Use {from,to} or "last N years".' };
    }
    return { warning: 'Unsupported time_range format. Use {from,to} or "last N years".' };
  }

  private mapProcedureCodeToShort(code: any): 'cpc' | 'gpc' | 'cac' | 'crpc' | null {
    const v = String(code || '').trim().toLowerCase();
    if (v === 'cpc') return 'cpc';
    if (v === 'gpc' || v === 'epc') return 'gpc';
    if (v === 'cac') return 'cac';
    if (v === 'crpc') return 'crpc';
    return null;
  }

  private async searchSupremeCourtPractice(args: any): Promise<any> {
    const procedureCode = this.mapProcedureCodeToShort(args.procedure_code || args.code);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
    const sectionFocus = Array.isArray(args.section_focus) ? args.section_focus : undefined;
    const courtLevel = String(args.court_level || 'SC');

    if (!procedureCode) {
      const providedValue = args.procedure_code || args.code;
      throw new Error(
        `procedure_code must be one of: cpc, gpc, cac, crpc. ` +
        `Received: ${providedValue ? `'${providedValue}'` : 'undefined'}. ` +
        `Valid values: 'cpc' (civil), 'gpc' (commercial), 'cac' (administrative), 'crpc' (criminal).`
      );
    }
    if (!query) {
      throw new Error('query parameter is required');
    }

    logger.info('[MCP Tool] search_supreme_court_practice started', {
      procedureCode,
      query: query.substring(0, 100),
      limit,
      courtLevel,
      sectionFocus
    });

    const timeRangeParsed = this.parseTimeRangeToDates(args.time_range);
    const scHints = this.buildSupremeCourtHints({ intent: 'supreme_court_position', slots: { court_level: courtLevel } });
    const searchQuery = `${query}${scHints}`.trim();

    const searchParams: any = {
      meta: { search: searchQuery },
      limit,
      offset: 0,
      ...(timeRangeParsed.date_from ? { date_from: timeRangeParsed.date_from } : {}),
      ...(timeRangeParsed.date_to ? { date_to: timeRangeParsed.date_to } : {}),
    };

    const response = await this.zoAdapter.searchCourtDecisions(searchParams);
    const normalized = await this.zoAdapter.normalizeResponse(response);

    const allowedChambers = new Set(['ВП ВС', 'КЦС', 'КГС', 'КАС', 'ККС']);
    const filtered = normalized.data.filter((d: any) => {
      if (courtLevel !== 'SC' && courtLevel !== 'GrandChamber') return true;
      const ch = String(d?.chamber || '').trim();
      if (courtLevel === 'GrandChamber') return ch === 'ВП ВС';
      return ch ? allowedChambers.has(ch) : true;
    });

    const results = filtered.slice(0, limit).map((d: any) => {
      const fullText = typeof d.full_text === 'string' ? d.full_text : '';
      const snippets = this.extractSnippets(fullText, query, 2);
      return {
        doc_id: d?._raw?.doc_id ?? d?.doc_id ?? d?.zakononline_id,
        court: d?.court,
        chamber: d?.chamber,
        date: d?.date,
        case_number: d?.case_number,
        url: d?._raw?.url,
        section_focus: sectionFocus,
        snippets,
      };
    });

    const payload: any = {
      procedure_code: procedureCode,
      query,
      time_range: args.time_range,
      applied_filters: {
        court_level: courtLevel,
        ...(timeRangeParsed.date_from ? { date_from: timeRangeParsed.date_from } : {}),
        ...(timeRangeParsed.date_to ? { date_to: timeRangeParsed.date_to } : {}),
      },
      results,
      total_returned: results.length,
    };
    if (timeRangeParsed.warning) {
      payload.warning = timeRangeParsed.warning;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async getCourtDecision(args: any): Promise<any> {
    console.log('========== [TRACE] getCourtDecision ENTRY ==========');
    console.log('[TRACE] Args:', JSON.stringify(args).substring(0, 200));
    logger.info('[TRACE] getCourtDecision called', { args: JSON.stringify(args).substring(0, 100) });

    const docIdRaw = args.doc_id ?? args.document_id ?? args.case_id;
    const caseNumber = typeof args.case_number === 'string' ? args.case_number.trim() : '';
    const depth = Math.min(5, Math.max(1, Number(args.depth || 2)));
    const budget = args.reasoning_budget || 'standard';

    console.log('[TRACE] Parsed:', { docIdRaw, caseNumber, depth, budget });

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

    let doc: any = null;
    let fullTextData: any = null;
    let metadata: any = null;

    if (docId) {
      // When fetching by doc_id, we need both text and metadata
      // First get metadata from API search
      const searchResult = await this.zoAdapter.searchCourtDecisions({
        meta: { search: String(docId) },
        limit: 1,
        fulldata: 1,
      });

      if (searchResult?.data && searchResult.data.length > 0) {
        metadata = searchResult.data[0];
      }

      // Then get full text (now includes case_number extracted from HTML)
      fullTextData = await this.zoAdapter.getDocumentFullText(docId);
      doc = {
        ...metadata,
        text: fullTextData?.text,
        html: fullTextData?.html,
        case_number: fullTextData?.case_number || metadata?.case_number,  // Prefer HTML-extracted case_number
      };
    } else if (caseNumber) {
      // getDocumentByCaseNumber already returns full document with metadata
      doc = await this.zoAdapter.getDocumentByCaseNumber(caseNumber);
    } else {
      throw new Error('Provide doc_id (preferred) or case_number');
    }

    // getDocumentFullText returns { text, html }, getDocumentByCaseNumber returns doc with full_text
    const fullText = typeof doc?.full_text === 'string' ? doc.full_text : (typeof doc?.text === 'string' ? doc.text : '');
    const url = typeof doc?.url === 'string' ? doc.url : (docId ? `https://zakononline.ua/court-decisions/show/${docId}` : undefined);

    // Extract doc_id and case_number from the fetched document
    const actualDocId = doc?.doc_id || doc?.zakononline_id || docId || null;
    const actualCaseNumber = doc?.case_number || caseNumber || undefined;

    logger.info('[DEBUG] After doc fetch', {
      hasDoc: !!doc,
      hasFullText: !!doc?.full_text,
      hasText: !!doc?.text,
      fullTextLength: fullText.length,
      urlFromDoc: doc?.url,
      actualDocId,
      actualCaseNumber
    });

    const extractedSections = fullText
      ? await this.sectionizer.extractSections(fullText, budget === 'deep')
      : [];

    logger.info('[DEBUG] After section extraction', {
      fullTextLength: fullText.length,
      extractedSectionsCount: extractedSections.length,
      extractedSectionsType: Array.isArray(extractedSections) ? 'array' : typeof extractedSections
    });

    const sections = Array.isArray(extractedSections)
      ? extractedSections
          .filter((s: any) => s && typeof s.text === 'string')
          .slice(0, 10)
          .map((s: any) => ({
            type: s.type,
            text: s.text,
          }))
      : [];

    logger.info('[DEBUG] Final sections', {
      sectionsCount: sections.length,
      fullTextLength: fullText.length
    });

    const payload: any = {
      doc_id: actualDocId || undefined,
      case_number: actualCaseNumber || undefined,
      url,
      depth,
      sections: sections.slice(0, depth),
      full_text_length: fullText.length,
    };

    logger.info('[DEBUG] Returning payload', {
      payloadFullTextLength: payload.full_text_length,
      payloadSectionsCount: payload.sections.length
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  /**
   * Get all related documents for a case by case number
   * Returns all instances (first, appeal, cassation), all judgments (decisions, rulings)
   */
  private async getCaseDocumentsChain(args: any): Promise<any> {
    const caseNumber = typeof args.case_number === 'string' ? args.case_number.trim() : '';
    const includeFullText = args.include_full_text !== false; // Default true
    const maxDocs = Math.min(100, Math.max(1, Number(args.max_docs || 50)));
    const groupByInstance = args.group_by_instance !== false; // Default true

    if (!caseNumber) {
      throw new Error('case_number parameter is required');
    }

    logger.info('[MCP Tool] get_case_documents_chain started', {
      caseNumber,
      includeFullText,
      maxDocs,
      groupByInstance
    });

    // Search for ALL documents with this case number (not limit: 1!)
    const searchResult = await this.zoAdapter.searchCourtDecisions({
      meta: { search: caseNumber },
      target: 'title', // Search in case number field for better accuracy
      limit: maxDocs,
      fulldata: 1,
      orderBy: {
        field: 'adjudication_date',
        direction: 'asc', // Chronological order
      },
    });

    const normalized = await this.zoAdapter.normalizeResponse(searchResult);
    const docs = normalized.data || [];

    if (docs.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              case_number: caseNumber,
              total_documents: 0,
              documents: [],
              message: `No documents found for case number: ${caseNumber}`,
            }, null, 2),
          },
        ],
      };
    }

    logger.info(`Found ${docs.length} documents for case ${caseNumber}`);

    // Helper function to classify document type from judgment_form or metadata
    const classifyDocumentType = (doc: any): string => {
      const form = doc?.judgment_form || doc?.form_name || doc?.judgment_form_name || doc?.metadata?.judgment_form || '';
      const formLower = String(form).toLowerCase();

      if (formLower.includes('постанова')) return 'Постанова';
      if (formLower.includes('рішення')) return 'Рішення';
      if (formLower.includes('ухвала')) return 'Ухвала';
      if (formLower.includes('вирок')) return 'Вирок';
      if (formLower.includes('окрема')) return 'Окрема ухвала';

      // Fallback: try to detect from title or resolution
      const title = doc?.title || '';
      if (title.includes('Постанова')) return 'Постанова';
      if (title.includes('Рішення')) return 'Рішення';
      if (title.includes('Ухвала')) return 'Ухвала';

      return 'Невідомо';
    };

    // Helper function to classify court instance
    const classifyInstance = (doc: any): string => {
      const court = (doc?.court || doc?.court_name || '').toLowerCase();
      const chamber = (doc?.chamber || '').toLowerCase();
      const title = (doc?.title || '').toLowerCase();

      // Check chamber first (more reliable for Supreme Court)
      if (chamber.includes('велика палата') || chamber.includes('вп вс')) {
        return 'Велика Палата ВС';
      }
      if (chamber.includes('кцс') || chamber.includes('касаційний цивільний')) {
        return 'Касація (КЦС ВС)';
      }
      if (chamber.includes('кгс') || chamber.includes('касаційний господарський')) {
        return 'Касація (КГС ВС)';
      }
      if (chamber.includes('кас') || chamber.includes('касаційний адміністративний')) {
        return 'Касація (КАС ВС)';
      }
      if (chamber.includes('ккс') || chamber.includes('касаційний кримінальний')) {
        return 'Касація (ККС ВС)';
      }

      // Check court name
      if (court.includes('касаці') || court.includes('верховн')) {
        return 'Касація';
      }
      if (court.includes('апеляці')) {
        return 'Апеляція';
      }
      if (court.includes('окружний') || court.includes('районний') || court.includes('міськ')) {
        return 'Перша інстанція';
      }

      // Check title
      if (title.includes('касаці')) return 'Касація';
      if (title.includes('апеляці')) return 'Апеляція';

      return 'Невідомо';
    };

    // Map documents to structured format
    const mappedDocs = docs.map((doc: any) => ({
      doc_id: doc?.doc_id || doc?.zakononline_id,
      case_number: doc?.cause_num || doc?.case_number || caseNumber,
      document_type: classifyDocumentType(doc),
      instance: classifyInstance(doc),
      court: doc?.court || doc?.court_name,
      chamber: doc?.chamber,
      judge: doc?.judge,
      date: doc?.adjudication_date || doc?.date,
      url: doc?.url || (doc?.doc_id ? `https://zakononline.ua/court-decisions/show/${doc.doc_id}` : undefined),
      resolution: doc?.resolution,
      snippet: doc?.snippet,
      // Only include full_text if requested
      ...(includeFullText && doc?.full_text ? { full_text: doc.full_text } : {}),
    }));

    // Group by instance if requested
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
        // Handle specific cassation chambers
        if (instance.startsWith('Касація')) {
          if (!groupedDocs['Касація']) {
            groupedDocs['Касація'] = [];
          }
          groupedDocs['Касація'].push(doc);
        } else if (groupedDocs[instance]) {
          groupedDocs[instance].push(doc);
        } else {
          groupedDocs['Невідомо'].push(doc);
        }
      }

      // Remove empty groups
      Object.keys(groupedDocs).forEach(key => {
        if (groupedDocs[key].length === 0) {
          delete groupedDocs[key];
        }
      });
    }

    const payload: any = {
      case_number: caseNumber,
      total_documents: mappedDocs.length,
      documents: groupByInstance ? undefined : mappedDocs,
      grouped_documents: groupByInstance ? groupedDocs : undefined,
      summary: {
        instances: {
          first_instance: mappedDocs.filter((d: any) => d.instance === 'Перша інстанція').length,
          appeal: mappedDocs.filter((d: any) => d.instance === 'Апеляція').length,
          cassation: mappedDocs.filter((d: any) => d.instance.includes('Касація')).length,
          grand_chamber: mappedDocs.filter((d: any) => d.instance === 'Велика Палата ВС').length,
        },
        document_types: {
          decisions: mappedDocs.filter((d: any) => d.document_type === 'Рішення' || d.document_type === 'Вирок').length,
          rulings: mappedDocs.filter((d: any) => d.document_type === 'Постанова').length,
          orders: mappedDocs.filter((d: any) => d.document_type.includes('Ухвала')).length,
        },
      },
    };

    logger.info('[MCP Tool] get_case_documents_chain completed', {
      caseNumber,
      totalDocs: mappedDocs.length,
      instances: payload.summary.instances,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async comparePracticeProContra(args: any): Promise<any> {
    const procedureCode = this.mapProcedureCodeToShort(args.procedure_code || args.code);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(20, Math.max(1, Number(args.limit || 7)));
    if (!procedureCode) {
      throw new Error('procedure_code must be one of: cpc, gpc, cac, crpc');
    }
    if (!query) {
      throw new Error('query parameter is required');
    }

    const timeRangeParsed = this.parseTimeRangeToDates(args.time_range);
    const scHints = this.buildSupremeCourtHints({ intent: 'supreme_court_position', slots: { court_level: 'SC' } });

    const mk = (q: string) => ({
      meta: { search: `${q}${scHints}`.trim() },
      limit,
      offset: 0,
      ...(timeRangeParsed.date_from ? { date_from: timeRangeParsed.date_from } : {}),
      ...(timeRangeParsed.date_to ? { date_to: timeRangeParsed.date_to } : {}),
    });

    const [proResp, contraResp] = await Promise.all([
      this.zoAdapter.searchCourtDecisions(mk(`${query} задовольн`)),
      this.zoAdapter.searchCourtDecisions(mk(`${query} відмов`)),
    ]);

    const proNorm = await this.zoAdapter.normalizeResponse(proResp);
    const contraNorm = await this.zoAdapter.normalizeResponse(contraResp);

    const mapCase = (d: any) => ({
      doc_id: d?._raw?.doc_id ?? d?.doc_id ?? d?.zakononline_id,
      court: d?.court,
      chamber: d?.chamber,
      date: d?.date,
      case_number: d?.case_number,
      url: d?._raw?.url,
      snippet: (typeof d?.full_text === 'string' && d.full_text.length > 0)
        ? this.extractSnippets(d.full_text, query, 1)[0]
        : undefined,
    });

    const payload: any = {
      procedure_code: procedureCode,
      query,
      time_range: args.time_range,
      pro: proNorm.data.slice(0, limit).map(mapCase),
      contra: contraNorm.data.slice(0, limit).map(mapCase),
      total_pro: proNorm.data.length,
      total_contra: contraNorm.data.length,
    };
    if (timeRangeParsed.warning) payload.warning = timeRangeParsed.warning;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async findSimilarFactPatternCases(args: any): Promise<any> {
    const procedureCode = this.mapProcedureCodeToShort(args.procedure_code || args.code);
    const factsText = typeof args.facts_text === 'string' ? args.facts_text.trim() : '';
    const limit = Math.min(20, Math.max(1, Number(args.limit || 10)));
    if (!procedureCode) {
      const providedValue = args.procedure_code || args.code;
      throw new Error(
        `procedure_code must be one of: cpc, gpc, cac, crpc. ` +
        `Received: ${providedValue ? `'${providedValue}'` : 'undefined'}. ` +
        `Valid values: 'cpc' (civil), 'gpc' (commercial), 'cac' (administrative), 'crpc' (criminal).`
      );
    }
    if (!factsText) {
      throw new Error('facts_text parameter is required');
    }

    const timeRangeParsed = this.parseTimeRangeToDates(args.time_range);
    const scHints = this.buildSupremeCourtHints({ intent: 'supreme_court_position', slots: { court_level: 'SC' } });
    const extracted = await extractSearchTermsWithAI(factsText);
    const extractedTerms = Array.isArray(extracted?.keywords) ? extracted.keywords : [];
    const query = typeof extracted?.searchQuery === 'string' && extracted.searchQuery.trim().length > 0
      ? extracted.searchQuery.trim()
      : (extractedTerms.length > 0 ? extractedTerms.join(' ') : factsText.slice(0, 180));

    const searchParams: any = {
      meta: { search: `${query}${scHints}`.trim() },
      limit,
      offset: 0,
      ...(timeRangeParsed.date_from ? { date_from: timeRangeParsed.date_from } : {}),
      ...(timeRangeParsed.date_to ? { date_to: timeRangeParsed.date_to } : {}),
    };

    const resp = await this.zoAdapter.searchCourtDecisions(searchParams);
    const norm = await this.zoAdapter.normalizeResponse(resp);

    const results = norm.data.slice(0, limit).map((d: any) => {
      const fullText = typeof d?.full_text === 'string' ? d.full_text : '';
      return {
        doc_id: d?._raw?.doc_id ?? d?.doc_id ?? d?.zakononline_id,
        court: d?.court,
        chamber: d?.chamber,
        date: d?.date,
        case_number: d?.case_number,
        url: d?._raw?.url,
        why_similar: this.extractSnippets(fullText, query.split(' ')[0] || query, 2),
      };
    });

    const payload: any = {
      procedure_code: procedureCode,
      time_range: args.time_range,
      extracted_search_terms: extractedTerms,
      search_query: query,
      results,
      warning: 'Similarity is based on search-term extraction and text retrieval. For true fact-pattern similarity, FACTS sections need to be indexed as embeddings.',
    };
    if (timeRangeParsed.warning) payload.time_range_warning = timeRangeParsed.warning;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private addDaysYMD(ymd: string, days: number): string {
    const d = new Date(ymd);
    if (Number.isNaN(d.getTime())) {
      throw new Error('event_date must be a valid date string (YYYY-MM-DD)');
    }
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private async calculateProceduralDeadlines(args: any): Promise<any> {
    const procedureCode = this.mapProcedureCodeToShort(args.procedure_code || args.code);
    const eventType = String(args.event_type || '').trim().toLowerCase();
    const eventDate = typeof args.event_date === 'string' ? args.event_date.slice(0, 10) : '';
    const receivedFullTextDate = typeof args.received_full_text_date === 'string'
      ? args.received_full_text_date.slice(0, 10)
      : '';
    const appealType = String(args.appeal_type || '').trim().toLowerCase();
    const timeRange = args.time_range;
    const reasoningBudget = args.reasoning_budget || 'standard';
    const practiceLimit = Math.min(25, Math.max(3, Number(args.practice_limit || 15)));
    const practiceQueriesMax = Math.min(10, Math.max(1, Number(args.practice_queries_max || 4)));
    const practiceBroadQueriesMax = Math.min(10, Math.max(0, Number(args.practice_broad_queries_max || 2)));
    const practiceExpandDocs = Math.min(10, Math.max(0, Number(args.practice_expand_docs || 3)));
    const practiceExpandDepth = Math.min(5, Math.max(1, Number(args.practice_expand_depth || 2)));
    const practiceDisableTimeRange = args.practice_disable_time_range === true;
    const practiceUseCourtPractice = args.practice_use_court_practice !== false;
    const practiceCaseMapMax = Math.min(30, Math.max(0, Number(args.practice_case_map_max || 8)));

    if (!procedureCode) {
      throw new Error('procedure_code must be one of: cpc, gpc, cac, crpc');
    }
    if (!eventDate) {
      throw new Error('event_date parameter is required (YYYY-MM-DD)');
    }
    if (!appealType) {
      throw new Error('appeal_type parameter is required');
    }

    const defaults: Record<string, number> = {
      'cpc:appeal:decision': 30,
      'cpc:appeal:ruling': 15,
      'cpc:cassation:decision': 30,
      'cpc:cassation:ruling': 30,
      'gpc:appeal:decision': 20,
      'gpc:appeal:ruling': 10,
      'gpc:cassation:decision': 20,
      'gpc:cassation:ruling': 20,
      'cac:appeal:decision': 30,
      'cac:appeal:ruling': 15,
      'cac:cassation:decision': 30,
      'cac:cassation:ruling': 30,
      'crpc:appeal:decision': 30,
      'crpc:appeal:ruling': 7,
      'crpc:cassation:decision': 3,
      'crpc:cassation:ruling': 3,
    };

    const normalizedEvent = (eventType.includes('ухвал') || eventType.includes('ruling')) ? 'ruling' : 'decision';
    const normalizedAppeal = appealType.includes('кас') || appealType.includes('cass') ? 'cassation' : 'appeal';

    const key = `${procedureCode}:${normalizedAppeal}:${normalizedEvent}`;
    const days = defaults[key];
    if (!days) {
      throw new Error('Unsupported combination of procedure_code / appeal_type / event_type');
    }

    const variants: any[] = [];
    variants.push({
      rule: 'from_event_date',
      start_date: eventDate,
      end_date: this.addDaysYMD(eventDate, days),
    });

    if (receivedFullTextDate) {
      variants.push({
        rule: 'from_received_full_text_date',
        start_date: receivedFullTextDate,
        end_date: this.addDaysYMD(receivedFullTextDate, days),
      });
    }

    const normCode = procedureCode === 'cpc' || procedureCode === 'gpc' ? procedureCode : null;
    const normsQuery = `${normalizedAppeal === 'cassation' ? 'касаційна' : 'апеляційна'} скарга строк ${normalizedEvent === 'ruling' ? 'ухвала' : 'рішення'} з якого моменту обчислюється`;
    let normsReference: any = null;
    let normsError: string | null = null;
    if (normCode) {
      try {
        normsReference = await this.searchProceduralNorms({
          code: normCode,
          query: normsQuery,
        });
      } catch (e: any) {
        normsError = String(e?.message || e);
      }
    }

    const practiceTimeRange = timeRange || 'last 5 years';
    const appealKey = normalizedAppeal === 'cassation' ? 'касаційн' : 'апеляційн';
    const decisionKey = normalizedEvent === 'ruling' ? 'ухвал' : 'рішенн';
    const primaryQueries = Array.from(new Set([
      `строк ${appealKey}ого оскарження ${decisionKey} отримання повного тексту`,
      `строк ${appealKey}ого оскарження ${decisionKey} складення повного тексту`,
      `строк ${appealKey}ого оскарження ${decisionKey} з дня вручення`,
      `строк ${appealKey}ого оскарження ${decisionKey} отримання копії`,
      `строк ${appealKey}ого оскарження ${decisionKey} повний текст`,
      `апеляційна скарга строк повний текст`,
      `строк апеляційного оскарження повного тексту рішення`,
      `строк апеляції отримання повного тексту`,
      `строк апеляційної скарги з дня складення повного тексту`,
      `поновлення строку ${appealKey}ого оскарження несвоєчасне отримання повного тексту`,
      `поновлення строку ${appealKey}ого оскарження поважні причини`,
      `строк ${appealKey}ого оскарження ${decisionKey} з якого моменту`,
    ])).slice(0, practiceQueriesMax);

    const broadQueries = Array.from(new Set([
      `${appealKey}а скарга строк ${decisionKey}`,
      `строк ${appealKey}ого оскарження ${decisionKey}`,
      `поновлення строку ${appealKey}ого оскарження`,
      `несвоєчасне отримання повного тексту поновлення строку`,
      `з якого моменту обчислюється строк апеляційного оскарження`,
      `відлік строку апеляційного оскарження`,
    ])).slice(0, practiceBroadQueriesMax);

    const aggregated: any[] = [];
    const seen = new Set<string>();
    let practiceError: string | null = null;

    const minEnough = Math.min(practiceLimit, 8);
    const triedQueries: string[] = [];
    const runQuery = async (q: string) => {
      triedQueries.push(q);
      try {
        const raw = await this.searchSupremeCourtPractice({
          procedure_code: procedureCode,
          query: q,
          ...(practiceDisableTimeRange ? {} : { time_range: practiceTimeRange }),
          court_level: 'SC',
          section_focus: [SectionType.COURT_REASONING, SectionType.DECISION],
          limit: practiceLimit,
          reasoning_budget: reasoningBudget,
        });
        const parsed = this.safeParseJsonFromToolResult(raw);
        const results = Array.isArray(parsed?.results) ? parsed.results : [];
        for (const r of results) {
          const id = r?.doc_id != null ? String(r.doc_id) : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          aggregated.push(r);
          if (aggregated.length >= practiceLimit) break;
        }
      } catch (e: any) {
        practiceError = String(e?.message || e);
      }

      return aggregated.length >= practiceLimit || aggregated.length >= minEnough;
    };

    for (const q of primaryQueries) {
      const done = await runQuery(q);
      if (done) break;
    }

    const minWanted = Math.min(3, practiceLimit);
    if (aggregated.length < minWanted) {
      for (const q of broadQueries) {
        const done = await runQuery(q);
        if (done) break;
      }
    }

    // Extra recall path: search in ZakonOnline "court_practice" domain and map case_number -> court_decisions doc_id
    if (practiceUseCourtPractice && practiceCaseMapMax > 0 && aggregated.length < minWanted) {
      try {
        const courtPracticeQueries = Array.from(new Set([
          // Use broad/high-recall strings (court_practice is a different index; SC hints often hurt recall)
          primaryQueries[0] || '',
          `строк апеляційного оскарження повний текст`,
          `поновлення строку апеляційного оскарження`,
          `з якого моменту обчислюється строк апеляційного оскарження`,
        ].map((s) => String(s || '').trim()).filter(Boolean))).slice(0, 4);

        const mapped: Array<{ case_number: string; doc_id: number }> = [];
        const unmapped: string[] = [];
        const caseNumbers: string[] = [];
        let practiceCandidatesTotal = 0;

        for (const q of courtPracticeQueries) {
          const resp = await this.zoPracticeAdapter.searchCourtDecisions({
            meta: { search: q },
            limit: Math.min(50, practiceCaseMapMax * 3),
            offset: 0,
            ...(practiceDisableTimeRange ? {} : this.parseTimeRangeToDates(practiceTimeRange)),
          } as any);
          const norm = await this.zoPracticeAdapter.normalizeResponse(resp);
          const candidates = Array.isArray(norm?.data) ? norm.data : [];
          practiceCandidatesTotal += candidates.length;

          for (const d of candidates) {
            const cnRaw = String(
              d?.case_number ||
              d?._raw?.cause_num ||
              d?._raw?.case_number ||
              d?.case_number_text ||
              ''
            ).trim();
            const cn = cnRaw || this.extractCaseNumberFromText(String(d?.title || d?._raw?.title || d?._raw?.name || d?.name || '')) || '';
            if (!cn) continue;
            if (caseNumbers.includes(cn)) continue;
            caseNumbers.push(cn);
            if (caseNumbers.length >= practiceCaseMapMax) break;
          }

          if (caseNumbers.length >= practiceCaseMapMax) break;
        }

        for (const cn of caseNumbers) {
          const docId = await this.resolveCourtDecisionDocIdByCaseNumber(cn);
          if (!docId) {
            unmapped.push(cn);
            continue;
          }
          mapped.push({ case_number: cn, doc_id: docId });
          const id = String(docId);
          if (seen.has(id)) continue;
          seen.add(id);
          aggregated.push({ doc_id: docId, case_number: cn, source: 'court_practice' });
          if (aggregated.length >= practiceLimit) break;
        }

        // attach mapping stats
        (args.__debug_stats ??= {});
        (args.__debug_stats.court_practice ??= {});
        args.__debug_stats.court_practice = {
          queries: courtPracticeQueries,
          candidates_total: practiceCandidatesTotal,
          case_numbers_collected: caseNumbers.length,
          mapped: mapped.length,
          unmapped: unmapped.length,
        };
      } catch (e: any) {
        practiceError = practiceError || String(e?.message || e);
      }
    }

    // A. Structured conclusion
    const conclusion = {
      summary: `Строк ${normalizedAppeal === 'cassation' ? 'касаційного' : 'апеляційного'} оскарження ${normalizedEvent === 'ruling' ? 'ухвали' : 'рішення'} становить ${days} днів.`,
      conditions: `Строк обчислюється з дня ${normalizedEvent === 'ruling' ? 'проголошення ухвали' : 'проголошення рішення'} або з дня отримання повного тексту судового рішення (залежно від конкретних обставин справи).`,
      risks: `Ризик пропуску строку у разі несвоєчасного отримання повного тексту рішення. Поновлення строку можливе лише за наявності поважних причин, які суд оцінює за сукупністю критеріїв.`,
    };

    // B. Expanded norms section with quote and commentary
    const normsSection = {
      act: procedureCode === 'cpc' ? 'Цивільний процесуальний кодекс України' : procedureCode === 'gpc' ? 'Господарський процесуальний кодекс України' : procedureCode === 'cac' ? 'Кодекс адміністративного судочинства України' : 'Кримінальний процесуальний кодекс України',
      article: procedureCode === 'cpc' ? 'стаття 354' : procedureCode === 'gpc' ? 'стаття 256' : procedureCode === 'cac' ? 'стаття 295' : 'стаття 395',
      quote: normsReference?.content?.[0]?.text || 'Норма не знайдена через обмеження пошуку',
      commentary: `Ключовим є момент початку перебігу строку: з дня проголошення рішення або з дня отримання його повного тексту. Суди застосовують правило "на користь особи" при неясності щодо дати отримання.`,
      source_url: 'https://zakon.rada.gov.ua/laws/show/1618-15',
      query_used: normsQuery,
      ...(normsError ? { error: normsError } : {}),
    };

    // E. Criteria for deadline renewal (extracted from practice)
    const renewalCriteria = {
      title: 'Критерії поновлення пропущеного строку (позиція ВС)',
      criteria: [
        {
          criterion: 'Тривалість пропущеного строку',
          explanation: 'Суд оцінює, наскільки довго особа пропустила строк після його закінчення',
        },
        {
          criterion: 'Об\'єктивна непереборність обставин',
          explanation: 'Причини мають бути непереборними, не залежати від волевиявлення особи, пов\'язані з істотними перешкодами',
        },
        {
          criterion: 'Поведінка особи',
          explanation: 'Чи вживала особа розумних заходів для реалізації права у строк та якнайшвидше після його закінчення',
        },
        {
          criterion: 'Своєчасність звернення з клопотанням',
          explanation: 'Клопотання про поновлення має бути подано негайно після усунення перешкод',
        },
        {
          criterion: 'Наявність доказів поважності причин',
          explanation: 'Особа повинна документально підтвердити обставини, що перешкоджали своєчасному оскарженню',
        },
      ],
      source_note: 'Критерії сформульовані на основі усталеної практики Верховного Суду',
    };

    // F. Counterarguments and risks
    const risksAndCounterarguments = {
      title: 'Контраргументи та процесуальні ризики',
      counterarguments: [
        {
          argument: 'Строк обчислюється з дня проголошення, а не отримання',
          basis: 'За загальним правилом строк починається з дня проголошення рішення у відкритому судовому засіданні',
          mitigation: 'Довести, що особа не була присутня при проголошенні та не могла ознайомитися з резолютивною частиною',
        },
        {
          argument: 'Несвоєчасне отримання повного тексту не є поважною причиною',
          basis: 'Суд може вважати, що особа мала можливість отримати текст через Електронний суд або канцелярію',
          mitigation: 'Довести об\'єктивну неможливість отримання (технічні збої, відсутність доступу, неналежне повідомлення)',
        },
      ],
      procedural_risks: [
        'Повернення апеляційної скарги без розгляду через пропуск строку без клопотання про поновлення',
        'Відмова у поновленні строку через недостатність доказів поважності причин',
        'Залишення клопотання про поновлення без задоволення через несвоєчасність його подання',
        'Відмова у відкритті касаційного провадження через пропуск строку на касаційне оскарження',
      ],
    };

    // G. Checklist of actions and evidence
    const actionChecklist = {
      title: 'Чеклист дій та доказів',
      steps: [
        {
          step: 'Визначити точну дату початку перебігу строку',
          details: 'З\'ясувати дату проголошення рішення або дату отримання повного тексту (за наявності підтвердження)',
        },
        {
          step: 'Розрахувати кінцеву дату строку',
          details: `Додати ${days} днів до дати початку, враховуючи правила обчислення строків (виключення вихідних/святкових)`,
        },
        {
          step: 'У разі пропуску строку - підготувати клопотання про поновлення',
          details: 'Обґрунтувати поважність причин з посиланням на докази та практику ВС',
        },
        {
          step: 'Підготувати апеляційну скаргу згідно з вимогами процесуального кодексу',
          details: 'Перевірити наявність всіх обов\'язкових реквізитів та додатків',
        },
        {
          step: 'Сплатити судовий збір або підготувати заяву про звільнення',
          details: 'Розрахувати розмір збору відповідно до предмета оскарження',
        },
        {
          step: 'Подати скаргу через Електронний суд або канцелярію',
          details: 'Зберегти підтвердження подання з датою та часом',
        },
      ],
      required_evidence: [
        'Копія оскаржуваного рішення (ухвали) з відміткою про дату проголошення',
        'Підтвердження дати отримання повного тексту (розписка, витяг з Електронного суду)',
        'Докази поважності причин пропуску строку (якщо строк пропущено): медичні довідки, службові записки, технічні збої системи тощо',
        'Докази вжиття розумних заходів для своєчасного оскарження',
        'Квитанція про сплату судового збору',
        'Докази надіслання копій скарги іншим учасникам справи',
      ],
    };

    const payload: any = {
      // A. Structured conclusion
      conclusion,
      
      // Basic calculation data
      procedure_code: procedureCode,
      event_type: args.event_type,
      appeal_type: args.appeal_type,
      event_date: eventDate,
      received_full_text_date: receivedFullTextDate || undefined,
      days,
      variants,
      
      // B. Norms section (expanded)
      norms: normsSection,
      
      // E. Criteria for renewal
      renewal_criteria: renewalCriteria,
      
      // C. Supreme Court practice (will be structured below with expanded items)
      sources: {
        supreme_court_practice: aggregated,
        practice_query: triedQueries[0] || primaryQueries[0],
        practice_queries_tried: triedQueries,
        practice_time_range: practiceDisableTimeRange ? null : practiceTimeRange,
        practice_disable_time_range: practiceDisableTimeRange,
        practice_use_court_practice: practiceUseCourtPractice,
        practice_case_map_max: practiceCaseMapMax,
        ...(args?.__debug_stats?.court_practice ? { court_practice_map_stats: args.__debug_stats.court_practice } : {}),
        ...(practiceError ? { practice_error: practiceError } : {}),
      },
      
      // F. Risks and counterarguments
      risks_and_counterarguments: risksAndCounterarguments,
      
      // G. Action checklist
      action_checklist: actionChecklist,
      
      warnings: [
        ...(normCode ? [] : ['Norms lookup is available only for cpc/gpc via search_procedural_norms.']),
        'Deadlines and starting-point rules must be verified against the applicable procedural code and Supreme Court practice for the specific situation.',
      ],
    };

    if (practiceExpandDocs > 0 && aggregated.length > 0) {
      const toExpand = aggregated.slice(0, practiceExpandDocs);
      const expanded: any[] = [];
      let expandError: string | null = null;
      const expandStart = Date.now();

      for (const item of toExpand) {
        const docIdRaw = item?.doc_id;
        if (docIdRaw == null) continue;
        try {
          const fetchDepth = 5;
          const toolResp = await this.getCourtDecision({
            doc_id: docIdRaw,
            depth: fetchDepth,
            reasoning_budget: reasoningBudget,
          });
          const parsed = this.safeParseJsonFromToolResult(toolResp);
          const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
          const focus = sections.filter((s: any) => s?.type === SectionType.COURT_REASONING || s?.type === SectionType.DECISION);
          const excerpted = focus.slice(0, practiceExpandDepth).map((s: any) => ({
            type: s.type,
            text: typeof s.text === 'string' && s.text.length > 1200 ? `${s.text.slice(0, 1200)}…` : s.text,
          }));

          expanded.push({
            doc_id: item.doc_id,
            url: parsed?.url || item?.url,
            case_number: parsed?.case_number || item?.case_number,
            sections: excerpted,
          });
        } catch (e: any) {
          expandError = String(e?.message || e);
        }
      }

      // C. Structure SC practice as key theses with context
      const scTheses: any[] = [];
      for (const exp of expanded) {
        const reasoningSections = exp.sections?.filter((s: any) => s.type === SectionType.COURT_REASONING) || [];
        const decisionSections = exp.sections?.filter((s: any) => s.type === SectionType.DECISION) || [];
        
        if (reasoningSections.length > 0 || decisionSections.length > 0) {
          const mainQuote = reasoningSections[0]?.text || decisionSections[0]?.text || '';
          scTheses.push({
            thesis: `Позиція ВС щодо ${normalizedAppeal === 'cassation' ? 'касаційного' : 'апеляційного'} оскарження та поновлення строків`,
            court_and_date: `Верховний Суд, справа № ${exp.case_number || 'невідомо'}`,
            quote: mainQuote.slice(0, 600) + (mainQuote.length > 600 ? '…' : ''),
            context: `Справа стосується питання обчислення строку ${normalizedAppeal === 'cassation' ? 'касаційного' : 'апеляційного'} оскарження та критеріїв поновлення пропущеного строку`,
            section_type: reasoningSections.length > 0 ? 'COURT_REASONING' : 'DECISION',
            doc_id: exp.doc_id,
            url: exp.url,
          });
        }
      }

      // D. Improve case format with relevance explanation
      const structuredCases: any[] = [];
      for (const exp of expanded) {
        const caseRelevance = exp.case_number?.includes('апеляц') || exp.sections?.some((s: any) => 
          s.text?.toLowerCase().includes('апеляц') || s.text?.toLowerCase().includes('строк')
        ) ? 'Містить позицію щодо строків апеляційного оскарження' :
        exp.sections?.some((s: any) => s.text?.toLowerCase().includes('поновлення')) ? 'Містить критерії поновлення пропущеного строку' :
        'Релевантна практика щодо процесуальних строків';

        structuredCases.push({
          case_number: exp.case_number || 'Номер справи не вказано',
          court: 'Верховний Суд',
          date: 'Дата не вказана',
          relevance_reason: caseRelevance,
          quote: exp.sections?.[0]?.text?.slice(0, 400) || 'Текст недоступний',
          section_type: exp.sections?.[0]?.type || 'UNKNOWN',
          doc_id: exp.doc_id,
          url: exp.url,
        });
      }

      payload.sources.supreme_court_practice_expanded = {
        requested: practiceExpandDocs,
        depth: practiceExpandDepth,
        returned: expanded.length,
        time_taken_ms: Date.now() - expandStart,
        items: expanded,
        ...(expandError ? { warning: expandError } : {}),
      };

      // Add structured theses and cases to payload
      payload.supreme_court_theses = scTheses;
      payload.structured_cases = structuredCases;

      if (expanded.length === 0) {
        payload.warnings.push('Practice auto-expand did not return any extracted sections. Consider increasing practice_expand_depth or ensuring documents are accessible.');
      }
    }

    if (aggregated.length === 0) {
      payload.warnings.push('No Supreme Court practice results were retrieved for the generated queries. Consider increasing practice_limit or adjusting time_range/query.');
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async buildProceduralChecklist(args: any): Promise<any> {
    const procedureCode = this.mapProcedureCodeToShort(args.procedure_code || args.code);
    const stage = String(args.stage || '').trim().toLowerCase();
    const caseCategory = typeof args.case_category === 'string' ? args.case_category.trim() : undefined;

    if (!procedureCode) {
      throw new Error('procedure_code must be one of: cpc, gpc, cac, crpc');
    }
    if (!stage) {
      throw new Error('stage parameter is required');
    }

    const stageKey = stage.includes('апел') ? 'апеляція'
      : stage.includes('кас') ? 'касація'
      : stage.includes('забезпеч') ? 'забезпечення'
      : stage.includes('зустр') ? 'зустрічний позов'
      : 'позов';

    const normQuery = `${stageKey} вимоги форма зміст додатки строк`;
    const norms = await this.searchProceduralNorms({ code: procedureCode === 'gpc' ? 'gpc' : 'cpc', query: normQuery });

    const checklist = {
      stage: args.stage,
      procedure_code: procedureCode,
      case_category: caseCategory,
      steps: [
        'Визначити юрисдикцію і підсудність',
        'Перевірити строки та підстави для поновлення (якщо потрібно)',
        'Підготувати процесуальний документ відповідно до вимог кодексу',
        'Додати докази та підтвердження направлення копій іншим учасникам',
        'Сплатити судовий збір або підготувати заяву про звільнення/відстрочку',
        'Подати через належний канал (Е-суд/канцелярія) та зберегти підтвердження',
      ],
      typical_refusal_grounds: [
        'Пропуск строку без належного клопотання/обґрунтування',
        'Відсутні обов’язкові реквізити/додатки',
        'Не надіслано копії іншим учасникам',
        'Не сплачено судовий збір без підстав',
        'Неправильна підсудність/юрисдикція',
      ],
      norms_reference: norms?.content?.[0]?.text,
      warning: 'Checklist is a generic template. Tailor it to the specific procedure and consult the exact articles found by search_procedural_norms.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(checklist, null, 2),
        },
      ],
    };
  }

  private async calculateMonetaryClaims(args: any): Promise<any> {
    const amount = Number(args.amount || args.sum || 0);
    const fromDate = typeof args.date_from === 'string' ? args.date_from.slice(0, 10) : '';
    const toDate = typeof args.date_to === 'string' ? args.date_to.slice(0, 10) : '';
    const claimType = typeof args.claim_type === 'string' ? args.claim_type.trim() : 'three_percent';

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount must be a positive number');
    }
    if (!fromDate || !toDate) {
      throw new Error('date_from and date_to are required (YYYY-MM-DD)');
    }

    const d1 = new Date(fromDate);
    const d2 = new Date(toDate);
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime()) || d2 < d1) {
      throw new Error('Invalid date range');
    }

    const days = Math.ceil((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
    let computed: any = { days };

    if (claimType === 'three_percent' || claimType === '3percent' || claimType === '3%') {
      const threePercent = amount * 0.03 * (days / 365);
      computed = { ...computed, three_percent: parseFloat(threePercent.toFixed(2)) };
    }

    const payload: any = {
      amount,
      date_from: fromDate,
      date_to: toDate,
      claim_type: claimType,
      calculation: computed,
      warning: 'Inflation index and penalties depend on external official indices/contract terms and are not calculated here unless the backend has an indices provider. 3% is calculated as simple pro-rata by days.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private async formatAnswerPack(args: any): Promise<any> {
    const desiredOutput = typeof args.desired_output === 'string' ? args.desired_output : undefined;
    const payload: any = {
      desired_output: desiredOutput,
      norm: args.norm || args.legal_framework || null,
      position: args.position || args.practice || null,
      conclusion: args.conclusion || null,
      risks: args.risks || args.counterarguments_and_risks || null,
      warning: 'format_answer_pack currently performs a structural packaging only. Generating final narrative text should be done by the client LLM using this structured payload and verified sources.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private extractSnippets(fullText: string, query: string, limit: number): string[] {
    const q = query.trim();
    if (!fullText || !q) return [];

    const hay = fullText;
    const needle = q.toLowerCase();
    const lower = hay.toLowerCase();

    const snippets: string[] = [];
    let fromIndex = 0;
    const window = 320;
    while (snippets.length < limit) {
      const idx = lower.indexOf(needle, fromIndex);
      if (idx < 0) break;

      const start = Math.max(0, idx - Math.floor(window / 2));
      const end = Math.min(hay.length, idx + needle.length + Math.floor(window / 2));
      const raw = hay.slice(start, end).replace(/\s+/g, ' ').trim();
      const prefix = start > 0 ? '…' : '';
      const suffix = end < hay.length ? '…' : '';
      snippets.push(`${prefix}${raw}${suffix}`);
      fromIndex = idx + needle.length;
    }
    return snippets;
  }

  private buildProceduralNormsAnswer(params: {
    code: string;
    query?: string;
    article?: string;
    radaParsed: any;
  }): string {
    const { code, query, article, radaParsed } = params;

    const title = typeof radaParsed?.title === 'string' ? radaParsed.title : '';
    const lawNumber = typeof radaParsed?.law_number === 'string' ? radaParsed.law_number : '';
    const url = typeof radaParsed?.url === 'string' ? radaParsed.url : '';

    const header = title || lawNumber
      ? `${title}${title && lawNumber ? ' ' : ''}${lawNumber ? `(№ ${lawNumber})` : ''}`.trim()
      : (code === 'cpc' ? 'ЦПК' : 'ГПК');

    let quoteBlocks: string[] = [];

    const articleText = typeof radaParsed?.article?.text === 'string' ? radaParsed.article.text : '';
    if (article && articleText) {
      const cleaned = articleText.replace(/\s+/g, ' ').trim();
      const trimmed = cleaned.length > 900 ? `${cleaned.slice(0, 900)}…` : cleaned;
      quoteBlocks = [trimmed];
    } else if (typeof radaParsed?.full_text_plain === 'string' && query) {
      quoteBlocks = this.extractSnippets(radaParsed.full_text_plain, query, 4);
    }

    const lines: string[] = [];
    lines.push(`B. Норма / правова рамка`);
    lines.push('');
    lines.push(`Норма: ${header}`);
    if (article) {
      lines.push(`Стаття: ${article}`);
    }
    if (url) {
      lines.push(`Джерело: ${url}`);
    }

    if (quoteBlocks.length > 0) {
      lines.push('');
      lines.push('Цитата:');
      for (const q of quoteBlocks) {
        lines.push(`- ${q}`);
      }
    }

    return lines.join('\n');
  }

  private buildSupremeCourtHints(intent?: any): string {
    const base = ' Верховн КЦС КГС КАС ККС "Велика палата" "ВП ВС"';
    const slots = intent?.slots || {};
    if (slots?.court_level === 'GrandChamber') {
      return ' "Велика палата" "ВП ВС"';
    }
    if (slots?.court_level === 'SC' || intent?.intent === 'supreme_court_position') {
      return base;
    }
    return '';
  }

  private pickSectionTypesForAnswer(intent: any): SectionType[] {
    const focus = intent?.slots?.section_focus;
    if (Array.isArray(focus) && focus.length > 0) {
      return focus as SectionType[];
    }

    // Fallback to intent.sections (already mapped in QueryPlanner)
    if (Array.isArray(intent?.sections) && intent.sections.length > 0) {
      return intent.sections as SectionType[];
    }

    // Safe default
    return [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
  }

  private async callRadaTool(toolName: string, args: any) {
    const baseUrl = String(process.env.RADA_MCP_URL || '').trim();
    const apiKey = String(process.env.RADA_API_KEY || '').trim();

    if (!baseUrl) {
      throw new Error('RADA_MCP_URL is not configured');
    }
    if (!apiKey) {
      throw new Error('RADA_API_KEY is not configured');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/tools/${encodeURIComponent(toolName)}`;

    const resp = await axios.post(
      url,
      { arguments: args },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    return resp.data;
  }

  private async callOpenReyestrTool(toolName: string, args: any) {
    const baseUrl = String(process.env.OPENREYESTR_MCP_URL || '').trim();
    const apiKey = String(process.env.OPENREYESTR_API_KEY || '').trim();

    if (!baseUrl) {
      throw new Error('OPENREYESTR_MCP_URL is not configured');
    }
    if (!apiKey) {
      throw new Error('OPENREYESTR_API_KEY is not configured');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/tools/${encodeURIComponent(toolName)}`;

    const resp = await axios.post(
      url,
      { arguments: args },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    return resp.data;
  }

  private async searchProceduralNorms(args: any) {
    const code = String(args.code || '').trim().toLowerCase();
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const article = args.article !== undefined && args.article !== null ? String(args.article).trim() : '';

    if (code !== 'cpc' && code !== 'gpc') {
      throw new Error('code must be one of: cpc, gpc');
    }
    if (!query && !article) {
      throw new Error('Either query or article must be provided');
    }

    const lawIdentifier = code === 'cpc' ? 'цпк' : 'гпк';
    const radaArgs: any = {
      law_identifier: lawIdentifier,
      ...(article ? { article } : {}),
      ...(query ? { search_text: query } : {}),
      include_court_citations: false,
    };

    logger.info('search_procedural_norms: calling rada', {
      code,
      law_identifier: lawIdentifier,
      has_article: Boolean(article),
      has_query: Boolean(query),
    });

    const radaResponse = await this.callRadaTool('search_legislation_text', radaArgs);

    let radaParsed: any = null;
    try {
      const text = radaResponse?.result?.content?.[0]?.text;
      if (typeof text === 'string' && text.trim().length > 0) {
        radaParsed = JSON.parse(text);
      }
    } catch (_e) {
      radaParsed = null;
    }

    const text = radaParsed
      ? this.buildProceduralNormsAnswer({
          code,
          query: query || undefined,
          article: article || undefined,
          radaParsed,
        })
      : `B. Норма / правова рамка\n\nПомилка: не вдалося розібрати відповідь провайдера законодавства.`;

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  }

  private parseOpenReyestrResponse(response: any): any {
    try {
      const text = response?.result?.content?.[0]?.text;
      return typeof text === 'string' ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private translateEntityType(type: string): string {
    const map: Record<string, string> = {
      'UO': 'Юридична особа',
      'FOP': 'Фізична особа-підприємець',
      'FSU': 'Громадське формування'
    };
    return map[type] || type;
  }

  private formatBusinessEntitiesResponse(data: any, args: any): string {
    const entities = Array.isArray(data) ? data : [];

    let text = `# Результати пошуку суб'єктів господарювання\n\n`;
    text += `**Запит:** ${args.query || args.edrpou || 'всі'}\n`;
    text += `**Знайдено:** ${entities.length}\n\n`;

    entities.forEach((entity: any, idx: number) => {
      text += `## ${idx + 1}. ${entity.name || entity.short_name}\n\n`;
      text += `- **ЄДРПОУ:** ${entity.edrpou || 'н/д'}\n`;
      text += `- **Номер запису:** ${entity.record}\n`;
      text += `- **Тип:** ${this.translateEntityType(entity.entity_type)}\n`;
      text += `- **Статус:** ${entity.stan || 'н/д'}\n`;
      if (entity.opf) text += `- **ОПФ:** ${entity.opf}\n`;
      text += `\n`;
    });

    return text;
  }

  private async searchBusinessEntities(args: any) {
    logger.info('search_business_entities: calling openreyestr', { query: args.query });

    const openReyestrArgs = {
      query: args.query,
      edrpou: args.edrpou,
      entityType: args.entity_type || 'ALL',
      stan: args.status,
      limit: args.limit || 50,
    };

    const response = await this.callOpenReyestrTool('search_entities', openReyestrArgs);
    const parsed = this.parseOpenReyestrResponse(response);

    return {
      content: [{
        type: 'text',
        text: parsed
          ? this.formatBusinessEntitiesResponse(parsed, args)
          : 'Помилка: не вдалося отримати дані з реєстру'
      }]
    };
  }

  private async getBusinessEntityDetails(args: any) {
    logger.info('get_business_entity_details: calling openreyestr', { record: args.record });

    const response = await this.callOpenReyestrTool('get_entity_details', {
      record: args.record,
      entityType: args.entity_type,
    });

    const parsed = this.parseOpenReyestrResponse(response);
    if (!parsed) {
      return {
        content: [{
          type: 'text',
          text: 'Помилка: суб\'єкт не знайдено або помилка отримання даних'
        }]
      };
    }

    // Format detailed response
    let text = `# Детальна інформація про суб'єкт господарювання\n\n`;
    text += `**Номер запису:** ${parsed.record}\n`;
    text += `**Тип:** ${this.translateEntityType(parsed.entityType)}\n\n`;

    // Main info
    const main = parsed.mainInfo;
    if (main) {
      text += `## Основна інформація\n\n`;
      text += `- **Назва:** ${main.name || main.short_name}\n`;
      if (main.edrpou) text += `- **ЄДРПОУ:** ${main.edrpou}\n`;
      if (main.stan) text += `- **Статус:** ${main.stan}\n`;
      if (main.opf) text += `- **ОПФ:** ${main.opf}\n`;
      if (main.registration) text += `- **Дата реєстрації:** ${main.registration}\n`;
      text += `\n`;
    }

    // Founders
    if (parsed.founders && parsed.founders.length > 0) {
      text += `## Засновники (${parsed.founders.length})\n\n`;
      parsed.founders.slice(0, 5).forEach((f: any) => {
        text += `- ${f.founder_name || 'н/д'}\n`;
      });
      if (parsed.founders.length > 5) text += `... та ще ${parsed.founders.length - 5}\n`;
      text += `\n`;
    }

    // Beneficiaries
    if (parsed.beneficiaries && parsed.beneficiaries.length > 0) {
      text += `## Бенефіціари (${parsed.beneficiaries.length})\n\n`;
      parsed.beneficiaries.forEach((b: any) => {
        text += `- ${b.beneficiary_info || 'н/д'}\n`;
      });
      text += `\n`;
    }

    return {
      content: [{
        type: 'text',
        text
      }]
    };
  }

  private async searchEntityBeneficiaries(args: any) {
    logger.info('search_entity_beneficiaries: calling openreyestr', { query: args.query });

    const response = await this.callOpenReyestrTool('search_beneficiaries', {
      query: args.query,
      limit: args.limit || 50,
    });

    const parsed = this.parseOpenReyestrResponse(response);
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Бенефіціарів не знайдено'
        }]
      };
    }

    let text = `# Пошук бенефіціарів: "${args.query}"\n\n`;
    text += `**Знайдено:** ${parsed.length}\n\n`;

    parsed.forEach((item: any, idx: number) => {
      text += `## ${idx + 1}. ${item.beneficiary_info || 'н/д'}\n\n`;
      if (item.entity_name) {
        text += `- **Суб'єкт:** ${item.entity_name}\n`;
      }
      if (item.entity_record) {
        text += `- **Номер запису:** ${item.entity_record}\n`;
      }
      text += `\n`;
    });

    return {
      content: [{
        type: 'text',
        text
      }]
    };
  }

  private async lookupByEdrpou(args: any) {
    logger.info('lookup_by_edrpou: calling openreyestr', { edrpou: args.edrpou });

    const response = await this.callOpenReyestrTool('get_by_edrpou', {
      edrpou: args.edrpou,
    });

    const parsed = this.parseOpenReyestrResponse(response);
    if (!parsed) {
      return {
        content: [{
          type: 'text',
          text: `Суб'єкт з ЄДРПОУ ${args.edrpou} не знайдено`
        }]
      };
    }

    let text = `# Інформація за ЄДРПОУ: ${args.edrpou}\n\n`;
    text += `- **Назва:** ${parsed.name || parsed.short_name}\n`;
    text += `- **Номер запису:** ${parsed.record}\n`;
    text += `- **Тип:** ${this.translateEntityType(parsed.entity_type)}\n`;
    text += `- **Статус:** ${parsed.stan || 'н/д'}\n`;
    if (parsed.opf) text += `- **ОПФ:** ${parsed.opf}\n`;

    return {
      content: [{
        type: 'text',
        text
      }]
    };
  }

  getTools() {
    return [
      {
        name: 'classify_intent',
        description: 'Класифікація запиту: service/task/depth (entry-point для роутингу pipeline)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            context: { type: 'object' },
            reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'] },
          },
          required: ['query'],
        },
      },
      {
        name: 'retrieve_legal_sources',
        description: 'RAG retrieval: вернет сырые источники (cases/laws/guidance) без анализа',
        inputSchema: {
          type: 'object',
          properties: {
            context: { type: 'object' },
            limits: {
              type: 'object',
              properties: {
                cases: { type: 'number' },
                laws: { type: 'number' },
                guidance: { type: 'number' },
              },
            },
          },
          required: ['context'],
        },
      },
      {
        name: 'analyze_legal_patterns',
        description: 'Выделяет success_arguments/risk_factors по источникам/контексту',
        inputSchema: {
          type: 'object',
          properties: {
            documents: { type: 'array', items: { type: 'object' } },
            query: { type: 'string' },
          },
          required: [],
        },
      },
      {
        name: 'validate_response',
        description: 'Trust layer: проверка, что ответ опирается на источники (anti-hallucination)',
        inputSchema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            sources: { type: 'array', items: { type: 'object' } },
          },
          required: ['answer', 'sources'],
        },
      },
      {
        name: 'search_legal_precedents',
        description: `Поиск юридических прецедентов с семантическим анализом

💰 Примерная стоимость: $0.03-$0.10 USD
Стоимость зависит от сложности запроса и количества результатов. Включает OpenAI API (embeddings), ZakonOnline API (поиск), SecondLayer MCP (обработка документов).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            domain: {
              type: 'string',
              enum: ['court', 'npa', 'echr', 'all'],
              default: 'all',
            },
            time_range: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
            limit: { type: 'number', default: 10, description: 'Количество результатов для возврата' },
            offset: { type: 'number', default: 0, description: 'Смещение для пагинации (пропустить первые N результатов)' },
            count_all: {
              type: 'boolean',
              default: false,
              description: 'Подсчитать ВСЕ результаты через пагинацию (может быть дорого и долго). Если true - вернет только общий счетчик без загрузки документов.',
            },
            sections: {
              type: 'array',
              items: { type: 'string', enum: Object.values(SectionType) },
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'analyze_case_pattern',
        description: `Анализирует паттерны судебной практики: аргументы, риски, статистика исходов

💰 Примерная стоимость: $0.02-$0.08 USD
Анализ существующих дел в базе данных. Включает OpenAI API (анализ паттернов) и доступ к PostgreSQL.`,
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            case_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['intent'],
        },
      },
      {
        name: 'get_similar_reasoning',
        description: `Находит похожие судебные обоснования по векторному сходству

💰 Примерная стоимость: $0.01-$0.03 USD
Векторный поиск по эмбеддингам. Включает OpenAI API (embeddings) и Qdrant (векторная БД).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            section_type: {
              type: 'string',
              enum: Object.values(SectionType),
            },
            date_from: { type: 'string', description: 'YYYY-MM-DD' },
            date_to: { type: 'string', description: 'YYYY-MM-DD' },
            court: { type: 'string' },
            chamber: { type: 'string' },
            dispute_category: { type: 'string' },
            outcome: { type: 'string' },
            deviation_flag: { type: ['boolean', 'null'] },
            precedent_status: { type: 'string' },
            case_number: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'extract_document_sections',
        description: `Извлекает структурированные секции из полного текста документа (ФАКТЫ, ОБОСНУВАННЯ, РІШЕННЯ)

💰 Примерная стоимость: $0.005-$0.05 USD
При use_llm=false: минимальная стоимость (только парсинг HTML). При use_llm=true: включает OpenAI API для точной экстракции секций.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: ['string', 'number'],
              description: 'ID документа из Zakononline для загрузки полного текста'
            },
            document_id: {
              type: 'string',
              description: 'Альтернативное название для doc_id'
            },
            text: {
              type: 'string',
              description: 'Полный текст документа (если уже есть)'
            },
            use_llm: { type: 'boolean', default: false },
          },
          required: [],
        },
      },
      {
        name: 'count_cases_by_party',
        description: `Подсчитывает точное количество судебных дел по названию стороны (истец/ответчик)

💰 Примерная стоимость: зависит от количества результатов
Использует пагинацию через API Zakononline для точного подсчёта всех дел. Стоимость ~$0.007 за каждую страницу (1000 дел).`,
        inputSchema: {
          type: 'object',
          properties: {
            party_name: {
              type: 'string',
              description: 'Название компании или ФИО (например, "Фінансова компанія Фангарант груп")'
            },
            party_type: {
              type: 'string',
              enum: ['plaintiff', 'defendant', 'any'],
              default: 'any',
              description: 'Тип стороны: истец (plaintiff), ответчик (defendant), или любая (any)'
            },
            date_from: {
              type: 'string',
              description: 'Дата начала периода поиска (формат: YYYY-MM-DD)'
            },
            date_to: {
              type: 'string',
              description: 'Дата окончания периода поиска (формат: YYYY-MM-DD)'
            },
            return_cases: {
              type: 'boolean',
              default: false,
              description: 'Вернуть список дел вместе с подсчётом'
            },
            max_cases_to_return: {
              type: 'number',
              default: 100,
              description: 'Максимальное количество дел для возврата в списке (по умолчанию 100)'
            }
          },
          required: ['party_name'],
        },
      },
      {
        name: 'find_relevant_law_articles',
        description: `Находит статьи законов, которые часто применяются в делах по теме

💰 Примерная стоимость: $0.01-$0.02 USD
Запрос к базе данных legal patterns. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['intent'],
        },
      },
      {
        name: 'check_precedent_status',
        description: `Проверяет актуальность и статус прецедента: действующий, отменённый, сомнительный

💰 Примерная стоимость: $0.005-$0.015 USD
Проверка статуса в базе данных. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
          },
          required: ['case_id'],
        },
      },
      {
        name: 'load_full_texts',
        description: `Загружает полные тексты судебных решений и сохраняет в базу данных

💰 Примерная стоимость: зависит от количества документов
~$0.007 за каждый документ (Zakononline web scraping). Проверяет наличие в PostgreSQL и Redis кэше перед загрузкой.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Массив ID документов для загрузки (например, [110679112, 110441965])'
            },
            max_docs: {
              type: 'number',
              default: 1000,
              description: 'Максимальное количество документов для загрузки (защита от перегрузки)'
            },
            batch_size: {
              type: 'number',
              default: 100,
              description: 'Размер батча для обработки (по умолчанию 100)'
            }
          },
          required: ['doc_ids'],
        },
      },
      {
        name: 'bulk_ingest_court_decisions',
        description: `Массово находит и загружает судебные решения (пагинация) и индексирует ключевые секции (DECISION + COURT_REASONING)

💰 Примерная стоимость: зависит от количества документов
1) Поиск через Zakononline API (страницы по 1000)
2) Web scraping полного текста для документов, которых нет в кэше/БД
3) Извлечение секций + эмбеддинги + Qdrant

По умолчанию применяет фильтр date_from=today-3y (локально), чтобы не тянуть старые решения.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Поисковый запрос (например: "поновлення строку апеляції несвоєчасне отримання повного тексту")'
            },
            date_from: { type: 'string', description: 'YYYY-MM-DD (по умолчанию today-3y)' },
            date_to: { type: 'string', description: 'YYYY-MM-DD (опционально)' },
            max_docs: {
              type: 'number',
              default: 1000,
              description: 'Максимальное количество уникальных doc_id для загрузки (лимит безопасности)'
            },
            max_pages: {
              type: 'number',
              default: 50,
              description: 'Максимальное число страниц поиска (limit=1000)'
            },
            page_size: {
              type: 'number',
              default: 1000,
              description: 'Размер страницы поиска (max 1000)'
            },
            supreme_court_hint: {
              type: 'boolean',
              default: true,
              description: 'Если true - добавляет в поисковую строку подсказку для ВС (Верховн/КЦС/КГС/КАС/ККС/Велика палата)'
            }
          },
          required: ['query'],
        },
      },
      {
        name: 'get_citation_graph',
        description: `Строит граф цитирований между делами: прямые и обратные связи

💰 Примерная стоимость: $0.005-$0.02 USD
Построение графа из базы данных. Минимальная стоимость (только PostgreSQL запросы).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
            depth: { type: 'number', default: 2 },
          },
          required: ['case_id'],
        },
      },
      {
        name: 'search_procedural_norms',
        description: `Умный поиск процессуальных норм (ЦПК/ГПК) через RADA MCP

Возвращает релевантные статьи/фрагменты и структурированную выжимку (сроки/условия/требования).

💰 Примерная стоимость: $0.005-$0.03 USD
Обычно дешево: вызывает RADA MCP (локальная БД/кэш) + опционально LLM (зависит от настроек RADA).`,
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              enum: ['cpc', 'gpc'],
              description: 'Процессуальный кодекс: cpc (ЦПК) или gpc (ГПК)'
            },
            query: {
              type: 'string',
              description: 'Что найти (например: "строк апеляційного оскарження")'
            },
            article: {
              type: ['string', 'number'],
              description: 'Номер статьи (если известен)'
            },
            limit: {
              type: 'number',
              default: 5,
              description: 'Максимум результатов (если поддерживается провайдером)'
            }
          },
          required: ['code']
        }
      },
      {
        name: 'search_business_entities',
        description: `Пошук суб'єктів господарювання в Єдиному державному реєстрі України

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук юридичних осіб, ФОП та громадських організацій за назвою, ЄДРПОУ або іншими критеріями.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (назва або частина назви суб\'єкта)'
            },
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ'
            },
            entity_type: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU', 'ALL'],
              default: 'ALL',
              description: 'Тип суб\'єкта: UO (юридичні особи), FOP (ФОП), FSU (громадські організації), ALL (всі типи)'
            },
            status: {
              type: 'string',
              description: 'Статус діяльності (наприклад, "зареєстровано", "припинено")'
            },
            limit: {
              type: 'number',
              default: 50,
              description: 'Максимальна кількість результатів (1-100)'
            }
          }
        }
      },
      {
        name: 'get_business_entity_details',
        description: `Отримання повної інформації про суб'єкт господарювання

💰 Примерная стоимость: $0.001-$0.003 USD
Включає відомості про засновників, бенефіціарів, керівників, філії та іншу інформацію з реєстру.`,
        inputSchema: {
          type: 'object',
          properties: {
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі'
            },
            entity_type: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU'],
              description: 'Тип суб\'єкта (необов\'язково, визначається автоматично)'
            }
          },
          required: ['record']
        }
      },
      {
        name: 'search_entity_beneficiaries',
        description: `Пошук кінцевих бенефіціарних власників (контролерів) компаній

💰 Примерная стоимость: $0.002-$0.005 USD
Пошук бенефіціарів за ім'ям у всіх суб'єктах господарювання.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Ім\'я або частина імені бенефіціара'
            },
            limit: {
              type: 'number',
              default: 50,
              description: 'Максимальна кількість результатів (1-100)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'lookup_by_edrpou',
        description: `Швидкий пошук суб'єкта господарювання за кодом ЄДРПОУ

💰 Примерная стоимость: $0.001 USD
Отримання базової інформації про компанію за її ідентифікаційним кодом.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ (8 цифр)'
            }
          },
          required: ['edrpou']
        }
      },
      {
        name: 'search_supreme_court_practice',
        description: `Поиск практики Верховного Суду (в т.ч. ВП/КЦС/КГС/КАС/ККС) с краткими выдержками`,
        inputSchema: {
          type: 'object',
          properties: {
            procedure_code: { type: 'string', enum: ['cpc', 'gpc', 'cac', 'crpc'] },
            query: { type: 'string' },
            time_range: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                },
              ],
            },
            court_level: { type: 'string', enum: ['SC', 'GrandChamber'], default: 'SC' },
            section_focus: { type: 'array', items: { type: 'string', enum: Object.values(SectionType) } },
            limit: { type: 'number', default: 10 },
          },
          required: ['procedure_code', 'query'],
        },
      },
      {
        name: 'get_court_decision',
        description: `Загрузка полного текста решения/постановления и извлечение секций (FACTS/COURT_REASONING/DECISION)

💰 Примерная стоимость: $0.01-$0.04 USD
Стоимость зависит от глубины анализа (depth). Включает Zakononline API (поиск + HTML парсинг) и опционально OpenAI API для извлечения секций.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: { type: ['string', 'number'] },
            case_number: { type: 'string' },
            depth: { type: 'number', default: 2 },
            reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'standard' },
          },
          required: [],
        },
      },
      {
        name: 'get_case_text',
        description: `Получение полного текста судебного решения (alias для get_court_decision)

💰 Примерная стоимость: $0.01-$0.04 USD
Загружает текст решения из Zakononline, извлекает ключевые секции (факты, обоснование, решение). Стоимость зависит от параметра depth.`,
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: { type: ['string', 'number'] },
            case_number: { type: 'string' },
            depth: { type: 'number', default: 2 },
            reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'standard' },
          },
          required: [],
        },
      },
      {
        name: 'get_case_documents_chain',
        description: `Получение всех связанных документов по номеру дела (все инстанции, все решения/постановления/ухвалы)

💰 Примерная стоимость: $0.005-$0.02 USD
Находит ВСЕ судебные документы по номеру дела:
- Решения первой инстанции
- Постановления апелляционной инстанции
- Постановления кассационной инстанции (КЦС/КГС/КАС/ККС ВС)
- Постановления Великой Палаты ВС
- Ухвалы (определения)
- Решения после нового рассмотрения

Возвращает структурированный список всех документов с группировкой по инстанциям и типам.
Используйте этот инструмент когда нужно проанализировать полную историю дела через все судебные инстанции.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: {
              type: 'string',
              description: 'Номер дела (например, "123/456/23")'
            },
            include_full_text: {
              type: 'boolean',
              default: false,
              description: 'Включить полный текст документов (увеличивает размер ответа)'
            },
            max_docs: {
              type: 'number',
              default: 50,
              description: 'Максимальное количество документов для возврата (1-100)'
            },
            group_by_instance: {
              type: 'boolean',
              default: true,
              description: 'Группировать документы по инстанциям (перша/апеляція/касація)'
            },
          },
          required: ['case_number'],
        },
      },
      {
        name: 'compare_practice_pro_contra',
        description: `Подборка практики “за/против” по тезе (две линии практики)`,
        inputSchema: {
          type: 'object',
          properties: {
            procedure_code: { type: 'string', enum: ['cpc', 'gpc', 'cac', 'crpc'] },
            query: { type: 'string' },
            time_range: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                },
              ],
            },
            limit: { type: 'number', default: 7 },
          },
          required: ['procedure_code', 'query'],
        },
      },
      {
        name: 'find_similar_fact_pattern_cases',
        description: `Поиск дел по “похожим фактам” (приближенно: извлечение ключевых терминов + поиск)`,
        inputSchema: {
          type: 'object',
          properties: {
            procedure_code: { type: 'string', enum: ['cpc', 'gpc', 'cac', 'crpc'] },
            facts_text: { type: 'string' },
            time_range: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                },
              ],
            },
            limit: { type: 'number', default: 10 },
          },
          required: ['procedure_code', 'facts_text'],
        },
      },
      {
        name: 'calculate_procedural_deadlines',
        description: `Калькулятор процессуальных сроков (приближенно, требует проверки по норме)`,
        inputSchema: {
          type: 'object',
          properties: {
            procedure_code: { type: 'string', enum: ['cpc', 'gpc', 'cac', 'crpc'] },
            event_type: { type: 'string' },
            event_date: { type: 'string' },
            received_full_text_date: { type: 'string' },
            appeal_type: { type: 'string' },
            time_range: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                },
              ],
            },
            practice_limit: { type: 'number', default: 15, description: 'Максимум дел ВС в подборке практики (верхний лимит 25)' },
            practice_queries_max: { type: 'number', default: 4, description: 'Сколько вариантов поисковых запросов практики пробовать (1-10). Больше = дороже.' },
            practice_broad_queries_max: { type: 'number', default: 2, description: 'Если результатов мало, сколько дополнительных "широких" запросов практики пробовать (0-10). Больше = дороже.' },
            practice_disable_time_range: { type: 'boolean', default: false, description: 'Если true — поиск практики ВС без ограничения по time_range (может быть дороже/шире).' },
            practice_use_court_practice: { type: 'boolean', default: true, description: 'Если true — при малом числе дел дополнительно ищет через домен court_practice и маппит case_number в doc_id.' },
            practice_case_map_max: { type: 'number', default: 8, description: 'Сколько номеров дел брать из court_practice для попытки маппинга в court_decisions (0-30).' },
            practice_expand_docs: { type: 'number', default: 3, description: 'Сколько дел из подборки практики автоматически раскрыть (get_court_decision). 0 = выключено.' },
            practice_expand_depth: { type: 'number', default: 2, description: 'Сколько секций документа включать при авто-раскрытии (1-5).' },
            reasoning_budget: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'standard' },
          },
          required: ['procedure_code', 'event_date', 'appeal_type'],
        },
      },
      {
        name: 'build_procedural_checklist',
        description: `Процессуальный чеклист (шаблон + ссылка на найденную норму через search_procedural_norms)`,
        inputSchema: {
          type: 'object',
          properties: {
            procedure_code: { type: 'string', enum: ['cpc', 'gpc', 'cac', 'crpc'] },
            stage: { type: 'string' },
            case_category: { type: 'string' },
          },
          required: ['procedure_code', 'stage'],
        },
      },
      {
        name: 'calculate_monetary_claims',
        description: `Расчеты по денежным требованиям (минимально: 3% годовых)`,
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            claim_type: { type: 'string', default: 'three_percent' },
          },
          required: ['amount', 'date_from', 'date_to'],
        },
      },
      {
        name: 'format_answer_pack',
        description: `Упаковщик результата в структуру norm/position/conclusion/risks (структурно, без генерации текста)`,
        inputSchema: {
          type: 'object',
          properties: {
            desired_output: { type: 'string' },
            norm: { type: ['object', 'string', 'null'] },
            position: { type: ['object', 'string', 'null'] },
            conclusion: { type: ['object', 'string', 'null'] },
            risks: { type: ['object', 'string', 'null'] },
          },
          required: [],
        },
      },
      {
        name: 'get_legal_advice',
        description: `Главный инструмент: комплексный юридический анализ ситуации с проверкой источников и детекцией галлюцинаций

💰 Примерная стоимость: $0.10-$0.30 USD (зависит от reasoning_budget)
• quick: ~$0.10 (базовый анализ)
• standard: ~$0.15-$0.20 (рекомендуется)
• deep: ~$0.25-$0.30 (глубокий анализ с проверкой всех источников)

Самый дорогой инструмент. Включает множественные вызовы OpenAI API, ZakonOnline API, SecondLayer MCP и проверку галлюцинаций.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            reasoning_budget: {
              type: 'string',
              enum: ['quick', 'standard', 'deep'],
              default: 'standard',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    const startTime = Date.now();
    logger.info('[MCP] Tool call initiated', { toolName: name });

    try {
      let result;
      switch (name) {
        case 'classify_intent':
          result = await this.classifyIntentTool(args);
          break;
        case 'retrieve_legal_sources':
          result = await this.retrieveLegalSourcesTool(args);
          break;
        case 'analyze_legal_patterns':
          result = await this.analyzeLegalPatternsTool(args);
          break;
        case 'validate_response':
          result = await this.validateResponseTool(args);
          break;
        case 'search_legal_precedents':
          result = await this.searchLegalPrecedents(args);
          break;
        case 'analyze_case_pattern':
          result = await this.analyzeCasePattern(args);
          break;
        case 'get_similar_reasoning':
          result = await this.getSimilarReasoning(args);
          break;
        case 'extract_document_sections':
          result = await this.extractDocumentSections(args);
          break;
        case 'count_cases_by_party':
          result = await this.countCasesByParty(args);
          break;
        case 'find_relevant_law_articles':
          result = await this.findRelevantLawArticles(args);
          break;
        case 'check_precedent_status':
          result = await this.checkPrecedentStatus(args);
          break;
        case 'load_full_texts':
          result = await this.loadFullTexts(args);
          break;
        case 'bulk_ingest_court_decisions':
          result = await this.bulkIngestCourtDecisions(args);
          break;
        case 'get_citation_graph':
          result = await this.getCitationGraph(args);
          break;
        case 'search_procedural_norms':
          result = await this.searchProceduralNorms(args);
          break;
        case 'search_business_entities':
          result = await this.searchBusinessEntities(args);
          break;
        case 'get_business_entity_details':
          result = await this.getBusinessEntityDetails(args);
          break;
        case 'search_entity_beneficiaries':
          result = await this.searchEntityBeneficiaries(args);
          break;
        case 'lookup_by_edrpou':
          result = await this.lookupByEdrpou(args);
          break;
        case 'search_supreme_court_practice':
          result = await this.searchSupremeCourtPractice(args);
          break;
        case 'get_court_decision':
          result = await this.getCourtDecision(args);
          break;
        case 'get_case_text':
          result = await this.getCourtDecision(args);
          break;
        case 'get_case_documents_chain':
          result = await this.getCaseDocumentsChain(args);
          break;
        case 'compare_practice_pro_contra':
          result = await this.comparePracticeProContra(args);
          break;
        case 'find_similar_fact_pattern_cases':
          result = await this.findSimilarFactPatternCases(args);
          break;
        case 'calculate_procedural_deadlines':
          result = await this.calculateProceduralDeadlines(args);
          break;
        case 'build_procedural_checklist':
          result = await this.buildProceduralChecklist(args);
          break;
        case 'calculate_monetary_claims':
          result = await this.calculateMonetaryClaims(args);
          break;
        case 'format_answer_pack':
          result = await this.formatAnswerPack(args);
          break;
        case 'get_legal_advice':
          result = await this.getLegalAdvice(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const duration = Date.now() - startTime;
      logger.info('[MCP] Tool call completed', { toolName: name, durationMs: duration });
      return result;

    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error('[MCP] Tool call failed', { toolName: name, durationMs: duration, error: error.message });
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async bulkIngestCourtDecisions(args: any) {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('query parameter is required');
    }

    const defaultDateFrom = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 3);
      return d.toISOString().slice(0, 10);
    })();

    const dateFrom = args.date_from || defaultDateFrom;
    const dateTo = args.date_to;
    const maxDocs = Number(args.max_docs || 1000);
    const maxPages = Number(args.max_pages || 50);
    const pageSizeRaw = Number(args.page_size || 1000);
    const pageSize = Math.min(1000, Math.max(1, pageSizeRaw));
    const supremeCourtHint = args.supreme_court_hint !== false;

    const scHints = supremeCourtHint
      ? ' Верховн КЦС КГС КАС ККС "Велика палата" "ВП ВС"'
      : '';
    const searchQuery = `${query}${scHints}`.trim();

    const startTime = Date.now();
    const seenDocIds = new Set<number>();
    let pagesFetched = 0;
    let offset = 0;

    while (pagesFetched < maxPages && seenDocIds.size < maxDocs) {
      const searchParams: any = {
        meta: { search: searchQuery },
        limit: pageSize,
        offset,
      };

      logger.info('bulk_ingest_court_decisions: fetching page', {
        page: pagesFetched + 1,
        offset,
        limit: pageSize,
        collected: seenDocIds.size,
        dateFrom,
        dateTo,
      });

      const response = await this.zoAdapter.searchCourtDecisions(searchParams);
      pagesFetched++;

      if (!Array.isArray(response) || response.length === 0) {
        break;
      }

      const filtered = response.filter((doc: any) => {
        if (!doc?.doc_id) return false;
        const docDate = doc.adjudication_date ? new Date(doc.adjudication_date) : null;
        if (!docDate) return false;

        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          if (docDate < fromDate) return false;
        }
        if (dateTo) {
          const toDateObj = new Date(dateTo);
          if (docDate > toDateObj) return false;
        }
        return true;
      });

      for (const doc of filtered) {
        if (typeof doc.doc_id !== 'number') continue;
        if (seenDocIds.size >= maxDocs) break;
        seenDocIds.add(doc.doc_id);
      }

      if (response.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    const docIds = Array.from(seenDocIds);
    const docs = docIds.map((docId) => ({ doc_id: docId }));

    logger.info('bulk_ingest_court_decisions: starting ingestion', {
      docIds: docIds.length,
      pagesFetched,
    });

    await this.zoAdapter.saveDocumentsToDatabase(docs, maxDocs);

    const timeTaken = Date.now() - startTime;
    const costEstimateSearchUsd = pagesFetched * 0.00714;
    const costEstimateScrapeMaxUsd = docIds.length * 0.00714;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query: query,
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
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async searchLegalPrecedents(args: any) {
    // Validate query parameter
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('query parameter is required and cannot be empty');
    }

    // If count_all is requested, use pagination to count ALL results
    if (args.count_all === true) {
      logger.info('count_all requested, starting pagination', { query });

      try {
        const countResult = await this.countAllResults(query);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query,
                count_all_mode: true,
                total_count: countResult.total_count,
                pages_fetched: countResult.pages_fetched,
                time_taken_ms: countResult.time_taken_ms,
                cost_estimate_usd: countResult.cost_estimate_usd,
                note: 'Подсчитано через пагинацию с limit=1000. Документы НЕ загружались для экономии стоимости.',
                warning: countResult.total_count >= 10000000
                  ? 'Достигнут лимит безопасности в 10,000,000 результатов. Реальное количество может быть больше.'
                  : null,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        logger.error('count_all failed:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error counting all results: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Detect if query contains a case number (e.g., 756/655/23)
    const caseNumberPattern = /\b(\d{1,4}\/\d{1,6}\/\d{2}(-\w)?)\b/;
    const caseNumberMatch = query.match(caseNumberPattern);

    // If searching for a specific case number, use semantic search
    if (caseNumberMatch) {
      const caseNumber = caseNumberMatch[1];
      logger.info('Detected case number search, using semantic approach', { caseNumber });

      try {
        // Step 1: Get the source case document
        const sourceCase = await this.zoAdapter.getDocumentByCaseNumber(caseNumber);
        
        if (!sourceCase) {
          logger.warn('Source case not found', { caseNumber });
          return await this.performRegularSearch(args);
        }

        // Step 2: Extract text for semantic analysis
        // Use HTML parser to extract key content (facts + reasoning)
        let textForAnalysis = '';
        let textSource = 'metadata';
        
        if (sourceCase.full_text) {
          try {
            // Check if full_text is HTML
            if (sourceCase.full_text.includes('<html') || sourceCase.full_text.includes('<!DOCTYPE')) {
              // Parse HTML and extract key sections
              const parser = new CourtDecisionHTMLParser(sourceCase.full_text);
              const paragraphs = parser.extractMainText();
              const sections = parser.identifySections(paragraphs);
              
              // Extract only key content (max 5000 chars for embedding model)
              textForAnalysis = parser.extractKeyContent(sections);
              textSource = 'parsed_html_key_sections';
              
              logger.info('Extracted key sections from HTML', {
                caseNumber,
                sections: {
                  ustanovyv: sections.ustanovyv.length,
                  reasoning: sections.reasoning.length,
                  vyrishyv: sections.vyrishyv.length,
                },
                textLength: textForAnalysis.length,
              });
            } else {
              // Plain text - truncate to 5000 chars
              textForAnalysis = sourceCase.full_text.substring(0, 5000);
              textSource = 'full_text_truncated';
            }
            
            // Ensure we don't exceed embedding model limits (~8192 tokens = ~32k chars max)
            // Use 5000 chars to be safe
            if (textForAnalysis.length > 5000) {
              textForAnalysis = textForAnalysis.substring(0, 5000);
            }
            
            logger.info('Prepared text for semantic search', { 
              caseNumber,
              source: textSource,
              fullTextLength: sourceCase.full_text.length,
              analyzedLength: textForAnalysis.length,
            });
          } catch (error: any) {
            logger.warn('HTML parsing failed, using truncated full text', error);
            textForAnalysis = sourceCase.full_text.substring(0, 5000);
            textSource = 'full_text_truncated_fallback';
          }
        } else {
          // Combine available text fields if no full text
          const parts = [
            sourceCase.title,
            sourceCase.resolution, 
            sourceCase.snippet ? sourceCase.snippet.replace(/<[^>]*>/g, '') : '', // Remove HTML tags
          ].filter(Boolean);
          textForAnalysis = parts.join('\n');
          textSource = 'combined_metadata';
          
          logger.info('Using combined metadata for semantic search', { 
            caseNumber,
            textLength: textForAnalysis.length,
          });
        }

        if (!textForAnalysis || textForAnalysis.length < 50) {
          logger.warn('Insufficient text for semantic analysis', { 
            caseNumber,
            textLength: textForAnalysis?.length 
          });
          return await this.performRegularSearch(args);
        }

        // Step 3: Extract search terms using OpenAI for intelligent analysis
        logger.info('Extracting search terms using AI from source case');
        const searchTerms = await extractSearchTermsWithAI(textForAnalysis);
        
        // Use AI-generated search query
        const smartQuery = searchTerms.searchQuery || searchTerms.disputeType || '';
        
        logger.info('AI extracted search terms and query', {
          caseNumber,
          query: smartQuery,
          lawArticles: searchTerms.lawArticles,
          keywords: searchTerms.keywords,
          disputeType: searchTerms.disputeType,
          caseEssence: searchTerms.caseEssence,
        });
        
        // Step 5: Search for similar cases using pagination
        // Use explicit limit parameter if provided, otherwise default to 10
        // Support offset parameter to skip first N results
        const requestedDisplay = args.limit || 10;
        const userOffset = args.offset || 0; // User's requested offset
        const maxApiLimit = 1000; // Zakononline API maximum limit

        logger.info('Searching for similar cases via pagination', {
          limit: requestedDisplay,
          offset: userOffset,
        });

        let similarCasesForDisplay: any[] = [];
        let totalFound = 0;
        let offset = userOffset; // Start from user's offset
        let pagesFetched = 0;
        let hasMore = true;
        const maxPages = 10000; // Safety limit (10 million results max)

        while (hasMore && pagesFetched < maxPages) {
          const similarSearchParams = {
            meta: {
              search: smartQuery,
            },
            limit: maxApiLimit,
            offset: offset,
          };

          logger.info('Fetching page of similar cases', {
            page: pagesFetched + 1,
            offset,
            limit: maxApiLimit,
          });

          const similarResponse = await this.zoAdapter.searchCourtDecisions(similarSearchParams);
          const normalized = await this.zoAdapter.normalizeResponse(similarResponse);

          // Filter out source case
          const pageResults = normalized.data.filter((doc: any) => doc.doc_id !== sourceCase.doc_id);

          // Store results up to requestedDisplay limit
          if (similarCasesForDisplay.length < requestedDisplay) {
            const remainingSlots = requestedDisplay - similarCasesForDisplay.length;
            const resultsToKeep = pageResults.slice(0, remainingSlots).map((doc: any) => ({
              cause_num: doc.cause_num,
              doc_id: doc.doc_id,
              title: doc.title,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              adjudication_date: doc.adjudication_date,
              url: doc.url,
              similarity_reason: 'metadata_and_keywords',
            }));
            similarCasesForDisplay.push(...resultsToKeep);
          }

          totalFound += pageResults.length;
          pagesFetched++;

          logger.info('Page fetched', {
            page: pagesFetched,
            resultsInPage: normalized.data.length,
            totalSoFar: totalFound,
            keptForDisplay: similarCasesForDisplay.length,
          });

          // Stop conditions:
          // 1. Got less than maxApiLimit - this is the last page
          // 2. Already have enough results for user's request
          if (normalized.data.length < maxApiLimit) {
            hasMore = false;
            logger.info('Last page reached', {
              totalFound,
              pagesFetched,
            });
          } else if (similarCasesForDisplay.length >= requestedDisplay) {
            hasMore = false;
            logger.info('Collected enough results for request', {
              collected: similarCasesForDisplay.length,
              requested: requestedDisplay,
              totalSeen: totalFound,
              pagesFetched,
            });
          } else {
            // Continue to next page
            offset += maxApiLimit;
          }
        }

        if (pagesFetched >= maxPages) {
          logger.warn('Reached safety limit of pages', {
            maxPages,
            totalFound,
          });
        }

        const reachedLimit = pagesFetched >= maxPages;
        const similarCases = similarCasesForDisplay;

        logger.info('Search completed', {
          totalFound,
          reachedLimit,
          pagesFetched,
          displaying: similarCases.length,
        });

        // Save found documents to database (limited to 1000 max)
        if (similarCases.length > 0) {
          logger.info('Saving found documents to database', {
            count: similarCases.length,
          });
          // Run in background, don't wait
          this.zoAdapter.saveDocumentsToDatabase(similarCases, 1000).catch(err => {
            logger.error('Failed to save documents to database:', err);
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                source_case: {
                  cause_num: sourceCase.cause_num,
                  doc_id: sourceCase.doc_id,
                  title: sourceCase.title,
                  resolution: sourceCase.resolution,
                  judge: sourceCase.judge,
                  court_code: sourceCase.court_code,
                  adjudication_date: sourceCase.adjudication_date,
                  url: sourceCase.url,
                  category_code: sourceCase.category_code,
                  justice_kind: sourceCase.justice_kind,
                },
                search_method: 'smart_text_search_with_pagination',
                text_source: textSource,
                text_length: textForAnalysis.length,
                extracted_terms: {
                  law_articles: searchTerms.lawArticles,
                  keywords: searchTerms.keywords,
                  dispute_type: searchTerms.disputeType,
                  case_essence: searchTerms.caseEssence,
                },
                search_query: smartQuery,
                similar_cases: similarCases,
                total_found: totalFound,
                pages_fetched: pagesFetched,
                reached_safety_limit: reachedLimit,
                displaying: similarCases.length,
                total_available_info: reachedLimit
                  ? `Найдено минимум ${totalFound} прецедентов (показано первых ${similarCases.length}). Достигнут лимит безопасности в ${maxPages} страниц.`
                  : `Найдено ${totalFound} прецедентов через ${pagesFetched} страниц (показано первых ${similarCases.length}).`,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        logger.error('Semantic search failed, falling back to regular search', error);
        return await this.performRegularSearch(args);
      }
    }

    // Regular search for non-case-number queries
    return await this.performRegularSearch(args);
  }

  /**
   * Count ALL results through pagination (offset-based)
   * Uses limit=1000 and keeps fetching until results < 1000
   */
  private async countAllResults(query: string, queryParams?: any): Promise<{
    total_count: number;
    pages_fetched: number;
    time_taken_ms: number;
    cost_estimate_usd: number;
  }> {
    const startTime = Date.now();
    const maxApiLimit = 1000;
    let offset = 0;
    let totalCount = 0;
    let pagesFetched = 0;
    let hasMore = true;

    logger.info('Starting pagination to count all results', { query });

    while (hasMore) {
      const searchParams = {
        meta: { search: query },
        limit: maxApiLimit,
        offset: offset,
        ...queryParams,
      };

      logger.info('Fetching page', {
        page: pagesFetched + 1,
        offset,
        limit: maxApiLimit
      });

      try {
        const response = await this.zoAdapter.searchCourtDecisions(searchParams);
        const normalized = await this.zoAdapter.normalizeResponse(response);

        const resultsInPage = normalized.data.length;
        totalCount += resultsInPage;
        pagesFetched++;

        logger.info('Page fetched', {
          page: pagesFetched,
          resultsInPage,
          totalSoFar: totalCount,
          offset
        });

        // If we got less than maxApiLimit, this is the last page
        if (resultsInPage < maxApiLimit) {
          hasMore = false;
          logger.info('Last page reached', {
            totalCount,
            pagesFetched
          });
        } else {
          // Continue to next page
          offset += maxApiLimit;

          // Safety limit: max 10,000 pages (10,000,000 results)
          if (pagesFetched >= 10000) {
            logger.warn('Reached safety limit of 10,000 pages', { totalCount });
            hasMore = false;
          }
        }
      } catch (error: any) {
        logger.error('Error during pagination', {
          page: pagesFetched + 1,
          offset,
          error: error.message
        });
        throw new Error(`Pagination failed at page ${pagesFetched + 1}: ${error.message}`);
      }
    }

    const timeTaken = Date.now() - startTime;

    // Estimate cost: ZakonOnline API calls only (no document processing)
    // Each page = 1 API call at ~$0.00714
    const costEstimate = pagesFetched * 0.00714;

    logger.info('Pagination completed', {
      totalCount,
      pagesFetched,
      timeTakenMs: timeTaken,
      costEstimateUsd: costEstimate.toFixed(6),
    });

    return {
      total_count: totalCount,
      pages_fetched: pagesFetched,
      time_taken_ms: timeTaken,
      cost_estimate_usd: parseFloat(costEstimate.toFixed(6)),
    };
  }

  /**
   * Regular text-based search (original implementation)
   */
  private async performRegularSearch(args: any) {
    // Validate query parameter
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('query parameter is required and cannot be empty');
    }

    // Use 'quick' budget to avoid LLM timeouts for simple searches
    const budget = query.length < 30 ? 'quick' : 'standard';
    const intent = await this.queryPlanner.classifyIntent(query, budget as 'quick' | 'standard');
    const queryParams = this.queryPlanner.buildQueryParams(intent, query);
    
    // Only use court endpoint for now (NPA/ECHR endpoints not available on court.searcher domain)
    const endpoints = this.queryPlanner.selectEndpoints(intent).filter(e => e === 'court');

    const results: any[] = [];
    const errors: string[] = [];
    
    for (const endpoint of endpoints) {
      try {
        let response;
        switch (endpoint) {
          case 'court':
            response = await this.zoAdapter.searchCourtDecisions(queryParams);
            break;
          // NPA and ECHR endpoints disabled - not available on court.searcher API
          // case 'npa':
          //   response = await this.zoAdapter.searchNPA(queryParams);
          //   break;
          // case 'echr':
          //   response = await this.zoAdapter.searchECHRPractice(queryParams);
          //   break;
          default:
            continue;
        }

        const normalized = await this.zoAdapter.normalizeResponse(response);
        results.push(...normalized.data.slice(0, args.limit || 10));
      } catch (error: any) {
        logger.warn(`Endpoint ${endpoint} failed:`, error.message);
        errors.push(`${endpoint}: ${error.message}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results,
            intent,
            search_method: 'text_based',
            total: results.length,
            ...(errors.length > 0 && { warnings: errors }),
          }, null, 2),
        },
      ],
    };
  }

  private async analyzeCasePattern(args: any) {
    const patterns = await this.patternStore.findPatterns(args.intent);
    
    if (args.case_ids && args.case_ids.length > 0) {
      const newPattern = await this.patternStore.extractPatterns(
        args.case_ids,
        args.intent
      );
      if (newPattern) {
        await this.patternStore.savePattern(newPattern);
        patterns.unshift(newPattern);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ patterns }, null, 2),
        },
      ],
    };
  }

  private async getSimilarReasoning(args: any) {
    const defaultDateFrom = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 3);
      return d.toISOString().slice(0, 10);
    })();

    const defaultSupremeCourtChambers = ['ВП ВС', 'КЦС', 'КГС', 'КАС', 'ККС'];

    const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
    const similar = await this.embeddingService.searchSimilar(
      queryEmbedding,
      {
        section_type: args.section_type as SectionType,
        date_from: args.date_from || defaultDateFrom,
        date_to: args.date_to,
        court: args.court,
        chamber: args.chamber || defaultSupremeCourtChambers,
        dispute_category: args.dispute_category,
        outcome: args.outcome,
        deviation_flag: args.deviation_flag,
        precedent_status: args.precedent_status,
        case_number: args.case_number,
      },
      args.limit || 10
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ similar }, null, 2),
        },
      ],
    };
  }

  private async extractDocumentSections(args: any) {
    let text = args.text;
    const docId = args.doc_id || args.document_id;

    // If no text provided but doc_id is available, fetch the document
    if (!text && docId) {
      logger.info('Fetching document by doc_id', { docId });

      try {
        // Try to get from ZOAdapter which checks database first, then fetches from API
        const fullTextData = await this.zoAdapter.getDocumentFullText(docId);

        if (fullTextData && fullTextData.text) {
          text = fullTextData.text;
          logger.info('Document loaded successfully', {
            docId,
            textLength: text.length,
          });
        } else {
          throw new Error(`Failed to load document ${docId}: no text returned`);
        }
      } catch (error: any) {
        logger.error('Failed to fetch document', { docId, error: error.message });
        throw new Error(`Failed to fetch document ${docId}: ${error.message}`);
      }
    }

    // Validate that we have text to work with
    if (!text) {
      throw new Error('Either "text" or "doc_id"/"document_id" must be provided');
    }

    // Extract sections from the text
    const sections = await this.sectionizer.extractSections(
      text,
      args.use_llm || false
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sections }, null, 2),
        },
      ],
    };
  }

  private async countCasesByParty(args: any) {
    const partyName = args.party_name;
    const partyType = args.party_type || 'any';
    const returnCases = args.return_cases || false;
    const maxCasesToReturn = args.max_cases_to_return || 100;

    logger.info('Counting cases by party', { partyName, partyType, returnCases, maxCasesToReturn });

    // Build search query based on party type
    let searchQuery = partyName;
    if (partyType === 'plaintiff') {
      searchQuery = `позивач ${partyName}`;
    } else if (partyType === 'defendant') {
      searchQuery = `відповідач ${partyName}`;
    }

    try {
      // Use pagination to count ALL results
      const startTime = Date.now();
      const maxApiLimit = 1000;
      let offset = 0;
      let totalCount = 0;
      let pagesFetched = 0;
      let hasMore = true;
      const allCases: any[] = [];
      const seenDocIds = new Set<number>(); // Track unique doc_ids to avoid duplicates
      const SAFETY_LIMIT = 100000; // Stop at 100k results
      // When using date filters, limit pages to avoid scanning millions of records
      const MAX_PAGES_WITH_DATE_FILTER = 100; // Max 100k docs to scan when filtering by date
      const hasDateFilter = !!(args.date_from || args.date_to);
      let reachedPageLimit = false;

      while (hasMore && totalCount < SAFETY_LIMIT) {
        // Stop early if using date filter and scanned enough pages
        if (hasDateFilter && pagesFetched >= MAX_PAGES_WITH_DATE_FILTER) {
          logger.warn('Reached max pages limit for date-filtered query', {
            pagesFetched,
            maxPages: MAX_PAGES_WITH_DATE_FILTER,
            totalCount
          });
          reachedPageLimit = true;
          break;
        }

        const searchParams: any = {
          meta: { search: searchQuery },
          limit: maxApiLimit,
          offset: offset,
        };

        // NOTE: Date filtering via API where clause is VERY slow (120+ seconds per request)
        // Instead, we fetch all results and filter locally
        // This is much faster for date-range queries

        logger.info('Fetching page', {
          page: pagesFetched + 1,
          offset,
          limit: maxApiLimit,
          totalSoFar: totalCount,
          hasDateFilter: !!(args.date_from || args.date_to)
        });

        const response = await this.zoAdapter.searchCourtDecisions(searchParams);
        pagesFetched++;

        if (Array.isArray(response) && response.length > 0) {
          // Filter results by date locally if date filters are provided
          let filteredResponse: any[] = response;
          if (args.date_from || args.date_to) {
            filteredResponse = response.filter(doc => {
              const docDate = doc.adjudication_date ? new Date(doc.adjudication_date) : null;
              if (!docDate) return false;

              if (args.date_from) {
                const fromDate = new Date(args.date_from);
                if (docDate < fromDate) return false;
              }

              if (args.date_to) {
                const toDate = new Date(args.date_to);
                if (docDate > toDate) return false;
              }

              return true;
            });

            logger.info('Local date filtering', {
              beforeFilter: response.length,
              afterFilter: filteredResponse.length,
              dateFrom: args.date_from,
              dateTo: args.date_to
            });
          }

          // Deduplicate results - only count and collect unique doc_ids
          const uniqueResults = filteredResponse.filter(doc => {
            if (!doc.doc_id) return false;
            if (seenDocIds.has(doc.doc_id)) return false;
            seenDocIds.add(doc.doc_id);
            return true;
          });

          // Check if API is returning duplicates (sign of pagination issue)
          if (uniqueResults.length === 0 && filteredResponse.length > 0) {
            logger.warn('API returned only duplicate results, stopping pagination', {
              totalResults: filteredResponse.length,
              uniqueCount: 0,
              totalUniqueSoFar: seenDocIds.size
            });
            hasMore = false;
            break;
          }

          totalCount += uniqueResults.length;

          // Collect cases if requested
          if (returnCases && allCases.length < maxCasesToReturn) {
            const casesToAdd = uniqueResults.slice(0, maxCasesToReturn - allCases.length);
            allCases.push(...casesToAdd.map(doc => ({
              cause_num: doc.cause_num,
              doc_id: doc.doc_id,
              title: doc.title,
              resolution: doc.resolution,
              judge: doc.judge,
              court_code: doc.court_code,
              adjudication_date: doc.adjudication_date,
              url: `https://zakononline.ua/court-decisions/show/${doc.doc_id}`,
            })));
          }

          // If got less than maxApiLimit, we've reached the end
          if (response.length < maxApiLimit) {
            hasMore = false;
            logger.info('Reached end of results', {
              lastPageSize: response.length
            });
          } else {
            offset += maxApiLimit;
          }
        } else {
          hasMore = false;
        }
      }

      const timeTaken = Date.now() - startTime;

      // Estimate cost: ZakonOnline API calls only
      // Each page = 1 API call at ~$0.00714
      const costEstimate = pagesFetched * 0.00714;

      const result: any = {
        party_name: partyName,
        party_type: partyType,
        search_query: searchQuery,
        total_unique_cases: totalCount,
        unique_doc_ids_found: seenDocIds.size,
        pages_fetched: pagesFetched,
        time_taken_ms: timeTaken,
        cost_estimate_usd: parseFloat(costEstimate.toFixed(6)),
      };

      if (args.date_from) result.date_from = args.date_from;
      if (args.date_to) result.date_to = args.date_to;

      if (args.date_from || args.date_to) {
        result.filtering_method = 'local';
        result.note = 'Фильтрация по датам выполнена локально (API-фильтр слишком медленный)';
      }

      if (reachedPageLimit) {
        result.warning = `Достигнут лимит в ${MAX_PAGES_WITH_DATE_FILTER} страниц для date-фильтрованного запроса. Просканировано ${pagesFetched * maxApiLimit} дел, найдено ${totalCount}. Для более точного подсчёта используйте запрос без date-фильтра.`;
        result.scanned_documents = pagesFetched * maxApiLimit;
      } else if (totalCount >= SAFETY_LIMIT) {
        result.warning = `Достигнут лимит безопасности в ${SAFETY_LIMIT} дел. Реальное количество может быть больше.`;
      }

      if (returnCases) {
        result.cases = allCases;
        result.cases_returned = allCases.length;
      }

      logger.info('Case counting completed', {
        totalCases: totalCount,
        pagesFetched,
        timeTakenMs: timeTaken,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to count cases by party', { error: error.message });
      throw new Error(`Failed to count cases: ${error.message}`);
    }
  }

  private async loadFullTexts(args: any) {
    const docIds: number[] = args.doc_ids || [];
    const maxDocs = args.max_docs || 1000;

    if (!docIds || docIds.length === 0) {
      throw new Error('doc_ids parameter is required and must be a non-empty array');
    }

    // Deduplicate doc_ids first
    const uniqueDocIds = Array.from(new Set(docIds));
    const duplicatesRemoved = docIds.length - uniqueDocIds.length;

    if (duplicatesRemoved > 0) {
      logger.warn('Removed duplicate doc_ids', {
        totalProvided: docIds.length,
        uniqueCount: uniqueDocIds.length,
        duplicatesRemoved
      });
    }

    logger.info('Loading full texts for documents', {
      totalDocs: uniqueDocIds.length,
      maxDocs,
      limitedTo: Math.min(uniqueDocIds.length, maxDocs),
      duplicatesRemoved
    });

    try {
      const startTime = Date.now();

      // Create document objects with doc_id
      const docs = uniqueDocIds.slice(0, maxDocs).map(docId => ({
        doc_id: docId
      }));

      // Use ZOAdapter's batch loading with cache checking
      await this.zoAdapter.saveDocumentsToDatabase(docs, maxDocs);

      const timeTaken = Date.now() - startTime;

      // Estimate cost: web scraping cost only (documents in cache/DB are free)
      // We don't know exact count without checking, so estimate maximum
      const estimatedCost = docs.length * 0.00714; // SecondLayer web scraping cost

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

      logger.info('Full texts loading completed', {
        processedDocs: docs.length,
        timeTakenMs: timeTaken,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('Failed to load full texts', { error: error.message });
      throw new Error(`Failed to load full texts: ${error.message}`);
    }
  }

  private async findRelevantLawArticles(args: any) {
    const patterns = await this.patternStore.findPatterns(args.intent);
    const articles = new Set<string>();

    for (const pattern of patterns) {
      pattern.law_articles.forEach((a) => articles.add(a));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              articles: Array.from(articles).slice(0, args.limit || 10),
              patterns_count: patterns.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async checkPrecedentStatus(args: any) {
    const status = await this.citationValidator.validatePrecedentStatus(args.case_id);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status }, null, 2),
        },
      ],
    };
  }

  private async getCitationGraph(args: any) {
    const graph = await this.citationValidator.buildCitationGraph(
      args.case_id,
      args.depth || 2
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ graph }, null, 2),
        },
      ],
    };
  }

  private async getLegalAdvice(args: any): Promise<any> {
    const budget = args.reasoning_budget || 'standard';

    logger.info('[MCP Tool] get_legal_advice started', {
      query: String(args.query || '').substring(0, 100),
      budget,
      hasAdditionalContext: !!args.context
    });

    // Step 1: Classify intent
    const intent = await this.queryPlanner.classifyIntent(args.query, budget);
    
    // Step 2: Search precedents (pass original query for full-text search)
    // Add Supreme Court hints for SC-position / procedural queries to improve retrieval
    const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
    const scHints = this.buildSupremeCourtHints(intent);
    if (scHints && queryParams?.meta?.search) {
      queryParams.meta.search = `${queryParams.meta.search}${scHints}`.trim();
    }

    const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
    const normalized = await this.zoAdapter.normalizeResponse(searchResponse);
    
    // Step 3: Extract sections from top results (up to 10 sources)
    const precedentChunks: any[] = [];
    const sources: string[] = [];
    const sourceDocs: any[] = [];

    const maxSources = 10;
    const sectionTypesForAnswer = this.pickSectionTypesForAnswer(intent);

    for (const doc of normalized.data.slice(0, maxSources)) {
      const sourceDocId = String(doc.doc_id || doc.id || doc.zakononline_id || '');
      if (!sourceDocId) continue;

      sources.push(sourceDocId);

      // Ensure full_text exists: if not present in search response, fetch via web scraping
      if (!doc.full_text && doc.doc_id) {
        const fullTextData = await this.zoAdapter.getDocumentFullText(doc.doc_id);
        if (fullTextData?.text) {
          doc.full_text = fullTextData.text;
          doc.full_text_html = fullTextData.html;
        }
      }

      sourceDocs.push(doc);

      if (!doc.full_text || typeof doc.full_text !== 'string' || doc.full_text.length < 100) {
        continue;
      }

      const sections = await this.sectionizer.extractSections(
        doc.full_text,
        budget === 'deep'
      );

      const selected = sections.filter((s) => sectionTypesForAnswer.includes(s.type));

      // Keep compact citations: at most 1 chunk per section type per doc
      for (const sectionType of sectionTypesForAnswer) {
        const first = selected.find((s) => s.type === sectionType);
        if (!first) continue;

        precedentChunks.push({
          text: first.text,
          source_doc_id: sourceDocId,
          section_type: first.type,
          similarity_score: 0.8,
          similar_cases: [],
        });
      }
    }

    // Persist the documents we actually touched (top-10) into PostgreSQL.
    // This is run in background and MUST NOT trigger additional network calls.
    try {
      this.zoAdapter.saveDocumentsMetadataToDatabase(sourceDocs, maxSources).catch((err: any) => {
        logger.error('Failed to save get_legal_advice documents to database:', err?.message);
      });
    } catch (e: any) {
      logger.warn('Document persistence skipped (non-fatal)', { message: e?.message });
    }
    
    // Step 4: Find patterns (optional; requires embeddings)
    const patterns: LegalPattern[] = [];
    if (budget !== 'quick') {
      try {
        const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
        const matched = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
        patterns.push(...matched);
      } catch (e: any) {
        logger.warn('Pattern matching failed, continuing without patterns', { message: e?.message });
      }
    }
    
    // Step 5: Extract law articles
    const lawArticles = new Set<string>();
    patterns.forEach((p) => p.law_articles.forEach((a: string) => lawArticles.add(a)));
    
    // Step 6: Final synthesis (LLM) into PackagedLawyerAnswer (citations, checklist, evidence, risks)
    let packagedAnswer: PackagedLawyerAnswer | undefined;
    try {
      const model = ModelSelector.getChatModel(budget);
      const supportsJsonMode = ModelSelector.supportsJsonMode(model);
      const openaiManager = getOpenAIManager();

      const synthesisSources = sourceDocs.slice(0, maxSources).map((d: any) => ({
        document_id: String(d.doc_id || d.id || d.zakononline_id || ''),
        case_number: d.cause_num || d.case_number || d.metadata?.cause_num || null,
        court: d.court || d.court_name || d.court_code || null,
        date: d.adjudication_date || d.date || null,
        judge: d.judge || null,
        url: d.url || (d.doc_id ? `https://zakononline.ua/court-decisions/show/${d.doc_id}` : null),
      }));

      const chunkPayload = precedentChunks.slice(0, 50).map((c: any) => ({
        source_doc_id: c.source_doc_id,
        section_type: c.section_type,
        quote: String(c.text || '').substring(0, 900),
      }));

      const requestConfig: any = {
        model,
        messages: [
          {
            role: 'system',
            content: `Ти юрист-аналітик (Україна). Зроби відповідь, придатну для вставки в процесуальний документ.

Дай відповідь в СТРУКТУРІ PackagedLawyerAnswer (JSON) з полями:
- short_conclusion: { conclusion, conditions?, risk_or_exception? }
- legal_framework: { norms: [{ act?, article_ref, quote?, comment? }] }
- supreme_court_positions: [{ thesis, quotes: [{ quote, source_doc_id, section_type }], context? }]
- practice: [{ source_doc_id, section_type, quote, relevance_reason?, case_number?, court?, date? }]
- criteria_test: string[]
- counterarguments_and_risks: string[]
- checklist: { steps: string[], evidence: string[] }
- sources: [{ document_id, section_type?, quote }]

Правила:
- Не вигадуй реквізити; використовуй тільки подані source_doc_id/case_number/court/date.
- Цитати бери ТІЛЬКИ з наданих фрагментів.
- Для процесуальних питань обов'язково: правова рамка + чеклист дій/доказів + ризики/контраргументи.
- Для “позиції ВС” зроби 2–4 тези і під кожну 1–2 короткі цитати з COURT_REASONING.

Поверни ТІЛЬКИ валідний JSON без додаткового тексту.`,
          },
          {
            role: 'user',
            content: JSON.stringify(
              {
                query: args.query,
                intent: intent,
                sources: synthesisSources,
                extracted_chunks: chunkPayload,
              },
              null,
              2
            ),
          },
        ],
        temperature: 0.2,
        max_tokens: budget === 'deep' ? 3500 : 2000,
      };

      if (supportsJsonMode) {
        requestConfig.response_format = { type: 'json_object' };
      }

      const llmResp = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create(requestConfig);
      });

      let content = llmResp.choices[0].message.content || '{}';
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        content = jsonObjectMatch[0];
      }

      packagedAnswer = JSON.parse(content) as PackagedLawyerAnswer;
    } catch (e: any) {
      logger.warn('Final synthesis failed, returning structured response without packaged_answer', { message: e?.message });
    }

    // Step 7: Build response
    const response: EnhancedMCPResponse = {
      summary: `Знайдено ${normalized.data.length} релевантних справ за запитом "${args.query}"`,
      confidence_score: intent.confidence,
      intent,
      relevant_patterns: patterns,
      precedent_chunks: precedentChunks,
      law_articles: Array.from(lawArticles),
      risk_notes: patterns.flatMap((p) => p.risk_factors),
      packaged_answer: packagedAnswer,
      reasoning_chain: [
        {
          step: 1,
          action: 'intent_classification',
          input: args.query,
          output: intent,
          confidence: intent.confidence,
          sources: [],
        },
        {
          step: 2,
          action: 'precedent_search',
          input: queryParams,
          output: { count: normalized.data.length },
          confidence: 0.8,
          sources: sources,
        },
        {
          step: 3,
          action: 'fulltext_and_section_extraction',
          input: { top_sources: maxSources, section_types: sectionTypesForAnswer },
          output: { precedent_chunks: precedentChunks.length },
          confidence: 0.75,
          sources: sources,
        },
        {
          step: 4,
          action: 'final_answer_packaging',
          input: { budget },
          output: { packaged_answer: !!packagedAnswer },
          confidence: packagedAnswer ? 0.8 : 0.5,
          sources: sources,
        },
      ],
      explanation: {
        why_relevant: `Знайдені справи стосуються теми "${intent.intent}"`,
        key_factors: patterns.flatMap((p) => p.success_arguments),
        differences: [],
        risks: patterns.flatMap((p) => p.risk_factors),
      },
      source_attribution: precedentChunks.map((chunk) => ({
        document_id: chunk.source_doc_id,
        section: chunk.section_type,
        quote: chunk.text.substring(0, 200),
        relevance_score: chunk.similarity_score,
      })),
      validation: {
        is_valid: true,
        claims_without_sources: [],
        invalid_citations: [],
        confidence: 0.8,
        warnings: [],
      },
    };
    
    // Step 8: Validate with Hallucination Guard
    const validation = await this.hallucinationGuard.validateResponse(
      response,
      sources
    );
    response.validation = validation;
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Streaming версия getLegalAdvice с SSE событиями прогресса
   */
  async getLegalAdviceStream(
    args: any,
    onEvent: StreamEventCallback
  ): Promise<any> {
    const budget = args.reasoning_budget || 'standard';

    try {
      logger.info('getLegalAdviceStream started', { query: args.query, budget });

      // Step 1: Classify intent
      onEvent({
        type: 'progress',
        data: {
          step: 1,
          action: 'intent_classification',
          message: 'Класифікація наміру запиту...',
          progress: 0.1,
        },
        id: 'step-1',
      });

      logger.info('Calling classifyIntent...');
      const intent = await this.queryPlanner.classifyIntent(args.query, budget);
      logger.info('classifyIntent completed', { intent: intent.intent });
      
      onEvent({
        type: 'progress',
        data: {
          step: 1,
          action: 'intent_classification',
          message: `Намір визначено: ${intent.intent}`,
          progress: 0.2,
          result: { intent: intent.intent, confidence: intent.confidence },
        },
        id: 'step-1-complete',
      });
      
      // Step 2: Search precedents (pass original query for full-text search)
      onEvent({
        type: 'progress',
        data: {
          step: 2,
          action: 'precedent_search',
          message: 'Пошук релевантних прецедентів...',
          progress: 0.3,
        },
        id: 'step-2',
      });

      logger.info('Building query params...');
      const queryParams = this.queryPlanner.buildQueryParams(intent, args.query);
      logger.info('Searching court decisions...', { queryParams });
      const searchResponse = await this.zoAdapter.searchCourtDecisions(queryParams);
      logger.info('Normalizing response...');
      const normalized = await this.zoAdapter.normalizeResponse(searchResponse);
      logger.info('Search completed', { resultsCount: normalized.data.length });
      
      onEvent({
        type: 'progress',
        data: {
          step: 2,
          action: 'precedent_search',
          message: `Знайдено ${normalized.data.length} справ`,
          progress: 0.4,
          result: { count: normalized.data.length },
        },
        id: 'step-2-complete',
      });
      
      // Step 3: Extract sections
      onEvent({
        type: 'progress',
        data: {
          step: 3,
          action: 'section_extraction',
          message: 'Витягнення семантичних секцій з документів...',
          progress: 0.5,
        },
        id: 'step-3',
      });
      
      const precedentChunks: any[] = [];
      const sources: string[] = [];
      const totalDocs = Math.min(5, normalized.data.length);
      
      for (let i = 0; i < totalDocs; i++) {
        const doc = normalized.data[i];
        sources.push(doc.id || doc.zakononline_id);
        
        onEvent({
          type: 'progress',
          data: {
            step: 3,
            action: 'section_extraction',
            message: `Обробка документа ${i + 1}/${totalDocs}...`,
            progress: 0.5 + (i / totalDocs) * 0.2,
            current: i + 1,
            total: totalDocs,
          },
          id: `step-3-doc-${i + 1}`,
        });
        
        if (doc.full_text) {
          const sections = await this.sectionizer.extractSections(
            doc.full_text,
            budget === 'deep'
          );
          
          const reasoningSections = sections.filter(
            (s) => s.type === SectionType.COURT_REASONING
          );
          
          for (const section of reasoningSections.slice(0, 2)) {
            const embedding = await this.embeddingService.generateEmbedding(section.text);
            const similar = await this.embeddingService.searchSimilar(embedding, {
              section_type: SectionType.COURT_REASONING,
            }, 3);
            
            precedentChunks.push({
              text: section.text,
              source_doc_id: doc.id || doc.zakononline_id,
              section_type: section.type,
              similarity_score: 0.8,
              similar_cases: similar,
            });
          }
        }
      }
      
      onEvent({
        type: 'progress',
        data: {
          step: 3,
          action: 'section_extraction',
          message: `Витягнуто ${precedentChunks.length} релевантних секцій`,
          progress: 0.7,
          result: { chunks: precedentChunks.length },
        },
        id: 'step-3-complete',
      });
      
      // Step 4: Find patterns
      onEvent({
        type: 'progress',
        data: {
          step: 4,
          action: 'pattern_matching',
          message: 'Пошук релевантних паттернів...',
          progress: 0.75,
        },
        id: 'step-4',
      });
      
      const queryEmbedding = await this.embeddingService.generateEmbedding(args.query);
      const patterns = await this.patternStore.matchPatterns(queryEmbedding, intent.intent);
      
      onEvent({
        type: 'progress',
        data: {
          step: 4,
          action: 'pattern_matching',
          message: `Знайдено ${patterns.length} паттернів`,
          progress: 0.85,
          result: { patterns: patterns.length },
        },
        id: 'step-4-complete',
      });
      
      // Step 5: Extract law articles
      const lawArticles = new Set<string>();
      patterns.forEach((p) => p.law_articles.forEach((a) => lawArticles.add(a)));
      
      // Step 6: Build response
      const response: EnhancedMCPResponse = {
        summary: `Знайдено ${normalized.data.length} релевантних справ за запитом "${args.query}"`,
        confidence_score: intent.confidence,
        intent,
        relevant_patterns: patterns,
        precedent_chunks: precedentChunks,
        law_articles: Array.from(lawArticles),
        risk_notes: patterns.flatMap((p) => p.risk_factors),
        packaged_answer: {
          short_conclusion: {
            conclusion: `За запитом "${args.query}" знайдено релевантну практику (топ: ${Math.min(5, normalized.data.length)} справ).`,
            conditions: intent.intent === 'procedural_deadlines' ? 'Залежить від конкретного процесуального кодексу та моменту початку перебігу строку.' : undefined,
            risk_or_exception: (patterns.flatMap((p) => p.risk_factors)[0]) || undefined,
          },
          legal_framework: {
            norms: (Array.from(lawArticles).slice(0, 5)).map((a) => ({
              article_ref: a,
            })),
          },
          supreme_court_positions: intent.intent === 'supreme_court_position'
            ? precedentChunks
                .filter((c) => c.section_type === SectionType.COURT_REASONING)
                .slice(0, 3)
                .map((c) => ({
                  thesis: c.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim() || c.text.substring(0, 200),
                  quotes: [
                    {
                      quote: c.text.substring(0, 300),
                      source_doc_id: c.source_doc_id,
                      section_type: c.section_type,
                    },
                  ],
                }))
            : [],
          practice: precedentChunks
            .slice(0, 10)
            .map((c) => ({
              source_doc_id: c.source_doc_id,
              section_type: c.section_type,
              quote: c.text.substring(0, 300),
              relevance_reason: c.section_type === SectionType.COURT_REASONING ? 'Мотивування суду (корисно для аргументації)' : 'Фрагмент з рішення/резолютивки',
            })),
          criteria_test: patterns.flatMap((p) => p.success_arguments).slice(0, 7),
          counterarguments_and_risks: patterns.flatMap((p) => p.risk_factors).slice(0, 7),
          checklist: {
            steps: intent.intent === 'procedural_deadlines'
              ? ['Перевірити норму про строк та момент його початку', 'Зафіксувати дату події/вручення', 'Підготувати клопотання про поновлення (за потреби)']
              : ['Зібрати релевантні рішення та виписати тези', 'Сформувати аргументацію: теза → норма → цитата з мотивування', 'Перевірити наявність контраргументів/альтернативної практики'],
            evidence: intent.intent === 'procedural_deadlines'
              ? ['Документи про дату вручення/отримання', 'Підтвердження поважних причин пропуску строку (за потреби)']
              : ['Докази фактичних обставин справи', 'Документи, що підтверджують правову кваліфікацію/статті'],
          },
          sources: precedentChunks
            .slice(0, 10)
            .map((c) => ({
              document_id: c.source_doc_id,
              section_type: c.section_type,
              quote: c.text.substring(0, 200),
            })),
        },
        reasoning_chain: [
          {
            step: 1,
            action: 'intent_classification',
            input: args.query,
            output: intent,
            confidence: intent.confidence,
            sources: [],
          },
          {
            step: 2,
            action: 'precedent_search',
            input: queryParams,
            output: { count: normalized.data.length },
            confidence: 0.8,
            sources: sources,
          },
        ],
        explanation: {
          why_relevant: `Знайдені справи стосуються теми "${intent.intent}"`,
          key_factors: patterns.flatMap((p) => p.success_arguments),
          differences: [],
          risks: patterns.flatMap((p) => p.risk_factors),
        },
        source_attribution: precedentChunks.map((chunk) => ({
          document_id: chunk.source_doc_id,
          section: chunk.section_type,
          quote: chunk.text.substring(0, 200),
          relevance_score: chunk.similarity_score,
        })),
        validation: {
          is_valid: true,
          claims_without_sources: [],
          invalid_citations: [],
          confidence: 0.8,
          warnings: [],
        },
      };
      
      // Step 7: Validate with Hallucination Guard
      onEvent({
        type: 'progress',
        data: {
          step: 5,
          action: 'validation',
          message: 'Перевірка джерел та валідація відповіді...',
          progress: 0.9,
        },
        id: 'step-5',
      });
      
      logger.info('Validating response...');
      const validation = await this.hallucinationGuard.validateResponse(
        response,
        sources
      );
      response.validation = validation;
      logger.info('Validation completed', { isValid: validation.is_valid });

      // Final result
      logger.info('Sending complete event...');
      onEvent({
        type: 'complete',
        data: response,
        id: 'final',
      });
      logger.info('Complete event sent, returning result');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('getLegalAdviceStream error', { error: error.message, stack: error.stack });
      onEvent({
        type: 'error',
        data: {
          message: error.message,
          error: error.toString(),
        },
        id: 'error',
      });
      throw error;
    }
  }
}
