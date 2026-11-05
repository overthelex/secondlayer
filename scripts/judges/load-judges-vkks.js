#!/usr/bin/env node

/**
 * Load judges data from VKKS (Higher Qualification Commission of Judges of Ukraine)
 * Source: https://data.gov.ua/dataset/354d406b-53cc-4788-a384-78b9abaf2ea0
 *
 * Downloads all weekly XLSX snapshots (84+ files) in parallel (10 threads),
 * parses them, and loads into PostgreSQL.
 *
 * Usage:
 *   node scripts/judges/load-judges-vkks.js [--latest-only] [--concurrency=10]
 *
 * Env:
 *   DATABASE_URL or POSTGRES_* vars for DB connection
 */

const https = require('https');
const http = require('http');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// --- Config ---
const DATASET_ID = '354d406b-53cc-4788-a384-78b9abaf2ea0';
const DATA_GOV_API = `https://data.gov.ua/api/3/action/package_show?id=${DATASET_ID}`;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const DEFAULT_CONCURRENCY = 10;

// --- CLI args ---
const args = process.argv.slice(2);
const latestOnly = args.includes('--latest-only');
const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : DEFAULT_CONCURRENCY;

// --- DB connection ---
function getPool() {
  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.POSTGRES_USER || 'secondlayer'}:${process.env.POSTGRES_PASSWORD || 'secondlayer'}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'secondlayer_local'}`;
  return new Pool({ connectionString, max: 5 });
}

// --- HTTP download with redirect following ---
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const handler = (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location.startsWith('http')
          ? response.headers.location
          : new URL(response.headers.location, url).href;
        const mod = redirectUrl.startsWith('https') ? https : http;
        mod.get(redirectUrl, handler).on('error', reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    };
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, handler).on('error', reject);
  });
}

// --- Fetch resource list from data.gov.ua API ---
async function fetchResourceList() {
  console.log('Fetching dataset metadata from data.gov.ua...');
  const data = await downloadFile(DATA_GOV_API);
  const json = JSON.parse(data.toString());
  const resources = json.result.resources
    .filter(r => (r.format || '').toUpperCase() === 'XLSX')
    .map(r => ({
      id: r.id,
      name: r.name,
      url: r.url,
      lastModified: r.last_modified,
    }))
    .sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));

  console.log(`Found ${resources.length} XLSX resources`);
  return resources;
}

// --- Parse date from resource name like "Список суддів станом на 23.02.2026" ---
function parseDateFromName(name) {
  const match = name.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  // try YYYY format from last_modified
  return null;
}

// --- Detect column layout from the header row ---
// The ВККС files come in three shapes, and the columns have to be found by their
// headers, not guessed from one keyword:
//   №, ПІБ, Суд                      (to 2023-08-14)
//   №, ПІБ, Стать, Суд               (2023-08-21 .. 2024-12-23)
//   №, Досьє, ПІБ, Стать, Суд        (from 2025)
// The middle shape was read as the first one, so 240K history rows stored the
// gender («Ч»/«Ж») as court_name and lost the court (LEXAI-2174).
function detectLayout(rows) {
  for (const row of rows) {
    const cells = (row || []).map(c => String(c || '').toLowerCase());
    const nameCol = cells.findIndex(c => c.includes('прізвище') || c.includes('піб'));
    if (nameCol < 0) continue;
    const find = (re) => { const i = cells.findIndex(c => re.test(c)); return i >= 0 ? i : null; };
    return {
      dossier: find(/досьє/),
      name: nameCol,
      gender: find(/^\s*стать/),
      court: find(/найменування суду|^\s*суд/),
    };
  }
  return { dossier: null, name: 1, gender: null, court: 2 };
}

// --- Parse XLSX buffer into judge records ---
async function parseXlsx(buffer, snapshotDate, resourceName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const ws = workbook.worksheets[0];

  const rows = [];
  ws.eachRow((row) => {
    rows.push(row.values.slice(1)); // row.values is 1-indexed, slice to make 0-indexed
  });

  const layout = detectLayout(rows);
  const judges = [];

  for (const row of rows) {
    // Skip header/title rows — first col should be a row number (number or numeric string)
    const firstCol = row[0];
    const rowNum = typeof firstCol === 'number' ? firstCol : parseInt(String(firstCol), 10);
    if (isNaN(rowNum) || rowNum < 1) continue;

    const cell = (i) => (i != null && row[i] != null && String(row[i]).trim()) ? String(row[i]).trim() : null;
    const dossierNumber = cell(layout.dossier);
    const fullName = cell(layout.name);
    const gender = cell(layout.gender);
    const courtName = cell(layout.court);

    if (!fullName) continue;

    judges.push({
      dossier_number: dossierNumber,
      full_name: fullName,
      gender: gender,
      court_name: courtName,
      snapshot_date: snapshotDate,
    });
  }

  return judges;
}

// --- Download and parse a single resource ---
async function processResource(resource, index, total) {
  const snapshotDate = parseDateFromName(resource.name) || resource.lastModified.split('T')[0];
  const fileName = `${snapshotDate}_${resource.id.substring(0, 8)}.xlsx`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  let buffer;
  if (fs.existsSync(filePath)) {
    buffer = fs.readFileSync(filePath);
    console.log(`  [${index + 1}/${total}] Cached: ${resource.name} (${snapshotDate})`);
  } else {
    try {
      buffer = await downloadFile(resource.url);
      fs.writeFileSync(filePath, buffer);
      console.log(`  [${index + 1}/${total}] Downloaded: ${resource.name} (${snapshotDate}, ${(buffer.length / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.error(`  [${index + 1}/${total}] FAILED: ${resource.name} — ${err.message}`);
      return { snapshotDate, judges: [], error: err.message };
    }
  }

  try {
    const judges = await parseXlsx(buffer, snapshotDate, resource.name);
    return { snapshotDate, judges, resourceId: resource.id };
  } catch (err) {
    console.error(`  [${index + 1}/${total}] PARSE ERROR: ${resource.name} — ${err.message}`);
    return { snapshotDate, judges: [], error: err.message };
  }
}

