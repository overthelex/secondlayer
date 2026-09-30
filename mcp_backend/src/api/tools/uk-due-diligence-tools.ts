/**
 * uk_check_citations — statutory due diligence in one call (LEXAI-2069).
 *
 * The client's own assistant reads the contract and sends only what it cites: instrument
 * titles (or leg_ids) and provision numbers, plus the signing date. The contract text never
 * reaches this server. For each citation the tool says, from the statute book and the
 * amendment register, whether the instrument or provision was already revoked when the
 * contract was signed, has been revoked, amended or modified since, or is unchanged, and
 * which instrument made the change and when.
 *
 * It is the server-side twin of lawrider-uk/tools/contract_dd/checks.py, with batched SQL in
 * place of one MCP call per fact: per instrument one metadata row, one effects scan and one
 * version-history query, whatever the number of provisions.
 *
 * What it does not do: say what a change means for the contract. Findings are facts from
 * the register, classed so a lawyer can triage them.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { datesToDays } from './uk-dates.js';
import { classifyEffect, matchEffect, ProvisionTarget } from './uk-effects-match.js';
import { AS_AT_CAVEAT, ISO_DATE, normaliseLegId } from './uk-legislation-tools.js';

export const MAX_INSTRUMENTS = 60;
export const MAX_PROVISIONS = 200;
const TEXT_CAP = 1500;
const RANGE_CAP = 20;
const CONCURRENCY = 6;

export type CitationStatus =
  | 'revoked_before_signing'
  | 'not_in_force_at_signing'
  | 'revoked_since_signing'
  | 'changed_since_signing'
  | 'modified_since_signing'
  | 'not_found'
  | 'no_history'
  | 'unchanged';

/** Most serious first; an instrument takes the worst status of its provisions. */
export const SEVERITY: CitationStatus[] = [
  'revoked_before_signing', 'not_in_force_at_signing', 'revoked_since_signing',
  'changed_since_signing', 'modified_since_signing', 'not_found', 'no_history', 'unchanged',
];

const worst = (a: CitationStatus[]): CitationStatus =>
  a.reduce((w, s) => (SEVERITY.indexOf(s) < SEVERITY.indexOf(w) ? s : w), 'unchanged' as CitationStatus);

/** Title as the register would print it, for an exact comparison: case, "The", punctuation and a revocation note do not count. */
export function normTitle(t: string): string {
  return String(t || '')
    .replace(/\((?:revoked|repealed)[^)]*\)/gi, ' ')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const KIND_WORD: Array<[RegExp, string]> = [
  [/^(?:sections?|ss?)$/i, 'section'],
  [/^(?:regulations?|regs?)$/i, 'regulation'],
  [/^(?:articles?|arts?)$/i, 'article'],
  [/^(?:rules?|rr?)$/i, 'rule'],
];

function defaultKind(legId: string): string {
  return /^(uksi|ssi|wsi|nisr)\//.test(legId) ? 'regulation' : 'section';
}

/**
 * 'ss. 24-28' → 24..28; 'ss. 24A-24D' → 24A..24D; 'ss. 1-7B' → 1..7 and 7B (the register
 * prints ranges like that). Inserted sections with longer suffixes (7ZA) between the ends
 * cannot be enumerated from the citation alone. Null when the range is unreadable or too long.
 */
function expand(lo: string, hi: string | undefined): string[] | null {
  lo = lo.toUpperCase();
  if (!hi) return [lo];
  hi = hi.toUpperCase();
  const a = /^(\d+)([A-Z]?)$/.exec(lo), b = /^(\d+)([A-Z]?)$/.exec(hi);
  if (!a || !b) return /\./.test(lo + hi) || lo === hi ? [lo] : null;
  const na = Number(a[1]), nb = Number(b[1]);
  if (na === nb) {
    const from = (a[2] || 'A').charCodeAt(0), to = (b[2] || 'A').charCodeAt(0);
    if (to < from) return null;
    const out = a[2] ? [] : [a[1]];
    for (let c = from; c <= to; c++) out.push(`${na}${String.fromCharCode(c)}`);
    return out;
  }
  if (nb < na || nb - na > RANGE_CAP) return null;
  const out = Array.from({ length: nb - na + 1 }, (_, i) => String(na + i));
  if (a[2]) out[0] = lo;          // '7B-9': 7B, 8, 9
  if (b[2]) out.push(hi);         // '1-7B': 1..7, 7B
  return out;
}

