/**
 * Backfill full texts from reyestr.court.gov.ua
 *
 * Finds documents with numeric zakononline_id but no full_text,
 * scrapes their full text from the court registry, parses it,
 * and saves text + sections (no embeddings).
 *
 * Env vars:
 *   CONCURRENCY  - parallel download workers (default 7)
 *   DELAY_MS     - min ms between requests per worker (default 300)
 *   MAX_DOCS     - cap for testing, 0 = unlimited (default 0)
 *   SKIP_SECTIONS- skip section extraction (default false)
 *   CACHE_DIR    - disk cache for raw HTML (default /tmp/reyestr-backfill)
 *   DRY_RUN      - download + parse but don't write to DB (default false)
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'cheerio';
import { Database } from '../database/database.js';
import { DocumentService, Document } from '../services/document-service.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { CourtDecisionHTMLParser } from '../utils/html-parser.js';
import { logger } from '../utils/logger.js';

// --- Config ---
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '7', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '300', 10);
const MAX_DOCS = parseInt(process.env.MAX_DOCS || '0', 10);
const SKIP_SECTIONS = process.env.SKIP_SECTIONS === 'true';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/reyestr-backfill';
const DRY_RUN = process.env.DRY_RUN === 'true';

const BASE_URL = 'https://reyestr.court.gov.ua/Review';

// --- Types ---
interface DocRow {
  id: string;
  zakononline_id: string;
  case_number: string | null;
}

interface ProgressState {
  processed: number;
  success: number;
  skipped: number;
  errors: number;
  lastZakononlineId: string | null;
  completedIds: string[];
}

// --- Globals ---
let shuttingDown = false;
const stats = { processed: 0, success: 0, skipped: 0, errors: 0 };

// --- HTML Extraction (reused from scrape-court-registry.ts) ---
function extractMetadataFromHTML(html: string, docId: string): {
  title: string;
  caseNumber: string | null;
  court: string | null;
  date: string | null;
  disputeCategory: string | null;
  fullText: string;
} {
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
  if (caseMatch) {
    caseNumber = caseMatch[1];
  }

  let court: string | null = null;
  const courtMatch = fullText.match(
    /([А-ЯІЇЄҐа-яіїєґ''\s]+(?:районний|апеляційний|касаційний|господарський|окружний|міський)\s+суд[а-яіїєґ''\s]*)/i
  );
  if (courtMatch) {
    court = courtMatch[1].trim().replace(/\s+/g, ' ').substring(0, 200);
  }

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
  if (categoryMatch) {
    disputeCategory = categoryMatch[1].trim().substring(0, 255);
  }

  const title = caseNumber
    ? `Рішення у справі ${caseNumber}`
    : `Рішення ${docId}`;

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

      // CAPTCHA detection
      if (html.includes('captcha') || html.includes('CAPTCHA') || html.includes('recaptcha')) {
        logger.warn(`CAPTCHA detected at ${url}, pausing all workers 30s`);
        await sleep(30000);
        continue;
      }

      return html;
    } catch (error: any) {
      const status = error.response?.status;
      const code = error.code;

      if (status === 429) {
        logger.warn(`429 rate limited, pausing 30s (attempt ${attempt}/${retries})`);
        await sleep(30000);
        continue;
      }

      if (status === 404) {
        return null; // Document doesn't exist on reyestr
      }

      const isTransient = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)
        || status === 503 || status === 502;

      if (isTransient && attempt < retries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 15000);
        logger.warn(`Transient error (${code || status}), retry in ${backoff}ms (attempt ${attempt}/${retries})`);
        await sleep(backoff);
        continue;
      }

      logger.error(`Failed to fetch ${url}: ${error.message}`);
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Disk cache ---
function getCachePath(zakononlineId: string): string {
  return path.join(CACHE_DIR, `${zakononlineId}.html`);
}

function readFromCache(zakononlineId: string): string | null {
  const cachePath = getCachePath(zakononlineId);
  try {
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}

function writeToCache(zakononlineId: string, html: string): void {
  try {
    fs.writeFileSync(getCachePath(zakononlineId), html, 'utf-8');
  } catch { /* ignore */ }
}

// --- Progress tracking ---
function loadProgress(): Set<string> {
  const progressPath = path.join(CACHE_DIR, 'progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf-8')) as ProgressState;
      logger.info(`Resuming from previous run: ${data.processed} processed, ${data.success} success`);
      return new Set(data.completedIds);
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveProgress(completedIds: Set<string>): void {
  const progressPath = path.join(CACHE_DIR, 'progress.json');
  const state: ProgressState = {
    ...stats,
    lastZakononlineId: null,
    completedIds: Array.from(completedIds),
  };
  try {
    fs.writeFileSync(progressPath, JSON.stringify(state), 'utf-8');
  } catch { /* ignore */ }
}

