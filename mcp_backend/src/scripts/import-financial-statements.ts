/**
 * Refresh opendata_financial_statements from the ДПС «Фінансова звітність підприємств»
 * dumps (data.gov.ua). Reads the ZIP archives under /data/opendata/finrep/{annual,quarterly}/,
 * each holding many KEP-signed XML filings. For every filing the <DECLAR> payload is located
 * inside the signed envelope, its DECLARHEAD fields are extracted, and one row is upserted by
 * (tin, period_year, form_type, c_doc_sub).
 *
 * Heavy: ~713K filings / ~3.7 GB. Run in the background; idempotent (ON CONFLICT).
 * A filing whose XML is unchanged is left alone, so imported_at marks real changes only
 * (backfill-financial-figures --incremental re-reads rows by it). Codes longer than 8
 * digits (sole traders' personal tax numbers) are skipped.
 *
 * Usage:
 *   npx tsx src/scripts/import-financial-statements.ts [root]
 *   default: /data/opendata/finrep
 *   node dist/scripts/import-financial-statements.js file1.zip [file2.zip ...]
 *   (explicit archives, in the given order: the weekly finzvit archive job passes the
 *   newly archived resources, oldest last_modified first)
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const DEFAULT_ROOT = '/data/opendata/finrep';
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

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() || null : null;
};
const toInt = (v: string | null): number | null => (v && /^\d+$/.test(v) ? parseInt(v) : null);

function parseFiling(buf: Buffer): any | null {
  // The signed envelope has binary before the payload; locate the <DECLAR ...>...</DECLAR>.
  const raw = buf.toString('latin1');
  const start = raw.indexOf('<DECLAR');
  const endTag = raw.lastIndexOf('</DECLAR>');
  if (start < 0 || endTag < 0) return null;
  // Re-decode just the payload as UTF-8 (the XML declares encoding="UTF-8").
  const declarXml = buf.slice(Buffer.byteLength(raw.slice(0, start), 'latin1'),
    Buffer.byteLength(raw.slice(0, endTag), 'latin1') + '</DECLAR>'.length).toString('utf8');

  const head = declarXml.slice(0, declarXml.indexOf('</DECLARHEAD>') + 13 || 4000);
  const tin = tag(head, 'TIN');
  const periodYear = toInt(tag(head, 'PERIOD_YEAR'));
  const cDocSub = tag(head, 'C_DOC_SUB');
  const fm = declarXml.match(/noNamespaceSchemaLocation="([^"]+?)\.XSD"/i);
  const formType = fm ? fm[1] : null;
  if (!tin || periodYear == null || !formType || !cDocSub) return null;
  // A sole trader's personal tax number is personal data: not loaded.
  if (!/^\d{1,8}$/.test(tin)) return null;

  return {
    tin,
    c_doc: tag(head, 'C_DOC'),
    c_doc_sub: cDocSub,
    c_doc_ver: tag(head, 'C_DOC_VER'),
    period_year: periodYear,
    period_month: toInt(tag(head, 'PERIOD_MONTH')) ?? 0, // 0 = unknown; keeps the unique key non-null
    period_type: toInt(tag(head, 'PERIOD_TYPE')),
    c_reg: tag(head, 'C_REG'),
    c_raj: tag(head, 'C_RAJ'),
    form_type: formType,
    raw_xml: declarXml,
  };
}

/**
 * Yield every XML payload inside a zip, recursing into nested `.zip` entries.
 * The ДПС dumps come in two shapes: flat (outer zip → XML) and nested
 * (outer zip → per-form inner zip → XML). The nested archives hold the main
 * annual річні звіти, so both must be walked.
 */
function* collectXmls(zip: AdmZip, stats: { badNested: number }): Generator<Buffer> {
  for (const en of zip.getEntries()) {
    if (en.isDirectory) continue;
    const name = en.entryName.toLowerCase();
    if (name.endsWith('.xml')) {
      yield en.getData();
    } else if (name.endsWith('.zip')) {
      let inner: AdmZip;
      try { inner = new AdmZip(en.getData()); } catch { stats.badNested++; continue; }
      yield* collectXmls(inner, stats);
    }
  }
}

