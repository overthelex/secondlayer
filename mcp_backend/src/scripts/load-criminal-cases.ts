/**
 * Load Criminal Court Decisions
 *
 * Two phases:
 *   Phase 1: Backfill full text for existing criminal cases (justice_kind=5) without text
 *   Phase 2: Search ZO API for new criminal cases not yet in the database
 *
 * Environment variables:
 *   CONCURRENCY    - parallel workers (default: 7)
 *   DELAY_MS       - ms between requests per worker (default: 300)
 *   MAX_NEW_DOCS   - max new docs to fetch in Phase 2 (default: 2000)
 *   DATE_FROM      - start date for Phase 2 search (default: 3 years ago)
 *   DATE_TO        - end date for Phase 2 search (default: today)
 *   BATCH_DAYS     - days per search window (default: 30)
 *   PAGE_SIZE      - results per ZO API page (default: 100)
 *   MAX_PAGES      - max pages per keyword per window (default: 10)
 *   SKIP_PHASE1    - skip backfill phase (default: false)
 *   SKIP_PHASE2    - skip new search phase (default: false)
 *   DRY_RUN        - parse but don't write to DB (default: false)
 *
 * Usage:
 *   node dist/scripts/load-criminal-cases.js
 *   CONCURRENCY=7 MAX_NEW_DOCS=2000 node dist/scripts/load-criminal-cases.js
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'cheerio';
import { Database } from '../database/database.js';
import { DocumentService, Document } from '../services/document-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { logger } from '../utils/logger.js';

// --- Config ---
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '7', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '300', 10);
const MAX_NEW_DOCS = parseInt(process.env.MAX_NEW_DOCS || '2000', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_PHASE1 = process.env.SKIP_PHASE1 === 'true';
const SKIP_PHASE2 = process.env.SKIP_PHASE2 === 'true';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/criminal-backfill';
const BASE_URL = 'https://reyestr.court.gov.ua/Review';

// Phase 2 config
const DATE_FROM = process.env.DATE_FROM || '';
const DATE_TO = process.env.DATE_TO || '';
const BATCH_DAYS = parseInt(process.env.BATCH_DAYS || '30', 10);
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '100', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '10', 10);

// Criminal case search keywords for Phase 2
const CRIMINAL_KEYWORDS = [
  'кримінальне провадження',
  'обвинувальний акт',
  'кримінальне правопорушення',
  'вирок у кримінальній справі',
  'запобіжний захід',
  'тримання під вартою',
  'домашній арешт кримінальне',
  'угода про визнання винуватості',
];

// --- Stats ---
let shuttingDown = false;
const phase1Stats = { processed: 0, success: 0, skipped: 0, errors: 0 };
const phase2Stats = { fetched: 0, newDocs: 0, saved: 0, errors: 0 };

// --- Helpers ---
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

// --- HTML extraction (from backfill-fulltext-reyestr.ts) ---
function extractMetadataFromHTML(html: string, docId: string) {
  const $ = load(html);
  const innerHtml = $('#txtdepository').text() || '';
  let fullText = '';

  if (innerHtml.length > 0) {
    const inner$ = load(innerHtml);
    fullText = inner$('body').text().replace(/\s+/g, ' ').trim();
  }

  if (!fullText || fullText.length < 100) {
    try {
      const parser = new CourtDecisionHTMLParser(html);
      fullText = parser.toText('plain');
    } catch {
      fullText = $('body').text().replace(/\s+/g, ' ').trim();
    }
  }

  const casecatText = $('#divcasecat').text() || '';
  const infoText = $('#info').text() || '';
  const metaText = casecatText + ' ' + infoText;

  let caseNumber: string | null = null;
  const caseMatch = metaText.match(/(?:справи?|Справа)\s*№\s*([\d\w\-\/]+)/i)
    || fullText.match(/Справа\s*№\s*([\d\w\-\/]+)/i);
  if (caseMatch) caseNumber = caseMatch[1];

  let court: string | null = null;
  const courtMatch = fullText.match(
    /([А-ЯІЇЄҐа-яіїєґ''\s]+(?:районний|апеляційний|касаційний|господарський|окружний|міський)\s+суд[а-яіїєґ''\s]*)/i
  );
  if (courtMatch) court = courtMatch[1].trim().replace(/\s+/g, ' ').substring(0, 200);

  let date: string | null = null;
  const dateForceMatch = metaText.match(/набрання законної сили:\s*(\d{2}\.\d{2}\.\d{4})/);
  const dateFallback = fullText.match(/(\d{2}\.\d{2}\.\d{4})/);
  const dateStr = dateForceMatch ? dateForceMatch[1] : dateFallback ? dateFallback[1] : null;
  if (dateStr) {
    const [dd, mm, yyyy] = dateStr.split('.');
    date = `${yyyy}-${mm}-${dd}`;
  }

  let disputeCategory: string | null = null;
  const categoryMatch = casecatText.match(/:\s*(.+)/);
  if (categoryMatch) disputeCategory = categoryMatch[1].trim().substring(0, 255);

  const title = caseNumber ? `Вирок/Ухвала у справі ${caseNumber}` : `Рішення ${docId}`;

  return { title, caseNumber, court, date, disputeCategory, fullText };
}

// --- HTTP fetch with retries ---
async function fetchWithRetry(url: string, retries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'uk-UA,uk;q=0.9',
        },
        maxRedirects: 5,
      });

      const html = response.data as string;

      if (html.includes('captcha') || html.includes('CAPTCHA') || html.includes('recaptcha')) {
        logger.warn(`CAPTCHA detected at ${url}, pausing 30s`);
        await sleep(30000);
        continue;
      }

      return html;
    } catch (error: any) {
      const status = error.response?.status;
      const code = error.code;

      if (status === 429) {
        await sleep(30000);
        continue;
      }
      if (status === 404) return null;

      const isTransient = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)
        || status === 503 || status === 502;

      if (isTransient && attempt < retries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 15000));
        continue;
      }

      return null;
    }
  }
  return null;
}

// --- Disk cache ---
function readFromCache(id: string): string | null {
  try {
    const p = path.join(CACHE_DIR, `${id}.html`);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch { /* ignore */ }
  return null;
}

