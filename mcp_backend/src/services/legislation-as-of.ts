/**
 * One rule for `as_of_date` across the legislation tools (LEXAI-2146).
 *
 * get_legislation_section {rada_id:'435-15', article_number:'625',
 * as_of_date:'2001-01-01'} returned today's ЦК text flagged is_historical:true,
 * although ЦК's first edition is 16.01.2003. Cause: the current-scrape rows of
 * legislation_articles carry a placeholder version_date of 2000-01-01
 * (rada-legislation-adapter stamps `new Date('2000-01-01T00:00:00Z')` when the
 * scrape knows no edition date; stored as 2000-01-01 02:00 Kyiv time). The
 * temporal lookup `version_date <= as_of_date` therefore matched the current
 * text for every date after 2000 that had no real edition row — dates before
 * the act existed, and dates before an article was inserted.
 *
 * The rule, applied by get_legislation_section, get_legislation_articles and
 * get_npa_act:
 *   - before the act's first edition       → error, no text;
 *   - in the future (after today, Kyiv)    → current text + note;
 *   - on/after the latest known edition    → current text (it IS the edition in force);
 *   - otherwise                            → the edition in force on that date, or an
 *     explanation (article not yet inserted / edition not in the database), never
 *     the current text dressed up as historical.
 *
 * Act dates: the earliest of npa.act.first_ed, legislation.adoption_date and the
 * first legislation_editions row (they agree on prod; LEAST tolerates NULLs).
 * Entry into force is not stored anywhere today (legislation.effective_date is
 * NULL in all rows); it is reported when present.
 */

import { isoToDmy } from './legislation-act-status.js';

export interface ActTimeline {
  /** ISO date of the act's first edition (adoption/publication). */
  first_edition?: string | null;
  /** ISO date the act entered into force, when known. */
  effective_date?: string | null;
  /** ISO date of the latest edition known for the act. */
  last_edition?: string | null;
}

export type AsOfVerdict =
  /** No date given: serve the current text. */
  | { kind: 'current' }
  | { kind: 'invalid'; error: string }
  /** The act did not exist yet: no text. */
  | { kind: 'before_act'; error: string; first_edition: string; effective_date?: string }
  /**
   * Serve the current text. `note` explains why (future date, or the date is on/after
   * the latest edition). `as_of_date` is kept for the response metadata.
   */
  | { kind: 'use_current'; as_of_date: string; note?: string }
  /** Look up the edition in force on `as_of_date`. `note` carries an optional caveat. */
  | { kind: 'historical'; as_of_date: string; note?: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's date in Kyiv, ISO. */
export function kyivToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** A calendar-valid YYYY-MM-DD, or null. */
export function parseIsoDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return s;
}

/**
 * npa.act.first_ed carries 1990-01-01 as a placeholder for three acts (995_*), not a
 * real date — migrations 187/188 exclude it the same way (npa.act_canon).
 */
export const NPA_FIRST_ED_PLACEHOLDER = '1990-01-01';

/** npa.act.first_ed with the 1990-01-01 placeholder dropped. */
export function npaFirstEdition(d: string | null | undefined): string | null {
  const v = iso(d);
  return v && v !== NPA_FIRST_ED_PLACEHOLDER ? v : null;
}

function iso(d: string | null | undefined): string | undefined {
  if (!d) return undefined;
  return String(d).slice(0, 10);
}

export function beforeActMessage(asOf: string, firstEdition: string, effectiveDate?: string): string {
  const inForce = effectiveDate ? `, набрав чинності ${isoToDmy(effectiveDate)}` : '';
  return `Акт ще не діяв на ${isoToDmy(asOf)} (перша редакція від ${isoToDmy(firstEdition)}${inForce}). Тексту станом на цю дату не існує.`;
}

/**
 * Decide what an `as_of_date` means for one act. Pure: the caller loads the
 * timeline. A missing timeline (act unknown to both tables) is not a reason to
 * refuse; the lookup then decides.
 */
