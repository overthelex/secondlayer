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
 * Fold every apostrophe look-alike to the ASCII one. Ukrainian text in the corpora uses
 * ' (U+0027), ’ (U+2019) and ʼ (U+02BC) interchangeably. U+02BC is a *letter* (\p{Lm}),
 * so without this fold «військовозобовʼязаних» stays one token while
 * «військовозобов'язаних» splits into two, and the same word never matches itself.
 * ASCII ' is what PostgreSQL's 'simple' parser and our \p{L} tokeniser both split on.
 */
export function normalizeApostrophes(text: string): string {
  return String(text ?? '').replace(/[ʼ’‘ʹ`´′]/g, "'");
}

/**
 * Content stems of a free-text query, deduped and capped — the shared basis for every
 * tsquery we build. Exported so callers that need a different boolean join (search_npa
 * runs AND-first over 429K editions, where OR-of-prefixes matches almost everything)
 * don't have to re-derive the tokenisation and stemming.
 */
export function legislationStems(query: string): string[] {
  const tokens = (String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(isContentToken)
    .slice(0, 10);
  return [...new Set(tokens.map(stemToPrefix).filter(Boolean))];
}

/** True for a token legislationStems keeps (content word, not a stopword or a bare number). */
function isContentToken(t: string): boolean {
  return t.length >= 3 && !UK_STOPWORDS.has(t) && !/^\d+$/.test(t);
}

/**
 * Phrase tsquery over the same prefix stems as legislationStems, with the exact word
 * distances of the query («штучний інтелект» → "штуч:* <-> інтел:*", «договір про
 * закупівлю» → "дого:* <2> закуп:*"). LEXAI-2153: an AND query is satisfied by
 * «штучні острови … інтелектуальної власності» 50K chars apart; the phrase is the
 * signal that the document is actually about the queried term.
 *
 * Positions mirror PostgreSQL's 'simple' parser: every word, short word, stopword and
 * number takes one position, and a hyphenated word takes one extra position for the
 * compound token, emitted before its parts ('науково-технічний':1 'науково':2 'технічний':3).
 * Returns '' when the query has fewer than two content words — there is no phrase.
 */
export function legislationPhraseTsquery(query: string): string {
  // Verified with ts_debug('simple', …) on prod: a dotted number («69.22», «2.3.4») is ONE
  // float/version token; «354-1» / «covid-19» are a number/word plus a signed int «-1»
  // (two positions, no compound); only letters-hyphen-letters («абзац-а») is an hword
  // that adds the compound position.
  const groups = String(query || '').toLowerCase()
    .match(/\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  let pos = 0;
  const parts: Array<{ pos: number; stem: string }> = [];
  for (const g of groups) {
    if (/^\p{N}+(?:\.\p{N}+)+$/u.test(g)) { pos++; continue; } // one numeric token, never a stem
    const words = g.split('-').filter(Boolean);
    if (words.length > 1 && words.every((w) => /^\p{L}+$/u.test(w))) pos++; // hword compound
    for (const w of words) {
      pos++;
      if (!isContentToken(w)) continue;
      const stem = stemToPrefix(w);
      if (stem) parts.push({ pos, stem });
    }
  }
  const kept = parts.slice(0, 10);
  if (kept.length < 2) return '';
  return kept
    .map((p, i) => {
      if (i === 0) return `${p.stem}:*`;
      const d = p.pos - kept[i - 1].pos;
      return `${d === 1 ? '<->' : `<${d}>`} ${p.stem}:*`;
    })
    .join(' ');
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
