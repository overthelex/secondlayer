import { Pool } from 'pg';
import unzipper from 'unzipper';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';
import { OpenReyestrXMLParser } from '../services/xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';

dotenv.config();

async function importAll(zipFilePath: string) {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  const parser = new OpenReyestrXMLParser();
  const importer = new DatabaseImporter(pool);

  try {
    console.log(`Opening ZIP file: ${zipFilePath}`);
    const directory = await unzipper.Open.file(zipFilePath);

    // Import UO (Legal Entities)
    console.log('\n=== Importing Legal Entities (UO) ===');
    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml');
    if (uoFile) {
      console.log('Reading UO XML file...');
      const chunks: Buffer[] = [];
      await pipeline(
        uoFile.stream(),
        async function* (source) {
          for await (const chunk of source) {
            chunks.push(chunk);
          }
        }
      );
      const xmlContent = Buffer.concat(chunks).toString('utf-8');
      console.log('Parsing UO XML...');
      const entities = parser.parseUO(xmlContent);
      console.log(`Parsed ${entities.length} legal entities`);
      await importer.importUOEntities(entities, 1000);
    } else {
      console.log('UO_FULL_out.xml not found, skipping...');
    }

    // Import FOP (Individual Entrepreneurs)
    console.log('\n=== Importing Individual Entrepreneurs (FOP) ===');
    const fopFile = directory.files.find(f => f.path === 'FOP_FULL_out.xml');
    if (fopFile) {
      console.log('Reading FOP XML file...');
      const chunks: Buffer[] = [];
      await pipeline(
        fopFile.stream(),
        async function* (source) {
          for await (const chunk of source) {
            chunks.push(chunk);
          }
        }
      );
      const xmlContent = Buffer.concat(chunks).toString('utf-8');
      console.log('Parsing FOP XML...');
      const entities = parser.parseFOP(xmlContent);
      console.log(`Parsed ${entities.length} individual entrepreneurs`);
      await importer.importFOPEntities(entities, 1000);
    } else {
      console.log('FOP_FULL_out.xml not found, skipping...');
    }

    // Import FSU (Public Associations)
    console.log('\n=== Importing Public Associations (FSU) ===');
    const fsuFile = directory.files.find(f => f.path === 'FSU_FULL_out.xml');
    if (fsuFile) {
      console.log('Reading FSU XML file...');
      const chunks: Buffer[] = [];
      await pipeline(
        fsuFile.stream(),
        async function* (source) {
          for await (const chunk of source) {
            chunks.push(chunk);
          }
        }
      );
      const xmlContent = Buffer.concat(chunks).toString('utf-8');
      console.log('Parsing FSU XML...');
      const entities = parser.parseFSU(xmlContent);
      console.log(`Parsed ${entities.length} public associations`);
      await importer.importFSUEntities(entities, 1000);
    } else {
      console.log('FSU_FULL_out.xml not found, skipping...');
    }

    console.log('\n=== Import completed successfully! ===');
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

importAll(zipPath).catch(console.error);
