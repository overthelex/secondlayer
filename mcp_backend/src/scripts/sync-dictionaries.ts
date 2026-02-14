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
 *   legal_acts: documentTypes, authors (extracted from search results — API returns 403 on dictionary endpoints)
 *   court_practice: categories, types
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { type ZakonOnlineDomainName } from '../types/zakononline-domains.js';
import { createClient } from 'redis';

interface DictionaryEntry {
  domain: ZakonOnlineDomainName;
  name: string;
  method: string;
  params?: Record<string, any>;
  /** If true, this dictionary must be extracted from search results instead of a dedicated endpoint */
  extractFromSearch?: boolean;
}

/**
 * Known legal_acts author ID -> name mapping.
 * The legal_acts API (searcher.api.zakononline.com.ua) returns 403 on /v1/authors,
 * so we maintain this mapping based on document analysis and website scraping.
 * The author field in search results is a numeric string ID (sometimes comma-separated for co-authors).
 *
 * To discover new authors: run with search terms covering all document types,
 * then look up unknown IDs on zakononline.ua document pages.
 */
const LEGAL_ACTS_AUTHORS: Record<string, string> = {
  '8501089': 'Верховна Рада України',
  '8501090': 'Верховна Рада УРСР',
  '8501091': 'Верховна Рада Автономної Республіки Крим',
  '8501092': 'Верховний Суд України',
  '8501095': 'Вищий адміністративний суд України',
  '8501096': 'Вищий господарський суд України',
  '8501097': 'Вищий спеціалізований суд України',
  '8501098': 'Генеральна прокуратура України',
  '8501100': 'Державна комісія з регулювання ринків фінансових послуг',
  '8501110': 'Державна служба спеціального зв\'язку та захисту інформації',
  '8501131': 'Конституційний Суд України',
  '8501136': 'Рада суддів України',
  '8501150': 'Міжнародний документ',
  '8501155': 'Міністерство внутрішніх справ України',
  '8501160': 'Міністерство економіки України',
  '8501163': 'Міністерство закордонних справ України',
  '8501166': 'Міністерство культури України',
  '8501225': 'Міністерство соціальної політики України',
  '8501266': 'Пенсійний фонд України',
  '8501268': 'Кабінет Міністрів України',
  '8501290': 'Державна податкова адміністрація України',
  '8501301': 'Державна служба статистики України',
  '8501321': 'Міністерство оборони України',
  '8501322': 'Міністерство освіти і науки України',
  '8501325': 'Міністерство охорони здоров\'я України',
  '8501332': 'Міністерство регіонального розвитку України',
  '8501357': 'Міністерство фінансів України',
  '8501358': 'Міністерство юстиції України',
  '8501361': 'Національна комісія з цінних паперів та фондового ринку',
  '8501371': 'Державна митна служба України',
  '8501372': 'Державна служба України з питань праці',
  '8501374': 'Антимонопольний комітет України',
  '8501375': 'Фонд державного майна України',
  '8501376': 'Національна комісія, що здійснює державне регулювання у сферах енергетики та комунальних послуг',
  '8501378': 'Державна архівна служба України',
  '8501384': 'Державна казначейська служба України',
  '8501390': 'Державна регуляторна служба України',
  '8501392': 'Національний банк України',
  '8501399': 'Рахункова палата',
  '8501400': 'Служба безпеки України',
  '8501402': 'Президент України',
  '8501403': 'Центральне розвідувальне управління',
  '8501410': 'Міністерство закордонних справ (міжнародні)',
  '8501412': 'Рада національної безпеки і оборони України',
  '8501418': 'Державне агентство з енергоефективності',
  '8501439': 'Державна авіаційна служба України',
  '8501441': 'Державна служба геології та надр України',
  '8501446': 'Національна поліція України',
  '8501448': 'Центральна виборча комісія',
  '8501449': 'Національна рада з питань телебачення і радіомовлення',
  '8501504': 'Держгірпромнагляд',
  '8501505': 'Державна екологічна інспекція України',
  '8501564': 'Фонд гарантування вкладів фізичних осіб',
  '8501590': 'Державна служба України з надзвичайних ситуацій',
  '8501702': 'Співдружність Незалежних Держав',
  '8501705': 'Міжнародні угоди',
  '8501714': 'Рада Європи',
  '8501732': 'Європейський Союз',
};

// All dictionaries to sync, mapped to their domains
const DICTIONARIES: DictionaryEntry[] = [
  // Court Decisions domain
  { domain: 'court_decisions', name: 'courts', method: 'getCourtsDictionary' },
  { domain: 'court_decisions', name: 'instances', method: 'getInstancesDictionary' },
  { domain: 'court_decisions', name: 'judgmentForms', method: 'getJudgmentFormsDictionary' },
  { domain: 'court_decisions', name: 'justiceKinds', method: 'getJusticeKindsDictionary' },
  { domain: 'court_decisions', name: 'regions', method: 'getRegionsDictionary' },
  { domain: 'court_decisions', name: 'judges', method: 'getJudgesDictionary' },
  // Legal Acts domain — dictionary endpoints return 403, extract from search results
  { domain: 'legal_acts', name: 'documentTypes', method: 'searchCourtDecisions', extractFromSearch: true },
  { domain: 'legal_acts', name: 'authors', method: 'searchCourtDecisions', extractFromSearch: true },
  // Court Practice domain
  { domain: 'court_practice', name: 'categories', method: 'getCategoriesDictionary' },
  { domain: 'court_practice', name: 'types', method: 'getTypesDictionary' },
];