/**
 * One cited provision as a contract or an assistant writes it: 's.24', 'section 38A(1)',
 * 'ss. 24-28', 'reg 40(4)', 'Sch. B1 para. 15', 'paragraph 2(2) of Schedule 4',
 * 'Schedule 7', or a key 'schedule/B1/paragraph/15'. Subsections are dropped: the register
 * and the archive both work at the level of the section. Returns null if it cannot be read.
 */
export function parseCitedProvision(input: string, legId: string): ProvisionTarget[] | null {
  let raw = String(input || '').trim();
  if (raw.startsWith(legId + '/')) raw = raw.slice(legId.length + 1);
  raw = raw.replace(/\s*\([^)]{1,8}\)/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  let m = /^schedule\/([0-9A-Za-z]+)\/paragraph\/([0-9A-Za-z.]+)$/i.exec(raw);
  if (m) return [{ kind: 'paragraph', schedule: m[1].toUpperCase(), number: m[2].toUpperCase() }];
  m = /^schedule\/([0-9A-Za-z]+)$/i.exec(raw);
  if (m) return [{ kind: 'schedule', number: m[1].toUpperCase() }];
  m = /^(section|regulation|article|rule)\/([0-9A-Za-z]+)$/i.exec(raw);
  if (m) return [{ kind: m[1].toLowerCase(), number: m[2].toUpperCase() }];

  const SCH = String.raw`(?:sch(?:edule)?s?\.?)`;
  const PARA = String.raw`(?:para(?:graph)?s?\.?)`;
  const NUM = String.raw`([0-9]+[A-Za-z]{0,3}(?:\.[0-9]+)?|[A-Za-z][0-9]+[A-Za-z]{0,2})`;
  const RANGE = String.raw`${NUM}(?:\s*(?:-|–|to)\s*${NUM})?`;
  const paras = (sch: string, lo: string, hi?: string) =>
    expand(lo, hi)?.map((n) => ({ kind: 'paragraph', schedule: sch.toUpperCase(), number: n })) ?? null;

  // "Sch. B1 para. 15", "Schedule 5, Part 1, paragraph 2", "Schedule 11 paragraph 5-7"
  m = new RegExp(String.raw`^${SCH}\s*${NUM}\s*,?\s*(?:(?:pt\.?|part)\s*[0-9IVXivx]+\s*,?\s*)?${PARA}\s*${RANGE}$`, 'i').exec(raw);
  if (m) return paras(m[1], m[2], m[3]);
  // "paragraph 15 of Schedule B1", "para 2 Sch 4"
  m = new RegExp(String.raw`^${PARA}\s*${RANGE}\s*(?:(?:of|to|in)\s+)?(?:the\s+)?${SCH}\s*${NUM}$`, 'i').exec(raw);
  if (m) return paras(m[3], m[1], m[2]);
  m = new RegExp(String.raw`^${SCH}\s*${NUM}$`, 'i').exec(raw);
  if (m) return [{ kind: 'schedule', number: m[1].toUpperCase() }];

  // "s.24", "section 38A", "ss. 24-28", "regs 107 to 110", bare "253"
  m = new RegExp(String.raw`^(?:([A-Za-z]+)\.?\s*)?${RANGE}$`).exec(raw);
  if (m) {
    let kind = defaultKind(legId);
    if (m[1]) {
      const k = KIND_WORD.find(([re]) => re.test(m![1]));
      if (!k) return null;
      kind = k[1];
    }
    return expand(m[2], m[3])?.map((n) => ({ kind, number: n })) ?? null;
  }
  return null;
}

/** Archive keys a target may be stored under; the corpus keys some SI rules as articles. */
export function candidateKeys(legId: string, t: ProvisionTarget): string[] {
  if (t.kind === 'paragraph') return [`${legId}/schedule/${t.schedule}/paragraph/${t.number}`];
  if (t.kind === 'schedule') return [`${legId}/schedule/${t.number}`];
  if (t.kind === 'rule') return [`${legId}/rule/${t.number}`, `${legId}/article/${t.number}`];
  return [`${legId}/${t.kind}/${t.number}`];
}

export function label(t: ProvisionTarget): string {
  const pre: Record<string, string> = { section: 's.', regulation: 'reg.', article: 'art.', rule: 'r.' };
  if (t.kind === 'paragraph') return `Sch. ${t.schedule} para. ${t.number}`;
  if (t.kind === 'schedule') return `Sch. ${t.number}`;
  return `${pre[t.kind] ?? t.kind + ' '}${t.number}`;
}

