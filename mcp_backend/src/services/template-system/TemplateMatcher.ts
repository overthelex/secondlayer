/**
 * TemplateMatcher Service
 *
 * Matches classified questions against existing templates using semantic search
 * - Embedding-based similarity search using Qdrant vector DB
 * - Redis caching for performance (< 100ms target)
 * - Confidence scoring and threshold checking (0.65 = generate if lower)
 * - Returns top-K matches ranked by similarity
 * - Integrated with EmbeddingService for vector generation
 */

import { QuestionClassification, TemplateMatchResult } from './types.js';
import { logger, BaseDatabase } from '@secondlayer/shared';

interface CachedMatchResult {
  matches: TemplateMatchResult[];
  executionTimeMs: number;
  costUsd: number;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: {
    template_id: string;
    template_name: string;
    category: string;
    quality_score: number;
    success_rate: number;
    user_satisfaction: number;
  };
}

export class TemplateMatcher {
  private readonly MATCH_THRESHOLD = 0.65; // Generate new if score < 0.65
  private readonly TOP_K = 10; // Return top 10 matches
  private readonly CACHE_TTL = 3600; // 1 hour cache
  private readonly MIN_MATCH_SCORE = 0.5; // Minimum score to return

  constructor(
    private db: BaseDatabase,
    private embeddingService?: any,
    private qdrantClient?: any,
    private redisClient?: any
  ) {}

  /**
   * Match a classified question against existing templates
   * Uses semantic search to find most relevant templates
   */
  async matchQuestion(
    classification: QuestionClassification,
    userQuestion: string
  ): Promise<TemplateMatchResult[]> {
    const startTime = Date.now();

    try {
      // 1. Generate cache key from classification
      const cacheKey = this.generateCacheKey(classification, userQuestion);

      // 2. Check Redis cache
      const cached = await this.getCachedMatches(cacheKey);
      if (cached) {
        logger.debug('TemplateMatcher: Using cached matches', {
          intent: classification.intent,
          matchCount: cached.matches.length,
        });
        return cached.matches;
      }

      // 3. Get embedding for the question (if EmbeddingService available)
      let questionEmbedding: number[] | null = null;
      if (this.embeddingService && userQuestion) {
        questionEmbedding = await this.getQuestionEmbedding(userQuestion);
      }

      // 4. Search for matching templates
      const matches = await this.searchTemplates(
        classification,
        questionEmbedding
      );

      // 5. Cache results
      const executionTimeMs = Date.now() - startTime;
      await this.cacheMatches(cacheKey, matches, executionTimeMs);

      logger.info('TemplateMatcher: Matching complete', {
        intent: classification.intent,
        matchCount: matches.length,
        executionTimeMs,
        bestScore: matches[0]?.matchScore || 0,
      });

      return matches;
    } catch (error) {
      logger.error('TemplateMatcher: Matching failed', {
        intent: classification.intent,
        error: (error as Error).message,
      });

      // Return empty matches on error (don't crash)
      return [];
    }
  }

  /**
   * Batch match multiple questions
   */
  async matchQuestionsInBatch(
    questions: Array<{ classification: QuestionClassification; text: string }>
  ): Promise<TemplateMatchResult[][]> {
    const results = await Promise.all(
      questions.map((q) => this.matchQuestion(q.classification, q.text))
    );
    return results;
  }

  /**
   * Check if a match score indicates need for template generation
   */
  shouldGenerateTemplate(bestMatchScore: number): boolean {
    return bestMatchScore < this.MATCH_THRESHOLD;
  }

