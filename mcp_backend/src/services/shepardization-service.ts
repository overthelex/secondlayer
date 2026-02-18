/**
 * ShepardizationService — Real-time precedent validity verification.
 *
 * Fetches the full procedural chain (first instance → appeal → cassation → Grand Chamber)
 * from ZakonOnline and determines whether a cited decision is still valid law.
 *
 * Three access patterns:
 * - analyze()      — Full verification with ZO API calls + caching
 * - quickCheck()   — Cache-only (Redis/PG), no API calls, for hot paths
 * - batchAnalyze() — Parallel analysis with concurrency limit
 */

import { logger } from '../utils/logger.js';
import { getRedisClient } from '../utils/redis-client.js';
import { generateCaseNumberVariations } from '../api/tool-utils.js';
import type { ZOAdapter } from '../adapters/zo-adapter.js';
import type { Database } from '../database/database.js';
import type { PrecedentStatusType } from '../types/index.js';

// ============================
// Types
// ============================

export interface ShepardizationResult {
  case_number: string;
  target_doc_id?: string;
  status: PrecedentStatusType;
  confidence: number;
  affecting_decisions: AffectingDecision[];
  chain_length: number;
  check_source: 'redis' | 'pg' | 'zo_api' | 'local';
  checked_at: string;
}

export interface AffectingDecision {
  doc_id: string;
  instance: string;
  court: string;
  date?: string;
  outcome: string;
  effect: 'upheld' | 'modified' | 'overruled' | 'remanded' | 'closed';
}

// ============================
// Instance classification
// ============================

const INSTANCE_HIERARCHY: Record<string, number> = {
  'Велика Палата ВС': 4,
  'Касація (КЦС ВС)': 3,
  'Касація (КГС ВС)': 3,
  'Касація (КАС ВС)': 3,
  'Касація (ККС ВС)': 3,
  'Касація': 3,
  'Апеляція': 2,
  'Перша інстанція': 1,
  'Невідомо': 0,
};

function classifyInstance(doc: any): string {
  const court = (doc?.court || doc?.court_name || '').toLowerCase();
  const chamber = (doc?.chamber || '').toLowerCase();
  const title = (doc?.title || '').toLowerCase();
  const snippet = (doc?.snippet || '').toLowerCase();

  if (chamber.includes('велика палата') || chamber.includes('вп вс')) return 'Велика Палата ВС';
  if (chamber.includes('кцс') || chamber.includes('касаційний цивільний')) return 'Касація (КЦС ВС)';
  if (chamber.includes('кгс') || chamber.includes('касаційний господарський')) return 'Касація (КГС ВС)';
  if (chamber.includes('кас') || chamber.includes('касаційний адміністративний')) return 'Касація (КАС ВС)';
  if (chamber.includes('ккс') || chamber.includes('касаційний кримінальний')) return 'Касація (ККС ВС)';

  const courtText = court || snippet;
  if (courtText.includes('велика палата') || courtText.includes('вп вс')) return 'Велика Палата ВС';
  if (courtText.includes('касаці') || courtText.includes('верховн')) return 'Касація';
  if (courtText.includes('апеляці')) return 'Апеляція';
  if (courtText.includes('окружний') || courtText.includes('районний') || courtText.includes('міськ')) return 'Перша інстанція';
  if (courtText.match(/господарський суд .*(області|міста)|цивільний суд .*(області|міста)|адміністративний суд/)) return 'Перша інстанція';

  if (title.includes('касаці')) return 'Касація';
  if (title.includes('апеляці')) return 'Апеляція';
  return 'Невідомо';
}

// ============================
// Outcome extraction (extended)
// ============================

interface OutcomeInfo {
  outcome: string;
  effect: AffectingDecision['effect'];
}

