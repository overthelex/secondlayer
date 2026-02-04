/**
 * Due Diligence Tools - Stage 5 MCP API
 *
 * MCP tools for bulk document review and due diligence processes:
 * - bulk_review_runner: Batch orchestration of document reviews
 * - risk_scoring: Calculate risk scores for documents
 * - generate_dd_report: Generate formatted DD reports with findings table
 *
 * Contract per pipeline_contracts.txt v1:
 * - All inputs/outputs versioned
 * - Unified error format (code/message/retryable/details)
 * - trace_id support for observability
 */

import {
  DueDiligenceService,
  DDFinding,
  DocumentRiskScore,
  DDReport,
  BatchReviewProgress,
} from '../services/due-diligence-service.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * MCP Tool Response Envelope (v1)
 */
interface ToolResponse<T> {
  version: 'v1';
  trace_id: string;
  data: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: any;
  };
}

/**
 * Batch review result
 */
interface BulkReviewResult {
  reviewId: string;
  totalDocuments: number;
  reviewedDocuments: number;
  failedDocuments: number;
  findings: DDFinding[];
  riskScores: DocumentRiskScore[];
  processingTimeMs: number;
}

/**
 * Formatted DD table row
 */
interface DDTableRow {
  documentTitle: string;
  category: string;
  riskLevel: string;
  finding: string;
  recommendation: string;
  anchor: string;
}

export class DueDiligenceTools {
  constructor(private ddService: DueDiligenceService) {}

