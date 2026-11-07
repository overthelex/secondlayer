import type { Queryable } from '../db';
import { NAAU_PRACTICES, NOTE_KINDS, STAGES, type NoteKind, type Stage } from '../practices';

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
    throw new ValidationError(`Невідома стадія: ${patch.stage}`);
  }
  if (patch.manualPractices) {
    const bad = patch.manualPractices.find((p) => !NAAU_PRACTICES.includes(p));
    if (bad) throw new ValidationError(`Невідома практика: ${bad}`);
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
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`Невідомий тип нотатки: ${kind}`);
  const text = body.trim();
  if (!text) throw new ValidationError('Порожня нотатка');
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
