/**
 * openreyestr_get_statistics enricher (LEXAI-2121).
 *
 * The OpenReyestr service counts public associations from its own
 * `public_associations` table (the ЄДР FSU section), which holds a few hundred
 * rows. The registry of public formations users actually search
 * (search_registry → public_organizations) lives in this backend's database as
 * `opendata_public_organizations` (~1.08M rows), which the OpenReyestr service
 * cannot reach. The gateway therefore replaces that counter with the real one.
 *
 * Cost: one GROUP BY over the table (index-only on registry_type, a few hundred ms),
 * cached in memory for CACHE_TTL_MS, so it runs at most once an hour per process.
 * pg_stat n_live_tup is not used: it reads 0 for this table after bulk loads.
 */

import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 60 * 60 * 1000;

interface QueryableDb {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface PublicOrganizationsCount {
  total: number;
  byType: Record<string, number>;
}

let cache: { value: PublicOrganizationsCount; at: number } | null = null;

/** Exposed for tests. */
export function resetPublicOrganizationsCountCache(): void {
  cache = null;
}

export async function getPublicOrganizationsCount(db: QueryableDb): Promise<PublicOrganizationsCount> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const result = await db.query(
    `SELECT COALESCE(NULLIF(registry_type, ''), 'unknown') AS registry_type, COUNT(*)::bigint AS n
       FROM opendata_public_organizations
      GROUP BY 1
      ORDER BY 2 DESC`
  );
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    const n = parseInt(row.n, 10) || 0;
    byType[row.registry_type] = n;
    total += n;
  }
  const value = { total, byType };
  cache = { value, at: Date.now() };
  return value;
}

const toInt = (v: unknown): number => (typeof v === 'number' ? v : parseInt(String(v ?? 0), 10) || 0);

/**
 * Replace the publicAssociations counters in an OpenReyestr get_statistics result
 * with the Minjust registry of public formations. Accepts both the MCP envelope the
 * service returns ({ content: [{ type: 'text', text: '<json>' }] }) and a bare stats
 * object. Returns the input unchanged if its shape is not the expected one or the
 * count cannot be read.
 */
export async function enrichOpenreyestrStatistics(result: any, db: QueryableDb): Promise<any> {
  const text = result?.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
  if (typeof text === 'string' && !result.isError) {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return result;
    }
    const enriched = await enrichStats(parsed, db);
    if (enriched === parsed) return result;
    return {
      ...result,
      content: [{ ...result.content[0], text: JSON.stringify(enriched, null, 2) }, ...result.content.slice(1)],
    };
  }
  return enrichStats(result, db);
}

async function enrichStats(result: any, db: QueryableDb): Promise<any> {
  if (!result || typeof result !== 'object' || !result.totalEntities) return result;

  let orgs: PublicOrganizationsCount;
  try {
    orgs = await getPublicOrganizationsCount(db);
  } catch (err: any) {
    logger.warn('[openreyestr_get_statistics] public organizations count failed, returning upstream result', {
      error: err?.message,
    });
    return result;
  }

  const total = result.totalEntities;
  const active = result.activeEntities || {};
  const legal = toInt(total.legalEntities);
  const fop = toInt(total.individualEntrepreneurs);
  const legalActive = toInt(active.legalEntities);
  const fopActive = toInt(active.individualEntrepreneurs);

  return {
    totalEntities: {
      legalEntities: legal,
      individualEntrepreneurs: fop,
      total: legal + fop,
      publicAssociations: orgs.total,
    },
    activeEntities: {
      legalEntities: legalActive,
      individualEntrepreneurs: fopActive,
      total: legalActive + fopActive,
      publicAssociations: null,
    },
    publicAssociationsByType: orgs.byType,
    notes: [
      "legalEntities та individualEntrepreneurs — Єдиний державний реєстр (НАІС); total — їх сума.",
      "publicAssociations — Реєстр громадських формувань Мін'юсту (ГО, політичні партії та їх осередки, " +
        'профспілки, благодійні та релігійні організації тощо), той самий, що search_registry → public_organizations. ' +
        'Формування зі статусом юридичної особи також враховані в legalEntities, тому до total не додаються.',
      'Кількість діючих громадських формувань не наводиться: статус заповнено лише для благодійних організацій і профспілок.',
    ],
  };
}
