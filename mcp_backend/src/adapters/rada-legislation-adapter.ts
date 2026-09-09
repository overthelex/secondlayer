import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import type { IDatabase } from '../domain/ports/index.js';
import { buildLegislationTsquery, extractArticleNumberTokens } from '../services/legislation-search-utils';

/**
 * КУпАП (Кодекс України про адміністративні правопорушення) is split in RADA
 * into two documents: 80731-10 (статті 1–212-21) and 80732-10 (статті 213–330).
 * Article numbers don't overlap, so a КУпАП article lookup must search BOTH
 * rada_ids (LEXAI-1770). Defined locally to avoid a circular import with
 * legislation-service.ts (which imports this adapter).
 */
const KUPAP_RADA_IDS = ['80731-10', '80732-10'];

function expandKupapRadaIds(radaId: string): string[] {
  const lower = String(radaId || '').toLowerCase();
  return KUPAP_RADA_IDS.some((id) => id === lower) ? [...KUPAP_RADA_IDS] : [radaId];
}

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
  section_title?: string;
  chapter_number?: string;
  chapter_title?: string;
  title?: string;
  full_text: string;
  full_text_html?: string;
  part_number?: number;
  paragraph_number?: number;
  notes?: string;
  version_date?: Date;
  byte_size: number;
  metadata?: any;
  /** rada_id of the legislation row this article belongs to (set on direct lookups). */
  rada_id?: string;
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
  private db: IDatabase;
  private readonly BASE_URL = 'https://zakon.rada.gov.ua';
  private readonly CHUNK_SIZE = 500; // characters per chunk for vector search
  private readonly CHUNK_OVERLAP = 100; // overlap between chunks
  /**
   * full_text length above which a parsed article is almost certainly a broken parse
   * (the last "Стаття N." swallowing the document tail — LEXAI-1809). The largest legit
   * article observed is ПКУ ст. 14 «визначення понять» ≈ 216K chars, so 400K is a safe
   * alarm threshold. We keep the record but log an error so the anomaly is visible.
   */
  private readonly MEGA_ARTICLE_WARN_CHARS = 400_000;
  /** legislation_articles.section_number / .chapter_number are varchar(50). */
  private static readonly STRUCTURE_NUMBER_MAX_CHARS = 50;
  /**
   * Headings that begin the "Прикінцеві та перехідні положення" block. Article bodies
   * must stop here — the block is extracted separately by extractTransitionalProvisions,
   * and letting the last article run past it produces the ст. 346 mega-record.
   */
  // The transitional-section heading must be the document's OWN structural header
  // (an rvts15/rvts23 span), never an in-text REFERENCE to another act's section
  // (LEXAI-1821: «…розділу XX "Перехідні положення" ПКУ» cited inside КУпАП ст.163
  // cut the main scan at 53%, and a «Про споживче кредитування» reference cut ПКУ
  // at 2% — nearly the whole main body went through the transitional extractor,
  // producing thousands of bogus 'п.*' rows).
  /**
   * Strip HTML/XML tags to plain text, looping until stable so overlapping
   * constructs (e.g. `<<a>script>`) cannot reconstitute a tag after one pass.
   */
  private static stripTags(input: string): string {
    let out = input;
    let prev: string;
    do {
      prev = out;
      out = out.replace(/<[^>]+>/g, '');
    } while (out !== prev);
    return out;
  }

  private static readonly TRANSITIONAL_HEADER_PATTERNS = [
    /<span\s+class=["']?rvts(?:15|23)["']?>[^<]{0,120}?ПРИКІНЦЕВІ\s+ТА\s+ПЕРЕХІДНІ\s+ПОЛОЖЕННЯ/i,
    /<span\s+class=["']?rvts(?:15|23)["']?>[^<]{0,120}?ПЕРЕХІДНІ\s+ТА\s+ПРИКІНЦЕВІ\s+ПОЛОЖЕННЯ/i,
    /<span\s+class=["']?rvts(?:15|23)["']?>[^<]{0,120}?ПЕРЕХІДНІ\s+ПОЛОЖЕННЯ/i,
    /<span\s+class=["']?rvts(?:15|23)["']?>[^<]{0,120}?ПРИКІНЦЕВІ\s+ПОЛОЖЕННЯ/i,
    // Not every act marks the heading with an rvts15/23 span. Two further shapes, each
    // required to be STRUCTURALLY ISOLATED and ALL CAPS so an in-text citation of another
    // act's section cannot pass for the document's own heading (see LEXAI-1821 above).
    //
    // (a) The heading is the whole paragraph, no span at all:
    //     <p class=rvps2><a name="n2639"></a>\nII. ПРИКІНЦЕВІ ПОЛОЖЕННЯ</p>
    // Anchoring on both <p …> and </p> is what makes it safe: a citation always shares
    // its paragraph with other text.
    /<p[^>]*>\s*(?:<a[^>]*>\s*<\/a>)?\s*(?:[IVXLC]+\s*\.\s*)?(?:ПРИКІНЦЕВІ|ПЕРЕХІДНІ)(?:\s+ТА\s+(?:ПЕРЕХІДНІ|ПРИКІНЦЕВІ))?\s+ПОЛОЖЕННЯ\s*<\/p>/,
    // (b) Older acts render as fixed-width <pre> text, where the heading occupies its own
    //     line:  <br>\n                ПРИКІНЦЕВІ ТА ПЕРЕХІДНІ ПОЛОЖЕННЯ <br>
    // Requiring a <br> on both sides keeps it to a line of its own.
    /<br>\s*(?:ПРИКІНЦЕВІ|ПЕРЕХІДНІ)(?:\s+ТА\s+(?:ПЕРЕХІДНІ|ПРИКІНЦЕВІ))?\s+ПОЛОЖЕННЯ\s*<br>/,
  ];
  /**
   * A transitional section is a tail. Every bound observed across the corpus falls at
   * 89% of the document or later, while both historical misfires cut the body in half or
   * worse: a «Перехідні положення» citation inside КУпАП ст.163 cut at 53%, and a
   * «Про споживче кредитування» reference cut ПКУ at 2%. Ignore a candidate that early —
   * the cost is one act keeping the old run-on behaviour, against losing most of its body.
   */
  private static readonly TRANSITIONAL_MIN_POSITION_RATIO = 0.6;
  /**
   * The same heading, seen by the fallback parser — which reads $('body').text(), so no
   * markup survives to anchor on. A whole line, all caps, optionally numbered: an in-text
   * citation is mixed case and shares its line with other words.
   */
  private static readonly TRANSITIONAL_TEXT_PATTERN =
    /^[ \t]*(?:[IVXLC]+[ \t]*\.?[ \t]*)?(?:ПРИКІНЦЕВІ|ПЕРЕХІДНІ)(?:[ \t]+ТА[ \t]+(?:ПЕРЕХІДНІ|ПРИКІНЦЕВІ))?[ \t]+ПОЛОЖЕННЯ[ \t]*$/m;
  private externalApiMetrics: ((service: string, status: string, durationSec: number) => void) | null = null;

  /**
   * Index of the earliest "Прикінцеві та перехідні положення" heading in the HTML, or -1.
   * Used to bound the main-article scan so the last article can't swallow the tail.
   */
  private findTransitionalSectionStart(html: string): number {
    let earliest = -1;
    for (const pat of RadaLegislationAdapter.TRANSITIONAL_HEADER_PATTERNS) {
      const m = pat.exec(html);
      if (m && (earliest < 0 || m.index < earliest)) earliest = m.index;
    }
    return this.guardTransitionalPosition(earliest, html.length);
  }

  /**
   * Same bound for the fallback parser, which works on plain text.
   */
  private findTransitionalSectionStartInText(text: string): number {
    const m = RadaLegislationAdapter.TRANSITIONAL_TEXT_PATTERN.exec(text);
    return this.guardTransitionalPosition(m ? m.index : -1, text.length);
  }

  private guardTransitionalPosition(index: number, total: number): number {
    if (index < 0 || total <= 0) return index;
    const ratio = index / total;
    if (ratio < RadaLegislationAdapter.TRANSITIONAL_MIN_POSITION_RATIO) {
      logger.warn(
        `[legislation] transitional heading matched at ${(ratio * 100).toFixed(1)}% of the document — ` +
        'too early to be the tail, ignoring the bound',
      );
      return -1;
    }
    return index;
  }

  constructor(db: IDatabase) {
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
    // An empty id passes the character check (it has no bad characters) and builds
    // /laws/show//print, which RADA answers 200 with its own search homepage. The parser
    // then finds one "article" — «Універсальний пошук. Інформаційно-пошукова система
    // "Законодавство України"…» — and the caller saves it as a law with an empty rada_id.
    // Nothing downstream can tell that row from a real act.
    if (!radaId || !radaId.trim()) {
      throw new Error('Legislation ID is required — an empty id fetches the RADA homepage, not a law');
    }
    // Validate radaId to prevent SSRF — Ukrainian law IDs contain alphanumeric, slashes, dashes, Cyrillic
    if (/[^\p{L}\p{N}\-_\/\.]/u.test(radaId) || radaId.includes('..')) {
      throw new Error(`Invalid legislation ID: ${radaId}`);
    }
    // Use /print endpoint for full text with all articles.
    // RADA IDs may contain a literal slash (e.g. "213/95-вр"); encode each
    // path segment but keep the "/" separators literal (encoded "%2F" 404s).
    const encodedId = radaId.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    const url = `${this.BASE_URL}/laws/show/${encodedId}/print`;
    logger.info(`Fetching legislation from ${url}`);

    const callStart = Date.now();
    try {
      const response = await this.httpClient.get(url);
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.('zakon_rada', 'success', callDuration);

      const html = RadaLegislationAdapter.normalizeSuperscriptIndexes(String(response.data));
      const $ = cheerio.load(html);

      const metadata = this.extractMetadata($, radaId, url);
      const articles = this.extractArticles($, radaId);

      logger.info(`Extracted ${articles.length} articles from ${radaId}`);
      return { metadata, articles };
    } catch (error: any) {
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.('zakon_rada', 'error', callDuration);
      logger.error(`Failed to fetch legislation ${radaId}:`, error.message);
      throw error;
    }
  }

  private extractMetadata($: cheerio.CheerioAPI, radaId: string, url: string): LegislationMetadata {
    let title = $('.title, .doc-title, h1').first().text().trim();

    // Fallback: RADA /print pages use og:title or span.rvts23 for КМУ resolutions
    if (!title) {
      title = $('meta[property="og:title"]').attr('content')?.trim() || '';
    }
    if (!title) {
      // Find the longest rvts23 span that looks like a title (skip "КАБІНЕТ МІНІСТРІВ УКРАЇНИ" etc.)
      $('span.rvts23, .rvts23').each((_i, el) => {
        const text = $(el).text().trim();
        if (text.length > 20 && text.length > title.length && /^(Про |ПОРЯДОК |ПРАВИЛА |ПОЛОЖЕННЯ )/i.test(text)) {
          title = text;
        }
      });
    }

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

  /**
   * LEXAI-1821: RADA renders the надрядковий індекс of dash-numbered units
   * (ст. 297-1, транзитний п. 16-1) as a superscript span whose dash is hidden with
   * font-size:0 (visually «297¹», copy-paste «297-1»):
   *
   *   297<span class="rvts37"><span style="font-size:0px">-</span>1</span>.
   *
   * The HTML-level parsers stop `[^<]*` capture at the inner span, so «Стаття 297-1»
   * was captured as «297» (and ON CONFLICT overwrote the REAL ст.297 with 297-1's
   * text), while transitional «16-1.» matched nothing — its sub-points were stored as
   * bare 'п.1.11' orphans. Flatten the markup to the literal dash form BEFORE any
   * parsing so every downstream regex sees plain «297-1» / «16-1».
   */
  static normalizeSuperscriptIndexes(html: string): string {
    return html
      .replace(
        /<span[^>]*>\s*<span[^>]*font-size:\s*0(?:px)?[^>]*>\s*-\s*<\/span>\s*(\d+)\s*<\/span>/gi,
        '-$1',
      )
      // Second pass (КК shape A): the dash-article HEADER is split across spans — the
      // number span closes BEFORE the superscript index, and the trailing dot (with or
      // without the title) sits in its own span:
      //   <span class=rvts9>Стаття 111</span>-2<span class=rvts9>.</span> Пособництво…
      // Merge it back into the single-span shape the article regex expects.
      .replace(
        /(Стаття\s+\d+)<\/span>(-\d+)<span[^>]*>\s*\.\s*([^<]*)<\/span>/gi,
        '$1$2. $3</span>',
      )
      // Shape B (КК 111-1, КУпАП 173-2, ПКУ 297-1): after the flattened index the dot
      // and title are PLAIN TEXT — no span to merge:
      //   <span class=rvts9>Стаття 111</span>-1. Колабораційна діяльність</p>
      // Pull the dash index inside the header span. Safe: body references to dash
      // articles are plain text with no </span> between the number and the index.
      .replace(
        /(Стаття\s+\d+)<\/span>(-\d+)\s*\./gi,
        '$1$2.</span>',
      );
  }

  private extractArticles($: cheerio.CheerioAPI, radaId: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];
    const bodyHtml = $('body').html() || '';

    // Build section/chapter map by scanning rvts15 spans before each article
    // Sections: <span class=rvts15>Розділ I </span><br><span class=rvts15>TITLE</span>
    // Chapters: <span class=rvts15>Глава 1 </span><br><span class=rvts15>TITLE</span>
    const structureMap = this.extractStructureMap(bodyHtml);

    // Bound the article scan at the "Прикінцеві та перехідні положення" heading: that block
    // is parsed separately (extractTransitionalProvisions), and without this bound the last
    // "Стаття N." greedily absorbs the entire tail (the ст. 346 ≈1M-char mega-record, LEXAI-1809).
    // Slicing only the tail keeps match.index aligned with structureMap (built on full bodyHtml).
    const transitionalStart = this.findTransitionalSectionStart(bodyHtml);
    const scanHtml = transitionalStart >= 0 ? bodyHtml.slice(0, transitionalStart) : bodyHtml;

    // Parse articles: handles both <span class=rvts9>Стаття N. Title</span> and <span class=rvts9>Стаття N.</span>.
    // A body also terminates at the next structural header (Розділ/Підрозділ/Глава/Книга) so an article
    // never swallows a following section that has no "Стаття N." of its own.
    //
    // The header alternative ends in a lookahead for whitespace-or-tag, NOT \b: JavaScript
    // defines \b over [A-Za-z0-9_] only, so after the Cyrillic "л" of «Розділ» it sits
    // between two non-word characters and never matches. The alternative was dead from the
    // day it was written, which is why ЦК ст. 625 kept «Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО
    // ДОГОВІР Глава 52 ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ» glued to its own text — it ran on to the
    // next «Стаття N.» instead of stopping at the heading. A heading is always followed by
    // a space («Розділ II ») or closes immediately («Розділ</span>»), so [\s<] covers both.
    const articleRegex = /<span\s+class=["']?rvts9["']?>Стаття\s+(\d+(?:-\d+)?)\.?\s*([^<]*)<\/span>\s*(.*?)(?=<span\s+class=["']?rvts9["']?>Стаття\s+\d|<span\s+class=["']?rvts15["']?>\s*(?:Розділ|Підрозділ|Глава|Книга)(?=[\s<])|$)/gs;

    let match;
    while ((match = articleRegex.exec(scanHtml)) !== null) {
      const articleNumber = match[1];
      const inlineTitle = match[2]?.trim(); // Title text inside the <span> tag
      const articleHtml = match[3];
      const articlePosition = match.index;

      // Load the article HTML into cheerio for text extraction
      const $article = cheerio.load(`<div>${articleHtml}</div>`);

      // Extract amendment annotations from <em> blocks before removing them.
      // Rada marks amended parts as: <em>{Частина N статті M в редакції Закону № X від DD.MM.YYYY}</em>
      // These are critical legal metadata — preserve them as plain-text notes in full_text.
      const amendmentNotes: string[] = [];
      $article('em').each((_i, el) => {
        const emText = $article(el).text()
          .replace(/\s+/g, ' ')
          .trim();
        // Only keep notes that look like amendment markers (contain "редакції" or "доповнено" or "виключено")
        if (/редакції|доповнено|виключено|втратила|набрала/i.test(emText) && emText.length > 5) {
          // Strip surrounding {} but keep the content
          const cleaned = emText.replace(/^\{|\}$/g, '').trim();
          if (cleaned) amendmentNotes.push(`[${cleaned}]`);
        }
      });

      // Extract clean text (remove HTML tags, scripts, styles)
      $article('script, style, em').remove();
      const bodyText = $article.text()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\{[^}]+\}/g, '') // Remove remaining {...} inline markers
        .trim();

      // Append amendment notes after the article body so LLMs can see them
      const fullText = amendmentNotes.length > 0
        ? `${bodyText} ${amendmentNotes.join(' ')}`
        : bodyText;

      if (fullText.length < 10) continue;

      // Alarm on a likely broken parse (a body that swallowed the tail). Kept, not dropped,
      // but logged so the anomaly surfaces instead of silently polluting search (LEXAI-1809).
      if (fullText.length > this.MEGA_ARTICLE_WARN_CHARS) {
        logger.error(
          `[legislation] Suspiciously large article ${radaId} ст.${articleNumber}: ${fullText.length} chars ` +
          `(> ${this.MEGA_ARTICLE_WARN_CHARS}) — probable parser tail-swallow, please re-check`
        );
      }

      // Where the title lives depends on the act. Some keep it inside the header span:
      //   <span class=rvts9>Стаття 14. Визначення понять</span>
      // Most put it right after, as plain text closing the same paragraph:
      //   <span class=rvts9>Стаття 625.</span> Відповідальність за порушення грошового зобов'язання</p>
      //
      // Only the first case was read from the markup. The second fell back to splitting
      // the body on its first "." — and a body reads «НАЗВА 1. Текст частини першої», so
      // the split handed back the title with the part number stuck to it: «Крадіжка 1»,
      // «Відповідальність за порушення грошового зобов'язання 1». That was 11,549 of
      // 25,383 stored articles. Where the first sentence ran past 200 characters the
      // heuristic gave up and stored no title at all even though the markup had one
      // (another 2,746), and in acts whose "articles" are numbered points with no titles
      // it stored a sentence of body text instead.
      //
      // Read the paragraph instead of guessing: everything between the header span and
      // the </p> that closes it is the title, and nothing is the honest answer when that
      // is empty.
      let title: string | undefined;
      if (inlineTitle && inlineTitle.length > 2) {
        title = inlineTitle;
      } else {
        const afterSpan = /^([^<]*)<\/p>/.exec(articleHtml);
        const fromMarkup = afterSpan?.[1]?.replace(/\s+/g, ' ').trim();
        // The same paragraph slot holds a title in most acts and the first sentence of
        // the body in acts whose articles are untitled — the Constitution among them,
        // where ст. 1 would otherwise be titled «Україна є суверенна і незалежна…
        // держава.» A title is a noun phrase and does not close with sentence
        // punctuation; a body sentence does. That is the only signal in the markup, and
        // it is the right way round: no title beats a title that is really the text.
        const looksLikeASentence = /[.!?;:]$/.test(fromMarkup ?? '');
        if (fromMarkup && fromMarkup.length > 2 && fromMarkup.length <= 300 && !looksLikeASentence) {
          title = fromMarkup;
        }
      }

      // Find which section/chapter this article belongs to
      const structure = this.findStructureForPosition(structureMap, articlePosition);

      // section_number / chapter_number are varchar(50). A header shape this parser has
      // not seen can still overflow one, and the insert then rejects the whole act — 546
      // parsed articles thrown away over one bad chapter label. Clamp and log instead.
      const clampStructureNumber = (value: string | undefined, field: string): string | undefined => {
        if (!value || value.length <= RadaLegislationAdapter.STRUCTURE_NUMBER_MAX_CHARS) return value;
        logger.warn(
          `[legislation] ${radaId} ст.${articleNumber}: ${field} is ${value.length} chars, ` +
          `truncating to ${RadaLegislationAdapter.STRUCTURE_NUMBER_MAX_CHARS} — likely an unhandled header shape`,
          { value: value.slice(0, 120) },
        );
        return value.slice(0, RadaLegislationAdapter.STRUCTURE_NUMBER_MAX_CHARS);
      };

      // Build unique section number with book prefix to avoid duplication
      const sectionNumber = structure.bookNumber && structure.sectionNumber
        ? `${structure.bookNumber}.${structure.sectionNumber}`
        : structure.sectionNumber;
      const sectionTitle = structure.sectionTitle;

      // Build unique subsection number with section context
      const subsectionNumber = structure.subsectionNumber;
      const subsectionTitle = structure.subsectionTitle;

      articles.push({
        article_number: articleNumber,
        section_number: clampStructureNumber(sectionNumber, 'section_number'),
        section_title: sectionTitle,
        chapter_number: clampStructureNumber(structure.chapterNumber, 'chapter_number'),
        chapter_title: structure.chapterTitle,
        title: title,
        full_text: fullText,
        full_text_html: articleHtml.substring(0, 10000), // Limit HTML size
        byte_size: Buffer.byteLength(fullText, 'utf8'),
        metadata: {
          rada_id: radaId,
          extraction_date: new Date().toISOString(),
          extraction_method: 'print_endpoint',
          book_number: structure.bookNumber,
          book_title: structure.bookTitle,
          subsection_number: subsectionNumber,
          subsection_title: subsectionTitle,
          paragraph_number: structure.paragraphNumber,
          paragraph_title: structure.paragraphTitle,
          amendment_notes: amendmentNotes.length > 0 ? amendmentNotes : undefined,
        },
      });
    }

    // Fallback to old method if too few articles found (likely regex mismatch)
    if (articles.length < 5) {
      logger.warn(`Only ${articles.length} articles found with print endpoint parser, trying fallback for ${radaId}`);
      const fallbackArticles = this.extractArticlesFallback($, radaId);
      if (fallbackArticles.length > articles.length) {
        logger.info(`Fallback found ${fallbackArticles.length} articles vs ${articles.length}, using fallback for ${radaId}`);
        articles.length = 0;
        articles.push(...fallbackArticles);
      }
    }

    // Extract transitional/final provisions as separate articles
    const transitional = this.extractTransitionalProvisions(bodyHtml, radaId);
    if (transitional.length > 0) {
      logger.info(`Extracted ${transitional.length} transitional provision entries from ${radaId}`);
      articles.push(...transitional);
    }

    return articles;
  }

  private extractStructureMap(bodyHtml: string): Array<{
    position: number;
    type: 'book' | 'section' | 'subsection' | 'chapter' | 'paragraph';
    number: string;
    title: string;
  }> {
    const entries: Array<{
      position: number;
      type: 'book' | 'section' | 'subsection' | 'chapter' | 'paragraph';
      number: string;
      title: string;
    }> = [];

    // Match Книга (Book) headers: <span class=rvts23>КНИГА ПЕРША </span><br><span class=rvts23>TITLE</span>
    const bookRegex = /<span\s+class=["']?rvts23["']?>КНИГА\s+([^<]+?)\s*<\/span>\s*(?:<br\s*\/?>)?\s*<span\s+class=["']?rvts23["']?>([^<]+?)<\/span>/gi;
    let match;
    while ((match = bookRegex.exec(bodyHtml)) !== null) {
      const rawNumber = match[1].trim();
      const title = match[2].trim();
      const number = this.ukrainianOrdinalToArabic(rawNumber) || rawNumber;
      entries.push({ position: match.index, type: 'book', number, title });
    }

    // Match Розділ/Глава/Підрозділ headers: <span class=rvts15>X N </span><br><span class=rvts15>TITLE</span>
    const headerRegex = /<span\s+class=["']?rvts15["']?>(Розділ|Глава|Підрозділ)\s+([^<]+?)\s*<\/span>\s*(?:<br\s*\/?>)?\s*<span\s+class=["']?rvts15["']?>([^<]+?)<\/span>/gi;
    while ((match = headerRegex.exec(bodyHtml)) !== null) {
      const keyword = match[1].toLowerCase();
      const type = keyword.startsWith('розділ') ? 'section' as const
        : keyword.startsWith('підрозділ') ? 'subsection' as const
        : 'chapter' as const;
      let rawNumber = match[2].trim();
      let title = match[3].trim();
      // Some acts keep the number and the START of the title in one span and wrap the
      // rest into the next one:
      //   <span class=rvts15>Глава 14. Розгляд судом справ про розкриття інформації…</span>
      //   <br><span class=rvts15>на ринках капіталу та організованих товарних ринках</span>
      // Read plainly, that made the whole first span the chapter NUMBER — 82 characters
      // into a varchar(50), which aborted the save of the entire act. ЦПК (1618-15) was
      // the one act of 367 that failed the corpus re-extraction for exactly this reason,
      // and the title was wrong too: it kept only the wrapped remainder.
      const wrapped = /^([^\s.]+)\.\s*(\S.*)$/.exec(rawNumber);
      if (wrapped) {
        rawNumber = wrapped[1];
        title = `${wrapped[2]} ${title}`.trim();
      }
      const number = this.romanToArabic(rawNumber) || rawNumber;
      entries.push({ position: match.index, type, number, title });
    }

    // Match § (paragraph) headers: <span class=rvts15>§ N. TITLE</span> (number and title in same span)
    const paragraphRegex = /<span\s+class=["']?rvts15["']?>§\s*(\d+)\.?\s*([^<]*?)\s*<\/span>/gi;
    while ((match = paragraphRegex.exec(bodyHtml)) !== null) {
      const number = match[1].trim();
      const title = match[2].trim();
      entries.push({ position: match.index, type: 'paragraph', number, title });
    }

    // Sort all entries by position in HTML
    entries.sort((a, b) => a.position - b.position);

    return entries;
  }

  private ukrainianOrdinalToArabic(str: string): string | null {
    const ordinals: Record<string, string> = {
      'ПЕРША': '1', 'ПЕРШИЙ': '1', 'ПЕРШЕ': '1',
      'ДРУГА': '2', 'ДРУГИЙ': '2', 'ДРУГЕ': '2',
      'ТРЕТЯ': '3', 'ТРЕТІЙ': '3', 'ТРЕТЄ': '3',
      'ЧЕТВЕРТА': '4', 'ЧЕТВЕРТИЙ': '4', 'ЧЕТВЕРТЕ': '4',
      "П'ЯТА": '5', "П'ЯТИЙ": '5', "П'ЯТЕ": '5',
      'ШОСТА': '6', 'ШОСТИЙ': '6', 'ШОСТЕ': '6',
      'СЬОМА': '7', 'СЬОМИЙ': '7', 'СЬОМЕ': '7',
      'ВОСЬМА': '8', 'ВОСЬМИЙ': '8', 'ВОСЬМЕ': '8',
      "ДЕВ'ЯТА": '9', "ДЕВ'ЯТИЙ": '9', "ДЕВ'ЯТЕ": '9',
      'ДЕСЯТА': '10', 'ДЕСЯТИЙ': '10', 'ДЕСЯТЕ': '10',
    };
    const cleaned = str.trim().toUpperCase();
    return ordinals[cleaned] || null;
  }

  private findStructureForPosition(
    structureMap: Array<{ position: number; type: 'book' | 'section' | 'subsection' | 'chapter' | 'paragraph'; number: string; title: string }>,
    articlePosition: number,
  ): { bookNumber?: string; bookTitle?: string; sectionNumber?: string; sectionTitle?: string; subsectionNumber?: string; subsectionTitle?: string; chapterNumber?: string; chapterTitle?: string; paragraphNumber?: string; paragraphTitle?: string } {
    let bookNumber: string | undefined;
    let bookTitle: string | undefined;
    let sectionNumber: string | undefined;
    let sectionTitle: string | undefined;
    let subsectionNumber: string | undefined;
    let subsectionTitle: string | undefined;
    let chapterNumber: string | undefined;
    let chapterTitle: string | undefined;
    let paragraphNumber: string | undefined;
    let paragraphTitle: string | undefined;

    for (const entry of structureMap) {
      if (entry.position > articlePosition) break;
      if (entry.type === 'book') {
        bookNumber = entry.number;
        bookTitle = entry.title;
        // Reset all sub-levels
        sectionNumber = undefined; sectionTitle = undefined;
        subsectionNumber = undefined; subsectionTitle = undefined;
        chapterNumber = undefined; chapterTitle = undefined;
        paragraphNumber = undefined; paragraphTitle = undefined;
      } else if (entry.type === 'section') {
        sectionNumber = entry.number;
        sectionTitle = entry.title;
        subsectionNumber = undefined; subsectionTitle = undefined;
        chapterNumber = undefined; chapterTitle = undefined;
        paragraphNumber = undefined; paragraphTitle = undefined;
      } else if (entry.type === 'subsection') {
        subsectionNumber = entry.number;
        subsectionTitle = entry.title;
        chapterNumber = undefined; chapterTitle = undefined;
        paragraphNumber = undefined; paragraphTitle = undefined;
      } else if (entry.type === 'chapter') {
        chapterNumber = entry.number;
        chapterTitle = entry.title;
        paragraphNumber = undefined; paragraphTitle = undefined;
      } else if (entry.type === 'paragraph') {
        paragraphNumber = entry.number;
        paragraphTitle = entry.title;
      }
    }

    return { bookNumber, bookTitle, sectionNumber, sectionTitle, subsectionNumber, subsectionTitle, chapterNumber, chapterTitle, paragraphNumber, paragraphTitle };
  }

  private romanToArabic(str: string): string | null {
    const roman: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const cleaned = str.trim().toUpperCase();

    // Check if it's already an Arabic number
    if (/^\d+$/.test(cleaned)) return cleaned;

    // Check if it's a valid Roman numeral
    if (!/^[IVXLCDM]+$/.test(cleaned)) return null;

    let result = 0;
    for (let i = 0; i < cleaned.length; i++) {
      const current = roman[cleaned[i]];
      const next = roman[cleaned[i + 1]];
      if (next && current < next) {
        result -= current;
      } else {
        result += current;
      }
    }
    return result.toString();
  }

  /**
   * Extract numbered points from "Прикінцеві та перехідні положення" section.
   * These use "N. text" format instead of "Стаття N." and are missed by the main parser.
   */
  private extractTransitionalProvisions(bodyHtml: string, radaId: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];

    // Find the transitional provisions section header (shared with the article-scan bound).
    let sectionStart = -1;
    let sectionTitle = '';
    for (const pat of RadaLegislationAdapter.TRANSITIONAL_HEADER_PATTERNS) {
      const m = pat.exec(bodyHtml);
      if (m) {
        sectionStart = m.index;
        sectionTitle = RadaLegislationAdapter.stripTags(m[0]).trim();
        break;
      }
    }
    if (sectionStart < 0) return articles;

    const sectionHtml = bodyHtml.slice(sectionStart);

    // Track current subsection/section context within transitional provisions
    let currentSection = sectionTitle;
    let currentSubsection = '';

    const sectionHeaderRegex = /<span\s+class=["']?rvts(?:15|23)["']?>((?:Розділ|Підрозділ)\s+[^<]+)<\/span>(?:\s*(?:<br\s*\/?>)?\s*<span\s+class=["']?rvts(?:15|23)["']?>([^<]+)<\/span>)?/gi;
    const sectionHeaders: Array<{ pos: number; type: string; number: string; title: string }> = [];
    let shMatch;
    while ((shMatch = sectionHeaderRegex.exec(sectionHtml)) !== null) {
      const raw = shMatch[1].trim();
      const title = shMatch[2]?.trim() || '';
      const isSubsection = /підрозділ/i.test(raw);
      sectionHeaders.push({
        pos: shMatch.index,
        type: isSubsection ? 'subsection' : 'section',
        number: raw.replace(/^(?:Розділ|Підрозділ)\s+/i, '').trim(),
        title,
      });
    }

    // Extract numbered points: <a name="nNNNN"></a>\s*N. or N.N. or N.N.N. text...
    // Matches: "38.6.", "69.14.", "1.", "41.2.5." — and dash-indexed points «16-1.»,
    // «52-1.» (LEXAI-1821; the superscript markup is flattened to a literal dash
    // by normalizeSuperscriptIndexes before parsing).
    const pointRegex = /<a\s+name="n(\d+)">\s*<\/a>\s*(\d+(?:-\d+)?(?:\.\d+)*)\.\s*/g;
    const points: Array<{ anchor: string; num: string; startPos: number }> = [];
    let pMatch;
    while ((pMatch = pointRegex.exec(sectionHtml)) !== null) {
      points.push({ anchor: pMatch[1], num: pMatch[2], startPos: pMatch.index + pMatch[0].length });
    }

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const endPos = i + 1 < points.length ? points[i + 1].startPos - 50 : sectionHtml.length;
      const pointHtml = sectionHtml.slice(point.startPos, endPos);

      // Strip HTML tags for plain text using cheerio parser
      const $point = cheerio.load(pointHtml, { xml: false });
      const pointAmendmentNotes: string[] = [];
      $point('em').each((_i, el) => {
        const emText = $point(el).text().replace(/\s+/g, ' ').trim();
        if (/редакції|доповнено|виключено|втратила|набрала/i.test(emText) && emText.length > 5) {
          const cleaned = emText.replace(/^\{|\}$/g, '').trim();
          if (cleaned) pointAmendmentNotes.push(`[${cleaned}]`);
        }
      });
      $point('script, style, em').remove();
      const pointBodyText = $point.text()
        .replace(/\{[^}]*\}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const fullText = pointAmendmentNotes.length > 0
        ? `${pointBodyText} ${pointAmendmentNotes.join(' ')}`
        : pointBodyText;

      if (fullText.length < 10) continue;

      // Determine which subsection/section this point belongs to
      for (const sh of sectionHeaders) {
        if (sh.pos < point.startPos) {
          if (sh.type === 'subsection') {
            currentSubsection = `Підрозділ ${sh.number}${sh.title ? ' ' + sh.title : ''}`;
          } else {
            currentSection = `Розділ ${sh.number}${sh.title ? ' ' + sh.title : ''}`;
            currentSubsection = '';
          }
        }
      }

      const articleNumber = `п.${point.num}`;
      // A transitional point is a numbered paragraph and carries no title. This used to
      // store fullText cut at 150 characters, which lands mid-word: «…цією Конституцією
      // є чинними у частині, що не суперечить Конституції Укра», «…в останню неділю
      // жовтня 1999 р», «…національної грошової одиниці - грив». A truncated sentence is
      // not a title, and a reader shown one has no way to know it is not the real one.
      const title = undefined;

      articles.push({
        article_number: articleNumber,
        section_number: undefined,
        section_title: sectionTitle,
        chapter_number: undefined,
        chapter_title: currentSubsection || currentSection,
        title,
        full_text: `${point.num}. ${fullText}`,
        full_text_html: pointHtml.substring(0, 10000),
        byte_size: Buffer.byteLength(fullText, 'utf8'),
        metadata: {
          rada_id: radaId,
          extraction_date: new Date().toISOString(),
          extraction_method: 'transitional_provisions',
          is_transitional: true,
          subsection: currentSubsection || undefined,
        },
      });
    }

    return articles;
  }

  private extractArticlesFallback($: cheerio.CheerioAPI, radaId: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];
    // Strip RADA's print-page chrome so we don't capture "Друкувати"/"Допомога"/
    // keyboard hints when falling back to whole-document extraction.
    $('#prnpanel, script, style, noscript, header, footer, nav').remove();
    // Cheerio .text() strips newlines between block elements (p, div, br),
    // so we inject newlines before extracting text to preserve paragraph boundaries
    $('p, div, br').each((_i, el) => {
      $(el).before('\n');
    });
    const fullBodyText = $('body').text();
    // Older acts render as fixed-width <pre> text and reach this parser instead of the
    // span-based one, which is why they kept the transitional block inside their last
    // article long after the HTML-level bound was in place: this path never had one.
    const transitionalStart = this.findTransitionalSectionStartInText(fullBodyText);
    const bodyText = transitionalStart >= 0 ? fullBodyText.slice(0, transitionalStart) : fullBodyText;

    // Try Стаття pattern first (laws, codes)
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

    // If no articles found, try пункт pattern (КМУ постанови, порядки, правила)
    // Format: "1. Text..." at line start, numbered sequentially
    if (articles.length === 0) {
      const punktPattern = /(?:^|\n)\s*(\d+)\.\s+([А-ЯІЇЄҐ][^\n]{10,})/g;
      const punktMatches: Array<{ number: string; title: string; index: number }> = [];

      while ((match = punktPattern.exec(bodyText)) !== null) {
        const num = parseInt(match[1], 10);
        // Only consider reasonable punkt numbers (1-999) and skip footnotes/references
        if (num > 0 && num < 1000) {
          punktMatches.push({
            number: match[1],
            title: match[2].trim().substring(0, 200),
            index: match.index,
          });
        }
      }

      // Extract text between consecutive punkts
      for (let i = 0; i < punktMatches.length; i++) {
        const startIdx = punktMatches[i].index;
        const endIdx = i + 1 < punktMatches.length ? punktMatches[i + 1].index : bodyText.length;
        const fullText = bodyText.substring(startIdx, endIdx).trim();

        if (fullText.length > 20) {
          articles.push({
            article_number: punktMatches[i].number,
            title: punktMatches[i].title.split(/[.;]/)[0].trim(),
            full_text: fullText,
            byte_size: Buffer.byteLength(fullText, 'utf8'),
            metadata: {
              rada_id: radaId,
              extraction_method: 'fallback_punkt',
            },
          });
        }
      }

      if (articles.length > 0) {
        logger.info(`Extracted ${articles.length} punkts (not articles) from ${radaId} via fallback`);
      }
    }

    // Last-resort fallback: short documents without Стаття/numbered punkts
    // (КМУ розпорядження, накази, короткі постанови з додатками-таблицями).
    // Store the whole document body as a single "article" so the text is at
    // least retrievable instead of yielding total_articles = 0.
    if (articles.length === 0) {
      const wholeText = bodyText
        .replace(/ /g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (wholeText.length > 50) {
        articles.push({
          article_number: '1',
          full_text: wholeText,
          byte_size: Buffer.byteLength(wholeText, 'utf8'),
          metadata: {
            rada_id: radaId,
            extraction_method: 'fallback_whole_document',
          },
        });
        logger.info(`Extracted whole document as single article for ${radaId} via fallback_whole_document (${wholeText.length} chars)`);
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
    try {
      const result = await this.db.transaction(async (client) => {
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
             (legislation_id, article_number, section_number, section_title, chapter_number, chapter_title, title,
              full_text, full_text_html, part_number, paragraph_number, notes,
              version_date, is_current, byte_size, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (legislation_id, article_number, version_date) DO UPDATE SET
               full_text = EXCLUDED.full_text,
               full_text_html = EXCLUDED.full_text_html,
               section_number = EXCLUDED.section_number,
               section_title = EXCLUDED.section_title,
               chapter_number = EXCLUDED.chapter_number,
               chapter_title = EXCLUDED.chapter_title,
               byte_size = EXCLUDED.byte_size,
               updated_at = NOW()
             RETURNING id`,
            [
              legislationId,
              article.article_number,
              article.section_number,
              article.section_title,
              article.chapter_number,
              article.chapter_title,
              article.title,
              article.full_text,
              article.full_text_html,
              article.part_number,
              article.paragraph_number,
              article.notes,
              article.version_date || new Date('2000-01-01T00:00:00Z'),
              true,
              article.byte_size,
              article.metadata || {},
            ]
          );

          articleIds.push(articleResult.rows[0].id);
        }

        logger.info(`Saved legislation ${metadata.rada_id} with ${articles.length} articles`);
        return { legislationId, articleIds };
      });

      return result;
    } catch (error: any) {
      logger.error(`Failed to save legislation to database: ${error.message}`);
      throw error;
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

  async getArticleByNumber(radaId: string, articleNumber: string, asOfDate?: string): Promise<LegislationArticle | null> {
    // КУпАП spans two RADA documents (80731-10 / 80732-10); search both halves.
    // Article numbers don't overlap between them, so the match stays unambiguous.
    const radaIds = expandKupapRadaIds(radaId).map((id) => id.toLowerCase());
    let result;
    if (asOfDate) {
      result = await this.db.query(
        `SELECT la.*, l.rada_id
         FROM legislation_articles la
         JOIN legislation l ON la.legislation_id = l.id
         WHERE LOWER(l.rada_id) = ANY($1) AND la.article_number = $2 AND la.version_date <= $3
         ORDER BY la.version_date DESC
         LIMIT 1`,
        [radaIds, articleNumber, asOfDate]
      );
    } else {
      result = await this.db.query(
        `SELECT la.*, l.rada_id
         FROM legislation_articles la
         JOIN legislation l ON la.legislation_id = l.id
         WHERE LOWER(l.rada_id) = ANY($1) AND la.article_number = $2 AND la.is_current = true
         ORDER BY la.version_date DESC NULLS LAST, la.id DESC
         LIMIT 1`,
        [radaIds, articleNumber]
      );
    }

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
          to_tsvector('simple', la.full_text) @@ plainto_tsquery('simple', $1)
          OR la.article_number ILIKE $2
        )
    `;

    const params: any[] = [query, `%${query}%`];

    if (radaId) {
      // КУпАП spans 80731-10 + 80732-10 — filter across both halves.
      sql += ` AND LOWER(l.rada_id) = ANY($3)`;
      params.push(expandKupapRadaIds(radaId).map((id) => id.toLowerCase()));
    }

    sql += ` ORDER BY ts_rank(to_tsvector('simple', la.full_text), plainto_tsquery('simple', $1)) DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  /**
   * FTS leg for the hybrid legislation retrieval path (LEXAI-1806).
   *
   * Unlike `searchArticles` (which AND-joins terms via plainto_tsquery('simple', …) and
   * is brittle against Ukrainian inflection), this builds an OR-of-prefixes tsquery
   * ("подат:* | нерух:* | окупова:*") so an article matching more topical stems ranks
   * higher, and separately matches exact article-number tokens from the query
   * (e.g. "266" → art. 266, "38.6" → п.38.6). Returns rows ordered by ts_rank, best first.
   */
  async searchArticlesHybrid(query: string, radaId?: string, limit: number = 24): Promise<any[]> {
    const tsq = buildLegislationTsquery(query);
    // Match both the bare token and its transitional "п."-prefixed form.
    const numberTokens = extractArticleNumberTokens(query);
    const articleNumberVariants = [
      ...numberTokens,
      ...numberTokens.map((t) => `п.${t}`),
    ];

    const params: any[] = [];
    const conditions: string[] = [];

    if (tsq) {
      params.push(tsq);
      conditions.push(`to_tsvector('simple', la.full_text) @@ to_tsquery('simple', $${params.length})`);
    }
    if (articleNumberVariants.length > 0) {
      params.push(articleNumberVariants);
      conditions.push(`la.article_number = ANY($${params.length})`);
    }

    // No usable terms at all → nothing to search on.
    if (conditions.length === 0) return [];

    let sql = `
      SELECT la.*, l.rada_id, l.title as legislation_title, l.short_title
      FROM legislation_articles la
      JOIN legislation l ON la.legislation_id = l.id
      WHERE la.is_current = true
        AND (${conditions.join(' OR ')})
    `;

    if (radaId) {
      params.push(expandKupapRadaIds(radaId.toLowerCase()).map((id) => id.toLowerCase()));
      sql += ` AND LOWER(l.rada_id) = ANY($${params.length})`;
    }

    // Rank by lexical relevance when we have a tsquery; otherwise fall back to a stable order.
    if (tsq) {
      sql += ` ORDER BY ts_rank(to_tsvector('simple', la.full_text), to_tsquery('simple', $1)) DESC`;
    } else {
      sql += ` ORDER BY la.id ASC`;
    }
    params.push(limit);
    sql += ` LIMIT $${params.length}`;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async fetchEditionDates(radaId: string): Promise<string[]> {
    if (/[^\p{L}\p{N}\-_\/\.]/u.test(radaId) || radaId.includes('..')) {
      throw new Error(`Invalid legislation ID: ${radaId}`);
    }
    const url = `${this.BASE_URL}/laws/show/${radaId}/card4`;
    logger.info(`Fetching edition dates from ${url}`);

    const response = await this.httpClient.get(url);
    const html = response.data as string;
    const edRegex = /\/ed(\d{8})/g;
    const dates = new Set<string>();
    let match;
    while ((match = edRegex.exec(html)) !== null) {
      dates.add(match[1]);
    }
    const sorted = [...dates].sort();
    logger.info(`Found ${sorted.length} editions for ${radaId}`);
    return sorted;
  }

  async fetchEdition(radaId: string, editionDate: string): Promise<{ metadata: LegislationMetadata; articles: LegislationArticle[] }> {
    if (/[^\p{L}\p{N}\-_\/\.]/u.test(radaId) || radaId.includes('..')) {
      throw new Error(`Invalid legislation ID: ${radaId}`);
    }
    if (!/^\d{8}$/.test(editionDate)) {
      throw new Error(`Invalid edition date format: ${editionDate}, expected YYYYMMDD`);
    }

    const url = `${this.BASE_URL}/laws/show/${radaId}/ed${editionDate}/print`;
    logger.info(`Fetching edition ${editionDate} from ${url}`);

    const callStart = Date.now();
    try {
      const response = await this.httpClient.get(url, { timeout: 60000 });
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.('zakon_rada', 'success', callDuration);

      const html = RadaLegislationAdapter.normalizeSuperscriptIndexes(String(response.data));
      const $ = cheerio.load(html);
      const metadata = this.extractMetadata($, radaId, url);

      const versionDate = new Date(
        parseInt(editionDate.substring(0, 4)),
        parseInt(editionDate.substring(4, 6)) - 1,
        parseInt(editionDate.substring(6, 8)),
      );

      // Edition pages use <pre><b> format
      let articles = this.extractArticlesPreBold(html);

      // Fallback to rvts9 format if pre/bold found nothing
      if (articles.length < 3) {
        articles = this.extractArticles($, radaId);
      }

      for (const art of articles) {
        art.version_date = versionDate;
        art.metadata = { ...art.metadata, edition_date: editionDate, extraction_method: 'edition_endpoint' };
      }

      logger.info(`Edition ${editionDate} of ${radaId}: ${articles.length} articles`);
      return { metadata, articles };
    } catch (error: any) {
      const callDuration = (Date.now() - callStart) / 1000;
      this.externalApiMetrics?.('zakon_rada', 'error', callDuration);
      logger.error(`Failed to fetch edition ${editionDate} of ${radaId}:`, error.message);
      throw error;
    }
  }

  private extractArticlesPreBold(html: string): LegislationArticle[] {
    const articles: LegislationArticle[] = [];
    // Bound the scan at the transitional block so the last <b>Стаття N.</b> can't swallow
    // the document tail (same mega-record defect as the /print parser — LEXAI-1809).
    const transitionalStart = this.findTransitionalSectionStart(html);
    const scanHtml = transitionalStart >= 0 ? html.slice(0, transitionalStart) : html;
    // Edition pages wrap text in <pre> blocks with <b>Стаття N.</b> headers
    const articleRegex = /<b>Стаття\s+(\d+(?:-\d+)?)\.?<\/b>\s*(.*?)(?=<b>Стаття\s+\d|<\/pre>\s*$|$)/gs;

    const seen = new Set<string>();
    let match;
    while ((match = articleRegex.exec(scanHtml)) !== null) {
      const articleNumber = match[1].trim();
      if (seen.has(articleNumber)) continue;
      seen.add(articleNumber);

      let body = match[2];
      // Clean HTML tags but preserve line breaks
      body = body.replace(/<br\s*\/?>/gi, '\n');
      body = body.replace(/<b>([^<]*)<\/b>/g, '$1');
      body = body.replace(/<[^>]+>/g, ' ');
      body = body.replace(/&nbsp;/g, ' ');
      body = body.replace(/&mdash;/g, '—');
      body = body.replace(/&laquo;/g, '«');
      body = body.replace(/&raquo;/g, '»');
      body = body.replace(/&amp;/g, '&');
      body = body.replace(/\{[^}]*\}/g, '');
      body = body.replace(/[ \t]+/g, ' ');
      body = body.replace(/\n\s*\n/g, '\n');
      body = body.trim();

      if (body.length < 5) continue;

      if (body.length > this.MEGA_ARTICLE_WARN_CHARS) {
        logger.error(
          `[legislation] Suspiciously large edition article ст.${articleNumber}: ${body.length} chars ` +
          `(> ${this.MEGA_ARTICLE_WARN_CHARS}) — probable parser tail-swallow, please re-check`
        );
      }

      const firstLine = body.split('\n')[0].trim();
      const title = firstLine.length < 200 ? firstLine : undefined;

      articles.push({
        article_number: articleNumber,
        title,
        full_text: body,
        byte_size: Buffer.byteLength(body, 'utf8'),
        metadata: { extraction_method: 'edition_pre_bold' },
      });
    }

    return articles;
  }

  setExternalApiMetrics(callback: (service: string, status: string, durationSec: number) => void) {
    this.externalApiMetrics = callback;
  }
}
