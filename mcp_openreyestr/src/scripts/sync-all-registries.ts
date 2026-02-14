/**
 * Unified NAIS Registry Sync Script
 *
 * Downloads and imports all 11 NAIS registries from data.gov.ua.
 * Supports filtering, weekly mode, and graceful error handling.
 *
 * Usage:
 *   node dist/scripts/sync-all-registries.js                          # Sync all
 *   node dist/scripts/sync-all-registries.js --only=notaries,debtors  # Sync specific
 *   node dist/scripts/sync-all-registries.js --weekly                 # Only due registries
 *   node dist/scripts/sync-all-registries.js --dry-run                # Show what would sync
 */

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';
import http from 'http';
import unzipper from 'unzipper';
import { REGISTRIES, RegistryConfig } from '../config/registries';
import { importXml } from '../services/generic-xml-importer';
import { importCsv } from '../services/csv-importer';

const DATA_DIR = process.env.NAIS_DATA_DIR || path.join(__dirname, '../../data/nais');

// --- CLI argument parsing ---

interface CliArgs {
  only: string[];
  weekly: boolean;
  dryRun: boolean;
  keepFiles: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { only: [], weekly: false, dryRun: false, keepFiles: false };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      args.only = arg.replace('--only=', '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--weekly') {
      args.weekly = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--keep-files') {
      args.keepFiles = true;
    } else if (!arg.startsWith('--')) {
      // Positional argument: treat as comma-separated registry names
      args.only = arg.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  return args;
}

// --- Download helpers ---

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (targetUrl: string, redirects: number = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const lib = targetUrl.startsWith('https') ? https : http;
      lib.get(targetUrl, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return follow(response.headers.location, redirects + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode} for ${targetUrl}`));
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err: Error) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    follow(url);
  });
}

async function extractZip(zipPath: string, extractDir: string): Promise<string[]> {
  const extracted: string[] = [];
  const writePromises: Promise<void>[] = [];

  // Use streaming extraction to avoid loading large files into memory
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', (entry: any) => {
        const filePath = entry.path as string;
        const type = entry.type as string;

        if (type === 'File') {
          const outPath = path.join(extractDir, filePath);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          const writePromise = new Promise<void>((res) => {
            entry.pipe(fs.createWriteStream(outPath))
              .on('finish', () => { extracted.push(filePath); res(); });
          });
          writePromises.push(writePromise);
        } else {
          entry.autodrain();
        }
      })
      .on('close', () => resolve())
      .on('error', (err: Error) => reject(err));
  });

  // Wait for all file writes to complete
  await Promise.all(writePromises);

  // Recursively extract any nested .zip files found inside
  const nestedZips = extracted.filter(f => f.toLowerCase().endsWith('.zip'));
  for (const nested of nestedZips) {
    const nestedPath = path.join(extractDir, nested);
    console.log(`  Extracting nested ZIP: ${nested}`);
    try {
      const innerFiles = await extractZip(nestedPath, extractDir);
      extracted.push(...innerFiles);
      // Remove the inner zip after extraction
      fs.unlinkSync(nestedPath);
    } catch (err: any) {
      console.error(`  Failed to extract nested ZIP ${nested}: ${err.message}`);
    }
  }

  return extracted.filter(f => !f.toLowerCase().endsWith('.zip'));
}

// --- Weekly check ---

async function isRegistryDue(pool: Pool, config: RegistryConfig): Promise<boolean> {
  const result = await pool.query(
    'SELECT last_update_date FROM registry_metadata WHERE registry_name = $1',
    [config.name]
  );

  if (result.rows.length === 0 || !result.rows[0].last_update_date) {
    return true; // Never imported, always due
  }

  const lastUpdate = new Date(result.rows[0].last_update_date);
  const now = new Date();
  const daysSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);

  if (config.updateFrequency === 'daily') {
    return daysSinceUpdate >= 1;
  }
  // weekly
  return daysSinceUpdate >= 7;
}

// --- Import logging ---

async function logImportStart(pool: Pool, config: RegistryConfig, fileName: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO import_log (registry_name, file_name, status) VALUES ($1, $2, 'in_progress') RETURNING id`,
    [config.name, fileName]
  );
  return result.rows[0].id;
}

async function logImportComplete(
  pool: Pool,
  logId: number,
  imported: number,
  errors: number,
  status: string,
  errorMessage?: string
): Promise<void> {
  await pool.query(
    `UPDATE import_log SET
      import_completed_at = CURRENT_TIMESTAMP,
      records_imported = $1,
      records_failed = $2,
      status = $3,
      error_message = $4
    WHERE id = $5`,
    [imported, errors, status, errorMessage || null, logId]
  );
}

async function updateRegistryMetadata(pool: Pool, config: RegistryConfig): Promise<void> {
  await pool.query(
    `UPDATE registry_metadata SET last_update_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE registry_name = $1`,
    [config.name]
  );
}

// --- Main orchestrator ---

async function syncRegistry(
  pool: Pool,
  config: RegistryConfig,
  keepFiles: boolean
): Promise<{ registry: string; count: number; time: number; error?: string }> {
  const startTime = Date.now();

  // 1. Download ZIP
  const registryDir = path.join(DATA_DIR, config.name);
  fs.mkdirSync(registryDir, { recursive: true });
  const zipPath = path.join(DATA_DIR, `${config.name}.zip`);

  console.log(`  Downloading from data.gov.ua...`);
  try {
    await downloadFile(config.datasetUrl, zipPath);
    const stats = fs.statSync(zipPath);
    console.log(`  Downloaded: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
  } catch (err: any) {
    return { registry: config.name, count: 0, time: (Date.now() - startTime) / 1000, error: `Download failed: ${err.message}` };
  }

  // 2. Extract ZIP
  console.log(`  Extracting...`);
  let extracted: string[];
  try {
    extracted = await extractZip(zipPath, registryDir);
    console.log(`  Extracted files: ${extracted.join(', ')}`);
  } catch (err: any) {
    return { registry: config.name, count: 0, time: (Date.now() - startTime) / 1000, error: `Extract failed: ${err.message}` };
  }

  // 3. Find data file
  const ext = config.format === 'csv' ? '.csv' : '.xml';
  let dataFile = config.innerFileName
    ? extracted.find(f => f === config.innerFileName || f.endsWith(config.innerFileName) || f.includes(config.innerFileName))
    : extracted.find(f => f.toLowerCase().endsWith(ext));

  if (!dataFile) {
    // Fallback: try any file with the right extension
    dataFile = extracted.find(f => f.toLowerCase().endsWith(ext));
  }

  if (!dataFile) {
    return { registry: config.name, count: 0, time: (Date.now() - startTime) / 1000, error: `No ${ext} file found. Available: ${extracted.join(', ')}` };
  }

  const dataFilePath = path.join(registryDir, dataFile);

  // 4. Log import start
  const logId = await logImportStart(pool, config, dataFile);

  // 5. Import
  console.log(`  Importing ${dataFile} to ${config.tableName}...`);
  try {
    let imported = 0;
    let errors = 0;

    if (config.format === 'xml') {
      const stats = await importXml(pool, config, dataFilePath, dataFile);
      imported = stats.imported;
      errors = stats.errors;
    } else {
      const stats = await importCsv(pool, config, dataFilePath, dataFile);
      imported = stats.imported;
      errors = stats.errors;
    }

    // 6. Update metadata and log
    await updateRegistryMetadata(pool, config);
    await logImportComplete(pool, logId, imported, errors, 'completed');

    // 7. Cleanup temp files
    if (!keepFiles) {
      try {
        fs.unlinkSync(zipPath);
        fs.rmSync(registryDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    return { registry: config.name, count: imported, time: elapsed };
  } catch (err: any) {
    await logImportComplete(pool, logId, 0, 0, 'failed', err.message);
    return { registry: config.name, count: 0, time: (Date.now() - startTime) / 1000, error: err.message };
  }
}

async function main() {
  const args = parseArgs();

  console.log('\n' + '='.repeat(60));
  console.log('NAIS Registry Sync — All Registries');
  console.log('='.repeat(60));

  if (args.only.length > 0) {
    console.log(`Filter: ${args.only.join(', ')}`);
  }
  if (args.weekly) {
    console.log('Mode: weekly (only due registries)');
  }
  if (args.dryRun) {
    console.log('Mode: dry-run (no downloads)');
  }

  // Ensure data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  // Determine which registries to sync
  let registriesToSync: RegistryConfig[] = Object.values(REGISTRIES);

  if (args.only.length > 0) {
    registriesToSync = registriesToSync.filter(r => args.only.includes(r.name));
    const unknown = args.only.filter(n => !REGISTRIES[n]);
    if (unknown.length > 0) {
      console.warn(`\nWarning: Unknown registries: ${unknown.join(', ')}`);
      console.warn(`Available: ${Object.keys(REGISTRIES).join(', ')}`);
    }
  }

  // Weekly mode: filter to only registries that are due
  if (args.weekly) {
    const due: RegistryConfig[] = [];
    for (const config of registriesToSync) {
      if (await isRegistryDue(pool, config)) {
        due.push(config);
      } else {
        console.log(`  Skipping ${config.name} (recently updated)`);
      }
    }
    registriesToSync = due;
  }

  if (registriesToSync.length === 0) {
    console.log('\nNo registries to sync.');
    await pool.end();
    return;
  }

  console.log(`\nSyncing ${registriesToSync.length} registries: ${registriesToSync.map(r => r.name).join(', ')}`);

  if (args.dryRun) {
    console.log('\nDry run — exiting without downloading.');
    await pool.end();
    return;
  }

  // Sync each registry
  const results: { registry: string; count: number; time: number; error?: string }[] = [];

  for (const config of registriesToSync) {
    console.log(`\n--- ${config.name} (${config.title}) ---`);

    const result = await syncRegistry(pool, config, args.keepFiles);
    results.push(result);

    if (result.error) {
      console.error(`  FAILED: ${result.error}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SYNC COMPLETE');
  console.log('='.repeat(60));

  const successful = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);

  for (const r of results) {
    const status = r.error ? `FAILED: ${r.error}` : `${r.count} records`;
    console.log(`  ${r.registry}: ${status} (${r.time.toFixed(1)}s)`);
  }

  console.log(`\n  Total: ${successful.length} succeeded, ${failed.length} failed`);
  console.log('');

  await pool.end();

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
