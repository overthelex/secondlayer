/**
 * Import АМКУ «Зведені відомості про спотворення результатів торгів (тендерів)»
 * (bid-rigging consolidated data) into opendata_amcu_bid_rigging.
 *
 * Reads all XLSX files under /data/opendata/amcu/zvedeni-vidomosti-torhy/.
 * Row 1 = machine headers, row 2 = Ukrainian descriptions (skipped), data from row 3.
 * Key columns: identifier (ЄДРПОУ), theEntityThatCommittedTheViolation, dateOfDecision.
 *
 * NOTE: the machine-header SET varies across the 252 source files (9 variants):
 * some files use lowercase keys (identifier), others PascalCase or spaced
 * (Identifier, DateOfDecision, "Cour CaseNumber"), and one legacy file has purely
 * positional headers (col1..col14). To map structural columns reliably we normalise
 * every header via norm(k) = k.toLowerCase().replace(/\s+/g,'') and look up values by
 * the normalised key. The full row_data is always preserved verbatim.
 *
 * Usage:
 *   npx tsx src/scripts/import-amcu-bid-rigging.ts [dir]
 *   default dir: /data/opendata/amcu/zvedeni-vidomosti-torhy
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { parseBidRiggingDate, sourceFileDateOf } from './amcu-dates.js';

const DEFAULT_DIR = '/data/opendata/amcu/zvedeni-vidomosti-torhy';
const BATCH_SIZE = 500;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'secondlayer',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'secondlayer_prod',
  max: 5,
});

function cellText(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.richText) return v.richText.map((t: any) => t.text).join('');
    return null;
  }
  return String(v).trim() || null;
}

/** dateOfDecision → YYYY-MM-DD; a date after the list's publication date is read day/month-swapped (LEXAI-2118). */
function toDate(v: any, notAfter: string | null): string | null {
  if (v instanceof Date) return parseBidRiggingDate(v.toISOString().slice(0, 10), notAfter);
  return parseBidRiggingDate(cellText(v), notAfter);
}

/** Normalise a header key so PascalCase/spaced/lowercase variants collapse to one key. */
function norm(k: string): string {
  return k.toLowerCase().replace(/\s+/g, '');
}

/** Build a normalisedKey -> value index for a row (first non-null wins on collisions). */
function buildNormIndex(rowData: Record<string, any>): Record<string, string | null> {
  const idx: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(rowData)) {
    const nk = norm(k);
    if (idx[nk] == null) idx[nk] = v as string | null;
  }
  return idx;
}

/**
 * Sanitise a ЄДРПОУ candidate: cyrillic О/о -> 0, strip leading/trailing dots and
 * spaces, then require exactly 6-10 digits. Returns null if it does not qualify.
 */
function sanitizeEdrpou(v: any): string | null {
  let s = cellText(v);
  if (!s) return null;
  s = s.replace(/[Оо]/g, '0');        // cyrillic O -> zero
  s = s.replace(/^[.\s]+|[.\s]+$/g, '').trim();
  return /^\d{6,10}$/.test(s) ? s : null;
}

/**
 * Detect a machine/description/legend header row (present at row 2 and, in the legacy
 * positional file, rows 3-5). Uses normalised-key lookups so it works for every header
 * variant, preventing header text from leaking into entity_name.
 */
function looksLikeDescriptionRow(idx: Record<string, string | null>): boolean {
  const id = String(idx['identifier'] ?? '');
  const dd = String(idx['dateofdecision'] ?? '');
  const ent = String(idx['theentitythatcommittedtheviolation'] ?? '');
  const num = String(idx['number'] ?? '');
  return (
    id.includes('ЄДРПОУ') || id.includes('Ідентифікаційний') ||
    dd.includes('Дата') || dd.includes('рішення у справі') ||
    ent.includes('який вчинив порушення') ||
    num.includes('за порядком') || num.includes('по порядку')
  );
}

