import type { Queryable } from '../db';
import { NOTE_KINDS, STAGES, type NoteKind, type Stage } from '../practices';
import { tenant } from '../tenant';
import type { RegistryAdapter } from '../tenant/types';

export class ValidationError extends Error {
  readonly status = 400;
}

export interface Lead {
  advocateSourceId: string;
  stage: Stage;
  nextContactAt: Date | null;
  assignedUserId: number | null;
  manualPractices: string[];
  updatedAt: Date;
  updatedBy: number | null;
}

export interface Note {
  id: number;
  advocateSourceId: string;
  userId: number;
  kind: NoteKind;
  body: string;
  createdAt: Date;
}

export interface NoteWithAuthor extends Note {
  author: string;
}

type LeadRow = {
  advocate_source_id: string;
  stage: Stage;
  next_contact_at: Date | null;
  assigned_user_id: number | null;
  manual_practices: string[] | null;
  updated_at: Date;
  updated_by: number | null;
};

function mapLead(r: LeadRow): Lead {
  return {
    advocateSourceId: r.advocate_source_id,
    stage: r.stage,
    nextContactAt: r.next_contact_at ? new Date(r.next_contact_at) : null,
    assignedUserId: r.assigned_user_id,
    manualPractices: r.manual_practices ?? [],
    updatedAt: new Date(r.updated_at),
    updatedBy: r.updated_by,
  };
}

export async function getLead(pool: Queryable, sourceId: string): Promise<Lead | null> {
  const r = await pool.query<LeadRow>('SELECT * FROM attorney_crm_leads WHERE advocate_source_id = $1', [sourceId]);
  return r.rows[0] ? mapLead(r.rows[0]) : null;
}

export interface LeadPatch {
  stage?: Stage;
  nextContactAt?: Date | null;
  manualPractices?: string[];
}

/** Creates the lead on first save (upsert); validates stage and practice vocabulary. */
export async function saveLead(pool: Queryable, sourceId: string, patch: LeadPatch, userId: number): Promise<Lead> {
  if (patch.stage !== undefined && !(STAGES as readonly string[]).includes(patch.stage)) {
    throw new ValidationError(tenant().strings.errors.unknownStage(String(patch.stage)));
  }
  if (patch.manualPractices) {
    const allowed = tenant().practices;
    const bad = patch.manualPractices.find((p) => !allowed.includes(p));
    if (bad) throw new ValidationError(tenant().strings.errors.unknownPractice(bad));
  }
  const r = await pool.query<LeadRow>(
    `INSERT INTO attorney_crm_leads (advocate_source_id, stage, next_contact_at, manual_practices, updated_by)
     VALUES ($1, COALESCE($2, 'new'), $3, COALESCE($4, '{}'), $5)
     ON CONFLICT (advocate_source_id) DO UPDATE SET
       stage = COALESCE($2, attorney_crm_leads.stage),
       next_contact_at = CASE WHEN $6::boolean THEN $3 ELSE attorney_crm_leads.next_contact_at END,
       manual_practices = COALESCE($4, attorney_crm_leads.manual_practices),
       updated_at = NOW(), updated_by = $5
     RETURNING *`,
    [sourceId, patch.stage ?? null, patch.nextContactAt ?? null, patch.manualPractices ?? null, userId, patch.nextContactAt !== undefined],
  );
  return mapLead(r.rows[0]);
}

export async function addNote(pool: Queryable, sourceId: string, userId: number, kind: NoteKind, body: string): Promise<Note> {
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw new ValidationError(tenant().strings.errors.unknownNoteKind(String(kind)));
  const text = body.trim();
  if (!text) throw new ValidationError(tenant().strings.errors.emptyNote);
  const r = await pool.query<{ id: number; advocate_source_id: string; user_id: number; kind: NoteKind; body: string; created_at: Date }>(
    'INSERT INTO attorney_crm_notes (advocate_source_id, user_id, kind, body) VALUES ($1, $2, $3, $4) RETURNING *',
    [sourceId, userId, kind, text],
  );
  const row = r.rows[0];
  return { id: Number(row.id), advocateSourceId: row.advocate_source_id, userId: row.user_id, kind: row.kind, body: row.body, createdAt: new Date(row.created_at) };
}

export async function listNotes(pool: Queryable, sourceId: string): Promise<NoteWithAuthor[]> {
  const r = await pool.query<{ id: number; advocate_source_id: string; user_id: number; kind: NoteKind; body: string; created_at: Date; author: string }>(
    `SELECT n.id, n.advocate_source_id, n.user_id, n.kind, n.body, n.created_at,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS author
       FROM attorney_crm_notes n JOIN attorney_crm_users u ON u.id = n.user_id
      WHERE n.advocate_source_id = $1
      ORDER BY n.created_at DESC, n.id DESC`,
    [sourceId],
  );
  return r.rows.map((n) => ({ id: Number(n.id), advocateSourceId: n.advocate_source_id, userId: n.user_id, kind: n.kind, body: n.body, createdAt: new Date(n.created_at), author: n.author }));
}

