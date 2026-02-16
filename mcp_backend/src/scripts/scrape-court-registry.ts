/**
 * Scrape Court Decisions from reyestr.court.gov.ua
 *
 * Opens the Ukrainian court registry in a headed browser, fills the search form
 * with configurable justice kind, document form, and search text, then navigates
 * paginated results and downloads each decision's print-version HTML to disk.
 *
 * After downloading, each document is processed through the DB pipeline:
 *   HTML → text extraction → save to documents table → section extraction →
 *   save sections → generate embeddings → store in Qdrant
 *
 * The browser is headed so the user can solve CAPTCHAs manually.
 *
 * Environment variables:
 *   MAX_DOCS          - Max documents to download (default: unlimited)
 *   MAX_PAGES         - Max result pages to process (default: 100)
 *   DOWNLOAD_DIR      - Output directory (default: ~/Downloads)
 *   DELAY_MS          - Delay between downloads in ms (default: 2000)
 *   CONCURRENCY       - Parallel processing threads (default: 10)
 *   SKIP_EMBEDDINGS   - If "true", save to DB but skip embedding step
 *   PROCESS_ONLY      - If "true", skip scraping and process existing HTML files
 *   JUSTICE_KIND      - Justice kind to search (default: "Цивільне")
 *                       Options: Цивільне, Господарське, Адміністративне, Кримінальне
 *   JUSTICE_KIND_ID   - Numeric ID for metadata grouping (default: "1")
 *                       1=Цивільне, 2=Господарське, 3=Адміністративне, 4=Кримінальне
 *   DOC_FORM          - Document form to search (default: "Рішення")
 *   SEARCH_TEXT       - Text to search in decisions (optional, fills the text field)
 *   DATE_FROM         - Start date dd.mm.yyyy (default: "01.01.2010")
 *
 * Usage:
 *   npm run scrape:court
 *   MAX_DOCS=10 npm run scrape:court
 *   PROCESS_ONLY=true CONCURRENCY=5 npm run scrape:court
 *   JUSTICE_KIND=Цивільне SEARCH_TEXT="витребувати майно" MAX_DOCS=2000 npm run scrape:court
 */

import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { load } from 'cheerio';
import { Database } from '../database/database.js';
import { DocumentService, type Document } from '../services/document-service.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { SectionType } from '../types/index.js';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';

const MAX_DOCS = parseInt(process.env.MAX_DOCS || '0', 10) || Infinity;
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '100', 10);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads');
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const SKIP_EMBEDDINGS = process.env.SKIP_EMBEDDINGS === 'true';
const PROCESS_ONLY = process.env.PROCESS_ONLY === 'true';
const JUSTICE_KIND = process.env.JUSTICE_KIND || 'Цивільне';
const JUSTICE_KIND_ID = process.env.JUSTICE_KIND_ID || '1';
const DOC_FORM = process.env.DOC_FORM || 'Рішення';
const SEARCH_TEXT = process.env.SEARCH_TEXT || '';
const DATE_FROM = process.env.DATE_FROM || '01.01.2010';
const BASE_URL = 'https://reyestr.court.gov.ua/';

// Processing stats
let processedCount = 0;
let processErrors = 0;
let embeddedCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── DB Pipeline ────────────────────────────────────────────────────────────

interface ProcessingContext {
  db: Database;
  documentService: DocumentService;
  sectionizer: SemanticSectionizer;
  embeddingService: EmbeddingService | null;
}

async function initServices(): Promise<ProcessingContext> {
  const db = new Database();
  const documentService = new DocumentService(db);
  const sectionizer = new SemanticSectionizer();
  let embeddingService: EmbeddingService | null = null;

  if (!SKIP_EMBEDDINGS) {
    embeddingService = new EmbeddingService();
    await embeddingService.initialize();
  }

  return { db, documentService, sectionizer, embeddingService };
}

