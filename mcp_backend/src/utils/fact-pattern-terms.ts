/**
 * Search-term extraction for find_similar_fact_pattern_cases (LEXAI-2101).
 *
 * The tool used to report `extracted_search_terms: []` for every call: the semantic path
 * never extracted terms, and the FTS fallback called extractSearchTermsWithAI(), which had
 * been reduced to a regex over a fixed debt/contract vocabulary — nothing in a labour
 * fact pattern («звільнили за прогул … лікарняний») matched it, so the fallback searched
 * the first six words of the facts and returned generic Supreme Court decisions.
 *
 * Now: one short LLM call (quick tier, JSON) extracts the terms; when it fails, times out
 * or returns nothing usable, a deterministic keyword extractor takes over, so the caller
 * always gets terms.
 */
import type { ILLMPort } from '../domain/ports/index.js';
import { logger } from './logger.js';

export interface FactPatternTerms {
  terms: string[];
  source: 'llm' | 'keyword_fallback';
}

const MAX_TERMS = 8;
const LLM_TIMEOUT_MS = 8_000;

const STOP_WORDS = new Set([
  'та', 'і', 'або', 'що', 'як', 'це', 'у', 'в', 'на', 'з', 'із', 'зі', 'за', 'до', 'від',
  'по', 'для', 'при', 'без', 'про', 'через', 'між', 'над', 'під', 'після', 'перед',
  'він', 'вона', 'воно', 'вони', 'його', 'її', 'їх', 'їй', 'йому', 'який', 'яка', 'яке', 'які',
  'якого', 'якої', 'яким', 'цей', 'ця', 'ці', 'той', 'ті', 'тієї', 'того', 'свій', 'свою',
  'своє', 'свої', 'свого', 'своєї', 'не', 'ні', 'так', 'але', 'також', 'ще', 'вже', 'навіть',
  'лише', 'тільки', 'є', 'був', 'була', 'було', 'були', 'бути', 'буде', 'може', 'має', 'мають',
  'а', 'й', 'чи', 'коли', 'якщо', 'тому', 'тобто', 'зокрема', 'проте', 'хоча', 'однак',
  'себе', 'собі', 'нього', 'неї', 'них', 'цього', 'тим', 'цей', 'цьому', 'цій', 'день',
  'дні', 'дня', 'році', 'року', 'рік', 'час', 'часу', 'весь', 'всі', 'усі', 'інший', 'інша',
  'було', 'щодо', 'відповідно', 'згідно', 'саме', 'тощо', 'дуже', 'де', 'там', 'тут',
  'мій', 'моя', 'мого', 'наш', 'наша', 'ми', 'я', 'ви', 'вас', 'нас', 'мене',
]);

/** Pull a string array out of whatever JSON shape the model produced. */
export function parseTermsFromLlmContent(content: string | null | undefined): string[] {
  if (!content || typeof content !== 'string') return [];
  let text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const obj = text.match(/\{[\s\S]*\}/);
    const arr = text.match(/\[[\s\S]*\]/);
    try {
      parsed = JSON.parse((obj || arr)?.[0] ?? '');
    } catch {
      return [];
    }
  }
  let list: unknown = parsed;
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    list = parsed.keywords ?? parsed.terms ?? parsed.search_terms ?? parsed.key_terms
      ?? Object.values(parsed).find(Array.isArray);
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const raw = typeof item === 'string' ? item : (item && typeof item === 'object' ? (item as any).term ?? (item as any).keyword : '');
    const term = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (term.length < 3 || term.length > 60) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Deterministic fallback: content words of the facts, stop words dropped, first
 * occurrence order, one word per 6-letter prefix (so «лікарняний»/«лікарняному» count once).
 */
export function extractKeywordsDeterministic(text: string, max: number = MAX_TERMS): string[] {
  const words = (text || '').toLowerCase().match(/[\p{L}][\p{L}'’ʼ-]*/gu) || [];
  const out: string[] = [];
  const seenPrefix = new Set<string>();
  for (const w of words) {
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    const prefix = w.slice(0, 6);
    if (seenPrefix.has(prefix)) continue;
    seenPrefix.add(prefix);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Prefix stems for a declension-tolerant FTS query: «звільнення за прогул» →
 * ["звільнен", "прогул"]. Words of 7+ letters lose their last two letters (the ending);
 * shorter words are used whole as a prefix. Stop words and words under 4 letters drop out.
 */
export function termsToStems(terms: string[], max: number = 4, stem: boolean = true): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    for (const w of term.toLowerCase().split(/[^\p{L}\p{Nd}]+/u)) {
      if (w.length < 4 || STOP_WORDS.has(w)) continue;
      const key = stem && w.length >= 7 ? w.slice(0, -2) : w;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** How many of the terms appear (by stem) in the text — used to rerank semantic hits. */
export function countTermHits(text: string, terms: string[]): number {
  const hay = (text || '').toLowerCase();
  let hits = 0;
  for (const term of terms) {
    const stems = termsToStems([term], 3);
    if (stems.length > 0 && stems.every((s) => hay.includes(s))) hits++;
  }
  return hits;
}

const SYSTEM_PROMPT =
  'Ти юрист-аналітик. Виділи з опису фактичних обставин 3-8 ключових пошукових термінів ' +
  '(юридичні поняття українською, у називному відмінку, 1-3 слова кожен) для повнотекстового ' +
  'пошуку судових рішень зі схожою фабулою. Відповідай ВИКЛЮЧНО JSON: {"keywords":["..."]}';

/**
 * Extract search terms from a fact pattern. Never throws; never returns an empty list
 * for non-empty facts (falls back to deterministic keywords).
 */
export async function extractFactPatternTerms(
  facts: string,
  llm?: ILLMPort,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<FactPatternTerms> {
  if (llm) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = llm.chatCompletion(
        {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: facts.slice(0, 4000) },
          ],
          // No max_tokens: a reasoning deployment spends its budget before emitting content
          // and returns "" — the output here is ~50 tokens anyway.
          temperature: 0,
          response_format: { type: 'json_object' },
        },
        'quick',
      );
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      const response = await Promise.race([call, timeout]);
      if (!response) {
        logger.warn('[extractFactPatternTerms] LLM timed out — keyword fallback', { timeoutMs });
      } else {
        const terms = parseTermsFromLlmContent(response.content);
        if (terms.length > 0) return { terms, source: 'llm' };
        logger.warn('[extractFactPatternTerms] LLM returned no usable terms — keyword fallback', {
          content_preview: String(response.content ?? '').slice(0, 200),
        });
      }
    } catch (err: any) {
      logger.warn('[extractFactPatternTerms] LLM call failed — keyword fallback', { error: err?.message });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { terms: extractKeywordsDeterministic(facts), source: 'keyword_fallback' };
}
