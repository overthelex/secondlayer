import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import { Pool } from 'pg';

export interface LegislationMetadata {
  rada_id: string;
  type: 'code' | 'law' | 'regulation';
  title: string;
  short_title?: string;
  full_url: string;
  adoption_date?: Date;
  effective_date?: Date;
  last_amended_date?: Date;
  status: 'active' | 'amended' | 'repealed';
  total_articles?: number;
  total_sections?: number;
  structure_metadata?: any;
}

export interface LegislationArticle {
  article_number: string;
  section_number?: string;
  chapter_number?: string;
  title?: string;
  full_text: string;
  full_text_html?: string;
  part_number?: number;
  paragraph_number?: number;
  notes?: string;
  version_date?: Date;
  byte_size: number;
  metadata?: any;
}

export interface ArticleChunk {
  chunk_index: number;
  text: string;
  context_before?: string;
  context_after?: string;
  metadata: any;
}

export class RadaLegislationAdapter {
  private httpClient: AxiosInstance;
  private db: Pool;
  private readonly BASE_URL = 'https://zakon.rada.gov.ua';
  private readonly CHUNK_SIZE = 500; // characters per chunk for vector search
  private readonly CHUNK_OVERLAP = 100; // overlap between chunks

  constructor(db: Pool) {
    this.db = db;
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SecondLayer/1.0; +https://secondlayer.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      decompress: true,
    });
  }

  async fetchLegislation(radaId: string): Promise<{ metadata: LegislationMetadata; articles: LegislationArticle[] }> {
    // Use /print endpoint for full text with all articles
    const url = `${this.BASE_URL}/laws/show/${radaId}/print`;
    logger.info(`Fetching legislation from ${url}`);

    try {
      const response = await this.httpClient.get(url);
      const html = response.data;
      const $ = cheerio.load(html);

      const metadata = this.extractMetadata($, radaId, url);
      const articles = this.extractArticles($, radaId);

      logger.info(`Extracted ${articles.length} articles from ${radaId}`);
      return { metadata, articles };
    } catch (error: any) {
      logger.error(`Failed to fetch legislation ${radaId}:`, error.message);
      throw error;
    }
  }

  private extractMetadata($: cheerio.CheerioAPI, radaId: string, url: string): LegislationMetadata {
    const titleElement = $('.title, .doc-title, h1').first();
    const title = titleElement.text().trim();
    
    const shortTitle = this.extractShortTitle(title);
    const type = this.determineDocumentType(title, radaId);
    
    const infoBlock = $('.info, .doc-info, .document-info');
    const adoptionDateText = infoBlock.find(':contains("прийнято")').text();
    const effectiveDateText = infoBlock.find(':contains("набрання чинності")').text();
    
    return {
      rada_id: radaId,
      type,
      title,
      short_title: shortTitle,
      full_url: url,
      adoption_date: this.parseDate(adoptionDateText),
      effective_date: this.parseDate(effectiveDateText),
      status: 'active',
    };
  }

  private extractArticles($: cheerio.CheerioAPI, radaId: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];

    // Parse /print endpoint format: <span class=rvts9>Стаття N.</span>
    // Note: cheerio adds quotes to attributes, so we match both class=rvts9 and class="rvts9"
    const bodyHtml = $('body').html() || '';
    const articleRegex = /<span\s+class=["']?rvts9["']?>Стаття\s+(\d+(?:-\d+)?)\.?<\/span>\s*(.*?)(?=<span\s+class=["']?rvts9|$)/gs;

    let match;
    while ((match = articleRegex.exec(bodyHtml)) !== null) {
      const articleNumber = match[1];
      const articleHtml = match[2];

      // Load the article HTML into cheerio for text extraction
      const $article = cheerio.load(`<div>${articleHtml}</div>`);

      // Extract clean text (remove HTML tags, scripts, styles)
      $article('script, style, em').remove();
      const fullText = $article.text()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\{[^}]+\}/g, '') // Remove {...} comments
        .trim();

      if (fullText.length < 10) continue;

      // Try to extract article title from first sentence
      let title: string | undefined;
      const firstSentence = fullText.split(/[.;]/)[0];
      if (firstSentence && firstSentence.length < 200) {
        title = firstSentence.trim();
      }

      articles.push({
        article_number: articleNumber,
        title: title,
        full_text: fullText,
        full_text_html: articleHtml.substring(0, 10000), // Limit HTML size
        byte_size: Buffer.byteLength(fullText, 'utf8'),
        metadata: {
          rada_id: radaId,
          extraction_date: new Date().toISOString(),
          extraction_method: 'print_endpoint',
        },
      });
    }

    // Fallback to old method if no articles found
    if (articles.length === 0) {
      logger.warn(`No articles found with print endpoint parser, trying fallback for ${radaId}`);
      articles.push(...this.extractArticlesFallback($, radaId));
    }

    return articles;
  }

  private extractArticlesFallback($: cheerio.CheerioAPI, radaId: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];
    const bodyText = $('body').text();
    
    const articlePattern = /Стаття\s+(\d+(?:-\d+)?)\.\s*([^\n]+)/gi;
    let match;
    
    while ((match = articlePattern.exec(bodyText)) !== null) {
      const articleNumber = match[1];
      const title = match[2].trim();
      
      const startIndex = match.index;
      const nextMatch = articlePattern.exec(bodyText);
      const endIndex = nextMatch ? nextMatch.index : bodyText.length;
      articlePattern.lastIndex = nextMatch ? nextMatch.index : bodyText.length;
      
      const fullText = bodyText.substring(startIndex, endIndex).trim();
      
      if (fullText.length > 20) {
        articles.push({
          article_number: articleNumber,
          title,
          full_text: fullText,
          byte_size: Buffer.byteLength(fullText, 'utf8'),
          metadata: {
            rada_id: radaId,
            extraction_method: 'fallback',
          },
        });
      }
    }
    
    return articles;
  }

  private extractArticleNumber($el: cheerio.Cheerio<any>): string | null {
    const numberElement = $el.find('.article-number, .number, [class*="num"]').first();
    let numberText = numberElement.text().trim();
    
    if (!numberText) {
      const fullText = $el.text();
      const match = fullText.match(/Стаття\s+(\d+(?:-\d+)?)/i);
      if (match) {
        numberText = match[1];
      }
    }
    
    numberText = numberText.replace(/[^\d-]/g, '');
    return numberText || null;
  }

  private extractArticleText($el: cheerio.Cheerio<any>): string {
    const clone = $el.clone();
    clone.find('script, style, .article-number, .number').remove();
    return clone.text().trim().replace(/\s+/g, ' ');
  }

  private extractShortTitle(fullTitle: string): string | undefined {
    const patterns = [
      /\(([А-ЯІЇЄҐ]{2,}(?:\s+України)?)\)/,
      /([А-ЯІЇЄҐ]{2,}\s+України)/,
    ];
    
    for (const pattern of patterns) {
      const match = fullTitle.match(pattern);
      if (match) return match[1];
    }
    
    return undefined;
  }

  private determineDocumentType(title: string, radaId: string): 'code' | 'law' | 'regulation' {
    if (title.includes('Кодекс') || radaId.includes('кодекс')) return 'code';
    if (title.includes('Закон') || radaId.match(/^\d+-\d+$/)) return 'law';
    return 'regulation';
  }

  private parseDate(text: string): Date | undefined {
    const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (match) {
      return new Date(`${match[3]}-${match[2]}-${match[1]}`);
    }
    return undefined;
  }

  async saveLegislationToDatabase(
    metadata: LegislationMetadata,
    articles: LegislationArticle[]
  ): Promise<{ legislationId: string; articleIds: string[] }> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      const legislationResult = await client.query(
        `INSERT INTO legislation (rada_id, type, title, short_title, full_url, adoption_date, 
          effective_date, last_amended_date, status, total_articles, structure_metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (rada_id) DO UPDATE SET
           title = EXCLUDED.title,
           short_title = EXCLUDED.short_title,
           last_amended_date = EXCLUDED.last_amended_date,
           total_articles = EXCLUDED.total_articles,
           updated_at = NOW()
         RETURNING id`,
        [
          metadata.rada_id,
          metadata.type,
          metadata.title,
          metadata.short_title,
          metadata.full_url,
          metadata.adoption_date,
          metadata.effective_date,
          metadata.last_amended_date,
          metadata.status,
          articles.length,
          metadata.structure_metadata || {},
        ]
      );

      const legislationId = legislationResult.rows[0].id;
      const articleIds: string[] = [];

      for (const article of articles) {
        const articleResult = await client.query(
          `INSERT INTO legislation_articles 
           (legislation_id, article_number, section_number, chapter_number, title, 
            full_text, full_text_html, part_number, paragraph_number, notes, 
            version_date, is_current, byte_size, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (legislation_id, article_number, version_date) DO UPDATE SET
             full_text = EXCLUDED.full_text,
             full_text_html = EXCLUDED.full_text_html,
             byte_size = EXCLUDED.byte_size,
             updated_at = NOW()
           RETURNING id`,
          [
            legislationId,
            article.article_number,
            article.section_number,
            article.chapter_number,
            article.title,
            article.full_text,
            article.full_text_html,
            article.part_number,
            article.paragraph_number,
            article.notes,
            article.version_date || new Date(),
            true,
            article.byte_size,
            article.metadata || {},
          ]
        );

        articleIds.push(articleResult.rows[0].id);
      }

      await client.query('COMMIT');
      logger.info(`Saved legislation ${metadata.rada_id} with ${articles.length} articles`);

      return { legislationId, articleIds };
    } catch (error: any) {
      await client.query('ROLLBACK');
      logger.error(`Failed to save legislation to database:`, error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  createArticleChunks(article: LegislationArticle): ArticleChunk[] {
    const chunks: ArticleChunk[] = [];
    const text = article.full_text;
    
    if (text.length <= this.CHUNK_SIZE) {
      chunks.push({
        chunk_index: 0,
        text,
        metadata: {
          article_number: article.article_number,
          section_number: article.section_number,
          chapter_number: article.chapter_number,
          title: article.title,
        },
      });
      return chunks;
    }

    let startIndex = 0;
    let chunkIndex = 0;

    while (startIndex < text.length) {
      const endIndex = Math.min(startIndex + this.CHUNK_SIZE, text.length);
      const chunkText = text.substring(startIndex, endIndex);

      const contextBefore = startIndex > 0 
        ? text.substring(Math.max(0, startIndex - this.CHUNK_OVERLAP), startIndex)
        : undefined;

      const contextAfter = endIndex < text.length
        ? text.substring(endIndex, Math.min(text.length, endIndex + this.CHUNK_OVERLAP))
        : undefined;

      chunks.push({
        chunk_index: chunkIndex,
        text: chunkText,
        context_before: contextBefore,
        context_after: contextAfter,
        metadata: {
          article_number: article.article_number,
          section_number: article.section_number,
          chapter_number: article.chapter_number,
          title: article.title,
          chunk_position: `${chunkIndex + 1}/${Math.ceil(text.length / this.CHUNK_SIZE)}`,
        },
      });

      startIndex += this.CHUNK_SIZE - this.CHUNK_OVERLAP;
      chunkIndex++;
    }

    return chunks;
  }

  async getArticleByNumber(radaId: string, articleNumber: string): Promise<LegislationArticle | null> {
    const result = await this.db.query(
      `SELECT la.* 
       FROM legislation_articles la
       JOIN legislation l ON la.legislation_id = l.id
       WHERE l.rada_id = $1 AND la.article_number = $2 AND la.is_current = true
       LIMIT 1`,
      [radaId, articleNumber]
    );

    if (result.rows.length === 0) return null;

    return result.rows[0];
  }

  async searchArticles(query: string, radaId?: string, limit: number = 10): Promise<any[]> {
    let sql = `
      SELECT la.*, l.rada_id, l.title as legislation_title, l.short_title
      FROM legislation_articles la
      JOIN legislation l ON la.legislation_id = l.id
      WHERE la.is_current = true
        AND (
          to_tsvector('ukrainian', la.full_text) @@ plainto_tsquery('ukrainian', $1)
          OR la.article_number ILIKE $2
        )
    `;

    const params: any[] = [query, `%${query}%`];

    if (radaId) {
      sql += ` AND l.rada_id = $3`;
      params.push(radaId);
    }

    sql += ` ORDER BY ts_rank(to_tsvector('ukrainian', la.full_text), plainto_tsquery('ukrainian', $1)) DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params);
    return result.rows;
  }
}
