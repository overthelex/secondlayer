/**
 * Import OpenReyestr XML files directly from disk.
 * 10 concurrent DB workers for maximum throughput.
 *
 * Usage:
 *   node dist/scripts/import-from-xml.js <xml-dir> [--skip-fsu] [--skip-uo] [--skip-fop]
 */
import { Pool, PoolClient } from 'pg';
import sax from 'sax';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BATCH_SIZE = 500;
const CONCURRENCY = 10;
const MAX_QUEUE = CONCURRENCY * 3; // pause reading when queue has 30 batches

// ─── Database Insertion ────────────────────────────────────────────

async function insertUOBatch(client: PoolClient, entities: any[]): Promise<{ ok: number; err: number }> {
  let ok = 0, err = 0;
  await client.query('BEGIN');
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const sp = `sp_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await client.query(
        `INSERT INTO legal_entities (record,edrpou,name,short_name,opf,stan,authorized_capital,founding_document_num,purpose,superior_management,statute,registration,managing_paper,terminated_info,termination_cancel_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (record) DO UPDATE SET edrpou=EXCLUDED.edrpou,name=EXCLUDED.name,short_name=EXCLUDED.short_name,opf=EXCLUDED.opf,stan=EXCLUDED.stan,authorized_capital=EXCLUDED.authorized_capital,founding_document_num=EXCLUDED.founding_document_num,purpose=EXCLUDED.purpose,superior_management=EXCLUDED.superior_management,statute=EXCLUDED.statute,registration=EXCLUDED.registration,managing_paper=EXCLUDED.managing_paper,terminated_info=EXCLUDED.terminated_info,termination_cancel_info=EXCLUDED.termination_cancel_info,updated_at=CURRENT_TIMESTAMP`,
        [e.RECORD, e.EDRPOU, e.NAME, e.SHORT_NAME, e.OPF, e.STAN,
         e.AUTHORIZED_CAPITAL ? parseFloat(String(e.AUTHORIZED_CAPITAL).replace(',', '.')) : null,
         e.FOUNDING_DOCUMENT_NUM, e.PURPOSE, e.SUPERIOR_MANAGEMENT, e.STATUTE,
         e.REGISTRATION, e.MANAGING_PAPER, e.TERMINATED_INFO, e.TERMINATION_CANCEL_INFO]
      );
      await insertRelated(client, e, 'UO');
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      ok++;
    } catch {
      err++;
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
  }
  await client.query('COMMIT');
  return { ok, err };
}

async function insertFOPBatch(client: PoolClient, entities: any[]): Promise<{ ok: number; err: number }> {
  let ok = 0, err = 0;
  await client.query('BEGIN');
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const sp = `sp_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await client.query(
        `INSERT INTO individual_entrepreneurs (record,name,stan,farmer,estate_manager,registration,terminated_info,termination_cancel_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (record) DO UPDATE SET name=EXCLUDED.name,stan=EXCLUDED.stan,farmer=EXCLUDED.farmer,estate_manager=EXCLUDED.estate_manager,registration=EXCLUDED.registration,terminated_info=EXCLUDED.terminated_info,termination_cancel_info=EXCLUDED.termination_cancel_info,updated_at=CURRENT_TIMESTAMP`,
        [e.RECORD, e.NAME, e.STAN, e.FARMER, e.ESTATE_MANAGER, e.REGISTRATION, e.TERMINATED_INFO, e.TERMINATION_CANCEL_INFO]
      );
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      ok++;
    } catch {
      err++;
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
  }
  await client.query('COMMIT');
  return { ok, err };
}

