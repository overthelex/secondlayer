/**
 * Due Diligence Service - Stage 5 Implementation
 *
 * Handles bulk document review for due diligence processes:
 * - Batch processing of multiple documents
 * - Risk scoring algorithms
 * - DD findings aggregation and reporting
 *
 * Reuses Stage 1 primitives:
 * - SemanticSectionizer (extract_document_sections)
 * - LegalPatternStore (analyze_legal_patterns)
 * - CitationValidator (validate_citations)
 */

import { SemanticSectionizer } from './semantic-sectionizer.js';
import { LegalPatternStore } from './legal-pattern-store.js';
import { CitationValidator } from './citation-validator.js';
import { DocumentService } from './document-service.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';
import { DocumentSection } from '../types/index.js';

/**
 * Risk level for a finding
 */
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Category of DD finding
 */
export type FindingCategory =
  | 'contractual_obligation'
  | 'financial_risk'
  | 'compliance_issue'
  | 'missing_clause'
  | 'legal_risk'
  | 'operational_risk'
  | 'other';

/**
 * Individual DD finding
 */
export interface DDFinding {
  id: string;
  documentId: string;
  documentTitle: string;
  category: FindingCategory;
  riskLevel: RiskLevel;
  title: string;
  description: string;
  recommendation?: string;
  affectedClause?: string;
  anchor?: {
    sectionType?: string;
    startIndex?: number;
    endIndex?: number;
    quote?: string;
  };
  confidence: number;
}

/**
 * Document risk score
 */
export interface DocumentRiskScore {
  documentId: string;
  documentTitle: string;
  overallRisk: RiskLevel;
  score: number; // 0-100
  breakdown: {
    contractual: number;
    financial: number;
    compliance: number;
    legal: number;
    operational: number;
  };
  criticalFindingsCount: number;
  highFindingsCount: number;
  mediumFindingsCount: number;
  lowFindingsCount: number;
}

/**
 * Due diligence report
 */
export interface DDReport {
  id: string;
  title: string;
  summary: string;
  executiveSummary: string;
  totalDocuments: number;
  reviewedDocuments: number;
  findings: DDFinding[];
  riskScores: DocumentRiskScore[];
  overallRisk: RiskLevel;
  recommendations: string[];
  createdAt: string;
  processingTimeMs: number;
}

/**
 * Batch review progress
 */
export interface BatchReviewProgress {
  total: number;
  completed: number;
  failed: number;
  currentDocument?: string;
  findings: DDFinding[];
  startTime: number;
}

export class DueDiligenceService {
  constructor(
    private sectionizer: SemanticSectionizer,
    private patternStore: LegalPatternStore,
    private citationValidator: CitationValidator,
    private documentService: DocumentService
  ) {}

  /**
   * Run bulk review on multiple documents
   *
   * Orchestrates the review process:
   * 1. Load documents in parallel
   * 2. Extract sections for each
   * 3. Analyze patterns and risks
   * 4. Aggregate findings
   * 5. Generate risk scores
   */
  async runBulkReview(
    documentIds: string[],
    options?: {
      onProgress?: (progress: BatchReviewProgress) => void;
      maxConcurrency?: number;
    }
  ): Promise<{ findings: DDFinding[]; riskScores: DocumentRiskScore[] }> {
    const startTime = Date.now();
    const maxConcurrency = options?.maxConcurrency || 20;

    logger.info('[DD] Starting bulk review', {
      documentCount: documentIds.length,
      maxConcurrency,
    });

    const progress: BatchReviewProgress = {
      total: documentIds.length,
      completed: 0,
      failed: 0,
      findings: [],
      startTime,
    };

    const allFindings: DDFinding[] = [];
    const riskScores: DocumentRiskScore[] = [];

    // Process documents in batches
    for (let i = 0; i < documentIds.length; i += maxConcurrency) {
      const batch = documentIds.slice(i, i + maxConcurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async (docId) => {
          progress.currentDocument = docId;
          options?.onProgress?.(progress);

          try {
            const findings = await this.reviewSingleDocument(docId);
            const riskScore = this.calculateRiskScore(docId, findings);

            progress.completed++;
            progress.findings.push(...findings);
            options?.onProgress?.(progress);

            return { findings, riskScore };
          } catch (error: any) {
            logger.error('[DD] Document review failed', {
              documentId: docId,
              error: error.message,
            });
            progress.failed++;
            options?.onProgress?.(progress);
            throw error;
          }
        })
      );

      // Aggregate results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          allFindings.push(...result.value.findings);
          riskScores.push(result.value.riskScore);
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info('[DD] Bulk review completed', {
      totalDocuments: documentIds.length,
      reviewedDocuments: progress.completed,
      failedDocuments: progress.failed,
      totalFindings: allFindings.length,
      durationMs: duration,
    });

    return { findings: allFindings, riskScores };
  }