  getToolDefinitions() {
    return [
      {
        name: 'bulk_review_runner',
        description: `Пакетная проверка документов для due diligence (Этап 5).

Запускает batch orchestration для массовой проверки документов:
1. Загружает документы параллельно (max concurrency: 5)
2. Извлекает секции через extract_document_sections
3. Анализирует риски через analyze_legal_patterns
4. Проверяет наличие критических клауз
5. Агрегирует findings с anchors (ссылки на места в документах)

Acceptance criteria (spec.txt):
- Формирует DD findings table
- Каждый finding имеет ссылку на document+anchor

Возвращает:
- findings[]: массив находок с категориями, рисками, anchors
- riskScores[]: оценки рисков по документам`,
        inputSchema: {
          type: 'object',
          properties: {
            documentIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'UUID документов для проверки (из vault или БД)',
            },
            maxConcurrency: {
              type: 'number',
              description: 'Макс. кол-во параллельных проверок (default: 5)',
            },
            trace_id: {
              type: 'string',
              description: 'Trace ID для observability (опционально)',
            },
          },
          required: ['documentIds'],
        },
      },
      {
        name: 'risk_scoring',
        description: `Расчет risk score для документов на основе findings.

Алгоритм скоринга:
- Critical finding: +25 баллов
- High finding: +15 баллов
- Medium finding: +8 баллов
- Low finding: +3 баллов
- Максимум: 100 баллов

Breakdown по категориям:
- contractual: договорные обязательства
- financial: финансовые риски
- compliance: соответствие требованиям
- legal: юридические риски
- operational: операционные риски

Возвращает:
- overallRisk: critical/high/medium/low
- score: числовой балл 0-100
- breakdown: оценки по категориям
- counts: количество findings по уровням`,
        inputSchema: {
          type: 'object',
          properties: {
            documentIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'UUID документов для скоринга',
            },
            findings: {
              type: 'array',
              items: {
                type: 'object',
              },
              description:
                'Findings из bulk_review_runner (опционально, если не указаны - загрузятся из БД)',
            },
            trace_id: {
              type: 'string',
              description: 'Trace ID для observability',
            },
          },
          required: ['documentIds'],
        },
      },
      {
        name: 'generate_dd_report',
        description: `Генерация отчета DD с таблицей findings и executive summary.

Формат отчета:
A. Executive Summary (для руководства, 2-3 абзаца)
B. Детальное резюме (статистика, основные риски)
C. Findings Table (таблица находок):
   - Document | Category | Risk | Finding | Recommendation | Anchor
D. Risk Scores (оценки по документам)
E. Recommendations (рекомендации для руководства)

Использует:
- analyze_legal_patterns для извлечения рисков
- validate_response для проверки рекомендаций
- AI для генерации executive summary

Acceptance criteria:
- Стабильный формат для разных типов вопросов
- Таблица findings с anchors (ссылки на документы)`,
        inputSchema: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              description: 'Findings из bulk_review_runner',
            },
            riskScores: {
              type: 'array',
              description: 'Risk scores из bulk_review_runner или risk_scoring',
            },
            reportTitle: {
              type: 'string',
              description: 'Название отчета',
            },
            format: {
              type: 'string',
              enum: ['json', 'markdown', 'html'],
              description: 'Формат вывода (default: json)',
            },
            trace_id: {
              type: 'string',
              description: 'Trace ID для observability',
            },
          },
          required: ['findings', 'riskScores', 'reportTitle'],
        },
      },
    ];
  }

  /**
   * Bulk review runner - batch orchestration
   */
  async bulkReviewRunner(args: {
    documentIds: string[];
    maxConcurrency?: number;
    trace_id?: string;
  }): Promise<ToolResponse<BulkReviewResult>> {
    const traceId = args.trace_id || uuidv4();
    const startTime = Date.now();
    const reviewId = `review-${Date.now()}`;

    logger.info('[DD Tool] bulk_review_runner started', {
      trace_id: traceId,
      reviewId,
      documentCount: args.documentIds.length,
      maxConcurrency: args.maxConcurrency,
    });

    try {
      let completedCount = 0;
      let failedCount = 0;

      // Run bulk review with progress tracking
      const result = await this.ddService.runBulkReview(args.documentIds, {
        maxConcurrency: args.maxConcurrency,
        onProgress: (progress: BatchReviewProgress) => {
          completedCount = progress.completed;
          failedCount = progress.failed;

          logger.info('[DD Tool] Bulk review progress', {
            trace_id: traceId,
            reviewId,
            completed: progress.completed,
            failed: progress.failed,
            total: progress.total,
            currentDocument: progress.currentDocument,
          });
        },
      });

      const duration = Date.now() - startTime;

      const response: BulkReviewResult = {
        reviewId,
        totalDocuments: args.documentIds.length,
        reviewedDocuments: completedCount,
        failedDocuments: failedCount,
        findings: result.findings,
        riskScores: result.riskScores,
        processingTimeMs: duration,
      };

      logger.info('[DD Tool] bulk_review_runner completed', {
        trace_id: traceId,
        reviewId,
        findingsCount: result.findings.length,
        durationMs: duration,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: response,
      };
    } catch (error: any) {
      logger.error('[DD Tool] bulk_review_runner failed', {
        trace_id: traceId,
        reviewId,
        error: error.message,
        stack: error.stack,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: {} as BulkReviewResult,
        error: {
          code: 'BULK_REVIEW_FAILED',
          message: error.message,
          retryable: true,
          details: { reviewId, documentIds: args.documentIds },
        },
      };
    }
  }

  /**
   * Risk scoring for documents
   */
  async riskScoring(args: {
    documentIds: string[];
    findings?: DDFinding[];
    trace_id?: string;
  }): Promise<ToolResponse<{ riskScores: DocumentRiskScore[] }>> {
    const traceId = args.trace_id || uuidv4();

    logger.info('[DD Tool] risk_scoring started', {
      trace_id: traceId,
      documentCount: args.documentIds.length,
      hasFindings: !!args.findings,
    });

    try {
      let findings = args.findings;

      // If findings not provided, run bulk review to get them
      if (!findings || findings.length === 0) {
        logger.info('[DD Tool] Running bulk review to get findings', { trace_id: traceId });
        const reviewResult = await this.ddService.runBulkReview(args.documentIds);
        findings = reviewResult.findings;
      }

      // Calculate risk scores for each document
      const riskScores: DocumentRiskScore[] = [];

      for (const docId of args.documentIds) {
        const docFindings = findings.filter((f) => f.documentId === docId);
        const riskScore = this.ddService.calculateRiskScore(docId, findings);
        riskScores.push(riskScore);
      }

      logger.info('[DD Tool] risk_scoring completed', {
        trace_id: traceId,
        scoresCount: riskScores.length,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: { riskScores },
      };
    } catch (error: any) {
      logger.error('[DD Tool] risk_scoring failed', {
        trace_id: traceId,
        error: error.message,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: { riskScores: [] },
        error: {
          code: 'RISK_SCORING_FAILED',
          message: error.message,
          retryable: true,
          details: { documentIds: args.documentIds },
        },
      };
    }
  }

  /**
   * Generate DD report with findings table
   */
  async generateDDReport(args: {
    findings: DDFinding[];
    riskScores: DocumentRiskScore[];
    reportTitle: string;
    format?: 'json' | 'markdown' | 'html';
    trace_id?: string;
  }): Promise<ToolResponse<DDReport | string>> {
    const traceId = args.trace_id || uuidv4();
    const format = args.format || 'json';

    logger.info('[DD Tool] generate_dd_report started', {
      trace_id: traceId,
      reportTitle: args.reportTitle,
      findingsCount: args.findings.length,
      scoresCount: args.riskScores.length,
      format,
    });

    try {
      // Generate report
      const report = await this.ddService.generateReport(
        args.findings,
        args.riskScores,
        args.reportTitle
      );

      // Format output
      if (format === 'markdown') {
        const markdown = this.formatReportAsMarkdown(report);
        logger.info('[DD Tool] generate_dd_report completed (markdown)', {
          trace_id: traceId,
          reportId: report.id,
        });
        return {
          version: 'v1',
          trace_id: traceId,
          data: markdown,
        };
      } else if (format === 'html') {
        const html = this.formatReportAsHTML(report);
        logger.info('[DD Tool] generate_dd_report completed (html)', {
          trace_id: traceId,
          reportId: report.id,
        });
        return {
          version: 'v1',
          trace_id: traceId,
          data: html,
        };
      }

      // Default: JSON
      logger.info('[DD Tool] generate_dd_report completed (json)', {
        trace_id: traceId,
        reportId: report.id,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: report,
      };
    } catch (error: any) {
      logger.error('[DD Tool] generate_dd_report failed', {
        trace_id: traceId,
        error: error.message,
      });

      return {
        version: 'v1',
        trace_id: traceId,
        data: {} as DDReport,
        error: {
          code: 'REPORT_GENERATION_FAILED',
          message: error.message,
          retryable: true,
          details: { reportTitle: args.reportTitle },
        },
      };
    }
  }

  /**
   * Format report as Markdown table
   */
  private formatReportAsMarkdown(report: DDReport): string {
    const { findings, riskScores } = report;

    let md = `# ${report.title}\n\n`;
    md += `**Report ID:** ${report.id}\n`;
    md += `**Created:** ${new Date(report.createdAt).toLocaleString()}\n`;
    md += `**Overall Risk:** ${report.overallRisk.toUpperCase()}\n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n${report.executiveSummary}\n\n`;

    // Detailed Summary
    md += `## Summary\n\n${report.summary}\n\n`;

    // Findings Table
    md += `## Findings Table\n\n`;
    md += `| Document | Category | Risk | Finding | Recommendation | Anchor |\n`;
    md += `|----------|----------|------|---------|----------------|--------|\n`;

    for (const finding of findings) {
      const anchor = finding.anchor?.quote
        ? `${finding.anchor.sectionType || 'N/A'}: "${finding.anchor.quote.slice(0, 50)}..."`
        : 'N/A';

      md += `| ${finding.documentTitle} | ${finding.category} | ${finding.riskLevel.toUpperCase()} | ${finding.title} | ${finding.recommendation || 'N/A'} | ${anchor} |\n`;
    }

    md += `\n`;

    // Risk Scores
    md += `## Risk Scores\n\n`;
    for (const score of riskScores) {
      md += `### ${score.documentTitle}\n`;
      md += `- **Overall Risk:** ${score.overallRisk.toUpperCase()}\n`;
      md += `- **Score:** ${score.score}/100\n`;
      md += `- **Critical Findings:** ${score.criticalFindingsCount}\n`;
      md += `- **High Findings:** ${score.highFindingsCount}\n`;
      md += `- **Breakdown:**\n`;
      md += `  - Contractual: ${score.breakdown.contractual}/100\n`;
      md += `  - Financial: ${score.breakdown.financial}/100\n`;
      md += `  - Compliance: ${score.breakdown.compliance}/100\n`;
      md += `  - Legal: ${score.breakdown.legal}/100\n`;
      md += `  - Operational: ${score.breakdown.operational}/100\n`;
      md += `\n`;
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      md += `## Recommendations\n\n`;
      for (const rec of report.recommendations) {
        md += `- ${rec}\n`;
      }
    }

    md += `\n---\n`;
    md += `*Generated in ${report.processingTimeMs}ms*\n`;

    return md;
  }

  /**
   * Format report as HTML
   */
  private formatReportAsHTML(report: DDReport): string {
    const { findings, riskScores } = report;

    let html = `<!DOCTYPE html>
<html>
<head>
  <title>${report.title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
    h2 { color: #666; border-bottom: 2px solid #ddd; padding-bottom: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f4f4f4; font-weight: bold; }
    .risk-critical { color: #d32f2f; font-weight: bold; }
    .risk-high { color: #f57c00; font-weight: bold; }
    .risk-medium { color: #fbc02d; }
    .risk-low { color: #388e3c; }
    .meta { color: #999; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>${report.title}</h1>
  <div class="meta">
    <p><strong>Report ID:</strong> ${report.id}</p>
    <p><strong>Created:</strong> ${new Date(report.createdAt).toLocaleString()}</p>
    <p><strong>Overall Risk:</strong> <span class="risk-${report.overallRisk}">${report.overallRisk.toUpperCase()}</span></p>
  </div>

  <h2>Executive Summary</h2>
  <p>${report.executiveSummary}</p>

  <h2>Summary</h2>
  <pre>${report.summary}</pre>

  <h2>Findings Table</h2>
  <table>
    <thead>
      <tr>
        <th>Document</th>
        <th>Category</th>
        <th>Risk</th>
        <th>Finding</th>
        <th>Recommendation</th>
        <th>Anchor</th>
      </tr>
    </thead>
    <tbody>`;

    for (const finding of findings) {
      const anchor = finding.anchor?.quote
        ? `${finding.anchor.sectionType || 'N/A'}: "${finding.anchor.quote.slice(0, 50)}..."`
        : 'N/A';

      html += `
      <tr>
        <td>${finding.documentTitle}</td>
        <td>${finding.category}</td>
        <td class="risk-${finding.riskLevel}">${finding.riskLevel.toUpperCase()}</td>
        <td>${finding.title}</td>
        <td>${finding.recommendation || 'N/A'}</td>
        <td><small>${anchor}</small></td>
      </tr>`;
    }

    html += `
    </tbody>
  </table>

  <h2>Risk Scores</h2>`;

    for (const score of riskScores) {
      html += `
  <h3>${score.documentTitle}</h3>
  <ul>
    <li><strong>Overall Risk:</strong> <span class="risk-${score.overallRisk}">${score.overallRisk.toUpperCase()}</span></li>
    <li><strong>Score:</strong> ${score.score}/100</li>
    <li><strong>Critical Findings:</strong> ${score.criticalFindingsCount}</li>
    <li><strong>High Findings:</strong> ${score.highFindingsCount}</li>
    <li><strong>Breakdown:</strong>
      <ul>
        <li>Contractual: ${score.breakdown.contractual}/100</li>
        <li>Financial: ${score.breakdown.financial}/100</li>
        <li>Compliance: ${score.breakdown.compliance}/100</li>
        <li>Legal: ${score.breakdown.legal}/100</li>
        <li>Operational: ${score.breakdown.operational}/100</li>
      </ul>
    </li>
  </ul>`;
    }

    if (report.recommendations.length > 0) {
      html += `
  <h2>Recommendations</h2>
  <ul>`;
      for (const rec of report.recommendations) {
        html += `<li>${rec}</li>`;
      }
      html += `</ul>`;
    }

    html += `
  <hr>
  <p class="meta">Generated in ${report.processingTimeMs}ms</p>
</body>
</html>`;

    return html;
  }
}
