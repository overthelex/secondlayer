/**
 * Pure helpers for hybrid (FTS + vector) legislation retrieval — LEXAI-1806.
 *
 * `get_legislation_section` query-mode used to run a bare Qdrant cosine search over
 * `legal_sections`, which (a) let the broken ~1M-char ПКУ ст. 346 mega-record flood
 * the results and (b) never surfaced the on-point transitional provisions
 * (підрозділ 10 розд. XX: п.38.6 / п.69.22 / ст. 266) for morphology-heavy queries.
 *
 * These functions implement the ranking side of the fix, mirroring the RRF pattern
 * used by `search_court_decisions` (edrsr-unified-search-tool.ts). They are kept in a
 * standalone module so both LegislationService and RadaLegislationAdapter can use them
 * without an import cycle, and so the ranking math stays unit-testable without a DB.
 */

/** Reciprocal-rank-fusion constant, matching the EDRSR hybrid path (DEFAULT_RRF_K). */
export const HYBRID_RRF_K = 60;

/**
 * full_text length above which a record is treated as a broken parser artifact and
 * demoted in discovery. ПКУ ст. 346 ≈ 1M chars is the known offender; the largest
 * *legitimate* article (ПКУ ст. 14 "визначення понять" ≈ 216K) stays below this, so
 * it is never demoted. The record is still fully retrievable by explicit article_number.
 */
export const MEGA_RECORD_CHAR_THRESHOLD = 300_000;

/** Additive boost when a bare article-number token from the query matches the candidate. */
export const ARTICLE_NUMBER_MATCH_BOOST = 0.02;

/** Small additive nudge for transitional/final provisions (перехідні положення). */
export const TRANSITIONAL_BOOST = 0.003;

/** Multiplicative penalty applied to mega-record candidates. */
export const MEGA_RECORD_PENALTY_FACTOR = 0.1;

/** Vector-leg cosine floor for hybrid candidate inclusion. Lower than the old pure-vector
 * 0.6 gate because RRF ranks by position, not score, and on-point transitional provisions
 * often score ~0.4-0.5 against a paraphrased query. The FTS leg + boosts do the ranking. */
export const MIN_VECTOR_SCORE_HYBRID = 0.35;

/** Ukrainian function words that carry no retrieval signal — dropped from the FTS tsquery. */
const UK_STOPWORDS = new Set([
  'для', 'або', 'від', 'про', 'які', 'яка', 'який', 'яке', 'щодо', 'цього', 'цьому',
  'якщо', 'при', 'над', 'під', 'між', 'його', 'її', 'їх', 'що', 'як', 'так', 'цей',
  'той', 'все', 'усі', 'він', 'вона', 'вони', 'має', 'був', 'була', 'було', 'бути',
  'нею', 'ним', 'них', 'аби', 'був', 'цих', 'them',
]);

/**
 * Build a stable dedup/fusion key for an article across the two legs.
 * FTS rows and vector payloads both carry the same `legislation_articles.article_number`,
 * so an exact join on (rada_id, article_number) is unambiguous.
 */
export function legislationKey(radaId: string, articleNumber: string): string {
  return `${String(radaId || '').toLowerCase()}:${String(articleNumber ?? '').trim()}`;
}

/**
 * Strip the transitional-provision prefix ("п." / "ст.") so a stored article_number
 * like "п.38.6" can be compared to a bare query token "38.6".
 */
export function bareArticleNumber(articleNumber: string): string {
  return String(articleNumber || '')
    .replace(/^\s*(?:п|ст|стаття)\.?\s*/i, '')
    .trim();
}

/**
 * Extract numeric article/point tokens from a query — "266", "38.6", "69.22", "354-1".
 * Used both to boost exact-number matches and to seed the FTS article_number branch.
 * Plain 4-digit years (1991..2099) are dropped: they are almost always dates, not
 * article numbers, and would otherwise match unrelated articles.
 */
export function extractArticleNumberTokens(query: string): string[] {
  const raw = String(query || '').match(/\d+(?:[.\-]\d+)*/g) || [];
  const tokens = raw.filter((t) => !/^(?:19|20)\d{2}$/.test(t));
  return [...new Set(tokens)];
}

/** Crude Ukrainian stem: trim the inflectional tail so a prefix tsquery matches відмінки/числа. */
function stemToPrefix(token: string): string {
  const clean = token.replace(/[^\p{L}\p{N}]/gu, '');
  if (!clean) return '';
  return clean.slice(0, Math.max(4, clean.length - 3));
}

/**
 * Build an OR-of-prefixes tsquery ("подат:* | нерух:* | окупова:*") from a free-text query.
 * OR + prefix matching tolerates Ukrainian morphology far better than the AND-joined
 * plainto_tsquery('simple', …) used by the legacy searchArticles, so an article that
 * matches more topical stems ranks higher via ts_rank. Returns '' when the query has no
 * usable content tokens (caller must then skip the tsquery branch — to_tsquery('') errors).
 */
export function buildLegislationTsquery(query: string): string {
  return legislationStems(query).map((s) => `${s}:*`).join(' | ');
}

/**
 * Content stems of a free-text query, deduped and capped — the shared basis for every
 * tsquery we build. Exported so callers that need a different boolean join (search_npa
 * runs AND-first over 429K editions, where OR-of-prefixes matches almost everything)
 * don't have to re-derive the tokenisation and stemming.
 */
export function legislationStems(query: string): string[] {
  const tokens = (String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((t) => t.length >= 3 && !UK_STOPWORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, 10);
  return [...new Set(tokens.map(stemToPrefix).filter(Boolean))];
}

/**
 * Reciprocal-rank fusion of two ranked key lists into a combined score map.
 * Each list contributes 1/(k + rank) per key; keys present in both legs accumulate.
 */
export function fuseRankLists(
  vectorKeys: string[],
  ftsKeys: string[],
  k: number = HYBRID_RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (keys: string[]) => {
    keys.forEach((key, idx) => {
      const rank = idx + 1;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank));
    });
  };
  add(ftsKeys);
  add(vectorKeys);
  return scores;
}

export interface LegislationBoostInput {
  article_number: string;
  full_text_length: number;
  is_transitional: boolean;
}

/**
 * Adjust a fused base score with the LEXAI-1806 boosts: exact article-number match,
 * transitional-provision nudge, and mega-record demotion (applied last, so a demoted
 * record cannot outrank a real one on the strength of a number-token match alone).
 */
export function applyLegislationBoosts(
  baseScore: number,
  candidate: LegislationBoostInput,
  queryNumberTokens: string[]
): number {
  let score = baseScore;
  const bare = bareArticleNumber(candidate.article_number);
  if (bare && queryNumberTokens.includes(bare)) {
    score += ARTICLE_NUMBER_MATCH_BOOST;
  }
  if (candidate.is_transitional) {
    score += TRANSITIONAL_BOOST;
  }
  if (candidate.full_text_length > MEGA_RECORD_CHAR_THRESHOLD) {
    score *= MEGA_RECORD_PENALTY_FACTOR;
  }
  return score;
}