function extractOutcomeExtended(text?: string | null): OutcomeInfo | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // Upheld patterns
  if (t.includes('залишити без змін') || t.includes('залишено без змін')) {
    return { outcome: 'залишено без змін', effect: 'upheld' };
  }
  if (t.includes('відмовити') && (t.includes('апеляці') || t.includes('скарг'))) {
    return { outcome: 'відмовлено у задоволенні скарги', effect: 'upheld' };
  }

  // Overruled patterns (cancel + remand first, since it's more specific)
  if (t.includes('скасув') && (t.includes('направ') || t.includes('нов'))) {
    return { outcome: 'скасовано та направлено на новий розгляд', effect: 'remanded' };
  }
  if (t.includes('скасув')) {
    return { outcome: 'скасовано', effect: 'overruled' };
  }

  // Modified patterns
  if (t.includes('змінити') || t.includes('змінено')) {
    return { outcome: 'змінено', effect: 'modified' };
  }
  if (t.includes('частков') && t.includes('задовольн')) {
    return { outcome: 'частково задоволено', effect: 'modified' };
  }

  // Closed
  if (t.includes('закрити провадження') || t.includes('закрито провадження')) {
    return { outcome: 'провадження закрито', effect: 'closed' };
  }

  // Generic allowed/denied (fallbacks)
  if (t.includes('задовольн')) {
    return { outcome: 'задоволено', effect: 'overruled' };
  }
  if (t.includes('відмов')) {
    return { outcome: 'відмовлено', effect: 'upheld' };
  }

  return null;
}

// ============================
// Confidence scoring
// ============================

function computeConfidence(
  status: PrecedentStatusType,
  highestAffectingInstance: string,
  checkSource: ShepardizationResult['check_source']
): number {
  if (checkSource === 'local') return 0.6;
  if (status === 'unknown') return 0.5;

  const instanceLevel = INSTANCE_HIERARCHY[highestAffectingInstance] || 0;

  if (status === 'explicitly_overruled') {
    if (instanceLevel >= 4) return 0.95; // Grand Chamber
    if (instanceLevel >= 3) return 0.95; // Cassation
    if (instanceLevel >= 2) return 0.85; // Appeal
    return 0.75;
  }

  if (status === 'limited') {
    if (instanceLevel >= 3) return 0.90;
    if (instanceLevel >= 2) return 0.80;
    return 0.70;
  }

  if (status === 'valid') {
    if (instanceLevel >= 3) return 0.90; // Upheld at cassation
    return 0.80;
  }

  return 0.5;
}

// ============================
// Constants
// ============================

const REDIS_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PG_FRESHNESS_DAYS = 7;
const BATCH_CONCURRENCY = 3;
const ANALYZE_TIMEOUT_MS = 15_000;

// ============================
// Service
// ============================

export class ShepardizationService {
  constructor(
    private zoAdapter: ZOAdapter,
    private db: Database
  ) {}

  /**
   * Full verification: Redis cache → PG cache → ZO API search → classify → cache.
   */
  async analyze(identifier: string): Promise<ShepardizationResult> {
    const startTime = Date.now();

    // 1. Resolve to case_number
    const caseNumber = await this.resolveCaseNumber(identifier);
    if (!caseNumber) {
      return this.unknownResult(identifier, 'local');
    }

    // 2. Check Redis cache
    const redisCached = await this.checkRedisCache(caseNumber);
    if (redisCached) {
      logger.debug('[Shepardization] Redis cache hit', { caseNumber });
      return redisCached;
    }

    // 3. Check PG cache (within freshness window)
    const pgCached = await this.checkPGCache(caseNumber);
    if (pgCached) {
      logger.debug('[Shepardization] PG cache hit', { caseNumber });
      // Warm Redis for next time
      await this.cacheToRedis(caseNumber, pgCached);
      return pgCached;
    }

    // 4. Search ZakonOnline for all documents in this case
    try {
      const result = await this.searchAndClassify(caseNumber);

      // 5. Cache in Redis + PG
      await this.cacheToRedis(caseNumber, result);
      await this.cacheToPG(result);

      // 6. Log
      const duration = Date.now() - startTime;
      await this.logAnalysis(result, duration);

      return result;
    } catch (err: any) {
      logger.warn('[Shepardization] ZO API search failed, falling back to local', {
        caseNumber,
        error: err.message,
      });

      // Fallback to local citation_links analysis
      return this.localFallback(caseNumber);
    }
  }