const cap = (s: string | null | undefined) =>
  s == null ? null : s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + ' …[truncated]' : s;

/** Dates are read as text in SQL (::text), so this only trims; a Date would be local midnight (see uk-dates.ts). */
const day = (d: any): string | null => {
  if (!d) return null;
  if (d instanceof Date) return datesToDays(d) as unknown as string;
  return String(d).slice(0, 10);
};

interface CitationInput { instrument?: unknown; provisions?: unknown; clause?: unknown }

export class UkDueDiligenceTools extends BaseToolHandler {
  protected override wrapResponse(data: any): ToolResult {
    return super.wrapResponse(datesToDays(data));
  }

  constructor(private db: any) {
    super();
  }

  /** Bad input is not charged: the fixed-price gate charges only results without isError. */
  private refuse(error: string, message: string): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }], isError: true };
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_check_citations',
        annotations: { title: 'UK statutory due diligence: check a contract\'s citations', readOnlyHint: true },
        description: `Checks every UK statute and statutory instrument a contract cites, in one call, against the statute book and the official amendment register (legislation.gov.uk).

Send only the citations, never the contract: read the contract yourself, list each instrument it cites (exact title as written, or leg_id such as 'ukpga/1954/56'), the provisions cited of each ('s.24', 'ss. 24-28', 'reg 40(4)', 'Sch. B1 para. 15', 'paragraph 2 of Schedule 4') and optionally the clause of the contract that cites it. as_of is the signing date.
For each instrument and provision it reports one of:
revoked_before_signing (already gone when the contract was signed), not_in_force_at_signing, revoked_since_signing, changed_since_signing (text changed; old and new text given), modified_since_signing (excluded, modified or restricted without a text change), unchanged, not_found (the act has history but no such provision: check the number), no_history (the archive has no point-in-time text for this act; only the amendment register was checked).
Each change names the amending instrument and the date it came into force. Titles that match no instrument exactly come back under unresolved with up to 3 closest titles: a contract that misnames a statute is itself a finding.
Limits: ${MAX_INSTRUMENTS} instruments and ${MAX_PROVISIONS} provisions per call (ranges count per provision). Subsections are checked at the level of the section.
⚠ ${AS_AT_CAVEAT}`,
        inputSchema: {
          type: 'object',
          properties: {
            as_of: { type: 'string', description: 'Signing date of the contract (YYYY-MM-DD)' },
            compare_to: { type: 'string', description: 'Date to compare against (YYYY-MM-DD); default today' },
            citations: {
              type: 'array',
              maxItems: MAX_INSTRUMENTS,
              description: 'One entry per cited instrument',
              items: {
                type: 'object',
                properties: {
                  instrument: { type: 'string', description: "Title exactly as the contract gives it, e.g. 'Landlord and Tenant Act 1954', or a leg_id" },
                  provisions: { type: 'array', items: { type: 'string' }, description: "Provisions cited, e.g. ['s.24', 's.38A(1)', 'Sch. B1 para. 15']" },
                  clause: { type: 'string', description: 'Optional: the clause of the contract that cites it, echoed back for the report' },
                },
                required: ['instrument'],
              },
            },
          },
          required: ['as_of', 'citations'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    return name === 'uk_check_citations' ? this.checkCitations(args) : null;
  }

  private async checkCitations(args: Record<string, unknown>): Promise<ToolResult> {
    const a = args as any;
    const asOf = a.as_of ? String(a.as_of) : '';
    const compareTo = a.compare_to ? String(a.compare_to) : new Date().toISOString().slice(0, 10);
    if (!ISO_DATE.test(asOf)) return this.refuse('bad_date', 'as_of (the signing date) must be YYYY-MM-DD.');
    if (!ISO_DATE.test(compareTo)) return this.refuse('bad_date', 'compare_to must be YYYY-MM-DD.');
    if (compareTo < asOf) return this.refuse('bad_date', 'compare_to is before as_of.');
    const list: CitationInput[] = Array.isArray(a.citations) ? a.citations : [];
    if (!list.length) return this.refuse('no_citations', 'Provide citations: one entry per instrument the contract cites.');
    if (list.length > MAX_INSTRUMENTS) {
      return this.refuse('too_many_instruments', `At most ${MAX_INSTRUMENTS} instruments per call; split the list.`);
    }

    try {
      // 1. Resolve every title to one register id; merge repeated instruments.
      const byId = new Map<string, { leg_id: string; title: string; cited_as: string[]; provisions: string[]; clauses: string[] }>();
      const unresolved: any[] = [];
      if (list.some((c) => !String(c?.instrument ?? '').trim())) {
        return this.refuse('bad_instrument', 'Every citation needs instrument: the title as the contract gives it, or a leg_id.');
      }
      for (const c of list) {
        const cited = String(c.instrument).trim();
        const provs = Array.isArray(c.provisions) ? c.provisions.map((p: unknown) => String(p)) : [];
        const clause = c.clause ? String(c.clause) : null;
        const hit = await this.resolve(cited);
        if ('suggestions' in hit) {
          unresolved.push({ cited_as: cited, ...(clause ? { clause } : {}), provisions: provs, suggestions: hit.suggestions });
          continue;
        }
        const e = byId.get(hit.leg_id) ?? { leg_id: hit.leg_id, title: hit.title, cited_as: [], provisions: [], clauses: [] };
        if (!e.cited_as.includes(cited)) e.cited_as.push(cited);
        e.provisions.push(...provs);
        if (clause && !e.clauses.includes(clause)) e.clauses.push(clause);
        byId.set(hit.leg_id, e);
      }

      // 2. Provisions to targets, within the per-call limit.
      const plans = [...byId.values()].map((e) => {
        const targets: ProvisionTarget[] = [];
        const unreadable: string[] = [];
        for (const p of e.provisions) {
          const t = parseCitedProvision(p, e.leg_id);
          if (!t) { unreadable.push(p); continue; }
          for (const x of t) if (!targets.some((y) => label(y) === label(x))) targets.push(x);
        }
        return { ...e, targets, unreadable };
      });
      const nProv = plans.reduce((n, p) => n + p.targets.length, 0);
      if (nProv > MAX_PROVISIONS) {
        return this.refuse('too_many_provisions', `At most ${MAX_PROVISIONS} provisions per call (ranges expanded); this call has ${nProv}. Split the list.`);
      }

      // 3. Check each instrument.
      // A few instruments at a time: each is 3-4 queries, and 60 in series is slow.
      const instruments: any[] = new Array(plans.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plans.length) }, async () => {
        while (next < plans.length) {
          const i = next++;
          instruments[i] = await this.checkInstrument(plans[i], asOf, compareTo);
        }
      }));
      instruments.sort((x, y) => SEVERITY.indexOf(x.status) - SEVERITY.indexOf(y.status));

      const summary: Record<string, number> = {};
      for (const i of instruments) summary[i.status] = (summary[i.status] || 0) + 1;
      const provSummary: Record<string, number> = {};
      for (const i of instruments) for (const pv of i.provisions) provSummary[pv.status] = (provSummary[pv.status] || 0) + 1;

      return this.wrapResponse({
        as_of: asOf,
        compare_to: compareTo,
        instruments_checked: instruments.length,
        provisions_checked: nProv,
        summary: { instruments: summary, provisions: provSummary, unresolved: unresolved.length },
        instruments,
        ...(unresolved.length ? { unresolved } : {}),
        as_at_caveat: AS_AT_CAVEAT,
        note: 'Facts from the statute book and the amendment register, not legal advice on their effect for the contract. applied=false marks a change that is law but not yet reflected in the published text.',
        attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
      });
    } catch (err) {
      logger.error('[uk_check_citations] failed', { err });
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'query_failed', message: 'The citation check failed; nothing was charged.' }) }], isError: true };
    }
  }

  /** Exact title (as the register prints it) or leg_id; otherwise the 3 closest titles. */
  private async resolve(cited: string): Promise<{ leg_id: string; title: string } | { suggestions: any[] }> {
    const asId = normaliseLegId(cited);
    if (asId) {
      const r = (await this.db.query('SELECT id, title FROM uk_legislation WHERE id = $1', [asId])).rows[0];
      if (r) return { leg_id: r.id, title: r.title };
    }
    const want = normTitle(cited);
    if (want) {
      const pattern = '%' + want.split(' ').join('%') + '%';
      const rows = (await this.db.query(
        // The exact title is the shortest one containing all the words in order.
        'SELECT id, title, leg_type FROM uk_legislation WHERE title ILIKE $1 ORDER BY length(title), id LIMIT 200', [pattern])).rows;
      const exact = rows.filter((r: any) => normTitle(r.title) === want);
      if (exact.length) {
        // The same title can exist as a UK and a Northern Ireland instrument; prefer UK-wide.
        const order = ['ukpga', 'uksi', 'asp', 'ssi', 'anaw', 'asc', 'wsi', 'nia', 'nisr'];
        exact.sort((x: any, y: any) => (order.indexOf(x.leg_type) + 99) % 99 - (order.indexOf(y.leg_type) + 99) % 99);
        return { leg_id: exact[0].id, title: exact[0].title };
      }
    }
    const sugg = (await this.db.query(
      `SELECT id, title, round(similarity(title, $1)::numeric, 2) AS similarity
         FROM uk_legislation WHERE title % $1 ORDER BY similarity(title, $1) DESC, id LIMIT 3`, [cited])).rows;
    return { suggestions: sugg.map((r: any) => ({ leg_id: r.id, title: r.title, similarity: Number(r.similarity) })) };
  }

  private async checkInstrument(
    p: { leg_id: string; title: string; cited_as: string[]; clauses: string[]; targets: ProvisionTarget[]; unreadable: string[] },
    asOf: string, compareTo: string,
  ) {
    const legId = p.leg_id;
    const meta = (await this.db.query(
      `SELECT l.title, COALESCE(s.versions, 0) AS versions, s.first_version::text AS first_version, s.last_version::text AS last_version
         FROM uk_legislation l LEFT JOIN uk_pit_load_state s ON s.leg_id = l.id WHERE l.id = $1`, [legId])).rows[0] ?? {};
    const title: string = meta.title ?? p.title;
    const hasHistory = Number(meta.versions) > 0;
    const base: any = {
      leg_id: legId,
      title,
      ...(p.cited_as.some((c) => normTitle(c) !== normTitle(title)) ? { cited_as: p.cited_as } : {}),
      ...(p.clauses.length ? { clauses: p.clauses } : {}),
      point_in_time: hasHistory,
      archive_to: day(meta.last_version),
      source: `https://www.legislation.gov.uk/${legId}`,
    };

    const effects = (await this.db.query(
      `SELECT affected_provisions, effect_type, affecting_id, affecting_title, affecting_provisions, in_force_date::text AS in_force_date, applied
         FROM uk_legislation_effects
        WHERE affected_id = $1 AND in_force_date IS NOT NULL AND in_force_date <= $2
        ORDER BY in_force_date LIMIT 20000`, [legId, compareTo])).rows
      .map((r: any) => ({ ...r, day: day(r.in_force_date), cls: classifyEffect(r.effect_type) }));
    const show = (e: any) => ({
      affected: e.affected_provisions, effect: e.effect_type, in_force: e.day, applied: e.applied,
      by: { leg_id: e.affecting_id, title: e.affecting_title, provisions: e.affecting_provisions },
    });

    // Revoked or repealed as a whole: the register title carries the note.
    if (/\((?:revoked|repealed)\b/i.test(title)) {
      const whole = effects.filter((e: any) => matchEffect(e.affected_provisions, { kind: 'section', number: '0' }) === 'whole_instrument'
        && /repeal|revok/i.test(e.effect_type || ''));
      const on = whole[0]?.day ?? day(meta.last_version);
      return {
        ...base,
        status: (on && on <= asOf ? 'revoked_before_signing' : 'revoked_since_signing') as CitationStatus,
        revoked_on: on,
        ...(whole.length ? { revoked_by: whole.slice(0, 3).map(show) } : { note: 'No dated revocation in the register; revoked_on is the last version the archive holds.' }),
        provisions: [],
      };
    }

    const since = effects.filter((e: any) => e.day > asOf && (e.cls === 'amendment' || e.cls === 'modification'));

    if (!p.targets.length) {
      const counts = new Map<string, { title: string; n: number; first: string; last: string }>();
      for (const e of since) {
        const k = e.affecting_id || e.affecting_title || '?';
        const c = counts.get(k) ?? { title: e.affecting_title, n: 0, first: e.day, last: e.day };
        c.n++; c.last = e.day;
        counts.set(k, c);
      }
      const amendments = since.filter((e: any) => e.cls === 'amendment').length;
      return {
        ...base,
        status: (amendments ? 'changed_since_signing' : since.length ? 'modified_since_signing' : 'unchanged') as CitationStatus,
        effects_since_signing: { amendments, modifications: since.length - amendments },
        ...(counts.size ? {
          by_instrument: [...counts.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 8)
            .map(([id, c]) => ({ leg_id: id, title: c.title, effects: c.n, first: c.first, last: c.last })),
        } : {}),
        ...(p.unreadable.length ? { unreadable_provisions: p.unreadable } : {}),
        provisions: [],
      };
    }

    // Version history for every cited provision in one query (texts fetched only where needed).
    const keys = p.targets.flatMap((t) => candidateKeys(legId, t));
    const hist = hasHistory ? (await this.db.query(
      `SELECT provision_key, valid_from::text AS valid_from, valid_to::text AS valid_to, encode(text_hash, 'hex') AS h
         FROM uk_provision_version WHERE leg_id = $1 AND provision_key = ANY($2) ORDER BY valid_from`,
      [legId, keys])).rows.map((r: any) => ({ ...r, from: day(r.valid_from), to: day(r.valid_to) })) : [];

    const at = (rows: any[], d: string) => rows.find((r) => r.from <= d && (r.to === null || r.to > d)) ?? null;
    const provisions = p.targets.map((t) => {
      const cands = candidateKeys(legId, t);
      const key = cands.find((k) => hist.some((r: any) => r.provision_key === k)) ?? cands[0];
      const rows = hist.filter((r: any) => r.provision_key === key);
      const mine = since.filter((e: any) => matchEffect(e.affected_provisions, t) === 'provision');
      const parts = since.filter((e: any) => matchEffect(e.affected_provisions, t) === 'part').length;
      const later = rows.filter((r: any) => r.from > asOf && r.from <= compareTo).map((r: any) => r.from);
      // Text on each date: only the interval that actually covers it. A provision whose last
      // interval closed before compare_to is gone from the text, not "as last seen".
      const then = at(rows, asOf), now = at(rows, compareTo);
      const removed = Boolean(then && !now && rows.length && rows[rows.length - 1].to !== null && rows[rows.length - 1].to <= compareTo);
      const repealed = mine.some((e: any) => /repeal|revok/i.test(e.effect_type || ''));
      const amended = mine.some((e: any) => e.cls === 'amendment');

      let status: CitationStatus;
      if (!rows.length && !hasHistory) status = repealed ? 'revoked_since_signing' : amended ? 'changed_since_signing' : mine.length ? 'modified_since_signing' : 'no_history';
      else if (!rows.length) status = repealed ? 'revoked_since_signing' : amended ? 'changed_since_signing' : mine.length ? 'modified_since_signing' : 'not_found';
      else if (rows[0].from > asOf) status = 'not_in_force_at_signing';
      else if (removed || repealed) status = 'revoked_since_signing';
      else if (later.length || amended) status = 'changed_since_signing';
      else if (mine.length) status = 'modified_since_signing';
      else status = 'unchanged';

      return {
        provision: label(t),
        status,
        ...(rows.length ? { provision_key: key } : {}),
        ...(later.length ? { versions_since_signing: later } : {}),
        ...(mine.length ? { effects: mine.slice(0, 10).map(show), ...(mine.length > 10 ? { more_effects: mine.length - 10 } : {}) } : {}),
        ...(parts ? { part_level_effects: parts } : {}),
        ...(status === 'not_in_force_at_signing' ? { earliest_version: rows[0].from } : {}),
        ...(removed ? { removed_on: rows[rows.length - 1].to } : {}),
        ...(status === 'not_found' ? { note: 'The act has version history but no such provision; check the number.' } : {}),
        ...(status === 'no_history' ? { note: 'No point-in-time text for this act; only the amendment register was checked, and it records nothing against this provision.' } : {}),
        _then: then?.h ?? null,
        _now: now?.h ?? null,
      };
    });

    // Old and new text, only where the text differs between the two dates (or is gone).
    const differs = (x: { _then: string | null; _now: string | null }) => Boolean(x._then && x._then !== x._now);
    const hashes = [...new Set(provisions.filter(differs).flatMap((x) => [x._then, x._now]).filter(Boolean) as string[])];
    const texts = new Map<string, string>();
    if (hashes.length) {
      const rows = (await this.db.query(
        `SELECT encode(text_hash, 'hex') AS h, text FROM uk_provision_text WHERE text_hash = ANY($1::bytea[])`,
        [hashes.map((h) => '\\x' + h)])).rows;
      for (const r of rows) texts.set(r.h, r.text);
    }
    const out = provisions.map(({ _then, _now, ...x }) =>
      differs({ _then, _now })
        ? { ...x, text_at_signing: cap(texts.get(_then!)), text_now: _now ? cap(texts.get(_now)) : null }
        : x);

    return {
      ...base,
      status: worst(out.map((x) => x.status)),
      ...(p.unreadable.length ? { unreadable_provisions: p.unreadable } : {}),
      provisions: out,
    };
  }
}
