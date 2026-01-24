/**
 * Legislation Service
 * CRUD operations for legislation texts with intelligent PostgreSQL caching (30-day TTL)
 */

import { Database } from '../database/database';
import { logger } from '../utils/logger';
import { ZakonRadaAdapter } from '../adapters/zakon-rada-adapter';
import { v4 as uuidv4 } from 'uuid';
import {
  Legislation,
  LegislationSearchParams,
  LegislationResult,
  LawArticle,
  LawChapter,
} from '../types';

export class LegislationService {
  private cacheTTLSeconds: number;

  constructor(
    private db: Database,
    private zakonAdapter: ZakonRadaAdapter
  ) {
    // Default: 30 days, can be overridden by env
    this.cacheTTLSeconds = parseInt(process.env.CACHE_TTL_LAWS || '2592000', 10);
    logger.info('LegislationService initialized', { cacheTTL: this.cacheTTLSeconds });
  }

  /**
   * Get legislation by law number or alias with cache-first strategy
   */
  async getLegislation(
    lawIdentifier: string,
    forceRefresh: boolean = false
  ): Promise<Legislation | null> {
    try {
      // Resolve alias to official number
      const lawNumber = this.zakonAdapter.resolveLawNumber(lawIdentifier);

      // Step 1: Check cache if not forcing refresh
      if (!forceRefresh) {
        const cached = await this.getCachedLegislation(lawNumber);
        if (cached) {
          logger.debug('Legislation found in cache', { lawNumber });
          return cached;
        }
      }

      // Step 2: Fetch from Zakon RADA API
      logger.info('Fetching legislation from Zakon RADA API', {
        lawIdentifier,
        lawNumber,
      });
      const rawData = await this.zakonAdapter.fetchLawText(lawIdentifier);

      // Step 3: Transform and upsert to database
      const legislation = this.transformRawLegislation(rawData);
      await this.upsertLegislation(legislation);

      return legislation;
    } catch (error: any) {
      logger.error('Failed to get legislation', {
        lawIdentifier,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Search legislation with filters
   */
  async searchLegislation(
    params: LegislationSearchParams
  ): Promise<LegislationResult> {
    try {
      // Get legislation
      const legislation = await this.getLegislation(params.law_identifier);

      if (!legislation) {
        return {
          legislation: null as any,
          search_results: [],
        };
      }

      const result: LegislationResult = { legislation };

      // If specific article requested
      if (params.article) {
        const article = await this.getArticle(
          params.law_identifier,
          params.article
        );
        if (article) {
          result.article = article;
        }
      }

      // If text search requested
      if (params.search_text && legislation.articles) {
        const searchResults = this.searchInArticles(
          legislation.articles,
          params.search_text
        );
        result.search_results = searchResults;
      }

      // If court citations requested
      if (params.include_court_citations) {
        result.court_citations = await this.getCourtCitations(
          legislation.law_number,
          params.article
        );
      }

      logger.info('Legislation search completed', {
        lawIdentifier: params.law_identifier,
        hasArticle: !!result.article,
        searchResultsCount: result.search_results?.length || 0,
        citationsCount: result.court_citations?.length || 0,
      });

      return result;
    } catch (error: any) {
      logger.error('Failed to search legislation', {
        params,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get specific article from legislation
   */
  async getArticle(
    lawIdentifier: string,
    articleNumber: string
  ): Promise<LawArticle | null> {
    try {
      const legislation = await this.getLegislation(lawIdentifier);

      if (!legislation || !legislation.articles) {
        // Try fetching from API directly
        logger.info('Fetching article from API', { lawIdentifier, articleNumber });
        const lawNumber = this.zakonAdapter.resolveLawNumber(lawIdentifier);
        const apiArticle = await this.zakonAdapter.fetchArticle(
          lawNumber,
          articleNumber
        );

        if (apiArticle) {
          return {
            number: apiArticle.number,
            text: apiArticle.text,
          };
        }

        return null;
      }

      // Search in cached articles
      const article = legislation.articles.find(
        (a) =>
          a.number === articleNumber ||
          a.number.includes(articleNumber) ||
          a.number === `Стаття ${articleNumber}`
      );

      return article || null;
    } catch (error: any) {
      logger.error('Failed to get article', {
        lawIdentifier,
        articleNumber,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Search for text within articles
   */
  private searchInArticles(
    articles: LawArticle[],
    searchText: string
  ): { article: LawArticle; relevance: number }[] {
    const results: { article: LawArticle; relevance: number }[] = [];
    const searchLower = searchText.toLowerCase();

    for (const article of articles) {
      const titleMatch = article.title?.toLowerCase().includes(searchLower);
      const textMatch = article.text.toLowerCase().includes(searchLower);

      if (titleMatch || textMatch) {
        // Simple relevance: count occurrences
        const occurrences =
          (article.text.toLowerCase().match(new RegExp(searchLower, 'g')) || [])
            .length +
          (article.title?.toLowerCase().match(new RegExp(searchLower, 'g')) || [])
            .length;

        results.push({
          article,
          relevance: occurrences,
        });
      }
    }

    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);

    return results.slice(0, 10); // Top 10 results
  }

  /**
   * Get court citations for a law
   */
  private async getCourtCitations(
    lawNumber: string,
    article?: string
  ): Promise<any[]> {
    try {
      let query = 'SELECT * FROM law_court_citations WHERE law_number = $1';
      const params: any[] = [lawNumber];

      if (article) {
        query += ' AND law_article = $2';
        params.push(article);
      }

      query += ' ORDER BY citation_count DESC, last_citation_date DESC LIMIT 50';

      const result = await this.db.query(query, params);

      return result.rows.map((row) => ({
        case_number: row.court_case_number,
        case_id: row.court_case_id,
        citation_count: row.citation_count,
        last_citation_date: row.last_citation_date,
        context: row.citation_context,
      }));
    } catch (error: any) {
      logger.error('Failed to get court citations', {
        lawNumber,
        article,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Get cached legislation (only if not expired)
   */
  private async getCachedLegislation(
    lawNumber: string
  ): Promise<Legislation | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM legislation WHERE (law_number = $1 OR law_alias = $1) AND cache_expires_at > NOW()',
        [lawNumber]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        ...row,
        articles: row.articles || [],
        chapters: row.chapters || [],
      } as Legislation;
    } catch (error: any) {
      logger.error('Failed to get cached legislation', {
        lawNumber,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Upsert legislation with new TTL
   */
  private async upsertLegislation(legislation: Legislation): Promise<string> {
    try {
      const id = legislation.id || uuidv4();
      const cacheExpires = new Date(Date.now() + this.cacheTTLSeconds * 1000);

      const query = `
        INSERT INTO legislation (
          id, law_number, law_alias, title, law_type,
          adoption_date, effective_date, status,
          full_text_html, full_text_plain, article_count,
          articles, chapters, url, metadata,
          cached_at, cache_expires_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          NOW(), $16, NOW()
        )
        ON CONFLICT (law_number)
        DO UPDATE SET
          law_alias = EXCLUDED.law_alias,
          title = EXCLUDED.title,
          law_type = EXCLUDED.law_type,
          adoption_date = EXCLUDED.adoption_date,
          effective_date = EXCLUDED.effective_date,
          status = EXCLUDED.status,
          full_text_html = EXCLUDED.full_text_html,
          full_text_plain = EXCLUDED.full_text_plain,
          article_count = EXCLUDED.article_count,
          articles = EXCLUDED.articles,
          chapters = EXCLUDED.chapters,
          url = EXCLUDED.url,
          metadata = legislation.metadata || EXCLUDED.metadata,
          cached_at = NOW(),
          cache_expires_at = EXCLUDED.cache_expires_at,
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        legislation.law_number,
        legislation.law_alias || null,
        legislation.title,
        legislation.law_type || null,
        legislation.adoption_date || null,
        legislation.effective_date || null,
        legislation.status || null,
        legislation.full_text_html || null,
        legislation.full_text_plain || null,
        legislation.article_count || null,
        JSON.stringify(legislation.articles || []),
        JSON.stringify(legislation.chapters || []),
        legislation.url || null,
        JSON.stringify(legislation.metadata || {}),
        cacheExpires,
      ]);

      const savedId = result.rows[0].id;

      logger.debug('Legislation upserted', {
        law_number: legislation.law_number,
        id: savedId,
        cacheExpires,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to upsert legislation', {
        law_number: legislation.law_number,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transform raw Zakon RADA API data to Legislation type
   */
  private transformRawLegislation(raw: any): Legislation {
    // Extract articles from HTML if available
    const articles: LawArticle[] = [];
    const chapters: LawChapter[] = [];

    // Parse articles from text if structured
    if (raw.text) {
      const articleMatches = raw.text.matchAll(
        /Стаття\s+(\d+[а-яА-Я]?)\.\s*([^\n]{0,200})/g
      );
      for (const match of articleMatches) {
        articles.push({
          number: `Стаття ${match[1]}`,
          text: match[2].trim(),
        });
      }
    }

    return {
      id: raw.id || uuidv4(),
      law_number: raw.number,
      law_alias: undefined,
      title: raw.title,
      law_type: raw.type || undefined,
      adoption_date: raw.date_adoption || undefined,
      effective_date: raw.date_effective || undefined,
      status: raw.status || undefined,
      full_text_html: raw.html || undefined,
      full_text_plain: raw.text || undefined,
      article_count: articles.length || undefined,
      articles,
      chapters,
      url: raw.url || undefined,
      metadata: raw,
    };
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<any> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_laws,
          COUNT(CASE WHEN cache_expires_at > NOW() THEN 1 END) as cached_laws,
          COUNT(CASE WHEN full_text_plain IS NOT NULL THEN 1 END) as laws_with_text,
          COUNT(CASE WHEN article_count > 0 THEN 1 END) as laws_with_articles,
          SUM(article_count) as total_articles,
          MIN(adoption_date) as oldest_law_date,
          MAX(adoption_date) as newest_law_date
        FROM legislation
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to get legislation stats:', error);
      return null;
    }
  }
}
