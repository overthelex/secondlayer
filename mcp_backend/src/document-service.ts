import express from 'express';
import dotenv from 'dotenv';
import { DocumentParser } from './services/document-parser.js';
import { DocumentAnalysisTools } from './api/document-analysis-tools.js';
import { SemanticSectionizer } from './services/semantic-sectionizer.js';
import { LegalPatternStore } from './services/legal-pattern-store.js';
import { CitationValidator } from './services/citation-validator.js';
import { EmbeddingService } from './services/embedding-service.js';
import { DocumentService } from './services/document-service.js';
import { Database } from './database/database.js';
import { logger } from './utils/logger.js';
import path from 'path';

dotenv.config();

const PORT = process.env.DOCUMENT_SERVICE_PORT || 3001;

class DocumentAnalysisServer {
  private app: express.Application;
  private documentParser: DocumentParser;
  private documentAnalysisTools: DocumentAnalysisTools;
  private db: Database;
  private embeddingService: EmbeddingService;

  constructor() {
    this.app = express();
    this.app.use(express.json({ limit: '50mb' }));

    // Initialize services
    this.db = new Database();
    this.embeddingService = new EmbeddingService();

    const visionKeyPath = process.env.VISION_CREDENTIALS_PATH ||
      path.resolve(process.cwd(), '../vision-ocr-credentials.json');

    this.documentParser = new DocumentParser(visionKeyPath);

    const documentService = new DocumentService(this.db);
    const sectionizer = new SemanticSectionizer();
    const patternStore = new LegalPatternStore(this.db, this.embeddingService);
    const citationValidator = new CitationValidator(this.db);

    this.documentAnalysisTools = new DocumentAnalysisTools(
      this.documentParser,
      sectionizer,
      patternStore,
      citationValidator,
      this.embeddingService,
      documentService
    );

    this.setupRoutes();
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'document-analysis',
        timestamp: new Date().toISOString()
      });
    });

    // Ready check (includes dependencies)
    this.app.get('/ready', async (_req, res) => {
      try {
        // Check if document parser is initialized
        res.json({
          status: 'ready',
          service: 'document-analysis',
          timestamp: new Date().toISOString()
        });
      } catch (error: any) {
        res.status(503).json({
          status: 'not ready',
          error: error.message
        });
      }
    });

    // Parse document
    this.app.post('/api/parse-document', async (req, res) => {
      try {
        const { fileBase64, mimeType, filename } = req.body;

        if (!fileBase64) {
          return res.status(400).json({ error: 'fileBase64 is required' });
        }

        const result = await this.documentAnalysisTools.parseDocument({
          fileBase64,
          mimeType,
          filename
        });

        return res.json(result);
      } catch (error: any) {
        logger.error('Parse document error:', error);
        return res.status(500).json({ error: error.message });
      }
    });

    // Extract key clauses
    this.app.post('/api/extract-clauses', async (req, res) => {
      try {
        const { documentText, documentId } = req.body;

        if (!documentText) {
          return res.status(400).json({ error: 'documentText is required' });
        }

        const result = await this.documentAnalysisTools.extractKeyClauses({
          documentText,
          documentId
        });

        return res.json(result);
      } catch (error: any) {
        logger.error('Extract clauses error:', error);
        return res.status(500).json({ error: error.message });
      }
    });

    // Summarize document
    this.app.post('/api/summarize-document', async (req, res) => {
      try {
        const { documentText, detailLevel } = req.body;

        if (!documentText) {
          return res.status(400).json({ error: 'documentText is required' });
        }

        const result = await this.documentAnalysisTools.summarizeDocument({
          documentText,
          detailLevel: detailLevel as 'quick' | 'standard' | 'deep'
        });

        return res.json(result);
      } catch (error: any) {
        logger.error('Summarize document error:', error);
        return res.status(500).json({ error: error.message });
      }
    });

    // Compare documents
    this.app.post('/api/compare-documents', async (req, res) => {
      try {
        const { oldDocumentText, newDocumentText } = req.body;

        if (!oldDocumentText || !newDocumentText) {
          return res.status(400).json({
            error: 'Both oldDocumentText and newDocumentText are required'
          });
        }

        const result = await this.documentAnalysisTools.compareDocuments({
          oldDocumentText,
          newDocumentText
        });

        return res.json(result);
      } catch (error: any) {
        logger.error('Compare documents error:', error);
        return res.status(500).json({ error: error.message });
      }
    });

    // Error handler
    this.app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async initialize() {
    try {
      // Initialize embedding service (may not need DB connection)
      await this.embeddingService.initialize().catch(() => {
        logger.warn('EmbeddingService initialization skipped (no DB)');
      });

      // Initialize document parser
      await this.documentParser.initialize();

      logger.info('Document Analysis Service initialized');
    } catch (error) {
      logger.error('Failed to initialize service:', error);
      throw error;
    }
  }

  async start() {
    await this.initialize();

    this.app.listen(PORT, () => {
      logger.info(`Document Analysis Service running on port ${PORT}`);
    });
  }

  async cleanup() {
    await this.documentParser.cleanup();
  }
}

// Start server
const server = new DocumentAnalysisServer();

server.start().catch((error) => {
  logger.error('Failed to start Document Analysis Service:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await server.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await server.cleanup();
  process.exit(0);
});
