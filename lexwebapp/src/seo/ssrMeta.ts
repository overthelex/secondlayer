/**
 * Build-time meta capture for static prerendering (scripts/prerender-pages.ts).
 *
 * In the browser, useDocumentMeta / useHreflang write tags into <head> from
 * effects. Effects never run under react-dom/server, so during prerender the
 * hooks record their arguments here instead, and the prerender script writes
 * them into the static HTML. One source of truth for both paths.
 */

export interface SsrDocumentMeta {
  title: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogUrl?: string;
  ogLocale?: string;
  canonical?: string;
}

export interface SsrHreflangEntry {
  lang: string;
  href: string;
}

export interface SsrMetaState {
  meta?: SsrDocumentMeta;
  hreflang?: SsrHreflangEntry[];
  hreflangDefault?: string;
}

export const ssrMeta: SsrMetaState = {};

export function resetSsrMeta(): void {
  delete ssrMeta.meta;
  delete ssrMeta.hreflang;
  delete ssrMeta.hreflangDefault;
}
