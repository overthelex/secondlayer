/**
 * ChVerificationTools — ch_verify_citations: the deterministic grounding
 * self-check for Swiss legal answers (LEXAI-2036).
 *
 * lawrider ships no chat of its own — external agents (ChatGPT, Claude Code)
 * compose answers from the ch_* tools and are expected to run THIS tool over
 * their draft before presenting it. It returns four verdicts computed from
 * the corpus, never from a model:
 *
 *   1. citation validity  — every BGE/ATF/DTF, docket and ECLI reference in
 *      the text is looked up in ch_court_decisions.
 *   2. quote grounding    — a guillemet quote attributed to a cited decision
 *      must appear verbatim (whitespace-normalised) in its full_text.
 *   3. norm attribution   — «Art. N ABBR» claimed in the same sentence as a
 *      decision is checked against that decision's own extracted citation
 *      edges (ch_legislation_citations). Coverage-gated: a decision with no
 *      extracted edges is a data gap ('no_citation_data'), never a mismatch.
 *   4. precedent status   — per cited decision, the inbound-citation numbers
 *      from ch_decision_index (frequency, breadth, recency).
 *
 * Every check is judged only where the corpus can actually answer; anything
 * else is reported as unknown, not guessed.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

const MAX_TEXT_CHARS = 60000;
const MAX_REFERENCES = 15;
const MAX_TEXT_FETCHES = 5;
const MAX_EDGE_FETCHES = 5;
const MIN_QUOTE_CHARS = 25;
const QUOTE_BEFORE_WINDOW = 300;
const QUOTE_AFTER_WINDOW = 150;
const ACTIVE_YEARS = 3;

export type ChReferenceKind = 'bge' | 'docket' | 'ecli';

export interface ChCaseReference {
  raw: string;
  normalized: string;
  kind: ChReferenceKind;
  index: number;
}

const BGE_RE = /\b(BGE|ATF|DTF)\s+(\d{1,3})\s+(I[ab]?|II|III|IV|V)\s+(\d{1,4})\b/g;
const DOCKET_RE = /\b\d{1,2}[A-Z][A-Za-z]{0,2}_\d{1,5}\/\d{4}\b/g;
const ECLI_RE = /\bECLI:CH:[A-Za-z0-9_]+(?::[A-Za-z0-9._-]+)+/g;

/** Extract CH case references in document order, deduplicated on the
 *  normalized form. ATF (fr) and DTF (it) are the same reporter as BGE (de)
 *  and normalise to the German form the corpus stores in docket_number. */
export function extractChCaseReferences(text: string): ChCaseReference[] {
  const found: ChCaseReference[] = [];

  BGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BGE_RE.exec(text)) !== null) {
    found.push({ raw: m[0], normalized: `BGE ${m[2]} ${m[3]} ${m[4]}`, kind: 'bge', index: m.index });
  }

  // ECLIs are collected first and their spans blanked before the docket scan:
  // an ECLI's own segments must never be re-extracted as a docket.
  const ecliSpans: Array<[number, number]> = [];
  ECLI_RE.lastIndex = 0;
  while ((m = ECLI_RE.exec(text)) !== null) {
    const trimmed = m[0].replace(/[.,;:)\]]+$/, '');
    ecliSpans.push([m.index, m.index + trimmed.length]);
    found.push({ raw: trimmed, normalized: trimmed, kind: 'ecli', index: m.index });
  }

  DOCKET_RE.lastIndex = 0;
  while ((m = DOCKET_RE.exec(text)) !== null) {
    const idx = m.index;
    if (ecliSpans.some(([s, e]) => idx >= s && idx < e)) continue;
    found.push({ raw: m[0], normalized: m[0], kind: 'docket', index: idx });
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return found.filter(r => {
    if (seen.has(r.normalized)) return false;
    seen.add(r.normalized);
    return true;
  });
}

export interface ChQuotedClaim {
  reference: string;
  quote: string;
}

const QUOTE_RE = /«([^«»]+)»|“([^“”]+)”|"([^"]+)"/g;

/** Long quotes attributed to the nearest CH case reference — preceding within
 *  300 chars, else following within 150. Short quotes («ні») are emphasis,
 *  not holdings, and are skipped. */
