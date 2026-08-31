/**
 * Tool Utilities - Shared helper functions for MCP tool handlers
 *
 * Extracted from MCPQueryAPI to enable reuse across domain tool handlers.
 * Pure functions have no dependencies; impure functions accept dependencies as parameters.
 */

import { SectionType } from '../types/index.js';
import { PROCEDURE_TO_JUSTICE_KIND } from '@secondlayer/shared';
import type { EdsrFtsService, EdsrFtsFilters } from '../services/edrsr-fts-service.js';
import { logger } from '../utils/logger.js';
import axios from 'axios';

// ========================= Pure Functions =========================

const KYIV_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Render an EDRSR date as the calendar date the court actually stamped on the act.
 *
 * `adjudication_date` is a timestamptz holding Kyiv midnight, so a decision of
 * 23.04.2026 is the instant 2026-04-22T21:00:00Z. Serialised straight to JSON it
 * reaches the model as that UTC string, and every consumer reading the UTC
 * calendar day is one day early — a report on 907/665/18 dated all six cited
 * decisions to the day before the documents themselves (2026-08-13).
 *
 * Emitting `YYYY-MM-DD` in Kyiv removes the ambiguity instead of moving it:
 * there is no time-of-day left to reinterpret downstream. Values that are
 * already date-only pass through untouched, and anything unparseable is left
 * exactly as it came rather than silently becoming a wrong date.
 */
export function formatCourtDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : KYIV_DATE.format(value);
  }
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : KYIV_DATE.format(parsed);
}

/**
 * Parse JSON from LLM response, stripping markdown fences if present.
 * Handles: ```json {...} ```, ```{...}```, or raw JSON.
 */
export function parseLLMJson<T = any>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;

  let cleaned = text.trim();

  // Strip markdown code fences anywhere in text (not just anchored to start/end).
  // Handles: ```json\n{...}\n```, ```\n{...}\n```, and fences with surrounding text.
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract first JSON object/array
    const jsonMatch = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // give up
      }
    }
  }

  return fallback;
}

/**
 * Extract source strings from mixed sources array (strings, objects with id/url/title).
 */
export function extractSourceStrings(sources: any): string[] {
  if (!Array.isArray(sources)) return [];
  const out: string[] = [];
  for (const s of sources) {
    if (!s) continue;
    if (typeof s === 'string') {
      out.push(s);
      continue;
    }
    if (typeof s === 'object') {
      if (typeof s.id === 'string') out.push(s.id);
      if (typeof s.source_id === 'string') out.push(s.source_id);
      if (typeof s.url === 'string') out.push(s.url);
      if (typeof s.title === 'string') out.push(s.title);
    }
  }
  return Array.from(new Set(out.filter((x) => String(x).trim().length > 0)));
}

/**
 * Extract case number from Ukrainian court decision text.
 */
export function extractCaseNumberFromText(text: string): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = t.match(/Справа\s*№\s*([0-9A-Za-zА-Яа-яІіЇїЄє\/-]+)/i);
  if (m && m[1]) return m[1].trim();
  const m2 = t.match(/у\s*справ[іи]\s*№\s*([0-9A-Za-zА-Яа-яІіЇїЄє\/-]+)/i);
  if (m2 && m2[1]) return m2[1].trim();
  return null;
}

/**
 * Parse time_range parameter into date_from/date_to strings.
 */
