/**
 * Download and Import NAIS Registries
 * Downloads notaries, court experts, and arbitration managers from data.gov.ua
 * and imports them into PostgreSQL
 */

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';
import unzipper from 'unzipper';

const REGISTRIES = {
  notaries: {
    url: 'https://data.gov.ua/dataset/85a68e3e-8cb0-41b8-a764-58d005063b52/resource/65e9ad78-0e65-4672-ba42-f7613e0fa493/download/17-ex_xml_wern.zip',
    xmlFileName: '17-ex_xml_wern.xml',
    tableName: 'notaries',
  },
  court_experts: {
    url: 'https://data.gov.ua/dataset/f615eb1d-cda0-411e-800b-efb61fb9fb46/resource/c89d0270-c87a-4781-a96b-41def560c6fc/download/18-ex_xml_expert.zip',
    xmlFileName: '18-ex_xml_expert.xml',
    tableName: 'court_experts',
  },
  arbitration_managers: {
    url: 'https://data.gov.ua/dataset/d7cca6b1-863c-4c7d-a90b-6d024a68a4f7/resource/60439f25-5162-4e7a-b59d-cf9224346159/download/25-ex_xml_arbker.zip',
    xmlFileName: '25-ex_xml_arbker.xml',
    tableName: 'arbitration_managers',
  },
};

const DATA_DIR = process.env.NAIS_DATA_DIR || path.join(__dirname, '../../data/nais');

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (url: string, redirects: number = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const lib = url.startsWith('https') ? https : require('http');
      lib.get(url, (response: any) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return follow(response.headers.location, redirects + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err: Error) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    follow(url);
  });
}

async function extractZip(zipPath: string, extractDir: string): Promise<string[]> {
  const directory = await unzipper.Open.file(zipPath);
  const extracted: string[] = [];

  for (const file of directory.files) {
    if (file.type === 'File') {
      const outPath = path.join(extractDir, file.path);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const content = await file.buffer();
      fs.writeFileSync(outPath, content);
      extracted.push(file.path);
    }
  }

  return extracted;
}

async function importNotaries(pool: Pool, xmlContent: string, sourceFile: string): Promise<number> {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const result = parser.parse(xmlContent);

  // Navigate to the subjects array (NAIS XML format)
  let subjects = result?.DATA?.SUBJECT || result?.SUBJECTS?.SUBJECT || result?.data?.subject || [];
  if (!Array.isArray(subjects)) subjects = [subjects];

  console.log(`  Parsed ${subjects.length} notary records`);

  let imported = 0;
  let errors = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
    const batch = subjects.slice(i, i + BATCH_SIZE);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const sp = `sp_${j}`;

        try {
          await client.query(`SAVEPOINT ${sp}`);

          const certNum = s.CERTIFICATE_NUMBER || s.CERT_NUM || s.N_SVID || s.NUM || String(i * BATCH_SIZE + j + 1);
          const fullName = s.FULL_NAME || s.NAME || s.FIO || s.PIB || '';
          const region = s.REGION || s.OBLAST || s.RG || '';
          const district = s.DISTRICT || s.RAION || '';
          const organization = s.ORGANIZATION || s.ORG || s.NOTARY_OFFICE || '';
          const address = s.ADDRESS || s.ADDR || '';
          const phone = s.PHONE || s.TEL || '';
          const email = s.EMAIL || '';
          const certDate = s.CERTIFICATE_DATE || s.CERT_DATE || s.D_SVID || null;
          const status = s.STATUS || s.STAN || '';

          await client.query(
            `INSERT INTO notaries (certificate_number, full_name, region, district, organization, address, phone, email, certificate_date, status, raw_data, source_file)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (certificate_number) DO UPDATE SET
               full_name = EXCLUDED.full_name, region = EXCLUDED.region, district = EXCLUDED.district,
               organization = EXCLUDED.organization, address = EXCLUDED.address, phone = EXCLUDED.phone,
               email = EXCLUDED.email, certificate_date = EXCLUDED.certificate_date, status = EXCLUDED.status,
               raw_data = EXCLUDED.raw_data, updated_at = CURRENT_TIMESTAMP`,
            [certNum, fullName, region, district, organization, address, phone, email, certDate, status, JSON.stringify(s), sourceFile]
          );

          await client.query(`RELEASE SAVEPOINT ${sp}`);
          imported++;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          errors++;
          if (errors <= 3) console.error(`  Error importing notary:`, err);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  Batch failed:', err);
    } finally {
      client.release();
    }

    process.stdout.write(`  Progress: ${Math.min(i + BATCH_SIZE, subjects.length)}/${subjects.length}\r`);
  }

  console.log(`\n  Imported: ${imported}, Errors: ${errors}`);
  return imported;
}