export function extractChQuotedClaims(text: string): ChQuotedClaim[] {
  const refs = extractChCaseReferences(text);
  if (refs.length === 0) return [];

  const out: ChQuotedClaim[] = [];
  QUOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTE_RE.exec(text)) !== null) {
    const quote = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (quote.length < MIN_QUOTE_CHARS) continue;
    const qStart = m.index;
    const qEnd = m.index + m[0].length;

    let best: ChCaseReference | null = null;
    for (const r of refs) {
      const rEnd = r.index + r.raw.length;
      const precedes = rEnd <= qStart && qStart - rEnd <= QUOTE_BEFORE_WINDOW;
      const follows = r.index >= qEnd && r.index - qEnd <= QUOTE_AFTER_WINDOW;
      if (!precedes && !follows) continue;
      if (!best || Math.abs(r.index - qStart) < Math.abs(best.index - qStart)) best = r;
    }
    if (best) out.push({ reference: best.normalized, quote });
  }
  return out;
}

export interface ChNormClaim {
  reference: string;
  article: string;
  abbr: string;
}

// 'Art. 336 Abs. 1 OR' / "art. 336 al. 1 CO" / 'art. 336 cpv. 1 CO' — the
// article number, optional paragraph particles, then the act abbreviation.
const NORM_RE = /\b[Aa]rt\.\s*(\d+[a-z]?)(?:\s+(?:Abs|al|cpv)\.\s*\d+[a-z]?)*\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüàéèç-]{1,14})\b/g;
const NORM_ABBR_STOPLIST = new Set(['Abs', 'Ziff', 'Nr', 'ff']);

// Sentence splitting must not break on the dots INSIDE a norm citation
// ('Art. 336', 'Abs. 1'): those particles are shielded before the split and
// restored after.
const PARTICLE_RE = /\b(Art|art|Abs|al|cpv)\./g;
const SHIELD = '⦙';

/** «Art. N ABBR» paired with a case reference in the SAME sentence. A norm
 *  cited with no decision nearby is a doctrinal statement, not an attribution
 *  claim, and is not judged. */