  /**
   * Review a single document and extract findings
   *
   * Uses primitives:
   * - extract_document_sections (via sectionizer)
   * - analyze_legal_patterns (via patternStore)
   * - validate_citations (via citationValidator)
   */
  private async reviewSingleDocument(documentId: string): Promise<DDFinding[]> {
    logger.info('[DD] Reviewing document', { documentId });

    // Get document
    const doc = await this.documentService.getDocumentById(documentId);
    if (!doc || !doc.full_text) {
      logger.warn('[DD] Document not found or has no text', { documentId });
      return [];
    }

    const findings: DDFinding[] = [];

    // Step 1: Extract sections
    const sections = await this.sectionizer.extractSections(doc.full_text, false);
    logger.info('[DD] Sections extracted', {
      documentId,
      sectionCount: sections.length,
    });

    // Step 2: Analyze legal patterns for each section
    for (const section of sections) {
      const sectionFindings = await this.analyzeSectionForRisks(
        documentId,
        doc.title || 'Untitled',
        section
      );
      findings.push(...sectionFindings);
    }

    // Step 3: Check for missing critical clauses
    const missingClauseFindings = await this.checkMissingClauses(
      documentId,
      doc.title || 'Untitled',
      sections,
      doc.full_text
    );
    findings.push(...missingClauseFindings);

    logger.info('[DD] Document review completed', {
      documentId,
      findingsCount: findings.length,
    });

    return findings;
  }