function writeToCache(id: string, html: string): void {
  try { fs.writeFileSync(path.join(CACHE_DIR, `${id}.html`), html, 'utf-8'); } catch { /* ignore */ }
}

// ============================================================
// Phase 1: Backfill full text for existing criminal cases
// ============================================================

interface DocRow {
  id: string;
  zakononline_id: string;
  case_number: string | null;
}

async function phase1Worker(
  workerId: number,
  queue: DocRow[],
  documentService: DocumentService,
  sectionizer: SemanticSectionizer,
): Promise<void> {
  while (!shuttingDown) {
    const row = queue.shift();
    if (!row) break;

    try {
      let html = readFromCache(row.zakononline_id);
      if (!html) {
        html = await fetchWithRetry(`${BASE_URL}/${row.zakononline_id}`);
        if (!html) {
          phase1Stats.skipped++;
          phase1Stats.processed++;
          await sleep(DELAY_MS);
          continue;
        }
        writeToCache(row.zakononline_id, html);
      }

      const meta = extractMetadataFromHTML(html, row.zakononline_id);

      if (!meta.fullText || meta.fullText.length < 50) {
        phase1Stats.skipped++;
        phase1Stats.processed++;
        await sleep(DELAY_MS);
        continue;
      }

      if (!DRY_RUN) {
        const doc: Document = {
          id: row.id,
          zakononline_id: row.zakononline_id,
          type: 'court_decision',
          title: meta.title,
          date: meta.date || undefined,
          case_number: meta.caseNumber || undefined,
          court: meta.court || undefined,
          dispute_category: meta.disputeCategory || undefined,
          full_text: meta.fullText,
          full_text_html: html,
        };
        await documentService.saveDocument(doc);

        try {
          const sections = await sectionizer.extractSections(meta.fullText, false);
          if (sections.length > 0) {
            await documentService.saveSections(row.id, sections);
          }
        } catch { /* sections are optional */ }
      }

      phase1Stats.success++;
    } catch (err: any) {
      logger.error(`P1 worker ${workerId} error on ${row.zakononline_id}: ${err.message}`);
      phase1Stats.errors++;
    }

    phase1Stats.processed++;

    if (phase1Stats.processed % 50 === 0) {
      const total = queue.length + phase1Stats.processed;
      const pct = ((phase1Stats.processed / total) * 100).toFixed(1);
      console.log(
        `  [Phase 1] ${phase1Stats.processed}/${total} (${pct}%) — ` +
        `${phase1Stats.success} ok, ${phase1Stats.skipped} skip, ${phase1Stats.errors} err`
      );
    }

    await sleep(DELAY_MS);
  }
}

