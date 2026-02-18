/**
 * Unified EDRPOU Sync Script for UO, FOP, and FSU registries.
 *
 * Downloads from data.gov.ua, extracts, validates, imports, verifies, and archives.
 * Modeled after sync-all-registries.ts for NAIS registries.
 *
 * Usage:
 *   node dist/scripts/sync-edrpou.js                          # Sync all
 *   node dist/scripts/sync-edrpou.js --only=UO,FOP            # Sync specific
 *   node dist/scripts/sync-edrpou.js --skip-download           # Use existing files
 *   node dist/scripts/sync-edrpou.js --diff                    # Hash-based change detection
 *   node dist/scripts/sync-edrpou.js --dry-run                 # Show what would sync
 *   node dist/scripts/sync-edrpou.js --keep-files              # Don't clean up temp files
 *
 * Environment:
 *   EDRPOU_DATA_DIR       — Working directory for downloads/extracts (default: ../../data/edrpou)
 *   IMPORT_BATCH_SIZE     — Batch size for DB imports (default: 500)
 *   IMPORT_WORKERS        — Parallel workers per entity type (default: 10)
 *   EDRPOU_UO_URL         — Download URL for UO ZIP
 *   EDRPOU_FOP_URL        — Download URL for FOP ZIP
 *   EDRPOU_FSU_URL        — Download URL for FSU ZIP
 */

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import unzipper from 'unzipper';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter, ImportStats } from '../services/database-importer.js';
import { DownloadService } from '../services/download-service.js';
import { ImportProgress } from '../services/import-progress.js';
import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from '../services/xml-parser.js';

const DATA_DIR = process.env.EDRPOU_DATA_DIR || path.join(__dirname, '../../data/edrpou');
const BATCH_SIZE = parseInt(process.env.IMPORT_BATCH_SIZE || '500');
const WORKER_COUNT = parseInt(process.env.IMPORT_WORKERS || '10');

// Default data.gov.ua URLs — override with env vars if they change
const DATASET_URLS: Record<string, string> = {
  UO: process.env.EDRPOU_UO_URL || 'https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10/resource/b2d3b3a3-8555-44e7-869f-f81042b97aa2/download/uo.zip',
  FOP: process.env.EDRPOU_FOP_URL || 'https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10/resource/e1c7d5b5-f0c5-4f5e-8e0a-7e65f7e48e9c/download/fop.zip',
  FSU: process.env.EDRPOU_FSU_URL || 'https://data.gov.ua/dataset/1c7f3815-3259-45e0-bdf1-64dca07ddc10/resource/7db8eb53-4e2e-4e92-a504-0f9cf086d25a/download/fsu.zip',
};

const XML_FILE_NAMES: Record<string, string[]> = {
  UO: ['UO_FULL_out.xml', 'UO.xml'],
  FOP: ['FOP_FULL_out.xml', 'FOP.xml'],
  FSU: ['FSU_FULL_out.xml', 'FSU.xml'],
};

const ESTIMATED_COUNTS: Record<string, number> = {
  UO: 1_800_000,
  FOP: 2_000_000,
  FSU: 100_000,
};

const TABLE_NAMES: Record<string, string> = {
  UO: 'legal_entities',
  FOP: 'individual_entrepreneurs',
  FSU: 'public_associations',
};

// --- CLI ---

interface CliArgs {
  only: string[];
  skipDownload: boolean;
  keepFiles: boolean;
  dryRun: boolean;
  diff: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { only: [], skipDownload: false, keepFiles: false, dryRun: false, diff: false };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      args.only = arg.replace('--only=', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    } else if (arg === '--skip-download') {
      args.skipDownload = true;
    } else if (arg === '--keep-files') {
      args.keepFiles = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--diff') {
      args.diff = true;
    }
  }

  return args;
}

// --- Extract ---

async function extractZip(zipPath: string, extractDir: string): Promise<string[]> {
  fs.mkdirSync(extractDir, { recursive: true });

  // Try system unzip first — handles large files better
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], {
      timeout: 10 * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Fallback to Node.js unzipper
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractDir }))
        .on('close', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
  }

  return listFilesRecursive(extractDir);
}

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// --- Import logging (reuses import_log table from NAIS) ---

async function logImportStart(pool: Pool, registryName: string, fileName: string): Promise<number> {
  const result = await pool.query(
    `INSERT INTO import_log (registry_name, file_name, status) VALUES ($1, $2, 'in_progress') RETURNING id`,
    [registryName, fileName]
  );
  return result.rows[0].id;
}

