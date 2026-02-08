/**
 * Tests for TemplateClassifier Service
 */

import { TemplateClassifier } from '../TemplateClassifier';
import { QuestionClassification } from '../types';

describe('TemplateClassifier', () => {
  let classifier: TemplateClassifier;

  beforeEach(() => {
    // Mock Redis client
    const mockRedisClient = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };
    classifier = new TemplateClassifier(mockRedisClient);
  });

  describe('normalizeQuestion', () => {
    it('should normalize question text', () => {
      const question = '  Як отримати розлучення?  ';
      const normalized = (classifier as any).normalizeQuestion(question);
      expect(normalized).toBe('як отримати розлучення');
    });

    it('should expand abbreviations', () => {
      const question = 'За якими умовами за ЦК можна розірвати контракт?';
      const normalized = (classifier as any).normalizeQuestion(question);
      expect(normalized).toContain('цивільний кодекс');
    });

    it('should remove trailing punctuation', () => {
      const question = 'Що таке договір??? !!!';
      const normalized = (classifier as any).normalizeQuestion(question);
      expect(normalized).not.toMatch(/[?!]+$/);
    });

    it('should normalize whitespace', () => {
      const question = 'Це   є   тест';
      const normalized = (classifier as any).normalizeQuestion(question);
      expect(normalized).toBe('це є тест');
    });
  });

  describe('hashQuestion', () => {
    it('should generate consistent SHA256 hash', () => {
      const question = 'Як розірвати контракт?';
      const hash1 = (classifier as any).hashQuestion(question);
      const hash2 = (classifier as any).hashQuestion(question);
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different questions', () => {
      const hash1 = (classifier as any).hashQuestion('Питання 1');
      const hash2 = (classifier as any).hashQuestion('Питання 2');
      expect(hash1).not.toBe(hash2);
    });

    it('should generate 64-character SHA256 hash', () => {
      const hash = (classifier as any).hashQuestion('test');
      expect(hash).toHaveLength(64);
    });
  });

  describe('parseClassificationResponse', () => {
    it('should parse valid JSON response', () => {
      const response = JSON.stringify({
        intent: 'contract termination',
        confidence: 0.95,
        category: 'commercial_law',
        entities: { date: '2024-01-15' },
        keywords: ['contract', 'termination'],
        reasoning: 'Question is about terminating a contract',
        alternatives: [],
      });

      const result = (classifier as any).parseClassificationResponse(response);
      expect(result.intent).toBe('contract termination');
      expect(result.confidence).toBe(0.95);
      expect(result.category).toBe('commercial_law');
    });

    it('should handle JSON in markdown code block', () => {
      const response = `\`\`\`json
{
  "intent": "divorce",
  "confidence": 0.87,
  "category": "family_law",
  "entities": {},
  "keywords": ["divorce"],
  "reasoning": "Family law question",
  "alternatives": []
}
\`\`\``;

      const result = (classifier as any).parseClassificationResponse(response);
      expect(result.intent).toBe('divorce');
      expect(result.category).toBe('family_law');
    });

    it('should default invalid category to "other"', () => {
      const response = JSON.stringify({
        intent: 'test',
        confidence: 0.5,
        category: 'invalid_category',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
      });

      const result = (classifier as any).parseClassificationResponse(response);
      expect(result.category).toBe('other');
    });

    it('should clamp confidence between 0 and 1', () => {
      const responseTooHigh = JSON.stringify({
        intent: 'test',
        confidence: 1.5,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
      });

      const resultHigh = (classifier as any).parseClassificationResponse(
        responseTooHigh
      );
      expect(resultHigh.confidence).toBe(1);

      const responseTooLow = JSON.stringify({
        intent: 'test',
        confidence: -0.5,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
      });

      const resultLow = (classifier as any).parseClassificationResponse(
        responseTooLow
      );
      expect(resultLow.confidence).toBe(0);
    });

    it('should return fallback for invalid JSON', () => {
      const response = 'This is not JSON';
      const result = (classifier as any).parseClassificationResponse(response);
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0.0);
      expect(result.category).toBe('other');
    });

    it('should validate alternatives', () => {
      const response = JSON.stringify({
        intent: 'main',
        confidence: 0.9,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [
          {
            intent: 'alt1',
            category: 'invalid',
            confidence: 2.0,
            reasoning: 'alt reason',
          },
        ],
      });

      const result = (classifier as any).parseClassificationResponse(response);
      expect(result.alternatives[0].category).toBe('other');
      expect(result.alternatives[0].confidence).toBe(1);
    });
  });

  describe('extractEntities', () => {
    it('should extract dates in various formats', async () => {
      const question =
        'Договір був укладений 15.01.2024 або 2024-01-15 року';
      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 1,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
        executionTimeMs: 0,
        costUsd: 0,
      };

      const entities = await classifier.extractEntities(
        question,
        classification
      );
      expect(entities.dates).toBeDefined();
      expect(entities.dates?.length).toBeGreaterThan(0);
    });

    it('should extract currency amounts', async () => {
      const question =
        'Сума договору становить 5000 грн, або еквівалент 500 USD';
      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 1,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
        executionTimeMs: 0,
        costUsd: 0,
      };

      const entities = await classifier.extractEntities(
        question,
        classification
      );
      expect(entities.amounts).toBeDefined();
      expect(entities.amounts?.length).toBeGreaterThan(0);
    });

    it('should extract percentages', async () => {
      const question = 'Скидка становить 15% або 20.5%';
      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 1,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
        executionTimeMs: 0,
        costUsd: 0,
      };

      const entities = await classifier.extractEntities(
        question,
        classification
      );
      expect(entities.percentages).toBeDefined();
      expect(entities.percentages?.length).toBeGreaterThan(0);
    });

    it('should extract email addresses', async () => {
      const question = 'Зв\'яжіться з нами на email test@example.com';
      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 1,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
        executionTimeMs: 0,
        costUsd: 0,
      };

      const entities = await classifier.extractEntities(
        question,
        classification
      );
      expect(entities.emails).toBeDefined();
      expect(entities.emails?.length).toBeGreaterThan(0);
    });

    it('should extract phone numbers', async () => {
      const question = 'Зв\'яжіться з нами за номером +380506921234 або 0509876543';
      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 1,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'test',
        alternatives: [],
        executionTimeMs: 0,
        costUsd: 0,
      };

      const entities = await classifier.extractEntities(
        question,
        classification
      );
      expect(entities.phones).toBeDefined();
      expect(entities.phones?.length).toBeGreaterThan(0);
    });
  });

  describe('buildClassificationPrompt', () => {
    it('should build valid classification prompt', () => {
      const prompt = (classifier as any).buildClassificationPrompt(
        'Як розірвати контракт?'
      );
      expect(prompt).toContain('Як розірвати контракт?');
      expect(prompt).toContain('VALID CATEGORIES');
      expect(prompt).toContain('contract_interpretation');
      expect(prompt).toContain('JSON');
    });

    it('should include all valid categories in prompt', () => {
      const prompt = (classifier as any).buildClassificationPrompt('test');
      const categories = [
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

      categories.forEach((cat) => {
        expect(prompt).toContain(cat);
      });
    });
  });

  describe('caching', () => {
    it('should cache classification result', async () => {
      const mockRedisClient = {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue('OK'),
      };
      const classifierWithMock = new TemplateClassifier(mockRedisClient);

      const classification: QuestionClassification = {
        intent: 'test',
        confidence: 0.95,
        category: 'commercial_law',
        entities: {},
        keywords: ['test'],
        reasoning: 'test reasoning',
        alternatives: [],
        executionTimeMs: 50,
        costUsd: 0.001,
      };

      const hash = (classifierWithMock as any).hashQuestion('test question');
      await (classifierWithMock as any).cacheClassification(hash, classification);

      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        `classification:${hash}`,
        86400, // Cache TTL
        expect.any(String)
      );
    });

    it('should retrieve cached classification', async () => {
      const cachedData: QuestionClassification = {
        intent: 'cached',
        confidence: 0.95,
        category: 'commercial_law',
        entities: {},
        keywords: [],
        reasoning: 'cached',
        alternatives: [],
        executionTimeMs: 10,
        costUsd: 0,
      };

      const mockRedisClient = {
        get: jest.fn().mockResolvedValue(JSON.stringify(cachedData)),
        setex: jest.fn().mockResolvedValue('OK'),
      };
      const classifierWithMock = new TemplateClassifier(mockRedisClient);

      const hash = (classifierWithMock as any).hashQuestion('test question');
      const cached = await (classifierWithMock as any).getCachedClassification(
        hash
      );

      expect(cached).toEqual(cachedData);
    });

    it('should handle cache read errors gracefully', async () => {
      const mockRedisClient = {
        get: jest.fn().mockRejectedValue(new Error('Cache error')),
        setex: jest.fn().mockResolvedValue('OK'),
      };
      const classifierWithMock = new TemplateClassifier(mockRedisClient);

      const hash = (classifierWithMock as any).hashQuestion('test question');
      const cached = await (classifierWithMock as any).getCachedClassification(
        hash
      );

      expect(cached).toBeNull();
    });
  });
});
