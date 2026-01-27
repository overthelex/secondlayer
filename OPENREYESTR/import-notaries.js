const fs = require('fs');
const xml2js = require('xml2js');
const { Client } = require('pg');

// Database connection
const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'opendata_db',
  user: 'opendatauser',
  password: 'opendata_secure_pass_2026'
});

// Parse contacts string to extract phone and email
function parseContacts(contactsStr) {
  if (!contactsStr) return { address: null, phone: null, email: null };

  // Email pattern
  const emailMatch = contactsStr.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
  const email = emailMatch ? emailMatch[1] : null;

  // Phone pattern - various formats
  const phoneMatch = contactsStr.match(/(\([0-9]{2,5}\)\s*[0-9\-\s]+|\+\d{2}\s*\d{3}\s*\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\d{3}-\d{2}-\d{2})/);
  const phone = phoneMatch ? phoneMatch[1].trim() : null;

  // Address is the full contacts string (we'll keep it as is for now)
  const address = contactsStr;

  return { address, phone, email };
}

async function importNotaries() {
  try {
    // Connect to database
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Read and parse XML file
    const xmlData = fs.readFileSync('17-ex_xml_wern_utf8.xml', 'utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);

    const records = result.DATA.RECORD;
    console.log(`Found ${records.length} notary records`);

    let imported = 0;
    let failed = 0;
    let skipped = 0;

    // Prepare insert statement
    const insertQuery = `
      INSERT INTO notaries (
        certificate_number,
        full_name,
        region,
        organization,
        address,
        phone,
        email,
        raw_data,
        source_file
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (certificate_number) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        region = EXCLUDED.region,
        organization = EXCLUDED.organization,
        address = EXCLUDED.address,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        raw_data = EXCLUDED.raw_data,
        updated_at = CURRENT_TIMESTAMP
    `;

    // Process each record
    for (const record of records) {
      try {
        const region = record.REGION ? record.REGION[0] : null;
        const nameObj = record.NAME_OBJ ? record.NAME_OBJ[0] : null;
        const contactsStr = record.CONTACTS ? record.CONTACTS[0] : null;
        const fio = record.FIO ? record.FIO[0] : null;
        const license = record.LICENSE ? record.LICENSE[0] : null;

        if (!license || !fio) {
          console.warn(`Skipping record: missing license or FIO`);
          skipped++;
          continue;
        }

        // Parse contacts
        const { address, phone, email } = parseContacts(contactsStr);

        // Store raw data as JSON
        const rawData = {
          region,
          name_obj: nameObj,
          contacts: contactsStr,
          fio,
          license
        };

        // Insert into database
        await client.query(insertQuery, [
          license,           // certificate_number
          fio,               // full_name
          region,            // region
          nameObj,           // organization
          address,           // address
          phone,             // phone
          email,             // email
          JSON.stringify(rawData),  // raw_data
          '17-ex_xml_wern.xml'      // source_file
        ]);

        imported++;

        if (imported % 100 === 0) {
          console.log(`Imported ${imported} records...`);
        }
      } catch (err) {
        console.error(`Error importing record: ${err.message}`);
        failed++;
      }
    }

    console.log('\n=== Import Complete ===');
    console.log(`Total records: ${records.length}`);
    console.log(`Successfully imported: ${imported}`);
    console.log(`Failed: ${failed}`);
    console.log(`Skipped: ${skipped}`);

    // Show sample data
    console.log('\n=== Sample Data ===');
    const sampleQuery = await client.query('SELECT certificate_number, full_name, region, organization FROM notaries LIMIT 5');
    console.table(sampleQuery.rows);

    // Show statistics
    console.log('\n=== Statistics ===');
    const statsQuery = await client.query(`
      SELECT
        region,
        COUNT(*) as count
      FROM notaries
      GROUP BY region
      ORDER BY count DESC
      LIMIT 10
    `);
    console.table(statsQuery.rows);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed');
  }
}

// Run import
importNotaries();
