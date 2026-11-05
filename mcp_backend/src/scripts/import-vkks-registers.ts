/**
 * Refresh the ВККС registers from data.gov.ua XLSX files (LEXAI-2126).
 *
 * vkks_judges, vkks_vacancies and vkks_evaluations were loaded once (2026-03-23) by a script
 * that is not in any repo, and stopped at 16.03.2026. Each table holds one snapshot, so a run
 * replaces it in one transaction; it refuses when the new snapshot is under 90% of the old one
 * (a truncated or re-shaped file must not empty the table).
 *
 * Usage (inside the backend container):
 *   node dist/scripts/import-vkks-registers.js judges <file.xlsx>
 *     dataset 9338e3fb «Список суддів»: row 1 «СПИСОК СУДДІВ СТАНОМ НА dd.mm.yyyy», row 2 header,
 *     columns № / Номер досьє / ПІБ / Стать / Найменування суду
 *   node dist/scripts/import-vkks-registers.js vacancies <file.xlsx>
 *     dataset f37f5de5: sheets МС / АС / ВСС / ВС, two header rows (3 = Гранична / Призначено /
 *     Вакантні / Триває процедура); only АС has a region column; ВСС uses formulas
 *   node dist/scripts/import-vkks-registers.js evaluations <dir>
 *     dataset 7fd5f184: <dir>/primary.xlsx (первинне), regular.xlsx (на відповідність посаді),
 *     disciplinary.xlsx (у зв'язку з дисциплінарним стягненням); missing values are "NA"
 *   --date YYYY-MM-DD overrides the snapshot date read from the title row.
 */

import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { xlsxCellValue } from '../services/ckan-multifile-import.js';

export type Grid = any[][];

const MIN_RATIO = 0.9;

export async function readSheets(file: string): Promise<Array<{ name: string; rows: Grid }>> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows: Grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      rows.push(Array.from(row.values as any[]).slice(1).map(xlsxCellValue));
    });
    return { name: ws.name.trim(), rows };
  });
}

export function str(v: any): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' || s === 'NA' || s === '-' ? null : s;
}

