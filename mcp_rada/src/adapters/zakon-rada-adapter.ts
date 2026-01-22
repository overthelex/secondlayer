/**
 * Adapter for zakon.rada.gov.ua (Ukrainian legislation)
 * Fetches law texts, Constitution, codes, etc.
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import { KNOWN_LAWS, ZakonRadaLawResponse, ZakonRadaSearchResult, ZakonRadaAPIError } from '../types/rada';

export class ZakonRadaAdapter {
  private client: AxiosInstance;
  private baseURL = 'https://zakon.rada.gov.ua';
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 500; // 500ms between requests

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'RADA-MCP/1.0 (compatible; Mozilla/5.0)',
        'Accept-Language': 'uk,en;q=0.9',
      },
    });

    logger.info('ZakonRadaAdapter initialized');
  }

  /**
   * Rate limiting: ensure minimum interval between requests
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Resolve law alias to official number
   * Example: "constitution" -> "254к/96-вр"
   */
  resolveLawNumber(aliasOrNumber: string): string {
    const normalized = aliasOrNumber.toLowerCase().trim();
    return KNOWN_LAWS[normalized] || aliasOrNumber;
  }

  /**
   * Fetch law text by number
   * Example: fetchLawText("254к/96-вр") or fetchLawText("constitution")
   */
  async fetchLawText(lawIdentifier: string): Promise<ZakonRadaLawResponse> {
    await this.waitForRateLimit();

    const lawNumber = this.resolveLawNumber(lawIdentifier);
    const endpoint = `/laws/show/${lawNumber}`;
    logger.info('Fetching law text', { lawIdentifier, lawNumber });

    try {
      const response = await this.client.get(endpoint);
      const html = response.data;

      // Parse HTML with Cheerio
      const $ = cheerio.load(html);

      // Extract title
      const title = $('h1.title').first().text().trim() ||
                    $('.document-title').first().text().trim() ||
                    $('title').first().text().trim();

      // Extract law type and dates
      const metaText = $('.document-meta, .law-meta').text();
      const adoptionDateMatch = metaText.match(/від\s+(\d{2}\.\d{2}\.\d{4})/);
      const adoptionDate = adoptionDateMatch ? adoptionDateMatch[1] : undefined;

      // Extract main text
      let mainText = '';
      const articleContainer = $('#article-container, .article-container, .law-text');
      if (articleContainer.length > 0) {
        mainText = articleContainer.text().trim();
      } else {
        // Fallback: extract from body
        mainText = $('body').text().trim();
      }

      // Extract plain text (remove excessive whitespace)
      const plainText = mainText.replace(/\s+/g, ' ').trim();

      // Try to extract articles if structured
      const articles = this.extractArticles($, html);

      const result: ZakonRadaLawResponse = {
        number: lawNumber,
        title,
        date_adoption: adoptionDate,
        url: `${this.baseURL}${endpoint}`,
        html,
        text: plainText,
      };

      logger.info('Law text fetched successfully', {
        lawNumber,
        titleLength: title.length,
        textLength: plainText.length,
        articleCount: articles?.length || 0
      });

      return result;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to fetch law ${lawNumber}: ${error.message}`;
      logger.error(message, { statusCode, lawNumber });
      throw new ZakonRadaAPIError(message, statusCode, lawNumber);
    }
  }

  /**
   * Extract articles from law HTML
   */
  private extractArticles($: cheerio.CheerioAPI, html: string): { number: string; title?: string; text: string }[] {
    const articles: { number: string; title?: string; text: string }[] = [];

    // Try different article patterns
    $('.article, article, [class*="article"]').each((i, elem) => {
      const articleElem = $(elem);
      const articleNumberElem = articleElem.find('.article-number, .art-num, [class*="number"]');
      const articleTitleElem = articleElem.find('.article-title, .art-title, h3, h4');
      const articleTextElem = articleElem.find('.article-text, .art-text, p');

      const number = articleNumberElem.text().trim() || `Стаття ${i + 1}`;
      const title = articleTitleElem.text().trim() || undefined;
      const text = articleTextElem.text().trim() || articleElem.text().trim();

      if (text && text.length > 10) {
        articles.push({ number, title, text });
      }
    });

    // Fallback: try to find by patterns like "Стаття 1."
    if (articles.length === 0) {
      const textContent = $.text();
      const articleMatches = textContent.matchAll(/Стаття\s+(\d+[а-яА-Я]?)\.\s*([^\n]+)/g);
      for (const match of articleMatches) {
        articles.push({
          number: `Стаття ${match[1]}`,
          text: match[2].trim(),
        });
      }
    }

    return articles;
  }

  /**
   * Search laws by keyword
   */
  async searchLaws(keyword: string): Promise<ZakonRadaSearchResult[]> {
    await this.waitForRateLimit();

    const endpoint = '/laws/search';
    logger.info('Searching laws', { keyword });

    try {
      const response = await this.client.get(endpoint, {
        params: {
          q: keyword,
        },
      });

      const html = response.data;
      const $ = cheerio.load(html);
      const results: ZakonRadaSearchResult[] = [];

      // Parse search results
      $('.search-result, .result-item, .law-item').each((i, elem) => {
        const resultElem = $(elem);
        const titleElem = resultElem.find('a, .title, h3');
        const title = titleElem.text().trim();
        const url = titleElem.attr('href') || '';
        const snippet = resultElem.find('.snippet, .description, p').text().trim();

        // Extract law number from URL or title
        const numberMatch = url.match(/\/laws\/show\/([^\/]+)/) || title.match(/№\s*([^\s]+)/);
        const number = numberMatch ? numberMatch[1] : '';

        if (title && number) {
          results.push({
            title,
            number,
            url: url.startsWith('http') ? url : `${this.baseURL}${url}`,
            snippet: snippet || undefined,
          });
        }
      });

      logger.info('Search completed', { keyword, resultsCount: results.length });
      return results;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const message = `Failed to search laws for "${keyword}": ${error.message}`;
      logger.error(message, { statusCode, keyword });
      throw new ZakonRadaAPIError(message, statusCode);
    }
  }

  /**
   * Fetch specific article from a law
   */
  async fetchArticle(lawNumber: string, articleNumber: string): Promise<{ number: string; text: string } | null> {
    const lawText = await this.fetchLawText(lawNumber);
    const $ = cheerio.load(lawText.html);

    // Try to find the specific article
    const articlePattern = new RegExp(`Стаття\\s+${articleNumber}[^\\d]`, 'i');
    const textContent = $.text();
    const match = textContent.match(articlePattern);

    if (match) {
      const startIndex = match.index || 0;
      const nextArticleMatch = textContent.slice(startIndex + 50).match(/Стаття\s+\d+/);
      const endIndex = nextArticleMatch
        ? startIndex + 50 + (nextArticleMatch.index || 0)
        : Math.min(startIndex + 2000, textContent.length);

      const articleText = textContent.slice(startIndex, endIndex).trim();

      return {
        number: `Стаття ${articleNumber}`,
        text: articleText,
      };
    }

    logger.warn('Article not found', { lawNumber, articleNumber });
    return null;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/');
      return true;
    } catch (error) {
      logger.error('Zakon RADA API health check failed:', error);
      return false;
    }
  }
}
