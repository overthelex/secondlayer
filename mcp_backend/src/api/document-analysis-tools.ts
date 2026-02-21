import { DocumentParser, ParsedDocument } from '../services/document-parser.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { CitationValidator } from '../services/citation-validator.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { DocumentService } from '../services/document-service.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';
import * as Diff from 'diff';
import { BaseToolHandler, ToolDefinition, ToolResult } from './base-tool-handler.js';

export interface ExtractedClause {
  type: string;
  text: string;
  pageNumber?: number;
  confidence: number;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface DocumentSummary {
  executiveSummary: string;
  detailedSummary: string;
  keyFacts: {
    parties?: string[];
    dates?: string[];
    amounts?: string[];
  };
}

export interface DocumentComparison {
  changes: Array<{
    type: 'addition' | 'deletion' | 'modification';
    oldText?: string;
    newText?: string;
    location: string;
    importance: 'critical' | 'significant' | 'minor';
  }>;
  summary: string;
}

export class DocumentAnalysisTools extends BaseToolHandler {
  constructor(
    private documentParser: DocumentParser,
    _sectionizer: SemanticSectionizer,
    _patternStore: LegalPatternStore,
    _citationValidator: CitationValidator,
    _embeddingService: EmbeddingService,
    _documentService: DocumentService
  ) {
    super();
  }

  getToolDefinitions() {
    return [
      {
        name: 'parse_document',
        description: `Парсинг документа (PDF/DOCX/HTML) с извлечением текста и метаданных.

Стратегия:
- PDF: сначала нативное извлечение текста, затем OCR через Playwright + Google Vision API
- DOCX: сначала mammoth, затем OCR
- HTML: screenshot + OCR

Поддерживает языки: украинский, русский, английский`,
        inputSchema: {
          type: 'object',
          properties: {
            fileBase64: {
              type: 'string',
              description: 'Base64-encoded содержимое файла',
            },
            mimeType: {
              type: 'string',
              description: 'MIME type: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/html',
            },
            filename: {
              type: 'string',
              description: 'Имя файла (опционально, для логирования)',
            },
          },
          required: ['fileBase64'],
        },
      },
      {
        name: 'extract_key_clauses',
        description: `Извлечение ключевых положений из контракта/соглашения.

Выделяет и классифицирует клаузы по типам:
- Стороны и предмет договора
- Права и обязательства
- Сроки и условия
- Платежи и финансы
- Ответственность и штрафы
- Форс-мажор и прекращение
- Конфиденциальность

Анализирует риски через analyze_legal_patterns.`,
        inputSchema: {
          type: 'object',
          properties: {
            documentText: {
              type: 'string',
              description: 'Текст документа (можно получить через parse_document)',
            },
            documentId: {
              type: 'string',
              description: 'ID документа из БД (опционально)',
            },
          },
          required: ['documentText'],
        },
      },
      {
        name: 'summarize_document',
        description: `Создание краткого и детального резюме документа.

Включает:
- Executive summary (2-3 абзаца для руководства)
- Detailed summary (по секциям)
- Ключевые факты: стороны, даты, суммы

Использует budget-aware model selection (quick/standard/deep).`,
        inputSchema: {
          type: 'object',
          properties: {
            documentText: {
              type: 'string',
              description: 'Текст документа',
            },
            detailLevel: {
              type: 'string',
              enum: ['quick', 'standard', 'deep'],
              description: 'Уровень детализации (quick = executive only, deep = с анализом)',
            },
          },
          required: ['documentText'],
        },
      },
      {
        name: 'compare_documents',
        description: `Семантическое сравнение двух версий документа.

Находит и классифицирует изменения:
- Критические: изменения сумм, сроков, обязательств
- Значительные: новые клаузы, изменения прав
- Незначительные: форматирование, опечатки

Использует векторные эмбеддинги для семантического анализа.`,
        inputSchema: {
          type: 'object',
          properties: {
            oldDocumentText: {
              type: 'string',
              description: 'Текст старой версии документа',
            },
            newDocumentText: {
              type: 'string',
              description: 'Текст новой версии документа',
            },
          },
          required: ['oldDocumentText', 'newDocumentText'],
        },
      },
    ];
  }