function extractMetadataFromHTML(html: string, docId: string): {
  title: string;
  caseNumber: string | null;
  court: string | null;
  date: string | null;
  disputeCategory: string | null;
  fullText: string;
} {
  const $ = load(html);

  // Court registry pages store the decision as nested HTML inside <textarea id="txtdepository">
  // and metadata in #divcasecat / #info
  const innerHtml = $('#txtdepository').text() || '';
  let fullText = '';

  if (innerHtml.length > 0) {
    // Parse the inner HTML to extract plain text
    const inner$ = load(innerHtml);
    fullText = inner$('body').text().replace(/\s+/g, ' ').trim();
  }

  // Fallback: try CourtDecisionHTMLParser (works for ZakonOnline-style pages)
  if (!fullText || fullText.length < 100) {
    try {
      const parser = new CourtDecisionHTMLParser(html);
      fullText = parser.toText('plain');
    } catch {
      // Last resort: strip all tags from body
      fullText = $('body').text().replace(/\s+/g, ' ').trim();
    }
  }

  // Metadata from #divcasecat header line:
  // "Категорія справи № 2-229/2010: Цивільні справи; Позовне провадження; Спори..."
  const casecatText = $('#divcasecat').text() || '';
  const infoText = $('#info').text() || '';
  const metaText = casecatText + ' ' + infoText;

  // Case number: "справи № XXX" or "Справа №XXX"
  let caseNumber: string | null = null;
  const caseMatch = metaText.match(/(?:справи?|Справа)\s*№\s*([\d\w\-\/]+)/i)
    || fullText.match(/Справа\s*№\s*([\d\w\-\/]+)/i);
  if (caseMatch) {
    caseNumber = caseMatch[1];
  }

  // Court name from decision text
  let court: string | null = null;
  const courtMatch = fullText.match(
    /([А-ЯІЇЄҐа-яіїєґ''\s]+(?:районний|апеляційний|касаційний|господарський|окружний|міський)\s+суд[а-яіїєґ''\s]*)/i
  );
  if (courtMatch) {
    court = courtMatch[1].trim().replace(/\s+/g, ' ').substring(0, 200);
  }

  // Date: "Дата набрання законної сили: dd.mm.yyyy" or first dd.mm.yyyy in text
  let date: string | null = null;
  const dateForceMatch = metaText.match(/набрання законної сили:\s*(\d{2}\.\d{2}\.\d{4})/);
  const dateFallback = fullText.match(/(\d{2}\.\d{2}\.\d{4})/);
  const dateStr = dateForceMatch ? dateForceMatch[1] : dateFallback ? dateFallback[1] : null;
  if (dateStr) {
    const [dd, mm, yyyy] = dateStr.split('.');
    date = `${yyyy}-${mm}-${dd}`;
  }

  // Dispute category from divcasecat: text after the case number colon
  let disputeCategory: string | null = null;
  const categoryMatch = casecatText.match(/:\s*(.+)/);
  if (categoryMatch) {
    disputeCategory = categoryMatch[1].trim().substring(0, 255);
  }

  // Title
  const title = caseNumber
    ? `Рішення у справі ${caseNumber}`
    : `Рішення ${docId}`;

  return {
    title,
    caseNumber,
    court,
    date,
    disputeCategory,
    fullText,
  };
}

async function processDocument(
  ctx: ProcessingContext,
  docId: string,
  html: string
): Promise<boolean> {
  try {
    // 1. Extract text and metadata
    const meta = extractMetadataFromHTML(html, docId);

    if (!meta.fullText || meta.fullText.length < 100) {
      console.log(`  [PROC ${docId}] Text too short (${meta.fullText.length} chars), skipping`);
      return false;
    }

    // 2. Save to documents table
    const doc: Document = {
      zakononline_id: `court_${docId}`,
      type: 'court_decision',
      title: meta.title,
      date: meta.date || undefined,
      case_number: meta.caseNumber || undefined,
      court: meta.court || undefined,
      dispute_category: meta.disputeCategory || undefined,
      full_text: meta.fullText,
      full_text_html: html,
      metadata: {
        source: 'reyestr.court.gov.ua',
        registry_id: docId,
        justice_kind: JUSTICE_KIND_ID,
        search_text: SEARCH_TEXT || undefined,
        scraped_at: new Date().toISOString(),
      },
    };

    const documentUuid = await ctx.documentService.saveDocument(doc);
    console.log(`  [PROC ${docId}] Saved to DB (uuid=${documentUuid.substring(0, 8)}..., text=${meta.fullText.length} chars)`);

    // 3. Extract sections
    const sections = await ctx.sectionizer.extractSections(meta.fullText, false);
    if (sections.length > 0) {
      await ctx.documentService.saveSections(documentUuid, sections);
      console.log(`  [PROC ${docId}] ${sections.length} sections saved`);
    }

    // 4. Generate embeddings and store in Qdrant
    if (ctx.embeddingService && sections.length > 0) {
      const indexable = sections.filter(
        (s) => s.type === SectionType.DECISION || s.type === SectionType.COURT_REASONING
      );

      if (indexable.length > 0) {
        for (const section of indexable) {
          const chunks = ctx.embeddingService.splitIntoChunks(section.text);
          if (chunks.length === 0) continue;

          const embeddings = await ctx.embeddingService.generateEmbeddingsBatch(chunks);
          const nowIso = new Date().toISOString();

          await Promise.all(chunks.map((chunk, i) =>
            ctx.embeddingService!.storeChunk({
              id: '',
              source: 'zakononline',
              doc_id: documentUuid,
              section_type: section.type,
              text: chunk,
              embedding: embeddings[i],
              metadata: {
                date: meta.date || '',
                court: meta.court || undefined,
                case_number: meta.caseNumber || undefined,
                dispute_category: meta.disputeCategory || undefined,
              },
              created_at: nowIso,
            })
          ));
        }
        embeddedCount++;
        console.log(`  [PROC ${docId}] Embeddings stored (${indexable.length} sections)`);
      }
    }

    processedCount++;
    return true;
  } catch (error: any) {
    console.error(`  [PROC ${docId}] Error: ${error.message}`);
    processErrors++;
    return false;
  }
}

