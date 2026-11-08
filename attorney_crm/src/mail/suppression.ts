import type { Queryable } from '../db';
import { normaliseEmail } from './token';

export const SUPPRESSION_REASONS = ['unsubscribe', 'bounce', 'complaint', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  source: string;
  advocateSourceId: string | null;
  detail: string | null;
  createdAt: Date;
}

type Row = { email: string; reason: SuppressionReason; source: string; advocate_source_id: string | null; detail: string | null; created_at: Date };

const map = (r: Row): Suppression => ({
  email: r.email,
  reason: r.reason,
  source: r.source,
  advocateSourceId: r.advocate_source_id,
  detail: r.detail,
  createdAt: new Date(r.created_at),
});

export function isSuppressionReason(v: unknown): v is SuppressionReason {
  return typeof v === 'string' && (SUPPRESSION_REASONS as readonly string[]).includes(v);
}

/**
 * Records an address as undeliverable or unwanted. A repeat keeps the first row but
 * an unsubscribe or complaint overrides a weaker reason (bounce/manual), because the
 * person's own request is the one that must never be lost.
 */
export async function suppress(
  pool: Queryable,
  input: { email: string; reason: SuppressionReason; source?: string; advocateSourceId?: string | null; detail?: string | null },
): Promise<Suppression> {
  const email = normaliseEmail(input.email);
  if (!email.includes('@')) throw new Error(`not an e-mail address: ${input.email}`);
  const r = await pool.query<Row>(
    `INSERT INTO attorney_crm_suppression (email, reason, source, advocate_source_id, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       reason = CASE WHEN EXCLUDED.reason IN ('unsubscribe','complaint') THEN EXCLUDED.reason ELSE attorney_crm_suppression.reason END,
       source = CASE WHEN EXCLUDED.reason IN ('unsubscribe','complaint') THEN EXCLUDED.source ELSE attorney_crm_suppression.source END,
       detail = COALESCE(EXCLUDED.detail, attorney_crm_suppression.detail),
       advocate_source_id = COALESCE(attorney_crm_suppression.advocate_source_id, EXCLUDED.advocate_source_id)
     RETURNING *`,
    [email, input.reason, input.source ?? '', input.advocateSourceId ?? null, input.detail ?? null],
  );
  return map(r.rows[0]);
}

export async function getSuppression(pool: Queryable, rawEmail: string): Promise<Suppression | null> {
  const r = await pool.query<Row>('SELECT * FROM attorney_crm_suppression WHERE email = $1', [normaliseEmail(rawEmail)]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** The subset of `emails` (normalised) that must not be mailed. */
export async function suppressedAmong(pool: Queryable, emails: string[]): Promise<Set<string>> {
  const wanted = [...new Set(emails.map(normaliseEmail))];
  if (!wanted.length) return new Set();
  const r = await pool.query<{ email: string }>('SELECT email FROM attorney_crm_suppression WHERE email = ANY($1::text[])', [wanted]);
  return new Set(r.rows.map((x) => x.email));
}

export async function unsuppress(pool: Queryable, rawEmail: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM attorney_crm_suppression WHERE email = $1', [normaliseEmail(rawEmail)]);
  return (r.rowCount ?? 0) > 0;
}

/** Removes only a team-made ('manual') entry; the recipient's own unsubscribe or a bounce stays. */
export async function unsuppressManual(pool: Queryable, rawEmail: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM attorney_crm_suppression WHERE email = $1 AND reason = 'manual'", [normaliseEmail(rawEmail)]);
  return (r.rowCount ?? 0) > 0;
}

export interface BounceLine {
  email: string;
  detail: string;
}

const POSTFIX_TO = /\bto=<([^>]+)>/;
const POSTFIX_STATUS = /\bstatus=(bounced|expired)\b(.*)$/;
const BARE_EMAIL = /^[^\s,;"']+@[^\s,;"']+\.[^\s,;"']+$/;

/**
 * Parses bounce evidence from stdin-style text: Postfix log lines with
 * `to=<addr>` and `status=bounced|expired` (mail2's /var/log/mail.log), or a plain
 * list / CSV whose first column is an address (Azure portal export). Other lines
 * are ignored, so a whole log can be piped through.
 */
export function parseBounceLines(text: string): BounceLine[] {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const to = POSTFIX_TO.exec(trimmed);
    if (to) {
      const st = POSTFIX_STATUS.exec(trimmed);
      if (!st) continue;
      out.set(normaliseEmail(to[1]), `${st[1]}${st[2]}`.trim().slice(0, 500));
      continue;
    }
    const first = trimmed.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, '');
    if (BARE_EMAIL.test(first) && !first.toLowerCase().startsWith('email')) out.set(normaliseEmail(first), trimmed.slice(0, 500));
  }
  return [...out].map(([email, detail]) => ({ email, detail }));
}

/** Writes the parsed bounces into the table; returns how many rows were new. */
export async function importBounces(pool: Queryable, lines: BounceLine[], source = 'postfix-log'): Promise<number> {
  let added = 0;
  for (const b of lines) {
    const before = await getSuppression(pool, b.email);
    await suppress(pool, { email: b.email, reason: 'bounce', source, detail: b.detail });
    if (!before) added++;
  }
  return added;
}
