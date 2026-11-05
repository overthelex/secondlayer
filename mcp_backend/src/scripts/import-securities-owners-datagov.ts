/**
 * Refresh opendata_securities_owners from the НКЦПФР "власники значних пакетів акцій"
 * quarterly dumps (data.gov.ua dataset nssmc-001).
 *
 * Reads /data/opendata/smida/datagov_nssmc/owners/*.csv — headerless, windows-1251,
 * semicolon-delimited, 15 positional columns:
 *   0 report_date  1 issuer_edrpou  2 issuer_name  3 isin  4 owner_edrpou
 *   5 owner surname / entity name  6 owner first name  7 owner patronymic
 *   8 depositor_type_code  9 owner_reg_id  10 security_type  11 nominal_value_per_share
 *   12 share_percent (частка в статутному капіталі)  13 share_count (кількість акцій)
 *   14 country_code (країна реєстрації власника)
 *
 * Since 2024 the files (holders/YYYY/Q on data.gov.ua) start with a header line
 * ("Код";"fid";"z_edre";…) and a leading row-number column; the remaining 15
 * columns are the same, so the header is skipped and column 0 dropped.
 *
 * The full raw row is preserved in raw_data; upsert matches the existing unique index.
 *
 * Usage:
 *   npx tsx src/scripts/import-securities-owners-datagov.ts [dir]
 *   default: /data/opendata/smida/datagov_nssmc/owners
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_DIR = '/data/opendata/smida/datagov_nssmc/owners';
const BATCH_SIZE = 500;
const win1251 = new TextDecoder('windows-1251');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'secondlayer',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'secondlayer_prod',
  max: 5,
});

/** Parse one delimited line honouring "" quotes (2025 Q1–Q2 files use commas). */
function parseLine(line: string, delim = ';'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function toDate(v: string): string | null {
  let m = v.match(/(\d{4})-(\d{2})-(\d{2})/); // ISO yyyy-mm-dd (2018–2021 files)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); // d.m.yyyy (2022+ files)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function toNum(v: string): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
/** Clamp to a NUMERIC(precision, scale) column; out-of-range → null (raw kept in raw_data). */
function numFit(n: number | null, maxInteger: number): number | null {
  return n != null && Math.abs(n) < maxInteger ? n : null;
}
function toInt(v: string): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = parseInt(v);
  return n <= 2147483647 ? n : null; // int4 range (country_code); out-of-range → null
}

function mapRow(c: string[], reportDateFallback: string | null): any | null {
  const reportDate = (c[0] && toDate(c[0])) || reportDateFallback;
  const issuerEdrpou = c[1] || null;
  if (!reportDate || !issuerEdrpou) return null;
  const ownerEdrpou = c[4] || null;
  const ownerName = ownerEdrpou
    ? (c[5] || null)                                  // legal entity → name in col5
    : ([c[5], c[6], c[7]].filter(Boolean).join(' ') || null); // individual → ПІБ
  return {
    report_date: reportDate,
    issuer_edrpou: issuerEdrpou,
    issuer_name: c[2] || null,
    isin_code: c[3] || null,
    owner_edrpou: ownerEdrpou,
    owner_name: ownerName,
    owner_name_alt: null,
    owner_type: ownerEdrpou ? 'legal' : 'individual',
    share_percent: (v => (v != null && v >= 0 && v <= 100 ? v : null))(toNum(c[12])),  // col12 частка; a share % >100 signals a malformed/column-shifted source row → null
    nominal_value: numFit(toNum(c[11]), 1e16),   // col11 номінальна вартість, numeric(18,2)
    share_count: (v => (v == null ? null : Math.round(v)))(toNum(c[13])),  // col13 кількість акцій (bigint)
    country_code: toInt(c[14]),                  // col14 країна реєстрації
    raw_data: c,
  };
}

async function insertBatch(rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  // dedupe within batch on the unique key
  const seen = new Set<string>();
  const deduped = rows.filter(r => {
    const k = `${r.report_date}|${r.issuer_edrpou}|${r.owner_edrpou || ''}|${r.owner_name || ''}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const values: any[] = [];
  const ph: string[] = [];
  let i = 1;
  for (const r of deduped) {
    const cols = [r.report_date, r.issuer_edrpou, r.issuer_name, r.isin_code, r.owner_edrpou,
      r.owner_name, r.owner_name_alt, r.owner_type, r.share_percent, r.nominal_value,
      r.share_count, r.country_code, JSON.stringify(r.raw_data)];
    ph.push(`(${cols.map(() => `$${i++}`).join(',')})`);
    values.push(...cols);
  }
  const sql = `
    INSERT INTO opendata_securities_owners
      (report_date, issuer_edrpou, issuer_name, isin_code, owner_edrpou, owner_name,
       owner_name_alt, owner_type, share_percent, nominal_value, share_count, country_code, raw_data)
    VALUES ${ph.join(',')}
    ON CONFLICT (report_date, issuer_edrpou, coalesce(owner_edrpou, ''), coalesce(owner_name, ''))
    DO UPDATE SET
      issuer_name = EXCLUDED.issuer_name, isin_code = EXCLUDED.isin_code,
      owner_type = EXCLUDED.owner_type, share_percent = EXCLUDED.share_percent,
      nominal_value = EXCLUDED.nominal_value, share_count = EXCLUDED.share_count,
      country_code = EXCLUDED.country_code,
      raw_data = EXCLUDED.raw_data, imported_at = NOW()
  `;
  const res = await pool.query(sql, values);
  return res.rowCount || 0;
}

function reportDateFromName(f: string): string | null {
  // "1-qv-2024.csv", "data-4-qv-2025.csv", "owners_2020_q3.csv" → last day of the quarter
  let m = f.match(/(\d)-qv-(\d{4})/);
  let q: number, y: string;
  if (m) { q = parseInt(m[1]); y = m[2]; }
  else if ((m = f.match(/_(\d{4})_q(\d)/))) { y = m[1]; q = parseInt(m[2]); }
  else if ((m = f.match(/holders_(\d{4})_(\d)\b/))) { y = m[1]; q = parseInt(m[2]); }
  else return null;
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  return q >= 1 && q <= 4 ? `${y}-${ends[q - 1]}` : null;
}

/** 2024+ files carry a header line: "Код";"fid";"z_edre";… */
function isHeader(cells: string[]): boolean {
  return cells.some(c => /^(fid|z_edre)$/i.test(c));
}

async function importFile(file: string): Promise<number> {
  const buf = fs.readFileSync(file);
  const text = win1251.decode(buf);
  const fallback = reportDateFromName(path.basename(file));
  let imported = 0, batch: any[] = [];
  let dropLead = false;
  let first = true;
  let delim = ';';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (first) delim = parseLine(line, ';').length >= 10 ? ';' : ',';
    let cells = parseLine(line, delim);
    if (first) {
      first = false;
      if (isHeader(cells)) { dropLead = cells[0].toLowerCase() === 'код'; continue; }
    }
    if (dropLead) cells = cells.slice(1);
    const row = mapRow(cells, fallback);
    if (!row) continue;
    batch.push(row);
    if (batch.length >= BATCH_SIZE) { imported += await insertBatch(batch); batch = []; }
  }
  if (batch.length) imported += await insertBatch(batch);
  return imported;
}

async function main(): Promise<void> {
  const dir = process.argv[2] || DEFAULT_DIR;
  console.log(`📥 НКЦПФР owners refresh from ${dir}`);
  if (!fs.existsSync(dir)) { console.error(`❌ Not found: ${dir}`); process.exit(1); }
  await pool.query('SELECT 1');
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  let total = 0;
  for (const f of files) {
    const n = await importFile(path.join(dir, f));
    total += n;
    console.log(`   ${f}: ${n}`);
  }
  console.log(`✅ Securities owners: ${total} rows upserted from ${files.length} files`);
  await pool.end();
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