async function importCourtExperts(pool: Pool, xmlContent: string, sourceFile: string): Promise<number> {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const result = parser.parse(xmlContent);

  let subjects = result?.DATA?.SUBJECT || result?.SUBJECTS?.SUBJECT || result?.data?.subject || [];
  if (!Array.isArray(subjects)) subjects = [subjects];

  console.log(`  Parsed ${subjects.length} court expert records`);

  let imported = 0;
  let errors = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
    const batch = subjects.slice(i, i + BATCH_SIZE);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const sp = `sp_${j}`;

        try {
          await client.query(`SAVEPOINT ${sp}`);

          const expertId = s.EXPERT_ID || s.ID || s.NUM || s.N_EXP || String(i * BATCH_SIZE + j + 1);
          const fullName = s.FULL_NAME || s.NAME || s.FIO || s.PIB || '';
          const region = s.REGION || s.OBLAST || s.RG || '';
          const organization = s.ORGANIZATION || s.ORG || s.INSTITUTION || '';
          const commissionName = s.COMMISSION_NAME || s.COMMISSION || s.ATEST_COMMISSION || '';
          const certNumber = s.CERTIFICATE_NUMBER || s.CERT_NUM || s.N_SVID || '';
          const certDate = s.CERTIFICATE_DATE || s.CERT_DATE || s.D_SVID || null;
          const status = s.STATUS || s.STAN || '';

          // Expertise types can be in various formats
          let expertiseTypes: string[] = [];
          const rawTypes = s.EXPERTISE_TYPES || s.EXPERT_TYPE || s.VID_EXP || s.SPECIALITY || '';
          if (Array.isArray(rawTypes)) {
            expertiseTypes = rawTypes.map(String);
          } else if (rawTypes) {
            expertiseTypes = [String(rawTypes)];
          }

          await client.query(
            `INSERT INTO court_experts (expert_id, full_name, region, organization, commission_name, expertise_types, certificate_number, certificate_date, status, raw_data, source_file)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (expert_id) DO UPDATE SET
               full_name = EXCLUDED.full_name, region = EXCLUDED.region, organization = EXCLUDED.organization,
               commission_name = EXCLUDED.commission_name, expertise_types = EXCLUDED.expertise_types,
               certificate_number = EXCLUDED.certificate_number, certificate_date = EXCLUDED.certificate_date,
               status = EXCLUDED.status, raw_data = EXCLUDED.raw_data, updated_at = CURRENT_TIMESTAMP`,
            [expertId, fullName, region, organization, commissionName, expertiseTypes, certNumber, certDate, status, JSON.stringify(s), sourceFile]
          );

          await client.query(`RELEASE SAVEPOINT ${sp}`);
          imported++;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          errors++;
          if (errors <= 3) console.error(`  Error importing expert:`, err);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  Batch failed:', err);
    } finally {
      client.release();
    }

    process.stdout.write(`  Progress: ${Math.min(i + BATCH_SIZE, subjects.length)}/${subjects.length}\r`);
  }

  console.log(`\n  Imported: ${imported}, Errors: ${errors}`);
  return imported;
}