  /**
   * Get question embedding from EmbeddingService
   */
  private async getQuestionEmbedding(question: string): Promise<number[]> {
    try {
      if (!this.embeddingService) {
        return [];
      }

      const embedding = await this.embeddingService.embed(question);
      return embedding;
    } catch (error) {
      logger.warn('TemplateMatcher: Failed to get embedding', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Search for matching templates using multiple strategies
   */
  private async searchTemplates(
    classification: QuestionClassification,
    questionEmbedding: number[] | null
  ): Promise<TemplateMatchResult[]> {
    const results: Map<string, TemplateMatchResult> = new Map();

    // Strategy 1: Category-based search (fast, keyword-only)
    const categoryMatches = await this.searchByCategory(classification);
    categoryMatches.forEach((match) => {
      results.set(match.templateId, match);
    });

    // Strategy 2: Semantic search using embeddings (if available)
    if (questionEmbedding && questionEmbedding.length > 0) {
      const semanticMatches = await this.semanticSearch(
        classification,
        questionEmbedding
      );
      semanticMatches.forEach((match) => {
        // Merge with existing or add new
        if (results.has(match.templateId)) {
          const existing = results.get(match.templateId)!;
          existing.matchScore = Math.max(existing.matchScore, match.matchScore);
        } else {
          results.set(match.templateId, match);
        }
      });
    }

    // Strategy 3: Keyword-based matching (intent keywords)
    const keywordMatches = await this.keywordSearch(classification);
    keywordMatches.forEach((match) => {
      if (results.has(match.templateId)) {
        const existing = results.get(match.templateId)!;
        existing.matchScore = Math.max(existing.matchScore, match.matchScore);
      } else {
        results.set(match.templateId, match);
      }
    });

    // Convert to array, filter, and sort
    return Array.from(results.values())
      .filter((m) => m.matchScore >= this.MIN_MATCH_SCORE)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, this.TOP_K);
  }

  /**
   * Search templates by category (SQL query)
   */
  private async searchByCategory(
    classification: QuestionClassification
  ): Promise<TemplateMatchResult[]> {
    try {
      const result = await this.db.query(
        `SELECT id, name, category, intent_keywords, quality_score, success_rate, user_satisfaction
        FROM question_templates
        WHERE status = 'active'
          AND category = $1
        ORDER BY quality_score DESC, total_uses DESC
        LIMIT $2`,
        [classification.category, this.TOP_K]
      );

      return result.rows.map((row: any) => ({
        templateId: row.id,
        templateName: row.name,
        matchScore: 0.7, // Base score for category match
        qualityScore: row.quality_score,
        successRate: row.success_rate,
        userSatisfaction: row.user_satisfaction,
        reasoning: `Category match: ${classification.category}`,
        shouldGenerateNew: false,
      } as TemplateMatchResult));
    } catch (error) {
      logger.warn('TemplateMatcher: Category search failed', {
        category: classification.category,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Semantic search using Qdrant vector database
   */
  private async semanticSearch(
    classification: QuestionClassification,
    questionEmbedding: number[]
  ): Promise<TemplateMatchResult[]> {
    try {
      if (!this.qdrantClient) {
        return [];
      }

      // Query Qdrant for similar vectors
      const searchResults = await this.qdrantClient.search({
        collection_name: 'legal_templates',
        vector: questionEmbedding,
        limit: this.TOP_K,
        score_threshold: this.MIN_MATCH_SCORE,
        filter: {
          must: [
            {
              key: 'category',
              match: {
                value: classification.category,
              },
            },
          ],
        },
      });

      return searchResults.map((point: any) => ({
        templateId: point.payload.template_id,
        templateName: point.payload.template_name,
        matchScore: point.score,
        qualityScore: point.payload.quality_score,
        successRate: point.payload.success_rate,
        userSatisfaction: point.payload.user_satisfaction,
        reasoning: `Semantic match score: ${(point.score * 100).toFixed(1)}%`,
        shouldGenerateNew: point.score < this.MATCH_THRESHOLD,
      } as TemplateMatchResult));
    } catch (error) {
      logger.warn('TemplateMatcher: Semantic search failed', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Keyword-based matching using intent keywords
   */
  private async keywordSearch(
    classification: QuestionClassification
  ): Promise<TemplateMatchResult[]> {
    try {
      // Convert classification intent to keywords
      const intentKeywords = classification.keywords || [];
      if (intentKeywords.length === 0) {
        return [];
      }

      // Search for templates with matching intent keywords
      const result = await this.db.query(
        `SELECT id, name, intent_keywords, quality_score, success_rate, user_satisfaction,
                array_length(intent_keywords && $1::TEXT[], 1) as keyword_matches
        FROM question_templates
        WHERE status = 'active'
          AND category = $2
          AND intent_keywords && $1::TEXT[]
        ORDER BY keyword_matches DESC, quality_score DESC
        LIMIT $3`,
        [intentKeywords, classification.category, this.TOP_K]
      );

      return result.rows.map((row: any) => {
        const matchCount = row.keyword_matches || 1;
        const maxKeywords = Math.max(intentKeywords.length, row.intent_keywords.length);
        const matchScore = Math.min(1.0, matchCount / Math.max(maxKeywords, 2));

        return {
          templateId: row.id,
          templateName: row.name,
          matchScore,
          qualityScore: row.quality_score,
          successRate: row.success_rate,
          userSatisfaction: row.user_satisfaction,
          reasoning: `Keyword match: ${matchCount}/${maxKeywords} keywords`,
          shouldGenerateNew: matchScore < this.MATCH_THRESHOLD,
        } as TemplateMatchResult;
      });
    } catch (error) {
      logger.warn('TemplateMatcher: Keyword search failed', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Generate cache key from classification
   */
  private generateCacheKey(
    classification: QuestionClassification,
    userQuestion: string
  ): string {
    // Create deterministic key from intent + category + question hash
    const content = `${classification.intent}:${classification.category}:${userQuestion
      .toLowerCase()
      .trim()}`;
    const crypto = require('crypto');
    return `template_match:${crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')}`;
  }

  /**
   * Get cached matches from Redis
   */
  private async getCachedMatches(
    cacheKey: string
  ): Promise<CachedMatchResult | null> {
    if (!this.redisClient) {
      return null;
    }

    try {
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('TemplateMatcher: Cache read failed', {
        cacheKey,
        error: (error as Error).message,
      });
    }

    return null;
  }

  /**
   * Cache matches in Redis
   */
  private async cacheMatches(
    cacheKey: string,
    matches: TemplateMatchResult[],
    executionTimeMs: number
  ): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    try {
      const cacheData: CachedMatchResult = {
        matches,
        executionTimeMs,
        costUsd: 0, // Caching is free
      };

      await this.redisClient.setex(
        cacheKey,
        this.CACHE_TTL,
        JSON.stringify(cacheData)
      );
    } catch (error) {
      logger.warn('TemplateMatcher: Cache write failed', {
        cacheKey,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Update Qdrant index with new template embeddings
   * Called when new templates are approved
   */
  async indexTemplate(
    templateId: string,
    templateName: string,
    category: string,
    description: string,
    qualityScore: number,
    successRate: number,
    userSatisfaction: number
  ): Promise<void> {
    try {
      if (!this.qdrantClient || !this.embeddingService) {
        logger.warn('TemplateMatcher: Qdrant or embedding service not available');
        return;
      }

      // Get embedding for template
      const templateText = `${templateName} ${description}`;
      const embedding = await this.getQuestionEmbedding(templateText);

      if (embedding.length === 0) {
        logger.warn('TemplateMatcher: Failed to get embedding for template', {
          templateId,
        });
        return;
      }

      // Upsert to Qdrant
      await this.qdrantClient.upsert({
        collection_name: 'legal_templates',
        points: [
          {
            id: templateId,
            vector: embedding,
            payload: {
              template_id: templateId,
              template_name: templateName,
              category,
              quality_score: qualityScore,
              success_rate: successRate,
              user_satisfaction: userSatisfaction,
            },
          },
        ],
      });

      logger.info('TemplateMatcher: Template indexed', {
        templateId,
        templateName,
      });
    } catch (error) {
      logger.error('TemplateMatcher: Indexing failed', {
        templateId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Get matcher statistics and performance metrics
   */
  async getMatcherStats(days: number = 30): Promise<any> {
    try {
      const result = await this.db.query(
        `SELECT
          COUNT(*) as total_matches,
          COUNT(CASE WHEN match_score >= $1 THEN 1 END) as high_quality_matches,
          AVG(match_score) as avg_match_score,
          MAX(match_score) as max_match_score,
          MIN(match_score) as min_match_score,
          COUNT(DISTINCT user_id) as unique_users
        FROM template_matches
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * $2`,
        [this.MATCH_THRESHOLD, days]
      );

      const stats = result.rows[0];

      return {
        totalMatches: parseInt(stats.total_matches, 10),
        highQualityMatches: parseInt(stats.high_quality_matches, 10),
        avgMatchScore:
          parseFloat(stats.avg_match_score) || 0,
        maxMatchScore:
          parseFloat(stats.max_match_score) || 0,
        minMatchScore:
          parseFloat(stats.min_match_score) || 0,
        uniqueUsers: parseInt(stats.unique_users, 10),
        matchRate:
          stats.total_matches > 0
            ? (
                (parseInt(stats.high_quality_matches, 10) /
                  parseInt(stats.total_matches, 10)) *
                100
              ).toFixed(1) + '%'
            : '0%',
        period: `${days} days`,
      };
    } catch (error) {
      logger.error('TemplateMatcher: Stats query failed', {
        error: (error as Error).message,
      });

      return {
        totalMatches: 0,
        highQualityMatches: 0,
        avgMatchScore: 0,
        matchRate: '0%',
        error: 'Stats unavailable',
      };
    }
  }

  /**
   * Clear cache for testing/debugging
   */
  async clearCache(): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    try {
      const cursor = '0';
      const pattern = 'template_match:*';

      // Delete all template_match keys
      const keys = await this.redisClient.keys(pattern);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
        logger.info('TemplateMatcher: Cache cleared', { keysDeleted: keys.length });
      }
    } catch (error) {
      logger.warn('TemplateMatcher: Cache clear failed', {
        error: (error as Error).message,
      });
    }
  }
}

// Export singleton factory
let matcherInstance: TemplateMatcher | null = null;

export function createTemplateMatcher(
  db: BaseDatabase,
  embeddingService?: any,
  qdrantClient?: any,
  redisClient?: any
): TemplateMatcher {
  if (!matcherInstance) {
    matcherInstance = new TemplateMatcher(
      db,
      embeddingService,
      qdrantClient,
      redisClient
    );
  }
  return matcherInstance;
}

export function getTemplateMatcher(): TemplateMatcher {
  if (!matcherInstance) {
    throw new Error('TemplateMatcher not initialized');
  }
  return matcherInstance;
}