export function classifyAsOfDate(
  asOfRaw: unknown,
  timeline: ActTimeline | null | undefined,
  today: string = kyivToday(),
): AsOfVerdict {
  if (asOfRaw === undefined || asOfRaw === null || String(asOfRaw).trim() === '') return { kind: 'current' };
  const asOf = parseIsoDate(asOfRaw);
  if (!asOf) return { kind: 'invalid', error: 'as_of_date має бути датою у форматі YYYY-MM-DD.' };

  const first = iso(timeline?.first_edition);
  const effective = iso(timeline?.effective_date);
  const last = iso(timeline?.last_edition);

  if (first && asOf < first) {
    return { kind: 'before_act', error: beforeActMessage(asOf, first, effective), first_edition: first, ...(effective ? { effective_date: effective } : {}) };
  }
  if (asOf > today) {
    return {
      kind: 'use_current',
      as_of_date: asOf,
      note: `Дата ${isoToDmy(asOf)} ще не настала — показано чинну редакцію станом на ${isoToDmy(today)}. Майбутні зміни, які ще не набрали чинності, не враховано.`,
    };
  }
  if (last && asOf >= last) {
    return {
      kind: 'use_current',
      as_of_date: asOf,
      note: `Остання редакція акта — від ${isoToDmy(last)}, тож на ${isoToDmy(asOf)} діє чинна редакція.`,
    };
  }
  if (effective && asOf < effective) {
    return {
      kind: 'historical',
      as_of_date: asOf,
      note: `Акт прийнято, але станом на ${isoToDmy(asOf)} він ще не набрав чинності (набрав чинності ${isoToDmy(effective)}).`,
    };
  }
  return { kind: 'historical', as_of_date: asOf };
}

/**
 * SQL predicate (alias `la`) that is true for a legislation_articles row whose
 * version_date is the 2000-01-01 placeholder rather than a real edition date.
 * 02:00 is the JS-UTC stamp read back in Kyiv time and is always a placeholder;
 * a midnight 2000-01-01 row is real only if the act has an edition on that day.
 */
export const PLACEHOLDER_VERSION_SQL = `(la.version_date = TIMESTAMP '2000-01-01 02:00:00'
  OR (la.version_date = TIMESTAMP '2000-01-01 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM legislation_editions le_ph
                       WHERE le_ph.legislation_id = la.legislation_id
                         AND le_ph.edition_date = DATE '2000-01-01')))`;

export interface ArticleMissFacts {
  /** ISO date of the earliest real (dated) row of this article, if any. */
  article_first_seen?: string | null;
  /** True when the article exists in the current text. */
  in_current_text: boolean;
  /** ISO date of the latest loaded edition (with articles) on or before as_of_date. */
  edition_on_date?: string | null;
  /** ISO date of the earliest loaded edition, any. */
  earliest_loaded_edition?: string | null;
}

/**
 * Explain why there is no text of an article on `asOf` although the act existed.
 * Returns null when the article is simply unknown (the caller's plain «not found»).
 */
export function articleMissMessage(articleNumber: string, asOf: string, f: ArticleMissFacts): string | null {
  const firstSeen = iso(f.article_first_seen);
  const onDate = iso(f.edition_on_date);
  if (!firstSeen && !f.in_current_text) return null;

  if (onDate && firstSeen && firstSeen <= asOf) {
    // The article existed before this date but is absent from the edition in force
    // on it (excluded, then restored; or a gap in that edition's import).
    return `Стаття ${articleNumber} існувала раніше (вперше — у редакції від ${isoToDmy(firstSeen)}), але в редакції від ${isoToDmy(onDate)}, чинній на ${isoToDmy(asOf)}, її немає. Перевірте редакцію на zakon.rada.gov.ua.`;
  }
  if (onDate) {
    const appears = firstSeen
      ? `вперше з'являється в редакції від ${isoToDmy(firstSeen)}`
      : `є лише в чинній редакції`;
    const indexedCaveat = /-/.test(articleNumber)
      ? ' Статті з індексом (напр. 350-1) у частині старих редакцій не завантажені — за потреби перевірте редакцію на zakon.rada.gov.ua.'
      : '';
    return `Стаття ${articleNumber} ще не існувала станом на ${isoToDmy(asOf)}: у редакції від ${isoToDmy(onDate)}, чинній на цю дату, її немає; ${appears}.${indexedCaveat}`;
  }
  const earliest = iso(f.earliest_loaded_edition);
  return earliest
    ? `Редакції акта, чинної на ${isoToDmy(asOf)}, у базі немає (найраніша завантажена — від ${isoToDmy(earliest)}). Перелік доступних дат — list_legislation_editions.`
    : `Історичні редакції цього акта ще не завантажені — текст станом на ${isoToDmy(asOf)} недоступний. Без as_of_date буде показано чинну редакцію.`;
}