async function insertBatch(rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: any[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const r of rows) {
    const cols = [r.source_file, r.row_num, r.decision_date, r.entity_name, r.entity_edrpou, JSON.stringify(r.row_data)];
    placeholders.push(`(${cols.map(() => `$${i++}`).join(',')})`);
    values.push(...cols);
  }
  const sql = `
    INSERT INTO opendata_amcu_bid_rigging
      (source_file, row_num, decision_date, entity_name, entity_edrpou, row_data)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (source_file, row_num) DO UPDATE SET
      decision_date = EXCLUDED.decision_date,
      entity_name = EXCLUDED.entity_name,
      entity_edrpou = EXCLUDED.entity_edrpou,
      row_data = EXCLUDED.row_data,
      imported_at = NOW()
  `;
  const res = await pool.query(sql, values);
  return res.rowCount || 0;
}

async function importFile(file: string): Promise<number> {
  const base = path.basename(file);
  const publishedOn = sourceFileDateOf(base);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) return 0;

  const headerVals = ws.getRow(1).values as any[];
  const headers: string[] = [];
  for (let c = 1; c < headerVals.length; c++) {
    headers[c] = cellText(headerVals[c]) || `col${c}`;
  }

  let imported = 0;
  let batch: any[] = [];
  for (let rn = 2; rn <= ws.rowCount; rn++) {
    const rowVals = ws.getRow(rn).values as any[];
    if (!rowVals || rowVals.length <= 1) continue;
    const rowData: Record<string, any> = {};
    let hasContent = false;
    for (let c = 1; c < headers.length; c++) {
      const t = cellText(rowVals[c]);
      if (t != null) hasContent = true;
      rowData[headers[c]] = t;
    }
    if (!hasContent) continue;

    // Header-agnostic field access: look up structural columns by normalised header.
    const idx = buildNormIndex(rowData);

    // Skip machine/description/legend header rows regardless of header variant so their
    // text never lands in entity_name (row 2 in every file; rows 3-5 in the legacy file).
    if (looksLikeDescriptionRow(idx)) continue;

    let entityName: string | null = idx['theentitythatcommittedtheviolation'] ?? null;
    let edrpouRaw: any = idx['identifier'];
    let dateRaw: any = idx['dateofdecision'];

    // Best-effort positional fallback for the legacy col1..col14 file, which has no
    // machine keys. Column order there: col5=Дата рішення, col7=Суб'єкт, col8=ЄДРПОУ.
    // Only treat it as a data row when a plausible ЄДРПОУ or date is present.
    if (entityName == null && edrpouRaw == null && dateRaw == null) {
      const posEdrpou = sanitizeEdrpou(rowData['col8']);
      const posDate = toDate(rowData['col5'], publishedOn);
      if (posEdrpou || posDate) {
        entityName = (rowData['col7'] as string | null) ?? null;
        edrpouRaw = rowData['col8'];
        dateRaw = rowData['col5'];
      }
    }

    batch.push({
      source_file: base,
      row_num: rn,
      decision_date: toDate(dateRaw, publishedOn),
      entity_name: (typeof entityName === 'string' && entityName.trim()) ? entityName.trim() : null,
      entity_edrpou: sanitizeEdrpou(edrpouRaw),
      row_data: rowData,
    });
    if (batch.length >= BATCH_SIZE) { imported += await insertBatch(batch); batch = []; }
  }
  if (batch.length) imported += await insertBatch(batch);
  return imported;
}

async function main(): Promise<void> {
  const dir = process.argv[2] || DEFAULT_DIR;
  console.log(`📥 АМКУ bid-rigging import from ${dir}`);
  if (!fs.existsSync(dir)) { console.error(`❌ Dir not found: ${dir}`); process.exit(1); }
  await pool.query('SELECT 1');
  const files = fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f));
  let total = 0, done = 0;
  for (const f of files) {
    try {
      total += await importFile(path.join(dir, f));
    } catch (e: any) {
      console.warn(`   ⚠️ ${f}: ${e.message}`);
    }
    if (++done % 25 === 0) console.log(`   ${done}/${files.length} files, ${total} rows`);
  }
  console.log(`✅ АМКУ bid-rigging: ${total} rows from ${files.length} files`);
  await pool.end();
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
