/**
 * SSR entry used only by scripts/prerender-pages.ts (loaded through Vite's
 * ssrLoadModule, never bundled into the client). Renders a public page to
 * static HTML and returns the meta the page's own hooks declared.
 */
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { Routes, Route } from 'react-router-dom';
import { ssrMeta, resetSsrMeta, type SsrMetaState } from './ssrMeta';

export interface PrerenderRoute {
  /** Concrete URL path written to dist (e.g. /ua/terms). */
  path: string;
  /** Route pattern the component expects (e.g. /:lang/terms). */
  pattern: string;
  /** <html lang> for the static page. */
  lang: 'uk' | 'en';
  load: () => Promise<ComponentType>;
}

const LEGAL_PAGES: Array<{ slug: string; hasEn: boolean; load: () => Promise<ComponentType> }> = [
  { slug: 'offer', hasEn: true, load: () => import('../pages/OfferPage').then(m => m.OfferPage) },
  { slug: 'attorney-offer', hasEn: true, load: () => import('../pages/AttorneyOfferPage').then(m => m.AttorneyOfferPage) },
  { slug: 'developer-offer', hasEn: true, load: () => import('../pages/DeveloperOfferPage').then(m => m.DeveloperOfferPage) },
  { slug: 'marketplace-rules', hasEn: true, load: () => import('../pages/MarketplaceRulesPage').then(m => m.MarketplaceRulesPage) },
  { slug: 'terms', hasEn: true, load: () => import('../pages/TermsPage').then(m => m.TermsPage) },
  { slug: 'privacy', hasEn: true, load: () => import('../pages/PrivacyPolicyPage').then(m => m.PrivacyPolicyPage) },
  { slug: 'dpa', hasEn: true, load: () => import('../pages/DpaPage').then(m => m.DpaPage) },
  { slug: 'ai-usage', hasEn: true, load: () => import('../pages/AiUsagePolicyPage').then(m => m.AiUsagePolicyPage) },
  { slug: 'ai-transparency', hasEn: true, load: () => import('../pages/AiTransparencyPage').then(m => m.AiTransparencyPage) },
  { slug: 'refund-policy', hasEn: true, load: () => import('../pages/RefundPolicyPage').then(m => m.RefundPolicyPage) },
  { slug: 'api-terms', hasEn: true, load: () => import('../pages/ApiTermsPage').then(m => m.ApiTermsPage) },
  { slug: 'aup', hasEn: false, load: () => import('../pages/AupPage').then(m => m.AupPage) },
];

const DATA_SOURCE_PAGES: Array<{ path: string; lang: 'uk' | 'en'; load: () => Promise<ComponentType> }> = [
  { path: '/data-sources', lang: 'en', load: () => import('../pages/DataSourcesPage').then(m => m.DataSourcesPage) },
  { path: '/us/data-sources', lang: 'en', load: () => import('../pages/USDataSourcesPage').then(m => m.USDataSourcesPage) },
  { path: '/uk/data-sources', lang: 'en', load: () => import('../pages/UKDataSourcesPage').then(m => m.UKDataSourcesPage) },
  { path: '/de/data-sources', lang: 'en', load: () => import('../pages/DEDataSourcesPage').then(m => m.DEDataSourcesPage) },
  { path: '/fr/data-sources', lang: 'en', load: () => import('../pages/FRDataSourcesPage').then(m => m.FRDataSourcesPage) },
  { path: '/nl/data-sources', lang: 'en', load: () => import('../pages/NLDataSourcesPage').then(m => m.NLDataSourcesPage) },
  { path: '/ee/data-sources', lang: 'en', load: () => import('../pages/EEDataSourcesPage').then(m => m.EEDataSourcesPage) },
  { path: '/ua/data-sources', lang: 'uk', load: () => import('../pages/UADataSourcesPage').then(m => m.UADataSourcesPage) },
  { path: '/eu/comparison', lang: 'en', load: () => import('../pages/EUComparisonPage').then(m => m.EUComparisonPage) },
];

export const PRERENDER_ROUTES: PrerenderRoute[] = [
  ...LEGAL_PAGES.flatMap(p => [
    { path: `/ua/${p.slug}`, pattern: `/:lang/${p.slug}`, lang: 'uk' as const, load: p.load },
    ...(p.hasEn ? [{ path: `/en/${p.slug}`, pattern: `/:lang/${p.slug}`, lang: 'en' as const, load: p.load }] : []),
  ]),
  ...DATA_SOURCE_PAGES.map(p => ({ ...p, pattern: p.path })),
];

export async function renderRoute(route: PrerenderRoute): Promise<{ html: string; meta: SsrMetaState }> {
  const Page = await route.load();
  resetSsrMeta();
  const html = renderToString(
    <StaticRouter location={route.path}>
      <Routes>
        <Route path={route.pattern} element={<Page />} />
      </Routes>
    </StaticRouter>,
  );
  return { html, meta: { ...ssrMeta } };
}
