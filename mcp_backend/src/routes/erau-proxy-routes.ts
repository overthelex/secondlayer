/**
 * ERAU Proxy Routes
 *
 * Proxies requests to the Ukrainian Bar Registry (Єдиний реєстр адвокатів України)
 * at https://erau.unba.org.ua/search
 *
 * Cache-through: Redis → PG → external API. On success, results are persisted
 * to PG and cached in Redis so repeat searches avoid external calls.
 */

import { Router, Request, Response } from 'express';
import { load } from 'cheerio';
import { logger } from '../utils/logger.js';
import { ERAUCacheService, ERAULawyer } from '../services/erau-cache-service.js';
import { BaseDatabase } from '@secondlayer/shared';

const ERAU_BASE_URL = 'https://erau.unba.org.ua';
const PROFILE_REDIS_PREFIX = 'erau:profile:';
const PROFILE_REDIS_TTL = 86400; // 24 hours

// ERAU serves at most `limit` rows per request — 10 by default — ordered by ascending
// registry id, which is the order of admission. Reading only the first page therefore
// returns the oldest advocates and hides everyone certified in recent years, so the full
// result set has to be paged through.
const ERAU_PAGE_SIZE = 200;
const ERAU_MAX_RESULTS = 2000;

class ERAUUpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`ERAU returned status ${status}`);
    this.name = 'ERAUUpstreamError';
  }
}

function normaliseLawyer(raw: any): ERAULawyer {
  return {
    id: Number(raw?.id),
    surname: raw?.surname ?? '',
    firstname: raw?.firstname ?? '',
    middlename: raw?.middlename ?? undefined,
    racalc: raw?.racalc ?? undefined,
    certnum: raw?.certnum ?? undefined,
    certat: raw?.certat ?? undefined,
    certcalc: raw?.certcalc ?? undefined,
  };
}

/**
 * Newest certificate first. ERAU dates arrive as "YYYY-MM-DD HH:MM:SS", which sorts
 * correctly as plain strings; rows without a date go last, and ties fall back to
 * descending registry id so the order is stable.
 */
function sortNewestFirst(items: ERAULawyer[]): ERAULawyer[] {
  return [...items].sort((a, b) => {
    const da = a.certat || '';
    const db = b.certat || '';
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? 1 : -1;
    }
    return b.id - a.id;
  });
}

