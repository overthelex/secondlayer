/**
 * Legal status of an act for the legislation tools (LEXAI-2147).
 *
 * `legislation.status` is useless as a signal: it defaults to 'active' and is
 * never updated (all 687 rows on prod read 'active', the repealed Господарський
 * кодекс 436-15 included). The authoritative status is Rada's own, carried in
 * the full НПА corpus as `npa.act.status_code`, keyed by the same registry id
 * (`npa.act.nreg` = `legislation.rada_id`, both lower-case). get_npa_act already
 * reads it; the legislation tools did not, so they served repealed acts as
 * current law with no warning.
 *
 * The repeal date is not a column. Two sources, combined:
 *   - `npa.act.last_ed`: Rada publishes a final edition on the day an act stops
 *     having effect (436-15 → 2025-08-28, 1280-15 → 2022-01-01);
 *   - the «{Закон втратив чинність на підставі Закону № … від DD.MM.YYYY}» note
 *     at the head of that final edition's text. Where the last edition with
 *     text predates the repealing act (1098-99-п: last edition 1999, repealed
 *     by 617-2006-п of 11.05.2006), the repealing act's date is the better bound.
 */

import type { IDatabase } from '../domain/ports/index.js';
import { resolveActNumber, pickActNumber } from './act-number.js';
import { NPA_STATUS } from '../api/tools/npa-dicts.js';

/** Rada status «Втратив чинність»: the act as a whole is no longer law. */
export const FULLY_REPEALED_CODE = 1;
/** Rada status «Втратив чинність крім окремих положень»: some provisions still apply. */
export const PARTIALLY_REPEALED_CODE = 9;
/** Codes whose final edition carries a «втратив чинність на підставі …» note. */
const NOTE_CODES = [FULLY_REPEALED_CODE, PARTIALLY_REPEALED_CODE];

/** Statuses that need a caveat even though the act is not repealed. */
const CAVEAT_CODES: Record<number, string> = {
  2: 'Акт ще не набрав чинності',
  3: 'Дію акта зупинено',
  6: 'Акт не набрав чинності',
  7: 'Акт не застосовується на території України',
  8: 'Акт набрав чинності частково — окремі положення ще не діють; перевірте, чи діє саме ця норма',
};

/**
 * Curated successors where a repealed act's subject matter moved into a
 * specific current act. Only for cases that matter in practice; the generic
 * pointer is the repealing act taken from the note.
 */
export const ACT_SUCCESSORS: Record<string, Array<{ rada_id: string; title: string }>> = {
  // Law 4196-IX repealed ГК from 28.08.2025; obligations, penalties
  // (неустойка ст. 549-552) and contracts are governed by ЦК.
  '436-15': [{ rada_id: '435-15', title: 'Цивільний кодекс України' }],
};

export interface ActStatus {
  rada_id: string;
  status_code: number | null;
  /** Rada's label, e.g. «Чинний», «Втратив чинність». */
  status: string;
  in_force: boolean;
  /** Fully repealed (status 1): excluded from default search, «НЕ чинна норма». */
  repealed: boolean;
  /** Repealed except for some provisions (status 9): kept in search, demoted, caveated. */
  partially_repealed: boolean;
  /** ISO date the act (or most of it) stopped having effect (best estimate, see module doc). */
  repealed_from?: string;
  /** The «втратив чинність на підставі …» note, braces stripped. */
  repealed_by?: string;
  /** Registry id of the repealing act, when it could be resolved. */
  repealed_by_rada_id?: string;
  successors?: Array<{ rada_id: string; title: string }>;
}

/**
 * Finds the repeal note at the head of an edition text. Passed to Postgres as a
 * parameter (ARE syntax, bounded repetition ≤ 255). The group MUST stay
 * non-capturing: with a capturing group, Postgres `substring(… from re)`
 * returns that group («втратив») instead of the whole match.
 */
export const REPEAL_NOTE_SQL_REGEX =
  '\\{[^{}]{0,250}?(?:втратив|втратила|втратило|втратили)\\s+чинн[^{}]{0,250}\\}';

export interface ParsedRepealNote {
  text: string;
  /** ISO date of the repealing act («від 09.01.2025»). */
  basis_date?: string;
  /** Official number of the repealing act («4196-IX», «242»). */
  basis_number?: string;
  /** Registry id given inline in parentheses, «( 2427-19 )». */
  basis_rada_id?: string;
}