async function insertBatch(rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  // One row per key, the LAST one read: archives are passed oldest first and each is
  // flushed before the next, so a later filing replaces an earlier one.
  const byKey = new Map<string, any>();
  for (const r of rows) byKey.set(`${r.tin}|${r.period_year}|${r.period_month}|${r.form_type}|${r.c_doc_sub}`, r);
  const deduped = [...byKey.values()];
  const values: any[] = [];
  const ph: string[] = [];
  let i = 1;
  for (const r of deduped) {
    const cols = [r.tin, r.c_doc, r.c_doc_sub, r.c_doc_ver, r.period_year, r.period_month,
      r.period_type, r.c_reg, r.c_raj, r.form_type, r.raw_xml];
    ph.push(`(${cols.map(() => `$${i++}`).join(',')})`);
    values.push(...cols);
  }
  const sql = `
    INSERT INTO opendata_financial_statements
      (tin, c_doc, c_doc_sub, c_doc_ver, period_year, period_month, period_type,
       c_reg, c_raj, form_type, raw_xml)
    VALUES ${ph.join(',')}
    ON CONFLICT (tin, period_year, period_month, form_type, c_doc_sub) DO UPDATE SET
      c_doc = EXCLUDED.c_doc, c_doc_ver = EXCLUDED.c_doc_ver, period_month = EXCLUDED.period_month,
      period_type = EXCLUDED.period_type, c_reg = EXCLUDED.c_reg, c_raj = EXCLUDED.c_raj,
      raw_xml = EXCLUDED.raw_xml, imported_at = NOW()
    WHERE opendata_financial_statements.raw_xml IS DISTINCT FROM EXCLUDED.raw_xml
  `;
  const res = await pool.query(sql, values);
  return res.rowCount || 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const explicit = args.length > 0 && args.every((a) => a.toLowerCase().endsWith('.zip'));
  const root = explicit ? '(explicit archives)' : (args[0] || DEFAULT_ROOT);
  console.log(`📥 Financial statements refresh from ${root}`);
  const zips: string[] = [];
  if (explicit) {
    for (const a of args) {
      if (!fs.existsSync(a)) { console.error(`❌ Not found: ${a}`); process.exit(1); }
      zips.push(a);
    }
  } else {
    if (!fs.existsSync(root)) { console.error(`❌ Not found: ${root}`); process.exit(1); }
    for (const sub of ['annual', 'quarterly']) {
      const d = path.join(root, sub);
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.zip')) zips.push(path.join(d, f));
    }
  }
  await pool.query('SELECT 1');
  console.log(`   ${zips.length} archives`);

  let total = 0, parsed = 0, skipped = 0;
  let batch: any[] = [];
  const failed: string[] = [];
  for (const zp of zips) {
    const base = path.basename(zp);
    let zip: AdmZip;
    try { zip = new AdmZip(zp); } catch (e: any) {
      console.warn(`   ⚠️ ${base}: ${e.message}`);
      failed.push(base);
      continue;
    }
    const stats = { badNested: 0 };
    const parsedBefore = parsed;
    for (const xmlBuf of collectXmls(zip, stats)) {
      let row: any = null;
      try { row = parseFiling(xmlBuf); } catch { /* skip corrupt */ }
      if (!row) { skipped++; continue; }
      parsed++;
      batch.push(row);
      if (batch.length >= BATCH_SIZE) { total += await insertBatch(batch); batch = []; }
    }
    // Flush at the archive boundary, so a later archive's filing always lands after this one's.
    if (batch.length) { total += await insertBatch(batch); batch = []; }
    if (stats.badNested > 0 || parsed === parsedBefore) {
      console.warn(`   ⚠️ ${base}: ${stats.badNested} unreadable nested archive(s), ${parsed - parsedBefore} filings`);
      failed.push(base);
    }
    console.log(`   ${base}: parsed ${parsed}, upserted ${total}, skipped ${skipped}`);
  }
  console.log(`✅ Financial statements: ${total} rows upserted (${parsed} parsed, ${skipped} skipped)`);
  await pool.end();
  // Explicit archives are the weekly job's input: an unreadable or empty one fails the run,
  // so the job keeps it pending instead of reporting success.
  if (explicit && failed.length) {
    console.error(`❌ ${failed.length} archive(s) unreadable or without filings: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