async function fetchERAUPage(
  surname: string,
  limit: number,
  offset: number
): Promise<{ items: ERAULawyer[]; total: number }> {
  const url = `${ERAU_BASE_URL}/search?surname=${encodeURIComponent(surname)}`
    + `&limit=${limit}&offset=${offset}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'SecondLayer/1.0',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) throw new ERAUUpstreamError(response.status);

  const data = await response.json() as any;
  const page: any[] = Array.isArray(data) ? data : (data?.items || []);
  // ERAU reports the match count as a string ("291"), and ids likewise. Coerce rather
  // than type-check: treating a string total as absent silently reduced the whole result
  // set to its first page.
  const total = Number(data?.total);
  return {
    items: page.map(normaliseLawyer).filter((l) => Number.isFinite(l.id)),
    total: Number.isFinite(total) && total > 0 ? total : 0,
  };
}

async function fetchAllFromERAU(
  surname: string
): Promise<{ items: ERAULawyer[]; total: number; truncated: boolean }> {
  const first = await fetchERAUPage(surname, ERAU_PAGE_SIZE, 0);
  // 0 when the registry omits the count; paging then runs until a short page arrives.
  const reportedTotal = first.total;
  const total = reportedTotal || first.items.length;
  const truncated = reportedTotal > ERAU_MAX_RESULTS;

  // ERAU accepts no sort parameter and orders by ascending registry id, i.e. by order of
  // admission, so the most recent advocates sit at the end of the result set. A broad
  // query such as "ко" matches over 22000 of them; reading its head under the cap would
  // make "newest first" mean "newest among the oldest few", so read its tail instead.
  const startOffset = truncated ? total - ERAU_MAX_RESULTS : 0;

  const seen = new Set<number>();
  const items: ERAULawyer[] = [];
  const collect = (page: ERAULawyer[]) => {
    for (const lawyer of page) {
      if (!seen.has(lawyer.id)) {
        seen.add(lawyer.id);
        items.push(lawyer);
      }
    }
  };

  let offset = startOffset;
  let exhausted = false;
  if (!truncated) {
    collect(first.items);
    offset = first.items.length;
    exhausted = first.items.length < ERAU_PAGE_SIZE;
  }

  while (
    !exhausted
    && items.length < ERAU_MAX_RESULTS
    && (!reportedTotal || offset < reportedTotal)
  ) {
    const page = await fetchERAUPage(surname, ERAU_PAGE_SIZE, offset);
    collect(page.items);
    offset += page.items.length;
    exhausted = page.items.length < ERAU_PAGE_SIZE;
  }

  if (truncated) {
    logger.warn(
      `[ERAU] "${surname}" matched ${total} advocates; returning the ${items.length} most recently admitted`
    );
  }

  return { items: sortNewestFirst(items), total, truncated };
}

export interface ERAUProfile {
  id: string;
  fullName: string;
  council: string | null;
  certificate: {
    number: string | null;
    date: string | null;
    issuedBy: string | null;
    decisionNumber: string | null;
    decisionDate: string | null;
  };
  experience: string | null;
  contacts: {
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  practiceForm: {
    type: string | null;
    address: string | null;
    phone: string | null;
  };
  qualification: Array<{ year: string; status: string }>;
}

function parseERAUProfileHTML(html: string, id: string): ERAUProfile {
  const clean = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const $ = load(s);
    $('script, style').remove();
    return ($('body').text() || $.root().text()).replace(/\s+/g, ' ').trim() || null;
  };

  const extract = (pattern: RegExp): string | null => {
    const m = html.match(pattern);
    return m ? clean(m[1]) : null;
  };

  // Name: <h1 class="info-about__name">...</h1>
  const fullName = extract(/<h1[^>]*class="info-about__name"[^>]*>([\s\S]*?)<\/h1>/)
    || extract(/<h1[^>]*>([\s\S]*?)<\/h1>/)
    || '';

  // Council: inside .info-about__council-name <h2>
  const council = extract(/info-about__council-name[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/);

  // Certificate section: .info-about__certificate contains <p> label then <p> value pairs
  const certSection = html.match(/info-about__certificate[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  let certNumber: string | null = null;
  let certDate: string | null = null;
  let issuedBy: string | null = null;

  if (certSection) {
    const cs = certSection[0];
    // Pattern: <p>Label:</p>\n<p class="...">Value</p> or <p>Label:</p>\n<p>Value</p>
    certNumber = extract.call(null, /№\s*Свідоцтва[\s\S]*?<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(cs) ? /dummy/ : /dummy/)
      || null;
    // Use simpler approach — extract all <p> contents from certSection
    const certPs = [...cs.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => clean(m[1]));
    // Structure: [label, value, label, value, label, value]
    for (let i = 0; i < certPs.length - 1; i++) {
      const label = certPs[i] || '';
      const value = certPs[i + 1] || '';
      if (label.includes('Свідоцтва')) { certNumber = value; i++; }
      else if (label.includes('Дата видачі')) { certDate = value; i++; }
      else if (label.includes('Орган')) { issuedBy = value; i++; }
    }
  }

  // Decision section: .info-about__solution
  const solSection = html.match(/info-about__solution[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  let decisionNumber: string | null = null;
  let decisionDate: string | null = null;
  let experience: string | null = null;

  if (solSection) {
    const ss = solSection[0];
    const solPs = [...ss.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => clean(m[1]));
    for (let i = 0; i < solPs.length - 1; i++) {
      const label = solPs[i] || '';
      const value = solPs[i + 1] || '';
      if (label.includes('Номер рішення')) { decisionNumber = value; i++; }
      else if (label.includes('Дата прийняття')) { decisionDate = value; i++; }
      else if (label.includes('стаж')) { experience = value || null; i++; }
    }
  }

  // Contacts section: after "Адреса робочого місця"
  const contactSection = html.match(/Адреса робочого місця[\s\S]*?Форми адвокатської/i);
  let address: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;

  if (contactSection) {
    const cs = contactSection[0];
    // Address: <h2> inside .text-info after "Адреса основна"
    const addrMatch = cs.match(/Адреса основна[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i);
    address = addrMatch ? clean(addrMatch[1]) : null;
    // Phone: first tel: link
    const phoneMatch = cs.match(/href="tel:([^"]+)"/i);
    phone = phoneMatch ? clean(phoneMatch[1]) : null;
    // Email: mailto link
    const emailMatch = cs.match(/href="mailto:\s*([\s\S]*?)"/i);
    email = emailMatch ? clean(emailMatch[1]) : null;
  }

  // Practice form section: after "Форми адвокатської діяльності"
  const practiceSection = html.match(/Форми адвокатської діяльності[\s\S]*?(?:Підвищення кваліфікації|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/i);
  let practiceType: string | null = null;
  let practiceAddress: string | null = null;
  let practicePhone: string | null = null;

  if (practiceSection) {
    const ps = practiceSection[0];
    // Type: inside .column-right__header
    const typeMatch = ps.match(/column-right__header[\s\S]*?>([\s\S]*?)<\/div>/i);
    practiceType = typeMatch ? clean(typeMatch[1]) : null;
    if (!practiceType) {
      practiceType = extract(/(Індивідуальна адвокатська діяльність|Адвокатське бюро|Адвокатське об'єднання)/i);
    }
    // Practice address: after "Адреса:" in type-info div, value in next text-info div
    const pAddrMatch = ps.match(/Адреса:[\s\S]*?<\/div>\s*<div[^>]*class="text-info[^>]*>([\s\S]*?)<\/div>/i);
    practiceAddress = pAddrMatch ? clean(pAddrMatch[1]) : null;
    // Practice phone: tel: link inside practice section
    const pPhoneMatch = ps.match(/Мобільний[\s\S]*?href="tel:([^"]+)"/i)
      || ps.match(/href="tel:([^"]+)"/i);
    practicePhone = pPhoneMatch ? clean(pPhoneMatch[1]) : null;
  }

  // Qualification section: after "Підвищення кваліфікації"
  const qualification: Array<{ year: string; status: string }> = [];
  const qualSection = html.match(/Підвищення кваліфікації[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (qualSection) {
    // Pairs: <div class="type-info...">2021 рік</div> <div class="text-info...">Виконано</div>
    const pairs = [...qualSection[0].matchAll(/type-info[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="text-info[^>]*>([\s\S]*?)<\/div>/gi)];
    for (const m of pairs) {
      const yearMatch = m[1].match(/(\d{4})/);
      const status = clean(m[2]);
      if (yearMatch && status) {
        qualification.push({ year: yearMatch[1], status });
      }
    }
  }

  return {
    id,
    fullName: fullName || '',
    council,
    certificate: {
      number: certNumber,
      date: certDate,
      issuedBy,
      decisionNumber,
      decisionDate,
    },
    experience,
    contacts: {
      address,
      phone,
      email,
    },
    practiceForm: {
      type: practiceType,
      address: practiceAddress,
      phone: practicePhone,
    },
    qualification,
  };
}

export function createERAUProxyRoutes(erauCacheService?: ERAUCacheService, db?: BaseDatabase): Router {
  const router = Router();

  // --- Search History endpoints ---

  // GET /search-history — list recent searches for the authenticated user
  router.get('/search-history', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId || !db) {
        return res.json([]);
      }

      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const { rows } = await db.query(
        `SELECT id, query, result_count, created_at
         FROM search_history
         WHERE user_id = $1 AND page = 'lawyers'
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      res.json(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Search history fetch error', { error: msg });
      res.json([]);
    }
  });

  // POST /search-history — save a search entry
  router.post('/search-history', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId || !db) {
        return res.status(200).json({ ok: true });
      }

      const { query, resultCount } = req.body;
      if (!query || typeof query !== 'string' || query.trim().length < 2) {
        return res.status(400).json({ error: 'query required (min 2 chars)' });
      }

      const trimmed = query.trim();

      // Remove previous identical query for this user to avoid duplicates, then insert fresh
      await db.query(
        `DELETE FROM search_history WHERE user_id = $1 AND page = 'lawyers' AND LOWER(query) = LOWER($2)`,
        [userId, trimmed]
      );

      const { rows } = await db.query(
        `INSERT INTO search_history (user_id, page, query, result_count)
         VALUES ($1, 'lawyers', $2, $3)
         RETURNING id, query, result_count, created_at`,
        [userId, trimmed, resultCount || 0]
      );

      res.json(rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Search history save error', { error: msg });
      res.status(200).json({ ok: true });
    }
  });

  // DELETE /search-history/:id — delete a single history entry
  router.delete('/search-history/:id', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId || !db) {
        return res.status(200).json({ ok: true });
      }

      await db.query(
        `DELETE FROM search_history WHERE id = $1 AND user_id = $2`,
        [req.params.id, userId]
      );

      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Search history delete error', { error: msg });
      res.status(200).json({ ok: true });
    }
  });

  // DELETE /search-history — clear all history for authenticated user
  router.delete('/search-history', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId || !db) {
        return res.status(200).json({ ok: true });
      }

      await db.query(
        `DELETE FROM search_history WHERE user_id = $1 AND page = 'lawyers'`,
        [userId]
      );

      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Search history clear error', { error: msg });
      res.status(200).json({ ok: true });
    }
  });

  // Profile endpoint
  router.get('/profile/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid profile ID' });
      }

      // 1. Check Redis cache
      const redisKey = `${PROFILE_REDIS_PREFIX}${id}`;
      try {
        const { getRedisClient } = await import('../utils/redis-client.js');
        const redis = await getRedisClient();
        if (redis) {
          const cached = await redis.get(redisKey);
          if (cached) {
            logger.info(`[ERAU] Profile cache hit for id=${id}`);
            return res.json(JSON.parse(cached));
          }
        }
      } catch (err: any) {
        logger.warn('[ERAU] Redis read error for profile', { error: err.message });
      }

      // 2. Fetch from ERAU
      const url = `${ERAU_BASE_URL}/profile/${id}`;
      logger.info(`[ERAU] Fetching profile id=${id}`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'SecondLayer/1.0',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: 'Profile not found' });
        }
        return res.status(502).json({ error: `ERAU returned status ${response.status}` });
      }

      const html = await response.text();
      const profile = parseERAUProfileHTML(html, id);

      // 3. Cache in Redis (fire-and-forget)
      try {
        const { getRedisClient } = await import('../utils/redis-client.js');
        const redis = await getRedisClient();
        if (redis) {
          await redis.set(redisKey, JSON.stringify(profile), { EX: PROFILE_REDIS_TTL });
        }
      } catch (err: any) {
        logger.warn('[ERAU] Redis write error for profile', { error: err.message });
      }

      res.json(profile);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Profile fetch error', { error: msg });
      if (msg.includes('timeout') || msg.includes('abort')) {
        return res.status(504).json({ error: 'ERAU request timed out' });
      }
      res.status(502).json({ error: 'Failed to fetch ERAU profile' });
    }
  });

  router.get('/search', async (req: Request, res: Response) => {
    try {
      const surname = req.query.surname as string;
      if (!surname || surname.trim().length < 2) {
        return res.status(400).json({ error: 'surname query parameter required (min 2 characters)' });
      }

      const trimmed = surname.trim();

      // 1. Check cache (Redis → PG). An empty array is a valid cached answer.
      if (erauCacheService) {
        const cached = await erauCacheService.getBySurname(trimmed);
        if (cached) {
          logger.info(`[ERAU] Serving ${cached.length} cached results for "${trimmed}"`);
          return res.json(cached);
        }
      }

      // 2. Fetch every page from the external API
      logger.info(`[ERAU] Proxying search for surname="${trimmed}"`);

      let items: ERAULawyer[];
      let total: number;
      try {
        ({ items, total } = await fetchAllFromERAU(trimmed));
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (fetchErr instanceof ERAUUpstreamError) {
          logger.warn(`[ERAU] Upstream returned ${fetchErr.status}`);
        } else {
          logger.error('[ERAU] External API error', { error: msg });
        }

        // Fall back to the last known result set, even if it is past its TTL
        if (erauCacheService) {
          const fallback = await erauCacheService.getBySurname(trimmed, { allowStale: true });
          if (fallback && fallback.length > 0) {
            logger.info(`[ERAU] Serving ${fallback.length} stale results for "${trimmed}" after upstream failure`);
            return res.json(fallback);
          }
        }

        if (fetchErr instanceof ERAUUpstreamError) {
          return res.status(502).json({ error: `ERAU returned status ${fetchErr.status}` });
        }
        if (msg.includes('timeout') || msg.includes('abort')) {
          return res.status(504).json({ error: 'ERAU request timed out' });
        }
        return res.status(502).json({ error: 'Failed to reach ERAU registry' });
      }

      // 3. Cache results (fire-and-forget)
      if (erauCacheService) {
        erauCacheService.cacheResults(trimmed, items, total).catch((err) => {
          logger.warn('[ERAU] Background cache write failed', { error: err.message });
        });
      }

      logger.info(`[ERAU] Returning ${items.length} of ${total} results for "${trimmed}"`);
      res.json(items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ERAU] Proxy error', { error: msg });
      res.status(502).json({ error: 'Failed to reach ERAU registry' });
    }
  });

  return router;
}
