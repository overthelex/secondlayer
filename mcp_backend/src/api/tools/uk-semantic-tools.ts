/**
 * Semantic search over the UK statute book (Qdrant `uk_provisions_bge`).
 *
 * `uk_search_legislation` finds an act by title or id; this finds the PROVISION that says
 * what the caller described, in whatever words the draftsman used. 1,326,013 chunks over
 * 1,237,129 distinct wordings, bge-m3 with **CLS** pooling — the same pooling tei-bge-m3
 * produces for every query. A mean-pooled collection answers CLS queries at about 0.73
 * self-similarity instead of 1.0, and nothing errors: the results just quietly get worse.
 *
 * ⚠ Legislation only. The judgments in `uk_court_decisions` are not in this collection,
 * and they carry their own licence gate (services/uk-judgment-access.ts) — a semantic
 * hit must never reach across into them.
 *
 * Two properties of the index shape the result list, and both are visible in the output:
 *
 * 1. Vectors are keyed by CONTENT, not by provision. One 63-character string — the marker
 *    for repealed text — occurs 260,194 times in the corpus, and identical wording is
 *    common between an act and the instrument that re-enacts it. So a hit resolves through
 *    `uk_provision_text_hash` to EVERY provision carrying that wording: the first is
 *    returned, the rest are counted in `also_in`.
 *
 * 2. A hit can resolve to nothing. When the weekly refresh rewords a provision the old
 *    hash stops being referenced, but its vector survives until the index is rebuilt.
 *    Those hits are dropped here and counted in `stale_hits_dropped` rather than returned
 *    as an empty row, because an answer with a score and no text is worse than no answer.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { BgeM3Client } from '../../utils/bge-m3-client.js';
import { logger } from '../../utils/logger.js';

const COLLECTION = process.env.UK_BGE_COLLECTION || 'uk_provisions_bge';

/**
 * Chunks pulled before collapsing. A long provision owns several chunks and shared
 * wording collapses many hits into one, so the raw list has to be wider than the answer.
 */
const OVERFETCH = 6;

/** With leg_type set the narrowing happens in SQL, after this cut — see the call site. */
const OVERFETCH_TYPED = 30;

export class UkSemanticTools extends BaseToolHandler {
  private _bge: BgeM3Client | null = null;
  private _qdrant: QdrantClient | null = null;

  constructor(private db: any) {
    super();
  }

  private get bge(): BgeM3Client {
    if (!this._bge) this._bge = new BgeM3Client(process.env.BGE_M3_URL || 'http://tei-bge-uk:80');
    return this._bge;
  }

