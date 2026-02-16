/**
 * Load Civil Property Court Decisions from ZakonOnline
 *
 * Searches for civil court decisions across 6 property dispute categories:
 *   1. Витребування майна з чужого незаконного володіння (виндикація)
 *   2. Визнання права власності
 *   3. Поділ майна
 *   4. Скасування державної реєстрації права
 *   5. Недійсність договорів купівлі-продажу
 *   6. Спадкові спори
 *
 * Uses 10 parallel search threads per category (date-windowed).
 * Deduplicates results, persists with full text, sections, and embeddings.
 *
 * Environment variables:
 *   MAX_DOCS      - Maximum unique documents to collect (default: 10000)
 *   DRY_RUN       - If "true", only count without persisting (default: false)
 *   DATE_FROM     - Start date for search (YYYY-MM-DD, default: 3 years ago)
 *   DATE_TO       - End date for search (YYYY-MM-DD, default: today)
 *   PAGE_SIZE     - Results per page (default: 1000)
 *   MAX_PAGES     - Max pages per keyword per window (default: 25)
 *   SAVE_BATCH    - Documents per save batch (default: 200)
 *   CONCURRENCY   - Parallel date windows (default: 10)
 *   BATCH_DAYS    - Days per search window (default: 30)
 *   SKIP_CATEGORIES - Comma-separated category indices to skip (0-based)
 *   ONLY_CATEGORY   - Run only this category index (0-based)
 *
 * Usage:
 *   npm run load:civil-cases
 *   DRY_RUN=true npm run load:civil-cases
 *   MAX_DOCS=5000 ONLY_CATEGORY=0 npm run load:civil-cases
 */

import { Database } from '../database/database.js';
import { DocumentService } from '../services/document-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { logger } from '../utils/logger.js';

// --- Category definitions ---

interface SearchCategory {
  name: string;
  keywords: string[];
}

const CATEGORIES: SearchCategory[] = [
  {
    name: 'Витребування майна (виндикація)',
    keywords: [
      'витребування майна з чужого незаконного володіння',
      'витребувати майно',
      'віндикаційний позов',
      'добросовісний набувач витребування',
    ],
  },
  {
    name: 'Визнання права власності',
    keywords: [
      'визнання права власності на нерухоме майно',
      'визнання права власності на житловий будинок',
      'визнання права власності на квартиру',
      'визнання права власності на земельну ділянку',
    ],
  },
  {
    name: 'Поділ майна',
    keywords: [
      'поділ спільного майна подружжя',
      'поділ майна подружжя',
      'поділ спільного сумісного майна',
      'визнання майна спільною сумісною власністю',
    ],
  },
  {
    name: 'Скасування державної реєстрації права',
    keywords: [
      'скасування державної реєстрації права власності',
      'скасування рішення державного реєстратора',
      'визнання протиправним рішення реєстратора',
      'скасування запису про право власності',
    ],
  },
  {
    name: 'Недійсність договорів купівлі-продажу',
    keywords: [
      'визнання недійсним договору купівлі-продажу',
      'недійсність договору купівлі-продажу нерухомого майна',
      'недійсність правочину купівлі-продажу',
      'визнання недійсним договору відчуження',
    ],
  },
  {
    name: 'Спадкові спори',
    keywords: [
      'визнання права на спадщину',
      'оспорювання заповіту',
      'визнання заповіту недійсним',
      'прийняття спадщини поновлення строку',
      'поділ спадкового майна',
    ],
  },
];

// --- Types ---

interface WindowRange {
  start: string;
  end: string;
}

interface CategoryResult {
  category: string;
  fetched: number;
  newDocs: number;
  errors: number;
}

