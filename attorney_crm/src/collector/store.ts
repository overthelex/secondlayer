// Writes to public.pl_lawyers / public.pl_lawyers_crawl. Every upsert is "fill, never erase":
// an undefined field is sent as NULL and COALESCEd with the stored value, so a list walk
// cannot wipe a phone the detail fetch found, and szukajradcy cannot clear a register e-mail.
import type { Queryable } from '../db';
import type { LawyerStatus } from './normalise';

export type Profession = 'adwokat' | 'radca';

export interface LawyerUpsert {
  lawyerId: string;
  profession: Profession;
  surname: string;
  givenNames: string;
  status: LawyerStatus;
  statusRaw: string;
  chamber?: string | null;
  city?: string | null;
  postcode?: string | null;
  address?: string | null;
  officeName?: string | null;
  phone?: string | null;
  phone2?: string | null;
  email?: string | null;
  website?: string | null;
  contactSource?: 'register' | 'szukajradcy' | null;
  entryNumber?: string | null;
  entryDate?: string | null;
  practices?: string[];
  practiceTagsRaw?: string[];
  profileUrl?: string | null;
  directoryUrl?: string | null;
  detailFetched?: boolean;
  raw?: unknown;
}

const COLS = [
  'lawyer_id', 'profession', 'surname', 'given_names', 'status', 'status_raw', 'chamber', 'city', 'postcode', 'address',
  'office_name', 'phone', 'phone2', 'email', 'website', 'contact_source', 'entry_number', 'entry_date', 'practices',
  'practice_tags_raw', 'profile_url', 'directory_url', 'list_seen_at', 'detail_fetched_at', 'raw',
] as const;

const FILL_ONLY = ['chamber', 'city', 'postcode', 'address', 'office_name', 'phone', 'phone2', 'email', 'website', 'contact_source', 'entry_number', 'entry_date', 'profile_url', 'directory_url', 'detail_fetched_at'];

/**
 * @param seenAt   list_seen_at for inserted rows and (when touchSeen) for updated ones
 * @param touchSeen false for enrichment passes (szukajradcy) so markUnseen still sees the true last list sighting
 */
/**
 * One row per lawyer id: the registers themselves repeat an entry number now and then (BŁ/1678 is
 * listed twice on rejestrradcow.pl with two spellings), and Postgres refuses to touch the same row
 * twice in one INSERT … ON CONFLICT. The first row wins; its blanks are filled from the duplicates.
 */
export function dedupeLawyers(rows: LawyerUpsert[]): LawyerUpsert[] {
  const byId = new Map<string, LawyerUpsert>();
  for (const r of rows) {
    const prev = byId.get(r.lawyerId);
    if (!prev) { byId.set(r.lawyerId, { ...r }); continue; }
    for (const k of Object.keys(r) as (keyof LawyerUpsert)[]) {
      const cur = prev[k];
      if (cur === undefined || cur === null || cur === '') (prev as unknown as Record<string, unknown>)[k] = r[k];
    }
  }
  return [...byId.values()];
}

