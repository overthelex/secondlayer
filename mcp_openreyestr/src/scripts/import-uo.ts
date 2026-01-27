import { Pool } from 'pg';
import { createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import unzipper from 'unzipper';
import dotenv from 'dotenv';
import { OpenReyestrXMLParser } from '../services/xml-parser.js';
import { DatabaseImporter } from '../services/database-importer.js';

dotenv.config();

async function importUO(zipFilePath: string) {
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
    console.log(`Extracting and parsing ${zipFilePath}...`);

    const directory = await unzipper.Open.file(zipFilePath);
    const uoFile = directory.files.find(f => f.path === 'UO_FULL_out.xml');

    if (!uoFile) {
      throw new Error('UO_FULL_out.xml not found in ZIP file');
    }

    console.log('Reading XML file...');
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
    console.log('Parsing XML...');

    const entities = parser.parseUO(xmlContent);
    console.log(`Parsed ${entities.length} legal entities`);

    console.log('Importing to database...');
    await importer.importUOEntities(entities, 1000);

    console.log('Import completed successfully!');
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

const zipPath = process.argv[2] || process.env.OPENREYESTR_DATA_PATH + '/20260126174103-69.zip';
importUO(zipPath).catch(console.error);
