// Pure helpers shared by the three parsers and the store.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', hellip: '…' };

/** Strip tags, decode the common entities and collapse whitespace. */
export function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** Lines of a block, trimmed, blanks removed. */
export function lines(html: string): string[] {
  return text(html).split('\n').map((l) => l.trim()).filter(Boolean);
}

export function clean(s: string | null | undefined): string | null {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

/** 'WA 17979' / 'wa-17979' → 'WA-17979'; slashes (adwokaci) kept, upper-cased. */
export function normaliseEntryNumber(s: string | null | undefined): string | null {
  const v = clean(s);
  if (!v) return null;
  return v.toUpperCase().replace(/\s*[-\s]\s*/g, '-').replace(/\s*\/\s*/g, '/');
}

/** Polish numbers to E.164 (+48…); anything that is not 9 national digits is returned digits-only with + if it had a country code, else null. */
export function normalisePhone(s: string | null | undefined): string | null {
  const v = clean(s);
  if (!v) return null;
  let digits = v.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) return `+48${digits}`;
  if (digits.length === 11 && digits.startsWith('48')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export type LawyerStatus = 'active' | 'inactive' | 'former';

/** Register status wording → our three-state status. Unknown wording counts as inactive so it never pollutes the practising list. */
export function statusFromRaw(profession: 'adwokat' | 'radca', raw: string): LawyerStatus {
  const r = raw.toLowerCase();
  if (profession === 'adwokat') {
    if (r.startsWith('wykonujący')) return 'active';
    if (r.startsWith('były') || r.includes('skreśl')) return 'former';
    return 'inactive';
  }
  if (r.startsWith('wykonuje')) return 'active';
  if (r.includes('skreśl') || r.includes('był')) return 'former';
  return 'inactive';
}

/** Polish '26-900 Kozienice' → { postcode, city }. */
export function splitPostcodeCity(line: string): { postcode: string | null; city: string | null } {
  const m = /^(\d{2}-\d{3})\s+(.+)$/.exec(line.trim());
  if (m) return { postcode: m[1], city: m[2].trim() };
  return { postcode: null, city: clean(line) };
}

/** YYYY-MM-DD that is a real calendar date; the adwokat register prints 0000-00-00 for an unknown entry date. */
export function validIsoDate(s: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1800) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : null;
}