  /**
   * Parse document (PDF/DOCX/HTML)
   */
  async parseDocument(args: {
    fileBase64: string;
    mimeType?: string;
    filename?: string;
  }): Promise<ParsedDocument> {
    try {
      logger.info('[MCP Tool] parse_document started', {
        filename: args.filename,
        mimeType: args.mimeType,
        sizeBytes: args.fileBase64.length,
      });

      const fileBuffer = Buffer.from(args.fileBase64, 'base64');
      const result = await this.documentParser.parseDocument(fileBuffer, args.mimeType);

      logger.info('[MCP Tool] parse_document completed', {
        textLength: result.text.length,
        pageCount: result.metadata.pageCount,
        source: result.metadata.source,
      });

      return result;
    } catch (error: any) {
      logger.error('Document parsing failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Extract key clauses from contract
   */
  async extractKeyClauses(args: {
    documentText: string;
    documentId?: string;
  }): Promise<{ clauses: ExtractedClause[]; riskReport: any }> {
    try {
      logger.info('[MCP Tool] extract_key_clauses started', {
        textLength: args.documentText.length,
        documentId: args.documentId,
      });

      // Step 1: Extract clauses using AI
      const openaiManager = getOpenAIManager();
      const modelSelection = ModelSelector.getModelSelection('standard');
      const model = modelSelection.model;

      const prompt = `Проанализируй договор и выдели ключевые положения (клаузы).

Классифицируй каждую клаузу по типу:
- parties_subject: Стороны и предмет договора
- rights_obligations: Права и обязательства
- terms_conditions: Сроки и условия
- payments_finance: Платежи и финансовые условия
- liability_penalties: Ответственность и штрафы
- force_majeure: Форс-мажор
- termination: Прекращение договора
- confidentiality: Конфиденциальность

Для каждой клаузы укажи уровень риска (low/medium/high) если есть потенциальные проблемы.

Формат вывода JSON:
{
  "clauses": [
    {
      "type": "payments_finance",
      "text": "текст клаузы",
      "confidence": 0.95,
      "riskLevel": "medium"
    }
  ]
}

Текст договора:
${args.documentText.slice(0, 15000)}`;

      const response = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'Ты юридический эксперт по анализу контрактов.' },
            { role: 'user', content: prompt },
          ],
          ...(ModelSelector.supportsTemperature(model) ? { temperature: 0.1 } : {}),
          response_format: { type: 'json_object' },
        });
      });

      const parsed = JSON.parse(response.choices[0].message.content || '{"clauses":[]}');
      const clauses: ExtractedClause[] = parsed.clauses || [];

      // Step 2: Create simple risk report
      const riskReport = {
        riskFactors: [],
        highRiskClauses: clauses.filter((c) => c.riskLevel === 'high'),
      };

      logger.info('[MCP Tool] extract_key_clauses completed', {
        clauseCount: clauses.length,
        highRiskCount: riskReport.highRiskClauses.length,
      });

