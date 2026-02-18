/**
 * Streaming import for all entity types (UO, FOP, FSU) from a single ZIP file.
 * Usage: node dist/scripts/import-all-streaming.js <zipPath>
 *
 * Environment config:
 *   IMPORT_BATCH_SIZE (default 500)
 */
import { Pool } from 'pg';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';
import { ImportProgress } from '../services/import-progress.js';
import { ParsedFOPEntity, ParsedFSUEntity, ParsedUOEntity } from '../services/xml-parser.js';

dotenv.config();

const BATCH_SIZE = parseInt(process.env.IMPORT_BATCH_SIZE || '500');

async function importAllStreaming(zipFilePath: string) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  const parser = new StreamingXMLParser();
  const importer = new DatabaseImporter(pool, { validate: true });

  try {
    console.log(`Opening ZIP file: ${zipFilePath}`);
    console.log(`Batch size: ${BATCH_SIZE}`);
    const directory = await unzipper.Open.file(zipFilePath);

    // Import UO (Legal Entities)
    console.log('\n=== Importing Legal Entities (UO) ===');
    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml' || f.path === 'UO.xml');
    if (uoFile) {
      const progress = new ImportProgress('UO', { estimatedTotal: 1_800_000 });
      progress.start();
      const count = await parser.parseBatched<ParsedUOEntity>(
        uoFile.stream(), 'UO', BATCH_SIZE,
        async (entities) => {
          const stats = await importer.importUOEntities(entities, BATCH_SIZE);
          progress.addImported(stats.imported);
          progress.addErrors(stats.errors);
          progress.addSkipped(stats.skipped);
        },
        () => progress.addParsed(1)
      );
      progress.stop();
      console.log(`Imported ${count} legal entities`);
    } else {
      console.log('UO XML not found, skipping...');
    }

    // Import FOP (Individual Entrepreneurs)
    console.log('\n=== Importing Individual Entrepreneurs (FOP) ===');
    const fopFile = directory.files.find(f => f.path === 'FOP_FULL_out.xml' || f.path === 'FOP.xml');
    if (fopFile) {
      const progress = new ImportProgress('FOP', { estimatedTotal: 2_000_000 });
      progress.start();
      const count = await parser.parseBatched<ParsedFOPEntity>(
        fopFile.stream(), 'FOP', BATCH_SIZE,
        async (entities) => {
          const stats = await importer.importFOPEntities(entities, BATCH_SIZE);
          progress.addImported(stats.imported);
          progress.addErrors(stats.errors);
          progress.addSkipped(stats.skipped);
        },
        () => progress.addParsed(1)
      );
      progress.stop();
      console.log(`Imported ${count} individual entrepreneurs`);
    } else {
      console.log('FOP XML not found, skipping...');
    }

    // Import FSU (Public Associations)
    console.log('\n=== Importing Public Associations (FSU) ===');
    const fsuFile = directory.files.find(f => f.path === 'FSU_FULL_out.xml' || f.path === 'FSU.xml');
    if (fsuFile) {
      const progress = new ImportProgress('FSU', { estimatedTotal: 100_000 });
      progress.start();
      const count = await parser.parseBatched<ParsedFSUEntity>(
        fsuFile.stream(), 'FSU', BATCH_SIZE,
        async (entities) => {
          const stats = await importer.importFSUEntities(entities, BATCH_SIZE);
          progress.addImported(stats.imported);
          progress.addErrors(stats.errors);
          progress.addSkipped(stats.skipped);
        },
        () => progress.addParsed(1)
      );
      progress.stop();
      console.log(`Imported ${count} public associations`);
    } else {
      console.log('FSU XML not found, skipping...');
    }

    // Post-import verification
    console.log('\n=== Verification ===');
    const counts = await Promise.all([
      pool.query('SELECT COUNT(*) FROM legal_entities'),
      pool.query('SELECT COUNT(*) FROM individual_entrepreneurs'),
      pool.query('SELECT COUNT(*) FROM public_associations'),
    ]);
    console.log(`Legal entities: ${counts[0].rows[0].count}`);
    console.log(`Individual entrepreneurs: ${counts[1].rows[0].count}`);
    console.log(`Public associations: ${counts[2].rows[0].count}`);

    const validationSummary = importer.getValidator()?.getSummary();
    if (validationSummary) {
      console.log(`\nValidation: ${validationSummary.valid} valid, ${validationSummary.skipped} skipped, ${validationSummary.warnings} with warnings`);
    }

    console.log('\nImport completed successfully!');
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

const zipPath = process.argv[2] || process.env.OPENREYESTR_DATA_PATH + '/20260126174103-69.zip';
if (!zipPath) {
  console.error('Please provide ZIP file path as argument or set OPENREYESTR_DATA_PATH environment variable');
  process.exit(1);
}

importAllStreaming(zipPath).catch(console.error);