async function insertFSUBatch(client: PoolClient, entities: any[]): Promise<{ ok: number; err: number }> {
  let ok = 0, err = 0;
  await client.query('BEGIN');
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const sp = `sp_${i}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await client.query(
        `INSERT INTO public_associations (record,edrpou,name,short_name,type_subject,type_branch,stan,founding_document,registration,terminated_info,termination_cancel_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (record) DO UPDATE SET edrpou=EXCLUDED.edrpou,name=EXCLUDED.name,short_name=EXCLUDED.short_name,type_subject=EXCLUDED.type_subject,type_branch=EXCLUDED.type_branch,stan=EXCLUDED.stan,founding_document=EXCLUDED.founding_document,registration=EXCLUDED.registration,terminated_info=EXCLUDED.terminated_info,termination_cancel_info=EXCLUDED.termination_cancel_info,updated_at=CURRENT_TIMESTAMP`,
        [e.RECORD, e.EDRPOU, e.NAME, e.SHORT_NAME, e.TYPE_SUBJECT, e.TYPE_BRANCH, e.STAN, e.FOUNDING_DOCUMENT, e.REGISTRATION, e.TERMINATED_INFO, e.TERMINATION_CANCEL_INFO]
      );
      await insertRelated(client, e, 'FSU');
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      ok++;
    } catch {
      err++;
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
  }
  await client.query('COMMIT');
  return { ok, err };
}

async function insertRelated(client: PoolClient, e: any, entityType: string) {
  const record = e.RECORD;
  if (e._founders?.length) {
    await client.query('DELETE FROM founders WHERE entity_type=$1 AND entity_record=$2', [entityType, record]);
    for (const f of e._founders) {
      await client.query('INSERT INTO founders (entity_type,entity_record,founder_info) VALUES ($1,$2,$3)', [entityType, record, f]);
    }
  }
  if (e._beneficiaries?.length) {
    await client.query('DELETE FROM beneficiaries WHERE entity_type=$1 AND entity_record=$2', [entityType, record]);
    for (const b of e._beneficiaries) {
      await client.query('INSERT INTO beneficiaries (entity_type,entity_record,beneficiary_info) VALUES ($1,$2,$3)', [entityType, record, b]);
    }
  }
  if (e._signers?.length) {
    await client.query('DELETE FROM signers WHERE entity_type=$1 AND entity_record=$2', [entityType, record]);
    for (const s of e._signers) {
      await client.query('INSERT INTO signers (entity_type,entity_record,signer_info) VALUES ($1,$2,$3)', [entityType, record, s]);
    }
  }
  if (entityType === 'UO' && e._branches?.length) {
    await client.query('DELETE FROM branches WHERE parent_record=$1', [record]);
    for (const b of e._branches) {
      await client.query('INSERT INTO branches (parent_record,code,name,signer,create_date) VALUES ($1,$2,$3,$4,$5)',
        [record, b.CODE, b.NAME, b.SIGNER, b.CREATE_DATE]);
    }
  }
  if (e._predecessors?.length) {
    await client.query('DELETE FROM predecessors WHERE entity_type=$1 AND entity_record=$2', [entityType, record]);
    for (const p of e._predecessors) {
      await client.query('INSERT INTO predecessors (entity_type,entity_record,predecessor_name,predecessor_code) VALUES ($1,$2,$3,$4)',
        [entityType, record, p.NAME, p.CODE]);
    }
  }
}

// ─── Parallel Worker Pool ──────────────────────────────────────────

interface WorkerPool {
  queue: any[][];
  activeWorkers: number;
  imported: number;
  errors: number;
  startTime: number;
  done: boolean;
  fileStream: fs.ReadStream | null;
  resolve: ((stats: { imported: number; errors: number }) => void) | null;
  pool: Pool;
  insertFn: (client: PoolClient, batch: any[]) => Promise<{ ok: number; err: number }>;
  label: string;
}

function createWorkerPool(
  pool: Pool,
  insertFn: (client: PoolClient, batch: any[]) => Promise<{ ok: number; err: number }>,
  label: string,
): WorkerPool {
  return {
    queue: [],
    activeWorkers: 0,
    imported: 0,
    errors: 0,
    startTime: Date.now(),
    done: false,
    fileStream: null,
    resolve: null,
    pool,
    insertFn,
    label,
  };
}

async function runWorker(wp: WorkerPool) {
  // activeWorkers already incremented by caller (synchronously)

  while (wp.queue.length > 0) {
    const batch = wp.queue.shift()!;

    // Resume reading if queue drained below threshold
    if (wp.fileStream && wp.queue.length < MAX_QUEUE / 2) {
      wp.fileStream.resume();
    }

    const client = await wp.pool.connect();
    try {
      const result = await wp.insertFn(client, batch);
      wp.imported += result.ok;
      wp.errors += result.err;
    } catch (error: any) {
      wp.errors += batch.length;
      console.error(`  Worker error: ${error.message}`);
    } finally {
      client.release();
    }
  }

  wp.activeWorkers--;

  // Log progress
  const elapsed = ((Date.now() - wp.startTime) / 1000).toFixed(0);
  const rate = Math.round(wp.imported / ((Date.now() - wp.startTime) / 1000));
  console.log(`  [${elapsed}s] ${wp.label}: ${wp.imported} imported, ${wp.errors} errors (${rate}/s, workers: ${wp.activeWorkers}, queue: ${wp.queue.length})`);

  // If done and no more workers, resolve
  if (wp.done && wp.activeWorkers === 0 && wp.queue.length === 0 && wp.resolve) {
    wp.resolve({ imported: wp.imported, errors: wp.errors });
  }
}

function enqueueBatch(wp: WorkerPool, batch: any[]) {
  wp.queue.push(batch);

  // Pause reading if queue is full
  if (wp.fileStream && wp.queue.length >= MAX_QUEUE) {
    wp.fileStream.pause();
  }

  // Spawn workers up to CONCURRENCY — increment counter synchronously to avoid race
  while (wp.activeWorkers < CONCURRENCY && wp.queue.length > 0) {
    wp.activeWorkers++;
    runWorker(wp);
  }
}

// ─── SAX Parser ────────────────────────────────────────────────────

function parseXMLFile(
  filePath: string,
  wp: WorkerPool,
): Promise<{ imported: number; errors: number }> {
  return new Promise((resolve, reject) => {
    wp.resolve = resolve;
    wp.startTime = Date.now();
    const saxParser = sax.createStream(true, { trim: true, normalize: true });
    const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    wp.fileStream = fileStream;

    let currentSubject: any = null;
    let currentPath: string[] = [];
    let currentValue = '';
    let currentArray: any[] | null = null;
    let currentObject: any = null;
    let batch: any[] = [];

    saxParser.on('opentag', (node: any) => {
      const tag = node.name;
      currentPath.push(tag);

      if (tag === 'SUBJECT') {
        currentSubject = {};
      } else if (currentSubject) {
        if (['FOUNDER', 'BENEFICIARY', 'SIGNER', 'MEMBER', 'EXCHANGE_ANSWER'].includes(tag)) {
          if (!currentArray) { currentArray = []; }
          if (tag === 'EXCHANGE_ANSWER') { currentObject = {}; }
        } else if (['BRANCH', 'PREDECESSOR', 'ASSIGNEE'].includes(tag)) {
          currentObject = {};
          if (!currentArray) { currentArray = []; }
        }
      }
      currentValue = '';
    });

    saxParser.on('text', (text: string) => {
      if (text.trim()) currentValue += text;
    });

    saxParser.on('cdata', (text: string) => {
      if (text.trim()) currentValue += text;
    });

    saxParser.on('closetag', (tag: string) => {
      if (tag === 'SUBJECT' && currentSubject) {
        batch.push(currentSubject);
        currentSubject = null;

        if (batch.length >= BATCH_SIZE) {
          enqueueBatch(wp, batch);
          batch = [];
        }
      } else if (currentSubject) {
        const fullPath = currentPath.join('/');

        if (currentObject && ['BRANCH', 'PREDECESSOR', 'ASSIGNEE', 'EXCHANGE_ANSWER'].includes(tag)) {
          if (currentArray) currentArray.push(currentObject);
          currentObject = null;
        }
        else if (tag === 'FOUNDERS' && currentArray) {
          currentSubject._founders = currentArray; currentArray = null;
        } else if (tag === 'BENEFICIARIES' && currentArray) {
          currentSubject._beneficiaries = currentArray; currentArray = null;
        } else if (tag === 'SIGNERS' && currentArray) {
          currentSubject._signers = currentArray; currentArray = null;
        } else if (tag === 'MEMBERS' && currentArray) {
          currentSubject._members = currentArray; currentArray = null;
        } else if (tag === 'BRANCHES' && currentArray) {
          currentSubject._branches = currentArray; currentArray = null;
        } else if (tag === 'PREDECESSORS' && currentArray) {
          currentSubject._predecessors = currentArray; currentArray = null;
        } else if (tag === 'ASSIGNEES' && currentArray) {
          currentSubject._assignees = currentArray; currentArray = null;
        } else if (tag === 'EXCHANGE_DATA' && currentArray) {
          currentSubject._exchange_data = currentArray; currentArray = null;
        }
        else if (currentArray && ['FOUNDER', 'BENEFICIARY', 'SIGNER', 'MEMBER'].includes(tag) && currentValue.trim()) {
          currentArray.push(currentValue.trim());
        }
        else if (currentObject && currentValue.trim()) {
          currentObject[tag] = currentValue.trim();
        }
        else if (currentValue.trim()) {
          const val = currentValue.trim();
          if (fullPath.includes('EXECUTIVE_POWER')) {
            if (!currentSubject.EXECUTIVE_POWER) currentSubject.EXECUTIVE_POWER = {};
            currentSubject.EXECUTIVE_POWER[tag] = val;
          } else if (fullPath.includes('TERMINATION_STARTED_INFO')) {
            if (!currentSubject.TERMINATION_STARTED_INFO) currentSubject.TERMINATION_STARTED_INFO = {};
            currentSubject.TERMINATION_STARTED_INFO[tag] = val;
          } else if (fullPath.includes('BANKRUPTCY_READJUSTMENT_INFO')) {
            if (!currentSubject.BANKRUPTCY_READJUSTMENT_INFO) currentSubject.BANKRUPTCY_READJUSTMENT_INFO = {};
            currentSubject.BANKRUPTCY_READJUSTMENT_INFO[tag] = val;
          } else {
            currentSubject[tag] = val;
          }
        }
      }

      currentPath.pop();
      currentValue = '';
    });

    saxParser.on('error', (err: any) => {
      console.error('SAX parse error:', err.message);
      (saxParser as any)._parser.error = null;
      (saxParser as any)._parser.resume();
    });

    saxParser.on('end', () => {
      // Flush remaining
      if (batch.length > 0) {
        enqueueBatch(wp, batch);
        batch = [];
      }
      wp.done = true;

      // If all workers already finished
      if (wp.activeWorkers === 0 && wp.queue.length === 0 && wp.resolve) {
        wp.resolve({ imported: wp.imported, errors: wp.errors });
      }
    });

    fileStream.on('error', reject);
    fileStream.pipe(saxParser);
  });
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const xmlDir = args.find(a => !a.startsWith('--'));
  const skipFSU = args.includes('--skip-fsu');
  const skipUO = args.includes('--skip-uo');
  const skipFOP = args.includes('--skip-fop');

  if (!xmlDir) {
    console.error('Usage: node dist/scripts/import-from-xml.js <xml-directory> [--skip-fsu] [--skip-uo] [--skip-fop]');
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: CONCURRENCY + 2, // 10 workers + 2 spare
  });

  console.log(`OpenReyestr XML Import (${CONCURRENCY} concurrent workers)`);
  console.log(`Directory: ${xmlDir}\n`);

  // FSU (smallest)
  if (!skipFSU) {
    const fsuPath = path.join(xmlDir, 'FSU_FULL_out.xml');
    if (fs.existsSync(fsuPath)) {
      console.log('=== Importing Public Associations (FSU) ===');
      const wp = createWorkerPool(pool, insertFSUBatch, 'FSU');
      const stats = await parseXMLFile(fsuPath, wp);
      console.log(`✓ FSU done: ${stats.imported} imported, ${stats.errors} errors\n`);
    }
  }

  // UO (5GB)
  if (!skipUO) {
    const uoPath = path.join(xmlDir, 'UO_FULL_out.xml');
    if (fs.existsSync(uoPath)) {
      console.log('=== Importing Legal Entities (UO) ===');
      const wp = createWorkerPool(pool, insertUOBatch, 'UO');
      const stats = await parseXMLFile(uoPath, wp);
      console.log(`✓ UO done: ${stats.imported} imported, ${stats.errors} errors\n`);
    }
  }

  // FOP (8GB)
  if (!skipFOP) {
    const fopPath = path.join(xmlDir, 'FOP_FULL_out.xml');
    if (fs.existsSync(fopPath)) {
      console.log('=== Importing Individual Entrepreneurs (FOP) ===');
      const wp = createWorkerPool(pool, insertFOPBatch, 'FOP');
      const stats = await parseXMLFile(fopPath, wp);
      console.log(`✓ FOP done: ${stats.imported} imported, ${stats.errors} errors\n`);
    }
  }

  console.log('✅ Import completed!');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