// --- Helpers ---

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function generateWindows(startDate: string, endDate: string, batchDays: number): WindowRange[] {
  const windows: WindowRange[] = [];
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

async function searchKeywordInWindow(
  zoAdapter: ZOAdapter,
  keyword: string,
  window: WindowRange,
  seenIds: Set<string>,
  maxDocs: number,
  pageSize: number,
  maxPages: number,
): Promise<{ docs: any[]; fetched: number; newDocs: number; errors: number }> {
  let fetched = 0;
  let newDocs = 0;
  let errors = 0;
  const docs: any[] = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (seenIds.size >= maxDocs) break;

    try {
      const response = await zoAdapter.searchCourtDecisions({
        meta: { search: keyword },
        where: [
          { field: 'adjudication_date', operator: '>=', value: window.start },
          { field: 'adjudication_date', operator: '<=', value: window.end },
          { field: 'justice_kind', operator: '=', value: 1 },
        ],
        limit: pageSize,
        page: pageNum,
        orderBy: { field: 'adjudication_date', direction: 'desc' },
      });

      const items = Array.isArray(response) ? response : response?.data || [];
      fetched += items.length;

      for (const doc of items) {
        const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
        if (!docId || docId === 'undefined') continue;
        if (!seenIds.has(docId)) {
          seenIds.add(docId);
          docs.push(doc);
          newDocs++;
          if (seenIds.size >= maxDocs) break;
        }
      }

      if (items.length < pageSize) break;

      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error: any) {
      errors++;
      logger.error(`Error [${keyword}] ${window.start}..${window.end} p${pageNum}:`, error?.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return { docs, fetched, newDocs, errors };
}

async function processCategory(
  zoAdapter: ZOAdapter,
  category: SearchCategory,
  seenIds: Set<string>,
  maxDocs: number,
  windows: WindowRange[],
  concurrency: number,
  pageSize: number,
  maxPages: number,
): Promise<{ result: CategoryResult; docs: any[] }> {
  const result: CategoryResult = {
    category: category.name,
    fetched: 0,
    newDocs: 0,
    errors: 0,
  };
  const allDocs: any[] = [];

  for (const keyword of category.keywords) {
    if (seenIds.size >= maxDocs) break;

    console.log(`    Keyword: "${keyword}"`);

    // Process windows in parallel batches
    for (let i = 0; i < windows.length; i += concurrency) {
      if (seenIds.size >= maxDocs) break;

      const batch = windows.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(w => searchKeywordInWindow(
          zoAdapter, keyword, w, seenIds, maxDocs, pageSize, maxPages
        ))
      );

      for (const r of results) {
        result.fetched += r.fetched;
        result.newDocs += r.newDocs;
        result.errors += r.errors;
        allDocs.push(...r.docs);
      }

      const windowsProcessed = Math.min(i + concurrency, windows.length);
      console.log(
        `      Windows ${windowsProcessed}/${windows.length}: ` +
        `${result.newDocs} new docs (total unique: ${seenIds.size})`
      );
    }
  }

  return { result, docs: allDocs };
}

// --- Main ---

async function main() {
  const now = new Date();
  const threeYearsAgo = new Date(now);
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const maxDocs = parseInt(process.env.MAX_DOCS || '10000', 10);
  const dryRun = process.env.DRY_RUN === 'true';
  const dateFrom = process.env.DATE_FROM || formatDate(threeYearsAgo);
  const dateTo = process.env.DATE_TO || formatDate(now);
  const pageSize = parseInt(process.env.PAGE_SIZE || '1000', 10);
  const maxPages = parseInt(process.env.MAX_PAGES || '25', 10);
  const saveBatch = parseInt(process.env.SAVE_BATCH || '200', 10);
  const concurrency = parseInt(process.env.CONCURRENCY || '10', 10);
  const batchDays = parseInt(process.env.BATCH_DAYS || '30', 10);
  const skipCategories = new Set(
    (process.env.SKIP_CATEGORIES || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  );
  const onlyCategory = process.env.ONLY_CATEGORY != null
    ? parseInt(process.env.ONLY_CATEGORY, 10)
    : null;

  const windows = generateWindows(dateFrom, dateTo, batchDays);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Civil Property Court Decisions Loader');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Max documents:  ${maxDocs}`);
  console.log(`  Date range:     ${dateFrom} to ${dateTo}`);
  console.log(`  Date windows:   ${windows.length} (${batchDays} days each)`);
  console.log(`  Concurrency:    ${concurrency} parallel windows`);
  console.log(`  Page size:      ${pageSize}`);
  console.log(`  Max pages/kw:   ${maxPages}`);
  console.log(`  Save batch:     ${saveBatch}`);
  console.log(`  Dry run:        ${dryRun}`);
  if (onlyCategory != null) {
    console.log(`  Only category:  ${onlyCategory} (${CATEGORIES[onlyCategory]?.name})`);
  }
  console.log(`  Categories:     ${CATEGORIES.length}`);
  for (let i = 0; i < CATEGORIES.length; i++) {
    const skip = skipCategories.has(i) || (onlyCategory != null && i !== onlyCategory);
    console.log(`    [${i}] ${CATEGORIES[i].name} (${CATEGORIES[i].keywords.length} keywords)${skip ? ' [SKIP]' : ''}`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Initialize services
  const db = new Database();
  const documentService = new DocumentService(db);
  const embeddingService = new EmbeddingService();
  const zoAdapter = new ZOAdapter(documentService, undefined, embeddingService);

  try {
    await db.connect();

    const beforeResult = await db.query('SELECT COUNT(*) as count FROM documents');
    const beforeCount = parseInt(beforeResult.rows[0].count, 10);
    console.log(`Documents before: ${beforeCount}\n`);

    const seenIds = new Set<string>();
    const allDocs: any[] = [];
    const categoryResults: CategoryResult[] = [];

    // Phase 1: Search all categories
    console.log('Phase 1: Searching categories...\n');

    for (let i = 0; i < CATEGORIES.length; i++) {
      if (seenIds.size >= maxDocs) {
        console.log(`\nGlobal cap reached (${seenIds.size}/${maxDocs}), skipping remaining categories.`);
        break;
      }

      if (skipCategories.has(i) || (onlyCategory != null && i !== onlyCategory)) {
        console.log(`\n  [${i}] Skipping: ${CATEGORIES[i].name}`);
        continue;
      }

      console.log(`\n  [${i}] ${CATEGORIES[i].name}`);
      const { result, docs } = await processCategory(
        zoAdapter, CATEGORIES[i], seenIds, maxDocs, windows,
        concurrency, pageSize, maxPages
      );
      categoryResults.push(result);
      allDocs.push(...docs);

      console.log(
        `  → ${result.category}: ${result.fetched} fetched, ${result.newDocs} new, ${result.errors} errors`
      );
    }

    console.log(`\nPhase 1 complete: ${allDocs.length} unique documents collected.\n`);

    // Phase 2: Persist
    if (dryRun) {
      console.log('[DRY RUN] Skipping persistence.\n');
    } else if (allDocs.length > 0) {
      console.log(`Phase 2: Persisting ${allDocs.length} documents (batch size: ${saveBatch})...\n`);

      let totalSaved = 0;
      const totalBatches = Math.ceil(allDocs.length / saveBatch);

      for (let i = 0; i < allDocs.length; i += saveBatch) {
        const batch = allDocs.slice(i, i + saveBatch);
        const batchNum = Math.floor(i / saveBatch) + 1;

        console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} documents...`);

        try {
          await zoAdapter.saveDocumentsToDatabase(batch, batch.length);
          totalSaved += batch.length;
          console.log(`  Batch ${batchNum}/${totalBatches}: saved. Total: ${totalSaved}/${allDocs.length}`);
        } catch (error: any) {
          logger.error(`Batch ${batchNum} save failed:`, error?.message);
          console.error(`  Batch ${batchNum} FAILED: ${error?.message}`);
        }

        if (i + saveBatch < allDocs.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`\nPhase 2 complete: ${totalSaved} documents saved.\n`);
    }

    // Wait for persistence queue
    console.log('Waiting for persistence queue to flush...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const afterResult = await db.query('SELECT COUNT(*) as count FROM documents');
    const afterCount = parseInt(afterResult.rows[0].count, 10);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    for (const cr of categoryResults) {
      console.log(`  ${cr.category}: ${cr.fetched} fetched, ${cr.newDocs} new, ${cr.errors} errors`);
    }
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`  Total unique docs:  ${allDocs.length}`);
    console.log(`  Documents before:   ${beforeCount}`);
    console.log(`  Documents after:    ${afterCount}`);
    console.log(`  New documents:      ${afterCount - beforeCount}`);
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.error('Load civil property cases failed:', err);
  console.error('Load civil property cases failed:', err);
  process.exit(1);
});
