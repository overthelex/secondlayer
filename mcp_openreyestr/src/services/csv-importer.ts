/**
 * CSV Streaming Importer
 * For large CSV registries (enforcement_proceedings, debtors).
 * Uses readline + iconv-lite for streaming without loading full file into memory.
 */

import { Pool, PoolClient } from 'pg';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import iconv from 'iconv-lite';
import { RegistryConfig } from '../config/registries';

const BATCH_SIZE = 500;
const PROGRESS_INTERVAL = 10000;

export interface CsvImportStats {
  registry: string;
  imported: number;
  errors: number;
  elapsed: number;
  totalRows: number;
}

/**
 * Import CSV file into database using registry config.
 * Streams line-by-line to handle files of any size.
 */
export async function importCsv(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<CsvImportStats> {
  const start = Date.now();
  const delimiter = config.csvDelimiter || ';';

  console.log(`  CSV delimiter: "${delimiter}", encoding: ${config.encoding}`);

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

  // Get DB column names and their CSV source field names
  const columns = Object.keys(config.fieldMap);
  const allColumns = [...columns, 'raw_data', 'source_file'];

  // Build ON CONFLICT clause
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const conflictTarget = uniqueKeys.join(', ');
  const updateCols = columns
    .filter(c => !uniqueKeys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .concat(['raw_data = EXCLUDED.raw_data', 'updated_at = CURRENT_TIMESTAMP']);

  for await (const line of rl) {
    lineNumber++;

    // First line is header
    if (lineNumber === 1) {
      headers = parseCsvLine(line, delimiter);
      console.log(`  CSV headers (${headers.length}): ${headers.slice(0, 5).join(', ')}...`);
      continue;
    }

    // Skip empty lines
    if (!line.trim()) continue;

    const values = parseCsvLine(line, delimiter);
    if (values.length < headers.length * 0.5) continue; // Skip malformed rows

    // Build record from headers + values
    const record: Record<string, string> = {};
    for (let i = 0; i < headers.length && i < values.length; i++) {
      record[headers[i]] = values[i];
    }

    batch.push(record);
    totalRows++;

    if (batch.length >= BATCH_SIZE) {
      const result = await processCsvBatch(pool, config, batch, allColumns, uniqueKeys, conflictTarget, updateCols, sourceFile);
      totalImported += result.imported;
      totalErrors += result.errors;
      batch = [];

      if (totalRows % PROGRESS_INTERVAL === 0) {
        process.stdout.write(`  Progress: ${totalRows} rows (${totalImported} imported, ${totalErrors} errors)\r`);
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    const result = await processCsvBatch(pool, config, batch, allColumns, uniqueKeys, conflictTarget, updateCols, sourceFile);
    totalImported += result.imported;
    totalErrors += result.errors;
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
          i++; // skip escaped quote
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
 * Process a batch of CSV records
 */
async function processCsvBatch(
  pool: Pool,
  config: RegistryConfig,
  records: Record<string, string>[],
  allColumns: string[],
  _uniqueKeys: string[],
  conflictTarget: string,
  updateCols: string[],
  sourceFile: string
): Promise<{ imported: number; errors: number }> {
  let imported = 0;
  let errors = 0;

  const client: PoolClient = await pool.connect();
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
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        errors++;
        if (errors <= 3) console.error(`  Error importing CSV row:`, err);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('  Batch failed:', err);
  } finally {
    client.release();
  }

  return { imported, errors };
}
