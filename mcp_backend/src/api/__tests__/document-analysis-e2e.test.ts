/**
 * Document Analysis E2E Tests with Real Data
 *
 * Tests the complete document analysis workflow with real files from test_data/:
 * - HTML court case
 * - PDF court case
 * - DOCX court case
 *
 * Workflow:
 * 1. Parse documents (PDF/DOCX/HTML)
 * 2. Extract key clauses
 * 3. Summarize documents
 * 4. Compare document versions
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { DocumentParser } from '../../services/document-parser.js';
import { DocumentAnalysisTools } from '../document-analysis-tools.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import { CitationValidator } from '../../services/citation-validator.js';
import { DocumentService } from '../../services/document-service.js';
import { EmbeddingService } from '../../services/embedding-service.js';
import { Database } from '../../database/database.js';
import fs from 'fs/promises';
import path from 'path';

// Test data paths
const TEST_DATA_DIR = path.join(process.cwd(), '../test_data');
const HTML_FILE = '1-2605-1BC54EE0-ED22-11ED-90D9-2280ECA8990C.html';
const PDF_FILE = '2-2-8b1c30c0-0f68-11ee-971c-9f5be971921e.PDF';
const DOCX_FILE = 'zo6NAJrqmQjM2qn3.docx';

// Skip tests if credentials are not available
const SKIP_TESTS = !process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.OPENAI_API_KEY;
const skipMessage = SKIP_TESTS
  ? 'Skipping E2E tests: GOOGLE_APPLICATION_CREDENTIALS or OPENAI_API_KEY not set'
  : '';

describe('Document Analysis E2E Tests', () => {
  let documentParser: DocumentParser;
  let analysisTools: DocumentAnalysisTools;
  let testFiles: Map<string, Buffer>;

  beforeAll(async () => {
    if (SKIP_TESTS) {
      console.warn(skipMessage);
      return;
    }

    console.log('=== E2E Test Setup ===');
    console.log(`Test data directory: ${TEST_DATA_DIR}`);

    // Initialize services
    const visionKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    documentParser = new DocumentParser(visionKeyPath);
    await documentParser.initialize();

    // Mock dependencies for analysis tools
    const db = { query: jest.fn(), getPool: jest.fn() } as any;
    const embeddingService = {
      generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      storeChunk: jest.fn(),
    } as any;

    const documentService = {
      getDocumentById: jest.fn(),
      saveSections: jest.fn(),
      saveDocument: jest.fn(),
    } as any;

    const sectionizer = new SemanticSectionizer();
    const patternStore = new LegalPatternStore(db, embeddingService);
    const citationValidator = new CitationValidator(db);

    analysisTools = new DocumentAnalysisTools(
      documentParser,
      sectionizer,
      patternStore,
      citationValidator,
      embeddingService,
      documentService
    );

    // Load test files
    testFiles = new Map();

    try {
      const htmlBuffer = await fs.readFile(path.join(TEST_DATA_DIR, HTML_FILE));
      const pdfBuffer = await fs.readFile(path.join(TEST_DATA_DIR, PDF_FILE));
      const docxBuffer = await fs.readFile(path.join(TEST_DATA_DIR, DOCX_FILE));

      testFiles.set('html', htmlBuffer);
      testFiles.set('pdf', pdfBuffer);
      testFiles.set('docx', docxBuffer);

      console.log('✓ Test files loaded successfully');
      console.log(`  - HTML: ${htmlBuffer.length} bytes`);
      console.log(`  - PDF: ${pdfBuffer.length} bytes`);
      console.log(`  - DOCX: ${docxBuffer.length} bytes`);
    } catch (error: any) {
      console.error('Failed to load test files:', error.message);
      throw error;
    }
  }, 30000);

  afterAll(async () => {
    if (documentParser) {
      await documentParser.cleanup();
      console.log('✓ Cleanup completed');
    }
  });

  describe('1. Document Parsing', () => {
    it('should parse HTML court case', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing HTML Parsing ===');
      const htmlBuffer = testFiles.get('html')!;

      const result = await documentParser.parseHTML(htmlBuffer);

      console.log(`✓ Parsed HTML document`);
      console.log(`  - Text length: ${result.text.length} chars`);
      console.log(`  - Source: ${result.metadata.source}`);
      console.log(`  - MIME type: ${result.metadata.mimeType}`);

      expect(result).toBeDefined();
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(100);
      expect(result.metadata.mimeType).toBe('text/html');
      expect(result.metadata.source).toBe('ocr');
    }, 60000);

    it('should parse PDF court case', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing PDF Parsing ===');
      const pdfBuffer = testFiles.get('pdf')!;

      const result = await documentParser.parsePDF(pdfBuffer);

      console.log(`✓ Parsed PDF document`);
      console.log(`  - Text length: ${result.text.length} chars`);
      console.log(`  - Pages: ${result.metadata.pageCount}`);
      console.log(`  - Source: ${result.metadata.source}`);
      console.log(`  - Title: ${result.metadata.title || 'N/A'}`);

      expect(result).toBeDefined();
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(100);
      expect(result.metadata.mimeType).toBe('application/pdf');
      expect(result.metadata.pageCount).toBeGreaterThan(0);
    }, 120000);

    it('should parse DOCX court case', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing DOCX Parsing ===');
      const docxBuffer = testFiles.get('docx')!;

      const result = await documentParser.parseDOCX(docxBuffer);

      console.log(`✓ Parsed DOCX document`);
      console.log(`  - Text length: ${result.text.length} chars`);
      console.log(`  - Source: ${result.metadata.source}`);

      expect(result).toBeDefined();
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(100);
      expect(result.metadata.mimeType).toContain('wordprocessing');
    }, 60000);
  });

  describe('2. Key Clause Extraction', () => {
    it('should extract clauses from parsed document', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Clause Extraction ===');
      const docxBuffer = testFiles.get('docx')!;

      // First parse the document
      const parsed = await documentParser.parseDOCX(docxBuffer);
      console.log(`✓ Document parsed (${parsed.text.length} chars)`);

      // Extract clauses
      const result = await analysisTools.extractKeyClauses({
        documentText: parsed.text,
        documentId: 'test-docx-1',
      });

      console.log(`✓ Extracted clauses`);
      console.log(`  - Total clauses: ${result.clauses.length}`);
      console.log(`  - High risk clauses: ${result.riskReport.highRiskClauses.length}`);

      if (result.clauses.length > 0) {
        console.log(`  - Sample clause types: ${result.clauses.slice(0, 3).map(c => c.type).join(', ')}`);
      }

      expect(result).toBeDefined();
      expect(result.clauses).toBeInstanceOf(Array);
      expect(result.riskReport).toBeDefined();
    }, 90000);
  });

  describe('3. Document Summarization', () => {
    it('should create quick summary', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Quick Summarization ===');
      const pdfBuffer = testFiles.get('pdf')!;

      // Parse first
      const parsed = await documentParser.parsePDF(pdfBuffer);
      console.log(`✓ Document parsed (${parsed.text.length} chars)`);

      // Summarize
      const summary = await analysisTools.summarizeDocument({
        documentText: parsed.text,
        detailLevel: 'quick',
      });

      console.log(`✓ Summary created`);
      console.log(`  - Executive summary length: ${summary.executiveSummary.length} chars`);
      console.log(`  - Parties found: ${summary.keyFacts.parties?.length || 0}`);
      console.log(`  - Dates found: ${summary.keyFacts.dates?.length || 0}`);
      console.log(`  - Amounts found: ${summary.keyFacts.amounts?.length || 0}`);

      expect(summary).toBeDefined();
      expect(summary.executiveSummary).toBeTruthy();
      expect(summary.executiveSummary.length).toBeGreaterThan(50);
      expect(summary.keyFacts).toBeDefined();
    }, 90000);

    it('should create detailed summary', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Detailed Summarization ===');
      const htmlBuffer = testFiles.get('html')!;

      // Parse first
      const parsed = await documentParser.parseHTML(htmlBuffer);
      console.log(`✓ Document parsed (${parsed.text.length} chars)`);

      // Summarize with deep analysis
      const summary = await analysisTools.summarizeDocument({
        documentText: parsed.text,
        detailLevel: 'deep',
      });

      console.log(`✓ Detailed summary created`);
      console.log(`  - Executive summary: ${summary.executiveSummary.length} chars`);
      console.log(`  - Detailed summary: ${summary.detailedSummary.length} chars`);

      expect(summary).toBeDefined();
      expect(summary.executiveSummary).toBeTruthy();
      expect(summary.detailedSummary).toBeTruthy();
      expect(summary.detailedSummary.length).toBeGreaterThan(summary.executiveSummary.length);
    }, 120000);
  });

  describe('4. Document Comparison', () => {
    it('should compare two document versions', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Document Comparison ===');

      // Use PDF and DOCX as "different versions" for testing
      const pdfBuffer = testFiles.get('pdf')!;
      const docxBuffer = testFiles.get('docx')!;

      // Parse both
      const doc1 = await documentParser.parsePDF(pdfBuffer);
      const doc2 = await documentParser.parseDOCX(docxBuffer);

      console.log(`✓ Documents parsed`);
      console.log(`  - Doc 1: ${doc1.text.length} chars`);
      console.log(`  - Doc 2: ${doc2.text.length} chars`);

      // Compare
      const comparison = await analysisTools.compareDocuments({
        oldDocumentText: doc1.text.slice(0, 5000), // Limit for testing
        newDocumentText: doc2.text.slice(0, 5000),
      });

      console.log(`✓ Comparison completed`);
      console.log(`  - Total changes: ${comparison.changes.length}`);
      console.log(`  - Critical: ${comparison.changes.filter(c => c.importance === 'critical').length}`);
      console.log(`  - Significant: ${comparison.changes.filter(c => c.importance === 'significant').length}`);
      console.log(`  - Minor: ${comparison.changes.filter(c => c.importance === 'minor').length}`);
      console.log(`  - Summary: ${comparison.summary.slice(0, 100)}...`);

      expect(comparison).toBeDefined();
      expect(comparison.changes).toBeInstanceOf(Array);
      expect(comparison.changes.length).toBeGreaterThan(0);
      expect(comparison.summary).toBeTruthy();
    }, 120000);
  });

  describe('5. Complete Workflow Integration', () => {
    it('should execute full analysis workflow on real document', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Complete Workflow ===');
      const docxBuffer = testFiles.get('docx')!;
      const fileBase64 = docxBuffer.toString('base64');

      // Step 1: Parse document via MCP tool
      console.log('Step 1: Parsing document...');
      const parsed = await analysisTools.parseDocument({
        fileBase64,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: DOCX_FILE,
      });

      console.log(`✓ Document parsed`);
      console.log(`  - Text: ${parsed.text.length} chars`);
      console.log(`  - Source: ${parsed.metadata.source}`);

      expect(parsed.text.length).toBeGreaterThan(100);

      // Step 2: Extract clauses
      console.log('Step 2: Extracting clauses...');
      const clauses = await analysisTools.extractKeyClauses({
        documentText: parsed.text,
      });

      console.log(`✓ Clauses extracted: ${clauses.clauses.length} clauses`);
      expect(clauses.clauses).toBeInstanceOf(Array);

      // Step 3: Summarize
      console.log('Step 3: Creating summary...');
      const summary = await analysisTools.summarizeDocument({
        documentText: parsed.text,
        detailLevel: 'standard',
      });

      console.log(`✓ Summary created`);
      console.log(`  - Executive: ${summary.executiveSummary.length} chars`);

      expect(summary.executiveSummary).toBeTruthy();

      // Final validation
      console.log('\n=== Workflow Complete ===');
      console.log('All steps executed successfully!');

      expect(parsed).toBeDefined();
      expect(clauses).toBeDefined();
      expect(summary).toBeDefined();
    }, 180000);
  });

  describe('6. Error Handling', () => {
    it('should handle invalid base64 gracefully', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      console.log('\n=== Testing Error Handling ===');

      await expect(
        analysisTools.parseDocument({
          fileBase64: 'invalid-base64!!!',
          mimeType: 'application/pdf',
        })
      ).rejects.toThrow();

      console.log('✓ Invalid base64 handled correctly');
    }, 10000);

    it('should handle empty document text', async () => {
      if (SKIP_TESTS) {
        console.warn(skipMessage);
        return;
      }

      await expect(
        analysisTools.extractKeyClauses({
          documentText: '',
        })
      ).rejects.toThrow();

      console.log('✓ Empty document handled correctly');
    }, 10000);
  });
});
