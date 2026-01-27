import { Pool } from 'pg';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';
import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from '../services/xml-parser.js';

dotenv.config();

async function importAllStreaming(zipFilePath: string) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  const parser = new StreamingXMLParser();
  const importer = new DatabaseImporter(pool);
  const BATCH_SIZE = 500;

  try {
    console.log(`Opening ZIP file: ${zipFilePath}`);
    const directory = await unzipper.Open.file(zipFilePath);

    // Import UO (Legal Entities)
    console.log('\n=== Importing Legal Entities (UO) ===');
    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml');
    if (uoFile) {
      console.log('Processing UO XML file in streaming mode...');
      let uoBatch: ParsedUOEntity[] = [];
      let uoTotal = 0;

      const count = await parser.parseUOStream(uoFile.stream(), async (entity) => {
        uoBatch.push(entity);
        if (uoBatch.length >= BATCH_SIZE) {
          await importer.importUOEntities(uoBatch, BATCH_SIZE);
          uoTotal += uoBatch.length;
          uoBatch = [];
        }
      });

      // Import remaining entities
      if (uoBatch.length > 0) {
        await importer.importUOEntities(uoBatch, BATCH_SIZE);
        uoTotal += uoBatch.length;
      }

      console.log(`✓ Imported ${count} legal entities`);
    } else {
      console.log('UO_FULL_out.xml not found, skipping...');
    }

    // Import FOP (Individual Entrepreneurs)
    console.log('\n=== Importing Individual Entrepreneurs (FOP) ===');
    const fopFile = directory.files.find(f => f.path === 'FOP_FULL_out.xml');
    if (fopFile) {
      console.log('Processing FOP XML file in streaming mode...');
      let fopBatch: ParsedFOPEntity[] = [];
      let fopTotal = 0;

      const count = await parser.parseFOPStream(fopFile.stream(), async (entity) => {
        fopBatch.push(entity);
        if (fopBatch.length >= BATCH_SIZE) {
          await importer.importFOPEntities(fopBatch, BATCH_SIZE);
          fopTotal += fopBatch.length;
          fopBatch = [];
        }
      });

      // Import remaining entities
      if (fopBatch.length > 0) {
        await importer.importFOPEntities(fopBatch, BATCH_SIZE);
        fopTotal += fopBatch.length;
      }

      console.log(`✓ Imported ${count} individual entrepreneurs`);
    } else {
      console.log('FOP_FULL_out.xml not found, skipping...');
    }

    // Import FSU (Public Associations)
    console.log('\n=== Importing Public Associations (FSU) ===');
    const fsuFile = directory.files.find(f => f.path === 'FSU_FULL_out.xml');
    if (fsuFile) {
      console.log('Processing FSU XML file in streaming mode...');
      let fsuBatch: ParsedFSUEntity[] = [];
      let fsuTotal = 0;

      const count = await parser.parseFSUStream(fsuFile.stream(), async (entity) => {
        fsuBatch.push(entity);
        if (fsuBatch.length >= BATCH_SIZE) {
          await importer.importFSUEntities(fsuBatch, BATCH_SIZE);
          fsuTotal += fsuBatch.length;
          fsuBatch = [];
        }
      });

      // Import remaining entities
      if (fsuBatch.length > 0) {
        await importer.importFSUEntities(fsuBatch, BATCH_SIZE);
        fsuTotal += fsuBatch.length;
      }

      console.log(`✓ Imported ${count} public associations`);
    } else {
      console.log('FSU_FULL_out.xml not found, skipping...');
    }

    console.log('\n✅ Import completed successfully!');
  } catch (error) {
    console.error('❌ Import failed:', error);
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
