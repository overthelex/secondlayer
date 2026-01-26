import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';
import { ParsedDocument } from '../services/document-parser.js';
import { ExtractedClause, DocumentSummary, DocumentComparison } from '../api/document-analysis-tools.js';

export class DocumentServiceClient {
  private client: AxiosInstance;
  private baseURL: string;
  private enabled: boolean;

  constructor(baseURL?: string) {
    this.baseURL = baseURL || process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3001';
    this.enabled = !!baseURL || !!process.env.DOCUMENT_SERVICE_URL;

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 120000, // 2 minutes for large documents
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (this.enabled) {
      logger.info('Document Service Client initialized', { baseURL: this.baseURL });
    } else {
      logger.warn('Document Service Client disabled (no DOCUMENT_SERVICE_URL configured)');
    }
  }

  /**
   * Check if document service is available
   */
  async healthCheck(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const response = await this.client.get('/health', { timeout: 5000 });
      return response.status === 200;
    } catch (error: any) {
      logger.warn('Document service health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Parse document (PDF/DOCX/HTML)
   */
  async parseDocument(args: {
    fileBase64: string;
    mimeType?: string;
    filename?: string;
  }): Promise<ParsedDocument> {
    if (!this.enabled) {
      throw new Error('Document service is not configured');
    }

    try {
      logger.info('Calling document service: parse-document', {
        filename: args.filename,
        mimeType: args.mimeType,
        size: args.fileBase64.length
      });

      const response = await this.client.post('/api/parse-document', args);
      return response.data;
    } catch (error: any) {
      logger.error('Document service parse-document failed', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      if (error.response?.status === 503) {
        throw new Error('Document service is temporarily unavailable');
      }

      throw new Error(`Document parsing failed: ${error.message}`);
    }
  }

  /**
   * Extract key clauses from contract
   */
  async extractKeyClauses(args: {
    documentText: string;
    documentId?: string;
  }): Promise<{ clauses: ExtractedClause[]; riskReport: any }> {
    if (!this.enabled) {
      throw new Error('Document service is not configured');
    }

    try {
      logger.info('Calling document service: extract-clauses', {
        textLength: args.documentText.length,
        documentId: args.documentId
      });

      const response = await this.client.post('/api/extract-clauses', args);
      return response.data;
    } catch (error: any) {
      logger.error('Document service extract-clauses failed', {
        error: error.message,
        status: error.response?.status
      });
      throw new Error(`Clause extraction failed: ${error.message}`);
    }
  }

  /**
   * Summarize document
   */
  async summarizeDocument(args: {
    documentText: string;
    detailLevel?: 'quick' | 'standard' | 'deep';
  }): Promise<DocumentSummary> {
    if (!this.enabled) {
      throw new Error('Document service is not configured');
    }

    try {
      logger.info('Calling document service: summarize-document', {
        textLength: args.documentText.length,
        detailLevel: args.detailLevel
      });

      const response = await this.client.post('/api/summarize-document', args);
      return response.data;
    } catch (error: any) {
      logger.error('Document service summarize-document failed', {
        error: error.message,
        status: error.response?.status
      });
      throw new Error(`Document summarization failed: ${error.message}`);
    }
  }

  /**
   * Compare two document versions
   */
  async compareDocuments(args: {
    oldDocumentText: string;
    newDocumentText: string;
  }): Promise<DocumentComparison> {
    if (!this.enabled) {
      throw new Error('Document service is not configured');
    }

    try {
      logger.info('Calling document service: compare-documents', {
        oldLength: args.oldDocumentText.length,
        newLength: args.newDocumentText.length
      });

      const response = await this.client.post('/api/compare-documents', args);
      return response.data;
    } catch (error: any) {
      logger.error('Document service compare-documents failed', {
        error: error.message,
        status: error.response?.status
      });
      throw new Error(`Document comparison failed: ${error.message}`);
    }
  }

  /**
   * Check if service is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