  /**
   * Cache-only check (Redis/PG). Returns null if no cached data.
   * For HallucinationGuard hot path — must be fast, no API calls.
   */
  async quickCheck(caseNumber: string): Promise<ShepardizationResult | null> {
    // Redis first
    const redisCached = await this.checkRedisCache(caseNumber);
    if (redisCached) return redisCached;

    // PG second (any age)
    const pgResult = await this.checkPGCache(caseNumber, false);
    if (pgResult) {
      await this.cacheToRedis(caseNumber, pgResult);
      return pgResult;
    }

    return null;
  }

  /**
   * Parallel analysis with concurrency limit. For post-chat verification.
   */
  async batchAnalyze(caseNumbers: string[]): Promise<ShepardizationResult[]> {
    const unique = [...new Set(caseNumbers)];
    const results: ShepardizationResult[] = [];
    const queue = [...unique];

    const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const cn = queue.shift();
        if (!cn) break;

        try {
          const result = await Promise.race([
            this.analyze(cn),
            new Promise<ShepardizationResult>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), ANALYZE_TIMEOUT_MS)
            ),
          ]);
          results.push(result);
        } catch (err: any) {
          logger.warn('[Shepardization] Batch item failed', { caseNumber: cn, error: err.message });
          results.push(this.unknownResult(cn, 'local'));
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  // ============================
  // Internal: Resolution
  // ============================

  private async resolveCaseNumber(identifier: string): Promise<string | null> {
    // If it already looks like a case number (digits/digits/digits pattern)
    if (/^\d+\/\d+\/\d{2,4}/.test(identifier)) {
      return identifier;
    }

    // Try UUID lookup in documents table
    try {
      const result = await this.db.query(
        `SELECT metadata->>'case_number' as case_number FROM documents WHERE id = $1 LIMIT 1`,
        [identifier]
      );
      if (result.rows.length > 0 && result.rows[0].case_number) {
        return result.rows[0].case_number;
      }
    } catch {
      // Not a valid UUID, ignore
    }

    // Try zakononline_id lookup
    try {
      const result = await this.db.query(
        `SELECT metadata->>'case_number' as case_number FROM documents WHERE zakononline_id = $1 LIMIT 1`,
        [identifier]
      );
      if (result.rows.length > 0 && result.rows[0].case_number) {
        return result.rows[0].case_number;
      }
    } catch {
      // ignore
    }

    return null;
  }

  // ============================
  // Internal: Cache operations
  // ============================

  private async checkRedisCache(caseNumber: string): Promise<ShepardizationResult | null> {
    try {
      const redis = await getRedisClient();
      if (!redis) return null;

      const cached = await redis.get(`shepard:${caseNumber}`);
      if (!cached) return null;

      return JSON.parse(cached) as ShepardizationResult;
    } catch {
      return null;
    }
  }

  private async cacheToRedis(caseNumber: string, result: ShepardizationResult): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      await redis.setEx(`shepard:${caseNumber}`, REDIS_TTL_SECONDS, JSON.stringify(result));
    } catch {
      // non-critical
    }
  }

  private async checkPGCache(caseNumber: string, checkFreshness = true): Promise<ShepardizationResult | null> {
    try {
      const freshnessClause = checkFreshness
        ? `AND last_checked > NOW() - INTERVAL '${PG_FRESHNESS_DAYS} days'`
        : '';

      const result = await this.db.query(
        `SELECT status, confidence, case_number, target_doc_id, affecting_decisions, check_source, last_checked
         FROM precedent_status
         WHERE case_number = $1 ${freshnessClause}
         LIMIT 1`,
        [caseNumber]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      const affecting = Array.isArray(row.affecting_decisions) ? row.affecting_decisions : [];

      return {
        case_number: caseNumber,
        target_doc_id: row.target_doc_id || undefined,
        status: row.status as PrecedentStatusType,
        confidence: row.confidence,
        affecting_decisions: affecting,
        chain_length: affecting.length,
        check_source: (row.check_source || 'pg') as ShepardizationResult['check_source'],
        checked_at: row.last_checked?.toISOString() || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async cacheToPG(result: ShepardizationResult): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO precedent_status (case_id, case_number, target_doc_id, status, confidence, affecting_decisions, check_source, last_checked, ttl_expires_at)
         VALUES (
           COALESCE((SELECT id FROM documents WHERE metadata->>'case_number' = $1 LIMIT 1), uuid_generate_v4()),
           $1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW() + INTERVAL '7 days'
         )
         ON CONFLICT (case_id) DO UPDATE SET
           case_number = EXCLUDED.case_number,
           target_doc_id = EXCLUDED.target_doc_id,
           status = EXCLUDED.status,
           confidence = EXCLUDED.confidence,
           affecting_decisions = EXCLUDED.affecting_decisions,
           check_source = EXCLUDED.check_source,
           last_checked = EXCLUDED.last_checked,
           ttl_expires_at = EXCLUDED.ttl_expires_at`,
        [
          result.case_number,
          result.target_doc_id || null,
          result.status,
          result.confidence,
          JSON.stringify(result.affecting_decisions),
          result.check_source,
        ]
      );
    } catch (err: any) {
      logger.warn('[Shepardization] Failed to cache to PG', { error: err.message });
    }
  }

  // ============================
  // Internal: ZO API search + classification
  // ============================

  private async searchAndClassify(caseNumber: string): Promise<ShepardizationResult> {
    const variations = generateCaseNumberVariations(caseNumber);

    // Search ZO for all documents in this case
    let allDocs: any[] = [];

    for (const variation of variations) {
      try {
        const response = await this.zoAdapter.searchCourtDecisions({
          meta: { search: variation },
          limit: 50,
        });

        const docs = Array.isArray(response) ? response : response?.data || [];
        allDocs.push(...docs);
      } catch (err: any) {
        logger.debug('[Shepardization] Search variation failed', { variation, error: err.message });
      }
    }

    // Deduplicate by doc_id
    const seen = new Set<string>();
    allDocs = allDocs.filter((doc) => {
      const id = doc?.doc_id || doc?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (allDocs.length === 0) {
      return this.unknownResult(caseNumber, 'zo_api');
    }

    // Classify each document
    const classified = allDocs.map((doc) => ({
      doc_id: doc.doc_id || doc.id,
      instance: classifyInstance(doc),
      instanceLevel: INSTANCE_HIERARCHY[classifyInstance(doc)] || 0,
      court: doc.court || doc.court_name || '',
      date: doc.date || doc.adjudication_date || '',
      resolution: doc.resolution || doc.snippet || '',
      outcome: extractOutcomeExtended(doc.resolution || doc.snippet),
    }));

    // Sort by instance level (highest first), then by date (latest first)
    classified.sort((a, b) => {
      if (b.instanceLevel !== a.instanceLevel) return b.instanceLevel - a.instanceLevel;
      return (b.date || '').localeCompare(a.date || '');
    });

    // Find the target document (lowest instance = the original decision)
    const targetDoc = classified.reduce((lowest, doc) =>
      doc.instanceLevel > 0 && doc.instanceLevel < (lowest?.instanceLevel || 999) ? doc : lowest,
      classified[classified.length - 1]
    );

    // Find higher-court decisions that affect the target
    const targetLevel = targetDoc?.instanceLevel || 1;
    const higherCourt = classified.filter((d) => d.instanceLevel > targetLevel && d.outcome);

    // Determine status based on highest-court outcome
    let status: PrecedentStatusType = 'unknown';
    let highestInstance = 'Невідомо';
    const affectingDecisions: AffectingDecision[] = [];

    if (higherCourt.length === 0) {
      // No higher-court decisions found
      status = allDocs.length > 1 ? 'valid' : 'unknown';
    } else {
      // Highest court decision wins
      const highest = higherCourt[0]; // already sorted by instanceLevel desc
      highestInstance = highest.instance;

      for (const hc of higherCourt) {
        if (hc.outcome) {
          affectingDecisions.push({
            doc_id: hc.doc_id,
            instance: hc.instance,
            court: hc.court,
            date: hc.date || undefined,
            outcome: hc.outcome.outcome,
            effect: hc.outcome.effect,
          });
        }
      }

      // Map highest court effect to status
      const topEffect = highest.outcome!.effect;
      switch (topEffect) {
        case 'overruled':
        case 'remanded':
          status = 'explicitly_overruled';
          break;
        case 'modified':
          status = 'limited';
          break;
        case 'upheld':
          status = 'valid';
          break;
        case 'closed':
          status = 'limited';
          break;
        default:
          status = 'unknown';
      }
    }

    const confidence = computeConfidence(status, highestInstance, 'zo_api');

    return {
      case_number: caseNumber,
      target_doc_id: targetDoc?.doc_id,
      status,
      confidence,
      affecting_decisions: affectingDecisions,
      chain_length: allDocs.length,
      check_source: 'zo_api',
      checked_at: new Date().toISOString(),
    };
  }

  // ============================
  // Internal: Fallback to local citation_links
  // ============================

  private async localFallback(caseNumber: string): Promise<ShepardizationResult> {
    try {
      // Try to find via citation_links
      const result = await this.db.query(
        `SELECT cl.citation_type, cl.from_case_id, d.metadata->>'case_number' as from_case_number
         FROM citation_links cl
         JOIN documents d ON d.id = cl.from_case_id
         WHERE cl.to_case_id IN (
           SELECT id FROM documents WHERE metadata->>'case_number' = $1
         )`,
        [caseNumber]
      );

      if (result.rows.length === 0) {
        return this.unknownResult(caseNumber, 'local');
      }

      const overruledBy = result.rows.filter((r) => r.citation_type === 'overrules');
      const distinguished = result.rows.filter((r) => r.citation_type === 'distinguishes');

      let status: PrecedentStatusType = 'valid';
      if (overruledBy.length > 0) status = 'explicitly_overruled';
      else if (distinguished.length > 0) status = 'questioned';

      return {
        case_number: caseNumber,
        status,
        confidence: 0.6,
        affecting_decisions: overruledBy.map((r) => ({
          doc_id: r.from_case_id,
          instance: 'Невідомо',
          court: '',
          outcome: 'overrules',
          effect: 'overruled' as const,
        })),
        chain_length: result.rows.length,
        check_source: 'local',
        checked_at: new Date().toISOString(),
      };
    } catch {
      return this.unknownResult(caseNumber, 'local');
    }
  }

  // ============================
  // Internal: Logging
  // ============================

  private async logAnalysis(result: ShepardizationResult, durationMs: number): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO shepardization_log (case_number, target_doc_id, status, confidence, chain_length, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          result.case_number,
          result.target_doc_id || null,
          result.status,
          result.confidence,
          result.chain_length,
          result.check_source,
          durationMs,
        ]
      );
    } catch {
      // non-critical
    }
  }

  // ============================
  // Helpers
  // ============================

  private unknownResult(caseNumber: string, source: ShepardizationResult['check_source']): ShepardizationResult {
    return {
      case_number: caseNumber,
      status: 'unknown',
      confidence: 0.5,
      affecting_decisions: [],
      chain_length: 0,
      check_source: source,
      checked_at: new Date().toISOString(),
    };
  }
}
