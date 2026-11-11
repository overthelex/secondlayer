// Phone numbers as the PBX wants them. The registry stores «+38(050)500-51-34»,
// «0505005134», «38 050 500 51 34»; the trunk dials E.164 digits without the plus
// (the dialplan's [outbound] context matches _380XXXXXXXXX), and the operator sends
// inbound caller ids in any of those shapes too.

/** Country code (digits, no plus) the tenant's lawyers are called in. */
export function countryCodeFor(tenantId: string): string {
  return tenantId === 'pl' ? '48' : '380';
}

/** National significant number length for the country code (UA 9, PL 9). */
const NATIONAL_LENGTH: Record<string, number> = { '380': 9, '48': 9 };

/**
 * «+38(050)500-51-34» / «0505005134» / «380505005134» → «380505005134»;
 * null when the digits do not make a number in that country.
 */
export function toDialable(raw: string, cc: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const n = NATIONAL_LENGTH[cc] ?? 9;
  if (digits.length === n + 1 && digits.startsWith('0')) digits = cc + digits.slice(1);
  else if (digits.length === n) digits = cc + digits;
  if (digits.length !== cc.length + n || !digits.startsWith(cc)) return null;
  return digits;
}

/** The national part used to match a caller against registry phones («%505005134»). */
export function nationalPart(dialable: string, cc: string): string {
  return dialable.startsWith(cc) ? dialable.slice(cc.length) : dialable;
}

/** «380505005134» → «+380 50 500 51 34» for notes and the screen pop. */
export function formatE164(dialable: string, cc: string): string {
  const nat = nationalPart(dialable, cc);
  if (cc === '380' && nat.length === 9) return `+380 ${nat.slice(0, 2)} ${nat.slice(2, 5)} ${nat.slice(5, 7)} ${nat.slice(7)}`;
  if (cc === '48' && nat.length === 9) return `+48 ${nat.slice(0, 3)} ${nat.slice(3, 6)} ${nat.slice(6)}`;
  return `+${dialable}`;
}
