import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seoCheck } from '../../../scripts/seo/seo-check';
import { writeSitemaps } from '../../../scripts/seo/sitemap';
import { applyMeta } from '../../../scripts/seo/html';

const SHELL = '<!doctype html><html lang="uk"><head><title>Shell</title><link rel="canonical" href="https://legal.org.ua" /></head><body><div id="root"></div></body></html>';

function page(dir: string, urlPath: string, html: string) {
  const d = path.join(dir, urlPath.replace(/^\//, ''));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), html);
}

function good(urlPath: string, lang = 'uk', hreflang?: Array<{ lang: string; href: string }>) {
  return applyMeta(SHELL, { title: `T ${urlPath}`, canonical: `https://legal.org.ua${urlPath}`, ogLocale: 'uk_UA', htmlLang: lang, hreflang });
}

describe('seoCheck', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'));
    fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports sitemap URLs that would fall back to the shell or point canonical elsewhere', () => {
    writeSitemaps(dir, [{ id: 'post', publishedAt: '2026-11-01', langs: ['uk', 'en'] }]);
    const { errors } = seoCheck(dir);
    expect(errors.some(e => e.startsWith('/blog/post: no prerendered HTML'))).toBe(true);

    page(dir, '/blog/uk/post', applyMeta(SHELL, { title: 'X', canonical: 'https://legal.org.ua', ogLocale: 'uk_UA', htmlLang: 'uk' }));
    expect(seoCheck(dir).errors).toContain('/blog/uk/post: canonical is https://legal.org.ua');
  });

  it('passes when every listed URL has its own page, and flags dangling hreflang', () => {
    writeSitemaps(dir, [{ id: 'post', publishedAt: '2026-11-01', langs: ['uk'] }]);
    const sections = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-legal.xml']
      .flatMap(f => [...fs.readFileSync(path.join(dir, f), 'utf-8').matchAll(/<loc>https:\/\/legal\.org\.ua([^<]*)<\/loc>/g)].map(m => m[1] || '/'));
    for (const p of sections) if (p !== '/') page(dir, p, good(p));
    expect(seoCheck(dir).errors).toEqual([]);

    page(dir, '/blog/uk/post', good('/blog/uk/post', 'uk', [{ lang: 'en', href: 'https://legal.org.ua/blog/post' }]));
    expect(seoCheck(dir).errors).toContain('/blog/uk/post: hreflang points at /blog/post, which has no page');
  });
});
