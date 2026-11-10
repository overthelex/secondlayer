import { logger } from '../utils/logger';
import { withLLMRetry } from '../utils/llm-retry.js';
import type { ICachePort, ILLMPort } from '../domain/ports/index.js';

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
  private redis: ICachePort | null;
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
    'КУ': { rada_id: '254к/96-вр', full_name: 'Конституція України' },
    'КУпАП': { rada_id: '8073-10', full_name: 'Кодекс про адміністративні правопорушення' },
    'ЗУ про військовий обов\'язок': { rada_id: '2232-12', full_name: 'Закон про військовий обов\'язок і військову службу' },
    'ЗУ про мобілізацію': { rada_id: '3543-12', full_name: 'Закон про мобілізаційну підготовку та мобілізацію' },
    'ЗУ про воєнний стан': { rada_id: '389-19', full_name: 'Закон про правовий режим воєнного стану' },
    'ЗУ про оборону': { rada_id: '1932-12', full_name: 'Закон про оборону України' },
    'ЗУ про ЗСУ': { rada_id: '1934-12', full_name: 'Закон про Збройні Сили України' },
    'ЗУ про соцзахист військових': { rada_id: '2011-12', full_name: 'Закон про соціальний і правовий захист військовослужбовців' },
    'ЗУ про статус ветеранів': { rada_id: '3551-12', full_name: 'Закон про статус ветеранів війни' },
    'Дисциплінарний статут': { rada_id: '551-14', full_name: 'Дисциплінарний статут Збройних Сил України' },
    'Статут внутрішньої служби': { rada_id: '548-14', full_name: 'Статут внутрішньої служби Збройних Сил України' },
    'ЗУ про торговельні марки': { rada_id: '3689-12', full_name: 'Закон про охорону прав на знаки для товарів і послуг (торговельні марки)' },
    'ЗУ про винаходи': { rada_id: '3687-12', full_name: 'Закон про охорону прав на винаходи і корисні моделі (патенти)' },
    'ЗУ про промислові зразки': { rada_id: '3688-12', full_name: 'Закон про охорону прав на промислові зразки' },
    'ЗУ про авторське право': { rada_id: '2811-20', full_name: 'Закон про авторське право і суміжні права' },
  };

  constructor(redis?: ICachePort, private readonly llm?: ILLMPort) {
    this.redis = redis || null;
  }

  /**
   * Устанавливает Redis клиент для кэширования (опционально)
   */
  setRedisClient(redis: ICachePort | null): void {
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

    const systemPrompt = `Ти експерт з українського законодавства. Твоє завдання - визначити, до якого саме кодексу/закону/постанови та до якої статті (пункту) відноситься запит користувача.

ДОСТУПНІ КОДЕКСИ:
${availableCodes}

ПОСТАНОВИ КМУ (Кабінету Міністрів України):
Формат rada_id для постанов КМУ: "{номер}-{рік}-п"
Приклади:
- Постанова КМУ №1388 від 1998 → rada_id: "1388-98-п"
- Постанова КМУ №704 від 2017 → rada_id: "704-2017-п"
- Постанова КМУ №975 від 2013 → rada_id: "975-2013-п"
- Постанова КМУ №154 від 2022 → rada_id: "154-2022-п"

Якщо рік постанови невідомий, використай формат "KMU:{номер}" (наприклад, "KMU:1388") — система сама знайде правильний рік.

Для постанов КМУ замість "стаття" зазвичай вживається "пункт" (п.) — article_number = номер пункту.

РОЗПОРЯДЖЕННЯ КМУ:
Це ОКРЕМИЙ тип документа, НЕ постанова. Формат rada_id: "{номер}-{рік}-р" (суфікс "-р", не "-п").
Ознаки: слово "розпорядження" в запиті, або номер із суфіксом "-р" (напр. "265-р", "№ 265-р").
Приклади:
- Розпорядження КМУ №265-р від 24.04.2019 → rada_id: "265-2019-р"
- Розпорядження КМУ № 1588-р від 2021 → rada_id: "1588-2021-р"
- "розпорядження КМУ 265-р" без року → rada_id: "KMU-Р:265" (система знайде рік)

Розпорядження зазвичай короткі (один абзац + додаток-таблиця). Номер статті/пункту зазвичай відсутній (article_number: null), весь текст документа ідентифікується як article_number="1".

АКТИ ПРЕЗИДЕНТА / НАКАЗИ / ІНШІ ТИПИ (не плутай суфікси):
- Указ Президента: "{номер}/{рік}" (напр. "64/2022")
- Наказ міністерства: часто має формат "z{номер}-{рік}" або специфічний префікс

ПРАВИЛА КЛАСИФІКАЦІЇ:
1. Визнач точний rada_id кодексу або постанови (наприклад, "1618-15" для ЦПК, "1388-98-п" для ПКМУ №1388)
2. Витягни номер статті/пункту (може бути з дефісом або крапкою, наприклад "354-1", "6", "6.1")
3. Оціни впевненість (0.0-1.0):
   - 1.0 = однозначне посилання ("ст. 354 ЦПК")
   - 0.8-0.9 = чітке посилання з контекстом ("стаття 625 Цивільного кодексу", "пункт 6 ПКМУ 1388")
   - 0.5-0.7 = неявне посилання, потрібен контекст ("стаття 44 про податки" → ПКУ)
   - < 0.5 = неоднозначно або недостатньо інформації

4. Надай короткий reasoning (чому саме цей кодекс/постанова)

ПРИКЛАДИ ЗАПИТІВ:
- "ст. 354 ЦПК" → rada_id: "1618-15", article_number: "354", confidence: 1.0
- "стаття 625 ЦК" → rada_id: "435-15", article_number: "625", confidence: 1.0
- "44 стаття податкового кодексу" → rada_id: "2755-17", article_number: "44", confidence: 0.9
- "постанова КМУ 1388 пункт 6" → rada_id: "1388-98-п", article_number: "6", confidence: 0.9
- "ПКМУ №704 п. 3" → rada_id: "704-2017-п", article_number: "3", confidence: 0.9
- "постанова кабміну про реєстрацію транспортних засобів" → rada_id: "KMU:1388", article_number: null, confidence: 0.7
- "розпорядження КМУ 265-р від 24.04.2019" → rada_id: "265-2019-р", article_number: null, confidence: 0.95
- "розпорядження КМУ № 265-р про креативні індустрії" → rada_id: "KMU-Р:265", article_number: null, confidence: 0.8
- "креативні індустрії перелік КВЕД" → rada_id: "265-2019-р", article_number: null, confidence: 0.75 (контекст: розпорядження КМУ 265-р затверджує цей перелік)
- "стаття про строки" → rada_id: null, confidence: < 0.5 (недостатньо інформації)

Поверни ТІЛЬКИ валідний JSON без додаткового тексту:
{
  "rada_id": "1618-15" | "KMU:1388" | null,
  "article_number": "354" | null,
  "confidence": 0.95,
  "code_name": "ЦПК",
  "reasoning": "Чіткий запит з вказівкою ЦПК та номеру статті"
}`;

    if (!this.llm) {
      throw new Error('LLM port not configured for legislation classification');
    }

    const response = await withLLMRetry(
      () => this.llm!.chatCompletion(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
          ],
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        },
        budget
      ),
      { operationName: 'LegislationClassifier.classify', timeoutMs: 10_000 },
    );

    let content = response.content || '{}';

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

    // LLM іноді повертає літеральний рядок "null"/"none" замість JSON null — без
    // санітизації downstream шукає статтю з номером "null" і термінально фейлиться.
    const sanitizeField = (value: unknown): string | null => {
      if (value === null || value === undefined) return null;
      const s = String(value).trim();
      if (!s || ['null', 'none', 'undefined'].includes(s.toLowerCase())) return null;
      return s;
    };

    // Валидация и нормализация результата
    const classification: LegislationClassification = {
      rada_id: sanitizeField(result.rada_id),
      article_number: sanitizeField(result.article_number),
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
      await this.redis.set(key, JSON.stringify(classification), this.cacheTTL);
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
