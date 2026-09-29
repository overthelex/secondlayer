/**
 * Matching a caller's provision against `uk_legislation_effects.affected_provisions`.
 *
 * The amendment register names the affected provision as free text, the way the
 * legislation.gov.uk "Changes to legislation" tables print it: `s. 253(5)`, `s. 24-28`,
 * `ss. 1-7B`, `Sch. B1 para. 15`, `reg. 2(1)`, `art. 3(6)(p)-(x)`, `r. 180`, and for
 * whole-instrument or whole-Part effects `Act`, `Regulations`, `Pt. 2`. A plain LIKE on
 * the number is wrong both ways: `s. 1` must not match `s. 12`, and `s. 24-28` does cover
 * section 25. So the register text is parsed here and compared by value.
 */

export type EffectScope = 'provision' | 'part' | 'whole_instrument';

export interface ProvisionTarget {
  /** 'section' | 'regulation' | 'article' | 'rule' | 'paragraph' | 'schedule' */
  kind: string;
  /** Number of the provision itself, e.g. '253', '38A', '15'. */
  number: string;
  /** For a schedule paragraph, the schedule's number, e.g. 'B1'. */
  schedule?: string;
}

const WHOLE_INSTRUMENT = /^(act|regulations?|order|rules|measure|instrument|scheme|direction)s?$/i;

const PREFIX_BY_KIND: Record<string, RegExp> = {
  section: /^ss?\.\s*/i,
  regulation: /^regs?\.\s*/i,
  article: /^arts?\.\s*/i,
  rule: /^(?:rules?|rr?)\.?\s*(?=\d)/i,
};

/** '38A' -> [38, 'A']; used to order provision numbers the way the statute book does. */
function numKey(s: string): [number, string] | null {
  const m = /^(\d+)([A-Z]*)$/i.exec(s.trim());
  return m ? [Number(m[1]), m[2].toUpperCase()] : null;
}

function cmp(a: [number, string], b: [number, string]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** Does the leading token of `rest` ('253(5)', '24-28', '1-7B', '38A') cover `number`? */
function tokenCovers(rest: string, number: string): boolean {
  const token = /^[0-9A-Za-z]+(?:\s*-\s*[0-9A-Za-z]+)?/.exec(rest.trim())?.[0];
  if (!token) return false;
  const want = numKey(number);
  if (!want) return token.toUpperCase() === number.toUpperCase();
  const [lo, hi] = token.split(/\s*-\s*/);
  const a = numKey(lo);
  if (!a) return false;
  if (hi === undefined) return cmp(a, want) === 0;
  const b = numKey(hi);
  return b ? cmp(a, want) <= 0 && cmp(want, b) <= 0 : cmp(a, want) === 0;
}

/**
 * Turn the tool's `provision` argument into a target. Accepts '253', 's.253', 'section/253',
 * a full key 'ukpga/1986/45/section/253', and schedule paragraphs as
 * 'schedule/B1/paragraph/15'.
 */
export function parseTarget(provision: string, legId: string, kindHint?: string): ProvisionTarget | null {
  let raw = String(provision).trim();
  if (raw.startsWith(legId + '/')) raw = raw.slice(legId.length + 1);
  const sched = /^schedule\/([0-9A-Za-z]+)\/paragraph\/([0-9A-Za-z]+)$/i.exec(raw);
  if (sched) return { kind: 'paragraph', schedule: sched[1], number: sched[2] };
  const wholeSched = /^schedule\/([0-9A-Za-z]+)$/i.exec(raw);
  if (wholeSched) return { kind: 'schedule', number: wholeSched[1] };
  const keyed = /^(section|regulation|article|rule)\/([0-9A-Za-z]+)$/i.exec(raw);
  if (keyed) return { kind: keyed[1].toLowerCase(), number: keyed[2] };
  const bare = /^(?:(s|ss|reg|art|r|rule)\.?\s*)?([0-9]+[A-Za-z]*)$/i.exec(raw);
  if (!bare) return null;
  const fromPrefix: Record<string, string> = { s: 'section', ss: 'section', reg: 'regulation', art: 'article', r: 'rule', rule: 'rule' };
  const kind = bare[1] ? fromPrefix[bare[1].toLowerCase()] : (kindHint || '').toLowerCase() || defaultKind(legId);
  return { kind, number: bare[2] };
}

function defaultKind(legId: string): string {
  return /^(uksi|ssi|wsi|nisr)\//.test(legId) ? 'regulation' : 'section';
}

/**
 * Classify one register entry against a target: 'provision' when it names the provision
 * (or a range or schedule containing it), 'part' when it names a whole Part (which may or
 * may not contain it), 'whole_instrument' when it affects the instrument as such, or null.
 */
export function matchEffect(affected: string | null, target: ProvisionTarget): EffectScope | null {
  const text = (affected || '').trim();
  if (!text || WHOLE_INSTRUMENT.test(text)) return 'whole_instrument';
  if (/^Pts?\.\s*/i.test(text)) return 'part';

  const sch = /^Schs?\.\s*([0-9A-Za-z]+)\b\s*(.*)$/i.exec(text);
  if (target.kind === 'paragraph' || target.kind === 'schedule') {
    if (!sch || sch[1].toUpperCase() !== String(target.schedule ?? target.number).toUpperCase()) return null;
    if (target.kind === 'schedule') return 'provision';
    const rest = sch[2];
    if (!rest || /^Pt\./i.test(rest)) return 'part'; // the whole schedule, or a Part of it
    const para = /^paras?\.\s*(.*)$/i.exec(rest);
    return para && tokenCovers(para[1], target.number) ? 'provision' : null;
  }
  if (sch) return null;

  const prefix = PREFIX_BY_KIND[target.kind];
  if (!prefix) return null;
  const m = prefix.exec(text);
  if (!m) return null;
  return tokenCovers(text.slice(m[0].length), target.number) ? 'provision' : null;
}
