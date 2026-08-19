import { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';
import { getRedisClient } from '../utils/redis-client.js';

export interface ERAULawyer {
  id: number;
  surname: string;
  firstname: string;
  middlename?: string;
  racalc?: string;
  certnum?: string;
  certat?: string;
  certcalc?: string;
}

// v3: earlier keyspaces hold truncated result sets — ten rows before pagination, then
// one 200-row page while the registry's string `total` was being read as absent.
const REDIS_PREFIX = 'erau:search:v3:';
const REDIS_TTL = 86400; // 24 hours
const PG_TTL_HOURS = 24;

export interface CacheLookupOptions {
  /** Serve a result set even if it is past its TTL — used as a fallback when ERAU is down. */
  allowStale?: boolean;
}

export class ERAUCacheService {
  constructor(private db: BaseDatabase) {}

  async getBySurname(surname: string, options: CacheLookupOptions = {}): Promise<ERAULawyer[] | null> {
    const queryKey = this.queryKey(surname);
    const key = `${REDIS_PREFIX}${queryKey}`;

    // 1. Try Redis (skipped for stale reads — Redis entries expire with the TTL anyway)
    if (!options.allowStale) {
      try {
        const redis = await getRedisClient();
        if (redis) {
          const cached = await redis.get(key);
          if (cached) {
            logger.info(`[ERAU Cache] Redis hit for "${surname}"`);
            return JSON.parse(cached);
          }
        }
      } catch (err: any) {
        logger.warn('[ERAU Cache] Redis read error', { error: err.message });
      }
    }

    // 2. Try PG, keyed by the query rather than by surname so that prefix matches
    //    ("Мельник" → "Мельникова") and empty result sets are reproduced faithfully.
    try {
      const freshness = options.allowStale
        ? ''
        : `AND fetched_at > NOW() - INTERVAL '${PG_TTL_HOURS} hours'`;

      const entry = await this.db.query(
        `SELECT erau_ids, fetched_at FROM erau_search_cache WHERE query_key = $1 ${freshness}`,
        [queryKey]
      );
      if (entry.rows.length === 0) return null;

      const ids: string[] = entry.rows[0].erau_ids || [];
      if (ids.length === 0) {
        logger.info(`[ERAU Cache] PG hit for "${surname}" (empty result set)`);
        return [];
      }

      const result = await this.db.query(
        `SELECT l.erau_id AS id, l.surname, l.firstname, l.middlename, l.racalc,
                l.certnum, l.certat, l.certcalc
         FROM unnest($1::bigint[]) WITH ORDINALITY AS u(erau_id, ord)
         JOIN erau_lawyers l ON l.erau_id = u.erau_id
         ORDER BY u.ord`,
        [ids]
      );

      logger.info(
        `[ERAU Cache] PG hit for "${surname}" (${result.rows.length} rows` +
        `${options.allowStale ? ', stale' : ''})`
      );
      const lawyers: ERAULawyer[] = result.rows;
      if (!options.allowStale) {
        // Repopulate Redis
        this.setRedis(key, lawyers).catch(() => {});
      }
      return lawyers;
    } catch (err: any) {
      logger.warn('[ERAU Cache] PG read error', { error: err.message });
    }

    return null;
  }

  async cacheResults(surname: string, lawyers: ERAULawyer[], total?: number): Promise<void> {
    const queryKey = this.queryKey(surname);

    try {
      if (lawyers.length > 0) {
        const values: any[] = [];
        const placeholders: string[] = [];
        let idx = 1;

        for (const l of lawyers) {
          placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
          values.push(l.id, l.surname, l.firstname, l.middlename || null, l.racalc || null, l.certnum || null, l.certat || null, l.certcalc || null);
          idx += 8;
        }

        await this.db.query(
          `INSERT INTO erau_lawyers (erau_id, surname, firstname, middlename, racalc, certnum, certat, certcalc)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (erau_id) DO UPDATE SET
             surname = EXCLUDED.surname,
             firstname = EXCLUDED.firstname,
             middlename = EXCLUDED.middlename,
             racalc = EXCLUDED.racalc,
             certnum = EXCLUDED.certnum,
             certat = EXCLUDED.certat,
             certcalc = EXCLUDED.certcalc,
             updated_at = NOW()`,
          values
        );
      }

      await this.db.query(
        `INSERT INTO erau_search_cache (query_key, erau_ids, total, fetched_at)
         VALUES ($1, $2::bigint[], $3, NOW())
         ON CONFLICT (query_key) DO UPDATE SET
           erau_ids = EXCLUDED.erau_ids,
           total = EXCLUDED.total,
           fetched_at = NOW()`,
        [queryKey, lawyers.map((l) => l.id), total ?? lawyers.length]
      );
      logger.info(`[ERAU Cache] Cached ${lawyers.length} lawyers for "${surname}"`);
    } catch (err: any) {
      logger.warn('[ERAU Cache] PG upsert error', { error: err.message });
    }

    await this.setRedis(`${REDIS_PREFIX}${queryKey}`, lawyers).catch(() => {});
  }

  private queryKey(surname: string): string {
    return surname.trim().toLowerCase();
  }

  private async setRedis(key: string, data: ERAULawyer[]): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (redis) {
        await redis.set(key, JSON.stringify(data), { EX: REDIS_TTL });
      }
    } catch (err: any) {
      logger.warn('[ERAU Cache] Redis write error', { error: err.message });
    }
  }
}
