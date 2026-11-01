/**
 * Court-decision sectioning and response budgeting, shared by get_court_decision and
 * load_full_texts (LEXAI-2175).
 *
 * Lives in utils/, not services/: CI overlays every services/*.ts from the private core repo,
 * and the SemanticSectionizer itself is one of those overlaid files.
 *
 * Why this layer exists — doc 90458880 (Велика Палата, 57K chars) came back from
 * get_court_decision {depth:5} as HEADER, CLAIMS, FACTS, PROCEDURAL_HISTORY ×2, the last one
 * cut at exactly 40,000 chars mid-word, with no DECISION:
 *
 *  1. The core sectionizer has no marker for Supreme Court reasoning headings
 *     («ПОЗИЦІЯ ВЕЛИКОЇ ПАЛАТИ ВЕРХОВНОГО СУДУ», «Висновки за результатами розгляду…»), so
 *     everything from «22. Рішенням …» to «Керуючись …» (46.7K) was one PROCEDURAL_HISTORY.
 *     Nor does it know collegial forms: «П О С Т А Н О В И Л А:» (spaced, feminine).
 *  2. It ends every section at start + 50,000 and drops the rest of the text on the floor.
 *  3. get_court_decision took `sections.slice(0, depth)` in document order, so the resolutive
 *     part — always last — was the first thing cut, and load_full_texts head-truncated its
 *     excerpt the same way.
 *
 * This module keeps the core sectionizer as the source of labels, re-slices the sections out
 * of the full text so they are contiguous and lossless, adds the missing headings, and fits
 * the result to a budget that reserves the resolutive part and drops middle sections first.
 */

import { SectionType } from '../types/index.js';
import type { DocumentSection } from '../types/index.js';

export interface CourtDecisionSection {
  type: SectionType;
  text: string;
  start: number;
  end: number;
}

export interface SectionizerLike {
  extractSections(text: string, useLLM?: boolean): Promise<DocumentSection[]>;
}

/** Item numbering before a heading: "65. ", "3) ", "12.1. ". */
const ITEM_NUMBER = /^\d+(?:\.\d+)*[.)]?\s*/u;

/** Longest line still treated as a heading rather than a body sentence. */
const MAX_HEADING_LINE = 160;

/**
 * Headings that open the court's own assessment in cassation / Grand Chamber rulings.
 * Matched against a whole (trimmed, de-numbered) line, case-insensitively.
 */
const EXTRA_HEADINGS: Array<{ type: SectionType; re: RegExp }> = [
  { type: SectionType.COURT_REASONING, re: /^(?:позиція|оцінка|висновки)\s+(?:великої\s+палати\s+)?верховного\s+суду/iu },
  { type: SectionType.COURT_REASONING, re: /^(?:позиція|висновки)\s+(?:колегії\s+суддів|суду\s+касаційної\s+інстанції|касаційного\s+(?:господарського|цивільного|адміністративного|кримінального)\s+суду)/iu },
  { type: SectionType.COURT_REASONING, re: /^мотиви,?\s+з\s+яких\s+виходить\s+(?:велика\s+палата\s+)?верховн/iu },
  { type: SectionType.COURT_REASONING, re: /^оцінка\s+(?:аргументів|доводів|висновків)/iu },
  { type: SectionType.COURT_REASONING, re: /^висновки\s+за\s+результатами\s+розгляду/iu },
  { type: SectionType.LAW_REFERENCES, re: /^джерела\s+права/iu },
];

/** Verbs that open the resolutive part, in every gender/number a bench uses. */
const RESOLUTIVE_VERBS = [
  'постановив', 'постановила', 'постановили',
  'ухвалив', 'ухвалила', 'ухвалили',
  'вирішив', 'вирішила', 'вирішили',
  'присудив', 'присудила', 'присудили',
];

