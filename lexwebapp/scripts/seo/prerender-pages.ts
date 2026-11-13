/**
 * Post-build static prerender for public React pages that have no dedicated
 * prerender plugin (legal documents, data-source catalogues).
 *
 * Without this, nginx serves the bare SPA shell for these URLs: generic title
 * and canonical=https://legal.org.ua, so Google folds them into the homepage.
 *
 * Runs from vite.config.ts (prerenderPagesPlugin) after the client bundle is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { applyMeta, injectRoot, BASE_URL, OG_LOCALE } from './html';

/**
 * Renders every route in src/seo/prerender-entry.tsx into distDir.
 * Throws if any page fails, so the build fails instead of shipping a shell.
 */
export async function prerenderPages(root: string, distDir: string): Promise<number> {
  const shell = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(root, 'src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  let written = 0;
  const failures: string[] = [];
  try {
    const entry = await vite.ssrLoadModule('/src/seo/prerender-entry.tsx');
    for (const route of entry.PRERENDER_ROUTES) {
      try {
        const { html, meta } = await entry.renderRoute(route);
        if (!meta.meta?.title) throw new Error('page did not call useDocumentMeta');
        if (!html || html.length < 200) throw new Error(`rendered markup too short (${html.length} chars)`);
        const m = meta.meta;
        const page = injectRoot(applyMeta(shell, {
          title: m.title,
          description: m.description,
          ogTitle: m.ogTitle,
          ogDescription: m.ogDescription,
          ogImage: m.ogImage,
          canonical: m.canonical || `${BASE_URL}${route.path}`,
          ogLocale: m.ogLocale || OG_LOCALE[route.lang],
          htmlLang: route.lang,
          hreflang: meta.hreflang,
          hreflangDefault: meta.hreflangDefault,
        }), html);
        const outDir = path.join(distDir, route.path.replace(/^\//, ''));
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'index.html'), page);
        written++;
      } catch (err) {
        failures.push(`${route.path}: ${(err as Error).message}`);
      }
    }
  } finally {
    await vite.close();
  }

  if (failures.length) {
    throw new Error(`[prerender-pages] ${failures.length} page(s) failed:\n  ${failures.join('\n  ')}`);
  }
  return written;
}
