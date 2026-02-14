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
import { RegistryConfig } from '../config/registries';

const BATCH_SIZE = 500;

/**
 * Collect records from parsed XML, handling multi-section structures.
 * E.g. for path "rna.database.document" where database has multiple numbered sections,
 * collects all document records from all sections.
 */
function collectRecords(obj: Record<string, unknown>, path: string): Record<string, unknown>[] {
  const parts = path.split('.');
  let current: unknown[] = [obj];

  for (const part of parts) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node == null || typeof node !== 'object') continue;
      const rec = node as Record<string, unknown>;
      if (rec[part] !== undefined) {
        const val = rec[part];
        if (Array.isArray(val)) {
          next.push(...val);
        } else {
          next.push(val);
        }
      } else {
        // Check if this is a numbered/multi-section object (keys are indices)
        // e.g. { "0": { document: [...] }, "1": { document: [...] } }
        for (const key of Object.keys(rec)) {
          const child = rec[key];
          if (child != null && typeof child === 'object' && !Array.isArray(child)) {
            const childRec = child as Record<string, unknown>;
            if (childRec[part] !== undefined) {
              const val = childRec[part];
              if (Array.isArray(val)) {
                next.push(...val);
              } else {
                next.push(val);
              }
            }
          }
        }
      }
    }
    current = next;
  }

  return current.filter(r => r != null && typeof r === 'object') as Record<string, unknown>[];
}
/** Files above this size (bytes) use SAX streaming parser */
const STREAMING_THRESHOLD = 50 * 1024 * 1024; // 50 MB — files >50MB cause stack overflow in fast-xml-parser

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
  let records = collectRecords(result, config.recordPath);
  if (records.length === 0) {
    console.error(`  No records found at path: ${config.recordPath}`);
    return { registry: config.name, imported: 0, errors: 0, elapsed: 0 };
  }

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

    // Source stream — we pause/resume this for backpressure (sax stream has no pause/resume)
    const fileStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    let currentRecord: Record<string, string> | null = null;
    let currentTag = '';
    let currentText = '';
    let tagStack: string[] = [];
    let batch: Record<string, unknown>[] = [];
    let pendingBatch: Promise<void> | null = null;
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
        currentText = '';
      }
    });

    saxStream.on('text', (text: string) => {
      if (currentRecord && currentTag) {
        currentText += text;
      }
    });

    saxStream.on('cdata', (text: string) => {
      if (currentRecord && currentTag) {
        currentText += text;
      }
    });

    saxStream.on('closetag', (tagName: string) => {
      if (currentRecord && currentTag === tagName && tagName !== recordTag) {
        const trimmed = currentText.trim();
        if (trimmed) {
          currentRecord[currentTag] = trimmed;
        }
      }
      currentTag = '';
      currentText = '';
      tagStack.pop();

      if (tagName === recordTag && currentRecord) {
        batch.push(currentRecord);
        currentRecord = null;
        recordCount++;

        if (batch.length >= BATCH_SIZE) {
          const batchToProcess = batch;
          batch = [];
          // Pause the source file stream for backpressure
          fileStream.pause();
          pendingBatch = batchUpsert(pool, config, batchToProcess, sourceFile)
            .then(stats => {
              totalImported += stats.imported;
              totalErrors += stats.errors;
              if (recordCount % 10000 < BATCH_SIZE) {
                process.stdout.write(`  Progress: ${recordCount} records processed\r`);
              }
              pendingBatch = null;
              fileStream.resume();
            })
            .catch(err => {
              console.error('  Batch error:', err);
              pendingBatch = null;
              fileStream.resume();
            });
        }
      }
    });

    saxStream.on('end', async () => {
      // Wait for any pending batch to finish
      if (pendingBatch) {
        await pendingBatch;
      }
      // Process remaining batch
      if (batch.length > 0) {
        const stats = await batchUpsert(pool, config, batch, sourceFile);
        totalImported += stats.imported;
        totalErrors += stats.errors;
      }
      console.log(`\n  Streaming complete: ${recordCount} records, ${totalImported} imported, ${totalErrors} errors`);
      resolve({ registry: config.name, imported: totalImported, errors: totalErrors, elapsed: 0 });
    });

    saxStream.on('error', (err: Error) => {
      console.error('  SAX parse error:', err.message);
      reject(err);
    });

    fileStream.on('error', (err: Error) => {
      console.error('  File stream error:', err.message);
      reject(err);
    });

    if (config.encoding !== 'utf-8') {
      const decoder = iconv.decodeStream(config.encoding);
      decoder.on('error', (err: Error) => {
        console.error('  Decoder stream error:', err.message);
        reject(err);
      });
      fileStream.pipe(decoder).pipe(saxStream);
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
      // Convert empty strings to null (prevents PG "invalid input syntax for type date" errors)
      const strValue = value != null ? String(value).trim() : null;
      mapped[dbCol] = strValue === '' ? null : strValue;
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
