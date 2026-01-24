import { Pool } from 'pg';
import { LegislationService, parseLegislationReference } from '../services/legislation-service';
import { LegislationRenderer } from '../services/legislation-renderer';
import { EmbeddingService } from '../services/embedding-service';
import { logger } from '../utils/logger';

export interface LegislationToolArgs {
  rada_id?: string;
  article_number?: string;
  article_numbers?: string[];
  query?: string;
  limit?: number;
  include_html?: boolean;
  theme?: 'light' | 'dark';
}

export class LegislationTools {
  private service: LegislationService;
  private renderer: LegislationRenderer;

  constructor(db: Pool, embeddingService: EmbeddingService) {
    this.service = new LegislationService(db, embeddingService);
    this.renderer = new LegislationRenderer();
  }

  async getLegislationArticle(args: LegislationToolArgs): Promise<any> {
    if (!args.rada_id || !args.article_number) {
      throw new Error('rada_id and article_number are required');
    }

    logger.info(`Getting article ${args.article_number} from ${args.rada_id}`);

    const article = await this.service.getArticle(args.rada_id, args.article_number);
    
    if (!article) {
      return {
        error: `Article ${args.article_number} not found in legislation ${args.rada_id}`,
        suggestion: 'Check if the article number is correct or if the legislation is loaded in the database',
      };
    }

    const response: any = {
      rada_id: article.rada_id,
      article_number: article.article_number,
      title: article.title,
      full_text: article.full_text,
      url: article.url,
      metadata: article.metadata,
    };

    if (args.include_html) {
      response.html = this.renderer.renderArticleHTML(article, {
        theme: args.theme || 'light',
        format: 'full',
      });
    }

    return response;
  }

  async getLegislationSection(args: LegislationToolArgs): Promise<any> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const radaId = args.rada_id ? String(args.rada_id).trim() : '';
    const articleNumber = args.article_number ? String(args.article_number).trim() : '';

    let resolved = radaId && articleNumber ? { radaId, articleNumber } : null;
    if (!resolved && query) {
      resolved = parseLegislationReference(query);
    }

    if (!resolved) {
      throw new Error('Provide either (rada_id + article_number) or query like "ст. 625 ЦК"');
    }

    logger.info('Getting legislation section', {
      rada_id: resolved.radaId,
      article_number: resolved.articleNumber,
      from_query: Boolean(query) && !(radaId && articleNumber),
    });

    const article = await this.service.getArticle(resolved.radaId, resolved.articleNumber);
    if (!article) {
      return {
        error: `Article ${resolved.articleNumber} not found in legislation ${resolved.radaId}`,
        suggestion: 'Check if the article number is correct or if the legislation is available',
      };
    }

    const response: any = {
      rada_id: article.rada_id,
      article_number: article.article_number,
      title: article.title,
      full_text: article.full_text,
      url: article.url,
      metadata: article.metadata,
      resolved_from: query && !(radaId && articleNumber) ? { query } : undefined,
    };

    if (args.include_html) {
      response.html = this.renderer.renderArticleHTML(article, {
        theme: args.theme || 'light',
        format: 'full',
      });
    }

