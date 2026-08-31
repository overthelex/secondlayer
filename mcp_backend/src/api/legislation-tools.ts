import type { ICachePort } from '../domain/ports/index.js';
import { LegislationService, normalizeRadaId, parseKmuPrefix } from '../services/legislation-service';
import { LegislationRenderer } from '../services/legislation-renderer';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { logger } from '../utils/logger';
import { BaseToolHandler, ToolDefinition, ToolResult } from './base-tool-handler.js';

export interface LegislationToolArgs {
  rada_id?: string;
  article_number?: string;
  article_numbers?: string[];
  query?: string;
  limit?: number;
  include_html?: boolean;
  include_court_practice?: boolean;
  theme?: 'light' | 'dark';
  as_of_date?: string;
}

/** Per-request dedup cache for search_legislation — prevents repeated searches returning same rada_id */
interface SearchDedup {
  key: string;
  result: any;
  radaIds: Set<string>;
  ts: number;
}

/** Cap for SEARCH/list hits — many articles per response, protects the chat context window (PR #1846). */
const MAX_ARTICLE_TEXT_CHARS = 2000;
/** Cap for an EXPLICIT single-article fetch (get_legislation_section) — the tool promises "повний текст
 * статті", so only pathological outliers get cut (ПКУ ст. 14 ≈ 216K, ст. 346 ≈ 1M chars). */
const MAX_SINGLE_ARTICLE_TEXT_CHARS = 60_000;
/** Total full_text budget for an explicit multi-article fetch (get_legislation_articles) —
 * split across the requested articles, but never below the search-hit cap. */
const MAX_ARTICLES_TOTAL_TEXT_CHARS = 120_000;

function capText(text: string | undefined | null, maxChars: number = MAX_ARTICLE_TEXT_CHARS): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `… [обрізано; повний текст — ${text.length} символів]`;
}

/** Confidence at/above which an AI-resolved article is trusted without semantic supplementation. */
const AI_REF_TRUSTED_CONFIDENCE = 0.9;
/** Min share of distinctive query terms that must appear in the resolved article for it to be "grounded". */
const ARTICLE_GROUNDING_MIN_RATIO = 0.5;
const GROUNDING_TOKEN_MIN_LEN = 5;
/** Compare on a prefix to tolerate Ukrainian inflection (відмінки/числа). */
const GROUNDING_PREFIX_LEN = 6;

/**
 * Heuristic grounding check: does the resolved article's text actually cover the query's
 * distinctive terms? Guards against the AI classifier confidently returning a plausible but
 * off-topic article number (e.g. ст. 265 "склад податку" for a query about ВПО/occupied-territory
 * пільги that lives in ст. 266 / підрозділ 10 розд. XX). Returns the share [0..1] of distinctive
 * query tokens found in the article; callers treat a low share as "supplement with semantic search".
 */
