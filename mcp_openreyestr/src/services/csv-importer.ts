/**
 * CSV Streaming Importer — Parallel Workers
 * For large CSV registries (enforcement_proceedings, debtors).
 * Uses readline + iconv-lite for streaming, with N parallel DB workers
 * doing multi-row INSERTs for maximum throughput.
 */

import { Pool, PoolClient } from 'pg';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import iconv from 'iconv-lite';
import { RegistryConfig } from '../config/registries';

const BATCH_SIZE = 1000;
const PROGRESS_INTERVAL = 10000;
const NUM_WORKERS = parseInt(process.env.CSV_IMPORT_WORKERS || '10', 10);

export interface CsvImportStats {
  registry: string;
  imported: number;
  errors: number;
  elapsed: number;
  totalRows: number;
}

/**
 * Import CSV file into database using registry config.
 * Streams line-by-line, dispatches batches to N parallel workers.
 */
export async function importCsv(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<CsvImportStats> {
  const start = Date.now();
  const delimiter = config.csvDelimiter || ';';

  console.log(`  CSV delimiter: "${delimiter}", encoding: ${config.encoding}, workers: ${NUM_WORKERS}`);

  // Set up streaming pipeline
  const fileStream = createReadStream(filePath);
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

  // Get DB column names
  const columns = Object.keys(config.fieldMap);
  const allColumns = [...columns, 'raw_data', 'source_file'];

  // Build ON CONFLICT clause
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const conflictTarget = uniqueKeys.join(', ');
  const updateCols = columns
    .filter(c => !uniqueKeys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .concat(['raw_data = EXCLUDED.raw_data', 'updated_at = CURRENT_TIMESTAMP']);

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

    if (batch.length >= BATCH_SIZE) {
      // Drain if too many pending
      await drainToN(MAX_PENDING);

      const batchToProcess = batch;
      batch = [];

      pendingBatches.push(
        processCsvBatchMultiRow(pool, config, batchToProcess, allColumns, conflictTarget, updateCols, sourceFile)
      );

      if (totalRows % PROGRESS_INTERVAL === 0) {
        process.stdout.write(`  Progress: ${totalRows} rows (${totalImported} imported, ${totalErrors} errors)\r`);
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await drainToN(MAX_PENDING);
    pendingBatches.push(
      processCsvBatchMultiRow(pool, config, batch, allColumns, conflictTarget, updateCols, sourceFile)
    );
  }

  // Wait for all pending
  const remaining = await Promise.all(pendingBatches);
  for (const r of remaining) {
    totalImported += r.imported;
    totalErrors += r.errors;
  }

  const elapsed = (Date.now() - start) / 1000;
  console.log(`\n  CSV import complete: ${totalRows} rows, ${totalImported} imported, ${totalErrors} errors (${elapsed.toFixed(1)}s)`);

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
 * Process a batch using a single multi-row INSERT.
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
      // Keep last occurrence (overwrite)
      dedupedRecords[seen.get(key)!] = records[j];
    } else {
      seen.set(key, dedupedRecords.length);
      dedupedRecords.push(records[j]);
    }
  }

  const client: PoolClient = await pool.connect();
  try {
    // Build multi-row VALUES
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