async function importArbitrationManagers(pool: Pool, xmlContent: string, sourceFile: string): Promise<number> {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const result = parser.parse(xmlContent);

  let subjects = result?.DATA?.SUBJECT || result?.SUBJECTS?.SUBJECT || result?.data?.subject || [];
  if (!Array.isArray(subjects)) subjects = [subjects];

  console.log(`  Parsed ${subjects.length} arbitration manager records`);

  let imported = 0;
  let errors = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
    const batch = subjects.slice(i, i + BATCH_SIZE);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const sp = `sp_${j}`;

        try {
          await client.query(`SAVEPOINT ${sp}`);

          const regNumber = s.REGISTRATION_NUMBER || s.REG_NUM || s.N_REG || s.NUM || String(i * BATCH_SIZE + j + 1);
          const regDate = s.REGISTRATION_DATE || s.REG_DATE || s.D_REG || null;
          const fullName = s.FULL_NAME || s.NAME || s.FIO || s.PIB || '';
          const certNumber = s.CERTIFICATE_NUMBER || s.CERT_NUM || s.N_SVID || '';
          const certStatus = s.CERTIFICATE_STATUS || s.STATUS || s.STAN || '';
          const certIssueDate = s.CERTIFICATE_ISSUE_DATE || s.CERT_DATE || s.D_SVID || null;
          const certChangeDate = s.CERTIFICATE_CHANGE_DATE || s.CERT_CHANGE_DATE || s.D_CHANGE || null;

          await client.query(
            `INSERT INTO arbitration_managers (registration_number, registration_date, full_name, certificate_number, certificate_status, certificate_issue_date, certificate_change_date, raw_data, source_file)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (registration_number) DO UPDATE SET
               registration_date = EXCLUDED.registration_date, full_name = EXCLUDED.full_name,
               certificate_number = EXCLUDED.certificate_number, certificate_status = EXCLUDED.certificate_status,
               certificate_issue_date = EXCLUDED.certificate_issue_date, certificate_change_date = EXCLUDED.certificate_change_date,
               raw_data = EXCLUDED.raw_data, updated_at = CURRENT_TIMESTAMP`,
            [regNumber, regDate, fullName, certNumber, certStatus, certIssueDate, certChangeDate, JSON.stringify(s), sourceFile]
          );

          await client.query(`RELEASE SAVEPOINT ${sp}`);
          imported++;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          errors++;
          if (errors <= 3) console.error(`  Error importing arb manager:`, err);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  Batch failed:', err);
    } finally {
      client.release();
    }

    process.stdout.write(`  Progress: ${Math.min(i + BATCH_SIZE, subjects.length)}/${subjects.length}\r`);
  }

  console.log(`\n  Imported: ${imported}, Errors: ${errors}`);
  return imported;
}

async function main() {
  const registryFilter = process.argv[2]; // optional: 'notaries', 'court_experts', 'arbitration_managers'

  console.log('\n' + '='.repeat(60));
  console.log('NAIS Registry Data Download & Import');
  console.log('='.repeat(60));

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
  });

  const importers: Record<string, (pool: Pool, xml: string, src: string) => Promise<number>> = {
    notaries: importNotaries,
    court_experts: importCourtExperts,
    arbitration_managers: importArbitrationManagers,
  };

  const results: { registry: string; count: number; time: number }[] = [];

  for (const [name, config] of Object.entries(REGISTRIES)) {
    if (registryFilter && name !== registryFilter) continue;

    console.log(`\n--- ${name} ---`);
    const startTime = Date.now();

    // 1. Download ZIP
    const zipPath = path.join(DATA_DIR, `${name}.zip`);
    console.log(`  Downloading from data.gov.ua...`);
    try {
      await downloadFile(config.url, zipPath);
      const stats = fs.statSync(zipPath);
      console.log(`  Downloaded: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    } catch (err: any) {
      console.error(`  Download failed: ${err.message}`);
      continue;
    }

    // 2. Extract ZIP
    const extractDir = path.join(DATA_DIR, name);
    fs.mkdirSync(extractDir, { recursive: true });
    console.log(`  Extracting...`);
    const extracted = await extractZip(zipPath, extractDir);
    console.log(`  Extracted files: ${extracted.join(', ')}`);

    // 3. Find XML file
    const xmlFile = extracted.find(f => f.toLowerCase().endsWith('.xml'));
    if (!xmlFile) {
      console.error(`  No XML file found in archive!`);
      console.log(`  Available files: ${extracted.join(', ')}`);
      continue;
    }

    const xmlPath = path.join(extractDir, xmlFile);
    const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
    console.log(`  XML size: ${(xmlContent.length / 1024 / 1024).toFixed(1)} MB`);

    // 4. Import to database
    console.log(`  Importing to PostgreSQL...`);
    const importer = importers[name];
    const count = await importer(pool, xmlContent, xmlFile);

    const elapsed = (Date.now() - startTime) / 1000;
    results.push({ registry: name, count, time: elapsed });
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('IMPORT COMPLETE');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  ${r.registry}: ${r.count} records (${r.time.toFixed(1)}s)`);
  }
  console.log('');

  await pool.end();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