export function articleGroundingRatio(query: string, articleText: string): number {
  const normalize = (s: string) =>
    (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const queryTokens = [
    ...new Set(
      normalize(query)
        .split(' ')
        .filter(t => t.length >= GROUNDING_TOKEN_MIN_LEN)
    ),
  ];
  if (queryTokens.length === 0) return 1; // nothing distinctive to check — don't flag
  const haystack = normalize(articleText);
  const matched = queryTokens.filter(t =>
    haystack.includes(t.slice(0, Math.min(t.length, GROUNDING_PREFIX_LEN)))
  ).length;
  return matched / queryTokens.length;
}

export class LegislationTools extends BaseToolHandler {
  private service: LegislationService;
  private renderer: LegislationRenderer;
  private patternStore?: LegalPatternStore;
  private searchDedup: SearchDedup[] = [];
  private readonly DEDUP_TTL_MS = 300_000;

  constructor(
    service: LegislationService,
    renderer?: LegislationRenderer,
    patternStore?: LegalPatternStore
  ) {
    super();
    this.service = service;
    this.renderer = renderer || new LegislationRenderer();
    this.patternStore = patternStore;
  }

  getLegislationService(): LegislationService {
    return this.service;
  }

  /**
   * Устанавливает Redis клиент для AI-классификации законодательства
   */
  setRedisClient(redis: ICachePort | null): void {
    this.service.setRedisClient(redis);
  }

  async getLegislationSection(args: LegislationToolArgs): Promise<any> {
    const query = typeof args.query === 'string' ? args.query.trim()
      : typeof (args as any).legislation_reference === 'string' ? (args as any).legislation_reference.trim()
      : '';
    const radaId = args.rada_id ? String(args.rada_id).trim() : '';
    const articleNumber = args.article_number ? String(args.article_number).trim() : '';

    let resolved: { radaId: string; articleNumber: string; source?: 'regexp' | 'ai'; confidence?: number } | null = null;

    // Если явно переданы rada_id и article_number, используем их
    if (radaId && articleNumber) {
      resolved = { radaId: normalizeRadaId(radaId), articleNumber };
    }
    // rada_id + query без article_number → векторный поиск по конкретному НПА
    else if (radaId && query && !articleNumber) {
      logger.info('[MCP Tool] get_legislation_section: vector search within legislation', {
        rada_id: radaId,
        query: query.substring(0, 80),
      });

      const relevantArticles = await this.service.findRelevantArticles(query, normalizeRadaId(radaId), 3);
      if (relevantArticles.length > 0) {
        const response: any = {
          rada_id: normalizeRadaId(radaId),
          search_query: query,
          articles: relevantArticles.map(a => ({
            article_number: a.article_number,
            title: a.title,
            full_text: capText(a.full_text),
            url: a.url,
            metadata: a.metadata,
          })),
          resolved_from: { query, method: 'vector_search' },
        };
        return response;
      }

      return {
        error: `No relevant articles found in legislation ${radaId} for query: ${query}`,
        suggestion: 'Try a more specific query or provide an article_number',
      };
    }
    // Иначе пытаемся парсить из query
    else if (query) {
      // Используем AI-классификацию для улучшенного парсинга
      const aiResult = await this.service.parseArticleReferenceWithAI(query);
      if (aiResult) {
        resolved = aiResult;
      }
    }

    if (!resolved) {
      throw new Error('Provide either (rada_id + article_number), (rada_id + query), or query like "ст. 625 ЦК" or "стаття 44 податкового кодексу"');
    }

    // Resolve KMU:/KMU-Р: prefix
    const kmuPrefix = parseKmuPrefix(resolved.radaId);
    if (kmuPrefix) {
      const resolvedId = await this.service.resolveKmuRadaId(kmuPrefix.kmuNumber, kmuPrefix.docType);
      if (resolvedId) {
        resolved.radaId = resolvedId;
      } else {
        const docLabel = kmuPrefix.docType === '-р' ? 'Розпорядження' : 'Постанову';
        return {
          error: `${docLabel} КМУ №${kmuPrefix.kmuNumber} не знайдено на zakon.rada.gov.ua`,
          suggestion: `Перевірте номер ${kmuPrefix.docType === '-р' ? 'розпорядження' : 'постанови'}`,
        };
      }
    }

    logger.info('[MCP Tool] get_legislation_section started', {
      rada_id: resolved.radaId,
      article_number: resolved.articleNumber,
      source: resolved.source || 'explicit',
      confidence: resolved.confidence,
      from_query: Boolean(query) && !(radaId && articleNumber),
      query: query.substring(0, 50)
    });

    const article = await this.service.getArticle(resolved.radaId, resolved.articleNumber, args.as_of_date);
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
      full_text: capText(article.full_text, MAX_SINGLE_ARTICLE_TEXT_CHARS),
      full_text_length: article.full_text?.length,
      url: article.url,
      metadata: article.metadata,
      npa_title: article.npa_title,
      section_number: article.section_number,
      section_title: article.section_title,
      chapter_number: article.chapter_number,
      chapter_title: article.chapter_title,
      resolved_from: query && !(radaId && articleNumber) ? {
        query,
        method: resolved.source || 'explicit',
        confidence: resolved.confidence
      } : undefined,
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

    logger.info('[MCP Tool] get_legislation_articles started', {
      rada_id: args.rada_id,
      article_count: args.article_numbers.length,
      articles: args.article_numbers.join(', ')
    });

    const articles = await this.service.getMultipleArticles(args.rada_id, args.article_numbers, args.as_of_date);

    if (articles.length === 0) {
      return {
        error: `No articles found for ${args.rada_id}`,
        requested: args.article_numbers,
      };
    }

    // Явно названі статті — ділимо загальний бюджет тексту між ними (2-3 статті
    // отримують повний текст), але не нижче кепу пошукової видачі.
    const perArticleCap = Math.max(
      MAX_ARTICLE_TEXT_CHARS,
      Math.floor(MAX_ARTICLES_TOTAL_TEXT_CHARS / articles.length)
    );

    const response: any = {
      rada_id: args.rada_id,
      total_found: articles.length,
      as_of_date: args.as_of_date || undefined,
      articles: articles.map(a => ({
        article_number: a.article_number,
        title: a.title,
        full_text: capText(a.full_text, perArticleCap),
        url: a.url,
        npa_title: a.npa_title,
        section_number: a.section_number,
        section_title: a.section_title,
        chapter_number: a.chapter_number,
        chapter_title: a.chapter_title,
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

    // Dedup: if a recent search already found articles from the same rada_id, return cached
    const now = Date.now();
    this.searchDedup = this.searchDedup.filter(d => now - d.ts < this.DEDUP_TTL_MS);

    if (this.searchDedup.length >= 3) {
      const prevRadaIds = new Set<string>();
      for (const d of this.searchDedup) {
        d.radaIds.forEach(id => prevRadaIds.add(id));
      }
      {
        logger.info('[MCP Tool] search_legislation dedup: already searched 3+ times, returning hint', {
          query: args.query.substring(0, 60),
          prevSearches: this.searchDedup.length,
        });
        return {
          query: args.query,
          total_found: 0,
          articles: [],
          dedup_hint: `Вже виконано ${this.searchDedup.length} пошуків законодавства за цю сесію (знайдено: ${[...prevRadaIds].join(', ')}). Використайте search_edrsr_fulltext для судової практики або get_legislation_article для тексту конкретної статті.`,
        };
      }
    }

    logger.info('[MCP Tool] search_legislation started', {
      query: args.query.substring(0, 100),
      limit
    });

    // Пытаемся определить прямую ссылку на статью с помощью AI
    const directRef = await this.service.parseArticleReferenceWithAI(args.query);
    if (directRef) {
      // Resolve KMU:/KMU-Р: prefix to actual rada_id
      let resolvedRadaId = directRef.radaId;
      const kmuPrefix = parseKmuPrefix(resolvedRadaId);
      if (kmuPrefix) {
        const resolved = await this.service.resolveKmuRadaId(kmuPrefix.kmuNumber, kmuPrefix.docType);
        if (resolved) {
          resolvedRadaId = resolved;
        } else {
          const docLabel = kmuPrefix.docType === '-р' ? 'Розпорядження' : 'Постанову';
          return {
            query: args.query,
            total_found: 0,
            articles: [],
            suggestion: `${docLabel} КМУ №${kmuPrefix.kmuNumber} не знайдено на zakon.rada.gov.ua. Перевірте номер.`,
          };
        }
      }

      // If we have an article/punkt number, fetch it directly
      if (directRef.articleNumber) {
        const article = await this.service.getArticle(resolvedRadaId, directRef.articleNumber);
        if (!article) {
          // AI-визначена стаття не існує — класифікатор міг вгадати не той закон або номер
          // (на його боці немає retrieval/grounding). Замість термінального "не знайдено"
          // пробуємо семантичний пошук: у межах вгаданого акту та по всьому законодавству
          // (сам факт "стаття відсутня" — сильний сигнал, що і закон може бути не той).
          try {
            const [scoped, unscoped] = await Promise.all([
              this.service.findRelevantArticles(args.query, resolvedRadaId, limit),
              this.service.findRelevantArticles(args.query, undefined, limit),
            ]);
            const seen = new Set<string>();
            const fallbackArticles: any[] = [];
            for (const a of [...unscoped, ...scoped]) {
              if (fallbackArticles.length >= limit) break;
              const key = `${a.rada_id}:${a.article_number}`;
              if (seen.has(key)) continue;
              seen.add(key);
              fallbackArticles.push({
                rada_id: a.rada_id,
                article_number: a.article_number,
                title: a.title,
                full_text: capText(a.full_text),
                url: a.url,
                npa_title: a.npa_title,
                section_number: a.section_number,
                section_title: a.section_title,
                chapter_number: a.chapter_number,
                chapter_title: a.chapter_title,
              });
            }
            if (fallbackArticles.length > 0) {
              logger.info('[MCP Tool] search_legislation: AI-resolved article missing, semantic fallback', {
                rada_id: resolvedRadaId,
                ai_article: directRef.articleNumber,
                confidence: directRef.confidence,
                fallback_count: fallbackArticles.length,
              });
              return {
                query: args.query,
                resolved_reference: {
                  rada_id: resolvedRadaId,
                  article_number: directRef.articleNumber,
                  source: directRef.source,
                  confidence: directRef.confidence,
                  not_found: true,
                },
                total_found: fallbackArticles.length,
                articles: fallbackArticles,
                note: `Стаття ${directRef.articleNumber} не знайдена в ${resolvedRadaId} — показано релевантні статті за семантичним пошуком.`,
              };
            }
          } catch (err: any) {
            logger.warn('[MCP Tool] search_legislation semantic fallback failed', {
              error: err?.message,
            });
          }

          // Семантичний fallback нічого не дав — повертаємо структуру акту, якщо він існує
          const structure = await this.service.getLegislationStructure(resolvedRadaId);
          return {
            query: args.query,
            total_found: 0,
            articles: [],
            legislation_found: structure ? {
              rada_id: resolvedRadaId,
              title: structure.title,
              total_articles: structure.total_articles,
              url: `https://zakon.rada.gov.ua/laws/show/${resolvedRadaId}`,
            } : undefined,
            suggestion: `Пункт/стаття ${directRef.articleNumber} не знайдено в ${resolvedRadaId}. Перевірте номер.`,
          };
        }

        const resolvedArticle = {
          rada_id: article.rada_id,
          article_number: article.article_number,
          title: article.title,
          // Пряме посилання на конкретну статтю — віддаємо повний текст, як і
          // get_legislation_section (кеп лише для патологічно великих статей).
          full_text: capText(article.full_text, MAX_SINGLE_ARTICLE_TEXT_CHARS),
          url: article.url,
          npa_title: article.npa_title,
          section_number: article.section_number,
          section_title: article.section_title,
          chapter_number: article.chapter_number,
          chapter_title: article.chapter_title,
        };

        // Grounding guard: the AI classifier can confidently return a plausible-but-wrong
        // article number (no retrieval/grounding on its side). If the resolved article does
        // not actually cover the query's distinctive terms — or confidence is below the
        // trusted bar — supplement with semantic search scoped to the same rada_id so the
        // genuinely relevant article (e.g. ст. 266 vs ст. 265, or підрозділ 10 розд. XX
        // transitional points) still surfaces instead of a single wrong answer.
        const grounding = articleGroundingRatio(
          args.query,
          `${article.title || ''} ${article.full_text || ''}`
        );
        const trusted =
          (directRef.confidence ?? 0) >= AI_REF_TRUSTED_CONFIDENCE &&
          grounding >= ARTICLE_GROUNDING_MIN_RATIO;

        const response: any = {
          query: args.query,
          resolved_reference: {
            rada_id: resolvedRadaId,
            article_number: directRef.articleNumber,
            source: directRef.source,
            confidence: directRef.confidence,
            grounding_ratio: Number(grounding.toFixed(2)),
          },
          total_found: 1,
          articles: [resolvedArticle],
        };

        if (!trusted) {
          try {
            // Very low grounding means the AI guess — possibly the LAW itself — may be wrong,
            // so also search UNSCOPED across all legislation, not only within the guessed act
            // (a scoped-only fallback returns nothing when the wrong law was picked, leaving a
            // single wrong answer). When the law is suspect, prefer globally-relevant hits.
            const lawMayBeWrong = grounding < ARTICLE_GROUNDING_MIN_RATIO;
            const [scoped, unscoped] = await Promise.all([
              this.service.findRelevantArticles(args.query, resolvedRadaId, limit),
              lawMayBeWrong
                ? this.service.findRelevantArticles(args.query, undefined, limit)
                : Promise.resolve([] as any[]),
            ]);
            const supplemental = lawMayBeWrong ? [...unscoped, ...scoped] : [...scoped, ...unscoped];

            const seen = new Set<string>([
              `${resolvedArticle.rada_id}:${resolvedArticle.article_number}`,
            ]);
            for (const a of supplemental) {
              if (response.articles.length >= limit) break; // honor the caller's limit
              const key = `${a.rada_id}:${a.article_number}`;
              if (seen.has(key)) continue;
              seen.add(key);
              response.articles.push({
                rada_id: a.rada_id,
                article_number: a.article_number,
                title: a.title,
                full_text: capText(a.full_text),
                url: a.url,
                npa_title: a.npa_title,
                section_number: a.section_number,
                section_title: a.section_title,
                chapter_number: a.chapter_number,
                chapter_title: a.chapter_title,
              });
            }
            response.total_found = response.articles.length;
            if (response.articles.length > 1) {
              response.resolved_reference.supplemented = true;
              response.note =
                'AI-визначена стаття могла не повністю відповідати запиту — додано релевантні статті за семантичним пошуком. Перевірте, яка стаття відповідає питанню.';
            }
            logger.info('[MCP Tool] search_legislation supplemented low-grounding AI reference', {
              rada_id: resolvedRadaId,
              ai_article: directRef.articleNumber,
              confidence: directRef.confidence,
              grounding_ratio: Number(grounding.toFixed(2)),
              law_may_be_wrong: lawMayBeWrong,
              supplemental_count: response.articles.length - 1,
            });
          } catch (err: any) {
            logger.warn('[MCP Tool] search_legislation supplemental search failed', {
              error: err?.message,
            });
          }
        }

        if (args.include_html) {
          response.html = this.renderer.renderArticleHTML(article, {
            theme: args.theme || 'light',
            format: 'full',
          });
        }

        return response;
      }

      // No article number — return legislation structure/overview
      await this.service.ensureLegislationExists(resolvedRadaId);
      const structure = await this.service.getLegislationStructure(resolvedRadaId);
      if (structure) {
        return {
          query: args.query,
          resolved_reference: {
            rada_id: resolvedRadaId,
            source: directRef.source,
            confidence: directRef.confidence,
          },
          total_found: structure.total_articles || 0,
          legislation: {
            rada_id: resolvedRadaId,
            title: structure.title,
            type: structure.type,
            total_articles: structure.total_articles,
            url: `https://zakon.rada.gov.ua/laws/show/${resolvedRadaId}`,
            table_of_contents: structure.table_of_contents,
          },
          articles: structure.articles.slice(0, limit).map((a: any) => ({
            rada_id: resolvedRadaId,
            article_number: a.article_number,
            title: a.title,
            full_text: capText(a.full_text),
            url: `https://zakon.rada.gov.ua/laws/show/${resolvedRadaId}#n${a.article_number}`,
          })),
        };
      }
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
        full_text: capText(a.full_text),
        url: a.url,
        npa_title: a.npa_title,
        section_number: a.section_number,
        section_title: a.section_title,
        chapter_number: a.chapter_number,
        chapter_title: a.chapter_title,
      })),
    };

    // Supplement with court practice references if requested
    if (args.include_court_practice && this.patternStore) {
      try {
        const patterns = await this.patternStore.findPatterns(args.query);
        if (patterns.length > 0) {
          const patternArticles = new Set<string>();
          for (const pattern of patterns) {
            pattern.law_articles.forEach((a: string) => patternArticles.add(a));
          }
          response.court_practice_references = {
            from_court_practice: Array.from(patternArticles).slice(0, 5),
            patterns_count: patterns.length,
          };
        }
      } catch {
        // Pattern store is optional
      }
    }

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

    // Record in dedup cache
    const foundRadaIds = new Set(articles.map((a: any) => a.rada_id).filter(Boolean));
    this.searchDedup.push({
      key: args.query,
      result: response,
      radaIds: foundRadaIds,
      ts: Date.now(),
    });

    return response;
  }

  async getLegislationStructure(
    args: LegislationToolArgs & { force_refresh?: boolean; include_articles?: boolean; offset?: number; limit?: number }
  ): Promise<any> {
    if (!args.rada_id) {
      throw new Error('rada_id is required');
    }

    let radaId = args.rada_id;
    // Resolve KMU:/KMU-Р: prefix
    const structKmuPrefix = parseKmuPrefix(radaId);
    if (structKmuPrefix) {
      const resolved = await this.service.resolveKmuRadaId(structKmuPrefix.kmuNumber, structKmuPrefix.docType);
      if (resolved) {
        radaId = resolved;
      } else {
        const docLabel = structKmuPrefix.docType === '-р' ? 'Розпорядження' : 'Постанову';
        return {
          error: `${docLabel} КМУ №${structKmuPrefix.kmuNumber} не знайдено`,
          suggestion: `Перевірте номер ${structKmuPrefix.docType === '-р' ? 'розпорядження' : 'постанови'}`,
        };
      }
    }

    const includeArticles = args.include_articles === true;

    logger.info(`Getting structure for ${radaId}`, { force_refresh: args.force_refresh, includeArticles });

    // Always build a headings-only TOC — a full act (e.g. ЦК, ~1300 articles) with per-article
    // leaves otherwise returns ~1.2M chars and overflows the MCP token limit. The flat per-article
    // list is opt-in + paginated below (structure.articles is always the full flat set).
    const structure = await this.service.getLegislationStructure(radaId, args.force_refresh, false);

    if (!structure) {
      return {
        error: `Legislation ${args.rada_id} not found`,
        suggestion: 'Load the legislation first using ensureLegislationExists',
      };
    }

    const base = {
      rada_id: structure.rada_id,
      title: structure.title,
      short_title: structure.short_title,
      type: structure.type,
      total_articles: structure.total_articles,
      table_of_contents: structure.table_of_contents,
    };

    if (!includeArticles) {
      return {
        ...base,
        note:
          'Зміст (розділи/глави/статті-лічильники) без повного переліку статей. Для переліку статей передайте include_articles:true з offset/limit, або скористайтесь get_legislation_articles для конкретних статей.',
      };
    }

    // include_articles=true → paginated flat article list.
    const all: any[] = structure.articles || [];
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(1000, Math.max(1, Number(args.limit) || 300));
    const page = all.slice(offset, offset + limit).map((a: any) => ({
      article_number: a.article_number,
      title: a.title,
      byte_size: a.byte_size,
    }));

    return {
      ...base,
      articles_total: all.length,
      offset,
      limit,
      returned: page.length,
      has_more: offset + limit < all.length,
      articles_summary: page,
    };
  }

  getToolDefinitions() {
    return [
      {
        name: 'get_legislation_section',
        annotations: { title: 'Стаття закону', readOnlyHint: true, idempotentHint: true },
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
              description: 'ID законодавчого акту (наприклад, "254к/96-вр" для Конституції, "435-15" для ЦК, "436-15" для ГК, "2755-17" для ПКУ, "1618-15" для ЦПК, "2341-14" для КК)',
            },
            article_number: {
              type: 'string',
              description: 'Номер статті (наприклад, "625", "44", "354-1")',
            },
            as_of_date: {
              type: 'string',
              description: 'Дата для отримання історичної редакції (формат YYYY-MM-DD). Без цього параметру повертається чинна редакція.',
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
        annotations: { title: 'Статті закону (діапазон)', readOnlyHint: true, idempotentHint: true },
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
            as_of_date: {
              type: 'string',
              description: 'Дата для отримання історичної редакції (формат YYYY-MM-DD)',
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
        annotations: { title: 'Пошук законодавства', readOnlyHint: true },
        description: `Семантичний пошук релевантних статей законодавства за запитом або описом ситуації. Використовує векторний пошук для знаходження найбільш релевантних норм.

Приклади: "поновлення пропущеного строку", "підстави для залишення позову без розгляду", "реєстрація авто з кількома власниками", "затоплення квартири сусідом".

💰 Вартість: $0.01-$0.05 USD (семантичний пошук + OpenAI embedding)`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит або опис юридичної ситуації українською мовою',
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
            include_court_practice: {
              type: 'boolean',
              default: false,
              description: 'Додати посилання з судової практики (які статті згадуються в аналогічних справах)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_legislation_structure',
        annotations: { title: 'Структура закону', readOnlyHint: true, idempotentHint: true },
        description:
          'Отримати структуру законодавчого акту: зміст (розділи, глави, параграфи) з лічильником статей у кожному вузлі. За замовчуванням БЕЗ повного переліку статей (великі кодекси інакше не вміщуються). Для переліку статей передайте include_articles:true з offset/limit; для конкретних статей — get_legislation_articles.',
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту',
            },
            include_articles: {
              type: 'boolean',
              default: false,
              description: 'Додати плоский перелік статей (пагінований через offset/limit). За замовчуванням false — повертається лише зміст.',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зміщення для переліку статей (лише коли include_articles:true)',
            },
            limit: {
              type: 'number',
              default: 300,
              description: 'Макс. статей у переліку (1-1000, лише коли include_articles:true)',
            },
          },
          required: ['rada_id'],
        },
      },
      {
        name: 'list_legislation_editions',
        annotations: { title: 'Редакції закону', readOnlyHint: true, idempotentHint: true },
        description: 'Перелік всіх доступних історичних редакцій законодавчого акту з датами. Використовуй для вибору дати при запиті get_legislation_section з as_of_date.',
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту (наприклад, "435-15" для ЦК)',
            },
          },
          required: ['rada_id'],
        },
      },
      {
        name: 'get_legislation_history',
        annotations: { title: 'Історія змін закону', readOnlyHint: true },
        description: `Отримати історію змін (редакцій) законодавчого акту. Показує які статті змінювались, коли і в якій редакції.

Використовуй коли потрібно:
- Простежити як змінювалась конкретна норма з часом
- Знайти які постанови/закони вносили зміни до акту
- Проаналізувати еволюцію правового регулювання

Без article_number повертає загальну статистику змін (згруповано по статтях).
З article_number повертає повну історію конкретної статті.

💰 Вартість: $0.00 (тільки PostgreSQL запит)`,
        inputSchema: {
          type: 'object',
          properties: {
            rada_id: {
              type: 'string',
              description: 'ID законодавчого акту на zakon.rada.gov.ua (наприклад, "1388-98-п" для Постанови КМУ №1388, "435-15" для ЦК)',
            },
            article_number: {
              type: 'string',
              description: 'Номер статті для детальної історії (наприклад, "266"). Без цього параметра повертає загальну статистику змін.',
            },
          },
          required: ['rada_id'],
        },
      },
    ];
  }

  async getLegislationHistory(args: { rada_id: string; article_number?: string }): Promise<any> {
    if (!args.rada_id) {
      throw new Error('rada_id is required');
    }

    let radaId = normalizeRadaId(args.rada_id);

    // Resolve KMU:/KMU-Р: prefix
    const historyKmuPrefix = parseKmuPrefix(radaId);
    if (historyKmuPrefix) {
      const resolved = await this.service.resolveKmuRadaId(historyKmuPrefix.kmuNumber, historyKmuPrefix.docType);
      if (resolved) {
        radaId = resolved;
      } else {
        const docLabel = historyKmuPrefix.docType === '-р' ? 'Розпорядження' : 'Постанову';
        return {
          rada_id: radaId,
          error: `${docLabel} КМУ №${historyKmuPrefix.kmuNumber} не знайдено на zakon.rada.gov.ua`,
          suggestion: `Перевірте номер ${historyKmuPrefix.docType === '-р' ? 'розпорядження' : 'постанови'}`,
        };
      }
    }

    const articleFilter = args.article_number?.trim() || null;
    logger.info('[MCP Tool] get_legislation_history started', { rada_id: radaId, article_number: articleFilter });

    const structure = await this.service.getLegislationStructure(radaId, undefined, false);

    if (articleFilter) {
      // Detailed history for a specific article:
      // 1) real clause-level amendments (dated, from legislation_article_amendments), and
      // 2) distinct text versions deduped by full_text (many editions carry identical text,
      //    so raw per-edition rows over-report). Reads the real version_date column.
      const [amendments, versionsResult] = await Promise.all([
        this.service.getArticleAmendments(radaId, articleFilter),
        this.service.getArticleVersions(radaId, articleFilter, 50),
      ]);
      const changed = amendments.length > 0 || versionsResult.total > 1;
      return {
        rada_id: radaId,
        title: structure?.title || null,
        article_number: articleFilter,
        url: `https://zakon.rada.gov.ua/laws/show/${radaId}`,
        amendments_count: amendments.length,
        amendments,
        distinct_versions: versionsResult.total,
        versions: versionsResult.versions,
        versions_truncated: versionsResult.total > versionsResult.versions.length || undefined,
        note: !changed
          ? `Стаття ${articleFilter}: зафіксованих змін немає — поточна редакція єдина.`
          : amendments.length === 0
            ? `Деталізованих операцій зміни немає; показано ${versionsResult.versions.length} відмінних редакцій тексту (з ${versionsResult.total}).`
            : undefined,
      };
    }

    // Summary mode: grouped stats instead of 70K raw rows
    const summary = await this.service.getAmendmentSummary(radaId);

    if (!structure && summary.length === 0) {
      return {
        rada_id: radaId,
        error: `Законодавчий акт ${radaId} не знайдено в базі даних`,
        suggestion: 'Перевірте правильність rada_id. Для постанов КМУ формат: "1388-98-п", для законів: "435-15"',
        url: `https://zakon.rada.gov.ua/laws/show/${radaId}`,
      };
    }

    const totalAmendments = summary.reduce((s, r) => s + r.version_count, 0);

    return {
      rada_id: radaId,
      title: structure?.title || null,
      type: structure?.type || null,
      total_current_articles: structure?.total_articles || null,
      url: `https://zakon.rada.gov.ua/laws/show/${radaId}`,
      total_amendments: totalAmendments,
      total_amended_articles: summary.length,
      most_amended_articles: summary.slice(0, 30),
      note: summary.length === 0
        ? 'Історія змін порожня — можливо акт ще не був змінений або попередні редакції не збережено в базі'
        : 'Для детальної історії конкретної статті вкажіть article_number',
    };
  }

  async listLegislationEditions(args: { rada_id: string }): Promise<any> {
    if (!args.rada_id) throw new Error('rada_id is required');
    const radaId = normalizeRadaId(args.rada_id);
    const editions = await this.service.getEditionDates(radaId);
    const structure = await this.service.getLegislationStructure(radaId, undefined, false);
    return {
      rada_id: radaId,
      title: structure?.title || null,
      total_editions: editions.length,
      editions: editions.map(e => ({
        date: e.edition_date,
        article_count: e.article_count,
      })),
      note: editions.length === 0
        ? 'Історичні редакції ще не завантажені для цього акту'
        : undefined,
    };
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    switch (name) {
      case 'get_legislation_article': // backward-compat alias
      case 'get_legislation_section':
        return this.wrapResponse(await this.getLegislationSection(args));
      case 'get_legislation_articles':
        return this.wrapResponse(await this.getLegislationArticles(args));
      case 'find_relevant_law_articles': // backward-compat alias
        return this.wrapResponse(await this.searchLegislation({ ...args, include_court_practice: true }));
      case 'search_legislation':
        return this.wrapResponse(await this.searchLegislation(args));
      case 'get_legislation_structure':
        return this.wrapResponse(await this.getLegislationStructure(args));
      case 'get_legislation_history':
        return this.wrapResponse(await this.getLegislationHistory(args));
      case 'list_legislation_editions':
        return this.wrapResponse(await this.listLegislationEditions(args));
      default:
        return null;
    }
  }
}
