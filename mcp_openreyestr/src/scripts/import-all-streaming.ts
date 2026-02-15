import { Pool } from 'pg';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { StreamingXMLParser } from '../services/streaming-xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';
import { ParsedFOPEntity, ParsedFSUEntity, ParsedUOEntity } from '../services/xml-parser.js';

dotenv.config();

const BATCH_SIZE = 500;

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

  try {
    console.log(`Opening ZIP file: ${zipFilePath}`);
    const directory = await unzipper.Open.file(zipFilePath);

    // Import UO (Legal Entities)
    console.log('\n=== Importing Legal Entities (UO) ===');
    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml' || f.path === 'UO.xml');
    if (uoFile) {
      console.log('Processing UO XML file in streaming mode...');
      const count = await parser.parseBatched<ParsedUOEntity>(
        uoFile.stream(), 'UO', BATCH_SIZE,
        async (entities) => {
          await importer.importUOEntities(entities, BATCH_SIZE);
        }
      );
      console.log(`Imported ${count} legal entities`);
    } else {
      console.log('UO XML not found, skipping...');
    }

    // Import FOP (Individual Entrepreneurs)
    console.log('\n=== Importing Individual Entrepreneurs (FOP) ===');
    const fopFile = directory.files.find(f => f.path === 'FOP_FULL_out.xml' || f.path === 'FOP.xml');
    if (fopFile) {
      console.log('Processing FOP XML file in streaming mode...');
      const count = await parser.parseBatched<ParsedFOPEntity>(
        fopFile.stream(), 'FOP', BATCH_SIZE,
        async (entities) => {
          await importer.importFOPEntities(entities, BATCH_SIZE);
        }
      );
      console.log(`Imported ${count} individual entrepreneurs`);
    } else {
      console.log('FOP XML not found, skipping...');
    }

    // Import FSU (Public Associations)
    console.log('\n=== Importing Public Associations (FSU) ===');
    const fsuFile = directory.files.find(f => f.path === 'FSU_FULL_out.xml' || f.path === 'FSU.xml');
    if (fsuFile) {
      console.log('Processing FSU XML file in streaming mode...');
      const count = await parser.parseBatched<ParsedFSUEntity>(
        fsuFile.stream(), 'FSU', BATCH_SIZE,
        async (entities) => {
          await importer.importFSUEntities(entities, BATCH_SIZE);
        }
      );
      console.log(`Imported ${count} public associations`);
    } else {
      console.log('FSU XML not found, skipping...');
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