    return response;
  }

  async getLegislationArticles(args: LegislationToolArgs): Promise<any> {
    if (!args.rada_id || !args.article_numbers || args.article_numbers.length === 0) {
      throw new Error('rada_id and article_numbers array are required');
    }

    logger.info(`Getting ${args.article_numbers.length} articles from ${args.rada_id}`);

    const articles = await this.service.getMultipleArticles(args.rada_id, args.article_numbers);

    if (articles.length === 0) {
      return {
        error: `No articles found for ${args.rada_id}`,
        requested: args.article_numbers,
      };
    }

    const response: any = {
      rada_id: args.rada_id,
      total_found: articles.length,
      articles: articles.map(a => ({
        article_number: a.article_number,
        title: a.title,
        full_text: a.full_text,
        url: a.url,
      })),
    };

    if (args.include_html) {
      const structure = await this.service.getLegislationStructure(args.rada_id);
      response.html = this.renderer.renderMultipleArticlesHTML(
        articles,
        structure?.title || args.rada_id,
        {
          includeNavigation: true,
          highlightArticles: args.article_numbers,
          theme: args.theme || 'light',
        }
      );
    }

    return response;
  }

  async searchLegislation(args: LegislationToolArgs): Promise<any> {
    if (!args.query) {
      throw new Error('query is required');
    }

    const limit = args.limit || 10;
    logger.info(`Searching legislation: "${args.query}" (limit: ${limit})`);

    const directRef = parseLegislationReference(args.query);
    if (directRef) {
      const article = await this.service.getArticle(directRef.radaId, directRef.articleNumber);
      if (!article) {
        return {
          query: args.query,
          total_found: 0,
          articles: [],
          suggestion: `Article ${directRef.articleNumber} not found in ${directRef.radaId}`,
        };
      }

      const response: any = {
        query: args.query,
        resolved_reference: {
          rada_id: directRef.radaId,
          article_number: directRef.articleNumber,
        },
        total_found: 1,
        articles: [
          {
            rada_id: article.rada_id,
            article_number: article.article_number,
            title: article.title,
            full_text: article.full_text,
            url: article.url,
          },
        ],
      };

      if (args.include_html) {
        response.html = this.renderer.renderArticleHTML(article, {
          theme: args.theme || 'light',
          format: 'full',
        });
      }

      return response;
    }

    const articles = await this.service.findRelevantArticles(
      args.query,
      args.rada_id,
      limit
    );

    if (articles.length === 0) {
      return {
        query: args.query,
        total_found: 0,
        articles: [],
        suggestion: 'Try a different search query or check if the legislation is loaded',
      };
    }

    const response: any = {
      query: args.query,
      total_found: articles.length,
      articles: articles.map(a => ({
        rada_id: a.rada_id,
        article_number: a.article_number,
        title: a.title,
        full_text: a.full_text.substring(0, 500) + '...',
        url: a.url,
      })),
    };

    if (args.include_html && articles.length > 0) {
      const firstRadaId = articles[0].rada_id;
      const structure = await this.service.getLegislationStructure(firstRadaId);
      response.html = this.renderer.renderMultipleArticlesHTML(
        articles,
        structure?.title || 'Результати пошуку',
        {
          includeNavigation: false,
          theme: args.theme || 'light',
        }
      );
    }

    return response;
  }

  async getLegislationStructure(args: LegislationToolArgs): Promise<any> {
    if (!args.rada_id) {
      throw new Error('rada_id is required');
    }

    logger.info(`Getting structure for ${args.rada_id}`);

    const structure = await this.service.getLegislationStructure(args.rada_id);

    if (!structure) {
      return {
        error: `Legislation ${args.rada_id} not found`,
        suggestion: 'Load the legislation first using ensureLegislationExists',
      };
    }

    return {
      rada_id: structure.rada_id,
      title: structure.title,
      short_title: structure.short_title,
      type: structure.type,
      total_articles: structure.total_articles,
      table_of_contents: structure.table_of_contents,
      articles_summary: structure.articles.slice(0, 20).map((a: any) => ({
        article_number: a.article_number,
        title: a.title,
        byte_size: a.byte_size,
      })),
    };
  }

  async extractLegislationReferences(text: string): Promise<any[]> {
    const references: any[] = [];
    
    const patterns = [
      { regex: /стаття\s+(\d+(?:-\d+)?)\s+ЦПК/gi, rada_id: '1618-15', code: 'ЦПК' },
      { regex: /стаття\s+(\d+(?:-\d+)?)\s+ГПК/gi, rada_id: '435-15', code: 'ГПК' },
      { regex: /стаття\s+(\d+(?:-\d+)?)\s+КАС/gi, rada_id: '2747-15', code: 'КАС' },
      { regex: /стаття\s+(\d+(?:-\d+)?)\s+КПК/gi, rada_id: '4651-17', code: 'КПК' },
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        const articleNumber = match[1];
        
        try {
          const article = await this.service.getArticle(pattern.rada_id, articleNumber);
          if (article) {
            references.push({
              code: pattern.code,
              rada_id: pattern.rada_id,
              article_number: articleNumber,
              title: article.title,
              full_text: article.full_text,
              url: article.url,
            });
          }
        } catch (error: any) {
          logger.warn(`Failed to fetch article ${articleNumber} from ${pattern.rada_id}:`, error.message);
        }
      }
    }

    return references;
  }

  getToolDefinitions() {
    return [
      {
        name: 'get_legislation_article',
        description: 'Отримати повний текст конкретної статті законодавчого акту (ЦПК, ГПК, КАС, КПК). Використовуйте для отримання точного тексту норми права.',
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту на zakon.rada.gov.ua (наприклад, "1618-15" для ЦПК, "435-15" для ГПК, "2747-15" для КАС, "4651-17" для КПК)',
            },
            article_number: {
              type: 'string',
              description: 'Номер статті (наприклад, "354", "354-1")',
            },
            include_html: {
              type: 'boolean',
              description: 'Чи включати форматований HTML (за замовчуванням false)',
            },
            theme: {
              type: 'string',
              enum: ['light', 'dark'],
              description: 'Тема для HTML (за замовчуванням light)',
            },
          },
          required: ['rada_id', 'article_number'],
        },
      },
      {
        name: 'get_legislation_section',
        description: 'Отримати точний фрагмент/статтю за посиланням (наприклад, "ст. 625 ЦК") або за (rada_id + article_number). Повертає повний текст статті та посилання на джерело.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Посилання або короткий запит виду "ст. 625 ЦК" / "ст. 44 ПКУ" / "ст. 354 ЦПК"',
            },
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту (наприклад, "435-15" для ЦК, "436-15" для ГК, "2755-17" для ПКУ)',
            },
            article_number: {
              type: 'string',
              description: 'Номер статті (наприклад, "625", "44", "354-1")',
            },
            include_html: {
              type: 'boolean',
              description: 'Чи включати форматований HTML (за замовчуванням false)',
            },
            theme: {
              type: 'string',
              enum: ['light', 'dark'],
              description: 'Тема для HTML (за замовчуванням light)',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_legislation_articles',
        description: 'Отримати кілька статей законодавчого акту одночасно. Корисно для отримання повного контексту (наприклад, статті 354-356 ЦПК про апеляційне оскарження).',
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту',
            },
            article_numbers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Масив номерів статей (наприклад, ["354", "355", "356"])',
            },
            include_html: {
              type: 'boolean',
              description: 'Чи включати форматований HTML з навігацією',
            },
            theme: {
              type: 'string',
              enum: ['light', 'dark'],
            },
          },
          required: ['rada_id', 'article_numbers'],
        },
      },
      {
        name: 'search_legislation',
        description: 'Семантичний пошук релевантних статей законодавства за запитом. Використовує векторний пошук для знаходження найбільш релевантних норм.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (наприклад, "поновлення пропущеного строку", "підстави для залишення позову без розгляду")',
            },
            rada_id: {
              type: 'string',
              description: 'Опціонально: обмежити пошук конкретним законодавчим актом',
            },
            limit: {
              type: 'number',
              description: 'Максимальна кількість результатів (за замовчуванням 10)',
            },
            include_html: {
              type: 'boolean',
              description: 'Чи включати форматований HTML',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_legislation_structure',
        description: 'Отримати структуру законодавчого акту (зміст, розділи, глави, список статей). Корисно для навігації по великому документу.',
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту',
            },
          },
          required: ['rada_id'],
        },
      },
    ];
  }
}