/** Whole number of positions; text such as «не розпочав роботу» or «-» -> null. */
export function int(v: any): number | null {
  const s = str(v);
  return s != null && /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

export function num(v: any): number | null {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function isoDate(v: any): string | null {
  const s = str(v);
  if (s == null) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** «… СТАНОМ НА  02.11.2026» in the title row -> 2026-11-02. */
export function snapshotDate(title: any): string | null {
  const m = String(title ?? '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ── judges ──────────────────────────────────────────────────────────────

export interface JudgeRow { dossier_number: string | null; full_name: string; gender: string | null; court_name: string | null }

export function parseJudges(rows: Grid): JudgeRow[] {
  const h = rows.findIndex((r) => r.some((c) => /досьє/i.test(String(c ?? ''))));
  if (h < 0) throw new Error('judges: no header row with «Номер досьє»');
  const head = rows[h].map((c) => String(c ?? '').toLowerCase());
  const col = (re: RegExp) => head.findIndex((c) => re.test(c));
  const ci = { dossier: col(/досьє/), name: col(/прізвище|піб/), gender: col(/^стать/), court: col(/найменування суду|^суд/) };
  if (Object.values(ci).some((i) => i < 0)) throw new Error(`judges: unexpected header ${JSON.stringify(rows[h])}`);
  const seen = new Set<string>();
  const out: JudgeRow[] = [];
  for (const r of rows.slice(h + 1)) {
    const full_name = str(r[ci.name]);
    if (!full_name) continue;
    // Keep the leading zeros: the cell may come back as a number.
    const d = str(r[ci.dossier]);
    const dossier_number = d && /^\d+$/.test(d) ? d.padStart(5, '0') : d;
    if (dossier_number) {
      if (seen.has(dossier_number)) continue;
      seen.add(dossier_number);
    }
    const g = str(r[ci.gender]);
    out.push({ dossier_number, full_name, gender: g ? g.charAt(0).toUpperCase() : null, court_name: str(r[ci.court]) });
  }
  return out;
}

// ── vacancies ───────────────────────────────────────────────────────────

const SHEET_LEVEL: Record<string, string> = {
  'МС': 'місцевий', 'АС': 'апеляційний', 'ВСС': 'вищий спеціалізований', 'ВС': 'верховний',
};

export interface VacancyRow {
  court_name: string; court_level: string; region: string | null;
  positions_limit: number | null; positions_filled: number | null;
  positions_vacant: number | null; positions_in_process: number | null;
}

export function parseVacancySheet(sheetName: string, rows: Grid): VacancyRow[] {
  const court_level = SHEET_LEVEL[sheetName.toUpperCase()];
  if (!court_level) return [];
  const h = rows.findIndex((r) => r.some((c) => /^гранична/i.test(String(c ?? '').trim())));
  if (h < 0) throw new Error(`vacancies ${sheetName}: no «Гранична» header row`);
  const head = rows[h].map((c) => String(c ?? '').toLowerCase());
  const lim = head.findIndex((c) => /^гранична/.test(c.trim()));
  const reg = head.findIndex((c) => /регіон/.test(c));
  const out: VacancyRow[] = [];
  for (const r of rows.slice(h + 1)) {
    const court_name = str(r[1]);
    if (!court_name || !/суд|палата/i.test(court_name)) continue;
    if (/^найменування/i.test(court_name) || /^гранична/i.test(String(r[lim] ?? '').trim())) continue; // header repeated
    out.push({
      court_name, court_level,
      region: reg >= 0 ? str(r[reg]) : null,
      positions_limit: int(r[lim]), positions_filled: int(r[lim + 1]),
      positions_vacant: int(r[lim + 2]), positions_in_process: int(r[lim + 3]),
    });
  }
  return out;
}

// ── evaluations ─────────────────────────────────────────────────────────

export interface EvaluationRow {
  dossier_number: string | null; judge_name: string; court_name: string | null;
  collegium_decision_date: string | null; collegium_decision_number: string | null;
  collegium_decision_essence: string | null; total_score: number | null;
  plenary_decision_date: string | null; plenary_decision_number: string | null;
  plenary_decision_essence: string | null; evaluation_type: string;
  decision_url: string | null; decision_file_url: string | null; notes: string | null;
}

export function parseEvaluations(rows: Grid, evaluationType: string): EvaluationRow[] {
  const h = rows.findIndex((r) => r.some((c) => String(c ?? '').trim() === 'dossier_code'));
  if (h < 0) throw new Error(`evaluations ${evaluationType}: no «dossier_code» header`);
  const head = rows[h].map((c) => String(c ?? '').trim());
  const at = (r: any[], ...names: string[]) => {
    for (const n of names) {
      const i = head.findIndex((c) => c === n || c.startsWith(n));
      if (i >= 0 && str(r[i]) != null) return r[i];
    }
    return null;
  };
  const out: EvaluationRow[] = [];
  for (const r of rows.slice(h + 1)) {
    const judge_name = str(at(r, 'judge'));
    if (!judge_name) continue;
    const d = str(at(r, 'dossier_code'));
    out.push({
      dossier_number: d && /^\d+$/.test(d) ? d.padStart(5, '0') : d,
      judge_name,
      court_name: str(at(r, 'court')),
      collegium_decision_date: isoDate(at(r, 'panel_decision_date', 'decision_date')),
      collegium_decision_number: str(at(r, 'panel_decision_number', 'decision_number')),
      collegium_decision_essence: str(at(r, 'panel_decision_essence', 'core_of_the_decision')),
      total_score: num(at(r, 'overall_score')),
      plenary_decision_date: isoDate(at(r, 'plenary_or_chamber_decision_date')),
      plenary_decision_number: str(at(r, 'plenary_or_chamber_decision_numb')),
      plenary_decision_essence: str(at(r, 'plenary_or_chamber_decision_esse')),
      evaluation_type: evaluationType,
      decision_url: str(at(r, 'panel_decision_web', 'decision_url', 'plenary_or_chamber_decision_web')),
      decision_file_url: str(at(r, 'panel_decision_file', 'decision_file', 'plenary_or_chamber_decision_file')),
      notes: str(at(r, 'notes')),
    });
  }
  return out;
}

// ── load ────────────────────────────────────────────────────────────────

async function replaceTable(
  pool: Pool, table: string, rows: Record<string, any>[], extra: Record<string, any>,
): Promise<void> {
  if (rows.length === 0) throw new Error(`${table}: source gave 0 rows, table left as is`);
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    if (rows.length < n * MIN_RATIO) {
      throw new Error(`${table}: ${rows.length} new rows < ${MIN_RATIO} × ${n} current, table left as is`);
    }
    await client.query(`DELETE FROM ${table}`);
    const cols = [...Object.keys(rows[0]), ...Object.keys(extra)];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values: any[] = [];
      const ph = chunk.map((r) => {
        const vals = [...Object.values(r), ...Object.values(extra)];
        const start = values.length;
        values.push(...vals);
        return `(${vals.map((_, j) => `$${start + j + 1}`).join(',')})`;
      });
      await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}`, values);
    }
    await client.query('COMMIT');
    console.log(`✅ ${table}: ${n} -> ${rows.length} rows`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const [kind, target] = process.argv.slice(2);
  const di = process.argv.indexOf('--date');
  const dateArg = di > 0 ? process.argv[di + 1] : null;
  if (!kind || !target) throw new Error('usage: import-vkks-registers.js judges|vacancies|evaluations <file|dir> [--date YYYY-MM-DD]');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_prod',
    max: 2,
  });
  try {
    if (kind === 'judges') {
      const [sheet] = await readSheets(target);
      const date = dateArg || snapshotDate(sheet.rows[0]?.[0]);
      if (!date) throw new Error('judges: no «станом на» date in the title row; pass --date');
      await replaceTable(pool, 'vkks_judges', parseJudges(sheet.rows), { source_date: date });
    } else if (kind === 'vacancies') {
      const sheets = await readSheets(target);
      const date = dateArg || snapshotDate(sheets[0]?.rows[0]?.[0]);
      if (!date) throw new Error('vacancies: no date in the title row; pass --date');
      const rows = sheets.flatMap((s) => parseVacancySheet(s.name, s.rows));
      await replaceTable(pool, 'vkks_vacancies', rows, { report_date: date, source: 'data.gov.ua' });
    } else if (kind === 'evaluations') {
      const rows: EvaluationRow[] = [];
      for (const type of ['primary', 'regular', 'disciplinary']) {
        const f = path.join(target, `${type}.xlsx`);
        if (!fs.existsSync(f)) {
          if (type === 'disciplinary') continue;
          throw new Error(`evaluations: ${f} is missing`);
        }
        const [sheet] = await readSheets(f);
        rows.push(...parseEvaluations(sheet.rows, type));
      }
      await replaceTable(pool, 'vkks_evaluations', rows, { source: 'data.gov.ua' });
    } else {
      throw new Error(`unknown kind ${kind}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('❌', err.message || err); process.exit(1); });
}
