/**
 * @fileoverview Legal Pattern Store Service
 *
 * This service is responsible for extracting, storing, and matching legal reasoning
 * patterns from Ukrainian court decisions. It analyzes collections of similar court
 * cases to identify recurring patterns in judicial reasoning, common law article
 * citations, risk factors, and success arguments.
 *
 * ## Key Concepts
 *
 * **Legal Patterns**: Aggregated insights extracted from multiple court cases that
 * share similar legal intent (e.g., "consumer protection", "contract dispute").
 * Patterns include:
 * - Frequently cited law articles
 * - Common decision outcomes (won/lost/partial)
 * - Risk factors that correlate with negative outcomes
 * - Success arguments that correlate with positive outcomes
 * - Anti-patterns (common reasons for case rejection)
 *
 * **Pattern Matching**: Uses cosine similarity between vector embeddings of court
 * reasoning sections to find patterns relevant to a new legal query.
 *
 * ## Algorithm Overview
 *
 * 1. **Pattern Extraction** (`extractPatterns`):
 *    - Fetches court reasoning sections from specified cases
 *    - Identifies law articles appearing in ≥30% of cases
 *    - Classifies outcomes using Ukrainian legal keywords
 *    - Extracts risk factors and success arguments via keyword matching
 *    - Generates an average embedding vector from all reasoning texts
 *    - Assigns confidence score based on sample size
 *
 * 2. **Pattern Matching** (`matchPatterns`):
 *    - Retrieves stored patterns for a given intent
 *    - Computes cosine similarity between query embedding and pattern vectors
 *    - Returns patterns with similarity > 0.7 (70% threshold)
 *
 * ## Confidence Scoring
 *
 * Pattern confidence is determined by sample size:
 * - 3-4 cases: 0.3 (low confidence)
 * - 5-9 cases: 0.5 (moderate confidence)
 * - 10-19 cases: 0.7 (good confidence)
 * - 20+ cases: 0.9 (high confidence)
 *
 * ## Dependencies
 *
 * - **Database**: PostgreSQL for pattern persistence
 * - **EmbeddingService**: OpenAI embeddings for vector similarity search
 * - **Qdrant**: Vector storage for semantic search (via EmbeddingService)
 *
 * @module services/legal-pattern-store
 * @see {@link LegalPattern} for the pattern data structure
 * @see {@link EmbeddingService} for embedding generation
 */

