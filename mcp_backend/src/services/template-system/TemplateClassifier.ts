/**
 * TemplateClassifier Service
 *
 * Classifies user questions to determine intent and category
 * - Normalizes question text
 * - Extracts entities (dates, amounts, names, etc.)
 * - Determines primary intent + confidence
 * - Suggests alternative intents
 * - Caches results for < 50ms response time
 */

import {
  QuestionClassification,
  ClassificationAlternative,
} from './types.js';
import { getOpenAIManager, logger } from '@secondlayer/shared';
import * as crypto from 'crypto';

interface ClassificationPromptResult {
  intent: string;
  confidence: number;
  category: string;
  entities: Record<string, any>;
  keywords: string[];
  reasoning: string;
  alternatives: Array<{
    intent: string;
    category: string;
    confidence: number;
    reasoning: string;
  }>;
}

export class TemplateClassifier {
  private readonly CACHE_TTL = 86400; // 24 hours
  private readonly CLASSIFICATION_CATEGORIES = [
    'contract_interpretation',
    'legal_dispute',
    'legislation_search',
    'case_law_precedent',
    'document_analysis',
    'legal_consultation',
    'regulatory_compliance',
    'property_rights',
    'family_law',
    'commercial_law',
    'labor_law',
    'administrative_law',
    'criminal_law',
    'intellectual_property',
    'tax_law',
    'other',
  ];

  constructor(private redisClient?: any) {}

