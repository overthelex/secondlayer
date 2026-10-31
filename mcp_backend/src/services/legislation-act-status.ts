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
import { NPA_STATUS, NPA_REPEALED_CODES } from '../api/tools/npa-dicts.js';

/** Statuses that need a caveat even though the act is not repealed. */
const CAVEAT_CODES: Record<number, string> = {
  2: 'Акт ще не набрав чинності',
  3: 'Дію акта зупинено',
  6: 'Акт не набрав чинності',
  7: 'Акт не застосовується на території України',
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
  repealed: boolean;
  /** ISO date the act stopped having effect (best estimate, see module doc). */
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
  const repealed = code != null && NPA_REPEALED_CODES.includes(code);
  const status: ActStatus = {
    rada_id: row.nreg,
    status_code: code,
    status: code == null ? 'Не визначено' : (NPA_STATUS[code] ?? `Код ${code}`),
    in_force: code === 5 || code === 4 || code === 8,
    repealed,
  };
  if (repealed) {
    const note = parseRepealNote(row.repeal_note);
    status.repealed_from = computeRepealedFrom(row.last_ed, note?.basis_date);
    if (note) {
      status.repealed_by = note.text;
      if (note.basis_rada_id) status.repealed_by_rada_id = note.basis_rada_id;
    }
    const successors = ACT_SUCCESSORS[row.nreg];
    if (successors) status.successors = successors;
  }
  return status;
}

/**
 * Ukrainian warning for an act that is not plain «in force», or undefined.
 * `asOfDate` (ISO) softens the text when the caller asked for an edition from
 * before the repeal.
 */
export function buildStatusWarning(s: ActStatus | undefined, asOfDate?: string): string | undefined {
  if (!s) return undefined;
  if (s.repealed) {
    const partial = s.status_code === 9 ? ', крім окремих положень,' : '';
    const from = s.repealed_from ? ` з ${isoToDmy(s.repealed_from)}` : '';
    let msg = `⚠️ Акт втратив чинність${partial}${from}`;
    if (s.repealed_by) msg += ` (${s.repealed_by.replace(/\.$/, '')})`;
    msg += '.';
    if (asOfDate && s.repealed_from && asOfDate.slice(0, 10) < s.repealed_from) {
      msg += ` Показано редакцію станом на ${isoToDmy(asOfDate.slice(0, 10))}, коли акт ще діяв.`;
    } else {
      msg += ' Текст наведено довідково — це НЕ чинна норма.';
    }
    const refs: string[] = [];
    for (const succ of s.successors ?? []) refs.push(`${succ.title} (${succ.rada_id})`);
    if (s.repealed_by_rada_id && !refs.some((r) => r.includes(`(${s.repealed_by_rada_id})`))) {
      refs.push(`акт, яким скасовано (${s.repealed_by_rada_id})`);
    }
    if (refs.length > 0) msg += ` Див. ${refs.join('; ')}.`;
    return msg;
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
    ...(s.repealed_from ? { repealed_from: s.repealed_from } : {}),
    ...(s.repealed_by ? { repealed_by: s.repealed_by } : {}),
    ...(s.repealed_by_rada_id ? { repealed_by_rada_id: s.repealed_by_rada_id } : {}),
    ...(s.successors ? { successors: s.successors } : {}),
  };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;

/**
 * Batched, cached lookup of act statuses. One indexed query on npa.act (PK);
 * the edition text is only touched for repealed acts, to read the note.
 * Missing npa schema or any error → empty map (callers then show no status,
 * exactly the old behaviour, rather than failing the tool).
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

    let rows: any[];
    try {
      const res = await this.db.query(
        `SELECT a.nreg, a.status_code, to_char(a.last_ed, 'YYYY-MM-DD') AS last_ed,
                CASE WHEN a.status_code = ANY($2::int[]) THEN (
                  SELECT substring(left(t.body, 6000) from $3)
                    FROM npa.edition_text t
                   WHERE t.nreg = a.nreg AND t.ed_date = a.last_ed
                   LIMIT 1
                ) END AS repeal_note
           FROM npa.act a
          WHERE a.nreg = ANY($1::text[])`,
        [missing, NPA_REPEALED_CODES, REPEAL_NOTE_SQL_REGEX]
      );
      rows = res.rows;
    } catch {
      return out;
    }

    const found = new Set<string>();
    for (const row of rows) {
      const status = buildActStatus(row);
      if (status.repealed && !status.repealed_by_rada_id) {
        const num = parseRepealNote(row.repeal_note)?.basis_number;
        if (num && /-/.test(num)) {
          try {
            const { nreg } = pickActNumber(await resolveActNumber(this.db, num));
            if (nreg) status.repealed_by_rada_id = nreg;
          } catch { /* pointer is optional */ }
        }
      }
      found.add(status.rada_id);
      out.set(status.rada_id, status);
      this.remember(status.rada_id, status, now);
    }
    for (const id of missing) if (!found.has(id)) this.remember(id, null, now);
    return out;
  }

  private remember(id: string, value: ActStatus | null, ts: number): void {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(id, { value, ts });
  }
}
