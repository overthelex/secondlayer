import { load, CheerioAPI } from 'cheerio';
import { logger } from './logger.js';
import { getOpenAIManager } from './openai-client.js';
import { ModelSelector } from './model-selector.js';

export interface CourtDecisionSections {
  header: string[];      // Шапка (номер дела, суд, дата)
  ustanovyv: string[];   // УСТАНОВИВ (факты)
  reasoning: string[];   // Мотивировочная часть
  vyrishyv: string[];    // ВИРІШИВ (резолютивная часть)
  footer: string[];      // Подпись судьи, реквизиты
}

export interface CourtDecisionMetadata {
  title: string;
  description: string;
  caseNumber: string | null;
  url: string;
}

/**
 * Парсер HTML судебных решений
 * Оптимизирован для украинского языка и структуры решений
 */
export class CourtDecisionHTMLParser {
  private $: CheerioAPI;

  constructor(html: string) {
    this.$ = load(html);
  }

  /**
   * Извлекает только HTML контейнера с текстом решения (без стилей и скриптов)
   */
  extractArticleHTML(): string {
    const article = this.$('#article-container');
    if (article.length === 0) {
      logger.warn('Article container not found, trying fallback selectors');
      const fallback = this.$('article, main, .document-content').first();
      if (fallback.length > 0) {
        return fallback.html() || '';
      }
      return '';
    }

    // Возвращаем только HTML содержимого article-container
    return article.html() || '';
  }

  /**
   * Извлекает основной текст решения из HTML
   */
  extractMainText(): string[] {
    const article = this.$('#article-container');
    if (article.length === 0) {
      logger.warn('Article container not found, trying fallback selectors');
      // Fallback selectors
      const fallback = this.$('article, main, .document-content').first();
      if (fallback.length === 0) {
        throw new Error('Could not find decision text container');
      }
    }

    // Получаем все параграфы
    const paragraphs = this.$('#article-container p, article p').map((_i, el) => {
      let text = this.$(el).text().trim();
      
      // Удаляем лишние пробелы
      text = text.replace(/\s+/g, ' ');
      
      return text;
    }).get();

    return paragraphs.filter((p: string) => p.length > 0);
  }

  /**
   * Определяет структурные разделы решения
   */
  identifySections(paragraphs: string[]): CourtDecisionSections {
    const sections: CourtDecisionSections = {
      header: [],
      ustanovyv: [],
      reasoning: [],
      vyrishyv: [],
      footer: [],
    };

    let currentSection: keyof CourtDecisionSections = 'header';
    
    for (const para of paragraphs) {
      // Определяем ключевые маркеры разделов
      if (para.includes('УСТАНОВИВ:') || para.includes('ВСТАНОВИВ:')) {
        currentSection = 'ustanovyv';
        sections.ustanovyv.push(para);
      } else if (para.includes('ВИРІШИВ:') || para.includes('УХВАЛИВ:')) {
        currentSection = 'vyrishyv';
        sections.vyrishyv.push(para);
      } else if (para.match(/Суддя|Джерело:|ЄДРСР/)) {
        currentSection = 'footer';
        sections.footer.push(para);
      } else {
        sections[currentSection].push(para);
      }
    }

    return sections;
  }

  /**
   * Извлекает только ключевые факты и аргументы (оптимально для эмбеддингов)
   */
  extractKeyContent(sections: CourtDecisionSections): string {
    const keyParts: string[] = [];

    // Берем факты из УСТАНОВИВ
    if (sections.ustanovyv.length > 0) {
      keyParts.push('ВСТАНОВЛЕНІ ФАКТИ:');
      keyParts.push(sections.ustanovyv.join(' '));
    }

    // Берем правовой анализ
    if (sections.reasoning.length > 0) {
      keyParts.push('\nПРАВОВИЙ АНАЛІЗ:');
      keyParts.push(sections.reasoning.join(' '));
    }

    // Добавляем резолюцию
    if (sections.vyrishyv.length > 0) {
      keyParts.push('\nРЕЗОЛЮЦІЯ:');
      keyParts.push(sections.vyrishyv.join(' '));
    }

    return keyParts.join('\n');
  }

  /**
   * Получить метаданные решения
   */
  getMetadata(): CourtDecisionMetadata {
    const title = this.$('title').text().trim();
    const description = this.$('meta[name="description"]').attr('content') || '';
    
    // Извлекаем номер дела из текста
    const text = this.$('#article-container').text();
    const caseNumberMatch = text.match(/Справа № ([\d\/\-а-яА-Я]+)/i);
    const caseNumber = caseNumberMatch ? caseNumberMatch[1] : null;

    return {
      title,
      description,
      caseNumber,
      url: this.$('link[rel="canonical"]').attr('href') || '',
    };
  }

  /**
   * Конвертирует HTML в текст
   * @param format - 'full' (весь текст), 'key' (только ключевой контент), 'plain' (простой текст)
   * @param maxLength - максимальная длина текста (для ограничения размера)
   */
  toText(format: 'full' | 'key' | 'plain' = 'full', maxLength?: number): string {
    try {
      const paragraphs = this.extractMainText();
      
      if (paragraphs.length === 0) {
        logger.warn('No paragraphs extracted from HTML');
        return '';
      }

      let text = '';

      if (format === 'key') {
        // Только ключевой контент (оптимально для embeddings)
        const sections = this.identifySections(paragraphs);
        text = this.extractKeyContent(sections);
      } else if (format === 'plain') {
        // Простой текст с параграфами
        text = paragraphs.join('\n\n');
      } else {
        // Полный текст без разделителей
        text = paragraphs.join(' ');
      }

      // Ограничиваем длину если указано
      if (maxLength && text.length > maxLength) {
        text = text.substring(0, maxLength);
        logger.debug('Text truncated', { original: text.length, truncated: maxLength });
      }

      return text;
    } catch (error: any) {
      logger.error('Failed to convert HTML to text', error);
      throw error;
    }
  }
}