import { Database } from '../database/database.js';
import { EmbeddingService } from './embedding-service.js';
import { LegalPattern, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Threshold for law article frequency filter.
 * Articles must appear in at least this percentage of cases to be considered "common".
 * Set to 30% to balance between catching frequent citations and filtering noise.
 */
const LAW_ARTICLE_FREQUENCY_THRESHOLD = 0.3;

/**
 * Minimum cosine similarity score for pattern matching.
 * Patterns with similarity below this threshold are filtered out.
 * Set to 0.7 (70%) based on empirical testing with Ukrainian court documents.
 */
const PATTERN_SIMILARITY_THRESHOLD = 0.7;

/**
 * Minimum number of cases required for pattern extraction.
 * Extracting patterns from fewer cases produces unreliable results.
 * @see {@link CONFIDENCE_TIERS.LOW.min} - Uses same value for consistency
 */

/**
 * Confidence score tiers based on number of cases.
 * More cases = higher confidence in the extracted pattern.
 */
const CONFIDENCE_TIERS = {
  /** 3-4 cases: low confidence, pattern may be coincidental */
  LOW: { min: 3, max: 4, score: 0.3 },
  /** 5-9 cases: moderate confidence, emerging pattern */
  MODERATE: { min: 5, max: 9, score: 0.5 },
  /** 10-19 cases: good confidence, established pattern */
  GOOD: { min: 10, max: 19, score: 0.7 },
  /** 20+ cases: high confidence, well-established pattern */
  HIGH: { min: 20, max: Infinity, score: 0.9 },
} as const;

/**
 * Ukrainian legal keywords indicating negative case outcomes (rejection/loss).
 * Used to identify cases where the plaintiff's claims were denied.
 */
const NEGATIVE_OUTCOME_KEYWORDS = ['відмовлено', 'відхилено'] as const;

/**
 * Ukrainian legal keywords indicating positive case outcomes (claim granted).
 * Used to identify cases where the plaintiff (typically consumer) won.
 * @see {@link extractOutcomes} - Uses these keywords for classification
 */
const POSITIVE_OUTCOME_KEYWORDS = ['задоволено', 'позивач виграв'] as const;

/**
 * Ukrainian legal keyword indicating partial satisfaction of claims.
 * @see {@link extractOutcomes} - Uses this keyword for classification
 */
const PARTIAL_OUTCOME_KEYWORD = 'частково' as const;

/**
 * Risk factor keywords (Ukrainian) that correlate with case rejection.
 * These phrases commonly appear in judicial reasoning when denying claims.
 */
const RISK_FACTOR_KEYWORDS = [
  'недостатньо доказів',  // Insufficient evidence
  'не доведено',          // Not proven
  'пропущено строк',      // Missed deadline (statute of limitations)
  'не відповідає',        // Does not comply
] as const;

/**
 * Success argument keywords (Ukrainian) that correlate with case approval.
 * These phrases commonly appear in judicial reasoning when granting claims.
 */
const SUCCESS_ARGUMENT_KEYWORDS = [
  'доведено',             // Proven
  'підтверджено',         // Confirmed
  'відповідає вимогам',   // Meets requirements
  'має право',            // Has the right
] as const;

/**
 * Failure reason mappings for anti-pattern extraction.
 * Maps Ukrainian keywords to human-readable failure descriptions.
 */
const FAILURE_REASON_MAPPINGS: ReadonlyArray<{ keyword: string; reason: string }> = [
  { keyword: 'недостатньо', reason: 'Недостатньо доказів' },              // Insufficient evidence
  { keyword: 'пропущено', reason: 'Пропущено строк позовної давності' },  // Missed statute of limitations
  { keyword: 'не відповідає', reason: 'Не відповідає вимогам закону' },   // Does not meet legal requirements
] as const;

/**
 * Service for extracting, storing, and matching legal reasoning patterns.
 *
 * This class provides the core functionality for pattern-based legal analysis,
 * helping identify recurring patterns in court decisions that can be used to:
 * - Predict case outcomes
 * - Identify risk factors in legal arguments
 * - Find successful argumentation strategies
 * - Detect common reasons for case rejection
 *
 * @example
 * ```typescript
 * // Initialize the service
 * const patternStore = new LegalPatternStore(database, embeddingService);
 *
 * // Extract patterns from a set of similar cases
 * const pattern = await patternStore.extractPatterns(
 *   ['case-id-1', 'case-id-2', 'case-id-3'],
 *   'consumer_protection'
 * );
 *
 * // Save the pattern for future matching
 * if (pattern) {
 *   await patternStore.savePattern(pattern);
 * }
 *
 * // Match a new query against stored patterns
 * const queryEmbedding = await embeddingService.generateEmbedding('my legal query');
 * const matchingPatterns = await patternStore.matchPatterns(
 *   queryEmbedding,
 *   'consumer_protection'
 * );
 * ```
 */
export class LegalPatternStore {
  /**
   * Creates a new LegalPatternStore instance.
   *
   * @param db - Database connection for pattern persistence
   * @param embeddingService - Service for generating and searching vector embeddings
   */
  constructor(
    private db: Database,
    private embeddingService: EmbeddingService
  ) {}

  /**
   * Extracts a legal pattern from a collection of court cases.
   *
   * This method analyzes the court reasoning sections of multiple cases to identify
   * recurring elements that form a legal pattern. The extraction process:
   *
   * 1. Fetches court reasoning (COURT_REASONING section) from all specified cases
   * 2. Validates minimum case count (≥3 cases required)
   * 3. Extracts common law article citations (appearing in ≥30% of cases)
   * 4. Classifies case outcomes (won/lost/partial/rejected)
   * 5. Identifies risk factors and success arguments via keyword matching
   * 6. Generates an average embedding vector representing the pattern's semantic content
   * 7. Extracts anti-patterns from cases with negative outcomes
   * 8. Calculates confidence score based on sample size
   *
   * @param caseIds - Array of document UUIDs to analyze. Must contain at least 3 cases.
   * @param intent - Legal intent category (e.g., "consumer_protection", "contract_dispute").
   *                 Used to categorize and later retrieve the pattern.
   *
   * @returns A complete LegalPattern object if extraction succeeds, or null if:
   *          - Fewer than 3 cases have court reasoning sections
   *          - Database query fails
   *
   * @example
   * ```typescript
   * // Extract pattern from consumer protection cases
   * const pattern = await patternStore.extractPatterns(
   *   [
   *     '550e8400-e29b-41d4-a716-446655440001',
   *     '550e8400-e29b-41d4-a716-446655440002',
   *     '550e8400-e29b-41d4-a716-446655440003',
   *   ],
   *   'consumer_protection'
   * );
   *
   * if (pattern) {
   *   console.log(`Pattern confidence: ${pattern.confidence}`);
   *   console.log(`Common law articles: ${pattern.law_articles.join(', ')}`);
   *   console.log(`Risk factors: ${pattern.risk_factors.join(', ')}`);
   * }
   * ```
   *
   * @throws May throw database errors if connection fails
   */
  async extractPatterns(
    caseIds: string[],
    intent: string
  ): Promise<LegalPattern | null> {
    // Fetch court reasoning sections from the database
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

  /**
   * Persists a legal pattern to the database.
   *
   * Uses PostgreSQL's UPSERT (ON CONFLICT DO UPDATE) to handle both new patterns
   * and updates to existing patterns. When updating, the following fields are refreshed:
   * - frequency, confidence, example_cases
   * - risk_factors, success_arguments, anti_patterns
   * - updated_at timestamp
   *
   * Note: The pattern's embedding vector (court_reasoning_vector) is NOT stored in
   * PostgreSQL due to size constraints. Vector storage is handled separately by Qdrant.
   *
   * @param pattern - The LegalPattern object to save. Must have a valid UUID in the `id` field.
   *
   * @example
   * ```typescript
   * const pattern = await patternStore.extractPatterns(caseIds, 'consumer_protection');
   * if (pattern) {
   *   await patternStore.savePattern(pattern);
   *   console.log(`Pattern ${pattern.id} saved successfully`);
   * }
   * ```
   *
   * @throws Database errors if the connection fails or constraints are violated
   */
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

  /**
   * Retrieves stored legal patterns for a given intent category.
   *
   * Queries the database for patterns matching the specified intent with confidence
   * above the minimum threshold. Results are sorted by:
   * 1. Frequency (descending) - patterns from more cases are more reliable
   * 2. Confidence (descending) - higher confidence patterns first
   *
   * @param intent - Legal intent category to search for (e.g., "consumer_protection")
   * @param minConfidence - Minimum confidence threshold (0.0 to 1.0). Default: 0.6
   *                        Patterns below this confidence are excluded from results.
   *
   * @returns Array of LegalPattern objects matching the criteria, sorted by relevance.
   *          Returns empty array if no patterns match.
   *
   * @example
   * ```typescript
   * // Find high-confidence patterns for contract disputes
   * const patterns = await patternStore.findPatterns('contract_dispute', 0.7);
   *
   * for (const pattern of patterns) {
   *   console.log(`Pattern: ${pattern.id}`);
   *   console.log(`  Frequency: ${pattern.frequency} cases`);
   *   console.log(`  Confidence: ${(pattern.confidence * 100).toFixed(0)}%`);
   *   console.log(`  Outcome: ${pattern.decision_outcome}`);
   * }
   * ```
   */
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

  /**
   * Finds patterns that semantically match a query embedding.
   *
   * This method performs semantic pattern matching using cosine similarity between
   * the query embedding and stored pattern embeddings. The matching process:
   *
   * 1. Retrieves all patterns for the specified intent (with default confidence ≥0.6)
   * 2. Computes cosine similarity between query and each pattern's embedding
   * 3. Filters patterns with similarity > 0.7 (70% threshold)
   * 4. Sorts results by similarity (highest first)
   *
   * The 0.7 similarity threshold was chosen based on empirical testing with Ukrainian
   * court documents to balance precision (avoiding false positives) and recall
   * (finding relevant patterns).
   *
   * @param queryEmbedding - Vector embedding of the query text (1536 dimensions for OpenAI ada-002)
   * @param intent - Legal intent category to search within
   *
   * @returns Array of matching LegalPattern objects, sorted by similarity (highest first).
   *          Returns empty array if no patterns exceed the similarity threshold.
   *
   * @example
   * ```typescript
   * // Generate embedding for user's legal question
   * const queryEmbedding = await embeddingService.generateEmbedding(
   *   'Can I return a defective phone after 30 days?'
   * );
   *
   * // Find matching patterns
   * const matches = await patternStore.matchPatterns(queryEmbedding, 'consumer_protection');
   *
   * if (matches.length > 0) {
   *   const bestMatch = matches[0];
   *   console.log(`Best matching pattern: ${bestMatch.id}`);
   *   console.log(`Likely outcome: ${bestMatch.decision_outcome}`);
   *   console.log(`Risk factors to consider: ${bestMatch.risk_factors.join(', ')}`);
   * } else {
   *   console.log('No matching patterns found');
   * }
   * ```
   *
   * @see {@link cosineSimilarity} for the similarity calculation algorithm
   */
  async matchPatterns(
    queryEmbedding: number[],
    intent: string
  ): Promise<LegalPattern[]> {
    const patterns = await this.findPatterns(intent);

    // Calculate cosine similarity between query and each pattern's embedding
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
      .filter((p) => p.similarity > PATTERN_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .map((p) => p.pattern);
  }

  /**
   * Extracts law article citations that appear frequently across cases.
   *
   * Scans all case texts for Ukrainian law article citations matching the pattern
   * "ст. N" (Article N) and returns articles appearing in at least 30% of cases.
   *
   * The 30% threshold balances:
   * - High enough to filter out incidental citations
   * - Low enough to capture articles used in a significant minority of cases
   *
   * @param rows - Database rows containing case text in the `text` field
   * @returns Array of article citations (e.g., ["ст. 15", "ст. 23", "ст. 1023"])
   *
   * @example
   * // If 10 cases contain:
   * // - "ст. 15" in 8 cases (80%) → included
   * // - "ст. 23" in 4 cases (40%) → included
   * // - "ст. 99" in 2 cases (20%) → excluded (below 30%)
   *
   * @internal
   */
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
    const threshold = Math.ceil(rows.length * LAW_ARTICLE_FREQUENCY_THRESHOLD);
    return Array.from(articleCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([article, _]) => article);
  }

  /**
   * Classifies case outcomes from court reasoning text.
   *
   * Analyzes each case's text to determine the outcome using Ukrainian legal keywords:
   * - "задоволено" / "позивач виграв" → consumer_won (plaintiff won)
   * - "відмовлено" / "відхилено" → rejected (claim denied)
   * - "частково" → partial (partial satisfaction)
   * - Otherwise → unknown
   *
   * @param rows - Database rows containing case text in the `text` field
   * @returns Array of outcome strings, one per input row
   *
   * @internal
   */
  private extractOutcomes(rows: any[]): string[] {
    return rows.map((row: any) => {
      const text = (row.text || '').toLowerCase();
      // Check for positive outcome keywords
      if (POSITIVE_OUTCOME_KEYWORDS.some(keyword => text.includes(keyword))) {
        return 'consumer_won';
      }
      // Check for negative outcome keywords
      if (NEGATIVE_OUTCOME_KEYWORDS.some(keyword => text.includes(keyword))) {
        return 'rejected';
      }
      // Check for partial satisfaction
      if (text.includes(PARTIAL_OUTCOME_KEYWORD)) {
        return 'partial';
      }
      return 'unknown';
    });
  }

  /**
   * Determines the most common outcome from a list of individual case outcomes.
   *
   * Uses majority voting to determine the predominant outcome. If no clear
   * majority exists, defaults to 'rejected' as a conservative estimate.
   *
   * @param outcomes - Array of outcome strings from extractOutcomes()
   * @returns The most frequent outcome category:
   *          - 'consumer_won': Plaintiff's claims were fully granted
   *          - 'seller_won': Defendant prevailed (not currently detected)
   *          - 'partial': Claims were partially satisfied
   *          - 'rejected': Claims were denied (default fallback)
   *
   * @internal
   */
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

  /**
   * Extracts risk factors from case texts via keyword matching.
   *
   * Scans case texts for Ukrainian phrases that commonly appear when courts
   * reject claims. These risk factors help predict potential weaknesses in
   * similar future cases.
   *
   * **Risk Factor Keywords (Ukrainian → English):**
   * - "недостатньо доказів" → Insufficient evidence
   * - "не доведено" → Not proven / unsubstantiated
   * - "пропущено строк" → Missed deadline / statute of limitations
   * - "не відповідає" → Does not comply / non-conforming
   *
   * @param rows - Database rows containing case text in the `text` field
   * @returns Array of unique risk factor phrases found across all cases
   *
   * @internal
   */
  private extractRiskFactors(rows: any[]): string[] {
    const riskKeywords = RISK_FACTOR_KEYWORDS;

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

  /**
   * Extracts success arguments from case texts via keyword matching.
   *
   * Scans case texts for Ukrainian phrases that commonly appear when courts
   * grant claims. These success arguments help identify effective argumentation
   * strategies for similar future cases.
   *
   * **Success Argument Keywords (Ukrainian → English):**
   * - "доведено" → Proven / substantiated
   * - "підтверджено" → Confirmed / verified
   * - "відповідає вимогам" → Meets requirements / compliant
   * - "має право" → Has the right / entitled to
   *
   * @param rows - Database rows containing case text in the `text` field
   * @returns Array of unique success argument phrases found across all cases
   *
   * @internal
   */
  private extractSuccessArguments(rows: any[]): string[] {
    const successKeywords = SUCCESS_ARGUMENT_KEYWORDS;

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

  /**
   * Extracts anti-patterns from cases with negative outcomes.
   *
   * Anti-patterns are common reasons why claims get rejected. By identifying
   * these patterns, users can avoid making the same mistakes in their cases.
   *
   * The extraction process:
   * 1. Filters cases with negative outcomes (rejected/denied)
   * 2. Scans for common failure reason keywords
   * 3. Returns structured anti-pattern objects with descriptions
   *
   * **Detected Failure Reasons:**
   * - "Недостатньо доказів" - Insufficient evidence provided
   * - "Пропущено строк позовної давності" - Missed statute of limitations
   * - "Не відповідає вимогам закону" - Does not meet legal requirements
   *
   * @param rows - Database rows containing case text in the `text` field
   * @returns Array of anti-pattern objects, each containing:
   *          - description: Category of the anti-pattern
   *          - why_fails: Semicolon-separated list of failure reasons
   *          - example_cases: Document IDs of cases demonstrating this anti-pattern
   *
   * @internal
   */
  private async extractAntiPatterns(rows: any[]): Promise<any[]> {
    // Filter cases that were rejected or denied
    const negativeCases = rows.filter((row: any) => {
      const text = (row.text || '').toLowerCase();
      return NEGATIVE_OUTCOME_KEYWORDS.some(keyword => text.includes(keyword));
    });

    if (negativeCases.length === 0) {
      return [];
    }

    // Extract common reasons for failure using configured mappings
    const failureReasons: string[] = [];
    for (const row of negativeCases) {
      const text = row.text || '';
      for (const { keyword, reason } of FAILURE_REASON_MAPPINGS) {
        if (text.includes(keyword)) {
          failureReasons.push(reason);
        }
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

  /**
   * Calculates confidence score based on sample size.
   *
   * Confidence scoring is based on the principle that patterns derived from
   * more cases are more reliable. The scoring tiers are:
   *
   * | Sample Size | Confidence | Interpretation |
   * |-------------|------------|----------------|
   * | 3-4 cases   | 0.3 (30%)  | Low - pattern may be coincidental |
   * | 5-9 cases   | 0.5 (50%)  | Moderate - emerging pattern |
   * | 10-19 cases | 0.7 (70%)  | Good - established pattern |
   * | 20+ cases   | 0.9 (90%)  | High - well-established pattern |
   *
   * The minimum of 3 cases is required because:
   * - 1 case: No pattern, just a single data point
   * - 2 cases: Coincidence is still highly likely
   * - 3+ cases: Beginning to see meaningful patterns
   *
   * @param rows - Database rows (used to count sample size)
   * @returns Confidence score between 0.3 and 0.9
   *
   * @internal
   */
  private calculatePatternConfidence(rows: any[]): number {
    const count = rows.length;
    if (count < CONFIDENCE_TIERS.MODERATE.min) return CONFIDENCE_TIERS.LOW.score;
    if (count < CONFIDENCE_TIERS.GOOD.min) return CONFIDENCE_TIERS.MODERATE.score;
    if (count < CONFIDENCE_TIERS.HIGH.min) return CONFIDENCE_TIERS.GOOD.score;
    return CONFIDENCE_TIERS.HIGH.score;
  }

  /**
   * Computes the centroid (average) of multiple embedding vectors.
   *
   * This method creates a single representative embedding from multiple case
   * embeddings by computing element-wise averages. The resulting centroid
   * captures the "average semantic meaning" of the input texts.
   *
   * **Mathematical Operation:**
   * For N embeddings of dimension D:
   * ```
   * centroid[i] = (1/N) * Σ embedding[j][i] for j in 0..N-1
   * ```
   *
   * **Use Case:**
   * Used to create a pattern's "court_reasoning_vector" that represents the
   * typical semantic content of judicial reasoning in similar cases.
   *
   * @param embeddings - Array of embedding vectors (each 1536 dimensions for ada-002)
   * @returns Single centroid vector with same dimensions, or empty array if input is empty
   *
   * @example
   * // Given embeddings from 3 cases about consumer returns
   * const centroid = averageEmbedding([
   *   [0.1, 0.2, 0.3, ...],  // Case 1 reasoning embedding
   *   [0.15, 0.25, 0.28, ...], // Case 2 reasoning embedding
   *   [0.12, 0.18, 0.32, ...], // Case 3 reasoning embedding
   * ]);
   * // Result: [0.1233, 0.21, 0.3, ...] - element-wise average
   *
   * @internal
   */
  private averageEmbedding(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];

    const dimension = embeddings[0].length;
    const avg = new Array(dimension).fill(0);

    // Sum all embeddings element-wise
    for (const embedding of embeddings) {
      for (let i = 0; i < dimension; i++) {
        avg[i] += embedding[i];
      }
    }

    // Divide by count to get average
    return avg.map((sum) => sum / embeddings.length);
  }

  /**
   * Computes cosine similarity between two embedding vectors.
   *
   * Cosine similarity measures the cosine of the angle between two vectors,
   * providing a similarity metric independent of vector magnitude. This is
   * the standard similarity metric for text embeddings.
   *
   * **Mathematical Formula:**
   * ```
   * similarity = (A · B) / (||A|| * ||B||)
   *
   * where:
   *   A · B = Σ(a[i] * b[i])  (dot product)
   *   ||A|| = √(Σ(a[i]²))    (L2 norm)
   * ```
   *
   * **Value Interpretation:**
   * - 1.0: Identical direction (very similar semantics)
   * - 0.0: Orthogonal (unrelated content)
   * - -1.0: Opposite direction (rare with text embeddings)
   *
   * In practice, text embeddings typically show:
   * - > 0.8: Very similar content
   * - 0.6-0.8: Related content
   * - < 0.6: Weakly related or unrelated
   *
   * @param a - First embedding vector
   * @param b - Second embedding vector (must have same dimensions as `a`)
   * @returns Similarity score between -1.0 and 1.0, or 0 if dimensions don't match
   *
   * @example
   * const similarity = cosineSimilarity(
   *   await generateEmbedding("consumer protection return policy"),
   *   await generateEmbedding("buyer's right to refund defective goods")
   * );
   * // Result: ~0.85 (high similarity - related legal concepts)
   *
   * @internal
   */
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
