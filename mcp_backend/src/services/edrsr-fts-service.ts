/**
 * EdsrFtsService — Full Text Search over EDRSR court decisions
 *
 * Provides:
 * - searchFulltext()  — FTS query with metadata filters, ranking, and highlighted snippets
 * - indexBatch()      — Background indexing: populates tsv column in batches
 * - getIndexProgress() — Reports indexing progress (total / indexed / remaining)
 *
 * The tsv column uses 'simple' PG text search config (no Ukrainian stemmer in stock PG,
 * but 'simple' tokenizes correctly for Ukrainian text matching).
 *
 * Data is sharded across 4 databases; this service operates on whichever pool it receives.
 * edrsr_documents (metadata) lives only in the main DB.
 *
 * EDRSR_DATABASE_URL (optional): when set, the service opens its own pool to that database
 * and uses it for ALL its queries, ignoring caller-passed pools — so a dev deployment can
 * read EDRSR data from prod (readonly user) while the rest of the app stays on its own DB.
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import type { PartyRole } from '@secondlayer/shared';
import type { EdsrCacheService } from './edrsr-cache-service.js';
import {
  EDRSR_FTS_SEARCH_ORDER,
  FTS_HEADLINE_MAX_WORDS,
  FTS_HEADLINE_MIN_WORDS,
} from './search-ranking-config.js';

// PartyRole is the canonical whitelist — single source in @secondlayer/shared.
export type { PartyRole };

export interface EdsrFtsFilters {
  court_code?: number;
  judge?: string;
  date_from?: string;
  date_to?: string;
  justice_kind?: number;
  judgment_code?: number;
  category_code?: number;
  instance_code?: number;
  // Party constraints — anchored into the tsquery, NOT bag-of-words keywords.
  // party_name should be the distinctive proper name (e.g. "Нова Пошта"), without
  // the legal-form prefix (ТОВ / Товариство з обмеженою відповідальністю), which
  // declines and breaks the 'simple' (stemless) config. It is matched as a phrase.
  party_name?: string;
  // party_role narrows to decisions where the party stands in that procedural slot of the
  // claim clause ("за позовом X до Y про …"), enforced by a claim-clause regex over full_text
  // (see buildPartyRoleRegex) on top of the tsv role-noun prefilter. NOT mere co-occurrence
  // of the role word — that wrongly matched courier mentions. 'any'/undefined → no constraint.
  party_role?: PartyRole;
}

// Hand-rolled case forms for the role nouns — the 'simple' PG config has no Ukrainian
// stemmer, so each declension must be listed explicitly. Constant strings only (never
// user input), so they are safe to interpolate into to_tsquery().
const ROLE_TSQUERY: Record<Exclude<PartyRole, 'any'>, string> = {
  defendant: 'відповідач | відповідача | відповідачу | відповідачем | відповідачі | відповідачів | відповідачам | відповідачами',
  plaintiff: 'позивач | позивача | позивачу | позивачем | позивачі | позивачів | позивачам | позивачами',
};

// Legal-form prefixes a court may place before a company name in the claim clause
// ("ТОВ", "ПрАТ", "ПАТ", "ФОП", …). Constant ERE alternation (no user input), so it is
// safe to embed in the built pattern. Declension suffixes are spelled out because the
// 'simple' PG config / POSIX regex have no Ukrainian stemmer.
const LEGAL_FORM_GROUP =
  '(?:тов|товариств[а-яіїєґ]*[[:space:]]+з[[:space:]]+обмежен[а-яіїєґ]*[[:space:]]+відповідальніст[а-яіїєґ]*' +
  '|прат|приватн[а-яіїєґ]*[[:space:]]+акціонерн[а-яіїєґ]*[[:space:]]+товариств[а-яіїєґ]*' +
  '|пат|публічн[а-яіїєґ]*[[:space:]]+акціонерн[а-яіїєґ]*[[:space:]]+товариств[а-яіїєґ]*' +
  '|пп|приватн[а-яіїєґ]*[[:space:]]+підприємств[а-яіїєґ]*' +
  '|тдв|ат|дп|кп|фг|фоп)';

/**
 * Build a POSIX-ERE pattern (for `full_text ~* $param`) that matches the party ONLY when it
 * stands in the requested procedural slot of the claim clause "за позовом X до Y про …":
 *   - defendant → the name appears right after "до"/"проти" (the respondent slot)
 *   - plaintiff → the name appears right after "за позовом" (the claimant slot)
 *
 * `party_name` is user input (any company name carried in the user's query), so regex
 * metacharacters are escaped and internal whitespace is made flexible; the result is passed
 * as a BOUND PARAMETER, never interpolated into SQL. A REQUIRED closing quote after the name
 * discriminates the exact legal entity, so «Нова Пошта» is kept while «Нова Пошта Інтернешнл»
 * (a different company) is rejected.
 *
 * This replaces the old bag-of-words role check (party name + the word «відповідач»
 * co-occurring anywhere in the text), which wrongly matched decisions that merely named the
 * company as a courier ("надіслано через ТОВ «Нова Пошта»") or where it was the plaintiff.
 */
export function buildPartyRoleRegex(partyName: string, role: Exclude<PartyRole, 'any'>): string {
  const name = partyName
    .trim()
    .replace(/[.\\*+?()[\]{}|^$]/g, '\\$&')   // escape ERE metacharacters in user input
    .replace(/\s+/g, '[[:space:]]+');          // tolerate any whitespace between name tokens
  // Optional legal form, optional opening quote, the name, then a REQUIRED closing quote.
  const anchoredName = `${LEGAL_FORM_GROUP}?[[:space:]]*[«"”“]?[[:space:]]*${name}[»"”“]`;
  return role === 'defendant'
    ? `(?:до|проти)[[:space:]]+${anchoredName}`
    : `за[[:space:]]+позов[а-яіїєґ]*[[:space:]]+${anchoredName}`;
}

export interface EdsrFtsResult {
  doc_id: number;
  headline: string | null;
  rank: number;
  adjudication_date?: string;
  cause_num?: string;
  judge?: string;
  court_code?: number;
  justice_kind?: number;
  judgment_code?: number;
}

export interface EdsrFtsSearchResponse {
  query: string;
  total: number;
  returned: number;
  offset: number;
  has_more: boolean;
  results: EdsrFtsResult[];
}

export interface PartyCaseCount {
  /**
   * DOCUMENT count. One case produces many documents (ухвали, рішення, постанови at each
   * instance), so this is always >= the number of cases. Kept as `total` for callers that
   * genuinely want documents; anything user-facing that says "справ" must use `distinct_cases`.
   */
  total: number;
  /**
   * Distinct `cause_num` across the whole candidate set. Cannot be derived from `by_court` —
   * summing per-court case counts would count a case once per instance it passed through,
   * which is exactly how `total` came to overstate ЕВЕРЛІҐАЛ as 684 "справ" against 591 real
   * ones. Rows with a null cause_num are excluded by count(DISTINCT ...).
   */
  distinct_cases: number;
  by_court: Array<{ court_code: number; count: number }>;
  sample?: Array<{ doc_id: number; cause_num: string | null; court_code: number | null; justice_kind: number | null; adjudication_date: string | null }>;
  /** True when the FTS fallback hit PARTY_COUNT_CAND_CAP — `total` is then a floor, not an exact count. */
  capped?: boolean;
  /** The cap that was applied, present only alongside `capped`. */
  candidate_cap?: number;
}

// Candidate cap for the countByParty FTS fallback (the path taken whenever the structured
// parties table does not cover the requested years — i.e. always, while edrsr_parties is
// empty on prod).
//
// The old query joined edrsr_fulltext to edrsr_documents directly and let the planner
// choose. For a rare single-lexeme name the GIN row estimate is off by four orders of
// magnitude (22.6M estimated vs 684 actual), so it hash-joined a full parallel seq scan of
// all 136M edrsr_documents rows: 59.4s measured on prod, straddling the 60s tool timeout —
// count_cases_by_party for "ЕВЕРЛІҐАЛ" failed 3 times out of 3. A multi-token phrase got a
// different estimate and a nested-loop plan, which is why the same tool answered
// "ЛУЇ ДРЕЙФУС КОМПАНІ УКРАЇНА" in 1.1s. Resolving the FTS side first (MATERIALIZED) makes
// the join doc_id index lookups in every case: 59.4s → 1.4s for the same rare name.
//
// The cap bounds the high-volume tail (НАФТОГАЗ matches 343,089 documents, ПРИВАТБАНК more
// than 400,000, where even the materialized join runs into minutes). The capped subset is
// always the NEWEST `cap` documents — candCte assembles it from per-year legs precisely so
// that stays true without a corpus-wide sort. A truncated run sets `capped`, so a floor is
// never reported as an exact count; note that by_court is then a distribution over those
// newest documents, not over the party's whole history.
//
// The same cap is used for the sample path, and it must NOT be lowered "because the sample
// only needs ten rows". Measured on prod, sample latency for the same rare name:
// LIMIT 2000 → >90s (timeout), LIMIT 5000 → >90s (timeout), LIMIT 25000 → 1.57s. A small
// LIMIT makes the planner walk idx_ef_p_*_docid backwards probing tsv for matches instead of
// running the GIN bitmap scan and sorting the top N — the bigger cap is what keeps it on the
// index-driven plan. Same shape on a common name: 5000 → timeout, 25000 → 2.93s.
const PARTY_COUNT_CAND_CAP = 25_000;