/**
 * Extract documentTypes and authors dictionaries from legal_acts search results.
 * The legal_acts API (searcher.api.zakononline.com.ua) returns 403 on /v1/document_types
 * and /v1/authors dictionary endpoints, so we extract unique values from search results
 * and use the known author mapping.
 *
 * We search by document type names (title search) to ensure we discover all types and authors.
 */
async function extractLegalActsDictionaries(
  adapter: ZOAdapter
): Promise<{ documentTypes: any[]; authors: any[] }> {
  const typesMap = new Map<number, string>();
  const authorsSet = new Set<string>();

  // Search by known document type names to cover maximum variety of types/authors
  const SEARCH_TERMS = [
    'закон', 'кодекс', 'наказ', 'указ', 'постанова', 'рішення',
    'розпорядження', 'угода', 'повідомлення', 'лист', 'договір',
    'декрет', 'інструкція', 'положення', 'регламент', 'конвенція',
  ];

  for (const term of SEARCH_TERMS) {
    try {
      const data = await adapter.searchCourtDecisions({
        meta: { search: term },
        target: 'title' as any,
        limit: 100,
      });

      const items = Array.isArray(data) ? data : (data?.data || []);
      if (items.length === 0) continue;

      for (const doc of items) {
        // Extract document type: id + name from title
        const typeId = doc.type;
        if (typeId && !typesMap.has(typeId)) {
          const title = doc.title || '';
          // Title format: "Закон № 1127-XIV від ..." or "Повідомлення від ..."
          const match = title.match(/^([А-ЯІЇЄҐа-яіїєґA-Za-z\s'-]+?)(?:\s+№|\s+від)/);
          const typeName = match ? match[1].trim() : `Type ${typeId}`;
          typesMap.set(typeId, typeName);
        }

        // Collect author IDs (can be comma-separated for co-authored documents)
        const authorId = doc.author ? String(doc.author) : '';
        if (authorId) {
          authorsSet.add(authorId);
        }
      }

      // Rate limit between searches
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error: any) {
      logger.warn(`Error searching legal_acts for "${term}": ${error.message}`);
    }
  }

  // Build documentTypes array
  const documentTypes = Array.from(typesMap.entries()).map(([id, name]) => ({
    id,
    name,
  }));

  // Build authors array using known mapping + any new IDs found
  const authors = Array.from(authorsSet).map(id => ({
    id,
    name: LEGAL_ACTS_AUTHORS[id] || `Unknown Author (${id})`,
  }));

  // Log any unknown authors for future mapping
  const unknownAuthors = Array.from(authorsSet).filter(id => !LEGAL_ACTS_AUTHORS[id]);
  if (unknownAuthors.length > 0) {
    logger.warn(`Found unknown legal_acts author IDs: ${unknownAuthors.join(', ')}. Update LEGAL_ACTS_AUTHORS mapping.`);
  }

  return { documentTypes, authors };
}

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

    // Pre-extract legal_acts dictionaries (done once, shared between documentTypes and authors entries)
    let legalActsData: { documentTypes: any[]; authors: any[] } | null = null;
    const legalActsAdapter = adapters.get('legal_acts');
    if (legalActsAdapter) {
      try {
        logger.info('Extracting legal_acts dictionaries from search results (API dictionary endpoints return 403)...');
        legalActsData = await extractLegalActsDictionaries(legalActsAdapter);
        logger.info(`  Found ${legalActsData.documentTypes.length} document types, ${legalActsData.authors.length} authors`);
      } catch (error: any) {
        logger.error(`Failed to extract legal_acts dictionaries: ${error.message}`);
      }
    }

    for (const entry of DICTIONARIES) {
      try {
        logger.info(`Fetching ${entry.domain}/${entry.name}...`);

        let items: any[];

        if (entry.extractFromSearch) {
          // Use pre-extracted legal_acts data
          if (!legalActsData) {
            throw new Error('Legal acts data extraction failed earlier');
          }
          items = entry.name === 'documentTypes'
            ? legalActsData.documentTypes
            : legalActsData.authors;
        } else {
          const adapter = adapters.get(entry.domain)!;
          // Call the dictionary method
          const data = await (adapter as any)[entry.method](entry.params);
          // Extract items array from response
          items = Array.isArray(data) ? data : (data?.data || data?.items || []);
        }

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

        // Rate limit between requests (skip for extractFromSearch — already rate-limited)
        if (!entry.extractFromSearch) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
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