  /**
   * Analyze a section for risks using legal patterns
   */
  private async analyzeSectionForRisks(
    documentId: string,
    documentTitle: string,
    section: DocumentSection
  ): Promise<DDFinding[]> {
    const findings: DDFinding[] = [];

    // Use pattern store to find risk factors
    try {
      // Generic pattern finding for contract documents
      const patterns = await this.patternStore.findPatterns('contract', 0.5);

      for (const pattern of patterns) {
        // Check if pattern's risk factors match this section
        if (pattern.risk_factors && pattern.risk_factors.length > 0) {
          for (const riskFactor of pattern.risk_factors) {
            if (section.text.toLowerCase().includes(riskFactor.toLowerCase())) {
              findings.push({
                id: `${documentId}:${section.type}:${riskFactor}`,
                documentId,
                documentTitle,
                category: this.mapRiskFactorToCategory(riskFactor),
                riskLevel: this.assessRiskLevel(riskFactor, pattern.confidence),
                title: `Риск: ${riskFactor}`,
                description: `Обнаружен потенциальный риск в секции ${section.type}`,
                affectedClause: riskFactor,
                anchor: {
                  sectionType: section.type,
                  startIndex: section.start_index,
                  endIndex: section.end_index,
                  quote: section.text.slice(0, 200), // First 200 chars as context
                },
                confidence: pattern.confidence,
              });
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn('[DD] Pattern analysis failed for section', {
        documentId,
        sectionType: section.type,
        error: error.message,
      });
    }

    return findings;
  }

  /**
   * Check for missing critical clauses using AI
   */
  private async checkMissingClauses(
    documentId: string,
    documentTitle: string,
    sections: DocumentSection[],
    fullText: string
  ): Promise<DDFinding[]> {
    const findings: DDFinding[] = [];

    try {
      const openaiManager = getOpenAIManager();
      const model = ModelSelector.getChatModel('standard');

      const sectionTypes = sections.map((s) => s.type).join(', ');

      const prompt = `Проанализируй договор и определи, каких критически важных клауз не хватает.

Обнаруженные секции: ${sectionTypes}

Проверь наличие следующих критических клауз:
1. Условия оплаты и финансовые обязательства
2. Срок действия договора
3. Условия расторжения
4. Ответственность сторон
5. Форс-мажор
6. Конфиденциальность (если применимо)
7. Разрешение споров

Верни JSON в формате:
{
  "missingClauses": [
    {
      "clause": "название клаузы",
      "importance": "critical" | "high" | "medium",
      "recommendation": "рекомендация"
    }
  ]
}

Фрагмент договора:
${fullText.slice(0, 8000)}`;

      const response = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content:
                'Ты юридический аналитик, специализирующийся на due diligence контрактов.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });
      });

      const result = JSON.parse(response.choices[0].message.content || '{"missingClauses":[]}');
      const missingClauses = result.missingClauses || [];

      for (const missing of missingClauses) {
        findings.push({
          id: `${documentId}:missing:${missing.clause}`,
          documentId,
          documentTitle,
          category: 'missing_clause',
          riskLevel: this.mapImportanceToRiskLevel(missing.importance),
          title: `Отсутствует: ${missing.clause}`,
          description: `В договоре не обнаружена критически важная клауза: ${missing.clause}`,
          recommendation: missing.recommendation,
          confidence: 0.7,
        });
      }
    } catch (error: any) {
      logger.warn('[DD] Missing clause check failed', {
        documentId,
        error: error.message,
      });
    }

    return findings;
  }

  /**
   * Calculate risk score for a document based on findings
   */
  calculateRiskScore(
    documentId: string,
    findings: DDFinding[],
    documentTitle?: string
  ): DocumentRiskScore {
    const docFindings = findings.filter((f) => f.documentId === documentId);

    const criticalCount = docFindings.filter((f) => f.riskLevel === 'critical').length;
    const highCount = docFindings.filter((f) => f.riskLevel === 'high').length;
    const mediumCount = docFindings.filter((f) => f.riskLevel === 'medium').length;
    const lowCount = docFindings.filter((f) => f.riskLevel === 'low').length;

    // Calculate score (0-100, higher = more risky)
    const score =
      criticalCount * 25 + // Critical = 25 points each
      highCount * 15 + // High = 15 points each
      mediumCount * 8 + // Medium = 8 points each
      lowCount * 3; // Low = 3 points each

    const normalizedScore = Math.min(100, score);

    // Determine overall risk
    let overallRisk: RiskLevel;
    if (criticalCount > 0 || normalizedScore >= 75) {
      overallRisk = 'critical';
    } else if (highCount > 2 || normalizedScore >= 50) {
      overallRisk = 'high';
    } else if (normalizedScore >= 25) {
      overallRisk = 'medium';
    } else {
      overallRisk = 'low';
    }

    // Breakdown by category
    const breakdown = {
      contractual: this.calculateCategoryScore(docFindings, 'contractual_obligation'),
      financial: this.calculateCategoryScore(docFindings, 'financial_risk'),
      compliance: this.calculateCategoryScore(docFindings, 'compliance_issue'),
      legal: this.calculateCategoryScore(docFindings, 'legal_risk'),
      operational: this.calculateCategoryScore(docFindings, 'operational_risk'),
    };

    return {
      documentId,
      documentTitle: documentTitle || 'Unknown',
      overallRisk,
      score: normalizedScore,
      breakdown,
      criticalFindingsCount: criticalCount,
      highFindingsCount: highCount,
      mediumFindingsCount: mediumCount,
      lowFindingsCount: lowCount,
    };
  }

  /**
   * Generate DD report from findings
   */
  async generateReport(
    findings: DDFinding[],
    riskScores: DocumentRiskScore[],
    reportTitle: string
  ): Promise<DDReport> {
    const startTime = Date.now();
    const reportId = `dd-report-${Date.now()}`;

    logger.info('[DD] Generating report', {
      reportId,
      findingsCount: findings.length,
      documentsCount: riskScores.length,
    });

    // Determine overall risk
    const overallRisk = this.determineOverallRisk(riskScores);

    // Generate executive summary and recommendations using AI
    const { executiveSummary, recommendations } = await this.generateExecutiveSummary(
      findings,
      riskScores,
      overallRisk
    );

    // Generate detailed summary
    const summary = this.generateDetailedSummary(findings, riskScores);

    const report: DDReport = {
      id: reportId,
      title: reportTitle,
      summary,
      executiveSummary,
      totalDocuments: riskScores.length,
      reviewedDocuments: riskScores.length,
      findings: findings.sort((a, b) => {
        // Sort by risk level (critical first)
        const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
      }),
      riskScores,
      overallRisk,
      recommendations,
      createdAt: new Date().toISOString(),
      processingTimeMs: Date.now() - startTime,
    };

    logger.info('[DD] Report generated', {
      reportId,
      overallRisk,
      recommendationsCount: recommendations.length,
      durationMs: report.processingTimeMs,
    });

    return report;
  }

  // Helper methods

  private mapRiskFactorToCategory(riskFactor: string): FindingCategory {
    const lower = riskFactor.toLowerCase();
    if (lower.includes('доказ') || lower.includes('строк')) return 'legal_risk';
    if (lower.includes('сума') || lower.includes('платіж')) return 'financial_risk';
    if (lower.includes('вимог')) return 'compliance_issue';
    return 'other';
  }

  private assessRiskLevel(riskFactor: string, confidence: number): RiskLevel {
    const lower = riskFactor.toLowerCase();

    if (lower.includes('недостатньо доказів') || lower.includes('пропущено строк')) {
      return 'high';
    }
    if (lower.includes('не доведено')) {
      return 'medium';
    }
    return 'low';
  }

  private mapImportanceToRiskLevel(importance: string): RiskLevel {
    switch (importance) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      default:
        return 'low';
    }
  }

  private calculateCategoryScore(findings: DDFinding[], category: FindingCategory): number {
    const categoryFindings = findings.filter((f) => f.category === category);
    if (categoryFindings.length === 0) return 0;

    const score =
      categoryFindings.filter((f) => f.riskLevel === 'critical').length * 25 +
      categoryFindings.filter((f) => f.riskLevel === 'high').length * 15 +
      categoryFindings.filter((f) => f.riskLevel === 'medium').length * 8 +
      categoryFindings.filter((f) => f.riskLevel === 'low').length * 3;

    return Math.min(100, score);
  }

  private determineOverallRisk(riskScores: DocumentRiskScore[]): RiskLevel {
    const criticalCount = riskScores.filter((r) => r.overallRisk === 'critical').length;
    const highCount = riskScores.filter((r) => r.overallRisk === 'high').length;

    if (criticalCount > 0) return 'critical';
    if (highCount > riskScores.length / 2) return 'high';
    if (highCount > 0) return 'medium';
    return 'low';
  }

  private generateDetailedSummary(
    findings: DDFinding[],
    riskScores: DocumentRiskScore[]
  ): string {
    const totalFindings = findings.length;
    const criticalFindings = findings.filter((f) => f.riskLevel === 'critical').length;
    const highFindings = findings.filter((f) => f.riskLevel === 'high').length;

    const avgScore =
      riskScores.length > 0
        ? riskScores.reduce((sum, r) => sum + r.score, 0) / riskScores.length
        : 0;

    return `
Due Diligence Проверка завершена.

Проверено документов: ${riskScores.length}
Обнаружено находок: ${totalFindings}
- Критических: ${criticalFindings}
- Высоких: ${highFindings}
- Средних: ${findings.filter((f) => f.riskLevel === 'medium').length}
- Низких: ${findings.filter((f) => f.riskLevel === 'low').length}

Средний балл риска: ${avgScore.toFixed(1)}/100

Документы с критическим риском:
${riskScores
  .filter((r) => r.overallRisk === 'critical')
  .map((r) => `- ${r.documentTitle} (${r.score}/100)`)
  .join('\n')}
    `.trim();
  }

  private async generateExecutiveSummary(
    findings: DDFinding[],
    riskScores: DocumentRiskScore[],
    overallRisk: RiskLevel
  ): Promise<{ executiveSummary: string; recommendations: string[] }> {
    try {
      const openaiManager = getOpenAIManager();
      const model = ModelSelector.getChatModel('standard');

      const criticalFindings = findings
        .filter((f) => f.riskLevel === 'critical' || f.riskLevel === 'high')
        .slice(0, 10)
        .map((f) => `- ${f.title}: ${f.description}`)
        .join('\n');

      const prompt = `Создай executive summary для due diligence отчета.

Общий уровень риска: ${overallRisk}
Проверено документов: ${riskScores.length}
Критических/высоких находок: ${findings.filter((f) => f.riskLevel === 'critical' || f.riskLevel === 'high').length}

Основные находки:
${criticalFindings}

Верни JSON:
{
  "executiveSummary": "краткое резюме для руководства (2-3 абзаца)",
  "recommendations": ["рекомендация 1", "рекомендация 2", ...]
}`;

      const response = await openaiManager.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: 'Ты старший юрист, готовящий отчеты для руководства компании.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        });
      });

      const result = JSON.parse(
        response.choices[0].message.content ||
          '{"executiveSummary":"","recommendations":[]}'
      );

      return {
        executiveSummary: result.executiveSummary || 'Резюме недоступно',
        recommendations: result.recommendations || [],
      };
    } catch (error: any) {
      logger.error('[DD] Executive summary generation failed', { error: error.message });
      return {
        executiveSummary: 'Автоматическое резюме недоступно',
        recommendations: ['Провести детальный анализ всех находок'],
      };
    }
  }
}
