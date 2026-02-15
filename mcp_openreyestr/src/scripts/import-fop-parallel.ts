/**
 * Parallel FOP Import — streams FOP.xml from ZIP and imports with N parallel workers.
 * Usage: node dist/scripts/import-fop-parallel.js <zipPath> [workers=10]
 */
import { Pool } from 'pg';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';
import { ParsedFOPEntity } from '../services/xml-parser.js';

dotenv.config();

const BATCH_SIZE = 200;
const WORKER_COUNT = parseInt(process.argv[3] || '10');

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

async function importFOPParallel(zipFilePath: string) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: WORKER_COUNT + 2,
  });

  const parser = new StreamingXMLParser();
  const importer = new DatabaseImporter(pool);
  const sem = new Semaphore(WORKER_COUNT);
  let totalImported = 0;
  let totalErrors = 0;
  const inflightPromises: Promise<void>[] = [];

  try {
    console.log(`Opening ZIP: ${zipFilePath}`);
    console.log(`Workers: ${WORKER_COUNT}, Batch size: ${BATCH_SIZE}`);
    const directory = await unzipper.Open.file(zipFilePath);

    const fopFile = directory.files.find(f => f.path === 'FOP_FULL_out.xml' || f.path === 'FOP.xml');
    if (!fopFile) {
      console.error('FOP XML not found in ZIP');
      process.exit(1);
    }

    console.log(`Found: ${fopFile.path}`);
    const startTime = Date.now();

    const count = await parser.parseBatched<ParsedFOPEntity>(
      fopFile.stream(), 'FOP', BATCH_SIZE,
      async (entities) => {
        await sem.acquire();

        const p = (async () => {
          try {
            await importer.importFOPEntities(entities, entities.length);
            totalImported += entities.length;
            if (totalImported % 10000 < BATCH_SIZE) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
              console.log(`  Imported ${totalImported} FOP entities (${elapsed}s, ${totalErrors} errors, ${sem.pending} queued)`);
            }
          } catch (err) {
            totalErrors += entities.length;
            console.error(`Worker error:`, (err as Error).message?.substring(0, 200));
          } finally {
            sem.release();
          }
        })();
        inflightPromises.push(p);
      }
    );

    console.log(`Parsing done (${count} entities). Waiting for ${inflightPromises.length} workers to finish...`);
    await Promise.all(inflightPromises);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = parseInt(elapsed) > 0 ? (totalImported / parseInt(elapsed)).toFixed(0) : 'N/A';
    console.log(`\nCompleted: ${count} parsed, ${totalImported} imported, ${totalErrors} errors`);
    console.log(`Time: ${elapsed}s (${rate} entities/sec)`);
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('Usage: node import-fop-parallel.js <path-to-fop.zip> [workers=10]');
  process.exit(1);
}

importFOPParallel(zipPath).catch(e => { console.error(e); process.exit(1); });