/**
 * Process documents with a concurrency pool.
 * Accepts an array of { docId, html } items and processes up to CONCURRENCY at a time.
 */
async function processWithPool(
  ctx: ProcessingContext,
  items: Array<{ docId: string; html: string }>
): Promise<void> {
  const active: Promise<void>[] = [];

  for (const item of items) {
    const task = processDocument(ctx, item.docId, item.html).then(() => {
      // Remove from active pool when done
      const idx = active.indexOf(task);
      if (idx !== -1) active.splice(idx, 1);
    });
    active.push(task);

    // When pool is full, wait for one to finish
    if (active.length >= CONCURRENCY) {
      await Promise.race(active);
    }
  }

  // Wait for remaining tasks
  await Promise.all(active);
}

// ─── Scraping Functions ─────────────────────────────────────────────────────

async function waitForCaptcha(page: Page): Promise<void> {
  const captchaVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
  if (!captchaVisible) return;

  console.log('\n  CAPTCHA detected! Please solve it in the browser window.');
  console.log('   Waiting up to 5 minutes...\n');

  const startTime = Date.now();
  const timeout = 5 * 60 * 1000;

  while (Date.now() - startTime < timeout) {
    const stillVisible = await page.locator('#modalcaptcha').isVisible().catch(() => false);
    if (!stillVisible) {
      console.log('   CAPTCHA solved, continuing...\n');
      return;
    }
    await sleep(1000);
  }

  throw new Error('CAPTCHA timeout — not solved within 5 minutes');
}

async function clickMultiSelectOption(page: Page, labelText: string): Promise<boolean> {
  const containers = page.locator('.multiSelectOptions');
  const count = await containers.count();

  for (let i = 0; i < count; i++) {
    const container = containers.nth(i);
    const label = container.locator(`label:has-text("${labelText}")`);

    if (await label.count() > 0) {
      const isVisible = await container.isVisible().catch(() => false);
      if (!isVisible) {
        const trigger = container.locator('..').locator('.multiSelectTrigger, .trigger, > span, > a, > div').first();
        if (await trigger.count() > 0) {
          await trigger.click();
          await sleep(300);
        }
      }

      await label.first().click();
      console.log(`  Checked: "${labelText}"`);
      return true;
    }
  }

  const fallbackLabel = page.locator(`.multiSelectOptions label:has-text("${labelText}")`);
  if (await fallbackLabel.count() > 0) {
    await fallbackLabel.first().scrollIntoViewIfNeeded();
    await fallbackLabel.first().click();
    console.log(`  Checked (fallback): "${labelText}"`);
    return true;
  }

  console.log(`  WARNING: Could not find multi-select option "${labelText}"`);
  return false;
}