export interface EdsrIndexProgress {
  total: number;
  indexed: number;
  remaining: number;
  percentComplete: number;
}

// Anchor-vocabulary floor (LEXAI Cause-A fix). A token must occur in at least this many
// sampled documents to be trusted as an FTS anchor. Below it (or absent from the corpus),
// the token is a WEAK term — a colloquial abbreviation / OCR / typo (e.g. "сумування",
// "дррп") that the LLM reformulator baked into the fts string. Such tokens pollute an
// all-AND plainto_tsquery (→ 0 results) AND, fatally, survive IDF-only relaxation because
// "rare == high idf == kept first". The floor is relative to the sample with an absolute
// minimum, and is applied ONLY when document frequencies are supplied.
export const ANCHOR_DF_FRACTION = 1e-4;  // 3.0M-doc sample → ~300-doc floor
export const ANCHOR_DF_MIN_ABS = 8;

export interface SelectFtsTermsOpts {
  // Per-(lowercased)-token document frequency from edrsr_lexeme_df. When present, tokens
  // below the anchor floor are demoted to the tail so relaxation drops THEM first.
  df?: Map<string, number>;
  sampleDocs?: number;  // total sampled docs → relative floor = sampleDocs * ANCHOR_DF_FRACTION
}

// ── Status-vocabulary demotion + geo promotion (CORE-106) ─────────────────────
// Repro chat-98f8472e/chat-5340fe5c (gold-eval FAILs): the LLM echoes the user's
// party-status wording («ВПО» → «внутрішньо переміщені особи») into the search query.
// Those tokens are corpus-RARE (переміщ df≈1095), so IDF-first ordering puts them at the
// head of the capped AND-set — where they poison it: the query stays satisfiable (IDP
// cases exist in droves, so term-relaxation never fires) but the target decision, which
// exempts objects BY TERRITORY and never mentions the owner's status, can no longer match.
// Party status describes the person, not the legal issue — it must never outrank operative
// anchors. Conversely a locality token («Донецьк») is the single most discriminative
// operative fact and must survive the cap even at a modest idf.
// Prefix stems (lowercased, matched via startsWith over the sanitized token) so declined
// forms match without morphology.

/** Party-status vocabulary — demoted to the very tail (below weak junk: weak terms yield
 *  0 results and relaxation recovers, a satisfiable-but-wrong status conjunct does not). */
export const STATUS_VOCAB_STEMS: readonly string[] = [
  'впо', 'переміщен', 'переселен', 'внутрішньо', 'пенсіонер', 'інвалід',
  'ветеран', 'чорнобил', 'багатодіт', 'малозабезпечен', 'біженц', 'безробітн',
];

/** Occupied/frontline localities + oblast stems — promoted to the head of the anchor tier. */
export const GEO_ANCHOR_STEMS: readonly string[] = [
  'донецьк', 'донецк', 'луганськ', 'маріупол', 'крим', 'севастопол', 'херсон',
  'запоріз', 'запоріж', 'харків', 'миколаїв', 'бахмут', 'авдіївк', 'лисичанськ',
  'сєвєродонецьк', 'словянськ', 'краматорськ', 'горлівк', 'макіївк', 'мелітопол',
  'бердянськ', 'енергодар', 'токмак', 'волноваха',
];

/** Minimum count of non-status anchors for status demotion to apply: with fewer, the
 *  query is genuinely ABOUT the status (e.g. «пільги переселенців») and stays untouched. */
const STATUS_DEMOTE_MIN_ANCHORS = 3;

function matchesStemList(tokenLc: string, stems: readonly string[]): boolean {
  const t = sanitizeFtsToken(tokenLc);
  return t.length > 0 && stems.some(s => t.startsWith(s));
}

/** Telemetry helper (CORE-106): does the token belong to the party-status vocabulary? */
export function isStatusVocabToken(token: string): boolean {
  return matchesStemList((token || '').toLowerCase(), STATUS_VOCAB_STEMS);
}

/**
 * IDF-weighted ordering of FTS keyword tokens (CORE-21 P1.5a + LEXAI Cause-A).
 *
 * Returns discriminative-but-REAL terms first, so the caller probes them and relaxation
 * drops the commonest (low idf) and the junk (sub-floor df) first. Two-tier order:
 *   1. anchors (df ≥ floor, or df unknown) — by idf desc (rarest real term first)
 *   2. weak terms (df < floor: ultra-rare / absent → likely colloquial/typo) — by df desc,
 *      kept only as a last resort so a fully-colloquial query still searches *something*.
 *
 * Zero-risk fallbacks: an EMPTY idf map (df table unpopulated / lookup failed) preserves the
 * original positional order; with no `opts.df` the behaviour is exactly the previous pure-idf
 * ordering. Stable on ties via the original index.
 */
export function selectFtsTerms(
  tokens: string[],
  idfByToken: Map<string, number>,
  opts?: SelectFtsTermsOpts,
): string[] {
  if (idfByToken.size === 0) return [...tokens];
  const df = opts?.df;
  const floor = df
    ? Math.max(ANCHOR_DF_MIN_ABS, Math.round((opts?.sampleDocs ?? 0) * ANCHOR_DF_FRACTION))
    : 0;
  const scored = tokens.map((tok, i) => {
    const lc = tok.toLowerCase();
    const d = df ? (df.get(lc) ?? 0) : undefined;
    return {
      tok, i,
      idf: idfByToken.get(lc) ?? 0,
      d: d ?? 0,
      weak: df ? (d! < floor) : false,
      geo: matchesStemList(lc, GEO_ANCHOR_STEMS),
      status: matchesStemList(lc, STATUS_VOCAB_STEMS),
    };
  });
  // CORE-106: demote status vocabulary only while enough operative anchors remain —
  // a status-centric query (e.g. «пільги переселенців») keeps its subject untouched.
  const anchorCount = scored.filter(x => !x.weak && !x.status).length;
  const demoteStatus = anchorCount >= STATUS_DEMOTE_MIN_ANCHORS;
  // Tier order (cap takes the head, relaxation pops the tail):
  //   0 geo anchors · 1 anchors · 2 weak junk · 3 demoted status
  const tier = (x: typeof scored[number]): number => {
    if (demoteStatus && x.status) return 3;
    if (x.weak) return 2;
    return x.geo ? 0 : 1;
  };
  return scored
    .sort((a, b) => {
      const ta = tier(a), tb = tier(b);
      if (ta !== tb) return ta - tb;
      return ta === 2 ? (b.d - a.d) || (a.i - b.i)     // weak tail: least-rare junk first
                      : (b.idf - a.idf) || (a.i - b.i); // others: discriminative first
    })
    .map(x => x.tok);
}

// Token sanitisation for prefix tsquery construction. The 'simple' config keeps Cyrillic
// and Latin letters + digits; everything else (punctuation, tsquery metachars & | ! ( ) : *)
// is stripped so the token can never break to_tsquery or inject operators.
const MIN_STEM_LEN = 5;       // shortest prefix we will snap to (4-grams over-match in uk)
const MAX_STEM_LEN = 12;      // longest candidate prefix considered

export function sanitizeFtsToken(token: string): string {
  return (token || '').toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '');
}

/**
 * Build a declension-tolerant prefix tsquery string from already-snapped stems:
 *   ['окупован', 'нерухом'] → "окупован:* & нерухом:*"
 * Stems are sanitised corpus prefixes (no user metacharacters), so they are safe to embed.
 * Returns null when there is nothing usable (caller falls back to plainto_tsquery).
 */
export function buildPrefixTsquery(stems: string[]): string | null {
  const parts = stems.map(s => sanitizeFtsToken(s)).filter(s => s.length >= 1);
  if (parts.length === 0) return null;
  return parts.map(s => `${s}:*`).join(' & ');
}