export async function upsertLawyers(pool: Queryable, input: LawyerUpsert[], seenAt: Date, touchSeen = true): Promise<number> {
  const rows = dedupeLawyers(input);
  if (rows.length === 0) return 0;
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const vals: unknown[] = [
      r.lawyerId, r.profession, r.surname, r.givenNames, r.status, r.statusRaw, r.chamber ?? null, r.city ?? null, r.postcode ?? null, r.address ?? null,
      r.officeName ?? null, r.phone ?? null, r.phone2 ?? null, r.email ?? null, r.website ?? null, r.contactSource ?? null, r.entryNumber ?? null, r.entryDate ?? null,
      r.practices ?? null, r.practiceTagsRaw ?? null, r.profileUrl ?? null, r.directoryUrl ?? null, seenAt, r.detailFetched ? seenAt : null, r.raw === undefined ? null : JSON.stringify(r.raw),
    ];
    const placeholders = vals.map((v, i) => {
      params.push(v);
      const n = params.length;
      const col = COLS[i];
      if (col === 'practices' || col === 'practice_tags_raw') return `COALESCE($${n}::text[], '{}')`;
      if (col === 'raw') return `COALESCE($${n}::jsonb, '{}')`;
      if (col === 'entry_date') return `$${n}::date`;
      if (col === 'list_seen_at' || col === 'detail_fetched_at') return `$${n}::timestamptz`;
      return `$${n}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const t = 'public.pl_lawyers';
  // name and status come from the registers; an enrichment pass sends '' and keeps what is stored
  const sets = [
    `surname = COALESCE(NULLIF(EXCLUDED.surname, ''), ${t}.surname)`,
    `given_names = CASE WHEN EXCLUDED.surname = '' THEN ${t}.given_names ELSE EXCLUDED.given_names END`,
    `status = CASE WHEN COALESCE(NULLIF(EXCLUDED.status_raw, ''), '') = '' AND ${t}.status_raw <> '' THEN ${t}.status ELSE EXCLUDED.status END`,
    `status_raw = COALESCE(NULLIF(EXCLUDED.status_raw, ''), ${t}.status_raw)`,
    ...FILL_ONLY.map((c) => `${c} = COALESCE(EXCLUDED.${c}, ${t}.${c})`),
    `practices = CASE WHEN EXCLUDED.practices = '{}' THEN ${t}.practices ELSE EXCLUDED.practices END`,
    `practice_tags_raw = CASE WHEN EXCLUDED.practice_tags_raw = '{}' THEN ${t}.practice_tags_raw ELSE EXCLUDED.practice_tags_raw END`,
    touchSeen ? `list_seen_at = GREATEST(EXCLUDED.list_seen_at, ${t}.list_seen_at)` : `list_seen_at = ${t}.list_seen_at`,
    `raw = ${t}.raw || EXCLUDED.raw`,
  ];
  const r = await pool.query(
    `INSERT INTO public.pl_lawyers (${COLS.join(', ')}) VALUES ${tuples.join(',\n')}
     ON CONFLICT (lawyer_id) DO UPDATE SET ${sets.join(', ')}`,
    params,
  );
  void r;
  return rows.length;
}

export async function getCursor(pool: Queryable, source: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{ cursor: Record<string, unknown> }>('SELECT cursor FROM public.pl_lawyers_crawl WHERE source = $1', [source]);
  return r.rows[0]?.cursor ?? null;
}

export async function setCursor(pool: Queryable, source: string, cursor: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO public.pl_lawyers_crawl (source, cursor, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
    [source, JSON.stringify(cursor)],
  );
}

/** Rows of a profession the finished walk did not list any more. Status wording is kept, flagged. */
export async function markUnseen(pool: Queryable, profession: Profession, walkStartedAt: Date, newStatus: 'former' | 'inactive'): Promise<number> {
  const r = await pool.query(
    `UPDATE public.pl_lawyers SET status = $1, status_raw = CASE WHEN status_raw LIKE '%(nie na liście)' THEN status_raw ELSE status_raw || ' (nie na liście)' END
     WHERE profession = $2 AND list_seen_at < $3 AND status <> $1`,
    [newStatus, profession, walkStartedAt],
  );
  return r.rowCount ?? 0;
}

export interface MatchedLawyer {
  lawyerId: string;
  contactSource: string | null;
}

/** Exactly one radca with this entry number, else null. */
export async function findByEntryNumber(pool: Queryable, entryNumber: string): Promise<MatchedLawyer | null> {
  const r = await pool.query<{ lawyer_id: string; contact_source: string | null }>(
    "SELECT lawyer_id, contact_source FROM public.pl_lawyers WHERE entry_number = $1 AND profession = 'radca' LIMIT 2",
    [entryNumber],
  );
  return r.rows.length === 1 ? { lawyerId: r.rows[0].lawyer_id, contactSource: r.rows[0].contact_source } : null;
}

/**
 * Radcowie with this surname + given names (case-insensitive). Exactly one nationwide → match;
 * several → only the one whose city equals the directory's city; a NULL city never wins a tie.
 */
export async function findUniqueByName(pool: Queryable, surname: string, givenNames: string, city: string | null): Promise<MatchedLawyer | null> {
  const r = await pool.query<{ lawyer_id: string; contact_source: string | null; city: string | null }>(
    `SELECT lawyer_id, contact_source, city FROM public.pl_lawyers
     WHERE profession = 'radca' AND upper(surname) = upper($1) AND upper(given_names) = upper($2)
     LIMIT 10`,
    [surname, givenNames],
  );
  let rows = r.rows;
  if (rows.length > 1 && city) rows = rows.filter((x) => x.city && x.city.toUpperCase() === city.toUpperCase());
  return rows.length === 1 ? { lawyerId: rows[0].lawyer_id, contactSource: rows[0].contact_source } : null;
}

export async function countByProfession(pool: Queryable, profession: Profession): Promise<number> {
  const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM public.pl_lawyers WHERE profession = $1', [profession]);
  return Number(r.rows[0]?.n ?? 0);
}

export interface DetailCandidate {
  lawyerId: string;
  profileUrl: string;
}

/** Adwokaci whose profile was never fetched or is older than maxAgeDays, practising first. */
export async function detailCandidates(pool: Queryable, maxAgeDays: number, limit: number): Promise<DetailCandidate[]> {
  const r = await pool.query<{ lawyer_id: string; profile_url: string }>(
    `SELECT lawyer_id, profile_url FROM public.pl_lawyers
     WHERE profession = 'adwokat' AND profile_url IS NOT NULL
       AND (detail_fetched_at IS NULL OR detail_fetched_at < NOW() - ($1::int * INTERVAL '1 day'))
     ORDER BY (status = 'active') DESC, detail_fetched_at ASC NULLS FIRST, lawyer_id
     LIMIT $2`,
    [maxAgeDays, limit],
  );
  return r.rows.map((x) => ({ lawyerId: x.lawyer_id, profileUrl: x.profile_url }));
}

export async function markDetailFetched(pool: Queryable, lawyerId: string, raw: unknown): Promise<void> {
  await pool.query('UPDATE public.pl_lawyers SET detail_fetched_at = NOW(), raw = raw || $2::jsonb WHERE lawyer_id = $1', [lawyerId, JSON.stringify(raw)]);
}
