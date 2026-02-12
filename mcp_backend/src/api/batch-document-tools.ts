import { DocumentParser, ParsedDocument } from '../services/document-parser.js';
import { DocumentAnalysisTools, ExtractedClause, DocumentSummary } from './document-analysis-tools.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { BaseToolHandler, ToolDefinition, ToolResult } from './base-tool-handler.js';

export interface BatchFile {
  id: string;
  filename: string;
  fileBase64: string;
  mimeType?: string;
}

export interface BatchOperation {
  parse?: boolean;
  extract_clauses?: boolean;
  summarize?: boolean;
  summarize_level?: 'quick' | 'standard' | 'deep';
}

export interface BatchFileResult {
  fileId: string;
  filename: string;
  success: boolean;
  error?: string;
  result?: {
    parsed?: ParsedDocument;
    clauses?: { clauses: ExtractedClause[]; riskReport: any };
    summary?: DocumentSummary;
  };
  executionTimeMs: number;
  costEstimate?: {
    openai_usd: number;
    vision_usd: number;
    total_usd: number;
  };
}

export interface BatchProgressEvent {
  type: 'connected' | 'progress' | 'complete' | 'error' | 'end';
  data: any;
  id?: string;
}

export interface BatchResult {
  total: number;
  completed: number;
  failed: number;
  results: BatchFileResult[];
  totalCostUsd: number;
  totalExecutionTimeMs: number;
}

/**
 * Batch document processing with SSE progress streaming
 * Optimized for processing thousands of documents with real-time progress updates
 */
export class BatchDocumentTools extends BaseToolHandler {
  constructor(
    private documentParser: DocumentParser,
    private documentAnalysisTools: DocumentAnalysisTools
  ) {
    super();
  }

