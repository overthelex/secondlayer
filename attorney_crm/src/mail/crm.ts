import type { Queryable } from '../db';
import { tenant } from '../tenant';

// What the CRM remembers about a campaign e-mail once it has left: an 'email' note on
// the lead (so it shows in the lead's history and on "Today"), and a lead that was still
// 'new' moves to 'contacted'. Any later stage is left alone. The lead row is created if
// the advocate had none yet.
export async function noteSent(pool: Queryable, advocateSourceId: string, userId: number, subject: string, campaign: string | undefined): Promise<void> {
  await pool.query(
    "INSERT INTO attorney_crm_notes (advocate_source_id, user_id, kind, body) VALUES ($1, $2, 'email', $3)",
    [advocateSourceId, userId, tenant().strings.mailSentNote(subject, campaign)],
  );
  await pool.query(
    `INSERT INTO attorney_crm_leads (advocate_source_id, stage, updated_by) VALUES ($1, 'contacted', $2)
     ON CONFLICT (advocate_source_id) DO UPDATE SET stage = 'contacted', updated_at = NOW(), updated_by = $2
     WHERE attorney_crm_leads.stage = 'new'`,
    [advocateSourceId, userId],
  );
}

/** CRM user to attribute campaign notes to; null when nobody with that e-mail exists. */
export async function userIdByEmail(pool: Queryable, email: string): Promise<number | null> {
  const r = await pool.query<{ id: number }>('SELECT id FROM attorney_crm_users WHERE email = $1', [email.trim().toLowerCase()]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}
