const fs = require('fs');
const xml2js = require('xml2js');
const { Client } = require('pg');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Database connection
const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'opendata_db',
  user: 'opendatauser',
  password: 'secondlayer_password'
});

// Parse XML element to extract legal entity data
function parseEntity(record) {
  const entity = {};

  // EDRPOU code (ЄДРПОУ)
  entity.edrpou = record.EDRPOU?.[0] || record.CODE?.[0] || null;

  // Names
  entity.full_name = record.NAME?.[0] || record.FULL_NAME?.[0] || null;
  entity.short_name = record.SHORT_NAME?.[0] || null;

  // Legal form
  entity.legal_form = record.OPF?.[0] || record.LEGAL_FORM?.[0] || null;

  // Status
  entity.status = record.STAN?.[0] || record.STATUS?.[0] || 'unknown';

  // Dates
  entity.registration_date = parseDate(record.REGISTRATION_DATE?.[0] || record.ZDAT?.[0]);
  entity.termination_date = parseDate(record.TERMINATION_DATE?.[0] || record.DDAT?.[0]);

  // Address
  entity.address = record.ADDRESS?.[0] || record.ADRESS?.[0] || null;

  // Region - extract from address or separate field
  entity.region = record.REGION?.[0] || extractRegion(entity.address);

  // Activity type (KVED)
  entity.activity_type = record.KVED?.[0] || record.ACTIVITY?.[0] || null;

  // Authorized capital
  entity.authorized_capital = parseFloat(record.CAPITAL?.[0] || record.AUTHORIZED_CAPITAL?.[0] || 0);

  // Founders (if present)
  entity.founders = record.FOUNDERS ? parseFounders(record.FOUNDERS) : null;

  // Management (if present)
  entity.management = record.MANAGEMENT ? parseManagement(record.MANAGEMENT) : null;

  return entity;
}

// Parse date in various formats
function parseDate(dateStr) {
  if (!dateStr) return null;

  // Try DD.MM.YYYY format
  const ddmmyyyy = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }

  // Try YYYY-MM-DD format
  const yyyymmdd = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (yyyymmdd) {
    return dateStr;
  }

  return null;
}

