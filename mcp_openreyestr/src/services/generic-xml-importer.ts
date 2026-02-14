/**
 * Generic XML Importer
 * Config-driven XML parser and database importer for NAIS registries.
 * Uses fast-xml-parser for small/medium files, SAX streaming for large files.
 */

import { Pool, PoolClient } from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
// @ts-ignore - no type declarations for sax
import sax from 'sax';
import iconv from 'iconv-lite';
import { RegistryConfig, getNestedValue } from '../config/registries';

const BATCH_SIZE = 500;
/** Files above this size (bytes) use SAX streaming parser */
const STREAMING_THRESHOLD = 500 * 1024 * 1024; // 500 MB

export interface ImportStats {
  registry: string;
  imported: number;
  errors: number;
  elapsed: number;
}

/**
 * Import XML file into database using registry config.
 * Automatically chooses in-memory or streaming parser based on file size.
 */
export async function importXml(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<ImportStats> {
  const start = Date.now();
  const fileInfo = await stat(filePath);

  console.log(`  XML file size: ${(fileInfo.size / 1024 / 1024).toFixed(1)} MB`);

  let stats: ImportStats;
  if (fileInfo.size > STREAMING_THRESHOLD || config.sizeCategory === 'large') {
    console.log(`  Using SAX streaming parser (file > ${STREAMING_THRESHOLD / 1024 / 1024} MB or large category)`);
    stats = await importXmlStreaming(pool, config, filePath, sourceFile);
  } else {
    console.log(`  Using in-memory parser`);
    stats = await importXmlInMemory(pool, config, filePath, sourceFile);
  }

  stats.elapsed = (Date.now() - start) / 1000;
  return stats;
}

/**
 * In-memory XML parsing for small/medium files (<500MB)
 */
async function importXmlInMemory(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<ImportStats> {
  // Read and decode
  const { readFileSync } = require('fs');
  const rawBuffer = readFileSync(filePath);
  const xmlContent = config.encoding === 'utf-8'
    ? rawBuffer.toString('utf-8')
    : iconv.decode(rawBuffer, config.encoding);

  // Parse XML
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  });
  const result = parser.parse(xmlContent);

  // Navigate to records using recordPath (e.g. "DATA.RECORD")
  let records = getNestedValue(result, config.recordPath) as Record<string, unknown>[] | Record<string, unknown>;
  if (!records) {
    console.error(`  No records found at path: ${config.recordPath}`);
    return { registry: config.name, imported: 0, errors: 0, elapsed: 0 };
  }
  if (!Array.isArray(records)) records = [records];

  console.log(`  Parsed ${records.length} records`);
  return batchUpsert(pool, config, records, sourceFile);
}

/**
 * SAX streaming XML parsing for large files (>500MB)
 */
async function importXmlStreaming(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<ImportStats> {
  return new Promise((resolve, reject) => {
    const saxStream = sax.createStream(true, { trim: true });
    const pathParts = config.recordPath.split('.');
    const recordTag = pathParts[pathParts.length - 1];

    let currentRecord: Record<string, string> | null = null;
    let currentTag = '';
    let tagStack: string[] = [];
    let batch: Record<string, unknown>[] = [];
    let totalImported = 0;
    let totalErrors = 0;
    let recordCount = 0;

    saxStream.on('opentag', (node: sax.Tag) => {
      tagStack.push(node.name);
      if (node.name === recordTag) {
        currentRecord = {};
      }
      if (currentRecord) {
        currentTag = node.name;
      }
    });

    saxStream.on('text', (text: string) => {
      if (currentRecord && currentTag && text.trim()) {
        currentRecord[currentTag] = text.trim();
      }
    });

    saxStream.on('closetag', (tagName: string) => {
      tagStack.pop();
      if (tagName === recordTag && currentRecord) {
        batch.push(currentRecord);
        currentRecord = null;
        recordCount++;

        if (batch.length >= BATCH_SIZE) {
          const batchToProcess = batch;
          batch = [];
          // Process batch asynchronously
          saxStream.pause();
          batchUpsert(pool, config, batchToProcess, sourceFile)
            .then(stats => {
              totalImported += stats.imported;
              totalErrors += stats.errors;
              process.stdout.write(`  Progress: ${recordCount} records processed\r`);
              saxStream.resume();
            })
            .catch(err => {
              console.error('  Batch error:', err);
              saxStream.resume();
            });
        }
      }
      if (tagStack.length === 0 || tagStack[tagStack.length - 1] !== recordTag) {
        currentTag = '';
      }
    });

    saxStream.on('end', async () => {
      // Process remaining batch
      if (batch.length > 0) {
        const stats = await batchUpsert(pool, config, batch, sourceFile);
        totalImported += stats.imported;
        totalErrors += stats.errors;
      }
      console.log(`\n  Streaming complete: ${recordCount} records processed`);
      resolve({ registry: config.name, imported: totalImported, errors: totalErrors, elapsed: 0 });
    });

    saxStream.on('error', (err: Error) => {
      console.error('  SAX parse error:', err.message);
      reject(err);
    });

    // Pipe file through iconv decoder then sax
    const fileStream = createReadStream(filePath);
    if (config.encoding !== 'utf-8') {
      fileStream.pipe(iconv.decodeStream(config.encoding)).pipe(saxStream);
    } else {
      fileStream.pipe(saxStream);
    }
  });
}

/**
 * Map a raw XML record to DB columns using the registry's fieldMap
 */
function mapRecord(
  config: RegistryConfig,
  record: Record<string, unknown>,
  fallbackIndex: number
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};

  for (const [dbCol, mapping] of Object.entries(config.fieldMap)) {
    if (typeof mapping === 'function') {
      mapped[dbCol] = mapping('', record);
    } else {
      const value = record[mapping];
      mapped[dbCol] = value != null ? String(value) : null;
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
 * Batch upsert records into the database
 */
async function batchUpsert(
  pool: Pool,
  config: RegistryConfig,
  records: Record<string, unknown>[],
  sourceFile: string
): Promise<ImportStats> {
  let imported = 0;
  let errors = 0;

  // Get column names from fieldMap
  const columns = Object.keys(config.fieldMap);
  const allColumns = [...columns, 'raw_data', 'source_file'];

  // Build ON CONFLICT clause
  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const conflictTarget = uniqueKeys.join(', ');
  const updateCols = columns
    .filter(c => !uniqueKeys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .concat(['raw_data = EXCLUDED.raw_data', 'updated_at = CURRENT_TIMESTAMP']);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let j = 0; j < batch.length; j++) {
        const sp = `sp_${j}`;
        try {
          await client.query(`SAVEPOINT ${sp}`);

          const mapped = mapRecord(config, batch[j], i + j + 1);
          const values = allColumns.map((col) => {
            if (col === 'raw_data') return JSON.stringify(batch[j]);
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
          if (errors <= 3) console.error(`  Error importing record:`, err);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  Batch failed:', err);
    } finally {
      client.release();
    }
  }

  return { registry: config.name, imported, errors, elapsed: 0 };
}
