import { Pool } from 'pg';
import { RadaLegislationAdapter, LegislationArticle } from '../adapters/rada-legislation-adapter';
import { logger } from '../utils/logger';
import { EmbeddingService } from './embedding-service';
import { createHash } from 'crypto';

export interface LegislationReference {
  rada_id: string;
  article_number: string;
  title?: string;
  full_text: string;
  full_text_html?: string;
  url: string;
  metadata?: any;
}

export interface LegislationSearchResult {
  articles: LegislationArticle[];
  total_found: number;
  legislation_title: string;
  rada_id: string;
}

export function parseLegislationReference(text: string): { radaId: string; articleNumber: string } | null {
  const input = String(text || '').trim();
  if (!input) return null;

  const codeMap: Record<string, string> = {
    'ЦПК': '1618-15',
    'ГПК': '1798-12',
    'КАС': '2747-15',
    'КПК': '4651-17',
    'ЦК': '435-15',
    'ГК': '436-15',
    'ПКУ': '2755-17',
    'ПОДАТКОВИЙ КОДЕКС': '2755-17',
  };

  const normalized = input
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();

  const patterns: Array<{ regex: RegExp; codeGroupIndex: number; articleGroupIndex: number } | { regex: RegExp; radaIdIndex: number; articleIndex: number }> = [
    // Note: don't use \b for Cyrillic words (JS \b is ASCII-centric)
    { regex: /(?:^|\s)ст\.?\s*(\d+(?:-\d+)?)\s*(ЦПК|ГПК|КАС|КПК|ЦК|ГК|ПКУ)(?=\s|$|[.,;:])/iu, codeGroupIndex: 2, articleGroupIndex: 1 },
    { regex: /(?:^|\s)(ЦПК|ГПК|КАС|КПК|ЦК|ГК|ПКУ)\s*ст\.?\s*(\d+(?:-\d+)?)(?=\s|$|[.,;:])/iu, codeGroupIndex: 1, articleGroupIndex: 2 },
    { regex: /(?:^|\s)статт(?:я|і)\s*(\d+(?:-\d+)?)\s*(ЦПК|ГПК|КАС|КПК|ЦК|ГК|ПКУ)(?=\s|$|[.,;:])/iu, codeGroupIndex: 2, articleGroupIndex: 1 },
    { regex: /(?:^|\s)(\d{3,4}-\d{2}).*?ст\.?\s*(\d+(?:-\d+)?)(?=\s|$|[.,;:])/iu, radaIdIndex: 1, articleIndex: 2 },
  ];

  for (const p of patterns) {
    const match = normalized.match(p.regex);
    if (!match) continue;

    if ('radaIdIndex' in p) {
      const radaId = match[p.radaIdIndex];
      const articleNumber = match[p.articleIndex];
      if (radaId && articleNumber) {
        return { radaId, articleNumber };
      }
      continue;
    }

    const code = String(match[p.codeGroupIndex] || '').toUpperCase();
    const articleNumber = String(match[p.articleGroupIndex] || '').trim();
    const radaId = codeMap[code];
    if (radaId && articleNumber) {
      return { radaId, articleNumber };
    }
  }

  const longForm = normalized.toUpperCase();
  const longFormMatch = longForm.match(/(?:^|\s)ст\.?\s*(\d+(?:-\d+)?)(?=\s|$|[.,;:])/iu);
  if (longFormMatch) {
    const articleNumber = longFormMatch[1];
    if (longForm.includes('ПОДАТКОВ') && codeMap['ПОДАТКОВИЙ КОДЕКС']) {
      return { radaId: codeMap['ПОДАТКОВИЙ КОДЕКС'], articleNumber };
    }
  }

  return null;
}

export class LegislationService {
  private adapter: RadaLegislationAdapter;
  private embeddingService: EmbeddingService;
  private db: Pool;

  constructor(db: Pool, embeddingService: EmbeddingService) {
    this.db = db;
    this.adapter = new RadaLegislationAdapter(db);
    this.embeddingService = embeddingService;
  }

  async ensureLegislationExists(radaId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT id FROM legislation WHERE rada_id = $1',
      [radaId]
    );

    if (result.rows.length > 0) {
      return true;
    }

