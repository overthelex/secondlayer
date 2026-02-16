/**
 * Generic XML Importer
 * Config-driven XML parser and database importer for NAIS registries.
 * Uses fast-xml-parser for small/medium files, SAX streaming for large files.
 * Streaming path uses pipelined multi-row INSERTs for throughput.
 */

import { Pool, PoolClient } from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Transform } from 'stream';
// @ts-ignore - no type declarations for sax
import sax from 'sax';
import iconv from 'iconv-lite';
import { RegistryConfig } from '../config/registries';

const BATCH_SIZE = 2000;

/**
 * Collect records from parsed XML, handling multi-section structures.
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

const STREAMING_THRESHOLD = 50 * 1024 * 1024;

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
    console.log(`  Using SAX streaming parser (batch=${BATCH_SIZE}, multi-row INSERT)`);
    stats = await importXmlStreaming(pool, config, filePath, sourceFile);
  } else {
    console.log(`  Using in-memory parser`);
    stats = await importXmlInMemory(pool, config, filePath, sourceFile);
  }

  stats.elapsed = (Date.now() - start) / 1000;
  return stats;
}

/**
 * In-memory XML parsing for small/medium files
 */
async function importXmlInMemory(
  pool: Pool,
  config: RegistryConfig,
  filePath: string,
  sourceFile: string
): Promise<ImportStats> {
  const { readFileSync } = require('fs');
  const rawBuffer = readFileSync(filePath);
  const xmlContent = config.encoding === 'utf-8'
    ? rawBuffer.toString('utf-8')
    : iconv.decode(rawBuffer, config.encoding);

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  });
  const result = parser.parse(xmlContent);

  let records = collectRecords(result, config.recordPath);
  if (records.length === 0) {
    console.error(`  No records found at path: ${config.recordPath}`);
    return { registry: config.name, imported: 0, errors: 0, elapsed: 0 };
  }

  console.log(`  Parsed ${records.length} records`);
  let imported = 0;
  let errors = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const result = await multiRowUpsert(pool, config, batch, sourceFile);
    imported += result.imported;
    errors += result.errors;
  }
  return { registry: config.name, imported, errors, elapsed: 0 };
}

/**
 * SAX streaming with sequential multi-row INSERTs.
 * Graceful on SAX errors — returns partial results instead of rejecting.
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

    const fileStream = createReadStream(filePath, { highWaterMark: 256 * 1024 });

    let currentRecord: Record<string, unknown> | null = null;
    let currentTag = '';
    let currentText = '';
    let currentAttrs: Record<string, string> = {};
    let tagStack: string[] = [];
    // For item-based XML (EDRNPA): <item name="X"><text>Y</text></item>
    let currentItemName: string | null = null;
    let itemArray: Record<string, string>[] | null = null;
    let batch: Record<string, unknown>[] = [];
    let pendingBatch: Promise<void> | null = null;
    let totalImported = 0;
    let totalErrors = 0;
    let recordCount = 0;
    const startTime = Date.now();

    saxStream.on('opentag', (node: sax.Tag) => {
      tagStack.push(node.name);
      if (node.name === recordTag) {
        currentRecord = {};
        itemArray = null;
      }
      if (currentRecord) {
        currentTag = node.name;
        currentText = '';
        currentAttrs = node.attributes as Record<string, string>;
        // Track <item name="..."> for item-based XML
        if (node.name === 'item' && currentAttrs.name) {
          currentItemName = currentAttrs.name;
        }
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
      if (currentRecord) {
        const trimmed = currentText.trim();

        if (tagName === 'text' && currentItemName) {
          // Inside <item name="X"><text>Y</text></item> — build item array for extractItemText
          if (!itemArray) itemArray = [];
          itemArray.push({ '@_name': currentItemName, text: trimmed });
        } else if (tagName === 'item' && currentItemName) {
          currentItemName = null;
        } else if (tagName !== recordTag && trimmed && !currentItemName) {
          // Simple flat field (non-item XML)
          currentRecord[currentTag] = trimmed;
        }
      }
      currentTag = '';
      currentText = '';
      tagStack.pop();

      if (tagName === recordTag && currentRecord) {
        // Attach item array if present (for extractItemText compatibility)
        if (itemArray && itemArray.length > 0) {
          currentRecord['item'] = itemArray;
        }
        batch.push(currentRecord);
        currentRecord = null;
        itemArray = null;
        recordCount++;

        if (batch.length >= BATCH_SIZE) {
          const batchToProcess = batch;
          batch = [];
          fileStream.pause();
          pendingBatch = multiRowUpsert(pool, config, batchToProcess, sourceFile)
            .then(stats => {
              totalImported += stats.imported;
              totalErrors += stats.errors;
              if (recordCount % 10000 < BATCH_SIZE) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                const rate = Math.round(totalImported / ((Date.now() - startTime) / 1000)) || 0;
                console.log(`  [${elapsed}s] ${config.name}: ${totalImported} imported, ${totalErrors} errors (${rate}/s)`);
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

    const finalize = async () => {
      if (pendingBatch) await pendingBatch;
      if (batch.length > 0) {
        const stats = await multiRowUpsert(pool, config, batch, sourceFile);
        totalImported += stats.imported;
        totalErrors += stats.errors;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n  Streaming complete: ${recordCount} records, ${totalImported} imported, ${totalErrors} errors in ${elapsed}s`);
      resolve({ registry: config.name, imported: totalImported, errors: totalErrors, elapsed: 0 });
    };

    saxStream.on('end', finalize);

    saxStream.on('error', (err: Error) => {
      console.warn(`  SAX parse warning (continuing): ${err.message.split('\n')[0]}`);
      finalize();
    });

    fileStream.on('error', (err: Error) => {
      console.error('  File stream error:', err.message);
      reject(err);
    });

    // Strip control characters (like \x1A EOF marker) that break SAX parsing
    const sanitizer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        // Replace \x1A (SUB/EOF) and other invalid XML control chars with space
        const buf = Buffer.from(chunk);
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i];
          if (b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) {
            buf[i] = 0x20; // replace with space
          }
        }
        callback(null, buf);
      }
    });

    if (config.encoding !== 'utf-8') {
      const decoder = iconv.decodeStream(config.encoding);
      decoder.on('error', (err: Error) => {
        console.error('  Decoder stream error:', err.message);
        reject(err);
      });
      fileStream.pipe(decoder).pipe(sanitizer).pipe(saxStream);
    } else {
      fileStream.pipe(sanitizer).pipe(saxStream);
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
      const strValue = value != null ? String(value).trim() : null;
      mapped[dbCol] = strValue === '' ? null : strValue;
    }
  }

  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  for (const key of uniqueKeys) {
    if (!mapped[key] && mapped[key] !== 0) {
      mapped[key] = `gen_${fallbackIndex}`;
    }
  }

  return mapped;
}

/**
 * Multi-row INSERT ... VALUES (...),(...),... ON CONFLICT DO UPDATE
 * Single round-trip per batch. Falls back to row-by-row on failure.
 */
