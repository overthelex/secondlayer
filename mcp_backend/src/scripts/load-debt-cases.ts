/**
 * Load Debt Collection Court Decisions from ZakonOnline
 *
 * Searches for court decisions related to debt collection using multiple keywords,
 * deduplicates results, and persists them with full text, sections, and embeddings.
 *
 * Environment variables:
 *   MAX_DOCS    - Maximum unique documents to collect (default: 10000)
 *   DRY_RUN     - If "true", only count without persisting (default: false)
 *   DATE_FROM   - Start date for search (YYYY-MM-DD, default: 3 years ago)
 *   PAGE_SIZE   - Results per page (default: 1000)
 *   MAX_PAGES   - Max pages per keyword (default: 50)
 *   SAVE_BATCH  - Documents per saveDocumentsToDatabase call (default: 200)
 *
 * Usage:
 *   npm run load:debt-cases
 *   DRY_RUN=true npm run load:debt-cases
 *   MAX_DOCS=100 npm run load:debt-cases
 */

import { Database } from '../database/database.js';
import { DocumentService } from '../services/document-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { logger } from '../utils/logger.js';

const KEYWORDS = [
  'стягнення боргу',
  'договір позики',
  'кредитний договір',
  'розписка',
];

interface KeywordResult {
  keyword: string;
  fetched: number;
  newDocs: number;
  pages: number;
  errors: number;
}

async function searchKeyword(
  zoAdapter: ZOAdapter,
  keyword: string,
  seenIds: Set<string>,
  maxDocs: number,
  pageSize: number,
  maxPages: number,
  dateFrom: string,
): Promise<{ result: KeywordResult; docs: any[] }> {
  const result: KeywordResult = {
    keyword,
    fetched: 0,
    newDocs: 0,
    pages: 0,
    errors: 0,
  };
  const collectedDocs: any[] = [];

  for (let page = 0; page < maxPages; page++) {
    // Check if we've hit the global cap
    if (seenIds.size >= maxDocs) {
      console.log(`  [${keyword}] Global cap reached (${seenIds.size}/${maxDocs}), stopping.`);
      break;
    }

    const offset = page * pageSize;

    try {
      const response = await zoAdapter.searchCourtDecisions({
        meta: { search: keyword },
        where: [
          { field: 'adjudication_date', operator: '>=', value: dateFrom },
        ],
        limit: pageSize,
        offset,
        orderBy: { field: 'adjudication_date', direction: 'desc' },
      });

      result.pages++;

      const docs = Array.isArray(response) ? response : response?.data || [];
      const total = Array.isArray(response) ? docs.length : (response?.total ?? docs.length);

      result.fetched += docs.length;

      // Deduplicate
      let pageNew = 0;
      for (const doc of docs) {
        const docId = String(doc.doc_id || doc.id || doc.zakononline_id);
        if (!docId || docId === 'undefined') continue;
        if (!seenIds.has(docId)) {
          seenIds.add(docId);
          collectedDocs.push(doc);
          pageNew++;
          if (seenIds.size >= maxDocs) break;
        }
      }
      result.newDocs += pageNew;

      console.log(
        `  [${keyword}] page ${page + 1}: ${docs.length} results, ${pageNew} new ` +
        `(total unique: ${seenIds.size}/${maxDocs})`
      );

      // Stop if we got fewer results than page size (no more pages)
      if (docs.length < pageSize) break;

      // Stop if we've fetched everything available
      if (result.fetched >= total) break;

      // Rate limit delay
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error: any) {
      result.errors++;
      logger.error(`Error searching "${keyword}" page ${page + 1}:`, error?.message);
      console.error(`  [${keyword}] page ${page + 1} ERROR: ${error?.message}`);
      // Continue to next page on error
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return { result, docs: collectedDocs };
}

async function main() {
  const now = new Date();
  const threeYearsAgo = new Date(now);
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const maxDocs = parseInt(process.env.MAX_DOCS || '10000', 10);
  const dryRun = process.env.DRY_RUN === 'true';
  const dateFrom = process.env.DATE_FROM || threeYearsAgo.toISOString().split('T')[0];
  const pageSize = parseInt(process.env.PAGE_SIZE || '1000', 10);
  const maxPages = parseInt(process.env.MAX_PAGES || '50', 10);
  const saveBatch = parseInt(process.env.SAVE_BATCH || '200', 10);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Debt Collection Court Decisions Loader');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Max documents:  ${maxDocs}`);
  console.log(`  Date from:      ${dateFrom}`);
  console.log(`  Page size:      ${pageSize}`);
  console.log(`  Max pages/kw:   ${maxPages}`);
  console.log(`  Save batch:     ${saveBatch}`);
  console.log(`  Dry run:        ${dryRun}`);
  console.log(`  Keywords:       ${KEYWORDS.join(', ')}`);
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

    const seenIds = new Set<string>();
    const allDocs: any[] = [];
    const keywordResults: KeywordResult[] = [];

    // Phase 1: Search all keywords sequentially, collect unique docs
    console.log('Phase 1: Searching keywords...\n');

    for (const keyword of KEYWORDS) {
      if (seenIds.size >= maxDocs) {
        console.log(`\nGlobal cap reached, skipping remaining keywords.`);
        break;
      }

      console.log(`\nSearching: "${keyword}"`);
      const { result, docs } = await searchKeyword(
        zoAdapter, keyword, seenIds, maxDocs, pageSize, maxPages, dateFrom
      );
      keywordResults.push(result);
      allDocs.push(...docs);

      console.log(
        `  → "${keyword}": ${result.fetched} fetched, ${result.newDocs} new, ` +
        `${result.pages} pages, ${result.errors} errors`
      );
    }

    console.log(`\nPhase 1 complete: ${allDocs.length} unique documents collected.\n`);

    // Phase 2: Persist with full text + sections + embeddings
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

        // Small delay between batches
        if (i + saveBatch < allDocs.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`\nPhase 2 complete: ${totalSaved} documents saved.\n`);
    }

    // Wait for any background persistence to finish
    console.log('Waiting for persistence queue to flush...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get final count
    const afterResult = await db.query('SELECT COUNT(*) as count FROM documents');
    const afterCount = parseInt(afterResult.rows[0].count, 10);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════════');
    for (const kr of keywordResults) {
      console.log(`  "${kr.keyword}": ${kr.fetched} fetched, ${kr.newDocs} new, ${kr.errors} errors`);
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
  logger.error('Load debt cases failed:', err);
  console.error('Load debt cases failed:', err);
  process.exit(1);
});