  getToolDefinitions() {
    return [
      {
        name: 'batch_process_documents',
        description: `Пакетна обробка великої кількості документів (PDF, зображення, DOCX) з прогресом в реальному часі.

Підтримує:
- Парсинг документів (OCR через Google Vision API)
- Витяг ключових положень (AI-аналіз контрактів)
- Створення резюме документів

Особливості:
- Контроль паралелізму (concurrency) для оптимізації швидкості/затрат
- SSE streaming для відображення прогресу клієнту
- Автоматичний retry при помилках
- Детальний cost tracking
- Обробка до 1000 файлів за один запит

Рекомендації:
- concurrency: 5-10 для балансу швидкості та затрат
- Для >1000 файлів розділити на чанки по 100-200 файлів`,
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: 'Масив файлів для обробки',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Унікальний ідентифікатор файлу',
                  },
                  filename: {
                    type: 'string',
                    description: 'Назва файлу',
                  },
                  fileBase64: {
                    type: 'string',
                    description: 'Base64-encoded вміст файлу',
                  },
                  mimeType: {
                    type: 'string',
                    description: 'MIME type (application/pdf, image/png, image/jpeg, etc.)',
                  },
                },
                required: ['id', 'filename', 'fileBase64'],
              },
            },
            operations: {
              type: 'object',
              description: 'Операції для виконання над кожним файлом',
              properties: {
                parse: {
                  type: 'boolean',
                  description: 'Парсинг документа (витяг тексту)',
                },
                extract_clauses: {
                  type: 'boolean',
                  description: 'Витяг ключових положень (для контрактів)',
                },
                summarize: {
                  type: 'boolean',
                  description: 'Створення резюме документа',
                },
                summarize_level: {
                  type: 'string',
                  enum: ['quick', 'standard', 'deep'],
                  description: 'Рівень деталізації резюме',
                },
              },
            },
            concurrency: {
              type: 'number',
              description: 'Кількість паралельних обробок (за замовчуванням: 20)',
              minimum: 1,
              maximum: 50,
            },
            retryAttempts: {
              type: 'number',
              description: 'Кількість спроб при помилках (за замовчуванням: 2)',
              minimum: 0,
              maximum: 5,
            },
            skipErrors: {
              type: 'boolean',
              description: 'Продовжувати обробку при помилках (за замовчуванням: true)',
            },
          },
          required: ['files', 'operations'],
        },
      },
    ];
  }

  /**
   * Process batch of documents with progress streaming
   */
  async processBatch(
    args: {
      files: BatchFile[];
      operations: BatchOperation;
      concurrency?: number;
      retryAttempts?: number;
      skipErrors?: boolean;
    },
    progressCallback?: (event: BatchProgressEvent) => void
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const concurrency = args.concurrency || 20;
    const retryAttempts = args.retryAttempts || 2;
    const skipErrors = args.skipErrors !== false;

    const total = args.files.length;
    let completed = 0;
    let failed = 0;
    const results: BatchFileResult[] = [];
    let totalCostUsd = 0;

    logger.info('[BatchDocumentTools] Starting batch processing', {
      total,
      concurrency,
      operations: args.operations,
    });

    // Send initial connection event
    this.sendProgress(progressCallback, {
      type: 'connected',
      data: {
        total,
        operations: args.operations,
        concurrency,
        timestamp: new Date().toISOString(),
      },
      id: 'connection',
    });

    // Process files in batches with concurrency control
    for (let i = 0; i < args.files.length; i += concurrency) {
      const batchFiles = args.files.slice(i, i + concurrency);
      const batchNumber = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(total / concurrency);

      logger.info(`[BatchDocumentTools] Processing batch ${batchNumber}/${totalBatches}`, {
        filesInBatch: batchFiles.length,
      });

      // Send batch start event
      this.sendProgress(progressCallback, {
        type: 'progress',
        data: {
          message: `Обробка пакету ${batchNumber}/${totalBatches}`,
          batchNumber,
          totalBatches,
          progress: completed / total,
          completed,
          failed,
          total,
        },
        id: `batch-${batchNumber}-start`,
      });

      // Process batch files in parallel
      const batchResults = await Promise.allSettled(
        batchFiles.map(async (file) => {
          return await this.processFileWithRetry(
            file,
            args.operations,
            retryAttempts,
            skipErrors,
            progressCallback
          );
        })
      );

      // Collect results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const fileResult = result.value;
          results.push(fileResult);

          if (fileResult.success) {
            completed++;
            totalCostUsd += fileResult.costEstimate?.total_usd || 0;
          } else {
            failed++;
          }

          // Send file completion event
          this.sendProgress(progressCallback, {
            type: 'progress',
            data: {
              fileId: fileResult.fileId,
              filename: fileResult.filename,
              status: fileResult.success ? 'completed' : 'failed',
              error: fileResult.error,
              progress: (completed + failed) / total,
              completed,
              failed,
              total,
              executionTimeMs: fileResult.executionTimeMs,
              costUsd: fileResult.costEstimate?.total_usd,
            },
            id: `file-${fileResult.fileId}`,
          });
        } else {
          failed++;
          logger.error('[BatchDocumentTools] Unexpected batch processing error', {
            error: result.reason,
          });
        }
      }

      // Send batch completion event
      this.sendProgress(progressCallback, {
        type: 'progress',
        data: {
          message: `Пакет ${batchNumber}/${totalBatches} завершено`,
          batchNumber,
          totalBatches,
          progress: (completed + failed) / total,
          completed,
          failed,
          total,
        },
        id: `batch-${batchNumber}-complete`,
      });
    }

    const totalExecutionTimeMs = Date.now() - startTime;

    logger.info('[BatchDocumentTools] Batch processing completed', {
      total,
      completed,
      failed,
      totalCostUsd: totalCostUsd.toFixed(4),
      totalExecutionTimeMs,
    });

    // Send final completion event
    const finalResult: BatchResult = {
      total,
      completed,
      failed,
      results,
      totalCostUsd,
      totalExecutionTimeMs,
    };

    this.sendProgress(progressCallback, {
      type: 'complete',
      data: finalResult,
      id: 'final',
    });

    return finalResult;
  }

  /**
   * Process single file with retry logic
   */
  private async processFileWithRetry(
    file: BatchFile,
    operations: BatchOperation,
    retryAttempts: number,
    skipErrors: boolean,
    progressCallback?: (event: BatchProgressEvent) => void
  ): Promise<BatchFileResult> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt <= retryAttempts) {
      try {
        if (attempt > 0) {
          logger.info(`[BatchDocumentTools] Retry attempt ${attempt} for file`, {
            fileId: file.id,
            filename: file.filename,
          });

          this.sendProgress(progressCallback, {
            type: 'progress',
            data: {
              fileId: file.id,
              filename: file.filename,
              status: 'retrying',
              attempt,
              maxAttempts: retryAttempts,
            },
            id: `file-${file.id}-retry-${attempt}`,
          });
        }

        return await this.processSingleFile(file, operations);
      } catch (error: any) {
        lastError = error;
        attempt++;

        if (attempt > retryAttempts) {
          if (!skipErrors) {
            throw error;
          }
          logger.error('[BatchDocumentTools] File processing failed after retries', {
            fileId: file.id,
            filename: file.filename,
            attempts: attempt,
            error: error.message,
          });
          break;
        }

        // Wait before retry (exponential backoff)
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Return failed result
    return {
      fileId: file.id,
      filename: file.filename,
      success: false,
      error: lastError?.message || 'Unknown error',
      executionTimeMs: 0,
    };
  }

  /**
   * Process single file
   */
  private async processSingleFile(
    file: BatchFile,
    operations: BatchOperation
  ): Promise<BatchFileResult> {
    const startTime = Date.now();
    const result: BatchFileResult = {
      fileId: file.id,
      filename: file.filename,
      success: false,
      executionTimeMs: 0,
      result: {},
    };

    let openaiCost = 0;
    let visionCost = 0;

    try {
      const fileBuffer = Buffer.from(file.fileBase64, 'base64');

      // Operation 1: Parse document
      if (operations.parse) {
        logger.debug(`[BatchDocumentTools] Parsing file: ${file.filename}`);
        const parsed = await this.documentParser.parseDocument(fileBuffer, file.mimeType);
        result.result!.parsed = parsed;

        // Estimate Vision API cost (if OCR was used)
        if (parsed.metadata.source === 'ocr') {
          const pageCount = parsed.metadata.pageCount || 1;
          visionCost += pageCount * 0.0015; // $1.50 per 1000 pages
        }
      }

      // Get parsed text for subsequent operations
      const documentText = result.result?.parsed?.text;

      // Operation 2: Extract clauses (requires parsed text)
      if (operations.extract_clauses && documentText) {
        logger.debug(`[BatchDocumentTools] Extracting clauses: ${file.filename}`);
        const clauses = await this.documentAnalysisTools.extractKeyClauses({
          documentText,
          documentId: file.id,
        });
        result.result!.clauses = clauses;

        // Estimate OpenAI cost (GPT-4o-mini)
        const inputTokens = Math.ceil(documentText.length / 4);
        const outputTokens = 500; // Average for clause extraction
        openaiCost += (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000;
      }

      // Operation 3: Summarize (requires parsed text)
      if (operations.summarize && documentText) {
        logger.debug(`[BatchDocumentTools] Summarizing: ${file.filename}`);
        const summarizeLevel = operations.summarize_level || 'standard';
        const summary = await this.documentAnalysisTools.summarizeDocument({
          documentText,
          detailLevel: summarizeLevel,
        });
        result.result!.summary = summary;

        // Estimate OpenAI cost
        const inputTokens = Math.ceil(documentText.length / 4);
        const outputTokens = summarizeLevel === 'deep' ? 1000 : 500;
        const costMultiplier = summarizeLevel === 'deep' ? 15 : 1; // GPT-4o vs GPT-4o-mini
        openaiCost += (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000 * costMultiplier;
      }

      result.success = true;
      result.executionTimeMs = Date.now() - startTime;
      result.costEstimate = {
        openai_usd: openaiCost,
        vision_usd: visionCost,
        total_usd: openaiCost + visionCost,
      };

      logger.debug(`[BatchDocumentTools] File processed successfully`, {
        fileId: file.id,
        filename: file.filename,
        executionTimeMs: result.executionTimeMs,
        costUsd: result.costEstimate.total_usd.toFixed(6),
      });

      return result;
    } catch (error: any) {
      result.success = false;
      result.error = error.message;
      result.executionTimeMs = Date.now() - startTime;

      logger.error('[BatchDocumentTools] File processing failed', {
        fileId: file.id,
        filename: file.filename,
        error: error.message,
        executionTimeMs: result.executionTimeMs,
      });

      throw error;
    }
  }

  /**
   * Send progress event via callback
   */
  private sendProgress(
    callback: ((event: BatchProgressEvent) => void) | undefined,
    event: BatchProgressEvent
  ): void {
    if (callback) {
      try {
        callback(event);
      } catch (error) {
        logger.error('[BatchDocumentTools] Error in progress callback', { error });
      }
    }
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'batch_process_documents':
        return this.wrapResponse(await this.processBatch(args));
      default:
        return null;
    }
  }
}