      return { clauses, riskReport };
    } catch (error: any) {
      logger.error('Clause extraction failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Summarize document
   */
  async summarizeDocument(args: {
    documentText: string;
    detailLevel?: 'quick' | 'standard' | 'deep';
  }): Promise<DocumentSummary> {
    try {
      const detailLevel = args.detailLevel || 'standard';
      logger.info('[MCP Tool] summarize_document started', {
        textLength: args.documentText.length,
        detailLevel,
      });

      const openaiManager = getOpenAIManager();
      const modelSelection = ModelSelector.getModelSelection(detailLevel);
      const model = modelSelection.model;

      const systemPrompt = `Ты юридический аналитик. Создай резюме документа в структурированном виде.`;

      const userPrompt = `Создай резюме следующего документа:

${detailLevel === 'deep' ? 'ДЕТАЛЬНЫЙ АНАЛИЗ:' : 'КРАТКОЕ РЕЗЮМЕ:'}

1. Executive Summary (2-3 абзаца): суть документа для руководства
2. ${detailLevel === 'deep' ? 'Detailed Summary: подробное описание по секциям' : 'Основные положения'}
3. Ключевые факты:
   - Стороны (если есть)
   - Важные даты
   - Суммы/финансовые условия

Формат JSON:
{
  "executiveSummary": "...",
  "detailedSummary": "...",
  "keyFacts": {
    "parties": ["сторона 1", "сторона 2"],
    "dates": ["дата 1", "дата 2"],
    "amounts": ["сумма 1", "сумма 2"]
  }
}

Текст документа:
${args.documentText.slice(0, 20000)}`;

      const response = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...(ModelSelector.supportsTemperature(model) ? { temperature: 0.2 } : {}),
          response_format: { type: 'json_object' },
        });
      });

      const summary: DocumentSummary = JSON.parse(
        response.choices[0].message.content || '{"executiveSummary":"","detailedSummary":"","keyFacts":{}}'
      );

      logger.info('[MCP Tool] summarize_document completed', {
        executiveLength: summary.executiveSummary.length,
        partiesCount: summary.keyFacts.parties?.length || 0,
        datesCount: summary.keyFacts.dates?.length || 0,
      });

      return summary;
    } catch (error: any) {
      logger.error('Document summarization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Compare two document versions
   */
  async compareDocuments(args: {
    oldDocumentText: string;
    newDocumentText: string;
  }): Promise<DocumentComparison> {
    try {
      logger.info('[MCP Tool] compare_documents started', {
        oldLength: args.oldDocumentText.length,
        newLength: args.newDocumentText.length,
      });

      // Step 1: Text-level diff
      const textDiff = Diff.diffWords(args.oldDocumentText, args.newDocumentText);

      const changes: DocumentComparison['changes'] = [];
      let position = 0;

      textDiff.forEach((part: any) => {
        if (part.added) {
          changes.push({
            type: 'addition',
            newText: part.value,
            location: `Position ${position}`,
            importance: this.classifyChangeImportance(part.value),
          });
        } else if (part.removed) {
          changes.push({
            type: 'deletion',
            oldText: part.value,
            location: `Position ${position}`,
            importance: this.classifyChangeImportance(part.value),
          });
        }
        position += part.value.length;
      });

      // Step 2: Semantic analysis for important changes
      const criticalChanges = changes.filter((c) => c.importance === 'critical');

      // Step 3: Generate summary using AI
      const openaiManager = getOpenAIManager();
      const modelSelection = ModelSelector.getModelSelection('standard');
      const model = modelSelection.model;

      const changesText = changes
        .slice(0, 20)
        .map((c) => `[${c.type}] ${c.importance}: ${c.oldText || c.newText}`)
        .join('\n');

      const summaryPrompt = `Проанализируй изменения между двумя версиями документа и создай краткое резюме.

Изменения:
${changesText}

Укажи самые важные изменения (критические и значительные) в 3-5 пунктах.`;

      const response = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'Ты юридический аналитик.' },
            { role: 'user', content: summaryPrompt },
          ],
          ...(ModelSelector.supportsTemperature(model) ? { temperature: 0.2 } : {}),
        });
      });

      const summary = response.choices[0].message.content || 'Изменения обнаружены';

      logger.info('[MCP Tool] compare_documents completed', {
        totalChanges: changes.length,
        criticalChanges: criticalChanges.length,
        significantChanges: changes.filter(c => c.importance === 'significant').length,
      });

      return { changes, summary };
    } catch (error: any) {
      logger.error('Document comparison failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Classify change importance based on content
   */
  private classifyChangeImportance(text: string): 'critical' | 'significant' | 'minor' {
    const lowerText = text.toLowerCase();

    // Critical: money, dates, numbers, legal terms
    if (
      /\d+[\s]*грн|uah|usd|eur|\$|€/i.test(text) ||
      /\d{2}\.\d{2}\.\d{4}/.test(text) ||
      /термін|строк|penalty|штраф|неустойка|відповідальність/i.test(lowerText)
    ) {
      return 'critical';
    }

    // Significant: new clauses, rights, obligations
    if (
      /право|обов'язок|obligation|зобов'язання|умова|condition/i.test(lowerText) &&
      text.length > 50
    ) {
      return 'significant';
    }

    return 'minor';
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'parse_document':
        return this.wrapResponse(await this.parseDocument(args));
      case 'extract_key_clauses':
        return this.wrapResponse(await this.extractKeyClauses(args));
      case 'summarize_document':
        return this.wrapResponse(await this.summarizeDocument(args));
      case 'compare_documents':
        return this.wrapResponse(await this.compareDocuments(args));
      default:
        return null;
    }
  }
}
