import { Database } from '../database/database.js';
import { EmbeddingService } from './embedding-service.js';
import { LegalPattern, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export class LegalPatternStore {
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService
  ) {}

  async extractPatterns(
    caseIds: string[],
    intent: string
  ): Promise<LegalPattern | null> {
    // Get cases from database
    const cases = await this.db.query(
      `SELECT d.*, ds.section_type, ds.text 
       FROM documents d
       JOIN document_sections ds ON d.id = ds.document_id
       WHERE d.id = ANY($1::uuid[]) AND ds.section_type = $2`,
      [caseIds, SectionType.COURT_REASONING]
    );

    if (cases.rows.length < 3) {
      logger.warn('Not enough cases for pattern extraction');
      return null;
    }

    // Extract common elements
    const lawArticles = this.extractCommonLawArticles(cases.rows);
    const outcomes = this.extractOutcomes(cases.rows);
    const riskFactors = this.extractRiskFactors(cases.rows);
    const successArguments = this.extractSuccessArguments(cases.rows);

    // Generate average embedding for court reasoning
    const reasoningTexts = cases.rows.map((r: any) => r.text);
    const embeddings = await this.embeddingService.generateEmbeddingsBatch(reasoningTexts);
    const avgEmbedding = this.averageEmbedding(embeddings);

    // Extract anti-patterns (negative patterns)
    const antiPatterns = await this.extractAntiPatterns(cases.rows);

    const pattern: LegalPattern = {
      id: uuidv4(),
      intent,
      law_articles: lawArticles,
      court_reasoning_vector: avgEmbedding,
      decision_outcome: this.determineOutcome(outcomes),
      frequency: cases.rows.length,
      confidence: this.calculatePatternConfidence(cases.rows),
      example_cases: caseIds,
      risk_factors: riskFactors,
      success_arguments: successArguments,
      anti_patterns: antiPatterns,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return pattern;
  }

  async savePattern(pattern: LegalPattern): Promise<void> {
    await this.db.query(
      `INSERT INTO legal_patterns (
        id, intent, law_articles, decision_outcome, frequency, 
        confidence, example_cases, risk_factors, success_arguments, 
        anti_patterns, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        frequency = EXCLUDED.frequency,
        confidence = EXCLUDED.confidence,
        example_cases = EXCLUDED.example_cases,
        risk_factors = EXCLUDED.risk_factors,
        success_arguments = EXCLUDED.success_arguments,
        anti_patterns = EXCLUDED.anti_patterns,
        updated_at = EXCLUDED.updated_at`,
      [
        pattern.id,
        pattern.intent,
        pattern.law_articles,
        pattern.decision_outcome,
        pattern.frequency,
        pattern.confidence,
        pattern.example_cases,
        pattern.risk_factors,
        pattern.success_arguments,
        JSON.stringify(pattern.anti_patterns || []),
        pattern.created_at,
        pattern.updated_at,
      ]
    );
  }

  async findPatterns(
    intent: string,
    minConfidence: number = 0.6
  ): Promise<LegalPattern[]> {
    const result = await this.db.query(
      `SELECT * FROM legal_patterns 
       WHERE intent = $1 AND confidence >= $2
       ORDER BY frequency DESC, confidence DESC`,
      [intent, minConfidence]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      intent: row.intent,
      law_articles: row.law_articles || [],
      decision_outcome: row.decision_outcome,
      frequency: row.frequency,
      confidence: row.confidence,
      example_cases: row.example_cases || [],
      risk_factors: row.risk_factors || [],
      success_arguments: row.success_arguments || [],
      anti_patterns: row.anti_patterns || [],
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }));
  }

  async matchPatterns(
    queryEmbedding: number[],
    intent: string
  ): Promise<LegalPattern[]> {
    const patterns = await this.findPatterns(intent);

    // Calculate similarity with query embedding
    const patternsWithSimilarity = await Promise.all(
      patterns.map(async (pattern) => {
        if (!pattern.court_reasoning_vector) {
          return { pattern, similarity: 0 };
        }

        const similarity = this.cosineSimilarity(
          queryEmbedding,
          pattern.court_reasoning_vector
        );

        return { pattern, similarity };
      })
    );

    return patternsWithSimilarity
      .filter((p) => p.similarity > 0.7)
      .sort((a, b) => b.similarity - a.similarity)
      .map((p) => p.pattern);
  }

  private extractCommonLawArticles(rows: any[]): string[] {
    const articleCounts = new Map<string, number>();
    
    for (const row of rows) {
      const text = row.text || '';
      const articleMatches = text.match(/ст\.\s*\d+/gi);
      if (articleMatches) {
        for (const match of articleMatches) {
          articleCounts.set(match, (articleCounts.get(match) || 0) + 1);
        }
      }
    }

    // Return articles that appear in at least 30% of cases
    const threshold = Math.ceil(rows.length * 0.3);
    return Array.from(articleCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([article, _]) => article);
  }

  private extractOutcomes(rows: any[]): string[] {
    return rows.map((row: any) => {
      const text = (row.text || '').toLowerCase();
      if (text.includes('задоволено') || text.includes('позивач виграв')) {
        return 'consumer_won';
      } else if (text.includes('відмовлено') || text.includes('відхилено')) {
        return 'rejected';
      } else if (text.includes('частково')) {
        return 'partial';
      }
      return 'unknown';
    });
  }

  private determineOutcome(outcomes: string[]): 'consumer_won' | 'seller_won' | 'partial' | 'rejected' {
    const counts = new Map<string, number>();
    for (const outcome of outcomes) {
      counts.set(outcome, (counts.get(outcome) || 0) + 1);
    }

    const maxCount = Math.max(...Array.from(counts.values()));
    const mostCommon = Array.from(counts.entries()).find(
      ([_, count]) => count === maxCount
    )?.[0];

    if (mostCommon === 'consumer_won') return 'consumer_won';
    if (mostCommon === 'rejected') return 'rejected';
    if (mostCommon === 'partial') return 'partial';
    return 'rejected';
  }

  private extractRiskFactors(rows: any[]): string[] {
    const riskKeywords = [
      'недостатньо доказів',
      'не доведено',
      'пропущено строк',
      'не відповідає',
    ];

    const foundRisks: string[] = [];
    for (const row of rows) {
      const text = (row.text || '').toLowerCase();
      for (const keyword of riskKeywords) {
        if (text.includes(keyword) && !foundRisks.includes(keyword)) {
          foundRisks.push(keyword);
        }
      }
    }

    return foundRisks;
  }

  private extractSuccessArguments(rows: any[]): string[] {
    const successKeywords = [
      'доведено',
      'підтверджено',
      'відповідає вимогам',
      'має право',
    ];

    const foundArgs: string[] = [];
    for (const row of rows) {
      const text = (row.text || '').toLowerCase();
      for (const keyword of successKeywords) {
        if (text.includes(keyword) && !foundArgs.includes(keyword)) {
          foundArgs.push(keyword);
        }
      }
    }

    return foundArgs;
  }

  private async extractAntiPatterns(rows: any[]): Promise<any[]> {
    // Find cases with negative outcomes
    const negativeCases = rows.filter((row: any) => {
      const text = (row.text || '').toLowerCase();
      return text.includes('відмовлено') || text.includes('відхилено');
    });

    if (negativeCases.length === 0) {
      return [];
    }

    // Extract common reasons for failure
    const failureReasons: string[] = [];
    for (const row of negativeCases) {
      const text = row.text || '';
      if (text.includes('недостатньо')) {
        failureReasons.push('Недостатньо доказів');
      }
      if (text.includes('пропущено')) {
        failureReasons.push('Пропущено строк позовної давності');
      }
      if (text.includes('не відповідає')) {
        failureReasons.push('Не відповідає вимогам закону');
      }
    }

    return [
      {
        description: 'Спільні причини відмови',
        why_fails: failureReasons.join('; '),
        example_cases: negativeCases.map((r: any) => r.document_id),
      },
    ];
  }

  private calculatePatternConfidence(rows: any[]): number {
    if (rows.length < 3) return 0.3;
    if (rows.length < 5) return 0.5;
    if (rows.length < 10) return 0.7;
    return 0.9;
  }

  private averageEmbedding(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];
    
    const dimension = embeddings[0].length;
    const avg = new Array(dimension).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < dimension; i++) {
        avg[i] += embedding[i];
      }
    }

    return avg.map((sum) => sum / embeddings.length);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
