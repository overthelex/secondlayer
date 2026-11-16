/**
 * Daily IndexNow submission for legal.org.ua (Bing, Yandex, Seznam, Naver share
 * one endpoint; Google does not take part and reads the sitemaps).
 *
 * Walks the public sitemap index, keeps the URLs of our own host, and submits
 * only those that are new or whose <lastmod> changed since the last run
 * (table seo_indexnow). The key is public by design: the search engine checks
 * it against https://legal.org.ua/<key>.txt, served from lexwebapp/public.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';

export const INDEXNOW_KEY = 'ae8f3c5ec6f81d4bec85fc06634183c5';
export const INDEXNOW_SITE = 'https://legal.org.ua';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
/** Protocol limit per request. */
const BATCH = 10_000;
/** Spread the first full pass (~55K URLs) over a few days. */
const DAILY_CAP = 20_000;
const UA = 'LEX-IndexNow/1.0 (+https://legal.org.ua)';

export interface SitemapEntry { loc: string; lastmod: string | null }

/** <sitemapindex> children and <urlset> entries of one sitemap document. */
export function parseSitemap(xml: string): { sitemaps: string[]; urls: SitemapEntry[] } {
  const tag = (block: string, name: string) => {
    const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  };
  const sitemaps = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map(m => tag(m[1], 'loc')).filter((x): x is string => !!x);
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)]
    .map(m => ({ loc: tag(m[1], 'loc'), lastmod: tag(m[1], 'lastmod') }))
    .filter((x): x is SitemapEntry => !!x.loc);
  return { sitemaps, urls };
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class IndexNowSubmitter {
  private running = false;

  constructor(
    private readonly db: BaseDatabase,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    private readonly site = INDEXNOW_SITE,
  ) {}

  /** Every URL of our host listed in the sitemap index (one level of nesting). */
  async collect(): Promise<SitemapEntry[]> {
    const get = async (url: string) => {
      const r = await this.fetchFn(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return parseSitemap(await r.text());
    };
    const root = await get(`${this.site}/sitemap.xml`);
    const out = new Map<string, SitemapEntry>();
    const add = (list: SitemapEntry[]) => { for (const u of list) if (u.loc.startsWith(`${this.site}/`) || u.loc === this.site) out.set(u.loc, u); };
    add(root.urls);
    for (const sm of root.sitemaps) {
      if (!sm.startsWith(`${this.site}/`)) continue;
      try {
        add((await get(sm)).urls);
      } catch (err) {
        logger.warn('[indexnow] sitemap skipped', { sitemap: sm, err: (err as Error).message });
      }
    }
    return [...out.values()];
  }

  /** Entries not yet submitted with this lastmod. */
  async pending(entries: SitemapEntry[]): Promise<SitemapEntry[]> {
    if (!entries.length) return [];
    const r = await this.db.query(
      `SELECT u.loc FROM unnest($1::text[], $2::text[]) AS u(loc, lastmod)
         LEFT JOIN seo_indexnow s ON s.url = u.loc
        WHERE s.url IS NULL OR s.lastmod IS DISTINCT FROM u.lastmod`,
      [entries.map(e => e.loc), entries.map(e => e.lastmod)],
    );
    const want = new Set(r.rows.map((x: { loc: string }) => x.loc));
    return entries.filter(e => want.has(e.loc));
  }

  private async submit(batch: SitemapEntry[]): Promise<void> {
    const host = new URL(this.site).host;
    const r = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': UA },
      body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${this.site}/${INDEXNOW_KEY}.txt`, urlList: batch.map(e => e.loc) }),
    });
    // 200 = accepted, 202 = accepted, key validation pending
    if (r.status !== 200 && r.status !== 202) throw new Error(`IndexNow HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await this.db.query(
      `INSERT INTO seo_indexnow (url, lastmod, submitted_at)
       SELECT u, l, now() FROM unnest($1::text[], $2::text[]) AS t(u, l)
       ON CONFLICT (url) DO UPDATE SET lastmod = EXCLUDED.lastmod, submitted_at = now()`,
      [batch.map(e => e.loc), batch.map(e => e.lastmod)],
    );
  }

  /** Returns the number of URLs submitted, or null when a run is already in progress. */
  async run(cap = DAILY_CAP): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const all = await this.collect();
      const todo = (await this.pending(all)).slice(0, cap);
      for (let i = 0; i < todo.length; i += BATCH) await this.submit(todo.slice(i, i + BATCH));
      logger.info('[indexnow] submitted', { listed: all.length, submitted: todo.length });
      return todo.length;
    } finally {
      this.running = false;
    }
  }
}
