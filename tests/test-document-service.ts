#!/usr/bin/env ts-node
/**
 * Test Document Service with local test files
 *
 * Usage:
 *   npx ts-node --project tsconfig.test.json test-document-service.ts
 *
 * Or with Docker:
 *   cd deployment
 *   docker-compose -f docker-compose.local.yml up document-service-local
 *   npx ts-node --project tsconfig.test.json ../test-document-service.ts
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3002';
const TEST_DATA_DIR = path.join(__dirname, 'test_data');

// Test files
const TEST_FILES = {
  html: '1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html',
  pdf: '2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF',
  docx: 'zo6NAJrqmQjM2qn3.docx'
};

const MIME_TYPES = {
  html: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

async function healthCheck(): Promise<boolean> {
  try {
    const response = await axios.get(`${DOCUMENT_SERVICE_URL}/health`, { timeout: 5000 });
    console.log('✓ Health check passed:', response.data);
    return true;
  } catch (error: any) {
    console.error('✗ Health check failed:', error.message);
    return false;
  }
}

async function parseDocument(fileType: keyof typeof TEST_FILES, skipOnOCRError = false) {
  console.log(`\n=== Testing ${fileType.toUpperCase()} Parsing ===`);

  try {
    // Read file
    const filePath = path.join(TEST_DATA_DIR, TEST_FILES[fileType]);
    const fileBuffer = await fs.readFile(filePath);
    const fileBase64 = fileBuffer.toString('base64');

    console.log(`✓ Loaded file: ${TEST_FILES[fileType]}`);
    console.log(`  Size: ${fileBuffer.length} bytes`);

    // Parse document
    const startTime = Date.now();
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/parse-document`,
      {
        fileBase64,
        mimeType: MIME_TYPES[fileType],
        filename: TEST_FILES[fileType]
      },
      {
        timeout: 120000 // 2 minutes
      }
    );

    const duration = Date.now() - startTime;
    console.log(`✓ Document parsed successfully in ${duration}ms`);
    console.log(`  Text length: ${response.data.text.length} chars`);
    console.log(`  Source: ${response.data.metadata.source}`);
    console.log(`  MIME type: ${response.data.metadata.mimeType}`);

    if (response.data.metadata.pageCount) {
      console.log(`  Pages: ${response.data.metadata.pageCount}`);
    }

    // Show first 200 chars of parsed text
    console.log(`\n  Preview (first 200 chars):`);
    console.log(`  ${response.data.text.substring(0, 200)}...`);

    return response.data;
  } catch (error: any) {
    // Check if it's an OCR error
    const errorMsg = error.response?.data?.error || error.message;
    if (skipOnOCRError && errorMsg.includes('OCR failed')) {
      console.log(`⚠ Skipped ${fileType} parsing (OCR not configured)`);
      console.log(`  To enable OCR, set VISION_CREDENTIALS_PATH in deployment/.env.local`);
      return null;
    }

    console.error(`✗ Failed to parse ${fileType}:`, error.response?.data || error.message);
    throw error;
  }
}

async function extractClauses(documentText: string) {
  console.log(`\n=== Testing Clause Extraction ===`);

  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/extract-clauses`,
      {
        documentText: documentText.substring(0, 10000), // Limit for faster testing
        documentId: 'test-doc-1'
      },
      {
        timeout: 90000 // 90 seconds
      }
    );

    const duration = Date.now() - startTime;
    console.log(`✓ Clauses extracted in ${duration}ms`);
    console.log(`  Total clauses: ${response.data.clauses.length}`);
    console.log(`  High risk: ${response.data.riskReport.highRiskClauses.length}`);

    if (response.data.clauses.length > 0) {
      console.log(`\n  Sample clauses:`);
      response.data.clauses.slice(0, 3).forEach((clause: any, i: number) => {
        console.log(`  ${i + 1}. ${clause.type}: ${clause.text.substring(0, 100)}...`);
      });
    }

    return response.data;
  } catch (error: any) {
    console.error('✗ Failed to extract clauses:', error.response?.data || error.message);
    throw error;
  }
}

async function summarizeDocument(documentText: string, detailLevel: 'quick' | 'standard' | 'deep' = 'quick') {
  console.log(`\n=== Testing Document Summarization (${detailLevel}) ===`);

  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/summarize-document`,
      {
        documentText: documentText.substring(0, 5000), // Limit for faster testing
        detailLevel
      },
      {
        timeout: 90000 // 90 seconds
      }
    );

    const duration = Date.now() - startTime;
    console.log(`✓ Summary created in ${duration}ms`);
    console.log(`  Executive summary: ${response.data.executiveSummary.length} chars`);

    if (response.data.detailedSummary) {
      console.log(`  Detailed summary: ${response.data.detailedSummary.length} chars`);
    }

    console.log(`\n  Executive Summary:`);
    console.log(`  ${response.data.executiveSummary}`);

    if (response.data.keyFacts) {
      console.log(`\n  Key Facts:`);
      console.log(`  - Parties: ${response.data.keyFacts.parties?.length || 0}`);
      console.log(`  - Dates: ${response.data.keyFacts.dates?.length || 0}`);
      console.log(`  - Amounts: ${response.data.keyFacts.amounts?.length || 0}`);
    }

    return response.data;
  } catch (error: any) {
    console.error('✗ Failed to summarize:', error.response?.data || error.message);
    throw error;
  }
}

async function compareDocuments(text1: string, text2: string) {
  console.log(`\n=== Testing Document Comparison ===`);

  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${DOCUMENT_SERVICE_URL}/api/compare-documents`,
      {
        oldDocumentText: text1.substring(0, 3000),
        newDocumentText: text2.substring(0, 3000)
      },
      {
        timeout: 120000
      }
    );

    const duration = Date.now() - startTime;
    console.log(`✓ Comparison completed in ${duration}ms`);
    console.log(`  Changes found: ${response.data.changes.length}`);
    console.log(`  Critical: ${response.data.changes.filter((c: any) => c.importance === 'critical').length}`);
    console.log(`  Significant: ${response.data.changes.filter((c: any) => c.importance === 'significant').length}`);
    console.log(`  Minor: ${response.data.changes.filter((c: any) => c.importance === 'minor').length}`);

    console.log(`\n  Summary:`);
    console.log(`  ${response.data.summary.substring(0, 300)}...`);

    return response.data;
  } catch (error: any) {
    console.error('✗ Failed to compare:', error.response?.data || error.message);
    throw error;
  }
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Document Service Integration Test');
  console.log('='.repeat(60));
  console.log(`Service URL: ${DOCUMENT_SERVICE_URL}`);
  console.log(`Test data dir: ${TEST_DATA_DIR}`);
  console.log('='.repeat(60));

  try {
    // 1. Health check
    console.log('\n1. Health Check');
    const healthy = await healthCheck();
    if (!healthy) {
      console.error('\nService is not healthy. Make sure document-service is running:');
      console.error('  cd deployment');
      console.error('  docker-compose -f docker-compose.local.yml up document-service-local');
      process.exit(1);
    }

    // 2. Test parsing all formats
    console.log('\n2. Document Parsing Tests');
    const htmlResult = await parseDocument('html');
    const pdfResult = await parseDocument('pdf', true); // Skip on OCR error
    const docxResult = await parseDocument('docx');

    // Determine which document to use for testing
    const testDocument = docxResult || htmlResult;
    const secondDocument = htmlResult;

    // 3. Test clause extraction
    console.log('\n3. Clause Extraction Test');
    await extractClauses(testDocument.text);

    // 4. Test summarization
    console.log('\n4. Summarization Test');
    await summarizeDocument(testDocument.text, 'quick');

    // 5. Test comparison
    console.log('\n5. Document Comparison Test');
    if (pdfResult && docxResult) {
      await compareDocuments(pdfResult.text, docxResult.text);
    } else {
      await compareDocuments(secondDocument.text, testDocument.text);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✓ ALL TESTS PASSED!');
    console.log('='.repeat(60));

  } catch (error: any) {
    console.error('\n' + '='.repeat(60));
    console.error('✗ TESTS FAILED');
    console.error('='.repeat(60));
    console.error(error);
    process.exit(1);
  }
}

// Run tests if called directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

export { healthCheck, parseDocument, extractClauses, summarizeDocument, compareDocuments };