export function parseTimeRangeToDates(timeRange: any): { date_from?: string; date_to?: string; warning?: string } {
  if (!timeRange) return {};
  if (typeof timeRange === 'object' && (timeRange.from || timeRange.to)) {
    const from = typeof timeRange.from === 'string' ? timeRange.from.slice(0, 10) : undefined;
    const to = typeof timeRange.to === 'string' ? timeRange.to.slice(0, 10) : undefined;
    return { date_from: from, date_to: to };
  }
  if (typeof timeRange === 'string') {
    const s = timeRange.trim().toLowerCase();
    const m = s.match(/last\s+(\d+)\s+years?/);
    if (m) {
      const years = Math.max(0, Number(m[1]));
      const d = new Date();
      d.setFullYear(d.getFullYear() - years);
      return { date_from: d.toISOString().slice(0, 10) };
    }
    const m2 = s.match(/last\s+(\d+)\s+months?/);
    if (m2) {
      const months = Math.max(0, Number(m2[1]));
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      return { date_from: d.toISOString().slice(0, 10) };
    }
    return { warning: 'Unsupported time_range string format. Use {from,to} or "last N years".' };
  }
  return { warning: 'Unsupported time_range format. Use {from,to} or "last N years".' };
}

/**
 * Map procedure code string to normalized short form.
 */
export function mapProcedureCodeToShort(code: any): 'cpc' | 'gpc' | 'cac' | 'crpc' | null {
  const v = String(code || '').trim().toLowerCase();
  if (v === 'cpc') return 'cpc';
  if (v === 'gpc' || v === 'epc') return 'gpc';
  if (v === 'cac') return 'cac';
  if (v === 'crpc') return 'crpc';
  return null;
}

/**
 * Add days to a YYYY-MM-DD date string.
 */