async function logImportComplete(
  pool: Pool, logId: number, imported: number, errors: number, status: string, errorMessage?: string
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

async function updateRegistryMetadata(pool: Pool, registryName: string, recordCount: number): Promise<void> {
  await pool.query(
    `INSERT INTO registry_metadata (registry_name, record_count, last_update_date)
     VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT (registry_name) DO UPDATE SET
       record_count = EXCLUDED.record_count,
       last_update_date = EXCLUDED.last_update_date`,
    [registryName, recordCount]
  );
}

// --- Archive ---

async function archiveFile(filePath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const archivePath = `${filePath}.${timestamp}.gz`;
  await pipeline(
    fs.createReadStream(filePath),
    createGzip(),
    fs.createWriteStream(archivePath)
  );
  return archivePath;
}

// --- Semaphore for parallel workers ---

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) { this.permits = permits; }

  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); } else { this.permits++; }
  }
}

// --- Per-type import ---

async function importEntityType(
  pool: Pool,
  entityType: 'UO' | 'FOP' | 'FSU',
  xmlPath: string,
  diff: boolean
): Promise<ImportStats> {
  const parser = new StreamingXMLParser();
  const importer = new DatabaseImporter(pool, { validate: true, diffMode: diff });
  const sem = new Semaphore(WORKER_COUNT);
  const progress = new ImportProgress(entityType, { estimatedTotal: ESTIMATED_COUNTS[entityType] });
  const totalStats: ImportStats = { imported: 0, skipped: 0, errors: 0, unchanged: 0 };
  const inflightPromises: Promise<void>[] = [];

  const stream = fs.createReadStream(xmlPath);

  progress.start();

  const importBatch = async (entities: any[]) => {
    await sem.acquire();
    const p = (async () => {
      try {
        let stats: ImportStats;
        if (entityType === 'UO') {
          stats = await importer.importUOEntities(entities as ParsedUOEntity[], entities.length);
        } else if (entityType === 'FOP') {
          stats = await importer.importFOPEntities(entities as ParsedFOPEntity[], entities.length);
        } else {
          stats = await importer.importFSUEntities(entities as ParsedFSUEntity[], entities.length);
        }
        totalStats.imported += stats.imported;
        totalStats.errors += stats.errors;
        totalStats.skipped += stats.skipped;
        totalStats.unchanged += stats.unchanged;
        progress.addImported(stats.imported);
        progress.addErrors(stats.errors);
        progress.addSkipped(stats.skipped);
        progress.addUnchanged(stats.unchanged);
      } catch (err) {
        totalStats.errors += entities.length;
        progress.addErrors(entities.length);
        console.error(`\nWorker error (${entityType}):`, (err as Error).message?.substring(0, 200));
      } finally {
        sem.release();
      }
    })();
    inflightPromises.push(p);
  };

  const count = await parser.parseBatched(
    stream, entityType, BATCH_SIZE, importBatch,
    () => progress.addParsed(1)
  );

  await Promise.all(inflightPromises);
  progress.stop();

  console.log(`Parsed: ${count}, Imported: ${totalStats.imported}, Errors: ${totalStats.errors}, Skipped: ${totalStats.skipped}, Unchanged: ${totalStats.unchanged}`);

  const validationSummary = importer.getValidator()?.getSummary();
  if (validationSummary) {
    console.log(`Validation: ${validationSummary.valid} valid, ${validationSummary.skipped} skipped, ${validationSummary.warnings} with warnings`);
  }

  return totalStats;
}

// --- Main orchestrator ---