// --- Parallel executor with concurrency limit ---
async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- Create DB tables ---
async function createTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS judges (
      id SERIAL PRIMARY KEY,
      dossier_number VARCHAR(50),
      full_name VARCHAR(500) NOT NULL,
      gender VARCHAR(10),
      court_name VARCHAR(500),
      snapshot_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(full_name, court_name, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_judges_full_name ON judges (full_name);
    CREATE INDEX IF NOT EXISTS idx_judges_court_name ON judges (court_name);
    CREATE INDEX IF NOT EXISTS idx_judges_snapshot_date ON judges (snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_judges_dossier ON judges (dossier_number);

    CREATE TABLE IF NOT EXISTS judges_current (
      id SERIAL PRIMARY KEY,
      dossier_number VARCHAR(50),
      full_name VARCHAR(500) NOT NULL,
      gender VARCHAR(10),
      court_name VARCHAR(500),
      first_seen DATE,
      last_seen DATE,
      snapshot_count INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(full_name, court_name)
    );

    CREATE INDEX IF NOT EXISTS idx_judges_current_full_name ON judges_current (full_name);
    CREATE INDEX IF NOT EXISTS idx_judges_current_court ON judges_current (court_name);
    CREATE INDEX IF NOT EXISTS idx_judges_current_dossier ON judges_current (dossier_number);

    CREATE TABLE IF NOT EXISTS judges_load_log (
      id SERIAL PRIMARY KEY,
      resource_id VARCHAR(100),
      snapshot_date DATE NOT NULL,
      judges_count INT,
      status VARCHAR(20) DEFAULT 'success',
      error_message TEXT,
      loaded_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(snapshot_date)
    );
  `);
  console.log('DB tables created/verified');
}

// --- Bulk insert judges for a snapshot ---
async function insertSnapshot(pool, snapshotDate, judges, resourceId) {
  if (judges.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if already loaded
    const existing = await client.query(
      'SELECT id FROM judges_load_log WHERE snapshot_date = $1',
      [snapshotDate]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return -1; // already loaded
    }

    // Deduplicate by (full_name, court_name) within single snapshot
    const seen = new Set();
    const deduped = judges.filter(j => {
      const key = `${j.full_name}|||${j.court_name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Bulk insert using unnest
    const dossiers = deduped.map(j => j.dossier_number);
    const names = deduped.map(j => j.full_name);
    const genders = deduped.map(j => j.gender);
    const courts = deduped.map(j => j.court_name);
    const dates = deduped.map(() => snapshotDate);

    await client.query(`
      INSERT INTO judges (dossier_number, full_name, gender, court_name, snapshot_date)
      SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::date[])
      ON CONFLICT (full_name, court_name, snapshot_date) DO UPDATE SET
        dossier_number = COALESCE(EXCLUDED.dossier_number, judges.dossier_number),
        gender = COALESCE(EXCLUDED.gender, judges.gender)
    `, [dossiers, names, genders, courts, dates]);

    // Log
    await client.query(`
      INSERT INTO judges_load_log (resource_id, snapshot_date, judges_count, status)
      VALUES ($1, $2, $3, 'success')
      ON CONFLICT (snapshot_date) DO NOTHING
    `, [resourceId, snapshotDate, judges.length]);

    await client.query('COMMIT');
    return judges.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Build judges_current from all snapshots ---
async function buildCurrentTable(pool) {
  console.log('\nBuilding judges_current from all snapshots...');
  await pool.query(`
    TRUNCATE judges_current;

    INSERT INTO judges_current (dossier_number, full_name, gender, court_name, first_seen, last_seen, snapshot_count)
    SELECT
      (ARRAY_AGG(dossier_number ORDER BY snapshot_date DESC) FILTER (WHERE dossier_number IS NOT NULL))[1] AS dossier_number,
      full_name,
      (ARRAY_AGG(gender ORDER BY snapshot_date DESC) FILTER (WHERE gender IS NOT NULL))[1] AS gender,
      (ARRAY_AGG(court_name ORDER BY snapshot_date DESC))[1] AS court_name,
      MIN(snapshot_date) AS first_seen,
      MAX(snapshot_date) AS last_seen,
      COUNT(DISTINCT snapshot_date)::int AS snapshot_count
    FROM judges
    GROUP BY full_name
    ON CONFLICT (full_name, court_name) DO UPDATE SET
      dossier_number = COALESCE(EXCLUDED.dossier_number, judges_current.dossier_number),
      gender = COALESCE(EXCLUDED.gender, judges_current.gender),
      first_seen = LEAST(EXCLUDED.first_seen, judges_current.first_seen),
      last_seen = GREATEST(EXCLUDED.last_seen, judges_current.last_seen),
      snapshot_count = EXCLUDED.snapshot_count,
      updated_at = NOW();
  `);

  const result = await pool.query('SELECT COUNT(*) as cnt FROM judges_current');
  console.log(`judges_current: ${result.rows[0].cnt} unique judges`);
}

// --- Load from cached downloads (offline mode) ---
async function loadFromCache() {
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.xlsx')).sort();
  console.log(`Loading ${files.length} cached files from ${DOWNLOAD_DIR}`);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const snapshotDate = file.split('_')[0]; // "2021-06-01_d90fe23d.xlsx" -> "2021-06-01"
    const filePath = path.join(DOWNLOAD_DIR, file);
    const buffer = fs.readFileSync(filePath);
    try {
      const judges = await parseXlsx(buffer, snapshotDate, file);
      console.log(`  [${i + 1}/${files.length}] ${file}: ${judges.length} judges`);
      results.push({ snapshotDate, judges, resourceId: file });
    } catch (err) {
      console.error(`  [${i + 1}/${files.length}] PARSE ERROR: ${file} — ${err.message}`);
      results.push({ snapshotDate, judges: [], error: err.message });
    }
  }
  return results;
}

// --- Main ---
async function main() {
  console.log(`=== VKKS Judges Loader ===`);
  console.log(`Concurrency: ${CONCURRENCY}, Latest only: ${latestOnly}`);

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  let results;

  // Check if we have cached files and API is reachable
  const cachedFiles = fs.existsSync(DOWNLOAD_DIR)
    ? fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.xlsx'))
    : [];

  if (cachedFiles.length > 0) {
    // Try API first, fall back to cache
    try {
      let resources = await fetchResourceList();
      if (latestOnly) {
        resources = [resources[resources.length - 1]];
        console.log('Loading only latest snapshot');
      }
      console.log(`\nDownloading and parsing ${resources.length} files (${CONCURRENCY} threads)...`);
      results = await parallelMap(resources, processResource, CONCURRENCY);
    } catch (err) {
      console.log(`API unreachable (${err.message}), using ${cachedFiles.length} cached files...`);
      results = await loadFromCache();
    }
  } else {
    let resources = await fetchResourceList();
    if (latestOnly) {
      resources = [resources[resources.length - 1]];
      console.log('Loading only latest snapshot');
    }
    console.log(`\nDownloading and parsing ${resources.length} files (${CONCURRENCY} threads)...`);
    results = await parallelMap(resources, processResource, CONCURRENCY);
  }

  const successful = results.filter(r => r.judges.length > 0);
  const failed = results.filter(r => r.error);
  console.log(`\nParsed: ${successful.length} OK, ${failed.length} failed`);

  if (successful.length === 0) {
    console.error('No data parsed. Exiting.');
    process.exit(1);
  }

  // 3. Insert into DB
  const pool = getPool();
  try {
    await createTables(pool);

    console.log(`\nInserting into database...`);
    let totalInserted = 0;
    let skipped = 0;

    for (const result of successful) {
      const count = await insertSnapshot(pool, result.snapshotDate, result.judges, result.resourceId);
      if (count === -1) {
        skipped++;
      } else {
        totalInserted += count;
        process.stdout.write(`  ${result.snapshotDate}: ${count} judges\n`);
      }
    }

    console.log(`\nTotal inserted: ${totalInserted} records (${skipped} snapshots already loaded)`);

    // 4. Build current table
    await buildCurrentTable(pool);

    // 5. Summary
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM judges) as total_records,
        (SELECT COUNT(*) FROM judges_current) as unique_judges,
        (SELECT COUNT(DISTINCT snapshot_date) FROM judges) as snapshots,
        (SELECT MIN(snapshot_date) FROM judges) as earliest,
        (SELECT MAX(snapshot_date) FROM judges) as latest
    `);
    const s = stats.rows[0];
    console.log(`\n=== Summary ===`);
    console.log(`Total records: ${s.total_records}`);
    console.log(`Unique judges: ${s.unique_judges}`);
    console.log(`Snapshots: ${s.snapshots} (${s.earliest} — ${s.latest})`);

  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { parseXlsx, detectLayout };