/** «ПОСТАНОВИЛА:» or «П О С Т А Н О В И Л А:» alone on its line. */
const RESOLUTIVE_LINE = new RegExp(
  '^(?:' + RESOLUTIVE_VERBS.map((w) => Array.from(w).join('\\s*')).join('|') + ')\\s*[:.]?$',
  'iu',
);

/** «Керуючись статтями …» — the preamble that the resolutive part belongs with. */
const GUIDED_BY_LINE = /^керуючись\s/iu;

/** How far before the resolutive verb a «Керуючись …» preamble may start. */
const PREAMBLE_WINDOW = 3000;

/** Types that describe the case before the court's own assessment begins. */
const PRE_REASONING_TYPES = new Set<SectionType>([
  SectionType.HEADER,
  SectionType.FACTS,
  SectionType.CLAIMS,
  SectionType.PROCEDURAL_HISTORY,
]);

interface Boundary {
  pos: number;
  type: SectionType;
  extra: boolean;
}

interface Line {
  start: number;
  text: string;
}

function headingLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= MAX_HEADING_LINE) {
      // The boundary sits on the line break before the heading, as in the core sectionizer.
      lines.push({ start: start > 0 ? start - 1 : 0, text: trimmed.replace(ITEM_NUMBER, '') });
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

/**
 * Where the core sectionizer's section starts in `fullText`. Its indices refer to a
 * normalized copy of the text (spaced markers collapsed) and LLM-assisted sections carry
 * made-up indices, so trust start_index only when the text is really there.
 */
function locate(fullText: string, section: DocumentSection, from: number): number {
  const probe = section.text.slice(0, 60);
  if (!probe.trim()) return -1;
  if (Number.isInteger(section.start_index) && fullText.startsWith(probe, section.start_index)) {
    return section.start_index;
  }
  return fullText.indexOf(probe, from);
}

/**
 * Turn the core sectionizer's output into contiguous sections that cover `fullText` from the
 * first character to the last, with the resolutive part as a single trailing DECISION.
 * Returns [] when neither the sectionizer nor the extra headings find any structure, so
 * callers keep their unsectioned fallback.
 */
export function refineSections(fullText: string, coreSections: DocumentSection[]): CourtDecisionSection[] {
  if (!fullText) return [];

  const bounds: Boundary[] = [];

  const core = (Array.isArray(coreSections) ? coreSections : [])
    .filter((s) => s && typeof s.text === 'string' && s.type !== SectionType.AMOUNTS && s.type !== SectionType.HEADER)
    .sort((a, b) => (a.start_index ?? 0) - (b.start_index ?? 0));
  let cursor = 0;
  for (const s of core) {
    const pos = locate(fullText, s, cursor);
    if (pos < 0) continue;
    bounds.push({ pos, type: s.type, extra: false });
    cursor = pos + 1;
  }

  const lines = headingLines(fullText);
  const seenExtraTypes = new Set<RegExp>();
  for (const line of lines) {
    for (const h of EXTRA_HEADINGS) {
      if (h.re.test(line.text) && !seenExtraTypes.has(h.re)) {
        seenExtraTypes.add(h.re);
        bounds.push({ pos: line.start, type: h.type, extra: true });
        break;
      }
    }
  }

  // The resolutive part: the LAST line that is only «ПОСТАНОВИЛА:» etc. A ruling quotes the
  // lower courts' resolutive parts, but in running text — its own stands alone on a line and
  // comes last. Pull the «Керуючись …» preamble in with it.
  let decisionStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESOLUTIVE_LINE.test(lines[i].text)) {
      decisionStart = lines[i].start;
      for (let j = i - 1; j >= 0 && lines[j].start >= decisionStart - PREAMBLE_WINDOW; j--) {
        if (GUIDED_BY_LINE.test(lines[j].text)) {
          decisionStart = lines[j].start;
          break;
        }
      }
      break;
    }
  }
  if (decisionStart >= 0) {
    // A core DECISION boundary just before ours is the same preamble; prefer the earlier one.
    const nearby = bounds.find(
      (b) => b.type === SectionType.DECISION && b.pos < decisionStart && b.pos >= decisionStart - PREAMBLE_WINDOW,
    );
    if (nearby) decisionStart = nearby.pos;
    bounds.push({ pos: decisionStart, type: SectionType.DECISION, extra: true });
  }

  if (bounds.length === 0) return [];

  bounds.sort((a, b) => a.pos - b.pos || Number(b.extra) - Number(a.extra));

  // Two markers on the same heading: keep one, preferring the more specific extra marker.
  const deduped: Boundary[] = [];
  for (const b of bounds) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.pos - prev.pos < 20) {
      if (b.extra && !prev.extra) deduped[deduped.length - 1] = b;
      continue;
    }
    deduped.push(b);
  }

  // One resolutive part per decision. Once the court's assessment has started, case-history
  // markers inside it are quotes, not structure; and nothing after the resolutive start is
  // anything but the resolutive part (incl. signatures).
  const finalDecision = decisionStart >= 0 ? decisionStart : -1;
  let reasoningStarted = false;
  const kept: Boundary[] = [];
  for (const b of deduped) {
    if (finalDecision >= 0 && b.pos > finalDecision) continue;
    let type = b.type;
    if (finalDecision >= 0 && type === SectionType.DECISION && b.pos < finalDecision) {
      type = reasoningStarted ? SectionType.COURT_REASONING : SectionType.PROCEDURAL_HISTORY;
    }
    if (reasoningStarted && PRE_REASONING_TYPES.has(type)) continue;
    if (b.extra && (type === SectionType.COURT_REASONING || type === SectionType.LAW_REFERENCES)) {
      reasoningStarted = true;
    }
    kept.push({ ...b, type });
  }

  const raw: Array<{ type: SectionType; start: number; end: number }> = [];
  if (kept[0].pos > 0) raw.push({ type: SectionType.HEADER, start: 0, end: kept[0].pos });
  for (let i = 0; i < kept.length; i++) {
    const end = i + 1 < kept.length ? kept[i + 1].pos : fullText.length;
    if (end > kept[i].pos) raw.push({ type: kept[i].type, start: kept[i].pos, end });
  }

  // A sliver with no body (a bare heading line such as «Короткий зміст рішень судів
  // попередніх інстанцій» right before the next marker) belongs to the section it introduces.
  const SLIVER = 80;
  const merged: Array<{ type: SectionType; start: number; end: number }> = [];
  for (let i = 0; i < raw.length; i++) {
    const r = { ...raw[i] };
    const isSliver = r.type !== SectionType.DECISION && fullText.slice(r.start, r.end).trim().length < SLIVER;
    if (isSliver && i + 1 < raw.length) {
      raw[i + 1] = { ...raw[i + 1], start: r.start };
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && (prev.type === r.type || isSliver)) {
      prev.end = r.end;
      continue;
    }
    merged.push(r);
  }

  return merged.map((m) => ({ ...m, text: fullText.slice(m.start, m.end) }));
}