async function fillSearchForm(page: Page): Promise<void> {
  console.log('Filling search form...');
  console.log(`  Justice kind: ${JUSTICE_KIND} (id=${JUSTICE_KIND_ID})`);
  console.log(`  Document form: ${DOC_FORM}`);
  if (SEARCH_TEXT) console.log(`  Search text: "${SEARCH_TEXT}"`);

  await page.waitForSelector('select', { timeout: 10000 });
  await sleep(1000);

  // Select justice kind (Цивільне, Господарське, etc.)
  await clickMultiSelectOption(page, JUSTICE_KIND);
  await sleep(500);

  // Select document form (Рішення, Ухвала, etc.)
  await clickMultiSelectOption(page, DOC_FORM);
  await sleep(500);

  // Fill search text if provided (searches in decision text)
  if (SEARCH_TEXT) {
    const textInput = page.locator('input[name="SearchExpression"], textarea[name="SearchExpression"]');
    if (await textInput.count() > 0) {
      await textInput.first().fill(SEARCH_TEXT);
      console.log(`  Set search text: "${SEARCH_TEXT}"`);
    } else {
      // Fallback: try any large text input
      const fallbackInput = page.locator('textarea, input[type="text"][name*="text" i], input[type="text"][name*="search" i]');
      if (await fallbackInput.count() > 0) {
        await fallbackInput.first().fill(SEARCH_TEXT);
        console.log(`  Set search text (fallback): "${SEARCH_TEXT}"`);
      } else {
        console.log('  WARNING: Could not find text search input');
      }
    }
    await sleep(500);
  }

  // Set date from
  const dateFrom = page.locator('input[name="DateFrom"]');
  if (await dateFrom.count() > 0) {
    await dateFrom.fill(DATE_FROM);
    console.log(`  Set date from: ${DATE_FROM}`);
  } else {
    const dateInputs = page.locator('input[type="text"][id*="date" i], input[type="text"][name*="date" i], input[type="text"][placeholder*="дд.мм.рррр"]');
    if (await dateInputs.count() > 0) {
      await dateInputs.first().fill(DATE_FROM);
      console.log(`  Set date from: ${DATE_FROM} (fallback)`);
    }
  }
  await sleep(500);

  const pageSizeEl = page.locator('select[name="PagingInfo.ItemsPerPage"]');
  if (await pageSizeEl.count() > 0) {
    await pageSizeEl.selectOption('100');
    console.log('  Set page size: 100');
  }
}

async function clickSearch(page: Page): Promise<void> {
  console.log('Clicking search button...');

  try {
    await page.evaluate('Btn_search_click()');
  } catch {
    const searchBtn = page.locator(
      '#search_btn, .searchbtn, input[type="submit"], button:has-text("Пошук"), a[onclick*="Btn_search"]'
    );
    if (await searchBtn.count() > 0) {
      await searchBtn.first().click();
    } else {
      await page.locator('#login > form, form').first().evaluate((form: any) => form.submit());
    }
  }

  await sleep(3000);
  await waitForCaptcha(page);

  console.log('Waiting for results...');
  await page.waitForSelector(
    '.search_result, .result, table.results, #divresult, a[href*="/Review/"]',
    { timeout: 60000 }
  ).catch(() => {
    console.log('  Could not detect standard result container, continuing anyway...');
  });

  await sleep(2000);
}

async function extractDecisionLinks(page: Page): Promise<{ url: string; id: string }[]> {
  const anchors = await page.locator('a[href*="/Review/"]').all();
  const results: { url: string; id: string }[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href');
    if (!href) continue;
    const match = href.match(/\/Review\/(\d+)/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      results.push({ url: `${BASE_URL.replace(/\/$/, '')}${href}`, id: match[1] });
    }
  }

  return results;
}

