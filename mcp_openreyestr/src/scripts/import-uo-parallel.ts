/**
 * Parallel UO Import — streams UO.xml from ZIP and imports with N parallel workers.
 * Usage: node dist/scripts/import-uo-parallel.js <zipPath> [workers]
 *
 * Environment config:
 *   IMPORT_BATCH_SIZE (default 200)
 *   IMPORT_WORKERS (default 10)
 */
import { Pool } from 'pg';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter, ImportStats } from '../services/database-importer.js';
import { ImportProgress } from '../services/import-progress.js';
import { ParsedUOEntity } from '../services/xml-parser.js';

dotenv.config();

const BATCH_SIZE = parseInt(process.env.IMPORT_BATCH_SIZE || '200');
const WORKER_COUNT = parseInt(process.argv[3] || process.env.IMPORT_WORKERS || '10');

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

async function importUOParallel(zipFilePath: string) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: WORKER_COUNT + 2,
  });

  const parser = new StreamingXMLParser();
  const importer = new DatabaseImporter(pool, { validate: true });
  const sem = new Semaphore(WORKER_COUNT);
  const progress = new ImportProgress('UO', { estimatedTotal: 1_800_000 });
  let inflightCount = 0;
  const inflightPromises: Promise<void>[] = [];

  try {
    console.log(`Opening ZIP: ${zipFilePath}`);
    console.log(`Workers: ${WORKER_COUNT}, Batch size: ${BATCH_SIZE}`);
    const directory = await unzipper.Open.file(zipFilePath);

    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml' || f.path === 'UO.xml');
    if (!uoFile) {
      console.error('UO XML not found in ZIP');
      process.exit(1);
    }

    console.log(`Found: ${uoFile.path}`);
    progress.start();

    const count = await parser.parseBatched<ParsedUOEntity>(
      uoFile.stream(), 'UO', BATCH_SIZE,
      async (entities) => {
        await sem.acquire();

        const p = (async () => {
          try {
            const stats = await importer.importUOEntities(entities, entities.length);
            progress.addImported(stats.imported);
            progress.addErrors(stats.errors);
            progress.addSkipped(stats.skipped);
            progress.addUnchanged(stats.unchanged);
          } catch (err) {
            progress.addErrors(entities.length);
            console.error(`\nWorker error:`, (err as Error).message?.substring(0, 200));
          } finally {
            sem.release();
            inflightCount--;
          }
        })();
        inflightCount++;
        inflightPromises.push(p);
      },
      (parsed) => progress.addParsed(1)
    );

    console.log(`\nParsing done (${count} entities). Waiting for ${inflightCount} workers to finish...`);
    await Promise.all(inflightPromises);

    progress.stop();

    // Post-import verification
    const dbCount = await pool.query('SELECT COUNT(*) FROM legal_entities');
    console.log(`\nVerification: ${dbCount.rows[0].count} legal entities in database (parsed ${count})`);

    const validationSummary = importer.getValidator()?.getSummary();
    if (validationSummary) {
      console.log(`Validation: ${validationSummary.valid} valid, ${validationSummary.skipped} skipped, ${validationSummary.warnings} with warnings`);
    }
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  } finally {
    progress.stop();
    await pool.end();
  }
}

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('Usage: node import-uo-parallel.js <path-to-uo.zip> [workers=10]');
  process.exit(1);
}

importUOParallel(zipPath).catch(e => { console.error(e); process.exit(1); });