    logger.info(`Legislation ${radaId} not found in database, fetching...`);
    try {
      const { metadata, articles } = await this.adapter.fetchLegislation(radaId);
      await this.adapter.saveLegislationToDatabase(metadata, articles);
      
      await this.indexArticlesForVectorSearch(radaId);
      
      return true;
    } catch (error: any) {
      logger.error(`Failed to fetch and save legislation ${radaId}:`, error.message);
      return false;
    }
  }

  async getArticle(radaId: string, articleNumber: string): Promise<LegislationReference | null> {
    await this.ensureLegislationExists(radaId);

    const article = await this.adapter.getArticleByNumber(radaId, articleNumber);
    if (!article) {
      return null;
    }

    return {
      rada_id: radaId,
      article_number: articleNumber,
      title: article.title,
      full_text: article.full_text,
      full_text_html: article.full_text_html,
      url: `https://zakon.rada.gov.ua/laws/show/${radaId}#n${articleNumber}`,
      metadata: article.metadata,
    };
  }

  async getMultipleArticles(radaId: string, articleNumbers: string[]): Promise<LegislationReference[]> {
    await this.ensureLegislationExists(radaId);

    const result = await this.db.query(
      `SELECT la.*, l.rada_id
       FROM legislation_articles la
       JOIN legislation l ON la.legislation_id = l.id
       WHERE l.rada_id = $1 AND la.article_number = ANY($2) AND la.is_current = true`,
      [radaId, articleNumbers]
    );

    return result.rows.map((row: any) => ({
      rada_id: radaId,
      article_number: row.article_number,
      title: row.title,
      full_text: row.full_text,
      full_text_html: row.full_text_html,
      url: `https://zakon.rada.gov.ua/laws/show/${radaId}#n${row.article_number}`,
      metadata: row.metadata,
    }));
  }

  async searchLegislation(query: string, radaId?: string, limit: number = 10): Promise<LegislationSearchResult[]> {
    if (radaId) {
      await this.ensureLegislationExists(radaId);
    }

    const articles = await this.adapter.searchArticles(query, radaId, limit);

    const groupedByLegislation = articles.reduce((acc: any, article: any) => {
      const key = article.rada_id;
      if (!acc[key]) {
        acc[key] = {
          rada_id: article.rada_id,
          legislation_title: article.legislation_title,
          articles: [],
        };
      }
      acc[key].articles.push(article);
      return acc;
    }, {});

    return Object.values(groupedByLegislation).map((group: any) => ({
      articles: group.articles,
      total_found: group.articles.length,
      legislation_title: group.legislation_title,
      rada_id: group.rada_id,
    }));
  }

  async getLegislationStructure(radaId: string): Promise<any> {
    await this.ensureLegislationExists(radaId);

    const result = await this.db.query(
      `SELECT 
         l.title,
         l.short_title,
         l.type,
         l.total_articles,
         l.structure_metadata,
         json_agg(
           json_build_object(
             'article_number', la.article_number,
             'title', la.title,
             'section_number', la.section_number,
             'chapter_number', la.chapter_number,
             'byte_size', la.byte_size
           ) ORDER BY la.article_number
         ) as articles
       FROM legislation l
       LEFT JOIN legislation_articles la ON l.id = la.legislation_id AND la.is_current = true
       WHERE l.rada_id = $1
       GROUP BY l.id`,
      [radaId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const data = result.rows[0];
    return {
      rada_id: radaId,
      title: data.title,
      short_title: data.short_title,
      type: data.type,
      total_articles: data.total_articles,
      structure: data.structure_metadata || {},
      articles: data.articles || [],
      table_of_contents: this.buildTableOfContents(data.articles || []),
    };
  }

  private buildTableOfContents(articles: any[]): any[] {
    const toc: any[] = [];
    let currentSection: any = null;
    let currentChapter: any = null;

    for (const article of articles) {
      if (article.section_number && (!currentSection || currentSection.number !== article.section_number)) {
        currentSection = {
          type: 'section',
          number: article.section_number,
          articles: [],
        };
        toc.push(currentSection);
        currentChapter = null;
      }

      if (article.chapter_number && (!currentChapter || currentChapter.number !== article.chapter_number)) {
        currentChapter = {
          type: 'chapter',
          number: article.chapter_number,
          articles: [],
        };
        if (currentSection) {
          currentSection.chapters = currentSection.chapters || [];
          currentSection.chapters.push(currentChapter);
        } else {
          toc.push(currentChapter);
        }
      }

      const articleEntry = {
        article_number: article.article_number,
        title: article.title,
        byte_size: article.byte_size,
      };

      if (currentChapter) {
        currentChapter.articles.push(articleEntry);
      } else if (currentSection) {
        currentSection.articles.push(articleEntry);
      } else {
        toc.push(articleEntry);
      }
    }

    return toc;
  }

  async indexArticlesForVectorSearch(radaId: string): Promise<void> {
    logger.info(`Starting vector indexing for legislation ${radaId}`);

    const result = await this.db.query(
      `SELECT la.id, la.article_number, la.full_text, la.section_number, la.chapter_number, la.title
       FROM legislation_articles la
       JOIN legislation l ON la.legislation_id = l.id
       WHERE l.rada_id = $1 AND la.is_current = true`,
      [radaId]
    );

    const articles = result.rows;
    let totalChunks = 0;

    for (const article of articles) {
      const chunks = this.adapter.createArticleChunks(article);

      for (const chunk of chunks) {
        try {
          const embedding = await this.embeddingService.generateEmbedding(chunk.text);

          // Create UUID-based vector ID (Qdrant requires UUID or unsigned integer)
          // Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (UUID v4 style from MD5 hash)
          const idString = `leg_${radaId}_art_${article.article_number}_chunk_${chunk.chunk_index}`;
          const hash = createHash('md5').update(idString).digest('hex');
          const vectorId = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;

          await this.embeddingService.upsertVector(
            vectorId,
            embedding,
            {
              rada_id: radaId,
              article_id: article.id,
              article_number: article.article_number,
              section_number: article.section_number,
              chapter_number: article.chapter_number,
              article_title: article.title,
              chunk_index: chunk.chunk_index,
              text: chunk.text,
              context_before: chunk.context_before,
              context_after: chunk.context_after,
              document_type: 'legislation',
            }
          );

          await this.db.query(
            `INSERT INTO legislation_chunks 
             (article_id, legislation_id, chunk_index, text, vector_id, context_before, context_after, metadata)
             SELECT $1, l.id, $2, $3, $4, $5, $6, $7
             FROM legislation l
             WHERE l.rada_id = $8
             ON CONFLICT (article_id, chunk_index) DO UPDATE SET
               text = EXCLUDED.text,
               vector_id = EXCLUDED.vector_id`,
            [
              article.id,
              chunk.chunk_index,
              chunk.text,
              vectorId,
              chunk.context_before,
              chunk.context_after,
              chunk.metadata,
              radaId,
            ]
          );

          totalChunks++;
        } catch (error: any) {
          logger.error(`Failed to index chunk for article ${article.article_number}:`, error.message);
        }
      }
    }

    logger.info(`Indexed ${totalChunks} chunks for ${articles.length} articles in legislation ${radaId}`);
  }

  async findRelevantArticles(query: string, radaId?: string, limit: number = 5): Promise<LegislationReference[]> {
    try {
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);
      
      const filter: any = { document_type: 'legislation' };
      if (radaId) {
        filter.rada_id = radaId;
      }

      const searchResults = await this.embeddingService.searchVectors(queryEmbedding, limit * 2, filter);

      const articleIds = [...new Set(searchResults.map((r: any) => r.payload.article_id))].slice(0, limit);

      const result = await this.db.query(
        `SELECT la.*, l.rada_id
         FROM legislation_articles la
         JOIN legislation l ON la.legislation_id = l.id
         WHERE la.id = ANY($1)`,
        [articleIds]
      );

      return result.rows.map((row: any) => ({
        rada_id: row.rada_id,
        article_number: row.article_number,
        title: row.title,
        full_text: row.full_text,
        full_text_html: row.full_text_html,
        url: `https://zakon.rada.gov.ua/laws/show/${row.rada_id}#n${row.article_number}`,
        metadata: row.metadata,
      }));
    } catch (error: any) {
      logger.error('Vector search failed, falling back to text search:', error.message);
      const results = await this.searchLegislation(query, radaId, limit);
      return results.flatMap(r => r.articles.map((a: any) => ({
        rada_id: r.rada_id,
        article_number: a.article_number,
        title: a.title,
        full_text: a.full_text,
        full_text_html: a.full_text_html,
        url: `https://zakon.rada.gov.ua/laws/show/${r.rada_id}#n${a.article_number}`,
        metadata: a.metadata,
      })));
    }
  }

  parseArticleReference(text: string): { radaId: string; articleNumber: string } | null {
    return parseLegislationReference(text);
  }
}
