/**
 * Generates sitemap.xml from blog articles and static routes.
 *
 * Run standalone:  node --import tsx scripts/generate-sitemap.ts
 * Or via build:    automatically invoked by the Vite sitemapPlugin in vite.config.ts
 *
 * The script reads articles.ts with a regex so it works without importing
 * the full TypeScript source (no tsx / ts-node dependency required).
 */

import { writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = 'https://legal.org.ua';

interface SitemapEntry {
  loc: string;
  changefreq: 'daily' | 'weekly' | 'monthly';
  priority: string;
  lastmod?: string;
}

// ---------------------------------------------------------------------------
// 1. Static pages
// ---------------------------------------------------------------------------

const staticPages: SitemapEntry[] = [
  { loc: '/', changefreq: 'daily', priority: '1.0' },
  { loc: '/blog', changefreq: 'weekly', priority: '0.9' },
  { loc: '/lex-news', changefreq: 'weekly', priority: '0.7' },
  { loc: '/investor', changefreq: 'monthly', priority: '0.6' },
  { loc: '/uk_investor', changefreq: 'monthly', priority: '0.6' },
  { loc: '/uk_investor_simplified', changefreq: 'monthly', priority: '0.6' },
  { loc: '/pitch-deck.html', changefreq: 'monthly', priority: '0.6' },
  { loc: '/developer/docs', changefreq: 'monthly', priority: '0.7' },
];

// ---------------------------------------------------------------------------
// 2. Data-source pages
// ---------------------------------------------------------------------------

const dataSourcePages: SitemapEntry[] = [
  '/us/data-sources', '/uk/data-sources', '/de/data-sources',
  '/fr/data-sources', '/nl/data-sources', '/ee/data-sources',
  '/ua/data-sources', '/eu/comparison',
].map(loc => ({ loc, changefreq: 'monthly' as const, priority: '0.6' }));

// ---------------------------------------------------------------------------
// 3. Legal pages (all slug + lang combos)
// ---------------------------------------------------------------------------

const legalSlugs = [
  'offer', 'terms', 'privacy', 'dpa', 'ai-usage', 'ai-transparency',
  'refund-policy', 'attorney-offer', 'developer-offer', 'marketplace-rules', 'api-terms',
];
const legalLangs = ['en', 'ua'];

const legalPages: SitemapEntry[] = [];
for (const slug of legalSlugs) {
  for (const lang of legalLangs) {
    legalPages.push({ loc: `/${lang}/${slug}`, changefreq: 'monthly', priority: '0.5' });
  }
}

// ---------------------------------------------------------------------------
// 4. Blog articles — extracted from articles.ts via regex
// ---------------------------------------------------------------------------

function extractArticles(articlesPath: string): SitemapEntry[] {
  const src = readFileSync(articlesPath, 'utf-8');

  // Match id and publishedAt pairs from article objects.
  // The regex captures id: '...' lines followed (eventually) by publishedAt: '...' lines
  // within the same object literal.
  const idRegex = /id:\s*'([^']+)'/g;
  const dateRegex = /publishedAt:\s*'([^']+)'/g;

  const ids: string[] = [];
  const dates: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(src)) !== null) ids.push(m[1]);
  while ((m = dateRegex.exec(src)) !== null) dates.push(m[1]);

  if (ids.length !== dates.length) {
    console.warn(
      `[sitemap] Warning: found ${ids.length} article IDs but ${dates.length} dates. Using min count.`
    );
  }

  const count = Math.min(ids.length, dates.length);
  const entries: SitemapEntry[] = [];

  for (let i = 0; i < count; i++) {
    entries.push({
      loc: `/blog/${ids[i]}`,
      changefreq: 'monthly',
      priority: '0.8',
      lastmod: dates[i],
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// 5. Generate XML
// ---------------------------------------------------------------------------

function generateXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map(e => {
      const parts = [
        `    <loc>${BASE_URL}${e.loc}</loc>`,
        e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
        `    <changefreq>${e.changefreq}</changefreq>`,
        `    <priority>${e.priority}</priority>`,
      ].filter(Boolean);
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------

export function generateSitemap(rootDir?: string): string {
  const root = rootDir ?? resolve(__dirname, '..');
  const articlesPath = resolve(root, 'src/pages/BlogPage/articles.ts');
  const blogArticles = extractArticles(articlesPath);

  console.log(`[sitemap] Found ${blogArticles.length} blog articles`);

  const allEntries = [
    ...staticPages,
    ...blogArticles,
    ...legalPages,
    ...dataSourcePages,
  ];

  return generateXml(allEntries);
}

// When executed directly (not imported as a module by Vite plugin)
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('generate-sitemap.ts') || process.argv[1].endsWith('generate-sitemap.js'));

if (isDirectRun) {
  const root = resolve(__dirname, '..');
  const xml = generateSitemap(root);
  const outputPath = resolve(root, 'public/sitemap.xml');
  writeFileSync(outputPath, xml);
  console.log(`[sitemap] Written to ${outputPath} (${xml.length} bytes)`);
}