async function runPhase1(db: Database, documentService: DocumentService): Promise<void> {
  console.log('\n═══ Phase 1: Backfill full text for existing criminal cases ═══\n');

  const sectionizer = new SemanticSectionizer();
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const result = await db.query(`
    SELECT d.id, d.zakononline_id, d.case_number
    FROM documents d
    WHERE (d.full_text IS NULL OR length(d.full_text) < 100)
      AND d.zakononline_id ~ '^\\d+$'
      AND d.type = 'court_decision'
      AND d.metadata->>'justice_kind' = '5'
    ORDER BY d.date DESC NULLS LAST
  `);

  const docs: DocRow[] = result.rows;
  console.log(`  Found ${docs.length} criminal cases without full text`);

  if (docs.length === 0) {
    console.log('  Nothing to do in Phase 1.');
    return;
  }

  const queue = [...docs];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(phase1Worker(i, queue, documentService, sectionizer));
  }
  await Promise.all(workers);

  console.log(`\n  Phase 1 complete: ${phase1Stats.success} texts saved, ${phase1Stats.skipped} skipped, ${phase1Stats.errors} errors`);
}

// ============================================================
// Phase 2: Search ZO API for new criminal cases
// ============================================================

interface WindowRange { start: string; end: string; }

function generateWindows(startDate: string, endDate: string, batchDays: number): WindowRange[] {
  const windows: WindowRange[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  let current = new Date(start);
  while (current <= end) {
    const windowEnd = new Date(current);
    windowEnd.setDate(windowEnd.getDate() + batchDays - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    windows.push({ start: formatDate(current), end: formatDate(windowEnd) });
    current.setDate(current.getDate() + batchDays);
  }
  return windows;
}

async function runPhase2(
  db: Database,
  documentService: DocumentService,
  embeddingService: EmbeddingService,
): Promise<void> {
  console.log('\n═══ Phase 2: Search ZO API for new criminal cases ═══\n');

  const now = new Date();
  const threeYearsAgo = new Date(now);
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const dateFrom = DATE_FROM || formatDate(threeYearsAgo);
  const dateTo = DATE_TO || formatDate(now);
  const windows = generateWindows(dateFrom, dateTo, BATCH_DAYS);

  console.log(`  Date range: ${dateFrom} to ${dateTo} (${windows.length} windows)`);
  console.log(`  Keywords: ${CRIMINAL_KEYWORDS.length}`);
  console.log(`  Target: ${MAX_NEW_DOCS} new docs`);

  // Load existing zakononline_ids to deduplicate
  const existingResult = await db.query(
    `SELECT zakononline_id FROM documents WHERE zakononline_id IS NOT NULL AND type = 'court_decision'`
  );
  const existingIds = new Set(existingResult.rows.map((r: any) => String(r.zakononline_id)));
  console.log(`  Existing docs in DB: ${existingIds.size}`);

  const zoAdapter = new ZOAdapter(documentService, undefined, embeddingService);
  const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || '';
  const pendingDocs: any[] = [];

  for (const keyword of CRIMINAL_KEYWORDS) {
    if (phase2Stats.newDocs >= MAX_NEW_DOCS || shuttingDown) break;
    console.log(`\n  Keyword: "${keyword}"`);

    for (let wi = 0; wi < windows.length; wi += CONCURRENCY) {
      if (phase2Stats.newDocs >= MAX_NEW_DOCS || shuttingDown) break;

      const batch = windows.slice(wi, Math.min(wi + CONCURRENCY, windows.length));
      const results = await Promise.all(
        batch.map(async (w) => {
          const found: any[] = [];
          for (let page = 1; page <= MAX_PAGES; page++) {
            if (phase2Stats.newDocs + found.length >= MAX_NEW_DOCS) break;
            try {
              const response = await zoAdapter.searchCourtDecisions({
                meta: { search: keyword },
                where: [
                  { field: 'adjudication_date', operator: '>=', value: w.start },
                  { field: 'adjudication_date', operator: '<=', value: w.end },
                  { field: 'justice_kind', operator: '=', value: 5 },
                ],
                limit: PAGE_SIZE,
                page,
                orderBy: { field: 'adjudication_date', direction: 'desc' },
              });

              const items = Array.isArray(response) ? response : response?.data || [];
              phase2Stats.fetched += items.length;

              for (const doc of items) {
                const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
                if (!docId || docId === 'undefined') continue;
                if (!existingIds.has(docId)) {
                  existingIds.add(docId);
                  found.push(doc);
                }
              }

              if (items.length < PAGE_SIZE) break;
              await sleep(300);
            } catch (err: any) {
              phase2Stats.errors++;
              logger.error(`ZO search error [${keyword}] ${w.start}..${w.end} p${page}: ${err.message}`);
              await sleep(2000);
              break;
            }
          }
          return found;
        })
      );

      for (const found of results) {
        phase2Stats.newDocs += found.length;
        pendingDocs.push(...found);
      }

      // Save in batches of 100
      while (pendingDocs.length >= 100) {
        const toSave = pendingDocs.splice(0, 100);
        if (!DRY_RUN) {
          if (docServiceUrl) {
            await saveBatchViaDocService(docServiceUrl, toSave);
          } else {
            await zoAdapter.saveDocumentsToDatabase(toSave, toSave.length);
          }
          phase2Stats.saved += toSave.length;
        }
        console.log(`    Saved batch: ${toSave.length} (total new: ${phase2Stats.newDocs})`);
      }

      const windowsDone = Math.min(wi + CONCURRENCY, windows.length);
      console.log(`    Windows ${windowsDone}/${windows.length}: ${phase2Stats.newDocs} new found`);
    }
  }

  // Flush remaining
  if (pendingDocs.length > 0 && !DRY_RUN) {
    if (docServiceUrl) {
      await saveBatchViaDocService(docServiceUrl, pendingDocs);
    } else {
      await zoAdapter.saveDocumentsToDatabase(pendingDocs, pendingDocs.length);
    }
    phase2Stats.saved += pendingDocs.length;
    console.log(`    Saved final batch: ${pendingDocs.length}`);
  }

  console.log(`\n  Phase 2 complete: ${phase2Stats.fetched} fetched, ${phase2Stats.newDocs} new, ${phase2Stats.saved} saved, ${phase2Stats.errors} errors`);
}

async function saveBatchViaDocService(docServiceUrl: string, docs: any[]): Promise<void> {
  for (let i = 0; i < docs.length; i += 5) {
    const batch = docs.slice(i, i + 5);
    await Promise.all(
      batch.map(async (doc) => {
        try {
          const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
          await axios.post(
            `${docServiceUrl}/api/scrape-fulltext`,
            { doc_id: docId, metadata: doc },
            { timeout: 30000 },
          );
        } catch (err: any) {
          if (err.response?.status === 429) {
            const retryAfter = parseInt(err.response.headers['retry-after'] || '5', 10);
            await sleep(retryAfter * 1000);
          }
        }
      })
    );
  }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Criminal Court Decisions Loader');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Concurrency:   ${CONCURRENCY}`);
  console.log(`  Delay:         ${DELAY_MS}ms`);
  console.log(`  Max new docs:  ${MAX_NEW_DOCS}`);
  console.log(`  Dry run:       ${DRY_RUN}`);
  console.log(`  Skip Phase 1:  ${SKIP_PHASE1}`);
  console.log(`  Skip Phase 2:  ${SKIP_PHASE2}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const db = new Database();
  const documentService = new DocumentService(db);
  const embeddingService = new EmbeddingService();

  // Graceful shutdown
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down gracefully...');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await db.connect();

    const beforeResult = await db.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN full_text IS NOT NULL AND length(full_text) >= 100 THEN 1 END) as with_text
       FROM documents WHERE type = 'court_decision' AND metadata->>'justice_kind' = '5'`
    );
    const before = beforeResult.rows[0];
    console.log(`\n  Criminal cases before: ${before.total} total, ${before.with_text} with text\n`);

    if (!SKIP_PHASE1) {
      await runPhase1(db, documentService);
    }

    if (!SKIP_PHASE2 && !shuttingDown) {
      await runPhase2(db, documentService, embeddingService);
    }

    // Final stats
    const afterResult = await db.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN full_text IS NOT NULL AND length(full_text) >= 100 THEN 1 END) as with_text
       FROM documents WHERE type = 'court_decision' AND metadata->>'justice_kind' = '5'`
    );
    const after = afterResult.rows[0];

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Phase 1 (backfill): ${phase1Stats.success} texts, ${phase1Stats.skipped} skipped, ${phase1Stats.errors} errors`);
    console.log(`  Phase 2 (new):      ${phase2Stats.newDocs} found, ${phase2Stats.saved} saved, ${phase2Stats.errors} errors`);
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`  Criminal cases:  ${before.total} → ${after.total}`);
    console.log(`  With full text:  ${before.with_text} → ${after.with_text}`);
    console.log('═══════════════════════════════════════════════════════════════');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  console.error('Fatal:', err);
  process.exit(1);
});