async function main() {
  const args = parseArgs();
  const types: ('UO' | 'FOP' | 'FSU')[] = args.only.length > 0
    ? args.only.filter(t => ['UO', 'FOP', 'FSU'].includes(t)) as ('UO' | 'FOP' | 'FSU')[]
    : ['UO', 'FOP', 'FSU'];

  if (types.length === 0) {
    console.error('No valid entity types specified. Use --only=UO,FOP,FSU');
    process.exit(1);
  }

  console.log(`EDRPOU Sync: ${types.join(', ')}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Batch size: ${BATCH_SIZE}, Workers: ${WORKER_COUNT}`);
  if (args.diff) console.log('Mode: diff (hash-based change detection)');
  if (args.dryRun) console.log('Mode: DRY RUN — no actual imports');
  if (args.skipDownload) console.log('Skipping downloads — using existing files');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: WORKER_COUNT + 5,
  });

  const downloader = new DownloadService();
  const results: { type: string; status: string; stats?: ImportStats; error?: string }[] = [];

  try {
    for (const entityType of types) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`=== ${entityType} ===`);
      console.log('='.repeat(60));

      const zipPath = path.join(DATA_DIR, `${entityType.toLowerCase()}.zip`);
      const extractDir = path.join(DATA_DIR, entityType.toLowerCase());

      try {
        // Step 1: Download
        if (!args.skipDownload) {
          const url = DATASET_URLS[entityType];
          if (!url) {
            console.warn(`No download URL configured for ${entityType}, skipping`);
            results.push({ type: entityType, status: 'skipped', error: 'No URL' });
            continue;
          }
          console.log(`Downloading ${entityType} from data.gov.ua...`);
          if (!args.dryRun) {
            const result = await downloader.download(url, zipPath, {
              onProgress: (mb, total) => {
                const totalStr = total ? `/${total}MB` : '';
                process.stdout.write(`  Downloaded: ${mb}MB${totalStr}\r`);
              },
            });
            console.log(`Downloaded: ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB (${result.resumed ? 'resumed' : 'fresh'}, ${result.attempts} attempt(s))`);
          } else {
            console.log(`  [DRY RUN] Would download from ${url}`);
          }
        }

        // Step 2: Extract
        console.log(`Extracting ${entityType}...`);
        if (!args.dryRun) {
          if (!fs.existsSync(zipPath)) {
            throw new Error(`ZIP file not found: ${zipPath}`);
          }
          const files = await extractZip(zipPath, extractDir);
          console.log(`Extracted ${files.length} file(s)`);
        } else {
          console.log(`  [DRY RUN] Would extract ${zipPath}`);
        }

        // Step 3: Find XML file
        const xmlNames = XML_FILE_NAMES[entityType];
        let xmlPath = '';
        if (!args.dryRun) {
          for (const name of xmlNames) {
            const candidate = listFilesRecursive(extractDir).find(f => path.basename(f) === name);
            if (candidate) {
              xmlPath = candidate;
              break;
            }
          }
          if (!xmlPath) {
            throw new Error(`XML file not found in ${extractDir} (looking for ${xmlNames.join(' or ')})`);
          }
          console.log(`Found XML: ${path.basename(xmlPath)}`);
        }

        // Step 4: Import
        if (args.dryRun) {
          console.log(`  [DRY RUN] Would import ${entityType} entities`);
          results.push({ type: entityType, status: 'dry-run' });
          continue;
        }

        const logId = await logImportStart(pool, `EDRPOU_${entityType}`, path.basename(xmlPath));

        try {
          const stats = await importEntityType(pool, entityType, xmlPath, args.diff);

          // Step 5: Post-import verification
          const dbResult = await pool.query(`SELECT COUNT(*) FROM ${TABLE_NAMES[entityType]}`);
          const dbCount = parseInt(dbResult.rows[0].count);
          console.log(`Verification: ${dbCount} records in ${TABLE_NAMES[entityType]}`);

          await logImportComplete(pool, logId, stats.imported, stats.errors, 'completed');
          await updateRegistryMetadata(pool, `EDRPOU_${entityType}`, dbCount);

          // Step 6: Archive processed XML
          console.log(`Archiving processed XML...`);
          const archivePath = await archiveFile(xmlPath);
          console.log(`Archived: ${path.basename(archivePath)}`);

          results.push({ type: entityType, status: 'completed', stats });
        } catch (importErr) {
          await logImportComplete(pool, logId, 0, 0, 'failed', (importErr as Error).message);
          throw importErr;
        }

        // Step 7: Clean up
        if (!args.keepFiles) {
          console.log('Cleaning up temp files...');
          fs.rmSync(extractDir, { recursive: true, force: true });
          fs.unlinkSync(zipPath);
        }

      } catch (err) {
        console.error(`\nFailed to sync ${entityType}:`, (err as Error).message);
        results.push({ type: entityType, status: 'failed', error: (err as Error).message });
      }
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SYNC SUMMARY');
    console.log('='.repeat(60));
    for (const r of results) {
      const statsStr = r.stats
        ? ` (imported: ${r.stats.imported}, errors: ${r.stats.errors}, skipped: ${r.stats.skipped}, unchanged: ${r.stats.unchanged})`
        : '';
      const errorStr = r.error ? ` — ${r.error}` : '';
      console.log(`  ${r.type}: ${r.status}${statsStr}${errorStr}`);
    }

    const failed = results.filter(r => r.status === 'failed');
    if (failed.length > 0) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
