/**
 * ЄДРПОУ code normalisation for the relationship graph (LEXAI-2302).
 *
 * normEdrpou   ' 1234567 ' -> '01234567' (8 digits, leading zeros restored), with the reason
 *              when the value cannot be a code and whether the check digit matches.
 *
 * Check digit (the 8th digit) of the State statistics service algorithm:
 *   weights 1..7 for codes below 30000000 or above 60000000, otherwise 7,1,2,3,4,5,6;
 *   r = Σ d[i]·w[i] mod 11; if r = 10, repeat with every weight + 2; if r = 10 again, r = 0.
 * Checked against 5,000 codes sampled from edr_hist.company: 4,999 match. A register entry with
 * a wrong check digit still exists, so a checksum miss is flagged, never dropped.
 */

export type EdrpouProblem = 'empty' | 'not_digits' | 'too_long';

export interface EdrpouNorm {
  /** 8 digits, or null when the value cannot be an ЄДРПОУ code */
  code: string | null;
  /** the check digit matches (false when code is null) */
  checksumOk: boolean;
  problem: EdrpouProblem | null;
}

const W_LOW = [1, 2, 3, 4, 5, 6, 7];
const W_MID = [7, 1, 2, 3, 4, 5, 6];

/** Check digit for an 8-digit code (only the first 7 digits are read). */
export function edrpouCheckDigit(code: string): number {
  const d = [...code.slice(0, 7)].map(Number);
  const n = Number(code);
  const w = n < 30000000 || n > 60000000 ? W_LOW : W_MID;
  const sum = (add: number) => d.reduce((a, x, i) => a + x * (w[i] + add), 0) % 11;
  let r = sum(0);
  if (r === 10) r = sum(2);
  return r === 10 ? 0 : r;
}

export function normEdrpou(input: string | number | null | undefined): EdrpouNorm {
  const s = input == null ? '' : String(input).replace(/[\s ]+/g, '');
  if (!s) return { code: null, checksumOk: false, problem: 'empty' };
  if (!/^\d+$/.test(s)) return { code: null, checksumOk: false, problem: 'not_digits' };
  const t = s.replace(/^0+(?=\d{8})/, ''); // extra leading zeros: '0001234567' -> '01234567'
  if (t.length > 8) return { code: null, checksumOk: false, problem: 'too_long' };
  const code = t.padStart(8, '0');
  if (/^0{8}$/.test(code)) return { code: null, checksumOk: false, problem: 'empty' };
  return { code, checksumOk: edrpouCheckDigit(code) === Number(code[7]), problem: null };
}

/** True for an 8-digit-normalisable value whose check digit matches. */
export function isValidEdrpou(input: string | number | null | undefined): boolean {
  return normEdrpou(input).checksumOk;
}
