/** Helpers that write page meta into the built index.html shell. */

export const BASE_URL = 'https://legal.org.ua';

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface PageMeta {
  title: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  canonical: string;
  ogLocale: string;
  htmlLang: string;
  hreflang?: Array<{ lang: string; href: string }>;
  hreflangDefault?: string;
  robots?: string;
}

function setTag(html: string, re: RegExp, tag: string): string {
  if (re.test(html)) return html.replace(re, tag);
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

export function applyMeta(shell: string, m: PageMeta): string {
  const ogTitle = m.ogTitle || m.title;
  const desc = m.description || '';
  const ogDesc = m.ogDescription || desc;
  let h = shell.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(m.title)}</title>`);
  h = h.replace(/<html lang="[^"]*"/, `<html lang="${m.htmlLang}"`);
  h = setTag(h, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escapeAttr(desc)}" />`);
  h = setTag(h, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeAttr(ogTitle)}" />`);
  h = setTag(h, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeAttr(ogDesc)}" />`);
  h = setTag(h, /<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${m.canonical}" />`);
  h = setTag(h, /<meta property="og:locale" content="[^"]*"\s*\/?>/, `<meta property="og:locale" content="${m.ogLocale}" />`);
  h = setTag(h, /<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${escapeAttr(ogTitle)}" />`);
  h = setTag(h, /<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${escapeAttr(ogDesc)}" />`);
  if (m.ogImage) {
    h = setTag(h, /<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${m.ogImage}" />`);
    h = setTag(h, /<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${m.ogImage}" />`);
  }
  h = setTag(h, /<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${m.canonical}" />`);
  if (m.robots) {
    h = setTag(h, /<meta name="robots" content="[^"]*"\s*\/?>/, `<meta name="robots" content="${m.robots}" />`);
  }
  if (m.hreflang?.length) {
    const links = m.hreflang.map(e => `<link rel="alternate" hreflang="${e.lang}" href="${e.href}" />`);
    const def = m.hreflang.find(e => e.lang === (m.hreflangDefault || 'uk'));
    if (def) links.push(`<link rel="alternate" hreflang="x-default" href="${def.href}" />`);
    h = h.replace('</head>', `    ${links.join('\n    ')}\n  </head>`);
  }
  return h;
}

/** Put server-rendered markup inside #root; createRoot() replaces it on boot. */
export function injectRoot(html: string, markup: string): string {
  return html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
}

export const OG_LOCALE: Record<string, string> = { uk: 'uk_UA', en: 'en_US', ru: 'ru_RU' };