export function extractChNormClaims(text: string): ChNormClaim[] {
  const shielded = text.replace(PARTICLE_RE, `$1${SHIELD}`);
  const out: ChNormClaim[] = [];
  const seen = new Set<string>();

  for (const rawSentence of shielded.split(/(?<=[.!?])\s+/)) {
    const sentence = rawSentence.split(SHIELD).join('.');
    const refs = extractChCaseReferences(sentence);
    if (refs.length === 0) continue;

    NORM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NORM_RE.exec(sentence)) !== null) {
      const abbr = m[2];
      if (NORM_ABBR_STOPLIST.has(abbr)) continue;
      const key = `${refs[0].normalized}|${m[1]}|${abbr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ reference: refs[0].normalized, article: m[1], abbr });
    }
  }
  return out;
}

function normalizeForQuoteSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[«»“”"­]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ChVerificationTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'ch_verify_citations',
        annotations: { title: 'Перевірка обґрунтованості швейцарських цитувань', readOnlyHint: true },
        description: `Детермінована самоперевірка чернетки відповіді зі швейцарськими цитуваннями — ЗАПУСКАЙТЕ її над своїм текстом перед тим, як показати відповідь користувачу.

Чотири вердикти, обчислені з корпусу (не моделлю):
1. citation_validity — кожне посилання BGE/ATF/DTF, номер справи (4A_22/2017) чи ECLI шукається в корпусі рішень; невідомі потрапляють в invalid_references.
2. quote_grounding — цитата в лапках, приписана рішенню, мусить дослівно (з точністю до пробілів) міститись у його повному тексті.
3. norm_attribution — «Art. N ABBR» в одному реченні з рішенням звіряється з витягнутими ребрами цитувань самого рішення; рішення без ребер = прогалина покриття (no_citation_data), не помилка.
4. precedent_status — для кожного процитованого рішення: скільки, як широко і як давно його цитують (actively_cited / previously_cited / uncited).

Значення вердиктів: pass / warning / unknown / no_citations (no_quotes, no_claims). warning означає: приберіть або виправте позначені посилання перед видачею відповіді.`,
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Чернетка відповіді для перевірки (до 60 000 символів)' },
          },
          required: ['text'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'ch_verify_citations': return this.verifyCitations(args);
      default: return null;
    }
  }

  /** One reference → the loaded decision it names, or null. Reporter forms
   *  prefer CH_BGE, plain dockets CH_BGer, then ecli — the same deterministic
   *  disambiguation order the resolve stage and ch_check_precedent_status use. */
  private async resolveReference(ref: ChCaseReference): Promise<any | null> {
    if (ref.kind === 'ecli') {
      return (await this.db.query(
        `SELECT ecli, docket_number, court_code, to_char(decision_date, 'YYYY-MM-DD') AS decision_date
           FROM ch_court_decisions WHERE ecli = $1 AND stage = 'loaded'`,
        [ref.normalized]
      )).rows[0] ?? null;
    }
    return (await this.db.query(
      `SELECT ecli, docket_number, court_code, to_char(decision_date, 'YYYY-MM-DD') AS decision_date
         FROM ch_court_decisions
        WHERE docket_number = $1 AND stage = 'loaded'
        ORDER BY (spider = $2) DESC, ecli LIMIT 1`,
      [ref.normalized, ref.kind === 'bge' ? 'CH_BGE' : 'CH_BGer']
    )).rows[0] ?? null;
  }

  private async verifyCitations(args: Record<string, unknown>): Promise<ToolResult> {
    const { text } = args as any;

    if (!text || !String(text).trim()) {
      return this.wrapResponse('Вкажіть text — чернетку відповіді для перевірки.');
    }
    const answer = String(text);
    if (answer.length > MAX_TEXT_CHARS) {
      return this.wrapResponse(`text задовгий (${answer.length} символів; максимум ${MAX_TEXT_CHARS}). Перевірте відповідь частинами.`);
    }

    try {
      const refs = extractChCaseReferences(answer).slice(0, MAX_REFERENCES);
      const quoteClaims = extractChQuotedClaims(answer);
      const normClaims = extractChNormClaims(answer);

      // ── 1+4: validity + precedent status ─────────────────────────
      const resolved = new Map<string, any | null>();
      const references: any[] = [];
      for (const ref of refs) {
        const decision = await this.resolveReference(ref);
        resolved.set(ref.normalized, decision);
        if (!decision) {
          references.push({ reference: ref.normalized, kind: ref.kind, exists: false });
          continue;
        }
        const agg = (await this.db.query(
          `SELECT cited_by_count, citing_courts,
                  to_char(first_citing_date, 'YYYY-MM-DD') AS first_citing_date,
                  to_char(last_citing_date, 'YYYY-MM-DD') AS last_citing_date
             FROM ch_decision_index WHERE ecli = $1`,
          [decision.ecli]
        )).rows[0];

        let status: 'uncited' | 'actively_cited' | 'previously_cited' = 'uncited';
        if (agg && Number(agg.cited_by_count) > 0) {
          const cutoff = new Date();
          cutoff.setFullYear(cutoff.getFullYear() - ACTIVE_YEARS);
          status = agg.last_citing_date != null && new Date(agg.last_citing_date) >= cutoff
            ? 'actively_cited' : 'previously_cited';
        }
        references.push({
          reference: ref.normalized,
          kind: ref.kind,
          exists: true,
          ecli: decision.ecli,
          docket_number: decision.docket_number,
          court_code: decision.court_code,
          decision_date: decision.decision_date,
          status,
          cited_by_count: agg ? Number(agg.cited_by_count) : 0,
          citing_courts: agg ? Number(agg.citing_courts) : 0,
          last_citing_date: agg?.last_citing_date ?? null,
        });
      }
      const invalidReferences = references.filter(r => !r.exists).map(r => r.reference);

      // ── 2: quote grounding ───────────────────────────────────────
      const textCache = new Map<string, string | null>();
      let fetches = 0;
      const quotes: any[] = [];
      for (const claim of quoteClaims) {
        const decision = resolved.get(claim.reference);
        let grounded: boolean | null = null;
        if (decision) {
          if (!textCache.has(decision.ecli) && fetches < MAX_TEXT_FETCHES) {
            fetches++;
            const row = (await this.db.query(
              `SELECT full_text FROM ch_court_decisions WHERE ecli = $1`,
              [decision.ecli]
            )).rows[0];
            textCache.set(decision.ecli, row?.full_text
              ? normalizeForQuoteSearch(row.full_text) : null);
          }
          const haystack = textCache.get(decision.ecli);
          if (haystack) grounded = haystack.includes(normalizeForQuoteSearch(claim.quote));
        }
        quotes.push({
          reference: claim.reference,
          quote_preview: claim.quote.slice(0, 120),
          grounded,
        });
      }

      // ── 3: norm attribution ──────────────────────────────────────
      const edgeCache = new Map<string, any[] | null>();
      let edgeFetches = 0;
      const normResults: any[] = [];
      for (const claim of normClaims) {
        const decision = resolved.get(claim.reference);
        if (!decision) {
          normResults.push({ ...claim, supported: null, reason: 'reference_not_in_corpus' });
          continue;
        }
        if (!edgeCache.has(decision.ecli)) {
          if (edgeFetches >= MAX_EDGE_FETCHES) {
            normResults.push({ ...claim, supported: null, reason: 'check_capped' });
            continue;
          }
          edgeFetches++;
          edgeCache.set(decision.ecli, (await this.db.query(
            `SELECT c.abbr_raw, c.article, a.abbreviation
               FROM ch_legislation_citations c
               LEFT JOIN ch_act a ON a.act_id = c.act_id
              WHERE c.from_ecli = $1`,
            [decision.ecli]
          )).rows);
        }
        const edges = edgeCache.get(decision.ecli)!;
        if (edges.length === 0) {
          normResults.push({ ...claim, supported: null, reason: 'no_citation_data' });
          continue;
        }
        const abbrUpper = claim.abbr.toUpperCase();
        const actEdges = edges.filter(e =>
          e.abbr_raw?.toUpperCase() === abbrUpper || e.abbreviation?.toUpperCase() === abbrUpper);
        if (actEdges.length === 0) {
          normResults.push({
            ...claim, supported: false, reason: 'act_not_cited',
            cited_acts: [...new Set(edges.map(e => e.abbr_raw).filter(Boolean))].slice(0, 10),
          });
          continue;
        }
        const base = claim.article.replace(/[a-z]$/, '');
        const hit = actEdges.some(e =>
          e.article === claim.article || e.article === base || e.article?.replace(/[a-z]$/, '') === base);
        normResults.push(hit
          ? { ...claim, supported: true }
          : {
              ...claim, supported: false, reason: 'article_not_cited',
              cited_articles: [...new Set(actEdges.map(e => e.article))].slice(0, 15),
            });
      }

      // ── verdicts ─────────────────────────────────────────────────
      const verdicts = {
        citation_validity: refs.length === 0 ? 'no_citations'
          : invalidReferences.length > 0 ? 'warning' : 'pass',
        quote_grounding: quotes.length === 0 ? 'no_quotes'
          : quotes.some(q => q.grounded === false) ? 'warning'
          : quotes.every(q => q.grounded === true) ? 'pass' : 'unknown',
        norm_attribution: normResults.length === 0 ? 'no_claims'
          : normResults.some(n => n.supported === false) ? 'warning'
          : normResults.every(n => n.supported === true) ? 'pass' : 'unknown',
        precedent_status: refs.length === 0 ? 'no_citations' : 'ok',
      };

      // The per-call grounding line the acceptance asks for — mirrors the UA
      // chat_grounding_signals logging, greppable and counted per signal.
      logger.info('[ChVerifyCitations] verdicts', {
        references: refs.length,
        invalid: invalidReferences.length,
        quotes: quotes.length,
        ungroundedQuotes: quotes.filter(q => q.grounded === false).length,
        normClaims: normResults.length,
        normMismatches: normResults.filter(n => n.supported === false).length,
        uncitedPrecedents: references.filter(r => r.exists && r.status === 'uncited').length,
        verdicts,
      });

      return this.wrapResponse({
        verdicts,
        references,
        invalid_references: invalidReferences,
        quotes,
        norm_claims: normResults,
        ...(refs.length >= MAX_REFERENCES ? { references_truncated: true } : {}),
      });
    } catch (error: any) {
      logger.error('ch_verify_citations error', { error: error.message });
      return this.wrapError(`Помилка перевірки цитувань: ${error.message}`);
    }
  }
}
