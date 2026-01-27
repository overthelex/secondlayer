#!/usr/bin/env node
/**
 * Script to collect data from all NAIS registry pages using extracted data
 * Since automated scraping is blocked, this uses pre-collected data
 */

const fs = require('fs').promises;
const path = require('path');

// Complete registry data with download links
const COMPLETE_DATA = [
  {
    "id": 1,
    "url": "/m/ediniy-derjavniy-reestr-yuridichnih-osib-fizichnih-osib-pidpriemtsiv-ta-gromadskih-formuvan",
    "title": "Єдиний державний реєстр юридичних осіб, фізичних осіб-підприємців та громадських формувань",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/26/20260126174103-69.zip",
        "text": "16‑UFOPFSU_26.01.2026",
        "type": "dataset",
        "description": "гіперпосилання на розширений набір даних (електронний документ для завантаження або інтерфейс прикладного програмування)"
      },
      {
        "url": "https://nais.gov.ua/files/general/2026/01/19/20260119053247-12.zip",
        "text": "16-ufopfsu_xsd",
        "type": "schema",
        "description": "гіперпосилання на структуру набору даних (електронний документ для завантаження або інтерфейс прикладного програмування)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  },
  {
    "id": 2,
    "url": "/m/ediniy-reestr-notariusiv-188",
    "title": "Єдиний реєстр нотаріусів",
    "downloadLinks": [
      {
        "url": "https://nais.gov.ua/files/general/2026/01/20/20260120140657-96.zip",
        "text": "17-ex_xml_wern.zip",
        "type": "dataset",
        "description": "гіперпосилання на набір даних (електронний документ для завантаження або інтерфейс прикладного програмування)"
      },
      {
        "url": "https://nais.gov.ua/files/general/imported/download/open_data/18-ex_xml_wern_xsd.zip",
        "text": "17-ex_xml_wern_xsd.zip",
        "type": "schema",
        "description": "гіперпосилання на структуру набору даних (електронний документ для завантаження або інтерфейс прикладного програмування)"
      }
    ],
    "scrapedAt": "2026-01-27T00:00:00.000Z",
    "status": "success"
  }
  // Will be filled with data from remaining pages
];

// Import the HTML generator from the main script
const { generateHTML } = require('./scrape-nais.js');

async function main() {
  console.log('Generating HTML report from collected data...');

  // For now, use the partial data we have
  const html = generateHTML(COMPLETE_DATA);

  const htmlPath = path.join(__dirname, 'nais-opendata.html');
  await fs.writeFile(htmlPath, html, 'utf-8');

  console.log(`✅ HTML report saved to: ${htmlPath}`);
  console.log(`📊 Total registries: ${COMPLETE_DATA.length}`);
  console.log(`📥 Total download links: ${COMPLETE_DATA.reduce((sum, r) => sum + r.downloadLinks.length, 0)}`);
}

main().catch(console.error);
