/**
 * Build guard: every URL in the sitemap must ship its own prerendered HTML
 * with a self-referencing canonical, its own <title> and <html lang>, and
 * hreflang links that point at pages which exist. Any violation fails the
 * build (vite.config.ts seoCheckPlugin), so a page can no longer silently
 * fall back to the SPA shell and canonicalise to the homepage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL } from './html';

function fileFor(distDir: string, urlPath: string): string {
  const rel = urlPath.replace(/^\//, '');
  return rel === '' ? path.join(distDir, 'index.html') : path.join(distDir, rel, 'index.html');
}

function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
}

export function seoCheck(distDir: string): { checked: number; errors: string[] } {
  const shell = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
  const shellTitle = shell.match(/<title>([^<]*)<\/title>/)?.[1];
  const index = fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf-8');
  const sitemapFiles = locsOf(index).map(u => path.join(distDir, u.replace(BASE_URL + '/', '')));

  const errors: string[] = [];
  const urls: string[] = [];
  for (const f of sitemapFiles) {
    if (!fs.existsSync(f)) { errors.push(`sitemap index lists missing file ${path.basename(f)}`); continue; }
    urls.push(...locsOf(fs.readFileSync(f, 'utf-8')));
  }
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) { errors.push(`${url}: listed twice`); continue; }
    seen.add(url);
    if (!url.startsWith(BASE_URL)) { errors.push(`${url}: not under ${BASE_URL}`); continue; }
    const urlPath = url.slice(BASE_URL.length) || '/';
    const file = fileFor(distDir, urlPath);
    if (!fs.existsSync(file)) { errors.push(`${urlPath}: no prerendered HTML (would serve the SPA shell)`); continue; }
    const html = fs.readFileSync(file, 'utf-8');

    const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
    const want = urlPath === '/' ? [BASE_URL, `${BASE_URL}/`] : [url];
    if (!canonical || !want.includes(canonical)) errors.push(`${urlPath}: canonical is ${canonical ?? 'missing'}`);

    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    if (!title) errors.push(`${urlPath}: no <title>`);
    else if (urlPath !== '/' && title === shellTitle) errors.push(`${urlPath}: still has the shell <title>`);

    if (!/<html lang="(uk|en|ru)"/.test(html)) errors.push(`${urlPath}: <html lang> missing or unexpected`);
    if (/<meta name="robots" content="[^"]*noindex/.test(html)) errors.push(`${urlPath}: in sitemap but noindex`);

    for (const m of html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)"/g)) {
      const alt = m[1];
      if (!alt.startsWith(BASE_URL)) continue;
      const altPath = alt.slice(BASE_URL.length) || '/';
      if (!fs.existsSync(fileFor(distDir, altPath))) errors.push(`${urlPath}: hreflang points at ${altPath}, which has no page`);
    }
  }
  return { checked: seen.size, errors };
}
