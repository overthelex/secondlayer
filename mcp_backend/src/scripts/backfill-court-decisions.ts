/**
 * Backfill Court Decisions from ZakonOnline
 *
 * Fetches court decisions for a date range using the ZO API and persists them
 * to the documents table via ZOAdapter's built-in persistence queue.
 *
 * Environment variables:
 *   START_DATE     - Start of date range (YYYY-MM-DD, default: 2 years ago)
 *   END_DATE       - End of date range (YYYY-MM-DD, default: today)
 *   BATCH_DAYS     - Days per search window (default: 7)
 *   CONCURRENCY    - Parallel windows to process (default: 2)
 *   PAGE_LIMIT     - Max results per page (default: 40)
 *   MAX_PAGES      - Max pages per window (default: 25 = 1000 results)
 *   DRY_RUN        - If "true", only count without persisting
 *
 * Usage:
 *   npm run backfill:decisions
 *   START_DATE=2025-01-01 END_DATE=2025-06-01 npm run backfill:decisions
 */

import { Database } from '../database/database.js';
import { DocumentService } from '../services/document-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { logger } from '../utils/logger.js';

interface WindowResult {
  windowStart: string;
  windowEnd: string;
  fetched: number;
  pages: number;
  errors: number;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function generateWindows(startDate: string, endDate: string, batchDays: number): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start);
  while (current <= end) {
    const windowEnd = new Date(current);
    windowEnd.setDate(windowEnd.getDate() + batchDays - 1);
    if (windowEnd > end) {
      windowEnd.setTime(end.getTime());
    }
    windows.push({
      start: formatDate(current),
      end: formatDate(windowEnd),
    });
    current.setDate(current.getDate() + batchDays);
  }

  return windows;
}

async function processWindow(
  zoAdapter: ZOAdapter,
  windowStart: string,
  windowEnd: string,
  pageLimit: number,
  maxPages: number,
  dryRun: boolean
): Promise<WindowResult> {
  const result: WindowResult = {
    windowStart,
    windowEnd,
    fetched: 0,
    pages: 0,
    errors: 0,
  };

  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageLimit;

      const response = await zoAdapter.searchCourtDecisions({
        where: [
          { field: 'adjudication_date', operator: '>=', value: windowStart },
          { field: 'adjudication_date', operator: '<=', value: windowEnd },
        ],
        limit: pageLimit,
        offset,
        orderBy: { field: 'adjudication_date', direction: 'desc' },
      });

      result.pages++;

      // Response can be an array or { data: [], total: number }
      const docs = Array.isArray(response) ? response : response?.data || [];
      const total = Array.isArray(response) ? docs.length : (response?.total ?? docs.length);

      result.fetched += docs.length;

      if (dryRun) {
        logger.info(`[DRY RUN] Window ${windowStart}..${windowEnd} page ${page + 1}: ${docs.length} docs (total: ${total})`);
      }

      // ZOAdapter's enqueueDocumentsForPersistence handles saving automatically
      // when not in dry-run mode (it's triggered inside searchCourtDecisions)

      // Stop if we got fewer results than the limit (no more pages)
      if (docs.length < pageLimit) break;

      // Stop if we've fetched everything
      if (result.fetched >= total) break;

      // Small delay between pages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } catch (error: any) {
    result.errors++;
    logger.error(`Error processing window ${windowStart}..${windowEnd}:`, error?.message);
  }

  return result;
}

async function main() {
  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const startDate = process.env.START_DATE || formatDate(twoYearsAgo);
  const endDate = process.env.END_DATE || formatDate(now);
  const batchDays = parseInt(process.env.BATCH_DAYS || '7', 10);
  const concurrency = parseInt(process.env.CONCURRENCY || '2', 10);
  const pageLimit = parseInt(process.env.PAGE_LIMIT || '40', 10);
  const maxPages = parseInt(process.env.MAX_PAGES || '25', 10);
  const dryRun = process.env.DRY_RUN === 'true';

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Court Decisions Backfill');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Date range:    ${startDate} to ${endDate}`);
  console.log(`  Batch window:  ${batchDays} days`);
  console.log(`  Concurrency:   ${concurrency}`);
  console.log(`  Page limit:    ${pageLimit} results/page, max ${maxPages} pages/window`);
  console.log(`  Dry run:       ${dryRun}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Initialize services
  const db = new Database();
  const documentService = new DocumentService(db);
  const embeddingService = new EmbeddingService();
  const zoAdapter = new ZOAdapter(documentService, undefined, embeddingService);

  try {
    await db.connect();

    // Get initial count
    const beforeResult = await db.query('SELECT COUNT(*) as count FROM documents');
    const beforeCount = parseInt(beforeResult.rows[0].count, 10);
    console.log(`Documents before: ${beforeCount}\n`);

    // Generate windows
    const windows = generateWindows(startDate, endDate, batchDays);
    console.log(`Total windows to process: ${windows.length}\n`);

    let totalFetched = 0;
    let totalErrors = 0;
    let windowsDone = 0;

    // Process windows with concurrency
    for (let i = 0; i < windows.length; i += concurrency) {
      const batch = windows.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(w => processWindow(zoAdapter, w.start, w.end, pageLimit, maxPages, dryRun))
      );

      for (const r of results) {
        totalFetched += r.fetched;
        totalErrors += r.errors;
        windowsDone++;
        console.log(
          `[${windowsDone}/${windows.length}] ${r.windowStart}..${r.windowEnd}: ` +
          `${r.fetched} docs in ${r.pages} pages` +
          (r.errors > 0 ? ` (${r.errors} errors)` : '')
        );
      }
    }

    // Wait for persistence queue to flush (give it time)
    console.log('\nWaiting for persistence queue to flush...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get final count
    const afterResult = await db.query('SELECT COUNT(*) as count FROM documents');
    const afterCount = parseInt(afterResult.rows[0].count, 10);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Windows processed: ${windowsDone}`);
    console.log(`  API results:       ${totalFetched}`);
    console.log(`  Errors:            ${totalErrors}`);
    console.log(`  Documents before:  ${beforeCount}`);
    console.log(`  Documents after:   ${afterCount}`);
    console.log(`  New documents:     ${afterCount - beforeCount}`);
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.error('Backfill failed:', err);
  console.error('Backfill failed:', err);
  process.exit(1);
});
