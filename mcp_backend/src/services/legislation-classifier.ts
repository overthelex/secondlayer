import { logger } from '../utils/logger';
import { getOpenAIManager } from '../utils/openai-client';
import { ModelSelector } from '../utils/model-selector';
import { createClient } from 'redis';

export interface LegislationClassification {
  rada_id: string | null;
  article_number: string | null;
  confidence: number;
  code_name?: string;
  reasoning?: string;
}

/**
 * Классифицирует запросы к законодательству используя OpenAI,
 * когда regexp не может определить кодекс и статью
 */
export class LegislationClassifier {
  private openaiManager = getOpenAIManager();
  private redis: ReturnType<typeof createClient> | null;
  private cachePrefix = 'leg_classify:';
  private cacheTTL = 7 * 24 * 60 * 60; // 7 дней

  // Маппинг кодексов для промпта
  private readonly CODE_MAPPINGS = {
    'ЦПК': { rada_id: '1618-15', full_name: 'Цивільний процесуальний кодекс України' },
    'ГПК': { rada_id: '1798-12', full_name: 'Господарський процесуальний кодекс України' },
    'КАС': { rada_id: '2747-15', full_name: 'Кодекс адміністративного судочинства України' },
    'КПК': { rada_id: '4651-17', full_name: 'Кримінальний процесуальний кодекс України' },
    'ЦК': { rada_id: '435-15', full_name: 'Цивільний кодекс України' },
    'ГК': { rada_id: '436-15', full_name: 'Господарський кодекс України' },
    'ПКУ': { rada_id: '2755-17', full_name: 'Податковий кодекс України' },
    'КЗпП': { rada_id: '322-08', full_name: 'Кодекс законів про працю України' },
    'СК': { rada_id: '2947-14', full_name: 'Сімейний кодекс України' },
    'ЗК': { rada_id: '2768-14', full_name: 'Земельний кодекс України' },
    'КК': { rada_id: '2341-14', full_name: 'Кримінальний кодекс України' },
  };

  constructor(redis?: ReturnType<typeof createClient>) {
    this.redis = redis || null;
  }

  /**
   * Устанавливает Redis клиент для кэширования (опционально)
   */
  setRedisClient(redis: ReturnType<typeof createClient> | null): void {
    this.redis = redis;
  }