  /**
   * Classify a question to determine intent and category
   * Returns classification with confidence scores and alternatives
   */
  async classifyQuestion(
    questionText: string
  ): Promise<QuestionClassification> {
    const startTime = Date.now();

    try {
      // 1. Normalize question
      const normalizedQuestion = this.normalizeQuestion(questionText);
      const questionHash = this.hashQuestion(normalizedQuestion);

      // 2. Check cache
      const cached = await this.getCachedClassification(questionHash);
      if (cached) {
        logger.debug('TemplateClassifier: Using cached classification', {
          questionHash,
          intent: cached.intent,
        });
        return cached;
      }

      // 3. Call LLM to classify
      const openai = getOpenAIManager();

      const classificationPrompt = this.buildClassificationPrompt(
        normalizedQuestion
      );

      const response = await openai.executeWithRetry(async (client) => {
        return await client.chat.completions.create({
          model: 'gpt-4o-mini', // Quick classification
          messages: [
            {
              role: 'user',
              content: classificationPrompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
        });
      });

      const rawContent = response.choices[0].message.content || '{}';
      const parsedResult = this.parseClassificationResponse(rawContent);

      // 4. Build result
      const executionTimeMs = Date.now() - startTime;
      const classification: QuestionClassification = {
        intent: parsedResult.intent,
        confidence: parsedResult.confidence,
        category: parsedResult.category,
        entities: parsedResult.entities,
        keywords: parsedResult.keywords,
        reasoning: parsedResult.reasoning,
        alternatives: parsedResult.alternatives,
        executionTimeMs,
        costUsd: 0.002, // gpt-4o-mini classification cost
      };

      // 5. Cache result
      await this.cacheClassification(questionHash, classification);

      logger.info('TemplateClassifier: Classification complete', {
        questionHash,
        intent: classification.intent,
        confidence: classification.confidence,
        executionTimeMs,
        costUsd: classification.costUsd,
      });

      return classification;
    } catch (error) {
      logger.error('TemplateClassifier: Classification failed', {
        question: questionText.substring(0, 100),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Normalize question text for consistent classification
   * - Remove extra whitespace
   * - Lowercase
   * - Remove punctuation variations
   * - Expand common abbreviations
   */
  private normalizeQuestion(question: string): string {
    return question
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[?!]+$/, '') // Remove trailing punctuation
      .replace(/the\s+/gi, '') // Remove articles
      .replace(
        /\b(цк|гк|кас|пк|цпк|гпк)\b/gi,
        (match) => {
          const abbr: Record<string, string> = {
            цк: 'цивільний кодекс',
            гк: 'господарський кодекс',
            кас: 'кодекс адміністративного судочинства',
            пк: 'процесуальний кодекс',
            цпк: 'цивільний процесуальний кодекс',
            гпк: 'господарський процесуальний кодекс',
          };
          return abbr[match.toLowerCase()] || match;
        }
      );
  }

  /**
   * Generate SHA256 hash of normalized question
   */
  private hashQuestion(question: string): string {
    return crypto.createHash('sha256').update(question).digest('hex');
  }

  /**
   * Get cached classification from Redis
   */
  private async getCachedClassification(
    questionHash: string
  ): Promise<QuestionClassification | null> {
    if (!this.redisClient) {
      return null;
    }

    try {
      const cached = await this.redisClient.get(
        `classification:${questionHash}`
      );
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('TemplateClassifier: Cache read failed', {
        hash: questionHash,
        error: (error as Error).message,
      });
    }

    return null;
  }

  /**
   * Cache classification in Redis
   */
  private async cacheClassification(
    questionHash: string,
    classification: QuestionClassification
  ): Promise<void> {
    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.setex(
        `classification:${questionHash}`,
        this.CACHE_TTL,
        JSON.stringify(classification)
      );
    } catch (error) {
      logger.warn('TemplateClassifier: Cache write failed', {
        hash: questionHash,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Build LLM prompt for question classification
   */
  private buildClassificationPrompt(normalizedQuestion: string): string {
    const categoriesJson = this.CLASSIFICATION_CATEGORIES.join('\n  - ');

    return `You are a legal question classifier. Analyze the following Ukrainian legal question and provide a JSON response with classification.

QUESTION: "${normalizedQuestion}"

VALID CATEGORIES:
  - ${categoriesJson}

Respond with ONLY valid JSON (no markdown, no extra text) following this exact structure:
{
  "intent": "brief intent description (2-3 words)",
  "confidence": 0.95,
  "category": "category from the list above",
  "entities": {
    "date": "extracted date if present",
    "amount": "extracted amount if present",
    "names": ["extracted proper names"],
    "location": "extracted location if present"
  },
  "keywords": ["key", "words", "from", "question"],
  "reasoning": "Why this classification makes sense",
  "alternatives": [
    {
      "intent": "alternative intent",
      "category": "alternative category",
      "confidence": 0.65,
      "reasoning": "Why this could also match"
    }
  ]
}

Return ONLY the JSON object.`;
  }

  /**
   * Parse LLM response and validate JSON structure
   */
  private parseClassificationResponse(
    responseText: string
  ): ClassificationPromptResult {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = responseText.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.slice(7);
      }
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.slice(0, -3);
      }

      const parsed = JSON.parse(jsonText.trim());

      // Validate required fields
      if (!parsed.intent || !parsed.category || parsed.confidence === undefined) {
        throw new Error('Missing required classification fields');
      }

      // Ensure category is valid
      if (!this.CLASSIFICATION_CATEGORIES.includes(parsed.category)) {
        parsed.category = 'other';
      }

      // Ensure confidence is in valid range
      parsed.confidence = Math.min(
        1,
        Math.max(0, parseFloat(parsed.confidence))
      );

      // Validate alternatives
      if (Array.isArray(parsed.alternatives)) {
        parsed.alternatives = parsed.alternatives.map((alt: any) => ({
          intent: alt.intent || 'unknown',
          category: this.CLASSIFICATION_CATEGORIES.includes(alt.category)
            ? alt.category
            : 'other',
          confidence: Math.min(1, Math.max(0, parseFloat(alt.confidence) || 0)),
          reasoning: alt.reasoning || '',
        }));
      } else {
        parsed.alternatives = [];
      }

      // Ensure keywords is array
      if (!Array.isArray(parsed.keywords)) {
        parsed.keywords = [];
      }

      return parsed;
    } catch (error) {
      logger.error('TemplateClassifier: Failed to parse classification response', {
        response: responseText.substring(0, 200),
        error: (error as Error).message,
      });

      // Return fallback classification
      return {
        intent: 'unknown',
        confidence: 0.0,
        category: 'other',
        entities: {},
        keywords: [],
        reasoning: 'Classification failed, using fallback',
        alternatives: [],
      };
    }
  }

  /**
   * Extract entities from question text using regex and LLM
   * Identifies dates, amounts, names, locations, etc.
   */
  async extractEntities(
    questionText: string,
    classification: QuestionClassification
  ): Promise<Record<string, any>> {
    const entities: Record<string, any> = { ...classification.entities };

    // 1. Extract dates (Ukrainian format)
    const datePattern = /\b(\d{1,2}[.\-]\d{1,2}[.\-]\d{4}|\d{4})/g;
    const dates = questionText.match(datePattern);
    if (dates && dates.length > 0) {
      entities.dates = dates;
    }

    // 2. Extract amounts (currency)
    const amountPattern = /(\d+\s*(?:грн|USD|EUR|UAH|\$|€)\.?)/gi;
    const amounts = questionText.match(amountPattern);
    if (amounts && amounts.length > 0) {
      entities.amounts = amounts;
    }

    // 3. Extract percentages
    const percentPattern = /(\d+(?:[.,]\d{1,2})?%)/g;
    const percentages = questionText.match(percentPattern);
    if (percentages && percentages.length > 0) {
      entities.percentages = percentages;
    }

    // 4. Extract email addresses
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emails = questionText.match(emailPattern);
    if (emails && emails.length > 0) {
      entities.emails = emails;
    }

    // 5. Extract phone numbers
    const phonePattern = /\b(?:\+38|0)[\d\s\-()]{8,}\d/g;
    const phones = questionText.match(phonePattern);
    if (phones && phones.length > 0) {
      entities.phones = phones;
    }

    return entities;
  }

  /**
   * Get classification statistics
   */
  async getClassificationStats(days: number = 30): Promise<any> {
    // This would query the database table: question_classifications
    // Returns aggregated stats for the given period
    logger.info('TemplateClassifier: Getting classification stats', { days });
    return {
      totalClassifications: 0,
      uniqueIntents: 0,
      topCategories: [],
      avgConfidence: 0,
      cachHitRate: 0,
    };
  }
}

// Export singleton instance (created by factory)
let classifierInstance: TemplateClassifier | null = null;

export function createTemplateClassifier(redisClient?: any): TemplateClassifier {
  if (!classifierInstance) {
    classifierInstance = new TemplateClassifier(redisClient);
  }
  return classifierInstance;
}

export function getTemplateClassifier(): TemplateClassifier {
  if (!classifierInstance) {
    throw new Error('TemplateClassifier not initialized');
  }
  return classifierInstance;
}