function dmyToIso(d: string, m: string, y: string): string {
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function parseRepealNote(note: string | null | undefined): ParsedRepealNote | null {
  const raw = String(note ?? '').trim();
  if (!raw) return null;
  const text = raw.replace(/^\{\s*/, '').replace(/\s*\}$/, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const out: ParsedRepealNote = { text };

  // Only the part after «на підставі» names the repealing act.
  const basis = text.split(/на\s+підставі/i)[1] ?? '';
  const date = basis.match(/від\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (date) out.basis_date = dmyToIso(date[1], date[2], date[3]);
  const num = basis.match(/(?:№|N)\s*([0-9]+(?:-[IVXLCDMІХ]+)?)/u);
  if (num) out.basis_number = num[1];
  const inline = basis.match(/\(\s*([0-9][0-9a-zа-яіїєґ/_-]*)\s*\)/iu);
  if (inline) out.basis_rada_id = inline[1].toLowerCase();
  return out;
}

/** Later of the two ISO dates; either may be missing. */
export function computeRepealedFrom(lastEd?: string | null, basisDate?: string | null): string | undefined {
  const a = lastEd || undefined;
  const b = basisDate || undefined;
  if (a && b) return a >= b ? a : b;
  return a ?? b;
}

export function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function buildActStatus(row: {
  nreg: string;
  status_code: number | null;
  last_ed?: string | null;
  repeal_note?: string | null;
}): ActStatus {
  const code = row.status_code == null ? null : Number(row.status_code);
  const radaId = String(row.nreg).toLowerCase();
  const repealed = code === FULLY_REPEALED_CODE;
  const partial = code === PARTIALLY_REPEALED_CODE;
  const status: ActStatus = {
    rada_id: radaId,
    status_code: code,
    status: code == null ? 'Не визначено' : (NPA_STATUS[code] ?? `Код ${code}`),
    in_force: code === 5 || code === 4 || code === 8,
    repealed,
    partially_repealed: partial,
  };
  if (repealed || partial) {
    const note = parseRepealNote(row.repeal_note);
    status.repealed_from = computeRepealedFrom(row.last_ed, note?.basis_date);
    if (note) {
      status.repealed_by = note.text;
      if (note.basis_rada_id) status.repealed_by_rada_id = note.basis_rada_id;
    }
    const successors = ACT_SUCCESSORS[radaId];
    if (successors) status.successors = successors;
  }
  return status;
}

function seeAlso(s: ActStatus): string {
  const refs: string[] = [];
  for (const succ of s.successors ?? []) refs.push(`${succ.title} (${succ.rada_id})`);
  if (s.repealed_by_rada_id && !refs.some((r) => r.includes(`(${s.repealed_by_rada_id})`))) {
    refs.push(`акт, яким скасовано (${s.repealed_by_rada_id})`);
  }
  return refs.length > 0 ? ` Див. ${refs.join('; ')}.` : '';
}

/**
 * Ukrainian warning for an act that is not plain «in force», or undefined.
 * `asOfDate` (ISO) softens the text when the caller asked for an edition from
 * before the repeal.
 */
export function buildStatusWarning(s: ActStatus | undefined, asOfDate?: string): string | undefined {
  if (!s) return undefined;
  const from = s.repealed_from ? ` з ${isoToDmy(s.repealed_from)}` : '';
  const basis = s.repealed_by ? ` (${s.repealed_by.replace(/\.$/, '')})` : '';
  const beforeRepeal = Boolean(asOfDate && s.repealed_from && asOfDate.slice(0, 10) < s.repealed_from);
  if (s.repealed) {
    let msg = `⚠️ Акт втратив чинність${from}${basis}.`;
    msg += beforeRepeal
      ? ` Показано редакцію станом на ${isoToDmy(asOfDate!.slice(0, 10))}, коли акт ще діяв.`
      : ' Текст наведено довідково — це НЕ чинна норма.';
    return msg + seeAlso(s);
  }
  if (s.partially_repealed) {
    let msg = `⚠️ Акт частково втратив чинність${from}${basis}: діють лише окремі положення.`;
    msg += beforeRepeal
      ? ` Показано редакцію станом на ${isoToDmy(asOfDate!.slice(0, 10))}, коли акт діяв повністю.`
      : ' Перевірте, чи ця норма належить до положень, що зберегли чинність.';
    return msg + seeAlso(s);
  }
  if (s.status_code != null && CAVEAT_CODES[s.status_code]) {
    return `⚠️ ${CAVEAT_CODES[s.status_code]} (статус: «${s.status}»).`;
  }
  return undefined;
}

/** Compact status for a search hit / response field. */
export function actStatusField(s: ActStatus | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  return {
    status: s.status,
    in_force: s.in_force,
    ...(s.repealed ? { repealed: true } : {}),
    ...(s.partially_repealed ? { partially_repealed: true } : {}),
    ...(s.repealed_from ? { repealed_from: s.repealed_from } : {}),
    ...(s.repealed_by ? { repealed_by: s.repealed_by } : {}),
    ...(s.repealed_by_rada_id ? { repealed_by_rada_id: s.repealed_by_rada_id } : {}),
    ...(s.successors ? { successors: s.successors } : {}),
  };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;

/**
 * Reads the repeal note from the head of an edition text.
 *
 * `body || ''` is load-bearing: on PG 15 + pglz, slicing an npa body column
 * directly (`left(body, n)`, `substr(body, …)`) takes the partial-detoast path
 * and throws «invalid byte sequence for encoding "UTF8"» on about a third of
 * rows, non-deterministically. Concatenation forces a full detoast first,
 * which is safe (300/300 measured).
 */
const NOTE_SQL = `SELECT t.nreg, substring(substr(t.body || '', 1, 6000) from $3) AS repeal_note
                    FROM unnest($1::text[], $2::date[]) AS p(nreg, ed_date)
                    JOIN npa.edition_text t ON t.nreg = p.nreg AND t.ed_date = p.ed_date`;

/**
 * Batched, cached lookup of act statuses.
 *
 * Two steps, so the fragile part cannot take the essential part down:
 *   1. status: one PK query on npa.act, no body columns. If this fails (npa
 *      schema missing), the map is empty and responses are as before.
 *   2. repeal note: only for statuses 1/9, batched; if the batch fails, it
 *      is retried per act, and an act whose note cannot be read keeps its
 *      status and date without the note (and is not cached, so it is retried).
 */
export class ActStatusResolver {
  private cache = new Map<string, { value: ActStatus | null; ts: number }>();

  constructor(private readonly db: IDatabase) {}

  async getStatuses(radaIds: Array<string | null | undefined>): Promise<Map<string, ActStatus>> {
    const out = new Map<string, ActStatus>();
    const now = Date.now();
    const missing: string[] = [];
    for (const id of new Set(radaIds.filter(Boolean).map((r) => String(r).toLowerCase()))) {
      const hit = this.cache.get(id);
      if (hit && now - hit.ts < CACHE_TTL_MS) {
        if (hit.value) out.set(id, hit.value);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return out;

    let rows: Array<{ nreg: string; status_code: number | null; last_ed: string | null }>;
    try {
      const res = await this.db.query(
        `SELECT a.nreg, a.status_code, to_char(a.last_ed, 'YYYY-MM-DD') AS last_ed
           FROM npa.act a
          WHERE a.nreg = ANY($1::text[])`,
        [missing]
      );
      rows = res.rows;
    } catch {
      return out;
    }

    const needNote = rows.filter((r) => r.status_code != null && NOTE_CODES.includes(Number(r.status_code)) && r.last_ed);
    const { notes, failed } = await this.fetchNotes(needNote);

    const found = new Set<string>();
    for (const row of rows) {
      const nreg = String(row.nreg).toLowerCase();
      const note = notes.get(nreg) ?? null;
      const status = buildActStatus({ ...row, repeal_note: note });
      if ((status.repealed || status.partially_repealed) && !status.repealed_by_rada_id) {
        const num = parseRepealNote(note)?.basis_number;
        if (num && /-/.test(num)) {
          try {
            const { nreg: basis } = pickActNumber(await resolveActNumber(this.db, num));
            if (basis) status.repealed_by_rada_id = basis;
          } catch { /* pointer is optional */ }
        }
      }
      found.add(nreg);
      out.set(nreg, status);
      if (!failed.has(nreg)) this.remember(nreg, status, now);
    }
    for (const id of missing) if (!found.has(id)) this.remember(id, null, now);
    return out;
  }

  private async fetchNotes(
    rows: Array<{ nreg: string; last_ed: string | null }>
  ): Promise<{ notes: Map<string, string | null>; failed: Set<string> }> {
    const notes = new Map<string, string | null>();
    const failed = new Set<string>();
    if (rows.length === 0) return { notes, failed };
    const take = (res: any) => {
      for (const r of res.rows) notes.set(String(r.nreg).toLowerCase(), r.repeal_note ?? null);
    };
    try {
      take(await this.db.query(NOTE_SQL, [rows.map((r) => r.nreg), rows.map((r) => r.last_ed), REPEAL_NOTE_SQL_REGEX]));
      return { notes, failed };
    } catch {
      // One bad row must not cost every act its note: retry one by one.
    }
    for (const r of rows) {
      try {
        take(await this.db.query(NOTE_SQL, [[r.nreg], [r.last_ed], REPEAL_NOTE_SQL_REGEX]));
      } catch {
        failed.add(String(r.nreg).toLowerCase());
      }
    }
    return { notes, failed };
  }

  private remember(id: string, value: ActStatus | null, ts: number): void {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(id, { value, ts });
  }
}
