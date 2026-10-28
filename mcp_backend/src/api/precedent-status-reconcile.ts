/**
 * Reconcile the check_precedent_status answer with the evidence it was built from
 * (LEXAI-2122).
 *
 * The shepardization result carries `affecting_decisions` — the higher-court decisions of
 * the case with the disposition read from each operative part. Two fields were derived
 * from that list by two different rules:
 *   - `status` from the single top entry (highest instance, latest date);
 *   - `overruled_by` / `distinguished_in` from EVERY entry with an overruling/modifying
 *     effect, wherever it sits in the chain.
 * So 922/989/18 came back `valid` (Grand Chamber 23.06.2020) together with
 * overruled_by [76542491, 76570168] — 2018 appeal rulings that quashed an interim ухвала,
 * not the decision the status talks about. The two fields contradicted each other.
 *
 * Semantics after this fix:
 *   - `status` is the FINAL disposition of the case: the decision(s) of the highest
 *     instance the case reached, on that instance's latest date (the "decisive group",
 *     exposed as `decided_by`). When the group holds several rulings of the same day, the
 *     most severe effect wins (overruled > remanded > modified > closed > upheld).
 *   - `overruled_by` / `distinguished_in` list only decisions of that same group, so a
 *     non-empty `overruled_by` always means `explicitly_overruled` and vice versa.
 *   - every other reversal/modification in the chain moves to `other_reversals`
 *     (what, by which instance, when) — other documents or stages of the case, listed
 *     for the reader but not driving the status.
 *   - `summary` says the same in Ukrainian for the reader.
 */

import { formatCourtDate } from './tool-utils.js';

export type AffectingEffect = 'upheld' | 'modified' | 'overruled' | 'remanded' | 'closed';

export interface AffectingDecisionLike {
  doc_id: string;
  instance: string;
  court: string;
  date?: string;
  outcome: string;
  effect: AffectingEffect | string;
}

export interface DecisionRef {
  doc_id: string;
  instance: string;
  court: string;
  date?: string;
  outcome: string;
  effect: string;
}

const EFFECT_SEVERITY: Record<string, number> = {
  overruled: 5,
  remanded: 4,
  modified: 3,
  closed: 2,
  upheld: 1,
};

const OVERRULING = new Set(['overruled', 'remanded']);
const LIMITING = new Set(['modified', 'closed']);

/** Instance rank, matching the shepardization hierarchy (ВП > касація > апеляція > перша). */
export function instanceLevel(instance?: string): number {
  const s = (instance || '').toLowerCase();
  if (s.includes('велика палата')) return 4;
  if (s.includes('касаці')) return 3;
  if (s.includes('апеляці')) return 2;
  if (s.includes('перша')) return 1;
  return 0;
}

export function statusForEffect(effect?: string): 'valid' | 'limited' | 'explicitly_overruled' | undefined {
  if (!effect) return undefined;
  if (OVERRULING.has(effect)) return 'explicitly_overruled';
  if (LIMITING.has(effect)) return 'limited';
  if (effect === 'upheld') return 'valid';
  return undefined;
}

function toRef(d: AffectingDecisionLike): DecisionRef {
  return {
    doc_id: String(d.doc_id),
    instance: d.instance,
    court: d.court,
    // Kyiv calendar date: the stored instant is Kyiv midnight, i.e. the previous UTC day.
    date: d.date ? formatCourtDate(d.date) || undefined : undefined,
    outcome: d.outcome,
    effect: d.effect,
  };
}

function describe(d: DecisionRef): string {
  const date = d.date ? d.date.split('-').reverse().join('.') : 'дата невідома';
  return `${d.instance}${d.court ? ` (${d.court})` : ''}, ${date}, doc ${d.doc_id} — ${d.outcome}`;
}

/**
 * Rewrite `status` (the CitationValidator result) so that status, overruled_by,
 * distinguished_in and the shepardization status all come from the same decisive group.
 * Returns the input untouched when there is no shepardization evidence to reconcile
 * (local citation_links fallback, unknown case).
 */
export function reconcilePrecedentStatus<T extends Record<string, any>>(status: T): T {
  const shep = status?.shepardization;
  const affecting: AffectingDecisionLike[] = Array.isArray(shep?.affecting_decisions)
    ? shep.affecting_decisions.filter((d: any) => d && d.doc_id != null && d.effect)
    : [];
  if (!shep || shep.check_source === 'local') return status;

  if (affecting.length === 0) {
    return {
      ...status,
      overruled_by: [],
      distinguished_in: [],
      decided_by: null,
      other_reversals: [],
      summary:
        status.status === 'valid'
          ? 'Рішень вищих інстанцій із визначеним результатом перегляду в ЄДРСР не знайдено — рішення діє в редакції, в якій ухвалене.'
          : 'Ланцюг інстанцій не дав визначеного результату перегляду — статус невідомий.',
    };
  }

  const refs = affecting.map((d) => ({ ref: toRef(d), level: instanceLevel(d.instance) }));
  const topLevel = Math.max(...refs.map((r) => r.level));
  const topDate = refs
    .filter((r) => r.level === topLevel)
    .reduce((max, r) => ((r.ref.date || '') > max ? r.ref.date || '' : max), '');
  const isDecisive = (r: { ref: DecisionRef; level: number }) =>
    r.level === topLevel && (r.ref.date || '') === topDate;

  const decisive = refs.filter(isDecisive).map((r) => r.ref);
  const strongest = decisive.reduce((a, b) =>
    (EFFECT_SEVERITY[b.effect] || 0) > (EFFECT_SEVERITY[a.effect] || 0) ? b : a
  );
  const derived = statusForEffect(strongest.effect) ?? status.status;

  const overruledBy = decisive.filter((d) => OVERRULING.has(d.effect)).map((d) => d.doc_id);
  const distinguishedIn = decisive.filter((d) => LIMITING.has(d.effect)).map((d) => d.doc_id);
  const earlier = refs
    .filter((r) => !isDecisive(r) && (OVERRULING.has(r.ref.effect) || LIMITING.has(r.ref.effect)))
    .map((r) => r.ref);

  const lines = [
    `Статус описує остаточний результат справи на найвищій інстанції, до якої вона дійшла: ${describe(strongest)}.`,
  ];
  if (earlier.length > 0) {
    lines.push(
      `Інші рішення у справі, якими скасовано чи змінено судові акти: ${earlier.map(describe).join('; ')}. Вони стосуються інших документів справи або іншого етапу розгляду і статус не визначають.`
    );
  }

  return {
    ...status,
    status: derived,
    overruled_by: overruledBy,
    distinguished_in: distinguishedIn,
    decided_by: strongest,
    other_reversals: earlier,
    summary: lines.join(' '),
    shepardization: { ...shep, status: derived },
  };
}
