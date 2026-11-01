/**
 * ARMA Seized Assets Import
 * Downloads JSON from data.gov.ua and imports into PostgreSQL.
 * Uses streaming parser for large files (700+ MB).
 *
 * Usage: node dist/scripts/import-arma.js [--skip-download]
 *
 * Field mapping: services/arma-mapping.ts; load and stale-row cleanup:
 * services/arma-import.ts (LEXAI-2161).
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';
import http from 'http';
import { importArmaFile } from '../services/arma-import';

const ARMA_URL = 'https://data.gov.ua/dataset/d6cc6909-4098-47bc-a2e4-96182f446982/resource/02435739-9481-40ca-b40f-6379b6ed5949/download/edra_opendata.json';
const DATA_DIR = process.env.NAIS_DATA_DIR || path.join(__dirname, '../../data/nais');
const LOCK_KEY = 21610001; // pg advisory lock: one ARMA import at a time

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (url: string, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const proto = url.startsWith('https') ? https : http;
      proto.get(url, { timeout: 10 * 60 * 1000 }, (response: any) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const loc = response.headers.location.startsWith('http')
            ? response.headers.location
            : new URL(response.headers.location, url).href;
          return follow(loc, redirects + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const expected = Number(response.headers['content-length'] || 0);
        const tmp = `${dest}.part`;
        const file = fs.createWriteStream(tmp);
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes % (5 * 1024 * 1024) < chunk.length) {
            process.stdout.write(`\r  Downloaded: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
          }
        });
        response.on('aborted', () => reject(new Error('Download aborted')));
        response.on('error', reject);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`\n  Total: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
          if (!response.complete || (expected > 0 && bytes !== expected)) {
            return reject(new Error(`Truncated download: ${bytes} of ${expected || '?'} bytes`));
          }
          fs.renameSync(tmp, dest);
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function importArma() {
  const skipDownload = process.argv.includes('--skip-download');
  const jsonPath = path.join(DATA_DIR, 'arma_assets.json');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!skipDownload) {
    console.log('Downloading ARMA seized assets from data.gov.ua...');
    await downloadFile(ARMA_URL, jsonPath);
  }

  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }

  const fileSizeMB = (fs.statSync(jsonPath).size / 1024 / 1024).toFixed(1);
  console.log(`Parsing ${fileSizeMB} MB JSON (streaming)...`);

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 2,
  });

  const lockClient = await pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!lock.rows[0]?.ok) {
    console.error('Another ARMA import holds the lock — exiting');
    lockClient.release();
    await pool.end();
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const stats = await importArmaFile(pool, jsonPath, {
      sourceUrl: ARMA_URL,
      onProgress: (s) => process.stdout.write(`\r  Items: ${s.items} | New: ${s.inserted} | Updated: ${s.updated} | Batch errors: ${s.batchErrors}`),
    });
    console.log(`\n\nDone (run ${stats.runId}): ${stats.items} items parsed, ${stats.inserted} new, ${stats.updated} updated, ` +
      `${stats.seen} rows in this run, ${stats.parseErrors} unparseable lines, ${stats.batchErrors} failed batches, ` +
      `closing marker ${stats.complete ? 'found' : 'MISSING'} (rows before: ${stats.before})`);
    if (stats.staleKeptReason) {
      console.warn(`Stale rows kept: ${stats.staleKeptReason}`);
      exitCode = 2;
    } else {
      console.log(`Deleted ${stats.staleDeleted} rows not present in the current source file`);
    }
    const count = await pool.query('SELECT COUNT(*) FROM arma_assets');
    console.log(`Total in database: ${count.rows[0].count}`);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    lockClient.release();
    await pool.end();
  }
  if (exitCode) process.exit(exitCode);
}

importArma().catch(e => { console.error(e); process.exit(1); });
