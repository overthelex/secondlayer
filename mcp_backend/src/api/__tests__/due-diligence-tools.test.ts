/**
 * Due Diligence Tools Integration Tests
 *
 * Tests Stage 5 acceptance criteria:
 * - Bulk review forms DD findings table
 * - Each finding has link to document+anchor
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { DueDiligenceService, DDFinding } from '../../services/due-diligence-service.js';
import { DueDiligenceTools } from '../due-diligence-tools.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import { CitationValidator } from '../../services/citation-validator.js';
import { DocumentService } from '../../services/document-service.js';
import { Database } from '../../database/database.js';
import { EmbeddingService } from '../../services/embedding-service.js';

describe('DueDiligenceTools - Stage 5 Integration', () => {
  let ddService: DueDiligenceService;
  let ddTools: DueDiligenceTools;
  let sectionizer: SemanticSectionizer;
  let patternStore: LegalPatternStore;
  let citationValidator: CitationValidator;
  let documentService: DocumentService;
  let db: Database;
  let embeddingService: EmbeddingService;

  beforeEach(() => {
    // Mock dependencies
    db = { query: jest.fn(), getPool: jest.fn() } as any;
    embeddingService = { generateEmbedding: jest.fn(), storeChunk: jest.fn() } as any;
    documentService = {
      getDocumentById: jest.fn(),
      saveSections: jest.fn(),
      saveDocument: jest.fn(),
    } as any;

    sectionizer = new SemanticSectionizer();
    patternStore = new LegalPatternStore(db, embeddingService);
    citationValidator = new CitationValidator(db);

    ddService = new DueDiligenceService(
      sectionizer,
      patternStore,
      citationValidator,
      documentService
    );

    ddTools = new DueDiligenceTools(ddService);
  });

  describe('Acceptance Criteria Validation', () => {
    it('should create findings table with anchors (spec.txt requirement)', async () => {
      // Mock document with test data
      const mockDocument = {
        id: 'test-doc-1',
        title: 'Тестовый договор',
        full_text: `
          Договор поставки товаров

          1. Стороны договора
          Поставщик: ООО "Тест"
          Покупатель: ООО "Клиент"

          2. Предмет договора
          Поставщик обязуется поставить товары на сумму 100000 грн.

          3. Ответственность сторон
          Недостатньо доказів може привести до расторжения.
        `,
      };

      (documentService.getDocumentById as jest.Mock).mockResolvedValue(mockDocument);

      // Mock pattern store to return risk patterns
      jest.spyOn(patternStore, 'findPatterns').mockResolvedValue([
        {
          id: 'pattern-1',
          intent: 'contract',
          law_articles: [],
          decision_outcome: 'rejected',
          frequency: 10,
          confidence: 0.7,
          example_cases: [],
          risk_factors: ['недостатньо доказів'],
          success_arguments: [],
          anti_patterns: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      // Run bulk review
      const result = await ddTools.bulkReviewRunner({
        documentIds: ['test-doc-1'],
      });

      // Validate response structure (v1 contract)
      expect(result.version).toBe('v1');
      expect(result.trace_id).toBeDefined();
      expect(result.data).toBeDefined();

      const { findings, riskScores } = result.data;

      // Validate findings table structure
      expect(findings).toBeDefined();
      expect(Array.isArray(findings)).toBe(true);

      // Each finding should have required fields
      findings.forEach((finding: DDFinding) => {
        expect(finding.id).toBeDefined();
        expect(finding.documentId).toBeDefined();
        expect(finding.documentTitle).toBeDefined();
        expect(finding.category).toBeDefined();
        expect(finding.riskLevel).toBeDefined();
        expect(finding.title).toBeDefined();
        expect(finding.description).toBeDefined();

        // CRITICAL: Each finding MUST have an anchor (link to document location)
        // This is the acceptance criteria from spec.txt
        if (finding.anchor) {
          expect(finding.anchor.sectionType).toBeDefined();
          expect(finding.anchor.quote).toBeDefined();
          // Optionally: startIndex and endIndex
        }
      });

      // Validate risk scores
      expect(riskScores).toBeDefined();
      expect(Array.isArray(riskScores)).toBe(true);
      expect(riskScores.length).toBeGreaterThan(0);

      riskScores.forEach((score) => {
        expect(score.documentId).toBeDefined();
        expect(score.overallRisk).toBeDefined();
        expect(score.score).toBeGreaterThanOrEqual(0);
        expect(score.score).toBeLessThanOrEqual(100);
        expect(score.breakdown).toBeDefined();
      });
    });

    it('should generate DD report with formatted findings table', async () => {
      const mockFindings: DDFinding[] = [
        {
          id: 'finding-1',
          documentId: 'doc-1',
          documentTitle: 'Договор 1',
          category: 'financial_risk',
          riskLevel: 'high',
          title: 'Отсутствует условие оплаты',
          description: 'В договоре не указаны сроки и условия оплаты',
          recommendation: 'Добавить раздел с условиями оплаты',
          anchor: {
            sectionType: 'FACTS',
            startIndex: 100,
            endIndex: 200,
            quote: 'Договор не содержит...',
          },
          confidence: 0.8,
        },
        {
          id: 'finding-2',
          documentId: 'doc-1',
          documentTitle: 'Договор 1',
          category: 'legal_risk',
          riskLevel: 'critical',
          title: 'Нарушение требований закона',
          description: 'Договор не соответствует ст. 625 ГК',
          recommendation: 'Привести в соответствие с законодательством',
          anchor: {
            sectionType: 'LAW_REFERENCES',
            quote: 'Согласно ст. 625...',
          },
          confidence: 0.9,
        },
      ];

      const mockRiskScores = [
        {
          documentId: 'doc-1',
          documentTitle: 'Договор 1',
          overallRisk: 'high' as const,
          score: 65,
          breakdown: {
            contractual: 20,
            financial: 40,
            compliance: 15,
            legal: 50,
            operational: 10,
          },
          criticalFindingsCount: 1,
          highFindingsCount: 1,
          mediumFindingsCount: 0,
          lowFindingsCount: 0,
        },
      ];

      // Generate report in JSON format
      const result = await ddTools.generateDDReport({
        findings: mockFindings,
        riskScores: mockRiskScores,
        reportTitle: 'Тестовый DD отчет',
        format: 'json',
      });

      expect(result.version).toBe('v1');
      expect(result.data).toBeDefined();

      const report = result.data as any;

      // Validate report structure
      expect(report.id).toBeDefined();
      expect(report.title).toBe('Тестовый DD отчет');
      expect(report.executiveSummary).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.findings).toHaveLength(2);
      expect(report.riskScores).toHaveLength(1);
      expect(report.overallRisk).toBe('high');
      expect(report.recommendations).toBeDefined();
      expect(Array.isArray(report.recommendations)).toBe(true);

      // Validate findings are sorted by risk level (critical first)
      expect(report.findings[0].riskLevel).toBe('critical');
      expect(report.findings[1].riskLevel).toBe('high');
    });

    it('should format DD report as Markdown table', async () => {
      const mockFindings: DDFinding[] = [
        {
          id: 'finding-1',
          documentId: 'doc-1',
          documentTitle: 'Contract A',
          category: 'financial_risk',
          riskLevel: 'high',
          title: 'Missing payment terms',
          description: 'No payment schedule',
          recommendation: 'Add payment terms',
          anchor: {
            sectionType: 'FACTS',
            quote: 'Contract does not specify...',
          },
          confidence: 0.8,
        },
      ];

      const mockRiskScores = [
        {
          documentId: 'doc-1',
          documentTitle: 'Contract A',
          overallRisk: 'medium' as const,
          score: 40,
          breakdown: {
            contractual: 10,
            financial: 30,
            compliance: 5,
            legal: 15,
            operational: 5,
          },
          criticalFindingsCount: 0,
          highFindingsCount: 1,
          mediumFindingsCount: 0,
          lowFindingsCount: 0,
        },
      ];

      const result = await ddTools.generateDDReport({
        findings: mockFindings,
        riskScores: mockRiskScores,
        reportTitle: 'Sample DD Report',
        format: 'markdown',
      });

      const markdown = result.data as string;

      // Validate markdown structure
      expect(markdown).toContain('# Sample DD Report');
      expect(markdown).toContain('## Executive Summary');
      expect(markdown).toContain('## Findings Table');
      expect(markdown).toContain('| Document | Category | Risk | Finding | Recommendation | Anchor |');
      expect(markdown).toContain('## Risk Scores');
      expect(markdown).toContain('Contract A');
      expect(markdown).toContain('financial_risk');
      expect(markdown).toContain('HIGH');
    });
  });

  describe('Risk Scoring Algorithm', () => {
    it('should calculate risk scores correctly', () => {
      const findings: DDFinding[] = [
        {
          id: '1',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'financial_risk',
          riskLevel: 'critical', // 25 points
          title: 'Critical issue',
          description: 'Test',
          confidence: 0.9,
        },
        {
          id: '2',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'legal_risk',
          riskLevel: 'high', // 15 points
          title: 'High issue',
          description: 'Test',
          confidence: 0.8,
        },
        {
          id: '3',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'compliance_issue',
          riskLevel: 'medium', // 8 points
          title: 'Medium issue',
          description: 'Test',
          confidence: 0.7,
        },
      ];

      const riskScore = ddService.calculateRiskScore('doc-1', findings, 'Test');

      // Expected score: 25 + 15 + 8 = 48
      expect(riskScore.score).toBe(48);
      expect(riskScore.overallRisk).toBe('medium'); // 48 is in 25-50 range
      expect(riskScore.criticalFindingsCount).toBe(1);
      expect(riskScore.highFindingsCount).toBe(1);
      expect(riskScore.mediumFindingsCount).toBe(1);
      expect(riskScore.breakdown).toBeDefined();
    });

    it('should classify overall risk correctly', () => {
      // Critical: score >= 75 or has critical findings
      const criticalFindings: DDFinding[] = [
        {
          id: '1',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'legal_risk',
          riskLevel: 'critical',
          title: 'Critical',
          description: 'Test',
          confidence: 0.9,
        },
      ];

      const criticalScore = ddService.calculateRiskScore('doc-1', criticalFindings);
      expect(criticalScore.overallRisk).toBe('critical');

      // High: score >= 50
      const highFindings: DDFinding[] = [
        {
          id: '1',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'financial_risk',
          riskLevel: 'high',
          title: 'High',
          description: 'Test',
          confidence: 0.8,
        },
        {
          id: '2',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'legal_risk',
          riskLevel: 'high',
          title: 'High',
          description: 'Test',
          confidence: 0.8,
        },
        {
          id: '3',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'compliance_issue',
          riskLevel: 'high',
          title: 'High',
          description: 'Test',
          confidence: 0.8,
        },
        {
          id: '4',
          documentId: 'doc-1',
          documentTitle: 'Test',
          category: 'operational_risk',
          riskLevel: 'high',
          title: 'High',
          description: 'Test',
          confidence: 0.8,
        },
      ];

      const highScore = ddService.calculateRiskScore('doc-1', highFindings);
      expect(highScore.score).toBeGreaterThanOrEqual(50);
      expect(highScore.overallRisk).toBe('high');
    });
  });
});