/** `family_name, first_name, patronymic` from the registry adapter's name columns. */
function nameSelect(reg: RegistryAdapter): string {
  return `${reg.surnameColumn} AS family_name, ${reg.firstNameColumn} AS first_name, ${reg.patronymicColumn ?? "''"} AS patronymic`;
}

// ── Today page ────────────────────────────────────────────────────────────────

/** The zone's UTC offset in minutes at the given instant (e.g. Kyiv in summer → 180). */
export function utcOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const om = /GMT([+-])(\d{2}):(\d{2})/.exec(off);
  return om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : 0;
}

/** Midnight that ends the current local day in `tz`, as a UTC instant. */
export function endOfLocalDay(now: Date = new Date(), tz: string = tenant().timeZone): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD locally
  const [y, m, d] = ymd.split('-').map(Number);
  const nextUtcMidnight = Date.UTC(y, m - 1, d + 1);
  return new Date(nextUtcMidnight - utcOffsetMinutes(new Date(nextUtcMidnight), tz) * 60_000);
}

/** Kept for the Ukrainian tenant and its tests. */
export const endOfKyivDay = (now: Date = new Date()): Date => endOfLocalDay(now, 'Europe/Kyiv');

export interface DueRow {
  sourceId: string;
  fullName: string;
  city: string | null;
  phone: string | null;
  stage: Stage;
  nextContactAt: Date;
  overdue: boolean;
  lastNote: string | null;
  lastNoteAt: Date | null;
}

/** Leads due today or earlier (tenant time), earliest first so overdue ones lead. */
export async function dueToday(pool: Queryable, now: Date = new Date(), tz: string = tenant().timeZone): Promise<DueRow[]> {
  const bound = endOfLocalDay(now, tz);
  const reg = tenant().registry;
  const startOfToday = new Date(bound.getTime() - 24 * 3600 * 1000);
  const r = await pool.query<{
    advocate_source_id: string; family_name: string; first_name: string; patronymic: string; city: string | null;
    phone: string | null; stage: Stage; next_contact_at: Date; last_note: string | null; last_note_at: Date | null;
  }>(
    `SELECT l.advocate_source_id, ${nameSelect(reg)},
            ${reg.citySqlForToday} AS city,
            ${reg.phoneSqlForToday} AS phone,
            l.stage, l.next_contact_at, ln.body AS last_note, ln.created_at AS last_note_at
       FROM attorney_crm_leads l
       JOIN ${reg.table} ON ${reg.idColumn} = l.advocate_source_id
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM attorney_crm_notes n
          WHERE n.advocate_source_id = l.advocate_source_id ORDER BY created_at DESC LIMIT 1
       ) ln ON true
      WHERE l.next_contact_at < $1
      ORDER BY l.next_contact_at ASC, a.family_name ASC
      LIMIT 500`,
    [bound],
  );
  return r.rows.map((x) => {
    const nextContactAt = new Date(x.next_contact_at);
    return {
      sourceId: x.advocate_source_id,
      fullName: [x.family_name, x.first_name, x.patronymic].filter(Boolean).join(' '),
      city: x.city,
      phone: x.phone,
      stage: x.stage,
      nextContactAt,
      overdue: nextContactAt < startOfToday,
      lastNote: x.last_note,
      lastNoteAt: x.last_note_at ? new Date(x.last_note_at) : null,
    };
  });
}

export interface NoteWithAdvocate extends NoteWithAuthor {
  advocateName: string;
}

export async function recentNotes(pool: Queryable, limit = 30): Promise<NoteWithAdvocate[]> {
  const reg = tenant().registry;
  const r = await pool.query<{
    id: number; advocate_source_id: string; user_id: number; kind: NoteKind; body: string; created_at: Date; author: string;
    family_name: string | null; first_name: string | null; patronymic: string | null;
  }>(
    `SELECT n.id, n.advocate_source_id, n.user_id, n.kind, n.body, n.created_at,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS author,
            ${nameSelect(reg)}
       FROM attorney_crm_notes n
       JOIN attorney_crm_users u ON u.id = n.user_id
       LEFT JOIN ${reg.table} ON ${reg.idColumn} = n.advocate_source_id
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((n) => ({
    id: Number(n.id),
    advocateSourceId: n.advocate_source_id,
    userId: n.user_id,
    kind: n.kind,
    body: n.body,
    createdAt: new Date(n.created_at),
    author: n.author,
    advocateName: [n.family_name, n.first_name, n.patronymic].filter(Boolean).join(' ') || n.advocate_source_id,
  }));
}
