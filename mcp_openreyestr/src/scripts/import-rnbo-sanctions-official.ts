/**
 * Refresh the openreyestr `rnbo_sanctions` table from the OFFICIAL Держреєстр санкцій
 * РНБО dump (drs.nsdc.gov.ua), replacing the stale OpenSanctions crawl.
 *
 * Why: the `openreyestr_search_rnbo_sanctions` chat tool queries rnbo_sanctions, which
 * was loaded from OpenSanctions `ua_nsdc_sanctions` (CC-BY-NC, ~3.5 months stale, 21K).
 * The official registry dump is licence-clean, fresher and more complete (24K incl.
 * vessels). This keeps the established tool path but on official data, so it does not
 * collide with the raw `opendata_drs_sanctions` search_registry copy.
 *
 * The table is standalone (no cross-references to entity_id), so the reload is a plain
 * atomic TRUNCATE + INSERT. Searchable columns (name, aliases, schema_type, countries,
 * identifiers — all ILIKE) are fully populated.
 *
 * Usage:
 *   npx tsx src/scripts/import-rnbo-sanctions-official.ts [path]
 *   default path: /data/opendata/drs/drs_subjects_full.json
 *   DB: POSTGRES_HOST/PORT/USER/PASSWORD/DB (point at openreyestr_prod).
 */

import { Pool } from 'pg';
import * as fs from 'fs';

const DEFAULT_PATH = '/data/opendata/drs/drs_subjects_full.json';
const BATCH_SIZE = 500;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'openreyestr',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'openreyestr_prod',
  max: 5,
});

const SCHEMA_TYPE: Record<string, string> = { individual: 'Person', legal: 'Organization', vessel: 'Vessel' };

function citizenshipsText(cs: any[]): string {
  return (cs || []).map(c => [c?.name, c?.code].filter(Boolean).join(' ')).filter(Boolean).join('; ');
}

/** Flatten subjectIdentifiers ({tax:[{code,type,country}], passport:[...], ...}) into a
 *  single ILIKE-searchable string of codes + type + country. */
function identifiersText(ids: any): string {
  if (!ids || typeof ids !== 'object') return '';
  const parts: string[] = [];
  for (const group of Object.values(ids) as any[]) {
    for (const it of (Array.isArray(group) ? group : [group])) {
      if (!it) continue;
      parts.push([it.code, it.type, it.country].filter(Boolean).join(' '));
    }
  }
  return parts.filter(Boolean).join('; ');
}

function mapRow(s: any, id: number, fetchedAt: string): any[] {
  return [
    id,
    `DRS-${s.subjectId}`,
    SCHEMA_TYPE[s.subjectType] || 'LegalEntity',
    s.subjectName || null,
    (s.subjectAliases || []).join('; ') || null,
    s.subjectBirthDate || null,
    citizenshipsText(s.subjectCitizenships) || null,
    null,                                   // addresses (not in the official raw dump)
    identifiersText(s.subjectIdentifiers) || null,
    s.subjectStatus || null,                // sanctions: active | expired | excluded
    null, null, null,                       // phones, emails, program_ids
    'Ukraine NSDC State Register of Sanctions',
    // LEXAI-2167: the subjects dump has no listing/decree dates. Only last_seen
    // (= snapshot time) is known; first_seen/last_change stay NULL so nothing reads
    // the import time as the sanction date. The tool reports listing_date: null.
    null, fetchedAt, null,                  // first_seen, last_seen, last_change
  ];
}

const COLS = 'id, entity_id, schema_type, name, aliases, birth_date, countries, addresses, ' +
  'identifiers, sanctions, phones, emails, program_ids, dataset, first_seen, last_seen, last_change';

async function insertBatch(client: any, rows: any[][]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: any[] = [];
  const ph: string[] = [];
  let i = 1;
  for (const r of rows) {
    ph.push(`(${r.map(() => `$${i++}`).join(',')})`);
    values.push(...r);
  }
  const res = await client.query(`INSERT INTO rnbo_sanctions (${COLS}) VALUES ${ph.join(',')}`, values);
  return res.rowCount || 0;
}

async function main(): Promise<void> {
  const path = process.argv[2] || DEFAULT_PATH;
  console.log(`📥 rnbo_sanctions official refresh from ${path}`);
  if (!fs.existsSync(path)) { console.error(`❌ Not found: ${path}`); process.exit(1); }
  const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
  const items: any[] = doc.items || [];
  const fetchedAt = doc.fetchedAt || new Date().toISOString();
  console.log(`   subjects: ${items.length}, snapshot: ${fetchedAt}`);

  const client = await pool.connect();
  try {
    const before = (await client.query('SELECT count(*) FROM rnbo_sanctions')).rows[0].count;
    console.log(`   rows before: ${before}`);
    await client.query('BEGIN');
    await client.query('TRUNCATE rnbo_sanctions');
    let imported = 0, id = 1;
    let batch: any[][] = [];
    for (const s of items) {
      batch.push(mapRow(s, id++, fetchedAt));
      if (batch.length >= BATCH_SIZE) { imported += await insertBatch(client, batch); batch = []; }
    }
    if (batch.length) imported += await insertBatch(client, batch);
    await client.query('COMMIT');
    console.log(`✅ rnbo_sanctions reloaded: ${imported} official rows (was ${before})`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
