/**
 * Semantic search over the Polish corpus (Qdrant `pl_corpus_bge_cls`).
 *
 * `pl_search_court_decisions` / `pl_search_legislation` are keyword FTS; this is the semantic
 * complement — it finds decisions and provisions that describe the query's situation in other
 * words (and from a query in any language), which keyword search cannot.
 *
 * Collection: 37 440 674 chunks (1536-char windows, bge-m3 CLS pooling to match tei-bge-m3):
 * 33.06M from 2.47M court decisions, 0.91M legislation articles (all editions), 0.49M from
 * PDF-only act texts, 2.86M BZP procurement subjects, plus Sejm titles and open-data rows.
 * Vectors and the HNSW graph live on disk, binary quantization in RAM (same profile as the UA
 * EDRSR collection).
 *
 * Collapses keep the list usable: decision chunks → one hit per decision id; legislation →
 * current editions only (`is_current`), one hit per article (or per act for PDF-only texts);
 * procurement → one hit per notice.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { BgeM3Client } from '../../utils/bge-m3-client.js';
import { logger } from '../../utils/logger.js';
import { COURT_TYPES } from './pl-legal-tools.js';
import { plainText } from './pl-tool-utils.js';

const COLLECTION = process.env.PL_BGE_COLLECTION || 'pl_corpus_bge_cls';
/** Chunks pulled before collapsing — decisions average ~13 windows each. */
const DECISION_MULTIPLIER = 8;
const LEGISLATION_MULTIPLIER = 4;
const PROCUREMENT_MULTIPLIER = 2;
const MAX_LIMIT = 25;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Hit = { score?: number; payload?: Record<string, any> | null };

/** SAOS chunks are HTML windows: drop a tag cut at the window start, then the markup. */
const excerpt = (p: any) => {
  let t = String(p.text || '');
  if (/<\/?(p|div|span|strong|br|table)\b/i.test(t)) t = plainText(t.replace(/^[^<>]{0,120}?>/, '').replace(/<[^>]*$/, ''));
  return t.replace(/\s+/g, ' ').trim().slice(0, 500);
};
const sim = (s: number) => Number(s.toFixed(3));

/** Keep the best-scoring hit per key, ordered by score. */
function collapse(hits: Hit[], keyOf: (p: any) => string | null, lim: number) {
  const best = new Map<string, { score: number; payload: any }>();
  for (const h of hits) {
    const p: any = h.payload || {};
    const key = keyOf(p);
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || (h.score || 0) > prev.score) best.set(key, { score: h.score || 0, payload: p });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, lim);
}

export class PlSemanticTools extends BaseToolHandler {
  private _bge: BgeM3Client | null = null;
  private _qdrant: QdrantClient | null = null;

  constructor(private db: any) {
    super();
  }

  private get bge(): BgeM3Client {
    if (!this._bge) this._bge = new BgeM3Client(process.env.BGE_M3_URL || 'http://tei-bge-m3:80');
    return this._bge;
  }