// --- Process a single document ---
async function processDocument(
  row: DocRow,
  documentService: DocumentService,
  sectionizer: SemanticSectionizer,
): Promise<boolean> {
  const { id, zakononline_id } = row;

  // Try disk cache first
  let html = readFromCache(zakononline_id);
  if (!html) {
    const url = `${BASE_URL}/${zakononline_id}`;
    html = await fetchWithRetry(url);
    if (!html) {
      stats.skipped++;
      return false;
    }
    writeToCache(zakononline_id, html);
  }

  // Parse
  const meta = extractMetadataFromHTML(html, zakononline_id);

  if (!meta.fullText || meta.fullText.length < 50) {
    logger.warn(`Document ${zakononline_id}: text too short (${meta.fullText?.length || 0} chars), skipping`);
    stats.skipped++;
    return false;
  }

  if (DRY_RUN) {
    logger.info(`[DRY_RUN] ${zakononline_id}: ${meta.fullText.length} chars, case=${meta.caseNumber}, court=${meta.court?.substring(0, 50)}`);
    stats.success++;
    return true;
  }

  // Save document (UPSERT — COALESCE preserves existing non-null values)
  const doc: Document = {
    id,
    zakononline_id,
    type: 'court_decision',
    title: meta.title,
    date: meta.date || undefined,
    case_number: meta.caseNumber || undefined,
    court: meta.court || undefined,
    dispute_category: meta.disputeCategory || undefined,
    full_text: meta.fullText,
    full_text_html: html,
  };

  const savedId = await documentService.saveDocument(doc);

  // Extract and save sections
  if (!SKIP_SECTIONS) {
    try {
      const sections = await sectionizer.extractSections(meta.fullText, false);
      if (sections.length > 0) {
        await documentService.saveSections(savedId, sections);
      }
    } catch (err: any) {
      logger.warn(`Sections failed for ${zakononline_id}: ${err.message}`);
    }
  }

  stats.success++;
  return true;
}

// --- Worker: processes docs from queue ---
async function worker(
  workerId: number,
  queue: DocRow[],
  completedIds: Set<string>,
  documentService: DocumentService,
  sectionizer: SemanticSectionizer,
): Promise<void> {
  while (!shuttingDown) {
    const row = queue.shift();
    if (!row) break;

    if (completedIds.has(row.zakononline_id)) {
      stats.skipped++;
      stats.processed++;
      continue;
    }

    try {
      await processDocument(row, documentService, sectionizer);
    } catch (err: any) {
      logger.error(`Worker ${workerId} error on ${row.zakononline_id}: ${err.message}`);
      stats.errors++;
    }

    completedIds.add(row.zakononline_id);
    stats.processed++;

    // Progress logging every 100 docs
    if (stats.processed % 100 === 0) {
      const pct = ((stats.processed / (queue.length + stats.processed)) * 100).toFixed(1);
      logger.info(`[${stats.processed}/${queue.length + stats.processed}] ${pct}% — ${stats.success} success, ${stats.skipped} skipped, ${stats.errors} errors`);
      saveProgress(completedIds);
    }

    // Rate limiting per worker
    await sleep(DELAY_MS);
  }
}

// --- Main ---
async function main(): Promise<void> {
  logger.info('=== Backfill Full Texts from reyestr.court.gov.ua ===');
  logger.info(`Config: concurrency=${CONCURRENCY}, delay=${DELAY_MS}ms, maxDocs=${MAX_DOCS || 'unlimited'}, dryRun=${DRY_RUN}, skipSections=${SKIP_SECTIONS}`);

  // Ensure cache dir exists
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const db = new Database();
  const documentService = new DocumentService(db);
  const sectionizer = new SemanticSectionizer();

  // Load resume state
  const completedIds = loadProgress();

  // Query documents needing backfill
  let query = `
    SELECT id, zakononline_id, case_number FROM documents
    WHERE (full_text IS NULL OR length(full_text) < 100)
      AND zakononline_id ~ '^\\d+$'
    ORDER BY date DESC NULLS LAST
  `;
  if (MAX_DOCS > 0) {
    query += ` LIMIT ${MAX_DOCS}`;
  }

  const result = await db.query(query);
  const docs: DocRow[] = result.rows;

  logger.info(`Found ${docs.length} documents needing full text backfill (${completedIds.size} already completed)`);

  if (docs.length === 0) {
    logger.info('Nothing to do.');
    await db.close();
    return;
  }

  // Graceful shutdown
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down gracefully...');
    saveProgress(completedIds);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Build work queue (mutable array — workers shift from it)
  const queue = [...docs];

  // Launch workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(i, queue, completedIds, documentService, sectionizer));
  }

  await Promise.all(workers);

  // Final summary
  saveProgress(completedIds);
  logger.info('=== Backfill Complete ===');
  logger.info(`Processed: ${stats.processed}, Success: ${stats.success}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);

  await db.close();
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