// Extract region from address
function extractRegion(address) {
  if (!address) return null;

  const regionPatterns = [
    /([А-ЯІЇЄа-яіїє]+ська)\s+обл/i,
    /м\.\s*(Київ|Харків|Одеса|Дніпро|Львів)/i
  ];

  for (const pattern of regionPatterns) {
    const match = address.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// Parse founders array
function parseFounders(foundersData) {
  if (!foundersData || !Array.isArray(foundersData)) return null;

  const founders = [];
  for (const founder of foundersData) {
    if (founder.FOUNDER) {
      founders.push({
        name: founder.FOUNDER[0]?.NAME?.[0] || null,
        edrpou: founder.FOUNDER[0]?.EDRPOU?.[0] || null,
        share: founder.FOUNDER[0]?.SHARE?.[0] || null
      });
    }
  }

  return founders.length > 0 ? founders : null;
}

// Parse management array
function parseManagement(managementData) {
  if (!managementData || !Array.isArray(managementData)) return null;

  const management = [];
  for (const person of managementData) {
    if (person.PERSON) {
      management.push({
        name: person.PERSON[0]?.NAME?.[0] || null,
        position: person.PERSON[0]?.POSITION?.[0] || null
      });
    }
  }

  return management.length > 0 ? management : null;
}

async function importLegalEntities(xmlFilePath) {
  try {
    console.log('Starting legal entities import...');
    console.log(`Reading file: ${xmlFilePath}`);

    // Check if file exists
    if (!fs.existsSync(xmlFilePath)) {
      throw new Error(`File not found: ${xmlFilePath}`);
    }

    // Get file size
    const stats = fs.statSync(xmlFilePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`File size: ${fileSizeMB} MB`);

    // Connect to database
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Read and parse XML file
    console.log('Parsing XML (this may take a while for large files)...');
    const xmlData = fs.readFileSync(xmlFilePath, 'utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);

    // Get records array (structure may vary)
    const records = result.DATA?.RECORD || result.ROOT?.RECORD || result.RECORD || [];
    console.log(`Found ${records.length} legal entity records`);

    if (records.length === 0) {
      console.log('No records found. XML structure:');
      console.log(JSON.stringify(Object.keys(result), null, 2));
      return;
    }

    let imported = 0;
    let failed = 0;
    let skipped = 0;

    // Prepare insert statement with UPSERT
    const insertQuery = `
      INSERT INTO legal_entities (
        edrpou,
        full_name,
        short_name,
        legal_form,
        status,
        registration_date,
        termination_date,
        address,
        region,
        activity_type,
        authorized_capital,
        founders,
        management,
        raw_data,
        source_file
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (edrpou) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        short_name = EXCLUDED.short_name,
        legal_form = EXCLUDED.legal_form,
        status = EXCLUDED.status,
        registration_date = EXCLUDED.registration_date,
        termination_date = EXCLUDED.termination_date,
        address = EXCLUDED.address,
        region = EXCLUDED.region,
        activity_type = EXCLUDED.activity_type,
        authorized_capital = EXCLUDED.authorized_capital,
        founders = EXCLUDED.founders,
        management = EXCLUDED.management,
        raw_data = EXCLUDED.raw_data,
        updated_at = CURRENT_TIMESTAMP
    `;

    // Process records in batches
    const batchSize = 100;
    let batch = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      try {
        const entity = parseEntity(record);

        // Validate required fields
        if (!entity.edrpou || !entity.full_name) {
          skipped++;
          continue;
        }

        // Store raw data as JSON
        const rawData = JSON.stringify(record);

        batch.push([
          entity.edrpou,
          entity.full_name,
          entity.short_name,
          entity.legal_form,
          entity.status,
          entity.registration_date,
          entity.termination_date,
          entity.address,
          entity.region,
          entity.activity_type,
          entity.authorized_capital,
          entity.founders ? JSON.stringify(entity.founders) : null,
          entity.management ? JSON.stringify(entity.management) : null,
          rawData,
          xmlFilePath.split('/').pop()
        ]);

        // Execute batch when full
        if (batch.length >= batchSize) {
          await Promise.all(batch.map(params => client.query(insertQuery, params)));
          imported += batch.length;
          batch = [];

          if (imported % 1000 === 0) {
            console.log(`Imported ${imported} records...`);
          }
        }
      } catch (err) {
        console.error(`Error processing record ${i}: ${err.message}`);
        failed++;
      }
    }

    // Execute remaining batch
    if (batch.length > 0) {
      await Promise.all(batch.map(params => client.query(insertQuery, params)));
      imported += batch.length;
    }

    console.log('\n=== Import Complete ===');
    console.log(`Total records: ${records.length}`);
    console.log(`Successfully imported: ${imported}`);
    console.log(`Failed: ${failed}`);
    console.log(`Skipped: ${skipped}`);

    // Show statistics
    console.log('\n=== Statistics ===');

    const statsQuery = await client.query(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT region) as regions,
        COUNT(DISTINCT legal_form) as legal_forms,
        COUNT(CASE WHEN status = 'діюче' OR status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'припинено' OR status = 'terminated' THEN 1 END) as terminated
      FROM legal_entities
    `);

    console.table(statsQuery.rows[0]);

    // Top regions
    console.log('\n=== Top 10 Regions ===');
    const regionsQuery = await client.query(`
      SELECT region, COUNT(*) as count
      FROM legal_entities
      WHERE region IS NOT NULL
      GROUP BY region
      ORDER BY count DESC
      LIMIT 10
    `);
    console.table(regionsQuery.rows);

    // Top legal forms
    console.log('\n=== Top 10 Legal Forms ===');
    const formsQuery = await client.query(`
      SELECT legal_form, COUNT(*) as count
      FROM legal_entities
      WHERE legal_form IS NOT NULL
      GROUP BY legal_form
      ORDER BY count DESC
      LIMIT 10
    `);
    console.table(formsQuery.rows);

    // Sample data
    console.log('\n=== Sample Data ===');
    const sampleQuery = await client.query(`
      SELECT edrpou, full_name, legal_form, status, region
      FROM legal_entities
      ORDER BY created_at DESC
      LIMIT 5
    `);
    console.table(sampleQuery.rows);

  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    await client.end();
    console.log('\nDatabase connection closed');
  }
}

// Run import
const xmlFile = process.argv[2] || '15-ex_xml_edrpou.xml';

if (!xmlFile) {
  console.error('Usage: node import-legal-entities.js <xml-file>');
  process.exit(1);
}

importLegalEntities(xmlFile);