  /**
   * Классифицирует текстовый запрос к законодательству через OpenAI
   */
  async classify(
    query: string,
    budget: 'quick' | 'standard' | 'deep' = 'quick'
  ): Promise<LegislationClassification> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      return { rada_id: null, article_number: null, confidence: 0 };
    }

    // Проверяем кэш
    const cached = await this.getFromCache(normalizedQuery);
    if (cached) {
      logger.debug('[LegislationClassifier] Cache hit', { query: normalizedQuery });
      return cached;
    }

    logger.info('[LegislationClassifier] Classifying query via OpenAI', {
      query: normalizedQuery.substring(0, 100),
      budget,
    });

    try {
      const classification = await this.classifyWithOpenAI(normalizedQuery, budget);

      // Сохраняем в кэш если уверенность высокая
      if (classification.confidence >= 0.7) {
        await this.saveToCache(normalizedQuery, classification);
      }

      return classification;
    } catch (error: any) {
      logger.error('[LegislationClassifier] Classification failed', {
        error: error.message,
        query: normalizedQuery.substring(0, 100),
      });

      return { rada_id: null, article_number: null, confidence: 0, reasoning: error.message };
    }
  }

  private async classifyWithOpenAI(
    query: string,
    budget: 'quick' | 'standard' | 'deep'
  ): Promise<LegislationClassification> {
    // Формируем список доступных кодексов для промпта
    const availableCodes = Object.entries(this.CODE_MAPPINGS)
      .map(([code, info]) => `${code} (rada_id: "${info.rada_id}") - ${info.full_name}`)
      .join('\n');

    const systemPrompt = `Ти експерт з українського законодавства. Твоє завдання - визначити, до якого саме кодексу/закону та до якої статті відноситься запит користувача.

ДОСТУПНІ КОДЕКСИ:
${availableCodes}

ПРАВИЛА КЛАСИФІКАЦІЇ:
1. Визнач точний rada_id кодексу (наприклад, "1618-15" для ЦПК)
2. Витягни номер статті (може бути з дефісом, наприклад "354-1")
3. Оціни впевненість (0.0-1.0):
   - 1.0 = однозначне посилання ("ст. 354 ЦПК")
   - 0.8-0.9 = чітке посилання з контекстом ("стаття 625 Цивільного кодексу")
   - 0.5-0.7 = неявне посилання, потрібен контекст ("стаття 44 про податки" → ПКУ)
   - < 0.5 = неоднозначно або недостатньо інформації

4. Надай короткий reasoning (чому саме цей кодекс)

ПРИКЛАДИ ЗАПИТІВ:
- "ст. 354 ЦПК" → rada_id: "1618-15", article_number: "354", confidence: 1.0
- "стаття 625 ЦК" → rada_id: "435-15", article_number: "625", confidence: 1.0
- "44 стаття податкового кодексу" → rada_id: "2755-17", article_number: "44", confidence: 0.9
- "процесуальні строки в цивільному процесі стаття 124" → rada_id: "1618-15", article_number: "124", confidence: 0.8
- "стаття про строки" → rada_id: null, confidence: < 0.5 (недостатньо інформації)

Поверни ТІЛЬКИ валідний JSON без додаткового тексту:
{
  "rada_id": "1618-15" | null,
  "article_number": "354" | null,
  "confidence": 0.95,
  "code_name": "ЦПК",
  "reasoning": "Чіткий запит з вказівкою ЦПК та номеру статті"
}`;

    const response = await this.openaiManager.executeWithRetry(async (client) => {
      const model = ModelSelector.getChatModel(budget);
      const supportsJsonMode = ModelSelector.supportsJsonMode(model);

      const requestConfig: any = {
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0.2, // Низкая температура для более детерминированных результатов
        max_tokens: 300,
      };

      if (supportsJsonMode) {
        requestConfig.response_format = { type: 'json_object' };
      }

      return await client.chat.completions.create(requestConfig);
    });

    let content = response.choices[0].message.content || '{}';

    // Извлекаем JSON из markdown блоков если присутствуют
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1];
    }

    // Пытаемся найти JSON объект в тексте
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      content = jsonObjectMatch[0];
    }

    const result = JSON.parse(content);

    // Валидация и нормализация результата
    const classification: LegislationClassification = {
      rada_id: result.rada_id || null,
      article_number: result.article_number ? String(result.article_number).trim() : null,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      code_name: result.code_name || undefined,
      reasoning: result.reasoning || undefined,
    };

    logger.info('[LegislationClassifier] Classification result', {
      query: query.substring(0, 50),
      rada_id: classification.rada_id,
      article: classification.article_number,
      confidence: classification.confidence,
      code: classification.code_name,
    });

    return classification;
  }

  private async getFromCache(query: string): Promise<LegislationClassification | null> {
    if (!this.redis) return null;

    try {
      const key = this.cachePrefix + query;
      const cached = await this.redis.get(key);

      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error: any) {
      logger.warn('[LegislationClassifier] Cache read error', { error: error.message });
    }

    return null;
  }

  private async saveToCache(query: string, classification: LegislationClassification): Promise<void> {
    if (!this.redis) return;

    try {
      const key = this.cachePrefix + query;
      await this.redis.setEx(key, this.cacheTTL, JSON.stringify(classification));
      logger.debug('[LegislationClassifier] Saved to cache', { query: query.substring(0, 50) });
    } catch (error: any) {
      logger.warn('[LegislationClassifier] Cache write error', { error: error.message });
    }
  }

  /**
   * Batch classification для множественных запросов
   */
  async classifyBatch(
    queries: string[],
    budget: 'quick' | 'standard' | 'deep' = 'quick'
  ): Promise<LegislationClassification[]> {
    const results: LegislationClassification[] = [];

    for (const query of queries) {
      const result = await this.classify(query, budget);
      results.push(result);
    }

    return results;
  }
}