async function downloadDecisionDirect(
  context: import('playwright').BrowserContext,
  docId: string
): Promise<string | null> {
  const filePath = path.join(DOWNLOAD_DIR, `${docId}.html`);

  // If already downloaded, return existing HTML
  if (fs.existsSync(filePath)) {
    console.log(`  [${docId}] Already exists, reading from disk`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  const tab = await context.newPage();
  try {
    const url = `${BASE_URL}Review/${docId}`;
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    const html = await tab.content();
    fs.writeFileSync(filePath, html, 'utf-8');
    console.log(`  [${docId}] Saved (${(html.length / 1024).toFixed(1)} KB)`);
    return html;
  } catch (error: any) {
    console.error(`  [${docId}] Error: ${error.message}`);
    return null;
  } finally {
    await tab.close();
  }
}

/**
 * Download documents using a pool of concurrent browser tabs.
 * Returns array of { docId, html } for successfully downloaded docs.
 */
async function downloadWithPool(
  context: import('playwright').BrowserContext,
  ids: string[]
): Promise<Array<{ docId: string; html: string }>> {
  const results: Array<{ docId: string; html: string }> = [];
  const active: Promise<void>[] = [];

  for (const docId of ids) {
    const task = downloadDecisionDirect(context, docId).then((html) => {
      if (html) results.push({ docId, html });
      const idx = active.indexOf(task);
      if (idx !== -1) active.splice(idx, 1);
    });
    active.push(task);

    if (active.length >= CONCURRENCY) {
      await Promise.race(active);
    }
  }

  await Promise.all(active);
  return results;
}

async function goToNextPage(page: Page): Promise<boolean> {
  const nextBtn = page.locator(
    'a:has-text("Наступна"), a:has-text("»"), a:has-text(">"):not(:has-text(">>"))'
  );
  const paginationNext = page.locator('.pagination a.next, .pager a.next, a[title="Наступна сторінка"]');

  let clicked = false;

  if (await paginationNext.count() > 0) {
    await paginationNext.first().click();
    clicked = true;
  } else if (await nextBtn.count() > 0) {
    await nextBtn.first().click();
    clicked = true;
  }

  if (!clicked) {
    console.log('No next page button found.');
    return false;
  }

  await sleep(3000);
  await waitForCaptcha(page);
  await sleep(2000);

  return true;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Court Registry Scraper + DB Pipeline');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Justice kind:     ${JUSTICE_KIND} (id=${JUSTICE_KIND_ID})`);
  console.log(`  Document form:    ${DOC_FORM}`);
  console.log(`  Search text:      ${SEARCH_TEXT || '(none)'}`);
  console.log(`  Date from:        ${DATE_FROM}`);
  console.log(`  Max documents:    ${MAX_DOCS === Infinity ? 'unlimited' : MAX_DOCS}`);
  console.log(`  Max pages:        ${MAX_PAGES}`);
  console.log(`  Download dir:     ${DOWNLOAD_DIR}`);
  console.log(`  Delay:            ${DELAY_MS}ms`);
  console.log(`  Concurrency:      ${CONCURRENCY}`);
  console.log(`  Skip embeddings:  ${SKIP_EMBEDDINGS}`);
  console.log(`  Process only:     ${PROCESS_ONLY}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Initialize DB services
  console.log('Initializing database services...');
  const ctx = await initServices();
  console.log('  DB services ready.\n');

  let totalDownloaded = 0;
  let totalErrors = 0;

  if (PROCESS_ONLY) {
    // Process existing HTML files from DOWNLOAD_DIR
    console.log('PROCESS_ONLY mode: processing existing HTML files...\n');
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.html'));
    const items: Array<{ docId: string; html: string }> = [];

    for (const file of files) {
      if (items.length >= MAX_DOCS) break;
      const docId = path.basename(file, '.html');
      const html = fs.readFileSync(path.join(DOWNLOAD_DIR, file), 'utf-8');
      items.push({ docId, html });
    }

    console.log(`Found ${items.length} HTML files to process\n`);
    await processWithPool(ctx, items);
  } else {
    // Scrape + process
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'uk-UA',
    });
    const page = await context.newPage();

    try {
      console.log('Navigating to court registry...');
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      await fillSearchForm(page);
      await clickSearch(page);

      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        if (totalDownloaded >= MAX_DOCS) break;

        console.log(`\n--- Page ${pageNum} ---`);

        const links = await extractDecisionLinks(page);
        console.log(`Found ${links.length} decisions on this page`);

        if (links.length === 0) {
          console.log('No decisions found, stopping.');
          break;
        }

        // Take only as many IDs as we still need
        const remaining = MAX_DOCS - totalDownloaded;
        const idsToDownload = links.slice(0, remaining).map(l => l.id);

        // Download concurrently with CONCURRENCY tabs
        console.log(`  Downloading ${idsToDownload.length} decisions (${CONCURRENCY} concurrent tabs)...`);
        const downloaded = await downloadWithPool(context, idsToDownload);
        totalDownloaded += downloaded.length;
        totalErrors += idsToDownload.length - downloaded.length;

        // Process downloaded batch through DB pipeline
        if (downloaded.length > 0) {
          console.log(`\n  Processing batch of ${downloaded.length} documents...`);
          await processWithPool(ctx, downloaded);
        }

        if (totalDownloaded < MAX_DOCS && pageNum < MAX_PAGES) {
          const hasNext = await goToNextPage(page);
          if (!hasNext) break;
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Cleanup DB connection
  await ctx.db.close();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Downloaded:   ${totalDownloaded}`);
  console.log(`  Download err: ${totalErrors}`);
  console.log(`  Processed:    ${processedCount}`);
  console.log(`  Process err:  ${processErrors}`);
  console.log(`  Embedded:     ${embeddedCount}`);
  console.log(`  Output dir:   ${DOWNLOAD_DIR}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