  private get qdrant(): QdrantClient {
    if (!this._qdrant) {
      const url = process.env.QDRANT_URL || 'http://qdrant-uk:6333';
      const apiKey = process.env.QDRANT_API_KEY;
      this._qdrant = new QdrantClient({ url, ...(apiKey && { apiKey }) });
    }
    return this._qdrant;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_semantic_search',
        annotations: { title: 'UK legislation semantic search', readOnlyHint: true },
        description: `Semantic search over UK legislation — find the provision that says what you describe.

1,237,129 distinct provision wordings across the statute book: Acts (ukpga), statutory instruments (uksi), Scottish, Welsh and Northern Irish legislation, and retained EU law. Matches by MEANING, so "duty to consult before granting planning permission" finds "Before determining an application for planning permission the planning authority must consult", which no keyword search would return.

When to use what:
• uk_semantic_search — describe a rule, duty or situation in your own words
• uk_search_legislation — you know the act's title or id ('Companies Act 2006', 'ukpga/2006/46')
• uk_get_provision — you know the act and the section number, and want the text (with as_of for a date)

Legislation only: judgments are not in this index. Acts the source publishes as scans alone have no text and cannot be found here — 129,953 of 238,936 acts carry text.

Identical wording shared between instruments is one entry, so a result may report also_in: the other provisions that use the same words. Follow up with uk_get_provision for the full text or uk_get_provision_history for how it changed.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A rule, duty or situation in your own words' },
            leg_type: { type: 'string', description: "Restrict to one type: ukpga, uksi, asp, ssi, nia, nisr, asc, anaw, wsi, eur …" },
            limit: { type: 'number', default: 10, maximum: 25, description: 'Max results' },
          },
          required: ['query'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'uk_semantic_search') return null;
    return this.semanticSearch(args);
  }

  private async semanticSearch(args: any): Promise<ToolResult> {
    const { query, leg_type } = args;
    if (!query || !String(query).trim()) {
      return this.wrapResponse('Provide query — a rule, duty or situation in your own words.');
    }
    const legType = leg_type ? String(leg_type).trim().toLowerCase() : undefined;
    if (legType && !/^[a-z]{2,6}$/.test(legType)) {
      return this.wrapResponse("leg_type must be a short code such as ukpga, uksi, asp or eur.");
    }
    // Math.min(Number(limit) || 10, 25) alone lets a negative through: -3 is truthy,
    // Qdrant rejects limit -18, and slice(0, -3) would drop the BEST results. Clamp.
    const lim = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 25);

    try {
      const vector = await this.bge.generateEmbedding(String(query));

      // leg_type cannot be a Qdrant filter: the payload carries only text_hash and
      // chunk_ord, and which act holds a wording is known solely in Postgres. So the type
      // narrows AFTER retrieval, and a rare type would otherwise come back empty with
      // matching provisions sitting just below the cut. A wider net is the honest
      // mitigation, not a guarantee — hence what the empty response tells the caller.
      const hits = await this.qdrant.search(COLLECTION, {
        vector,
        limit: lim * (legType ? OVERFETCH_TYPED : OVERFETCH),
        with_payload: true,
      });

      // Several chunks of one long provision, and every instrument that shares a wording,
      // arrive as separate hits. Keep the best score per wording.
      const best = new Map<string, number>();
      for (const h of hits) {
        const hash = (h.payload as any)?.text_hash;
        if (typeof hash !== 'string') continue;
        if (!best.has(hash) || (h.score ?? 0) > best.get(hash)!) best.set(hash, h.score ?? 0);
      }
      if (!best.size) return this.wrapResponse('Nothing relevant found for this query.');

      const hashes = [...best.keys()];
      const values: any[] = [hashes];
      let typeClause = '';
      if (legType) {
        values.push(legType);
        typeClause = `AND l.leg_type = $${values.length}`;
      }

      // One row per wording: the provision that carries it, plus how many others do. The
      // provisions table is keyed (leg_id, valid_from, ord), so DISTINCT ON picks the most
      // recent version of the first act rather than a row at random.
      const sql = `
        WITH hit AS (
          SELECT decode(h, 'hex') AS text_hash FROM unnest($1::text[]) AS h
        ), resolved AS (
          SELECT DISTINCT ON (m.text_hash, p.leg_id)
                 m.text_hash, p.leg_id, p.ord, p.valid_from, p.provision_label,
                 p.provision_type, p.title AS provision_title, p.text, p.n_chars,
                 l.title AS act_title, l.leg_type, l.year
            FROM hit
            JOIN uk_provision_text_hash m ON m.text_hash = hit.text_hash
            JOIN uk_legislation_provisions p
              ON p.leg_id = m.leg_id AND p.valid_from = m.valid_from AND p.ord = m.ord
            JOIN uk_legislation l ON l.id = p.leg_id
           WHERE TRUE ${typeClause}
           ORDER BY m.text_hash, p.leg_id, p.valid_from DESC
        ), carriers AS (
          -- Counted before DISTINCT ON, which keeps one row per act: an act using the same
          -- wording in two sections would otherwise report one carrier instead of two.
          SELECT m.text_hash, COUNT(*) AS carriers
            FROM hit JOIN uk_provision_text_hash m ON m.text_hash = hit.text_hash
           GROUP BY m.text_hash
        )
        SELECT encode(r.text_hash, 'hex') AS text_hash, r.leg_id, r.ord, r.valid_from,
               r.provision_label, r.provision_type, r.provision_title, r.act_title,
               r.leg_type, r.year, r.n_chars, left(r.text, 600) AS snippet,
               c.carriers - 1 AS also_in
          FROM resolved r
          JOIN carriers c ON c.text_hash = r.text_hash
         ORDER BY r.leg_id`;

      const rows = (await this.db.query(sql, values)).rows;

      const byHash = new Map<string, any>();
      for (const r of rows) if (!byHash.has(r.text_hash)) byHash.set(r.text_hash, r);

      const results = hashes
        .filter((h) => byHash.has(h))
        .sort((a, b) => best.get(b)! - best.get(a)!)
        .slice(0, lim)
        .map((h) => {
          const r = byHash.get(h);
          return {
            score: Number(best.get(h)!.toFixed(4)),
            leg_id: r.leg_id,
            act_title: r.act_title,
            leg_type: r.leg_type,
            year: r.year,
            provision: r.provision_label,
            provision_type: r.provision_type,
            provision_title: r.provision_title,
            version_in_force_from: r.valid_from,
            n_chars: r.n_chars,
            text: r.snippet,
            truncated: r.n_chars > 600,
            ...(Number(r.also_in) > 0
              ? { also_in: Number(r.also_in), also_in_note: 'other provisions carry this exact wording' }
              : {}),
          };
        });

      if (!results.length) {
        return this.wrapResponse({
          query,
          results: [],
          note: legType
            ? `Nothing found in ${legType}. The wording may exist in another type of instrument — drop leg_type and search again.`
            : 'Nothing relevant found for this query.',
        });
      }

      const stale = hashes.length - byHash.size;
      return this.wrapResponse({
        query,
        searched_over: '1,237,129 distinct provision wordings across 129,953 UK acts with text (semantic)',
        results,
        ...(stale > 0
          ? {
              stale_hits_dropped: stale,
              stale_note:
                'Vectors whose wording the statute book no longer carries — dropped rather than returned without text.',
            }
          : {}),
        next: 'uk_get_provision for the full text (as_of for a date), uk_get_provision_history for how it changed.',
      });
    } catch (error: any) {
      logger.error('uk_semantic_search error', { error: error.message });
      return this.wrapError(`Semantic search failed: ${error.message}`);
    }
  }
}
