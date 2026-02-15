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

function downloadFile(url: string, dest: string, maxRetries = 3): Promise<void> {
  const http = require('http');
  const https = require('https');

  async function attemptDownload(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http;
      const fileStream = fs.createWriteStream(dest);
      let totalBytes = 0;
      let lastLog = 0;

      const request = proto.get(url, { timeout: 45 * 60 * 1000 }, (response: any) => {
        // Follow redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          fileStream.close();
          const redirectUrl = response.headers.location.startsWith('http')
            ? response.headers.location
            : new URL(response.headers.location, url).href;
          const redirectProto = redirectUrl.startsWith('https') ? https : http;
          redirectProto.get(redirectUrl, { timeout: 45 * 60 * 1000 }, (res2: any) => {
            if (res2.statusCode !== 200) {
              reject(new Error(`HTTP ${res2.statusCode} after redirect`));
              return;
            }
            const fileStream2 = fs.createWriteStream(dest);
            res2.on('data', (chunk: Buffer) => {
              totalBytes += chunk.length;
              const mb = totalBytes / 1024 / 1024;
              if (mb - lastLog > 50) {
                process.stdout.write(`  Downloaded: ${mb.toFixed(1)} MB\r`);
                lastLog = mb;
              }
            });
            res2.pipe(fileStream2);
            fileStream2.on('finish', () => {
              fileStream2.close();
              console.log(`  Downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
              resolve();
            });
            fileStream2.on('error', reject);
            res2.on('error', reject);
          }).on('error', reject);
          return;
        }

        if (response.statusCode !== 200) {
          fileStream.close();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          const mb = totalBytes / 1024 / 1024;
          if (mb - lastLog > 50) {
            process.stdout.write(`  Downloaded: ${mb.toFixed(1)} MB\r`);
            lastLog = mb;
          }
        });
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`  Downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        });
        fileStream.on('error', reject);
        response.on('error', reject);
      });
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }

  return new Promise(async (resolve, reject) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await attemptDownload();

        // Verify the file is not empty / truncated
        const stats = fs.statSync(dest);
        if (stats.size < 1000) {
          throw new Error(`Downloaded file too small (${stats.size} bytes), likely truncated`);
        }

        // Verify ZIP header if it's a .zip file
        if (dest.endsWith('.zip')) {
          const fd = fs.openSync(dest, 'r');
          const header = Buffer.alloc(4);
          fs.readSync(fd, header, 0, 4, 0);
          fs.closeSync(fd);
          if (header[0] !== 0x50 || header[1] !== 0x4B) {
            throw new Error('Downloaded file is not a valid ZIP (bad magic number)');
          }
        }

        return resolve();
      } catch (err: any) {
        console.warn(`  Download attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt === maxRetries) {
          fs.unlink(dest, () => {});
          return reject(new Error(`Download failed after ${maxRetries} attempts: ${err.message}`));
        }
        // Wait before retry (exponential backoff: 5s, 15s, 45s)
        const waitMs = 5000 * Math.pow(3, attempt - 1);
        console.log(`  Retrying in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  });
}

async function extractZip(zipPath: string, extractDir: string): Promise<string[]> {
  const { execSync } = require('child_process');

  // Try system unzip first — handles ZIP64 and large files better than Node.js unzipper
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, {
      timeout: 10 * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Fallback to Node.js unzipper for environments without unzip
    const writePromises: Promise<string>[] = [];
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Parse())
        .on('entry', (entry: any) => {
          const filePath = entry.path as string;
          const type = entry.type as string;
          if (type === 'File') {
            const outPath = path.join(extractDir, filePath);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            const writePromise = new Promise<string>((res) => {
              entry.pipe(fs.createWriteStream(outPath))
                .on('finish', () => res(filePath));
            });
            writePromises.push(writePromise);
          } else {
            entry.autodrain();
          }
        })
        .on('close', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
    await Promise.all(writePromises);
  }

  // List all extracted files (non-directories)
  const extracted = listFilesRecursive(extractDir, extractDir);

  // Recursively extract any nested .zip files found inside
  const nestedZips = extracted.filter(f => f.toLowerCase().endsWith('.zip'));
  for (const nested of nestedZips) {
    const nestedPath = path.join(extractDir, nested);
    console.log(`  Extracting nested ZIP: ${nested}`);
    try {
      const innerFiles = await extractZip(nestedPath, extractDir);
      extracted.push(...innerFiles);
      fs.unlinkSync(nestedPath);
    } catch (err: any) {
      console.error(`  Failed to extract nested ZIP ${nested}: ${err.message}`);
    }
  }

  return extracted.filter(f => !f.toLowerCase().endsWith('.zip'));
}

/** Recursively list files relative to baseDir */
function listFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
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

  // 3.5 Cleanup: delete extracted files we don't need (saves disk/memory for large archives)
  for (const f of extracted) {
    if (f !== dataFile) {
      try { fs.unlinkSync(path.join(registryDir, f)); } catch { /* ignore */ }
    }
  }
  // Also delete the downloaded ZIP
  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

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

  // Sync registries in parallel batches
  const concurrency = parseInt(process.env.CONCURRENCY || '3', 10);
  const results: { registry: string; count: number; time: number; error?: string }[] = [];

  console.log(`\nConcurrency: ${concurrency} registries in parallel`);

  for (let i = 0; i < registriesToSync.length; i += concurrency) {
    const batch = registriesToSync.slice(i, i + concurrency);
    console.log(`\nBatch ${Math.floor(i / concurrency) + 1}: ${batch.map(c => c.name).join(', ')}`);

    const batchResults = await Promise.allSettled(
      batch.map(async (config) => {
        console.log(`\n--- ${config.name} (${config.title}) ---`);
        return syncRegistry(pool, config, args.keepFiles);
      })
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        results.push(settled.value);
        if (settled.value.error) {
          console.error(`  FAILED ${settled.value.registry}: ${settled.value.error}`);
        }
      } else {
        results.push({ registry: 'unknown', count: 0, time: 0, error: settled.reason?.message || 'Unknown error' });
      }
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