// Cap-before-rank (LEXAI FTS perf). `ORDER BY ts_rank_cd(...) DESC` forces Postgres to
// compute the rank of EVERY matching row before it can take the top N. For broad topical
// prefix queries (податок:* & нерухом:* …) the match set is millions of rows across the
// year partitions, so ranking alone runs >40s and the tool hits its 120s ceiling. Instead
// we cap the candidate set with a cheap GIN-only scan (WHERE tsv @@ q LIMIT N), then rank
// only those — measured 412ms vs >35s on prod. Narrow queries (party/metadata, < cap
// matches) are unaffected: ranking the full match set and ranking the capped set are
// identical when the match set already fits under the cap.
const FTS_CANDIDATE_CAP = 2000;
// Belt-and-suspenders: even the capped rank could be pathological. A per-statement timeout
// caps the worst case; on timeout we return EMPTY so the caller's relax/hybrid fallback
// takes over instead of surfacing an error (the FTS leg returning 0 → hybrid is an
// already-supported path). Must comfortably clear the capped query (sub-second on prod).
const FTS_STATEMENT_TIMEOUT_MS = 8000;

/**
 * Historical RTF imports (2007-2025) left the RTF control word `\~` (non-breaking
 * space) in full_text; 2026+ arrives clean, so this is a fixed-size backlog, not a
 * growing one. Cosmetic only: to_tsvector is byte-identical with and without it, so
 * the FTS index is unaffected and needs no rebuild.
 *
 * Stripping the marker and collapsing the space runs it leaves behind reproduces the
 * reference (already-cleaned) copy exactly - verified by md5 of both texts with all
 * whitespace removed.
 *
 * Applied on read at the paths whose text a user actually reads. Drop this once the
 * historical partitions are cleaned in place, after which it is a no-op.
 */
export const cleanEdrsrTextSql = (col: string) =>
  `regexp_replace(replace(${col}, '\\~', ''), '[ ]{2,}', ' ', 'g')`;

export class EdsrFtsService {
  private edsrCache: EdsrCacheService | null = null;

  // EDRSR data can live in a different database than the app's main one (e.g. a dev instance
  // reading EDRSR from prod under a readonly user while writing sessions/costs to its own DB).
  // When EDRSR_DATABASE_URL is set, this dedicated pool overrides whatever pool callers pass;
  // unset → the caller-passed pool is used unchanged (prod behaviour).
  private readonly dedicatedPool: Pool | null;

  constructor(dedicatedPool?: Pool) {
    if (dedicatedPool) {
      this.dedicatedPool = dedicatedPool;
    } else {
      const url = (process.env.EDRSR_DATABASE_URL || '').trim();
      this.dedicatedPool = url
        ? new Pool({
            connectionString: url,
            max: parseInt(process.env.EDRSR_POOL_MAX || '20', 10),
          })
        : null;
      if (this.dedicatedPool) {
        let host = 'unparseable-url';
        try { host = new URL(url).host; } catch { /* keep placeholder, never log creds */ }
        logger.info('[EdsrFtsService] EDRSR_DATABASE_URL set — using dedicated EDRSR pool', { host });
      }
    }
  }

  /** Dedicated EDRSR pool when configured, otherwise the pool the caller passed. */
  private resolvePool(dbPool: any): any {
    return this.dedicatedPool ?? dbPool;
  }

  /**
   * The dedicated EDRSR pool (opened from EDRSR_DATABASE_URL) if configured,
   * else null. Lets other EDRSR-corpus readers (e.g. CourtDecisionTools) route
   * edrsr_documents/edrsr_fulltext reads to the same dedicated DB instead of the
   * main app pool. When null (prod, data co-located), callers fall back to their
   * own pool — no behaviour change.
   */
  getDedicatedPool(): Pool | null {
    return this.dedicatedPool;
  }

  // LEXAI-1760: years whose plaintiff/defendant spans have been extracted into edrsr_parties
  // (read from edrsr_parties_coverage). When a count's date range falls entirely inside these
  // years, countByParty serves it from the indexed parties table instead of the full-text
  // regex scan. Cached briefly; empty set (table absent / not yet built) ⇒ always FTS fallback.
  private coveredYearsCache: { years: Set<number>; at: number } | null = null;
  private static readonly COVERAGE_TTL_MS = 60_000;

  setEdsrCache(cache: EdsrCacheService): void {
    this.edsrCache = cache;
  }

  /**
   * Years served by the structured parties table (edrsr_parties_coverage), cached for
   * COVERAGE_TTL_MS. Fail-safe: any error / missing table ⇒ empty set ⇒ callers fall back to
   * the legacy FTS path, so a half-built or absent table can never break counting.
   */
  private async coveredPartyYears(dbPool: any): Promise<Set<number>> {
    const now = Date.now();
    if (this.coveredYearsCache && now - this.coveredYearsCache.at < EdsrFtsService.COVERAGE_TTL_MS) {
      return this.coveredYearsCache.years;
    }
    let years = new Set<number>();
    try {
      const res = await dbPool.query(`SELECT adj_year FROM edrsr_parties_coverage`);
      years = new Set(res.rows.map((r: any) => Number(r.adj_year)));
    } catch {
      years = new Set();
    }
    this.coveredYearsCache = { years, at: now };
    return years;
  }

