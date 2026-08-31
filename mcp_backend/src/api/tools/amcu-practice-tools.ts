/**
 * Semantic search over АМКУ decisions (Qdrant `amcu_bge_cls`).
 *
 * `search_registry(amcu_decisions)` already does keyword FTS over the same table via the GIN
 * index. What it cannot do is answer "practice about X" when X is phrased differently from the
 * decision text — competition decisions describe the same conduct as "антиконкурентні узгоджені
 * дії", "спотворення результатів торгів" or "змова", and a keyword query only finds the wording
 * it was given. This tool is the semantic complement, not a replacement.
 *
 * Collection: 174 382 chunks from 2 600 decisions, bge-m3 with **CLS** pooling to match what
 * prod's tei-bge-m3 produces for every user query. Verified after load: re-embedding a stored
 * chunk's own text through the live query path scores 1.0000 against itself.
 *
 * Chunks are collapsed to one hit per decision — a long decision matches on many windows, and
 * without collapsing a single case floods the whole result list.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { BgeM3Client } from '../../utils/bge-m3-client.js';
import { logger } from '../../utils/logger.js';

const COLLECTION = process.env.AMCU_BGE_COLLECTION || 'amcu_bge_cls';
/** Chunks to pull before collapsing to decisions — a long decision can own many windows. */
const CANDIDATE_MULTIPLIER = 8;

export class AmcuPracticeTools extends BaseToolHandler {
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
        name: 'search_amcu_practice',
        annotations: { title: 'Практика АМКУ (семантичний пошук)', readOnlyHint: true },
        description: `Семантичний пошук по рішеннях Антимонопольного комітету України

2 600 рішень з повним текстом, 174K фрагментів. Шукає ЗА ЗМІСТОМ, а не за збігом слів — знаходить релевантну практику, навіть якщо в рішенні вжито інше формулювання (наприклад «антиконкурентні узгоджені дії» на запит «змова на торгах»).

Коли що використовувати:
• search_amcu_practice — «яка практика АМКУ щодо…», опис фабули, пошук аналогічних порушень
• search_registry(amcu_decisions) — коли відомий номер рішення, дата або точне формулювання
• search_registry(amcu_bid_rigging) — коли треба перевірити конкретну компанію за ЄДРПОУ у переліку спотворення торгів

Повертає рішення (не окремі фрагменти) з найрелевантнішою цитатою та оцінкою схожості.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Опис ситуації або правового питання' },
            date_from: { type: 'string', description: 'Не раніше цієї дати (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Не пізніше цієї дати (YYYY-MM-DD)' },
            limit: { type: 'number', default: 10, maximum: 25, description: 'Макс. рішень' },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'search_amcu_practice') return null;
    return this.searchPractice(args);
  }

  private tsOf(d?: string): number | null {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return parseInt(d.replace(/-/g, ''), 10);
  }

  private async searchPractice(args: any): Promise<ToolResult> {
    const { query, date_from, date_to, limit = 10 } = args;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Вкажіть query — опис ситуації або правового питання.');
    }
    for (const [k, v] of [['date_from', date_from], ['date_to', date_to]] as const) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
        return this.wrapResponse(`${k} має бути у форматі YYYY-MM-DD.`);
      }
    }
    const lim = Math.min(Number(limit) || 10, 25);

    try {
      const vector = await this.bge.generateEmbedding(String(query));

      const must: any[] = [];
      const from = this.tsOf(date_from);
      const to = this.tsOf(date_to);
      if (from !== null || to !== null) {
        must.push({
          key: 'decision_date_ts',
          range: { ...(from !== null ? { gte: from } : {}), ...(to !== null ? { lte: to } : {}) },
        });
      }

      const hits = await this.qdrant.search(COLLECTION, {
        vector,
        limit: lim * CANDIDATE_MULTIPLIER,
        ...(must.length ? { filter: { must } } : {}),
        with_payload: true,
      });

      // Collapse chunks to decisions, keeping the best-scoring fragment of each.
      const best = new Map<number, { score: number; text: string; payload: any }>();
      for (const h of hits) {
        const p: any = h.payload || {};
        const id = Number(p.amcu_id);
        if (!Number.isInteger(id)) continue;
        const prev = best.get(id);
        if (!prev || (h.score || 0) > prev.score) {
          best.set(id, { score: h.score || 0, text: String(p.text || ''), payload: p });
        }
      }
      const top = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, lim);
      if (top.length === 0) {
        return this.wrapResponse('Релевантної практики АМКУ не знайдено за цим запитом.');
      }

      // Titles/kinds live in Postgres, not in the vector payload — one batched lookup.
      const ids = top.map(([id]) => id);
      const meta = new Map<number, any>();
      const rows = (await this.db.query(
        `SELECT id, doc_kind, decision_no, decision_date::text AS decision_date, doc_file
           FROM opendata_amcu_decisions WHERE id = ANY($1)`,
        [ids]
      )).rows;
      for (const r of rows) meta.set(Number(r.id), r);

      return this.wrapResponse({
        query,
        returned: top.length,
        searched_over: '2 600 рішень АМКУ з повним текстом (семантичний пошук)',
        results: top.map(([id, v]) => {
          const m = meta.get(id) || {};
          return {
            amcu_id: id,
            decision_no: m.decision_no ?? v.payload.decision_no,
            decision_date: m.decision_date ?? v.payload.decision_date,
            doc_kind: m.doc_kind ?? v.payload.doc_kind,
            similarity: Number(v.score.toFixed(3)),
            excerpt: v.text.replace(/\s+/g, ' ').trim().slice(0, 600),
          };
        }),
      });
    } catch (error: any) {
      logger.error('search_amcu_practice error', { error: error.message });
      return this.wrapError(`Помилка семантичного пошуку практики АМКУ: ${error.message}`);
    }
  }
}
