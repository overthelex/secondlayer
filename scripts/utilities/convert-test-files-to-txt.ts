#!/usr/bin/env ts-node
/**
 * Convert all test files (PDF, HTML, DOCX) to TXT using document-service
 * Saves results to test_data/ directory
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3002';
const TEST_DATA_DIR = path.join(__dirname, 'test_data');

interface TestFile {
  filename: string;
  mimeType: string;
  outputName: string;
}

const TEST_FILES: TestFile[] = [
  {
    filename: '1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html',
    mimeType: 'text/html',
    outputName: '1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.txt'
  },
  {
    filename: '2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF',
    mimeType: 'application/pdf',
    outputName: '2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.txt'
  },
  {
    filename: 'zo6NAJrqmQjM2qn3.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    outputName: 'zo6NAJrqmQjM2qn3.txt'
  }
];

async function convertFileToText(file: TestFile): Promise<void> {
  console.log(`\n=== Converting ${file.filename} ===`);

  try {
    // Read file
    const filePath = path.join(TEST_DATA_DIR, file.filename);
    const fileBuffer = await fs.readFile(filePath);
    const fileBase64 = fileBuffer.toString('base64');

    console.log(`✓ Loaded file (${fileBuffer.length} bytes)`);

    // Parse document via API
    const startTime = Date.now();
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/parse-document`,
      {
        fileBase64,
        mimeType: file.mimeType,
        filename: file.filename
      },
      {
        timeout: 120000 // 2 minutes for OCR
      }
    );

    const duration = Date.now() - startTime;
    const text = response.data.text;
    const metadata = response.data.metadata;

    console.log(`✓ Parsed in ${duration}ms`);
    console.log(`  Text length: ${text.length} chars`);
    console.log(`  Source: ${metadata.source}`);
    console.log(`  MIME type: ${metadata.mimeType}`);

    if (metadata.pageCount) {
      console.log(`  Pages: ${metadata.pageCount}`);
    }

    // Save to TXT file
    const outputPath = path.join(TEST_DATA_DIR, file.outputName);
    await fs.writeFile(outputPath, text, 'utf-8');

    console.log(`✓ Saved to ${file.outputName}`);
    console.log(`  Preview (first 100 chars): ${text.substring(0, 100).replace(/\n/g, ' ')}...`);

  } catch (error: any) {
    console.error(`✗ Failed to convert ${file.filename}:`, error.response?.data || error.message);
    throw error;
  }
}

async function convertAllFiles() {
  console.log('='.repeat(70));
  console.log('Converting Test Files to TXT via Document Service');
  console.log('='.repeat(70));
  console.log(`Service URL: ${DOCUMENT_SERVICE_URL}`);
  console.log(`Test data dir: ${TEST_DATA_DIR}`);
  console.log(`Files to convert: ${TEST_FILES.length}`);
  console.log('='.repeat(70));

  // Check service health
  try {
    const health = await axios.get(`${DOCUMENT_SERVICE_URL}/health`, { timeout: 5000 });
    console.log('\n✓ Document service is healthy');
  } catch (error: any) {
    console.error('\n✗ Document service is not available!');
    console.error('Start it with: cd deployment && docker compose -f docker-compose.local.yml up -d document-service-local');
    process.exit(1);
  }

  // Convert each file
  let successCount = 0;
  let failCount = 0;

  for (const file of TEST_FILES) {
    try {
      await convertFileToText(file);
      successCount++;
    } catch (error) {
      failCount++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('Conversion Summary');
  console.log('='.repeat(70));
  console.log(`✓ Successful: ${successCount}`);
  console.log(`✗ Failed: ${failCount}`);
  console.log(`Total: ${TEST_FILES.length}`);

  // List output files
  console.log('\nOutput files in test_data/:');
  for (const file of TEST_FILES) {
    const outputPath = path.join(TEST_DATA_DIR, file.outputName);
    try {
      const stats = await fs.stat(outputPath);
      console.log(`  ${file.outputName} (${stats.size} bytes)`);
    } catch (error) {
      console.log(`  ${file.outputName} (not created)`);
    }
  }

  console.log('='.repeat(70));

  if (failCount > 0) {
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  convertAllFiles().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { convertFileToText, convertAllFiles };