  /** Normalise a party name the same way the backfill builds name_norm (lower, strip quotes,
   *  collapse whitespace), then escape ILIKE wildcards so it is matched literally as a substring. */
  private normalizePartyName(partyName: string): string {
    return partyName
      .toLowerCase()
      .replace(/[«»"“”']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[%_\\]/g, '\\$&');
  }

  /**
   * Fast role count from the structured parties table — used by countByParty only when the
   * whole [date_from, date_to] year span is covered (see coveredPartyYears). Returns null when
   * the fast path is not applicable (no/partial date range, an uncovered year, or any error),
   * which signals the caller to fall back to the FTS scan.
   */
  private async countByPartyFast(
    partyName: string,
    partyRole: PartyRole | undefined,
    dbPool: any,
    filters: { date_from?: string; date_to?: string; justice_kind?: number },
    sampleLimit: number,
  ): Promise<PartyCaseCount | null> {
    const { date_from, date_to } = filters;
    if (!date_from || !date_to) return null;                       // open-ended range — coverage not guaranteed
    const yFrom = Number(date_from.slice(0, 4));
    const yTo = Number(date_to.slice(0, 4));
    if (!Number.isInteger(yFrom) || !Number.isInteger(yTo) || yFrom > yTo) return null;

    const covered = await this.coveredPartyYears(dbPool);
    if (covered.size === 0) return null;
    for (let y = yFrom; y <= yTo; y++) {
      if (!covered.has(y)) return null;                            // any uncovered year ⇒ fall back to FTS
    }

    const namePattern = `%${this.normalizePartyName(partyName)}%`;
    const params: any[] = [namePattern, yFrom, yTo];
    let p = 4;
    const conditions = [`name_norm ILIKE $1`, `adj_year BETWEEN $2 AND $3`];
    if (partyRole && partyRole !== 'any') {
      conditions.push(`role = $${p}`);
      params.push(partyRole === 'defendant' ? 2 : 1);
      p++;
    } else {
      conditions.push(`role IN (1, 2)`);
    }
    // Day-precision bounds inside the boundary years (the year span is coarse): re-check the
    // exact adjudication_date so e.g. 2023-03-01..2023-09-30 is honoured, not the whole year.
    conditions.push(`adjudication_date >= $${p}`); params.push(date_from); p++;
    conditions.push(`adjudication_date <= $${p}`); params.push(date_to); p++;
    if (filters.justice_kind) { conditions.push(`justice_kind = $${p}`); params.push(filters.justice_kind); p++; }
    const whereClause = conditions.join(' AND ');

    try {
      const countSql = `
        SELECT court_code, count(DISTINCT doc_id)::int AS n
        FROM edrsr_parties
        WHERE ${whereClause}
        GROUP BY court_code
        ORDER BY n DESC`;
      const countResult = await dbPool.query(countSql, params);
      const by_court = countResult.rows
        .filter((r: any) => r.court_code !== null)
        .map((r: any) => ({ court_code: r.court_code, count: r.n }));
      const total = countResult.rows.reduce((s: number, r: any) => s + r.n, 0);

      // `total` above counts DOCUMENTS (distinct doc_id). edrsr_parties carries no cause_num,
      // so distinct cases need the documents table — same distinction the FTS path makes, kept
      // here so this route cannot silently report documents as "справ" if it ever goes live.
      const casesResult = await dbPool.query(
        `SELECT count(DISTINCT d.cause_num)::int AS distinct_cases
           FROM edrsr_parties p JOIN edrsr_documents d ON d.doc_id = p.doc_id
          WHERE ${whereClause.replace(/\bname_norm\b/g, 'p.name_norm')
                              .replace(/\badj_year\b/g, 'p.adj_year')
                              .replace(/\brole\b/g, 'p.role')
                              .replace(/\badjudication_date\b/g, 'p.adjudication_date')
                              .replace(/\bjustice_kind\b/g, 'p.justice_kind')}`,
        params
      );
      const distinct_cases = Number(casesResult.rows[0]?.distinct_cases ?? 0);

      let sample: PartyCaseCount['sample'];
      if (sampleLimit > 0) {
        const safeSample = Math.min(Math.max(sampleLimit, 1), 1000);
        const sampleSql = `
          SELECT DISTINCT ON (p.doc_id) p.doc_id, d.cause_num, p.court_code, p.justice_kind, p.adjudication_date
          FROM edrsr_parties p
          JOIN edrsr_documents d ON d.doc_id = p.doc_id
          WHERE ${whereClause.replace(/\bname_norm\b/g, 'p.name_norm')
                              .replace(/\badj_year\b/g, 'p.adj_year')
                              .replace(/\brole\b/g, 'p.role')
                              .replace(/\badjudication_date\b/g, 'p.adjudication_date')
                              .replace(/\bjustice_kind\b/g, 'p.justice_kind')}
          ORDER BY p.doc_id, p.adjudication_date DESC NULLS LAST
          LIMIT ${safeSample}`;
        const sampleResult = await dbPool.query(sampleSql, params);
        sample = sampleResult.rows.map((r: any) => ({
          doc_id: Number(r.doc_id), cause_num: r.cause_num ?? null, court_code: r.court_code ?? null,
          justice_kind: r.justice_kind ?? null, adjudication_date: r.adjudication_date ?? null,
        }));
      }

      logger.info('[EdsrFtsService] countByParty (fast/parties-table)', {
        party_name: partyName, party_role: partyRole ?? 'any', years: [yFrom, yTo], total, distinct_cases, courts: by_court.length,
      });
      return { total, distinct_cases, by_court, ...(sample ? { sample } : {}) };
    } catch (err: any) {
      logger.warn('[EdsrFtsService] countByPartyFast failed; falling back to FTS', { error: err.message, party_name: partyName });
      return null;
    }
  }

  /**
   * Per-token IDF from the sampled edrsr_lexeme_df table (CORE-21 P1.5a). Returns a
   * Map<lowercased token, idf>; idf = ln(sample_docs / df) for sampled lexemes, and
   * ln(sample_docs) (the maximum) for tokens below the sampling floor when the table
   * IS populated. Returns an EMPTY map when the df table is empty/missing/unreadable —
   * callers then keep positional ordering (no regression before the table is built).
   */
  async lexemeDf(tokens: string[], dbPool: any): Promise<Map<string, number>> {
    return (await this.lexemeStats(tokens, dbPool)).idf;
  }

  /**
   * Like lexemeDf but also returns the raw per-token document frequency and the sample size,
   * so callers can apply the anchor-floor in selectFtsTerms (LEXAI Cause-A). `df` carries 0
   * for tokens absent from the sampled corpus — the signal that separates a rare-but-real
   * legal term from colloquial junk/typos. Same fail-safe contract as lexemeDf: an
   * empty/missing/unreadable table yields empty maps + sampleDocs 0 (positional fallback).
   */
  /**
   * Resolve a judge name fragment to the exact spellings present in EDRSR.
   *
   * The tools advertise partial names, so this filter has always been a substring
   * match. Running that substring directly against `edrsr_documents.judge` means a
   * Seq Scan of 135.8M rows across every partition — a leading wildcard cannot use
   * the per-partition b-tree, and `LOWER(judge)` would not match it in any case.
   * Measured through the tool that cost 83-120 s depending on mode.
   *
   * `edrsr_judges_distinct` (migration 183) holds the 26,642 distinct judge values
   * with decision counts, so the same LIKE runs over 26k rows in ~2 ms and callers
   * then filter by equality, which the existing b-trees serve. Semantics are
   * unchanged — verified identical result counts, 15,170 ms → 33 ms.
   *
   * Three outcomes, and callers must keep them apart:
   *   string[] non-empty — filter by equality on these names
   *   []                 — nothing matches; return no rows, exactly as the old
   *                        substring match did. NOT "drop the filter".
   *   null               — lookup unavailable (migration 183 not applied yet);
   *                        fall back to the old substring predicate. Slow, but
   *                        correct, and far better than silently unfiltered results.
   *
   * Ordered by decision count and capped, because a degenerate fragment (a single
   * common letter) would otherwise build an enormous ANY list. Real fragments are
   * surnames and match a handful; the cap only bites on input that was never going
   * to be a useful filter.
   */
  async resolveJudgeNames(
    fragment: string,
    dbPool: any,
    limit = 500,
  ): Promise<string[] | null> {
    dbPool = this.resolvePool(dbPool);
    const needle = (fragment || '').trim();
    if (!needle) return [];
    try {
      const { rows } = await dbPool.query(
        `SELECT judge FROM edrsr_judges_distinct
          WHERE lower(judge) LIKE lower($1)
          ORDER BY decisions DESC
          LIMIT $2`,
        [`%${needle}%`, limit],
      );
      return rows.map((r: any) => r.judge as string);
    } catch (e) {
      logger.warn('[EdsrFts] resolveJudgeNames unavailable — falling back to substring scan', {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  async lexemeStats(
    tokens: string[],
    dbPool: any,
  ): Promise<{ idf: Map<string, number>; df: Map<string, number>; sampleDocs: number }> {
    dbPool = this.resolvePool(dbPool);
    const idf = new Map<string, number>();
    const df = new Map<string, number>();
    const lexemes = [...new Set(tokens.map(t => t.toLowerCase()).filter(Boolean))];
    if (lexemes.length === 0) return { idf, df, sampleDocs: 0 };
    try {
      const res = await dbPool.query(
        `SELECT lexeme, df, sample_docs FROM edrsr_lexeme_df WHERE lexeme = ANY($1::text[])`,
        [lexemes],
      );
      // sample_docs identifies whether the table is populated. Any matched row carries
      // it; otherwise a cheap probe. No value -> empty table -> no signal (positional).
      let sampleDocs = Number(res.rows[0]?.sample_docs) || 0;
      if (!sampleDocs) {
        const probe = await dbPool.query(`SELECT sample_docs FROM edrsr_lexeme_df LIMIT 1`);
        sampleDocs = Number(probe.rows[0]?.sample_docs) || 0;
      }
      if (!sampleDocs) return { idf, df, sampleDocs: 0 };
      const maxIdf = Math.log(sampleDocs);
      const dfByLex = new Map<string, number>();
      for (const r of res.rows) dfByLex.set(r.lexeme, Number(r.df));
      for (const lex of lexemes) {
        const d = dfByLex.get(lex);
        idf.set(lex, d && d > 0 ? Math.log(sampleDocs / d) : maxIdf);
        df.set(lex, d && d > 0 ? d : 0);
      }
      return { idf, df, sampleDocs };
    } catch (err: any) {
      logger.warn('[EdsrFtsService] lexemeStats lookup failed; positional FTS fallback', { error: err.message });
      return { idf: new Map(), df: new Map(), sampleDocs: 0 };
    }
  }

  /**
   * Snap each query token to the LONGEST corpus stem present in edrsr_lexeme_df with
   * prefix-df ≥ floor (LEXAI Cause-A.2). This is the data-driven fix for two coupled
   * failures: (1) the 'simple' config has no Ukrainian stemmer, so an exact-form match
   * ("окупована") misses the declined forms a decision actually uses ("окупованій",
   * "нерухомості"); snapping to the stem ("окупован") + a `:*` prefix query restores
   * recall. (2) colloquial junk / typos that have no corpus stem (or only a sub-floor
   * one) snap to nothing and are dropped — choosing terms FROM the existing key list.
   *
   * Returns Map<sanitized-token, stem>. Tokens with no qualifying stem are absent (dropped).
   * Floor mirrors the anchor floor: max(ANCHOR_DF_MIN_ABS, sampleDocs * ANCHOR_DF_FRACTION).
   * Fail-safe: any error → empty map (caller keeps the plainto_tsquery path).
   */
  async snapTokensToStems(tokens: string[], dbPool: any): Promise<Map<string, string>> {
    dbPool = this.resolvePool(dbPool);
    const out = new Map<string, string>();
    const clean = [...new Set(tokens.map(sanitizeFtsToken).filter(t => t.length >= MIN_STEM_LEN))];
    if (clean.length === 0) return out;
    // Candidate prefixes per token: longest → shortest (we pick the longest that clears the
    // floor). Bounded by [MIN_STEM_LEN, MAX_STEM_LEN] so very long words stay cheap.
    const candidates: string[] = [];
    for (const tok of clean) {
      const top = Math.min(tok.length, MAX_STEM_LEN);
      for (let len = top; len >= MIN_STEM_LEN; len--) candidates.push(tok.slice(0, len));
    }
    const uniqCandidates = [...new Set(candidates)];
    try {
      // Prefix-df for every candidate in one round-trip, as an explicit range so
      // edrsr_lexeme_df_lexeme_prefix (btree text_pattern_ops, migration 166) can serve it.
      //
      // This used to read `lexeme LIKE u.cand || '%'` on the belief that the index would
      // turn it into a range scan. It does not: Postgres derives range bounds from a LIKE
      // only when the pattern is known at plan time, and here it is built from an unnest
      // column, so every candidate fell back to a Seq Scan of all 987k rows. One chat
      // search sends 40-50 candidates, so that was 40-50 full table scans per search:
      // measured on prod 2026-08-20 at 398,544 shared-buffer hits and 4.0s warm, 90-120s
      // cold. That is what pushed search_court_decisions and find_similar_fact_pattern_cases
      // past the 120s tool timeout on long queries. The range form plans as a Bitmap Index
      // Scan: 18 buffers, 0.5ms.
      //
      // `~>=~`/`~<~` are the text_pattern_ops comparison operators — byte-wise, matching
      // LIKE 'x%' semantics regardless of collation, which plain >=/< would not guarantee.
      // The LIKE stays as a redundant filter so the rewrite cannot change which lexemes
      // match (verified against prod data: 20 candidates, 0 mismatches).
      const res = await dbPool.query(
        `SELECT u.cand AS cand,
                (SELECT COALESCE(sum(d.df), 0) FROM edrsr_lexeme_df d
                  WHERE d.lexeme ~>=~ u.cand
                    AND d.lexeme ~<~ (u.cand || chr(1114111))
                    AND d.lexeme LIKE u.cand || '%') AS df
         FROM unnest($1::text[]) AS u(cand)`,
        [uniqCandidates],
      );
      let sampleDocs = 0;
      const probe = await dbPool.query(`SELECT sample_docs FROM edrsr_lexeme_df LIMIT 1`);
      sampleDocs = Number(probe.rows[0]?.sample_docs) || 0;
      if (!sampleDocs) return out;  // table empty → no snap signal → plainto fallback
      const floor = Math.max(ANCHOR_DF_MIN_ABS, Math.round(sampleDocs * ANCHOR_DF_FRACTION));
      const dfByCand = new Map<string, number>();
      for (const r of res.rows) dfByCand.set(r.cand, Number(r.df));
      for (const tok of clean) {
        const top = Math.min(tok.length, MAX_STEM_LEN);
        // SHORTEST valid prefix wins: it is the most inflection-tolerant stem (e.g. "нерух"
        // matches нерухоме/нерухомості/нерухомість), whereas the longest above-floor prefix
        // ("нерухомість") would again miss other declensions. The floor blocks meaningless
        // short n-grams that don't actually occur in the corpus.
        for (let len = MIN_STEM_LEN; len <= top; len++) {
          const cand = tok.slice(0, len);
          if ((dfByCand.get(cand) ?? 0) >= floor) { out.set(tok, cand); break; }
        }
      }
      return out;
    } catch (err: any) {
      logger.warn('[EdsrFtsService] snapTokensToStems failed; plainto fallback', { error: err.message });
      return new Map();
    }
  }

  /**
   * Full text search over edrsr_fulltext with optional metadata filters from edrsr_documents.
   *
   * Uses ts_rank_cd for relevance scoring and ts_headline for snippet generation.
   * Falls back to ILIKE when tsv column is not yet populated for matching rows.
   */
  async searchFulltext(
    query: string,
    dbPool: any,
    filters: EdsrFtsFilters = {},
    limit: number = 20,
    offset: number = 0,
    headlineQuery?: string,
    topicalTsquery?: string,
  ): Promise<EdsrFtsSearchResponse> {
    dbPool = this.resolvePool(dbPool);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);

    // LEXAI Cause-A.2: when the caller supplies a prebuilt prefix tsquery (vocabulary-snapped
    // stems like "окупован:* & нерухом:*"), match/rank/highlight with to_tsquery so declined
    // Ukrainian forms are caught. Without it, behaviour is the original plainto_tsquery path.
    const useTsq = !!(topicalTsquery && topicalTsquery.trim());
    const topicalArg = useTsq ? topicalTsquery!.trim() : query;
    const topicalExpr = useTsq ? `to_tsquery('simple', $1)` : `plainto_tsquery('simple', $1)`;
    // Distinct cache key per actual tsquery so prefix and plainto results never collide.
    const cacheKey = useTsq ? `tsq:${topicalArg}` : query;

    // Check cache first
    if (this.edsrCache) {
      const cached = await this.edsrCache.getCachedFtsResults(cacheKey, filters, safeLimit, safeOffset);
      if (cached) {
        logger.debug('[EdsrFtsService] Cache hit for FTS query', { query: cacheKey });
        return cached;
      }
    }

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // FTS condition on tsv column. The topical query stays at $1 so ranking and
    // ts_headline (below) reference it directly. Party constraints are AND-combined
    // into the same tsvector match via the && operator:
    //   - party_name → phraseto_tsquery (contiguous phrase, declension-tolerant for
    //     quoted proper names which courts keep in nominative)
    //   - party_role → to_tsquery of enumerated role-noun case forms
    const tsqueryParts: string[] = [topicalExpr];   // $1 — plainto OR to_tsquery (see useTsq)
    params.push(topicalArg);
    paramIdx++;

    const partyName = filters.party_name?.trim();
    if (partyName) {
      tsqueryParts.push(`phraseto_tsquery('simple', $${paramIdx})`);
      params.push(partyName);
      paramIdx++;
    }
    const roleTsquery = filters.party_role && filters.party_role !== 'any'
      ? ROLE_TSQUERY[filters.party_role]
      : null;
    if (roleTsquery) {
      // roleTsquery is a hardcoded constant — safe to inline, no user input.
      tsqueryParts.push(`to_tsquery('simple', '${roleTsquery}')`);
    }

    conditions.push(`f.tsv @@ (${tsqueryParts.join(' && ')})`);

    // Precise role enforcement: the party must stand in the claim clause's role slot, not
    // merely co-occur with the role noun anywhere in the text. Applied as a regex post-filter
    // on full_text — the tsv match above narrows the candidate rows the regex has to scan.
    if (partyName && filters.party_role && filters.party_role !== 'any') {
      conditions.push(`f.full_text ~* $${paramIdx}`);
      params.push(buildPartyRoleRegex(partyName, filters.party_role));
      paramIdx++;
    }

    // Metadata filters — require JOIN with edrsr_documents
    const hasMetadataFilter = filters.court_code || filters.judge || filters.date_from ||
      filters.date_to || filters.justice_kind || filters.judgment_code ||
      filters.category_code || filters.instance_code;

    if (filters.court_code) {
      conditions.push(`d.court_code = $${paramIdx}`);
      params.push(filters.court_code);
      paramIdx++;
    }
    if (filters.judge) {
      // Resolve the fragment against the distinct-judge lookup first, then filter by
      // equality so the per-partition b-trees on judge become usable. The old
      // `LOWER(d.judge) LIKE LOWER(...)` seq-scanned all 26 partitions of
      // edrsr_documents (135.8M rows) — 83-120 s through the tool. Same matching
      // semantics, same results, 15,170 ms → 33 ms. See resolveJudgeNames.
      const judgeNames = await this.resolveJudgeNames(filters.judge, dbPool);
      if (judgeNames === null) {
        // Lookup unavailable (migration 183 not applied) — old predicate. Slow, but
        // correct; dropping the filter here would return unrelated judges instead.
        conditions.push(`LOWER(d.judge) LIKE LOWER($${paramIdx})`);
        params.push(`%${filters.judge}%`);
        paramIdx++;
      } else if (judgeNames.length === 0) {
        // No judge matches the fragment. Match nothing — same as the old predicate.
        conditions.push('FALSE');
      } else {
        conditions.push(`d.judge = ANY($${paramIdx})`);
        params.push(judgeNames);
        paramIdx++;
      }
    }
    if (filters.date_from) {
      conditions.push(`d.adjudication_date >= $${paramIdx}`);
      params.push(filters.date_from);
      paramIdx++;
    }
    if (filters.date_to) {
      conditions.push(`d.adjudication_date <= $${paramIdx}`);
      params.push(filters.date_to);
      paramIdx++;
    }
    if (filters.justice_kind) {
      conditions.push(`d.justice_kind = $${paramIdx}`);
      params.push(filters.justice_kind);
      paramIdx++;
    }
    if (filters.judgment_code) {
      conditions.push(`d.judgment_code = $${paramIdx}`);
      params.push(filters.judgment_code);
      paramIdx++;
    }
    if (filters.category_code) {
      conditions.push(`d.category_code = $${paramIdx}`);
      params.push(filters.category_code);
      paramIdx++;
    }

    // Instance code filter — must be added before building whereClause
    let extraJoin = '';
    if (filters.instance_code) {
      extraJoin = ` LEFT JOIN edrsr_courts c ON c.court_code = d.court_code`;
      conditions.push(`c.instance_code = $${paramIdx}`);
      params.push(filters.instance_code);
      paramIdx++;
    }

    // Optional separate query for snippet highlighting. Callers that append discriminator
    // terms to the FTS match (e.g. compare_practice_pro_contra adds "відмовити у задоволенні")
    // can pass the bare user query here so ts_headline centres the snippet on the topic,
    // not on the boilerplate suffix (which produced header-only snippets — see LEXAI fix).
    let headlineParamIdx = 1;
    if (headlineQuery && headlineQuery !== query) {
      headlineParamIdx = paramIdx;
      params.push(headlineQuery);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Build FROM clause — only join edrsr_documents when metadata filters are used
    const fromClause = hasMetadataFilter
      ? `edrsr_fulltext f INNER JOIN edrsr_documents d ON d.doc_id = f.doc_id`
      : `edrsr_fulltext f`;

    // Headline tsquery: a caller-supplied bare headlineQuery is plain text (plainto); otherwise
    // it reuses $1, which is a prefix tsquery when useTsq → highlight via to_tsquery so the
    // snippet centres on the same declined matches the search found.
    const explicitHeadline = !!(headlineQuery && headlineQuery !== query);
    const headlineFn = (useTsq && !explicitHeadline)
      ? `to_tsquery('simple', $${headlineParamIdx})`
      : `plainto_tsquery('simple', $${headlineParamIdx})`;

    const buildSelectFields = (withHeadline: boolean) => {
      const headlineExpr = withHeadline
        ? `safe_ts_headline('simple'::regconfig, ${cleanEdrsrTextSql('f.full_text')}, ${headlineFn},
           'MaxWords=${FTS_HEADLINE_MAX_WORDS}, MinWords=${FTS_HEADLINE_MIN_WORDS}, StartSel=**, StopSel=**') AS headline`
        : `NULL AS headline`;

      return hasMetadataFilter
        ? `f.doc_id,
           ts_rank_cd(f.tsv, ${topicalExpr}) AS rank,
           ${headlineExpr},
           d.adjudication_date, d.cause_num, d.judge, d.court_code,
           d.justice_kind, d.judgment_code`
        : `f.doc_id,
           ts_rank_cd(f.tsv, ${topicalExpr}) AS rank,
           ${headlineExpr}`;
    };

    // Run the data query under a per-statement timeout (B). SET LOCAL needs a transaction,
    // so use a dedicated client when the pool exposes connect(); otherwise fall back to a
    // plain pooled query (timeout-less) so non-pg pool wrappers still work.
    const queryWithTimeout = async (sql: string, args: any[]) => {
      // A pooled client lets us scope SET LOCAL statement_timeout to one transaction. Only the
      // raw pg Pool yields a client with query()/release(); sharded/wrapper pools may expose a
      // connect() that returns undefined or a non-pg object (this broke compare_practice_pro_contra,
      // which passes such a wrapper). Probe the client and fall back to a plain pooled query —
      // which still runs the cap-before-rank SQL, just without the per-statement timeout.
      let client: any;
      if (typeof dbPool.connect === 'function') {
        try { client = await dbPool.connect(); } catch { client = undefined; }
      }
      if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
        if (client && typeof client.release === 'function') client.release();
        return dbPool.query(sql, args);
      }
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${FTS_STATEMENT_TIMEOUT_MS}`);
        const res = await client.query(sql, args);
        await client.query('COMMIT');
        return res;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
        throw e;
      } finally {
        client.release();
      }
    };

    const executeQuery = async (withHeadline: boolean) => {
      const selectFields = buildSelectFields(withHeadline);

      // Cap-before-rank (A): a MATERIALIZED CTE pins a bounded candidate set via a cheap
      // GIN-only scan (WHERE tsv @@ q LIMIT cap, no rank/headline), then rank/highlight only
      // those. AS MATERIALIZED stops the planner from inlining the cap back into the ranked
      // scan. The metadata JOIN (when present) lives in the CTE so its filters bound the
      // candidates; the outer JOIN re-fetches d.* for the returned rows only.
      const outerFrom = hasMetadataFilter
        ? `edrsr_fulltext f
           JOIN cand ON cand.doc_id = f.doc_id
           JOIN edrsr_documents d ON d.doc_id = f.doc_id`
        : `edrsr_fulltext f
           JOIN cand ON cand.doc_id = f.doc_id`;

      // Skip expensive COUNT(*) — use LIMIT+1 to detect has_more instead
      const dataSql = `
        WITH cand AS MATERIALIZED (
          SELECT f.doc_id
          FROM ${fromClause}${extraJoin}
          WHERE ${whereClause}
          LIMIT ${FTS_CANDIDATE_CAP}
        )
        SELECT ${selectFields}
        FROM ${outerFrom}
        ORDER BY ${EDRSR_FTS_SEARCH_ORDER}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

      const dataResult = await queryWithTimeout(dataSql, [...params, safeLimit + 1, safeOffset]);
      const total = dataResult.rows.length > safeLimit ? safeLimit * 10 : dataResult.rows.length;
      if (dataResult.rows.length > safeLimit) {
        dataResult.rows = dataResult.rows.slice(0, safeLimit);
      }
      return { total, dataResult };
    };

    try {
      let total: number;
      let dataResult: any;

      try {
        ({ total, dataResult } = await executeQuery(true));
      } catch (headlineErr: any) {
        // Retry without ts_headline if encoding error (some records have invalid UTF-8 bytes)
        if (headlineErr.code === '22021') {
          logger.warn('[EdsrFtsService] Retrying without ts_headline due to encoding error', { query });
          ({ total, dataResult } = await executeQuery(false));
        } else if (headlineErr.code === '57014') {
          // Statement timeout (B): even the candidate-capped rank blew the budget. Return
          // empty so the caller's relax/hybrid fallback (FTS-0 → hybrid) takes over instead
          // of erroring out to the user.
          logger.warn('[EdsrFtsService] FTS statement timeout; returning empty for fallback', {
            query: cacheKey, timeoutMs: FTS_STATEMENT_TIMEOUT_MS,
          });
          total = 0;
          dataResult = { rows: [] };
        } else {
          throw headlineErr;
        }
      }

      logger.info('[EdsrFtsService] searchFulltext', {
        query,
        filters: Object.keys(filters).filter(k => (filters as any)[k] !== undefined),
        total,
        returned: dataResult.rows.length,
      });

      const response = {
        query,
        total,
        returned: dataResult.rows.length,
        offset: safeOffset,
        has_more: safeOffset + dataResult.rows.length < total,
        results: dataResult.rows.map((row: any) => ({
          doc_id: row.doc_id,
          headline: row.headline || null,
          rank: parseFloat(row.rank) || 0,
          ...(row.adjudication_date !== undefined ? { adjudication_date: row.adjudication_date } : {}),
          ...(row.cause_num !== undefined ? { cause_num: row.cause_num } : {}),
          ...(row.judge !== undefined ? { judge: row.judge } : {}),
          ...(row.court_code !== undefined ? { court_code: row.court_code } : {}),
          ...(row.justice_kind !== undefined ? { justice_kind: row.justice_kind } : {}),
          ...(row.judgment_code !== undefined ? { judgment_code: row.judgment_code } : {}),
        })),
      };

      // Cache the result (keyed by the actual tsquery so prefix/plainto never collide)
      if (this.edsrCache) {
        this.edsrCache.setCachedFtsResults(cacheKey, filters, safeLimit, safeOffset, response).catch(() => {});
      }

      return response;
    } catch (err: any) {
      logger.error('[EdsrFtsService] searchFulltext failed', { error: err.message, query });
      throw new Error(`FTS search failed: ${err.message}`);
    }
  }

  /**
   * Exact case count for a party (optionally constrained to a procedural role), with a
   * per-court breakdown — backs count_cases_by_party. Replaces the old keyword-paginated
   * approach (which routed through a now-removed deprecated adapter stub and returned 0).
   *
   * party_name is matched as a phrase (declension-tolerant for quoted proper names);
   * party_role appends the enumerated role-noun case forms. Both are anchored into the
   * tsvector match, so the GIN index does the selection and only the matched rows are
   * counted/grouped.
   *
   * The FTS fallback resolves candidates in a MATERIALIZED CTE capped at
   * PARTY_COUNT_CAND_CAP before joining edrsr_documents — see that constant for the plan
   * collapse this avoids. Below the cap the count is exact; at the cap it is a floor and
   * `capped` is set.
   */
  async countByParty(
    partyName: string,
    partyRole: PartyRole | undefined,
    dbPool: any,
    filters: { date_from?: string; date_to?: string; justice_kind?: number } = {},
    sampleLimit: number = 0,
  ): Promise<PartyCaseCount> {
    dbPool = this.resolvePool(dbPool);
    // LEXAI-1760: when the requested year span is fully covered by the structured parties
    // table, answer from its indexes (fast, exact) instead of regex-scanning 125M full texts.
    // Returns null when not applicable / on error → fall through to the legacy FTS path below.
    const fast = await this.countByPartyFast(partyName, partyRole, dbPool, filters, sampleLimit);
    if (fast) return fast;

    const params: any[] = [];
    let p = 1;

    const tsqueryParts: string[] = [`phraseto_tsquery('simple', $${p})`];
    params.push(partyName);
    p++;
    const roleTsquery = partyRole && partyRole !== 'any' ? ROLE_TSQUERY[partyRole] : null;
    if (roleTsquery) {
      // roleTsquery is a hardcoded constant — safe to inline, no user input.
      tsqueryParts.push(`to_tsquery('simple', '${roleTsquery}')`);
    }

    // Conditions are split by the table they touch: the `f` (edrsr_fulltext) ones select
    // candidates inside the MATERIALIZED CTE, the `d` (edrsr_documents) ones filter after
    // the join. Both share one params array, so the $-numbering stays global to the
    // statement and must be built in this order.
    const ftsConditions = [`f.tsv @@ (${tsqueryParts.join(' && ')})`];
    // Claim-clause role post-filter (see buildPartyRoleRegex) — keeps the count honest by
    // dropping decisions that only mention the party as a courier or in the opposite role.
    if (partyRole && partyRole !== 'any') {
      ftsConditions.push(`f.full_text ~* $${p}`);
      params.push(buildPartyRoleRegex(partyName, partyRole));
      p++;
    }
    // Push the requested period into the CTE as an adj_year band. edrsr_fulltext is
    // LIST-partitioned by adj_year, so this prunes partitions and shrinks the GIN scan
    // itself — the only lever that actually helps a high-volume party. Measured on prod:
    // НАФТОГАЗ 50.5s → 5.0s, ПРИВАТБАНК >90s → 1.8s for a single year. Without it the
    // date filter only runs after the CTE and the "narrow the period" advice is a lie.
    //
    // The band is widened by a year on each side deliberately: adj_year agrees with
    // extract(year from adjudication_date) on prod (verified, and no NULLs), but the
    // exact d.adjudication_date bounds below are what enforce the period, so the band
    // only ever needs to be a superset. One spare partition per side costs little and
    // removes any timezone-boundary risk.
    const yearBand = (iso?: string, delta = 0): number | null => {
      const y = Number(String(iso ?? '').slice(0, 4));
      return Number.isInteger(y) && y > 1900 ? y + delta : null;
    };
    const yFrom = yearBand(filters.date_from, -1);
    const yTo = yearBand(filters.date_to, +1);
    if (yFrom !== null) { ftsConditions.push(`f.adj_year >= $${p}`); params.push(yFrom); p++; }
    if (yTo !== null) { ftsConditions.push(`f.adj_year <= $${p}`); params.push(yTo); p++; }

    const docConditions: string[] = [];
    if (filters.date_from) { docConditions.push(`d.adjudication_date >= $${p}`); params.push(filters.date_from); p++; }
    if (filters.date_to) { docConditions.push(`d.adjudication_date <= $${p}`); params.push(filters.date_to); p++; }
    if (filters.justice_kind) { docConditions.push(`d.justice_kind = $${p}`); params.push(filters.justice_kind); p++; }
    const ftsWhere = ftsConditions.join(' AND ');
    const docWhere = docConditions.length ? `WHERE ${docConditions.join(' AND ')}` : '';

    // Year boundaries between the three candidate legs (see candCte). Two single-year legs
    // ahead of the remainder, rather than one two-year band: each is pruned to a single
    // partition, which is what keeps its sort cheap, and the second one carries a
    // high-volume party through January, when the current-year partition is still too thin
    // to fill the cap on its own.
    const thisYear = new Date().getFullYear();
    const y0Param = p; params.push(thisYear); p++;
    const y1Param = p; params.push(thisYear - 1); p++;

    // Candidates, in three disjoint legs taken newest year first. MATERIALIZED is
    // load-bearing throughout: see PARTY_COUNT_CAND_CAP for why the un-materialized join
    // collapses.
    //
    // The problem this shape solves is that "the newest 25000" as ONE global top-N forces
    // the GIN scan to read every match before it can answer, so a party with hundreds of
    // thousands of documents was unanswerable: ПРИВАТБАНК (400k+) ran past 90s and blew
    // the 60s tool timeout. Splitting by year fixes it without giving up the ordering,
    // because each leg is pruned to a single partition and sorts only that partition:
    // `r0` alone satisfies a high-volume party and the rest are skipped.
    //
    // Every leg after the first is limited to whatever its predecessors left unfilled.
    // When the cap is already full that expression is 0 and Postgres returns from the leg
    // without scanning it, which is what makes the skip free. Because the legs are
    // disjoint and consumed in descending year order, the union is EXACTLY the newest
    // `cap` documents — the same answer a global ORDER BY would give, assembled from
    // partition-local sorts instead of one corpus-wide one.
    //
    // Measured on prod, paired and cache-fair. High-volume parties become answerable:
    // ПРИВАТБАНК >90s timeout -> 2.41s count / 2.72s sample, НАФТОГАЗ 50.5s -> 2.50s, and
    // both sample the true corpus maximum (2026-07-13). The price is one extra leg scan
    // for a rare name (ЕВЕРЛІҐАЛ 1.18s -> 1.66s) and nothing for a mid-volume one
    // (ЛУЇ ДРЕЙФУС 0.26s either way).
    //
    // Two single-year legs rather than one two-year band, for two independent reasons.
    // Cost: ordering a two-year band costs 44s cold for ПРИВАТБАНК versus 2.4s for a
    // single year. Calendar: a lone current-year leg is too thin every January to fill the
    // cap, which would drop high-volume parties back onto the corpus-wide ordered leg for
    // weeks — verified by running the split a year ahead (2.44s, still fine).
    const candCte = (cap: number) => `
        r0 AS MATERIALIZED (
          SELECT f.doc_id
          FROM edrsr_fulltext f
          WHERE ${ftsWhere} AND f.adj_year >= $${y0Param}
          ORDER BY f.doc_id DESC
          LIMIT ${cap}
        ),
        r1 AS MATERIALIZED (
          SELECT f.doc_id
          FROM edrsr_fulltext f
          WHERE ${ftsWhere} AND f.adj_year >= $${y1Param} AND f.adj_year < $${y0Param}
          ORDER BY f.doc_id DESC
          LIMIT GREATEST(0, ${cap} - (SELECT count(*) FROM r0))
        ),
        older AS MATERIALIZED (
          SELECT f.doc_id
          FROM edrsr_fulltext f
          WHERE ${ftsWhere} AND f.adj_year < $${y1Param}
          ORDER BY f.doc_id DESC
          LIMIT GREATEST(0, ${cap} - (SELECT count(*) FROM r0) - (SELECT count(*) FROM r1))
        ),
        cand AS MATERIALIZED (
          SELECT doc_id FROM r0
          UNION ALL
          SELECT doc_id FROM r1
          UNION ALL
          SELECT doc_id FROM older
        )`;

    try {
      const countSql = `
        WITH ${candCte(PARTY_COUNT_CAND_CAP)},
        agg AS (
          SELECT d.court_code, count(*)::int AS n
          FROM cand JOIN edrsr_documents d ON d.doc_id = cand.doc_id
          ${docWhere}
          GROUP BY d.court_code
        ),
        tot AS (
          SELECT count(DISTINCT d.cause_num)::int AS distinct_cases
          FROM cand JOIN edrsr_documents d ON d.doc_id = cand.doc_id
          ${docWhere}
        )
        SELECT c.candidates, t.distinct_cases, a.court_code, a.n
        FROM (SELECT count(*)::int AS candidates FROM cand) c
        CROSS JOIN tot t
        LEFT JOIN agg a ON TRUE
        ORDER BY a.n DESC NULLS LAST`;
      const countResult = await dbPool.query(countSql, params);
      // LEFT JOIN, not `FROM agg`: the candidate count must survive an empty aggregate.
      // A doc-side filter with no CTE counterpart (justice_kind) can drop every one of the
      // newest candidates, and `FROM agg` would then return zero rows — losing `candidates`
      // with them, so a capped search reported total 0 as an exact answer while older
      // matching documents existed. That is the precise failure this method exists to stop.
      // The synthetic row carries a null court_code and is dropped below.
      const by_court = countResult.rows
        .filter((r: any) => r.court_code !== null && r.court_code !== undefined)
        .map((r: any) => ({ court_code: r.court_code, count: r.n }));
      const total = by_court.reduce((s: number, r: any) => s + r.count, 0);
      const candidates = Number(countResult.rows[0]?.candidates ?? 0);
      const distinct_cases = Number(countResult.rows[0]?.distinct_cases ?? 0);
      // `cand` is LIMIT-ed to the cap, so count(*) over it tops out AT the cap and this is
      // effectively `=== cap`. A party matching exactly PARTY_COUNT_CAND_CAP documents is
      // therefore flagged capped even though its count is complete. Accepted: reading
      // `LIMIT cap + 1` to disambiguate would perturb a planner-verified constant for one
      // exact value, and the mislabel errs toward warning when it need not — never toward
      // presenting a truncated count as exact, which is the direction that matters.
      const capped = candidates >= PARTY_COUNT_CAND_CAP;

      let sample: PartyCaseCount['sample'];
      if (sampleLimit > 0) {
        const safeSample = Math.min(Math.max(sampleLimit, 1), 1000);
        // The sample only needs the newest few, so it walks a much shorter slice of the
        // same doc_id-ordered stream. The second MATERIALIZED is also load-bearing: with
        // a plain join the `ORDER BY adjudication_date DESC LIMIT n` lets the planner walk
        // idx_ed_p_*_adj_date backwards probing for matches, which on a rare name means
        // scanning millions of rows before it finds n (111s measured on prod).
        const sampleSql = `
          WITH ${candCte(PARTY_COUNT_CAND_CAP)},
          joined AS MATERIALIZED (
            SELECT d.doc_id, d.cause_num, d.court_code, d.justice_kind, d.adjudication_date
            FROM cand JOIN edrsr_documents d ON d.doc_id = cand.doc_id
            ${docWhere}
          )
          SELECT * FROM joined
          ORDER BY adjudication_date DESC NULLS LAST
          LIMIT ${safeSample}`;
        const sampleResult = await dbPool.query(sampleSql, params);
        sample = sampleResult.rows.map((r: any) => ({
          doc_id: Number(r.doc_id), cause_num: r.cause_num ?? null, court_code: r.court_code ?? null,
          justice_kind: r.justice_kind ?? null, adjudication_date: r.adjudication_date ?? null,
        }));
      }

      logger.info('[EdsrFtsService] countByParty', {
        party_name: partyName, party_role: partyRole ?? 'any',
        filters: Object.keys(filters).filter(k => (filters as any)[k] !== undefined),
        total, distinct_cases, courts: by_court.length, candidates, capped,
      });

      return {
        total,
        distinct_cases,
        by_court,
        ...(sample ? { sample } : {}),
        ...(capped ? { capped: true, candidate_cap: PARTY_COUNT_CAND_CAP } : {}),
      };
    } catch (err: any) {
      logger.error('[EdsrFtsService] countByParty failed', { error: err.message, party_name: partyName });
      throw new Error(`Party count failed: ${err.message}`);
    }
  }

  /**
   * Return the subset of doc_ids that satisfy structural constraints the Qdrant leg
   * cannot enforce — party_name/party_role (tsv phrase + role match) and instance_code
   * (court instance). Used by hybrid search to re-check fused candidates AFTER RRF, so
   * vector-only hits that don't actually involve the named party (or aren't from the
   * requested instance) are dropped instead of polluting the result.
   *
   * Matching mirrors searchFulltext/countByParty exactly (phraseto_tsquery for the name,
   * role-noun tsv prefilter + claim-clause regex for the role), so a doc that passes here
   * would also have passed the FTS leg. With no party/instance constraint it is a pass-through.
   */
  async filterDocIdsByConstraints(
    docIds: number[],
    constraints: { party_name?: string; party_role?: PartyRole; instance_code?: number },
    dbPool: any,
  ): Promise<Set<number>> {
    dbPool = this.resolvePool(dbPool);
    const matched = new Set<number>();
    if (docIds.length === 0) return matched;

    const partyName = constraints.party_name?.trim();
    const instanceCode = constraints.instance_code;
    if (!partyName && !instanceCode) {
      for (const id of docIds) matched.add(Number(id));
      return matched;
    }

    const params: any[] = [docIds];
    let p = 2;
    const conditions: string[] = [`f.doc_id = ANY($1)`];

    if (partyName) {
      const tsqueryParts: string[] = [`phraseto_tsquery('simple', $${p})`];
      params.push(partyName);
      p++;
      const roleTsquery = constraints.party_role && constraints.party_role !== 'any'
        ? ROLE_TSQUERY[constraints.party_role]
        : null;
      if (roleTsquery) {
        // roleTsquery is a hardcoded constant — safe to inline, no user input.
        tsqueryParts.push(`to_tsquery('simple', '${roleTsquery}')`);
      }
      conditions.push(`f.tsv @@ (${tsqueryParts.join(' && ')})`);
      // Claim-clause role post-filter: re-check the fused (post-RRF) candidates so a
      // vector-only hit that merely names the party as a courier — or in the opposite role —
      // is dropped instead of polluting the result. This is the hybrid path that previously
      // let "через ТОВ «Нова Пошта»" decisions through the defendant filter.
      if (constraints.party_role && constraints.party_role !== 'any') {
        conditions.push(`f.full_text ~* $${p}`);
        params.push(buildPartyRoleRegex(partyName, constraints.party_role));
        p++;
      }
    }

    if (instanceCode) {
      conditions.push(`c.instance_code = $${p}`);
      params.push(instanceCode);
      p++;
    }

    // edrsr_courts join only needed for the instance filter.
    const fromClause = instanceCode
      ? `edrsr_fulltext f
         JOIN edrsr_documents d ON d.doc_id = f.doc_id
         JOIN edrsr_courts c ON c.court_code = d.court_code`
      : `edrsr_fulltext f`;

    try {
      const sql = `SELECT f.doc_id FROM ${fromClause} WHERE ${conditions.join(' AND ')}`;
      const res = await dbPool.query(sql, params);
      for (const row of res.rows) matched.add(Number(row.doc_id));
      logger.info('[EdsrFtsService] filterDocIdsByConstraints', {
        candidates: docIds.length, matched: matched.size,
        party_name: partyName, party_role: constraints.party_role ?? 'any', instance_code: instanceCode,
      });
      return matched;
    } catch (err: any) {
      logger.error('[EdsrFtsService] filterDocIdsByConstraints failed', { error: err.message });
      // Fail open: on error keep all candidates rather than dropping the whole result set.
      for (const id of docIds) matched.add(Number(id));
      return matched;
    }
  }

  /**
   * Populate tsv column for rows that haven't been indexed yet.
   * Designed to be called repeatedly by a background job / cron.
   *
   * @param batchSize Number of rows to index per call (default 1000)
   * @param dbPool    PostgreSQL pool to use (can be main or shard DB)
   * @returns Number of rows indexed in this batch
   */
  async indexBatch(batchSize: number = 1000, dbPool: any): Promise<number> {
    dbPool = this.resolvePool(dbPool);
    const safeBatch = Math.min(Math.max(batchSize, 1), 10000);

    try {
      // Find un-indexed rows and update in one statement using a CTE
      const result = await dbPool.query(`
        WITH batch AS (
          SELECT doc_id
          FROM edrsr_fulltext
          WHERE tsv IS NULL AND full_text IS NOT NULL
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE edrsr_fulltext f
        SET tsv = to_tsvector('simple', f.full_text)
        FROM batch
        WHERE f.doc_id = batch.doc_id
      `, [safeBatch]);

      const indexed = result.rowCount || 0;

      if (indexed > 0) {
        logger.info('[EdsrFtsService] indexBatch', { indexed, batchSize: safeBatch });
      }

      return indexed;
    } catch (err: any) {
      logger.error('[EdsrFtsService] indexBatch failed', { error: err.message });
      throw new Error(`FTS indexing batch failed: ${err.message}`);
    }
  }

  /**
   * Report indexing progress for the given database pool.
   */
  async getIndexProgress(dbPool: any): Promise<EdsrIndexProgress> {
    dbPool = this.resolvePool(dbPool);
    try {
      const result = await dbPool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(tsv)::int AS indexed,
          (COUNT(*) - COUNT(tsv))::int AS remaining
        FROM edrsr_fulltext
      `);

      const row = result.rows[0];
      const total = row.total || 0;
      const indexed = row.indexed || 0;
      const remaining = row.remaining || 0;
      const percentComplete = total > 0 ? Math.round((indexed / total) * 10000) / 100 : 0;

      return { total, indexed, remaining, percentComplete };
    } catch (err: any) {
      logger.error('[EdsrFtsService] getIndexProgress failed', { error: err.message });
      throw new Error(`Failed to get FTS index progress: ${err.message}`);
    }
  }
}
