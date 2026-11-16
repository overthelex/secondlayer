import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSitemap, IndexNowSubmitter, INDEXNOW_KEY } from '../indexnow.js';

const INDEX = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://legal.org.ua/zakon/sitemap.xml</loc></sitemap>
  <sitemap><loc>https://legal.org.ua/broken.xml</loc></sitemap>
  <sitemap><loc>https://other.example/sitemap.xml</loc></sitemap>
</sitemapindex>`;
const ZAKON = `<urlset>
  <url><loc>https://legal.org.ua/zakon</loc><lastmod>2026-08-05</lastmod></url>
  <url><loc>https://legal.org.ua/zakon/tsyvilnyi-kodeks?a=1&amp;b=2</loc><lastmod>2026-08-05</lastmod></url>
  <url><loc>https://legal.org.ua/zakon/tsyvilnyi-kodeks/stattia-625</loc></url>
  <url><loc>https://elsewhere.example/x</loc></url>
</urlset>`;

function fakeFetch(status = 200) {
  const posts: Array<{ body: { host: string; key: string; keyLocation: string; urlList: string[] } }> = [];
  const fn = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push({ body: JSON.parse(init.body!) });
      return { ok: status < 300, status, text: async () => 'nope' };
    }
    const body = url.endsWith('/sitemap.xml') && url.startsWith('https://legal.org.ua/zakon') ? ZAKON
      : url === 'https://legal.org.ua/sitemap.xml' ? INDEX : null;
    return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => '' };
  });
  return { fn, posts };
}

/** seo_indexnow as a Map; answers the two queries the submitter makes. */
function fakeDb(seen: Map<string, string | null> = new Map()) {
  return {
    seen,
    query: jest.fn(async (sql: string, params: unknown[]) => {
      const [locs, mods] = params as [string[], Array<string | null>];
      if (sql.includes('LEFT JOIN seo_indexnow')) {
        return { rows: locs.filter((l, i) => !seen.has(l) || seen.get(l) !== mods[i]).map(loc => ({ loc })) };
      }
      if (sql.includes('INSERT INTO seo_indexnow')) {
        locs.forEach((l, i) => seen.set(l, mods[i]));
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

describe('parseSitemap', () => {
  it('reads index children and url entries, unescaping &amp;', () => {
    expect(parseSitemap(INDEX).sitemaps).toHaveLength(3);
    const { urls } = parseSitemap(ZAKON);
    expect(urls[1]).toEqual({ loc: 'https://legal.org.ua/zakon/tsyvilnyi-kodeks?a=1&b=2', lastmod: '2026-08-05' });
    expect(urls[2].lastmod).toBeNull();
  });
});

describe('IndexNowSubmitter', () => {
  it('submits our own URLs once, then only new or changed ones', async () => {
    const { fn, posts } = fakeFetch();
    const db = fakeDb();
    const s = new IndexNowSubmitter(db as never, fn as never);
    expect(await s.run()).toBe(3);
    expect(posts[0].body.host).toBe('legal.org.ua');
    expect(posts[0].body.keyLocation).toBe(`https://legal.org.ua/${INDEXNOW_KEY}.txt`);
    expect(posts[0].body.urlList).not.toContain('https://elsewhere.example/x');

    expect(await s.run()).toBe(0);
    db.seen.set('https://legal.org.ua/zakon', '2020-01-01'); // lastmod moved on
    expect(await s.run()).toBe(1);
    expect(posts[posts.length - 1].body.urlList).toEqual(['https://legal.org.ua/zakon']);
  });

  it('respects the cap and keeps unsent URLs for the next run', async () => {
    const { fn } = fakeFetch();
    const db = fakeDb();
    const s = new IndexNowSubmitter(db as never, fn as never);
    expect(await s.run(2)).toBe(2);
    expect(await s.run(2)).toBe(1);
  });

  it('records nothing when IndexNow rejects the batch', async () => {
    const { fn } = fakeFetch(403);
    const db = fakeDb();
    await expect(new IndexNowSubmitter(db as never, fn as never).run()).rejects.toThrow('IndexNow HTTP 403');
    expect(db.seen.size).toBe(0);
  });
});

describe('key file', () => {
  it('is served from lexwebapp/public with the key as its only content', () => {
    const file = join(__dirname, '../../../../../lexwebapp/public', `${INDEXNOW_KEY}.txt`);
    expect(readFileSync(file, 'utf8')).toBe(INDEXNOW_KEY);
  });
});
