/**
 * CSV Streaming Importer — Parallel Workers
 * For large CSV registries (enforcement_proceedings, debtors).
 * Uses readline + iconv-lite for streaming, with N parallel DB workers
 * doing multi-row INSERTs for maximum throughput.
 *
 * For "huge" registries: TRUNCATE + plain INSERT (no ON CONFLICT),
 * drop/recreate indexes, bigger batches, skip raw_data column.
 * Huge registries with upsertOnReload keep their UNIQUE key index during the
 * load and insert with ON CONFLICT (key) DO UPDATE instead (LEXAI-2130).
 */

import { Pool, PoolClient } from 'pg';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import iconv from 'iconv-lite';
import { RegistryConfig } from '../config/registries';
import { fillMissingUniqueKeys } from './synthetic-keys';
import { dedupeAndSortByKey, isUniqueKeyIndex, rowKey, uniqueKeyColumns } from './unique-key-load';

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
async function dropIndexes(
  pool: Pool,
  tableName: string,
  keep: (indexdef: string) => boolean = () => false
): Promise<IndexDef[]> {
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
    if (keep(idx.indexdef)) {
      console.log(`  Keeping index during load: ${idx.indexname}`);
      continue;
    }
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
  const uniqueKeys = uniqueKeyColumns(config);
  const upsertOnReload = isHuge && config.upsertOnReload === true;
  const batchSize = isHuge ? BATCH_SIZE_HUGE : BATCH_SIZE_NORMAL;

  console.log(`  CSV delimiter: "${delimiter}", encoding: ${config.encoding}, workers: ${NUM_WORKERS}, mode: ${upsertOnReload ? 'TRUNCATE+UPSERT' : isHuge ? 'TRUNCATE+INSERT' : 'UPSERT'}, batch: ${batchSize}`);

  // For huge registries: truncate and drop indexes for max throughput
  let savedIndexes: IndexDef[] = [];
  if (isHuge) {
    const keepKeyIndex = (indexdef: string) => upsertOnReload && isUniqueKeyIndex(indexdef, uniqueKeys);
    if (upsertOnReload) {
      // Check before TRUNCATE: without the key index ON CONFLICT (key) fails on
      // every batch and the table would be left empty.
      const { rows: idx } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = $1`,
        [config.tableName]
      );
      if (!idx.some(i => keepKeyIndex(i.indexdef))) {
        throw new Error(
          `${config.name}: no UNIQUE index on (${uniqueKeys.join(', ')}) in ${config.tableName}; ` +
          `run the openreyestr migrations before importing. Table left untouched.`
        );
      }
    }
    console.log(`  TRUNCATE ${config.tableName}...`);
    // RESTART IDENTITY bounds sequence growth to a single run. Without it each
    // daily reimport permanently consumed ~N sequence values and the id
    // sequence eventually overflowed its type (see migration 017).
    await pool.query(`TRUNCATE ${config.tableName} RESTART IDENTITY`);
    savedIndexes = await dropIndexes(pool, config.tableName, keepKeyIndex);

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

  // Build ON CONFLICT clause (non-huge, and huge with upsertOnReload)
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

  // batchStart = 0-based position of records[0] among all data rows, so gen_<n>
  // surrogates are numbered across the whole file, not per batch (LEXAI-2129).
  // Duplicate keys split across concurrent batches resolve in whichever order
  // the batches commit; in the ЄРБ file every such duplicate is an exact copy
  // (LEXAI-2130), so the surviving row is the same either way.
  const processBatch = isHuge && !upsertOnReload
    ? (records: Record<string, string>[], batchStart: number) =>
        processCsvBatchPlainInsert(pool, config, records, allColumns, sourceFile, isHuge, batchStart)
    : (records: Record<string, string>[], batchStart: number) =>
        processCsvBatchMultiRow(pool, config, records, allColumns, conflictTarget, updateCols, sourceFile, batchStart);

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

      pendingBatches.push(processBatch(batchToProcess, totalRows - batchToProcess.length));

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
    pendingBatches.push(processBatch(batch, totalRows - batch.length));
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

  // Ensure unique key columns have values (except nullableKeyColumns)
  fillMissingUniqueKeys(config, mapped, fallbackIndex);

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
  skipRawData: boolean,
  batchStart: number
): Promise<{ imported: number; errors: number }> {
  const client: PoolClient = await pool.connect();
  try {
    const allValues: unknown[] = [];
    const rowPlaceholders: string[] = [];
    const colCount = allColumns.length;

    for (let j = 0; j < records.length; j++) {
      const mapped = mapCsvRecord(config, records[j], batchStart + j + 1);
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
  sourceFile: string,
  batchStart: number
): Promise<{ imported: number; errors: number }> {
  // Deduplicate within batch by unique key to avoid
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  // Each record is mapped once, so the surrogate used for dedup is the one
  // inserted. The last occurrence wins; rows are sorted by key so parallel
  // batches take row locks in the same order.
  const uniqueKeys = uniqueKeyColumns(config);
  const { rows: deduped } = dedupeAndSortByKey(
    records.map((record, j) => ({ record, mapped: mapCsvRecord(config, record, batchStart + j + 1) })),
    r => rowKey(r.mapped, uniqueKeys)
  );

  const client: PoolClient = await pool.connect();
  try {
    const allValues: unknown[] = [];
    const rowPlaceholders: string[] = [];
    const colCount = allColumns.length;

    for (let j = 0; j < deduped.length; j++) {
      const { record, mapped } = deduped[j];
      const rowValues = allColumns.map(col => {
        if (col === 'raw_data') return JSON.stringify(record);
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
    return { imported: deduped.length, errors: records.length - deduped.length };
  } catch {
    // Multi-row failed — fall back to row-by-row with savepoints,
    // over the same deduped, key-sorted rows, so it neither hits a key twice
    // nor takes row locks in a different order.
    return await processCsvBatchRowByRow(client, config, deduped, records.length, allColumns, conflictTarget, updateCols, sourceFile);
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
  rows: { record: Record<string, string>; mapped: Record<string, unknown> }[],
  sourceRowCount: number,
  allColumns: string[],
  conflictTarget: string,
  updateCols: string[],
  sourceFile: string
): Promise<{ imported: number; errors: number }> {
  let imported = 0;
  // Rows collapsed by the in-batch dedupe count as not imported, as in the
  // multi-row path.
  let errors = sourceRowCount - rows.length;

  try {
    await client.query('BEGIN');

    for (let j = 0; j < rows.length; j++) {
      const sp = `sp_${j}`;
      try {
        await client.query(`SAVEPOINT ${sp}`);

        const { record, mapped } = rows[j];
        const values = allColumns.map(col => {
          if (col === 'raw_data') return JSON.stringify(record);
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