  private get qdrant(): QdrantClient {
    if (!this._qdrant) {
      const url = process.env.QDRANT_URL || 'http://localhost:6333';
      const apiKey = process.env.QDRANT_API_KEY;
      this._qdrant = new QdrantClient({ url, ...(apiKey && { apiKey }) });
    }
    return this._qdrant;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'pl_semantic_search',
        annotations: { title: 'Семантичний пошук у праві Польщі', readOnlyHint: true },
        description: `Семантичний пошук у судових рішеннях, законодавстві та закупівлях Польщі

2,47 млн рішень судів (загальні, Верховний суд, адміністративні, Конституційний трибунал, KIO), статті чинних редакцій актів Dziennik Ustaw / Monitor Polski і 2,9 млн предметів закупівель BZP. Шукає за ЗМІСТОМ, а не за збігом слів: опишіть ситуацію чи правове питання своїми словами будь-якою мовою.

Коли що:
• pl_semantic_search — ситуація або питання своїми словами; аналогічна практика, релевантні норми
• pl_search_court_decisions — точні слова, сигнатура справи, вид суду, період
• pl_search_legislation — акт за назвою чи ELI

Законодавство — лише чинні редакції. Далі: pl_get_court_decision (за id), pl_get_act_article або pl_get_act (за ELI), pl_get_procurement_notice.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Ситуація або правове питання своїми словами (будь-якою мовою)' },
            scope: {
              type: 'string',
              enum: ['all', 'decisions', 'legislation', 'procurement'],
              default: 'all',
              description: 'Де шукати: all = рішення + законодавство; procurement лише окремо',
            },
            court_type: { type: 'string', enum: Object.keys(COURT_TYPES), description: 'Вид суду (лише для рішень)' },
            date_from: { type: 'string', description: 'Рішення від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Рішення до (YYYY-MM-DD, включно)' },
            limit: { type: 'number', default: 10, maximum: MAX_LIMIT, description: 'Максимум результатів у кожній категорії' },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'pl_semantic_search') return null;
    return this.semanticSearch(args || {});
  }

  private async semanticSearch(args: any): Promise<ToolResult> {
    const { query, scope = 'all', court_type, date_from, date_to, limit = 10 } = args;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query: ситуацію або правове питання своїми словами.');
    }
    if (!['all', 'decisions', 'legislation', 'procurement'].includes(String(scope))) {
      return this.wrapResponse('scope має бути одним із: all, decisions, legislation, procurement.');
    }
    if (court_type && !COURT_TYPES[String(court_type)]) {
      return this.wrapResponse(`court_type має бути одним із: ${Object.keys(COURT_TYPES).join(', ')}.`);
    }
    for (const [k, v] of [['date_from', date_from], ['date_to', date_to]] as const) {
      if (v && !DATE_RE.test(String(v))) return this.wrapResponse(`${k} має бути у форматі YYYY-MM-DD.`);
    }
    const lim = Math.min(Math.max(Number(limit) || 10, 1), MAX_LIMIT);
    const wantDecisions = scope === 'all' || scope === 'decisions';
    const wantLegislation = scope === 'all' || scope === 'legislation';
    const wantProcurement = scope === 'procurement';

    try {
      const vector = await this.bge.generateEmbedding(String(query));
      const [decisions, legislation, procurement] = await Promise.all([
        wantDecisions ? this.searchDecisions(vector, lim, court_type, date_from, date_to) : null,
        wantLegislation ? this.searchLegislation(vector, lim) : null,
        wantProcurement ? this.searchProcurement(vector, lim) : null,
      ]);

      if (!decisions?.length && !legislation?.length && !procurement?.length) {
        return this.wrapResponse('Нічого релевантного за цим запитом не знайдено.');
      }
      return this.wrapResponse({
        query,
        searched_over: 'Польща: 2,47 млн судових рішень, чинне законодавство, закупівлі BZP (семантичний пошук)',
        ...(decisions ? { decisions } : {}),
        ...(legislation ? { legislation } : {}),
        ...(procurement ? { procurement } : {}),
      });
    } catch (error: any) {
      logger.error('pl_semantic_search error', { error: error.message });
      return this.wrapError(`Семантичний пошук не вдався: ${error.message}`);
    }
  }

  private async searchDecisions(
    vector: number[], lim: number, courtType?: string, dateFrom?: string, dateTo?: string,
  ): Promise<any[]> {
    const must: any[] = [{ key: 'doc_type', match: { value: 'pl_decision' } }];
    if (courtType) must.push({ key: 'court_type', match: { any: COURT_TYPES[courtType] } });
    if (dateFrom || dateTo) {
      must.push({
        key: 'decision_date',
        range: {
          ...(dateFrom && { gte: `${dateFrom}T00:00:00Z` }),
          ...(dateTo && { lte: `${dateTo}T23:59:59Z` }),
        },
      });
    }
    const hits = await this.qdrant.search(COLLECTION, {
      vector, limit: lim * DECISION_MULTIPLIER, filter: { must }, with_payload: true,
    });
    return collapse(hits, (p) => (p.decision_id ? String(p.decision_id) : null), lim).map((v) => ({
      id: v.payload.decision_id,
      case_number: v.payload.case_number,
      court_type: v.payload.court_type,
      court_name: v.payload.court_name,
      decision_type: v.payload.decision_type,
      decision_date: v.payload.decision_date,
      ...(v.payload.ecli && { ecli: v.payload.ecli }),
      similarity: sim(v.score),
      excerpt: excerpt(v.payload),
    }));
  }

  private async searchLegislation(vector: number[], lim: number): Promise<any[]> {
    const hits = await this.qdrant.search(COLLECTION, {
      vector,
      limit: lim * LEGISLATION_MULTIPLIER,
      filter: {
        must: [
          { key: 'doc_type', match: { any: ['pl_article', 'pl_act_text'] } },
          { key: 'is_current', match: { value: true } },
        ],
      },
      with_payload: true,
    });
    // Long articles and PDF-only act texts are split into several windows: one hit each.
    const keyOf = (p: any) => {
      if (!p.snapshot_eli) return null;
      return p.doc_type === 'pl_article' ? `${p.snapshot_eli}#${p.art_no}` : String(p.snapshot_eli);
    };
    return collapse(hits, keyOf, lim).map((v) => ({
      act_eli: v.payload.act_eli,
      title: v.payload.title,
      act_type: v.payload.act_type,
      ...(v.payload.doc_type === 'pl_article'
        ? { article: v.payload.art_display || v.payload.art_no, art_no: v.payload.art_no }
        : { whole_act_text: true }),
      similarity: sim(v.score),
      excerpt: excerpt(v.payload),
    }));
  }

  private async searchProcurement(vector: number[], lim: number): Promise<any[]> {
    const hits = await this.qdrant.search(COLLECTION, {
      vector,
      limit: lim * PROCUREMENT_MULTIPLIER,
      filter: { must: [{ key: 'doc_type', match: { value: 'pl_bzp' } }] },
      with_payload: true,
    });
    return collapse(hits, (p) => (p.object_id != null ? String(p.object_id) : null), lim).map((v) => ({
      object_id: v.payload.object_id,
      notice_type: v.payload.notice_type,
      publication_date: v.payload.publication_date,
      order_type: v.payload.order_type,
      cpv_code: v.payload.cpv_code,
      organization_name: v.payload.organization_name,
      similarity: sim(v.score),
      excerpt: excerpt(v.payload),
    }));
  }
}
