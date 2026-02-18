/**
 * Load Commercial (Господарське) Court Decisions from ZakonOnline
 *
 * Searches for commercial court decisions (justice_kind = 3) across 6 categories:
 *   1. Стягнення заборгованості за договором
 *   2. Банкрутство (неплатоспроможність)
 *   3. Корпоративні спори
 *   4. Визнання договорів недійсними
 *   5. Захист інтелектуальної власності
 *   6. Орендні спори
 *
 * Uses parallel search threads (date-windowed).
 * Deduplicates results, persists with full text.
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
 *   npm run load:commercial-cases
 *   CONCURRENCY=10 MAX_DOCS=10000 node dist/scripts/load-commercial-cases.js
 */

import axios from 'axios';
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
    name: 'Стягнення заборгованості за договором',
    keywords: [
      'стягнення заборгованості за договором поставки',
      'стягнення заборгованості за договором надання послуг',
      'стягнення заборгованості за договором підряду',
      'стягнення боргу за господарським договором',
      'стягнення пені інфляційних втрат відсотків річних',
    ],
  },
  {
    name: 'Банкрутство (неплатоспроможність)',
    keywords: [
      'визнання банкрутом',
      'відкриття провадження у справі про банкрутство',
      'розпорядження майном боржника банкрутство',
      'ліквідаційна процедура банкрутство',
      'план санації боржника',
    ],
  },
  {
    name: 'Корпоративні спори',
    keywords: [
      'корпоративний спір визнання рішень загальних зборів недійсними',
      'виключення учасника з товариства',
      'стягнення дивідендів корпоративний спір',
      'визнання недійсним рішення наглядової ради',
    ],
  },
  {
    name: 'Визнання договорів недійсними',
    keywords: [
      'визнання господарського договору недійсним',
      'недійсність правочину господарський суд',
      'визнання недійсним договору оренди господарський',
      'фіктивний правочин господарський суд',
    ],
  },
  {
    name: 'Захист інтелектуальної власності',
    keywords: [
      'порушення прав інтелектуальної власності',
      'захист торговельної марки',
      'порушення авторського права господарський',
      'неправомірне використання знака для товарів',
    ],
  },
  {
    name: 'Орендні спори',
    keywords: [
      'стягнення орендної плати господарський',
      'розірвання договору оренди нерухомого майна господарський',
      'визнання договору оренди недійсним господарський',
      'повернення орендованого майна господарський',
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
          { field: 'justice_kind', operator: '=', value: 3 },
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

async function saveBatchViaDocService(
  docServiceUrl: string,
  docs: any[],
  concurrency: number = 5,
): Promise<{ saved: number; errors: number }> {
  let saved = 0;
  let errors = 0;

  for (let i = 0; i < docs.length; i += concurrency) {
    const batch = docs.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (doc) => {
        try {
          const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
          const response = await axios.post(
            `${docServiceUrl}/api/scrape-fulltext`,
            { doc_id: docId, metadata: doc },
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } },
          );
          if (response.data.error) {
            errors++;
            return;
          }
          saved++;
        } catch (error: any) {
          errors++;
          if (error.response?.status === 429) {
            const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            try {
              const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
              await axios.post(
                `${docServiceUrl}/api/scrape-fulltext`,
                { doc_id: docId, metadata: doc },
                { timeout: 30000, headers: { 'Content-Type': 'application/json' } },
              );
              saved++;
              errors--;
            } catch {
              // give up on retry
            }
          }
        }
      }),
    );
  }

  return { saved, errors };
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
  saveBatch: number,
  dryRun: boolean,
  docServiceUrl?: string,
): Promise<CategoryResult> {
  const result: CategoryResult = {
    category: category.name,
    fetched: 0,
    newDocs: 0,
    errors: 0,
  };
  let pendingDocs: any[] = [];

  const flushPending = async (force = false) => {
    if (dryRun || pendingDocs.length === 0) return;
    if (!force && pendingDocs.length < saveBatch) return;

    const toSave = pendingDocs.splice(0, saveBatch);
    console.log(`      Saving batch of ${toSave.length} documents...`);
    try {
      if (docServiceUrl) {
        const { saved, errors } = await saveBatchViaDocService(docServiceUrl, toSave);
        console.log(`      Doc-service: ${saved} saved, ${errors} errors (total unique: ${seenIds.size})`);
        result.errors += errors;
      } else {
        await zoAdapter.saveDocumentsToDatabase(toSave, toSave.length);
        console.log(`      Saved ${toSave.length} docs (total unique: ${seenIds.size})`);
      }
    } catch (error: any) {
      logger.error(`Batch save failed:`, error?.message);
      console.error(`      SAVE FAILED: ${error?.message}`);
    }
    toSave.length = 0;
    await new Promise(resolve => setTimeout(resolve, 2000));
  };

  for (const keyword of category.keywords) {
    if (seenIds.size >= maxDocs) break;

    console.log(`    Keyword: "${keyword}"`);

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
        pendingDocs.push(...r.docs);
      }

      const windowsProcessed = Math.min(i + concurrency, windows.length);
      console.log(
        `      Windows ${windowsProcessed}/${windows.length}: ` +
        `${result.newDocs} new docs (total unique: ${seenIds.size})`
      );

      await flushPending();
    }
  }

  while (pendingDocs.length > 0) {
    await flushPending(true);
  }

  return result;
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
  const docServiceUrl = process.env.DOCUMENT_SERVICE_URL || '';

  const windows = generateWindows(dateFrom, dateTo, batchDays);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Commercial (Господарське) Court Decisions Loader');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Max documents:  ${maxDocs}`);
  console.log(`  Date range:     ${dateFrom} to ${dateTo}`);
  console.log(`  Date windows:   ${windows.length} (${batchDays} days each)`);
  console.log(`  Concurrency:    ${concurrency} parallel windows`);
  console.log(`  Page size:      ${pageSize}`);
  console.log(`  Max pages/kw:   ${maxPages}`);
  console.log(`  Save batch:     ${saveBatch}`);
  console.log(`  Dry run:        ${dryRun}`);
  console.log(`  Doc service:    ${docServiceUrl || '(inline scraping)'}`);
  if (onlyCategory != null) {
    console.log(`  Only category:  ${onlyCategory} (${CATEGORIES[onlyCategory]?.name})`);
  }
  console.log(`  Categories:     ${CATEGORIES.length}`);
  for (let i = 0; i < CATEGORIES.length; i++) {
    const skip = skipCategories.has(i) || (onlyCategory != null && i !== onlyCategory);
    console.log(`    [${i}] ${CATEGORIES[i].name} (${CATEGORIES[i].keywords.length} keywords)${skip ? ' [SKIP]' : ''}`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

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
    const categoryResults: CategoryResult[] = [];

    console.log('Searching and saving incrementally...\n');

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
      const result = await processCategory(
        zoAdapter, CATEGORIES[i], seenIds, maxDocs, windows,
        concurrency, pageSize, maxPages, saveBatch, dryRun,
        docServiceUrl || undefined,
      );
      categoryResults.push(result);

      console.log(
        `  → ${result.category}: ${result.fetched} fetched, ${result.newDocs} new, ${result.errors} errors`
      );
    }

    console.log(`\nAll categories done. Total unique IDs: ${seenIds.size}\n`);

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
    const totalNewDocs = categoryResults.reduce((s, r) => s + r.newDocs, 0);
    console.log(`  Total unique docs:  ${totalNewDocs}`);
    console.log(`  Documents before:   ${beforeCount}`);
    console.log(`  Documents after:    ${afterCount}`);
    console.log(`  New documents:      ${afterCount - beforeCount}`);
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.error('Load commercial cases failed:', err);
  console.error('Load commercial cases failed:', err);
  process.exit(1);
});