export function addDaysYMD(ymd: string, days: number): string {
  const d = new Date(ymd);
  if (Number.isNaN(d.getTime())) {
    throw new Error('event_date must be a valid date string (YYYY-MM-DD)');
  }
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract text snippets around query matches in a full text.
 */
export function extractSnippets(fullText: string, query: string, limit: number): string[] {
  const q = query.trim();
  if (!fullText || !q) return [];

  const hay = fullText;
  const needle = q.toLowerCase();
  const lower = hay.toLowerCase();

  const snippets: string[] = [];
  let fromIndex = 0;
  const window = 320;
  while (snippets.length < limit) {
    const idx = lower.indexOf(needle, fromIndex);
    if (idx < 0) break;

    const start = Math.max(0, idx - Math.floor(window / 2));
    const end = Math.min(hay.length, idx + needle.length + Math.floor(window / 2));
    const raw = hay.slice(start, end).replace(/\s+/g, ' ').trim();
    const prefix = start > 0 ? '…' : '';
    const suffix = end < hay.length ? '…' : '';
    snippets.push(`${prefix}${raw}${suffix}`);
    fromIndex = idx + needle.length;
  }
  return snippets;
}

/**
 * Suffixes that actually occur in EDRSR `cause_num`, taken from a 3% sample of
 * edrsr_case_index rather than guessed. The four procedural ones carry 99.9% of the
 * volume — ц 112,049 / к 64,556 / п 61,022 / а 17,155 — and the rest is a long thin tail
 * (С 748, г 561, Е 360, А 334, Ц 65, НМ 51, Б 45, ад 42, К 20, НА 20, б 17, АП 16, Д 10,
 * НР 6, Н 3, н 3) that mostly belongs to older commercial and bankruptcy numbering.
 *
 * The tail is included because each entry costs one extra equality probe on a primary-key
 * index and nothing else. Anything outside the set simply fails to resolve, and the caller
 * keeps whatever it did before — this is a lookup shortcut, not a validation rule.
 */
const CAUSE_NUM_SUFFIXES = [
  'ц', 'к', 'п', 'а',
  'Ц', 'К', 'П', 'А',
  'С', 'с', 'г', 'Г', 'е', 'Е', 'Б', 'б', 'Д', 'д', 'Н', 'н',
  'НМ', 'НА', 'НР', 'АП', 'ад',
];

const HAS_SUFFIX_RE = /-[а-яіїєґА-ЯІЇЄҐ]+$/;

/**
 * A procedural suffix the caller typed, captured in group 1.
 *
 * Broader than HAS_SUFFIX_RE in one direction: candidate generation only ever produces
 * Cyrillic suffixes, but the guard against swapping one has to recognise a suffix we would
 * never generate — a Latin or otherwise unmeasured tail is still the caller saying which
 * case they mean.
 *
 * Anchored to the modern digits/digits/year shape in the other direction, because a bare
 * trailing "-token" is not always a suffix. Pre-2017 Supreme Court numbers put a hyphen in
 * the middle of the identifier itself: "5-15кс12" would otherwise read as suffix "-15кс12"
 * and then fail to match its own canonical spelling "5-15/12", which carries no suffix at
 * all — so the guard would have blocked exactly the rewrite the VSU branch of
 * generateCaseNumberVariations exists to perform.
 */
const ASKED_SUFFIX_RE = /^\d+\/\d+\/\d{2,4}(-[^/\s-]*[A-Za-zА-Яа-яІіЇїЄєҐґ][^/\s-]*)$/;

/**
 * Case-number spellings worth probing against the corpus — the variations above, plus a
 * suffixed form of every unsuffixed one.
 *
 * generateCaseNumberVariations is deliberately asymmetric: it STRIPS a suffix but never
 * adds one, so "369/6892/15-ц" degrades to "369/6892/15" while the reverse never happens.
 * That is the direction that breaks in practice, because the chat model drops the suffix
 * on its way to the tool and the bare number matches nothing.
 *
 * These are candidates, not answers. Roughly 1 base number in 700 carries two different
 * suffixes (364 of 263,565 distinct bases in the same sample), and those are genuinely
 * different cases — which is why resolveCauseNumber looks them up rather than passing the
 * whole list to a `cause_num = ANY(...)` filter, where two unrelated cases would silently
 * merge into one instance chain.
 */
export function generateCaseNumberCandidates(caseNumber: string): string[] {
  const candidates = new Set<string>();
  for (const variant of generateCaseNumberVariations(caseNumber)) {
    candidates.add(variant);
    if (!HAS_SUFFIX_RE.test(variant)) {
      for (const suffix of CAUSE_NUM_SUFFIXES) candidates.add(`${variant}-${suffix}`);
    }
  }
  return Array.from(candidates);
}

/**
 * Pool holding the EDRSR corpus tables (edrsr_documents / edrsr_fulltext / edrsr_case_index).
 *
 * When EDRSR_DATABASE_URL is set the corpus lives in its own database and EdsrFtsService
 * opens a dedicated pool for it; otherwise it is co-located with the application data and
 * the caller's own pool is right. Shared rather than copied per tool class, so the rule has
 * one home and cannot drift between the tools that read the corpus.
 */
export function edrsrPool(ftsService: { getDedicatedPool(): any } | undefined, fallback: any): any {
  return ftsService?.getDedicatedPool() ?? fallback;
}

export interface CauseNumberResolution {
  /** The spelling to query with, or null when nothing matched or the input is ambiguous. */
  resolved: string | null;
  /** Every candidate that exists in the corpus, most documents first. */
  matches: Array<{ cause_num: string; member_count: number }>;
  /** True when several distinct cases share the base number — the caller must not guess. */
  ambiguous: boolean;
}

/**
 * Resolve a user- or model-supplied case number to the spelling EDRSR actually uses.
 *
 * Looks the candidates up by equality against `edrsr_case_index` (cause_num is its primary
 * key, so this is a handful of btree probes — 1.7ms measured on prod for 12 candidates).
 * Equality rather than `LIKE 'base%'` on purpose: the database collation is en_US.utf8, so
 * a prefix LIKE cannot use that index and seq-scans instead (5.2s measured), and a
 * collation-ordered range would depend on how glibc sorts punctuation.
 *
 * An exact hit on the caller's own spelling always wins — they may have been specific.
 * Otherwise a single surviving candidate is the answer. Several means the base number maps
 * to more than one real case, and the resolution stays null so nothing is silently merged.
 *
 * Fail-safe: any error (or no pool) resolves to null with no matches, leaving the caller on
 * whatever it did before.
 */
export async function resolveCauseNumber(caseNumber: string, dbPool: any): Promise<CauseNumberResolution> {
  const empty: CauseNumberResolution = { resolved: null, matches: [], ambiguous: false };
  const input = String(caseNumber || '').trim();
  if (!input || !dbPool?.query) return empty;

  try {
    const { rows } = await dbPool.query(
      `SELECT cause_num, COALESCE(member_count, 0)::int AS member_count
         FROM edrsr_case_index
        WHERE cause_num = ANY($1::text[])
        ORDER BY member_count DESC NULLS LAST`,
      [generateCaseNumberCandidates(input)],
    );
    const all = rows.map((r: any) => ({ cause_num: r.cause_num as string, member_count: Number(r.member_count) }));

    // A suffix the caller typed is a statement about WHICH case they mean, so it may be
    // completed but never swapped. Without this, "905/1234/20-XYZ" (a suffix outside the
    // measured set, hence not in the corpus) would strip down to "905/1234/20", pick up the
    // measured suffixes as candidates, and resolve to 905/1234/20-ц — a different real case
    // answered as if it were the one asked about. Year expansion still works, because an
    // expanded variant keeps the same suffix.
    const askedSuffix = input.match(ASKED_SUFFIX_RE)?.[1] ?? null;
    const matches = askedSuffix
      ? all.filter((m: { cause_num: string }) => (m.cause_num.match(ASKED_SUFFIX_RE)?.[1] ?? null) === askedSuffix)
      : all;

    if (matches.length === 0) return empty;
    if (matches.some((m: { cause_num: string }) => m.cause_num === input)) {
      return { resolved: input, matches, ambiguous: false };
    }
    if (matches.length === 1) return { resolved: matches[0].cause_num, matches, ambiguous: false };
    return { resolved: null, matches, ambiguous: true };
  } catch (error: any) {
    logger.warn('[tool-utils] resolveCauseNumber failed; keeping the caller-supplied number', {
      caseNumber: input,
      error: error?.message,
    });
    return empty;
  }
}

/**
 * Generate case number variations (short/long year, with/without suffix).
 */
export function generateCaseNumberVariations(caseNumber: string): string[] {
  const variations = new Set<string>();
  variations.add(caseNumber);

  // Standard format: 123/456/22-ц. The suffix group is `+`, not a single character: the
  // corpus carries multi-letter ones too (ад, НМ, НА, НР, АП — see CAUSE_NUM_SUFFIXES), and
  // with a single-character group the whole regex missed them, so those numbers got no
  // year expansion at all.
  const match = caseNumber.match(/^(\d+\/\d+\/)(\d{2,4})(-[а-яіїєґА-ЯІЇЄҐ]+)?$/);
  if (match) {
    const prefix = match[1];
    const year = match[2];
    const suffix = match[3] || '';

    const [shortYear, longYear] = expandYear(year);

    variations.add(`${prefix}${shortYear}${suffix}`);
    variations.add(`${prefix}${longYear}${suffix}`);

    if (suffix) {
      variations.add(`${prefix}${shortYear}`);
      variations.add(`${prefix}${longYear}`);
    }
  }

  // Pre-2017 VSU format: 5-15кс12 → also try 5-15/12, 5-15/2012
  const vsuMatch = caseNumber.match(/^(\d+-\d+)[а-яіїєґА-ЯІЇЄҐ]+(\d{2,4})$/);
  if (vsuMatch) {
    const numPart = vsuMatch[1];
    const year = vsuMatch[2];
    const [shortYear, longYear] = expandYear(year);

    variations.add(`${numPart}/${shortYear}`);
    variations.add(`${numPart}/${longYear}`);
  }

  return Array.from(variations);
}

function expandYear(year: string): [string, string] {
  if (year.length === 2) {
    const yearNum = parseInt(year, 10);
    return [year, yearNum < 50 ? `20${year}` : `19${year}`];
  }
  if (year.length === 4) {
    return [year.slice(-2), year];
  }
  return [year, year];
}

/**
 * Translate OpenReyestr entity type code to Ukrainian label.
 */
export function translateEntityType(type: string): string {
  const map: Record<string, string> = {
    'UO': 'Юридична особа',
    'FOP': 'Фізична особа-підприємець',
    'FSU': 'Громадське формування',
  };
  return map[type] || type;
}

/**
 * Format business entities response for display.
 */
export function formatBusinessEntitiesResponse(data: any, args: any): string {
  const entities = Array.isArray(data) ? data : [];

  let text = `# Результати пошуку суб'єктів господарювання\n\n`;
  text += `**Запит:** ${args.query || args.edrpou || 'всі'}\n`;
  text += `**Знайдено:** ${entities.length}\n\n`;

  entities.forEach((entity: any, idx: number) => {
    text += `## ${idx + 1}. ${entity.name || entity.short_name}\n\n`;
    text += `- **ЄДРПОУ:** ${entity.edrpou || 'н/д'}\n`;
    text += `- **Номер запису:** ${entity.record}\n`;
    text += `- **Тип:** ${translateEntityType(entity.entity_type)}\n`;
    text += `- **Статус:** ${entity.stan || 'н/д'}\n`;
    if (entity.opf) text += `- **ОПФ:** ${entity.opf}\n`;
    text += `\n`;
  });

  return text;
}

/**
 * Build Supreme Court search hints string based on intent.
 *
 * NOTE: ZakonOnline sph04 search mode treats all terms as AND conditions.
 * Appending chamber names (КЦС, КГС, etc.) to the search text causes 0 results
 * because documents rarely contain ALL chamber names simultaneously.
 * Use `buildSupremeCourtWhereFilter()` for API-level court filtering instead.
 */
export function buildSupremeCourtHints(_intent?: any): string {
  // Disabled: text-based hints break sph04 AND-mode search.
  // SC filtering now uses where[instance_code] API filter.
  return '';
}

/**
 * Map procedure code to ZakonOnline justice_kind filter value.
 * justice_kind: 1=цивільне, 2=кримінальне, 3=господарське, 4=адміністративне
 */
export function mapProcedureCodeToJusticeKind(code: string | null): number | null {
  // Mapping data is single-sourced in @secondlayer/shared (PROCEDURE_TO_JUSTICE_KIND):
  // cpc→1 (цивільне), crpc→2 (кримінальне), gpc→3 (господарське), cac→4 (адміністративне).
  if (!code) return null;
  return (PROCEDURE_TO_JUSTICE_KIND as Record<string, number>)[code] ?? null;
}

/**
 * Build where-filter conditions for court instance filtering.
 * instance_code: 1=cassation (ВС), 2=appellate, 3=first instance
 */
export function buildSupremeCourtWhereFilter(courtLevel: string): any[] {
  if (courtLevel === 'SC' || courtLevel === 'GrandChamber') {
    return [{ field: 'instance_code', operator: '=', value: 1 }];
  }
  if (courtLevel === 'AC') {
    return [{ field: 'instance_code', operator: '=', value: 2 }];
  }
  if (courtLevel === 'FC') {
    return [{ field: 'instance_code', operator: '=', value: 3 }];
  }
  return [];
}

/** Court instance cascade order: SC → appellate → first instance */
const INSTANCE_CASCADE = [
  { level: 'SC', code: 1, label: 'Верховний Суд' },
  { level: 'AC', code: 2, label: 'апеляційні суди' },
  { level: 'FC', code: 3, label: 'суди першої інстанції' },
] as const;

/**
 * Cascading court search: try SC first, if empty — appellate, if empty — first instance.
 * Returns results + which instance level actually matched.
 */
export async function searchWithInstanceCascade(
  searchFn: (whereFilters: any[]) => Promise<{ data: any[] }>,
  baseWhereFilters: any[],
): Promise<{ data: any[]; instanceLevel: string; instanceLabel: string }> {
  for (const inst of INSTANCE_CASCADE) {
    const filters = [
      ...baseWhereFilters,
      { field: 'instance_code', operator: '=', value: inst.code },
    ];
    const result = await searchFn(filters);
    if (result.data.length > 0) {
      return { data: result.data, instanceLevel: inst.level, instanceLabel: inst.label };
    }
  }
  return { data: [], instanceLevel: 'none', instanceLabel: '' };
}

/**
 * Pick section types for answer based on intent classification.
 */
export function pickSectionTypesForAnswer(intent: any): SectionType[] {
  const focus = intent?.slots?.section_focus;
  if (Array.isArray(focus) && focus.length > 0) {
    return focus as SectionType[];
  }
  if (Array.isArray(intent?.sections) && intent.sections.length > 0) {
    return intent.sections as SectionType[];
  }
  return [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
}

/**
 * Safely parse JSON from a tool result's content[0].text.
 */
export function safeParseJsonFromToolResult(result: any): any {
  try {
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse OpenReyestr response to extract data from result.content[0].text.
 */
export function parseOpenReyestrResponse(response: any): any {
  try {
    const text = response?.result?.content?.[0]?.text;
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ========================= Functions with Dependencies =========================

/**
 * Call a RADA MCP tool via HTTP API.
 */
export async function callRadaTool(toolName: string, args: any): Promise<any> {
  const baseUrl = String(process.env.RADA_MCP_URL || '').trim();
  const apiKey = String(process.env.RADA_API_KEY || '').trim();

  if (!baseUrl) {
    throw new Error('RADA_MCP_URL is not configured');
  }
  if (!apiKey) {
    throw new Error('RADA_API_KEY is not configured');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/tools/${encodeURIComponent(toolName)}`;

  const resp = await axios.post(
    url,
    { arguments: args },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  return resp.data;
}

/**
 * Call an OpenReyestr MCP tool via HTTP API.
 */
export async function callOpenReyestrTool(toolName: string, args: any): Promise<any> {
  const baseUrl = String(process.env.OPENREYESTR_MCP_URL || '').trim();
  const apiKey = String(process.env.OPENREYESTR_API_KEY || '').trim();

  if (!baseUrl) {
    throw new Error('OPENREYESTR_MCP_URL is not configured');
  }
  if (!apiKey) {
    throw new Error('OPENREYESTR_API_KEY is not configured');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/tools/${encodeURIComponent(toolName)}`;

  const resp = await axios.post(
    url,
    { arguments: args },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  return resp.data;
}

/**
 * Count results for a query via EDRSR FTS. Returns the FTS total estimate (the service
 * caps the exact count for speed) plus the first page for right-panel display. Replaces
 * the old ZakonOnline pagination loop, which routed through a now-deleted dead stub.
 */
export async function countAllResults(
  ftsService: EdsrFtsService,
  db: any,
  query: string,
  filters: EdsrFtsFilters = {}
): Promise<{
  total_count: number;
  pages_fetched: number;
  time_taken_ms: number;
  cost_estimate_usd: number;
  first_results: any[];
}> {
  const startTime = Date.now();
  const resp = await ftsService.searchFulltext(query, db, filters, 50, 0);
  const firstResults = resp.results.map((r) => ({
    doc_id: r.doc_id,
    cause_num: r.cause_num,
    judge: r.judge,
    court_code: r.court_code,
    adjudication_date: formatCourtDate(r.adjudication_date),
    url: `https://reyestr.court.gov.ua/Review/${r.doc_id}`,
  }));

  return {
    total_count: resp.total,
    pages_fetched: 1,
    time_taken_ms: Date.now() - startTime,
    cost_estimate_usd: 0,
    first_results: firstResults,
  };
}