/** Sectionize with the core sectionizer, then refine. The one entry point both tools use. */
export async function sectionizeCourtDecision(
  sectionizer: SectionizerLike,
  fullText: string,
  useLLM = false,
): Promise<CourtDecisionSection[]> {
  if (!fullText) return [];
  const core = await sectionizer.extractSections(fullText, useLLM);
  return refineSections(fullText, Array.isArray(core) ? core : []);
}

// ---------------------------------------------------------------------------------------
// Budgeting
// ---------------------------------------------------------------------------------------

/**
 * Order in which non-resolutive sections claim the budget: the header (court, bench,
 * parties — short), then the court's assessment, then the case history. Head and tail are
 * kept; the "middle" of a decision is what gets dropped first.
 */
export const SECTION_PRIORITY: SectionType[] = [
  SectionType.HEADER,
  SectionType.COURT_REASONING,
  SectionType.MOTIVES,
  SectionType.LAW_REFERENCES,
  SectionType.CLAIMS,
  SectionType.FACTS,
  SectionType.PROCEDURAL_HISTORY,
];

/** Below this much remaining budget a section is listed as omitted rather than sliced thin. */
export const MIN_PARTIAL_CHARS = 1500;

/** Length of `text` cut at or before `limit` on a paragraph, else a word, boundary. */
export function cutAtBoundary(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  if (limit <= 0) return 0;
  const floor = Math.floor(limit * 0.6);
  const para = text.lastIndexOf('\n', limit);
  if (para >= floor && para > 0) return para;
  const space = text.lastIndexOf(' ', limit);
  if (space >= floor && space > 0) return space;
  return limit;
}

