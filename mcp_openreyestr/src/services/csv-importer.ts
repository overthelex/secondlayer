/**
 * CSV Streaming Importer — Parallel Workers
 * For large CSV registries (enforcement_proceedings, debtors).
 * Uses readline + iconv-lite for streaming, with N parallel DB workers
 * doing multi-row INSERTs for maximum throughput.
 *
 * For "huge" registries: TRUNCATE + plain INSERT (no ON CONFLICT),
 * drop/recreate indexes, bigger batches, skip raw_data column.
 */

import { Pool, PoolClient } from 'pg';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import iconv from 'iconv-lite';
import { RegistryConfig } from '../config/registries';

const BATCH_SIZE_NORMAL = 1000;
const BATCH_SIZE_HUGE = 5000;
const PROGRESS_INTERVAL = 50000;
const NUM_WORKERS = parseInt(process.env.CSV_IMPORT_WORKERS || '10', 10);

export interface CsvImportStats {
  registry: string;
  imported: number;
  errors: number;
  elapsed: number;
  totalRows: number;
}

interface IndexDef {
  indexname: string;
  indexdef: string;
  is_constraint: boolean;
  constraint_type: string | null;
}

/**
 * For huge registries: drop all non-PK indexes and constraints before bulk insert,
 * recreate them after. Handles UNIQUE constraints that can't be dropped via DROP INDEX.
 */
async function dropIndexes(pool: Pool, tableName: string): Promise<IndexDef[]> {
  // Get all indexes
  const { rows: indexes } = await pool.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = $1
       AND indexname NOT LIKE '%_pkey'`,
    [tableName]
  );

  // Check which indexes are backing constraints
  const { rows: constraints } = await pool.query<{ conname: string; contype: string }>(
    `SELECT conname, contype FROM pg_constraint
     WHERE conrelid = $1::regclass
       AND conname NOT LIKE '%_pkey'`,
    [tableName]
  );
  const constraintMap = new Map(constraints.map(c => [c.conname, c.contype]));

  const result: IndexDef[] = [];
  for (const idx of indexes) {
    const isConstraint = constraintMap.has(idx.indexname);
    const constraintType = constraintMap.get(idx.indexname) || null;
    result.push({ ...idx, is_constraint: isConstraint, constraint_type: constraintType });

    if (isConstraint) {
      console.log(`  Dropping constraint: ${idx.indexname}`);
      await pool.query(`ALTER TABLE ${tableName} DROP CONSTRAINT ${idx.indexname}`);
    } else {
      console.log(`  Dropping index: ${idx.indexname}`);
      await pool.query(`DROP INDEX IF EXISTS ${idx.indexname}`);
    }
  }
  return result;
}

/**
 * Persist index definitions so a run that dies between drop and recreate
 * (container restart, OOM, deploy) leaves a durable record to repair from.
 */
async function saveIndexDefs(pool: Pool, tableName: string, indexes: IndexDef[]): Promise<void> {
  for (const idx of indexes) {
    await pool.query(
      `INSERT INTO csv_import_saved_indexes
         (table_name, index_name, index_def, is_constraint, constraint_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (table_name, index_name) DO UPDATE SET
         index_def = EXCLUDED.index_def,
         is_constraint = EXCLUDED.is_constraint,
         constraint_type = EXCLUDED.constraint_type,
         saved_at = CURRENT_TIMESTAMP`,
      [tableName, idx.indexname, idx.indexdef, idx.is_constraint, idx.constraint_type]
    );
  }
}

/** Index defs left behind by a previous run that never got to recreate them. */
async function loadOrphanedIndexDefs(pool: Pool, tableName: string): Promise<IndexDef[]> {
  const { rows } = await pool.query<{
    index_name: string; index_def: string; is_constraint: boolean; constraint_type: string | null;
  }>(
    `SELECT index_name, index_def, is_constraint, constraint_type
       FROM csv_import_saved_indexes WHERE table_name = $1`,
    [tableName]
  );
  return rows.map(r => ({
    indexname: r.index_name,
    indexdef: r.index_def,
    is_constraint: r.is_constraint,
    constraint_type: r.constraint_type,
  }));
}

async function clearSavedIndexDefs(pool: Pool, tableName: string): Promise<void> {
  await pool.query(`DELETE FROM csv_import_saved_indexes WHERE table_name = $1`, [tableName]);
}

async function recreateIndexes(pool: Pool, tableName: string, indexes: IndexDef[]): Promise<void> {
  for (const idx of indexes) {
    if (idx.is_constraint && idx.constraint_type === 'u') {
      // Recreate UNIQUE constraint
      // Extract column list from indexdef: CREATE UNIQUE INDEX name ON table USING btree (col1, col2)
      const colMatch = idx.indexdef.match(/\(([^)]+)\)/);
      if (colMatch) {
        console.log(`  Recreating UNIQUE constraint: ${idx.indexname}`);
        await pool.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${idx.indexname} UNIQUE (${colMatch[1]})`);
      }
    } else {
      console.log(`  Recreating index: ${idx.indexname}`);
      await pool.query(idx.indexdef);
    }
  }
}

