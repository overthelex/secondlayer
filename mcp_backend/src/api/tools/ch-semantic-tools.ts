/**
 * Semantic search over the Swiss corpus (Qdrant `ch_corpus_bge_cls`).
 *
 * `ch_search_court_decisions` / `ch_search_legislation` are keyword FTS; this is the semantic
 * complement — it finds decisions and articles that describe the query's situation in different
 * words (and across de/fr/it), which keyword search cannot.
 *
 * Collection: 22 312 049 chunks — 1.22M court decisions (entscheidsuche.ch, 2048-char chunks)
 * plus 7.5M legislation articles (Fedlex + 26 cantons, article-as-unit) — bge-m3 with **CLS**
 * pooling to match what tei-bge-m3 produces for every query (mean-pooled collections score
 * ~0.73 against CLS queries; this one scores 1.0 on self-probe).
 *
 * Two collapses keep the result list usable: decision chunks collapse to one hit per ECLI, and
 * legislation defaults to current editions only (`is_current`) so the same article does not
 * appear once per historical edition.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { BgeM3Client } from '../../utils/bge-m3-client.js';
import { logger } from '../../utils/logger.js';

const COLLECTION = process.env.CH_BGE_COLLECTION || 'ch_corpus_bge_cls';
/** Chunks pulled before collapsing — a long decision owns many windows (avg 12 per decision). */
const DECISION_MULTIPLIER = 8;
const ARTICLE_MULTIPLIER = 4;

export class ChSemanticTools extends BaseToolHandler {
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
        name: 'ch_semantic_search',
        annotations: { title: 'Swiss law semantic search', readOnlyHint: true },
        description: `Semantic search over Swiss court decisions and legislation

1.22M decisions (federal + all 26 cantons) and 7.5M legislation articles (Fedlex + cantonal law). Searches by MEANING, not keyword match, and works across languages: a German query finds relevant French or Italian decisions.

When to use what:
• ch_semantic_search — describe a situation or legal question in your own words; find analogous case law or relevant provisions
• ch_search_court_decisions — exact terms, parties, court or date range (date filters)
• ch_search_legislation — find an act by title/abbreviation (OR, ZGB, CC)

Legislation is returned in CURRENT editions only. Follow up with ch_get_court_decision (by ECLI) or ch_get_act_article (point-in-time article text).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A situation or legal question in your own words (any language)' },
            scope: {
              type: 'string',
              enum: ['all', 'decisions', 'legislation'],
              default: 'all',
              description: 'Search decisions, legislation, or both (default all)',
            },
            lang: { type: 'string', enum: ['de', 'fr', 'it', 'rm', 'en'], description: 'Language of the documents (not of the query)' },
            canton: { type: 'string', description: 'Two-letter canton code, or CH for the federal level (e.g. ZH, VD)' },
            limit: { type: 'number', default: 10, maximum: 25, description: 'Max results per category' },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'ch_semantic_search') return null;
    return this.semanticSearch(args);
  }

  private async semanticSearch(args: any): Promise<ToolResult> {
    const { query, scope = 'all', lang, canton, limit = 10 } = args;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Provide query — a situation or legal question in your own words.');
    }
    if (lang && !['de', 'fr', 'it', 'rm', 'en'].includes(String(lang))) {
      return this.wrapResponse('lang must be one of: de, fr, it, rm, en.');
    }
    const cantonCode = canton ? String(canton).trim().toUpperCase() : undefined;
    if (cantonCode && !/^[A-Z]{2}$/.test(cantonCode)) {
      return this.wrapResponse('canton must be a two-letter code (ZH, VD, …) or CH.');
    }
    const lim = Math.min(Number(limit) || 10, 25);
    const wantDecisions = scope === 'all' || scope === 'decisions';
    const wantLegislation = scope === 'all' || scope === 'legislation';

    try {
      const vector = await this.bge.generateEmbedding(String(query));

      const [decisions, legislation] = await Promise.all([
        wantDecisions ? this.searchDecisions(vector, lim, lang, cantonCode) : Promise.resolve(null),
        wantLegislation ? this.searchArticles(vector, lim, lang, cantonCode) : Promise.resolve(null),
      ]);

      if ((decisions?.length ?? 0) === 0 && (legislation?.length ?? 0) === 0) {
        return this.wrapResponse('Nothing relevant found for this query.');
      }
      return this.wrapResponse({
        query,
        searched_over:
          '1.22M Swiss court decisions + 7.5M legislation articles (semantic search, current editions)',
        ...(decisions ? { decisions } : {}),
        ...(legislation ? { legislation } : {}),
      });
    } catch (error: any) {
      logger.error('ch_semantic_search error', { error: error.message });
      return this.wrapError(`Semantic search failed: ${error.message}`);
    }
  }

  private async searchDecisions(
    vector: number[], lim: number, lang?: string, canton?: string
  ): Promise<any[]> {
    const must: any[] = [{ key: 'doc_type', match: { value: 'ch_decision' } }];
    if (lang) must.push({ key: 'language', match: { value: lang } });
    if (canton) must.push({ key: 'canton', match: { value: canton } });

    const hits = await this.qdrant.search(COLLECTION, {
      vector,
      limit: lim * DECISION_MULTIPLIER,
      filter: { must },
      with_payload: true,
    });

    // Collapse chunks to decisions, keeping the best-scoring fragment of each.
    const best = new Map<string, { score: number; payload: any }>();
    for (const h of hits) {
      const p: any = h.payload || {};
      const ecli = String(p.ecli || '');
      if (!ecli) continue;
      const prev = best.get(ecli);
      if (!prev || (h.score || 0) > prev.score) best.set(ecli, { score: h.score || 0, payload: p });
    }
    return [...best.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, lim)
      .map(([ecli, v]) => ({
        ecli,
        court_code: v.payload.court_code,
        chamber: v.payload.chamber,
        canton: v.payload.canton,
        decision_date: v.payload.decision_date,
        language: v.payload.language,
        similarity: Number(v.score.toFixed(3)),
        excerpt: String(v.payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      }));
  }

  private async searchArticles(
    vector: number[], lim: number, lang?: string, canton?: string
  ): Promise<any[]> {
    const must: any[] = [
      { key: 'doc_type', match: { value: 'ch_article' } },
      { key: 'is_current', match: { value: true } },
    ];
    if (lang) must.push({ key: 'lang', match: { value: lang } });
    // For articles the canton lives in `jurisdiction` ('CH' or the canton code).
    if (canton) must.push({ key: 'jurisdiction', match: { value: canton } });

    const hits = await this.qdrant.search(COLLECTION, {
      vector,
      limit: lim * ARTICLE_MULTIPLIER,
      filter: { must },
      with_payload: true,
    });

    // One hit per article: the same article exists once per language (and long articles are
    // split into several chunks), so collapse on act + eId.
    const best = new Map<string, { score: number; payload: any }>();
    for (const h of hits) {
      const p: any = h.payload || {};
      if (p.act_id === undefined || !p.e_id) continue;
      const key = `${p.act_id}/${p.e_id}`;
      const prev = best.get(key);
      if (!prev || (h.score || 0) > prev.score) best.set(key, { score: h.score || 0, payload: p });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, lim)
      .map((v) => ({
        sr_number: v.payload.sr_number,
        abbreviation: v.payload.abbreviation,
        article_number: v.payload.article_number,
        marginal_note: v.payload.marginal_note,
        jurisdiction: v.payload.jurisdiction,
        lang: v.payload.lang,
        valid_from: v.payload.date_from,
        similarity: Number(v.score.toFixed(3)),
        excerpt: String(v.payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      }));
  }
}