/**
 * Извлекает ключевые термины с помощью OpenAI для более точного анализа
 */
export async function extractSearchTermsWithAI(text: string): Promise<{
  lawArticles: string[];
  keywords: string[];
  disputeType: string | null;
  searchQuery: string;
  caseEssence: string;
}> {
  const openaiManager = getOpenAIManager();

  try {
    // Ограничиваем текст для анализа (макс 3000 символов)
    const analysisText = text.substring(0, 3000);

    const response = await openaiManager.executeWithRetry(async (client) => {
      // Use quick model for simple term extraction
      const model = ModelSelector.getChatModel('quick');
      return await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: `Ти експерт-аналітик судових рішень. Проаналізуй текст судового рішення та витягни:

1. **Статті законів** - які використовуються в рішенні (наприклад: "626 ЦК", "280 ЦПК")
2. **Тип спору** - коротко, одним реченням (наприклад: "стягнення заборгованості за договором лізингу")
3. **Суть справи** - 1-2 речення про що справа
4. **Ключові слова** для пошуку схожих справ (5-10 слів)
5. **Пошуковий запит** - оптимальний запит для пошуку подібних справ в базі

Поверни ТІЛЬКИ валідний JSON з полями: lawArticles (array), disputeType (string), caseEssence (string), keywords (array), searchQuery (string).`,
          },
          {
            role: 'user',
            content: `Проаналізуй це судове рішення:\n\n${analysisText}`,
          },
        ],
        temperature: 0.3,
        max_completion_tokens: 500,
        response_format: { type: 'json_object' },
      });
    });

    const content = response.choices[0].message.content || '{}';
    const result = JSON.parse(content);

    logger.info('AI extracted search terms', {
      lawArticles: result.lawArticles?.length || 0,
      keywords: result.keywords?.length || 0,
      disputeType: result.disputeType,
    });

    return {
      lawArticles: result.lawArticles || [],
      keywords: result.keywords || [],
      disputeType: result.disputeType || null,
      searchQuery: result.searchQuery || '',
      caseEssence: result.caseEssence || '',
    };
  } catch (error: any) {
    logger.warn('AI term extraction failed, using fallback', error?.message);
    // Fallback to regex-based extraction
    return extractSearchTermsRegex(text);
  }
}

/**
 * Извлекает ключевые термины для поиска из текста решения (regex fallback)
 */
export function extractSearchTermsRegex(text: string): {
  lawArticles: string[];
  keywords: string[];
  disputeType: string | null;
  searchQuery: string;
  caseEssence: string;
} {
  const lawArticles: string[] = [];
  const keywords = new Set<string>();
  let disputeType: string | null = null;

  // Извлекаем статьи законов (ст. 123, статті 456, article 789)
  const lawArticlePattern = /(?:ст\.|статт[іяє]|article)\s*(\d+(?:\.\d+)?)\s*(?:ЦК|ЦПК|ГК|КК|України)?/gi;
  let match;
  while ((match = lawArticlePattern.exec(text)) !== null) {
    lawArticles.push(match[1]);
  }

  // Извлекаем ключевые слова (юридические термины)
  const legalTerms = [
    'заборгованість', 'стягнення', 'позов', 'договір', 'лізинг',
    'неустойка', 'відшкодування', 'розірвання', 'виконання',
    'зобов\'язання', 'порушення', 'відповідальність', 'збитки',
    'штраф', 'пеня', 'сплата', 'оплата', 'послуги', 'товар',
  ];

  const lowerText = text.toLowerCase();
  for (const term of legalTerms) {
    if (lowerText.includes(term)) {
      keywords.add(term);
    }
  }

  // Определяем тип спора по ключевым словам
  if (lowerText.includes('стягнення') && lowerText.includes('заборгованост')) {
    disputeType = 'стягнення заборгованості';
  } else if (lowerText.includes('розірвання договору')) {
    disputeType = 'розірвання договору';
  } else if (lowerText.includes('відшкодування збитків')) {
    disputeType = 'відшкодування збитків';
  }

  // Формируем поисковый запрос
  const queryParts = [];
  if (disputeType) queryParts.push(disputeType);
  queryParts.push(...Array.from(keywords).slice(0, 5));
  const searchQuery = queryParts.join(' ');

  return {
    lawArticles: [...new Set(lawArticles)].slice(0, 10),
    keywords: Array.from(keywords).slice(0, 15),
    disputeType,
    searchQuery,
    caseEssence: disputeType || 'загальний спір',
  };
}

/**
 * Быстрая функция для извлечения текста из HTML
 */
export function extractTextFromHTML(html: string, maxLength: number = 5000): string {
  try {
    const parser = new CourtDecisionHTMLParser(html);
    return parser.toText('key', maxLength);
  } catch (error) {
    logger.error('HTML text extraction failed', error);
    return '';
  }
}