/**
 * Import CSV file into database using registry config.
 * Streams line-by-line, dispatches batches to N parallel workers.
 *
 * For huge registries (enforcement_proceedings, debtors):
 *   - TRUNCATE table
 *   - Drop indexes
 *   - Plain INSERT (no ON CONFLICT) with bigger batches
 *   - Skip raw_data column to reduce WAL
 *   - Recreate indexes after
 */
export async function importCsv(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<CsvImportStats> {
  const start = Date.now();
  const delimiter = config.csvDelimiter || ';';
  const isHuge = config.sizeCategory === 'huge';
  const batchSize = isHuge ? BATCH_SIZE_HUGE : BATCH_SIZE_NORMAL;

  console.log(`  CSV delimiter: "${delimiter}", encoding: ${config.encoding}, workers: ${NUM_WORKERS}, mode: ${isHuge ? 'TRUNCATE+INSERT' : 'UPSERT'}, batch: ${batchSize}`);

  // For huge registries: truncate and drop indexes for max throughput
  let savedIndexes: IndexDef[] = [];
  if (isHuge) {
    console.log(`  TRUNCATE ${config.tableName}...`);
    // RESTART IDENTITY bounds sequence growth to a single run. Without it each
    // daily reimport permanently consumed ~N sequence values and the id
    // sequence eventually overflowed its type (see migration 017).
    await pool.query(`TRUNCATE ${config.tableName} RESTART IDENTITY`);

    // Defs orphaned by a previous run that died before recreating its indexes.
    // Merged in (by index name) so this run rebuilds them rather than leaving
    // the table permanently unindexed.
    const orphaned = await loadOrphanedIndexDefs(pool, config.tableName);
    if (orphaned.length > 0) {
      console.log(`  Found ${orphaned.length} index(es) orphaned by a previous run — will rebuild`);
    }

    const dropped = await dropIndexes(pool, config.tableName);
    const merged = new Map<string, IndexDef>();
    for (const idx of [...orphaned, ...dropped]) merged.set(idx.indexname, idx);
    savedIndexes = [...merged.values()];

    await saveIndexDefs(pool, config.tableName, savedIndexes);

    // Disable autovacuum during bulk load
    await pool.query(`ALTER TABLE ${config.tableName} SET (autovacuum_enabled = false)`);
  }

  // Set up streaming pipeline
  const fileStream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
  const decodedStream = config.encoding !== 'utf-8'
    ? fileStream.pipe(iconv.decodeStream(config.encoding))
    : fileStream;

  const rl = createInterface({
    input: decodedStream,
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let lineNumber = 0;
  let batch: Record<string, string>[] = [];
  let totalImported = 0;
  let totalErrors = 0;
  let totalRows = 0;

  // Get DB column names — skip raw_data for huge registries
  const columns = Object.keys(config.fieldMap);
  const allColumns = isHuge
    ? [...columns, 'source_file']
    : [...columns, 'raw_data', 'source_file'];

  // Build ON CONFLICT clause (only for non-huge)
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const conflictTarget = uniqueKeys.join(', ');
  const updateCols = columns
    .filter(c => !uniqueKeys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .concat(isHuge ? [] : ['raw_data = EXCLUDED.raw_data', 'updated_at = CURRENT_TIMESTAMP']);

  // Worker pool for parallel batch processing
  const pendingBatches: Promise<{ imported: number; errors: number }>[] = [];
  const MAX_PENDING = NUM_WORKERS;

  async function drainToN(n: number) {
    while (pendingBatches.length >= n) {
      const settled = await Promise.race(
        pendingBatches.map((p, i) => p.then(r => ({ r, i })))
      );
      totalImported += settled.r.imported;
      totalErrors += settled.r.errors;
      pendingBatches.splice(settled.i, 1);
    }
  }

  const processBatch = isHuge
    ? (records: Record<string, string>[]) =>
        processCsvBatchPlainInsert(pool, config, records, allColumns, sourceFile, isHuge)
    : (records: Record<string, string>[]) =>
        processCsvBatchMultiRow(pool, config, records, allColumns, conflictTarget, updateCols, sourceFile);

  for await (const line of rl) {
    lineNumber++;

    // First line is header
    if (lineNumber === 1) {
      headers = parseCsvLine(line, delimiter);
      if (headers.length <= 1) {
        const altDelimiter = delimiter === ',' ? ';' : ',';
        const altHeaders = parseCsvLine(line, altDelimiter);
        if (altHeaders.length > 1) {
          console.log(`  Header uses '${altDelimiter}' delimiter (data uses '${delimiter}') — auto-detected`);
          headers = altHeaders;
        }
      }
      console.log(`  CSV headers (${headers.length}): ${headers.slice(0, 5).join(', ')}...`);
      continue;
    }

    // Skip empty lines
    if (!line.trim()) continue;

    const values = parseCsvLine(line, delimiter);
    if (values.length < headers.length * 0.5) continue;

    const record: Record<string, string> = {};
    for (let i = 0; i < headers.length && i < values.length; i++) {
      record[headers[i]] = values[i];
    }

    batch.push(record);
    totalRows++;

    if (batch.length >= batchSize) {
      await drainToN(MAX_PENDING);

      const batchToProcess = batch;
      batch = [];

      pendingBatches.push(processBatch(batchToProcess));

      if (totalRows % PROGRESS_INTERVAL === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const rate = Math.round(totalRows / ((Date.now() - start) / 1000));
        process.stdout.write(`  Progress: ${totalRows} rows (${totalImported} imported, ${totalErrors} errors, ${rate} rows/s, ${elapsed}s)\r`);
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await drainToN(MAX_PENDING);
    pendingBatches.push(processBatch(batch));
  }

  // Wait for all pending
  const remaining = await Promise.all(pendingBatches);
  for (const r of remaining) {
    totalImported += r.imported;
    totalErrors += r.errors;
  }

  // For huge registries: recreate indexes and re-enable autovacuum
  if (isHuge && savedIndexes.length > 0) {
    console.log(`\n  Recreating ${savedIndexes.length} indexes...`);
    const idxStart = Date.now();
    await recreateIndexes(pool, config.tableName, savedIndexes);
    console.log(`  Indexes recreated in ${((Date.now() - idxStart) / 1000).toFixed(1)}s`);

    // Only now are the defs safe to forget.
    await clearSavedIndexDefs(pool, config.tableName);

    await pool.query(`ALTER TABLE ${config.tableName} SET (autovacuum_enabled = true)`);
    console.log(`  Running ANALYZE ${config.tableName}...`);
    await pool.query(`ANALYZE ${config.tableName}`);
  }

  const elapsed = (Date.now() - start) / 1000;
  console.log(`\n  CSV import complete: ${totalRows} rows, ${totalImported} imported, ${totalErrors} errors (${elapsed.toFixed(1)}s)`);

  // Batch failures are swallowed per-batch so one bad batch can't abort the run.
  // But a huge import that read rows and inserted none has already TRUNCATEd the
  // table, so "success" here would leave the registry empty and report OK.
  if (isHuge && totalRows > 0 && totalImported === 0) {
    throw new Error(
      `${config.name}: read ${totalRows} rows but imported 0 (${totalErrors} errors) — ` +
      `table was truncated and is now empty. Refusing to report success.`
    );
  }

  return { registry: config.name, imported: totalImported, errors: totalErrors, elapsed, totalRows };
}

/**
 * Parse a CSV line respecting quoted fields
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Map a CSV record to DB columns using fieldMap
 */
function mapCsvRecord(
  config: RegistryConfig,
  record: Record<string, string>,
  fallbackIndex: number
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};

  for (const [dbCol, mapping] of Object.entries(config.fieldMap)) {
    if (typeof mapping === 'function') {
      mapped[dbCol] = mapping('', record);
    } else {
      const value = record[mapping];
      mapped[dbCol] = value != null && value !== '' ? value : null;
    }
  }

  // Ensure unique key columns have values
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  for (const key of uniqueKeys) {
    if (!mapped[key] && mapped[key] !== 0) {
      mapped[key] = `gen_${fallbackIndex}`;
    }
  }

  return mapped;
}

/**
 * Plain INSERT (no ON CONFLICT) for huge registries after TRUNCATE.
 * No deduplication needed — table is empty.
 * Skips raw_data to reduce WAL volume.
 */
async function processCsvBatchPlainInsert(
  pool: Pool,
  config: RegistryConfig,
  records: Record<string, string>[],
  allColumns: string[],
  sourceFile: string,
  skipRawData: boolean
): Promise<{ imported: number; errors: number }> {
  const client: PoolClient = await pool.connect();
  try {
    const allValues: unknown[] = [];
    const rowPlaceholders: string[] = [];
    const colCount = allColumns.length;

    for (let j = 0; j < records.length; j++) {
      const mapped = mapCsvRecord(config, records[j], j + 1);
      const rowValues = allColumns.map(col => {
        if (col === 'raw_data') return skipRawData ? null : JSON.stringify(records[j]);
        if (col === 'source_file') return sourceFile;
        return mapped[col] ?? null;
      });

      const offset = j * colCount;
      const placeholders = rowValues.map((_, idx) => `$${offset + idx + 1}`);
      rowPlaceholders.push(`(${placeholders.join(', ')})`);
      allValues.push(...rowValues);
    }

    const sql = `INSERT INTO ${config.tableName} (${allColumns.join(', ')})
      VALUES ${rowPlaceholders.join(', ')}`;

    await client.query(sql, allValues);
    return { imported: records.length, errors: 0 };
  } catch (err) {
    console.error(`  Batch INSERT failed: ${err instanceof Error ? err.message : err}`);
    return { imported: 0, errors: records.length };
  } finally {
    client.release();
  }
}

/**
 * Process a batch using a single multi-row INSERT with ON CONFLICT (UPSERT).
 * Used for non-huge registries.
 * Falls back to row-by-row on error.
 */
async function processCsvBatchMultiRow(
  pool: Pool,
  config: RegistryConfig,
  records: Record<string, string>[],
  allColumns: string[],
  conflictTarget: string,
  updateCols: string[],
  sourceFile: string
): Promise<{ imported: number; errors: number }> {
  // Deduplicate within batch by unique key to avoid
  // "ON CONFLICT DO UPDATE command cannot affect row a second time"
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const seen = new Map<string, number>();
  const dedupedRecords: Record<string, string>[] = [];

  for (let j = 0; j < records.length; j++) {
    const mapped = mapCsvRecord(config, records[j], j + 1);
    const keyParts = uniqueKeys.map(k => String(mapped[k] ?? ''));
    const key = keyParts.join('|');
    if (seen.has(key)) {
      dedupedRecords[seen.get(key)!] = records[j];
    } else {
      seen.set(key, dedupedRecords.length);
      dedupedRecords.push(records[j]);
    }
  }

  const client: PoolClient = await pool.connect();
  try {
    const allValues: unknown[] = [];
    const rowPlaceholders: string[] = [];
    const colCount = allColumns.length;

    for (let j = 0; j < dedupedRecords.length; j++) {
      const mapped = mapCsvRecord(config, dedupedRecords[j], j + 1);
      const rowValues = allColumns.map(col => {
        if (col === 'raw_data') return JSON.stringify(dedupedRecords[j]);
        if (col === 'source_file') return sourceFile;
        return mapped[col] ?? null;
      });

      const offset = j * colCount;
      const placeholders = rowValues.map((_, idx) => `$${offset + idx + 1}`);
      rowPlaceholders.push(`(${placeholders.join(', ')})`);
      allValues.push(...rowValues);
    }

    const sql = `INSERT INTO ${config.tableName} (${allColumns.join(', ')})
      VALUES ${rowPlaceholders.join(', ')}
      ON CONFLICT (${conflictTarget}) DO UPDATE SET
        ${updateCols.join(', ')}`;

    await client.query(sql, allValues);
    return { imported: dedupedRecords.length, errors: records.length - dedupedRecords.length };
  } catch {
    // Multi-row failed — fall back to row-by-row with savepoints
    return await processCsvBatchRowByRow(client, config, records, allColumns, conflictTarget, updateCols, sourceFile);
  } finally {
    client.release();
  }
}

/**
 * Fallback: row-by-row insert with savepoints for error isolation
 */
async function processCsvBatchRowByRow(
  client: PoolClient,
  config: RegistryConfig,
  records: Record<string, string>[],
  allColumns: string[],
  conflictTarget: string,
  updateCols: string[],
  sourceFile: string
): Promise<{ imported: number; errors: number }> {
  let imported = 0;
  let errors = 0;

  try {
    await client.query('BEGIN');

    for (let j = 0; j < records.length; j++) {
      const sp = `sp_${j}`;
      try {
        await client.query(`SAVEPOINT ${sp}`);

        const mapped = mapCsvRecord(config, records[j], j + 1);
        const values = allColumns.map(col => {
          if (col === 'raw_data') return JSON.stringify(records[j]);
          if (col === 'source_file') return sourceFile;
          return mapped[col] ?? null;
        });
        const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');

        const sql = `INSERT INTO ${config.tableName} (${allColumns.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT (${conflictTarget}) DO UPDATE SET
            ${updateCols.join(', ')}`;

        await client.query(sql, values);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        imported++;
      } catch {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        errors++;
      }
    }

    await client.query('COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  }

  return { imported, errors };
}
