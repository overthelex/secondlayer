/**
 * Import ДПС financial statements for 2020 (filed with the tax returns) into
 * financial_figures, source 'dps2020'.
 *
 * Source: data.gov.ua package 24069422-5825-41f6-81f7-89567e5e2ac9, file
 * pokaznyk_fin.zvit.zip (≈60 MB, published once in May 2021). Inside, one CSV per form
 * (utf-8 with BOM, ';', quoted): J09001xx Форма 1, J09002xx Форма 2, J09011xx 1-м,
 * J09012xx 1-мс. The consolidated, bank and public-sector forms are skipped.
 * Parsing: services/dps2020-financial-csv.ts. Codes longer than 8 digits (sole traders'
 * personal tax numbers) are skipped.
 *
 * Written in TypeScript, not Python, so it shares the cell rules, the summary amounts
 * and the later-filing-wins upsert with the backfill, and runs from the backend image
 * (adm-zip is already a dependency) with no extra runtime on the host.
 *
 * Usage (in the backend image; idempotent, a rerun replaces rows):
 *   node dist/scripts/import-dps2020-financial-figures.js /path/pokaznyk_fin.zvit.zip \
 *     [--batch 2000] [--statement-timeout 120s] [--dry-run]
 */

import { Pool } from 'pg';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { FinancialFigureRow } from '../api/tools/financial-statement-figures.js';
import { csvRecords, DPS_ENTRY, DPS_FORM_BY_ENTRY, dpsRow } from '../services/dps2020-financial-csv.js';
import { statementTimeoutLiteral, upsertFigureRows } from '../services/financial-figures-store.js';

function parseArgs(argv: string[]) {
  const o = { file: '', batch: 2000, timeout: '120s', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') o.batch = Math.max(100, parseInt(argv[++i] ?? '', 10) || 2000);
    else if (a === '--statement-timeout') o.timeout = statementTimeoutLiteral(argv[++i] ?? '');
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.file = a;
  }
  if (!o.file) throw new Error('usage: import-dps2020-financial-figures.js <pokaznyk_fin.zvit.zip> [--batch N] [--statement-timeout 120s] [--dry-run]');
  return o;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'secondlayer',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'secondlayer_local',
    max: 1,
    application_name: 'import-dps2020-financial-figures',
  });
  const client = await pool.connect();
  await client.query(`SET statement_timeout = '${o.timeout}'`);
  const started = Date.now();
  let totalRead = 0, totalRows = 0, totalWritten = 0, skipped = 0;
  try {
    const zip = new AdmZip(o.file);
    const zipName = path.basename(o.file);
    for (const entry of zip.getEntries()) {
      const base = path.basename(entry.entryName);
      const m = DPS_ENTRY.exec(base);
      if (entry.isDirectory || !m || !base.toLowerCase().endsWith('.csv')) continue;
      const form = DPS_FORM_BY_ENTRY[m[1]];
      const text = entry.getData().toString('utf8').replace(/^﻿/, '');
      let header: string[] | null = null;
      let batch: FinancialFigureRow[] = [];
      let read = 0, rows = 0, written = 0;
      const flush = async () => {
        if (!batch.length) return;
        if (!o.dryRun) written += await upsertFigureRows(client, batch);
        batch = [];
      };
      for (const rec of csvRecords(text)) {
        if (!header) { header = rec.map((h) => h.trim().toUpperCase()); continue; }
        read++;
        const row = dpsRow(header, rec, form, `${zipName}/${base}`);
        if (!row) { skipped++; continue; }
        rows++;
        batch.push(row);
        if (batch.length >= o.batch) await flush();
      }
      await flush();
      console.log(`  ${base}: form ${form}, ${read} records, ${rows} rows, ${written} written`);
      totalRead += read; totalRows += rows; totalWritten += written;
    }
    console.log(`Done: ${totalRead} records, ${totalRows} rows, ${totalWritten} written, ${skipped} skipped `
      + `in ${((Date.now() - started) / 1000).toFixed(1)} s${o.dryRun ? ' (dry run)' : ''}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  process.exit(1);
});
