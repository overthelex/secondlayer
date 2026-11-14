/**
 * Sitemap generation: sitemap.xml is a sitemap index pointing at one file
 * per section. Written into dist/ at the end of the build (vite.config.ts
 * sitemapPlugin). Only URLs that really exist go in: a blog post appears in
 * a language only if that translation exists, and scripts/seo/seo-check.ts
 * fails the build if any listed URL lacks its own prerendered HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL } from './html';

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: 'daily' | 'weekly' | 'monthly';
  priority?: string;
}

export interface BlogPostRef {
  id: string;
  publishedAt: string;
  langs: Array<'uk' | 'en' | 'ru'>;
}

export const LEGAL_SLUGS: Array<{ slug: string; hasEn: boolean }> = [
  { slug: 'offer', hasEn: true },
  { slug: 'attorney-offer', hasEn: true },
  { slug: 'developer-offer', hasEn: true },
  { slug: 'marketplace-rules', hasEn: true },
  { slug: 'terms', hasEn: true },
  { slug: 'privacy', hasEn: true },
  { slug: 'dpa', hasEn: true },
  { slug: 'ai-usage', hasEn: true },
  { slug: 'ai-transparency', hasEn: true },
  { slug: 'refund-policy', hasEn: true },
  { slug: 'api-terms', hasEn: true },
  { slug: 'aup', hasEn: false },
];

/** Prerendered marketing pages. Investor pages are deliberately absent (noindex). */
const PAGES: SitemapEntry[] = [
  { loc: '/', changefreq: 'daily', priority: '1.0' },
  { loc: '/product', changefreq: 'weekly', priority: '0.95' },
  { loc: '/about', changefreq: 'monthly', priority: '0.85' },
  { loc: '/about/team', changefreq: 'monthly', priority: '0.8' },
  { loc: '/developer/docs', changefreq: 'weekly', priority: '0.9' },
  { loc: '/lex-news', changefreq: 'weekly', priority: '0.7' },
  { loc: '/cisoacademy', changefreq: 'monthly', priority: '0.5' },
  { loc: '/data-sources', changefreq: 'monthly', priority: '0.6' },
  ...['us', 'uk', 'de', 'fr', 'nl', 'ee', 'ua'].map(c => ({ loc: `/${c}/data-sources`, changefreq: 'monthly' as const, priority: '0.6' })),
  { loc: '/eu/comparison', changefreq: 'monthly', priority: '0.6' },
];

function blogPath(id: string, lang: 'uk' | 'en' | 'ru'): string {
  return lang === 'en' ? `/blog/${id}` : `/blog/${lang}/${id}`;
}

export function buildSections(posts: BlogPostRef[]): Record<string, SitemapEntry[]> {
  const dates = posts.map(p => p.publishedAt).sort();
  const latest = dates[dates.length - 1];
  const blog: SitemapEntry[] = [
    { loc: '/blog', lastmod: latest, changefreq: 'weekly', priority: '0.9' },
    { loc: '/blog/uk', lastmod: latest, changefreq: 'weekly', priority: '0.9' },
    { loc: '/blog/ru', lastmod: latest, changefreq: 'weekly', priority: '0.6' },
  ];
  for (const p of posts) {
    for (const lang of p.langs) {
      blog.push({ loc: blogPath(p.id, lang), lastmod: p.publishedAt, changefreq: 'monthly', priority: lang === 'uk' ? '0.8' : '0.7' });
    }
  }
  const legal: SitemapEntry[] = LEGAL_SLUGS.flatMap(({ slug, hasEn }) => [
    { loc: `/ua/${slug}`, changefreq: 'monthly' as const, priority: '0.4' },
    ...(hasEn ? [{ loc: `/en/${slug}`, changefreq: 'monthly' as const, priority: '0.3' }] : []),
  ]);
  return { pages: PAGES, blog, legal };
}

function urlset(entries: SitemapEntry[]): string {
  const urls = entries.map(e => [
    '  <url>',
    `    <loc>${BASE_URL}${e.loc}</loc>`,
    e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
    e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
    e.priority ? `    <priority>${e.priority}</priority>` : null,
    '  </url>',
  ].filter(Boolean).join('\n'));
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

/**
 * Sitemaps generated at request time by mcp_backend (routes/zakon-routes.ts),
 * listed in the index but not written here. seo-check skips them.
 */
export const BACKEND_SITEMAPS = ['/zakon/sitemap.xml', '/sud/sitemap.xml', '/suddia/sitemap.xml', '/pozytsiia-vs/sitemap.xml', '/advokat/sitemap.xml'];

/** Writes sitemap.xml (index) + sitemap-<section>.xml into outDir. Returns URL count. */
export function writeSitemaps(outDir: string, posts: BlogPostRef[]): number {
  const sections = buildSections(posts);
  const today = new Date().toISOString().slice(0, 10);
  const index = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...Object.keys(sections).map(name => `  <sitemap>\n    <loc>${BASE_URL}/sitemap-${name}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`),
    // served by mcp_backend, not part of this build (no lastmod: the backend's own urlset carries per-URL dates)
    ...BACKEND_SITEMAPS.map(p => `  <sitemap>\n    <loc>${BASE_URL}${p}</loc>\n  </sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n');
  let total = 0;
  for (const [name, entries] of Object.entries(sections)) {
    fs.writeFileSync(path.join(outDir, `sitemap-${name}.xml`), urlset(entries));
    total += entries.length;
  }
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), index);
  return total;
}
