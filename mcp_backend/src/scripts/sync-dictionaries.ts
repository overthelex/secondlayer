/**
 * ZakonOnline Dictionary Sync Script
 * Fetches all 10 dictionaries from ZakonOnline API and stores in PostgreSQL + Redis cache
 *
 * Usage:
 *   npm run sync:dictionaries       # Build and run
 *   npm run sync:dictionaries:dev   # Run with ts-node-dev
 *
 * Dictionaries by domain:
 *   court_decisions: courts, instances, judgmentForms, justiceKinds, regions, judges
 *   legal_acts: documentTypes, authors
 *   court_practice: categories, types
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { ZAKONONLINE_DOMAINS, type ZakonOnlineDomainName } from '../types/zakononline-domains.js';
import { createClient } from 'redis';

interface DictionaryEntry {
  domain: ZakonOnlineDomainName;
  name: string;
  method: string;
  params?: Record<string, any>;
}

// All dictionaries to sync, mapped to their domains
const DICTIONARIES: DictionaryEntry[] = [
  // Court Decisions domain
  { domain: 'court_decisions', name: 'courts', method: 'getCourtsDictionary' },
  { domain: 'court_decisions', name: 'instances', method: 'getInstancesDictionary' },
  { domain: 'court_decisions', name: 'judgmentForms', method: 'getJudgmentFormsDictionary' },
  { domain: 'court_decisions', name: 'justiceKinds', method: 'getJusticeKindsDictionary' },
  { domain: 'court_decisions', name: 'regions', method: 'getRegionsDictionary' },
  { domain: 'court_decisions', name: 'judges', method: 'getJudgesDictionary' },
  // Legal Acts domain
  { domain: 'legal_acts', name: 'documentTypes', method: 'getDocumentTypesDictionary' },
  { domain: 'legal_acts', name: 'authors', method: 'getAuthorsDictionary' },
  // Court Practice domain
  { domain: 'court_practice', name: 'categories', method: 'getCategoriesDictionary' },
  { domain: 'court_practice', name: 'types', method: 'getTypesDictionary' },
];

async function syncDictionaries() {
  const db = new Database();
  let redis: ReturnType<typeof createClient> | null = null;

  try {
    await db.connect();
    logger.info('Starting ZakonOnline dictionary sync...');

    // Connect Redis for caching
    const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
    redis = createClient({ url: redisUrl });
    await redis.connect();
    logger.info('Redis connected');

    // Verify API tokens are configured (ZOAdapter reads them from env)
    if (!process.env.ZAKONONLINE_API_TOKEN) {
      throw new Error('No ZAKONONLINE_API_TOKEN configured');
    }

    // Create adapters for each domain we need
    const adapters = new Map<ZakonOnlineDomainName, ZOAdapter>();

    for (const entry of DICTIONARIES) {
      if (!adapters.has(entry.domain)) {
        const adapter = new ZOAdapter(entry.domain);
        adapters.set(entry.domain, adapter);
      }
    }

    let successCount = 0;
    let errorCount = 0;

    for (const entry of DICTIONARIES) {
      try {
        logger.info(`Fetching ${entry.domain}/${entry.name}...`);
        const adapter = adapters.get(entry.domain)!;

        // Call the dictionary method
        const data = await (adapter as any)[entry.method](entry.params);

        // Extract items array from response
        const items = Array.isArray(data) ? data : (data?.data || data?.items || []);
        const itemsCount = items.length;

        // Upsert into database
        await db.query(
          `INSERT INTO zo_dictionaries (domain, dictionary_name, data, items_count, fetched_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (domain, dictionary_name)
           DO UPDATE SET data = $3, items_count = $4, fetched_at = NOW(), updated_at = NOW()`,
          [entry.domain, entry.name, JSON.stringify(items), itemsCount]
        );

        // Also cache in Redis with 24h TTL
        const cacheKey = `zo:dict:${entry.domain}:${entry.name}`;
        await redis.setEx(cacheKey, 86400, JSON.stringify(items));

        logger.info(`  ✓ ${entry.name}: ${itemsCount} items`);
        successCount++;

        // Rate limit between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        logger.error(`  ✗ ${entry.name}: ${error.message}`);
        errorCount++;
      }
    }

    logger.info('');
    logger.info('Dictionary sync complete:');
    logger.info(`  Success: ${successCount}/${DICTIONARIES.length}`);
    if (errorCount > 0) {
      logger.info(`  Errors: ${errorCount}`);
    }

    // Show summary from database
    const result = await db.query(
      `SELECT domain, dictionary_name, items_count, fetched_at
       FROM zo_dictionaries
       ORDER BY domain, dictionary_name`
    );

    if (result.rows.length > 0) {
      logger.info('');
      logger.info('Database contents:');
      for (const row of result.rows) {
        logger.info(`  ${row.domain}/${row.dictionary_name}: ${row.items_count} items (fetched ${row.fetched_at})`);
      }
    }

  } catch (error: any) {
    logger.error('Dictionary sync failed:', error);
    throw error;
  } finally {
    if (redis) await redis.quit();
    await db.close();
  }
}

syncDictionaries()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