export interface ContinueCall {
  tool: 'get_court_decision';
  arguments: { doc_id: number | string; section: number; offset: number };
}

export function continueCall(docId: number | string, section: number, offset: number): ContinueCall {
  return { tool: 'get_court_decision', arguments: { doc_id: docId, section, offset } };
}

export function truncationMarker(docId: number | string, section: number, offset: number, total: number): string {
  return `\n\n[… ОБРІЗАНО: показано символи 0–${offset} з ${total} цієї секції. Продовження: get_court_decision {"doc_id": ${JSON.stringify(docId)}, "section": ${section}, "offset": ${offset}}]`;
}

export interface BudgetPlanEntry {
  index: number;
  /** Characters of the section returned from its start; equal to its length when whole. */
  take: number;
}

export interface BudgetPlan {
  returned: BudgetPlanEntry[];
  omitted: Array<{ index: number; reason: 'depth' | 'budget' }>;
}

/**
 * Choose which sections to return within `budget` characters.
 *
 * Every DECISION section is returned first and in full whenever it fits the budget at all;
 * then up to `maxOther` other eligible sections in SECTION_PRIORITY order, each whole if it
 * fits, sliced (at a boundary) if at least MIN_PARTIAL_CHARS remain, otherwise omitted.
 */
export function planSectionBudget(
  sections: Array<{ type: string; text: string }>,
  opts: { budget: number; maxOther?: number; eligible?: (type: string) => boolean },
): BudgetPlan {
  const eligible = opts.eligible ?? (() => true);
  const rank = (type: string) => {
    const r = SECTION_PRIORITY.indexOf(type as SectionType);
    return r === -1 ? SECTION_PRIORITY.length : r;
  };

  const decisions: number[] = [];
  const others: number[] = [];
  sections.forEach((s, i) => {
    if (s.type === SectionType.DECISION) decisions.push(i);
    else if (eligible(s.type)) others.push(i);
  });
  others.sort((a, b) => rank(sections[a].type) - rank(sections[b].type) || a - b);

  const maxOther = opts.maxOther ?? Infinity;
  const returned: BudgetPlanEntry[] = [];
  const omitted: BudgetPlan['omitted'] = [];
  let remaining = Math.max(0, opts.budget);

  for (const i of decisions) {
    const len = sections[i].text.length;
    const take = len <= remaining ? len : cutAtBoundary(sections[i].text, remaining);
    if (take <= 0) {
      omitted.push({ index: i, reason: 'budget' });
      continue;
    }
    returned.push({ index: i, take });
    remaining -= take;
  }

  others.forEach((i, n) => {
    if (n >= maxOther) {
      omitted.push({ index: i, reason: 'depth' });
      return;
    }
    const len = sections[i].text.length;
    if (len <= remaining) {
      returned.push({ index: i, take: len });
      remaining -= len;
    } else if (remaining >= MIN_PARTIAL_CHARS) {
      const take = cutAtBoundary(sections[i].text, remaining);
      returned.push({ index: i, take });
      remaining -= take;
    } else {
      omitted.push({ index: i, reason: 'budget' });
    }
  });

  returned.sort((a, b) => a.index - b.index);
  omitted.sort((a, b) => a.index - b.index);
  return { returned, omitted };
}