async function multiRowUpsert(
  pool: Pool,
  config: RegistryConfig,
  records: Record<string, unknown>[],
  sourceFile: string
): Promise<{ imported: number; errors: number }> {
  const columns = Object.keys(config.fieldMap);
  const allColumns = [...columns, 'raw_data', 'source_file'];
  const colCount = allColumns.length;

  const uniqueKeys = Array.isArray(config.uniqueKey) ? config.uniqueKey : [config.uniqueKey];
  const conflictTarget = uniqueKeys.join(', ');
  const updateCols = columns
    .filter(c => !uniqueKeys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .concat(['raw_data = EXCLUDED.raw_data', 'updated_at = CURRENT_TIMESTAMP']);

  const allValues: unknown[] = [];
  const rowPlaceholders: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const mapped = mapRecord(config, records[i], i + 1);
    const offset = i * colCount;
    const ph: string[] = [];
    for (let c = 0; c < allColumns.length; c++) {
      const col = allColumns[c];
      ph.push(`$${offset + c + 1}`);
      if (col === 'raw_data') {
        allValues.push(JSON.stringify(records[i]));
      } else if (col === 'source_file') {
        allValues.push(sourceFile);
      } else {
        allValues.push(mapped[col] ?? null);
      }
    }
    rowPlaceholders.push(`(${ph.join(', ')})`);
  }

  const sql = `INSERT INTO ${config.tableName} (${allColumns.join(', ')})
    VALUES ${rowPlaceholders.join(', ')}
    ON CONFLICT (${conflictTarget}) DO UPDATE SET
      ${updateCols.join(', ')}`;

  const client: PoolClient = await pool.connect();
  try {
    await client.query(sql, allValues);
    return { imported: records.length, errors: 0 };
  } catch (err) {
    // Batch failed — fall back to row-by-row to isolate bad records
    let imported = 0;
    let errors = 0;
    for (let j = 0; j < records.length; j++) {
      try {
        const mapped = mapRecord(config, records[j], j + 1);
        const values = allColumns.map((col) => {
          if (col === 'raw_data') return JSON.stringify(records[j]);
          if (col === 'source_file') return sourceFile;
          return mapped[col] ?? null;
        });
        const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
        const rowSql = `INSERT INTO ${config.tableName} (${allColumns.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT (${conflictTarget}) DO UPDATE SET
            ${updateCols.join(', ')}`;
        await client.query(rowSql, values);
        imported++;
      } catch (rowErr) {
        errors++;
        if (errors <= 3) console.error(`  Error importing record:`, rowErr);
      }
    }
    return { imported, errors };
  } finally {
    client.release();
  }
}
