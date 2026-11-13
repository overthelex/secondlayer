/**
 * HTML for the public /zakon pages. Server-rendered, no client JS, Ukrainian.
 * Every interpolated value goes through esc().
 */
import { ZAKON_CODES, articleSlug, type ZakonCode } from './zakon-codes.js';
import type { CodeData } from './zakon-repository.js';
import type { Heading, ParsedArticle } from './zakon-text.js';
import { sentenceCase } from './zakon-text.js';

export const SITE = 'https://legal.org.ua';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON for a <script type="application/ld+json"> block (no "</script>" breakout). */
function ldJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function uaDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function radaUrl(code: ZakonCode): string {
  return `https://zakon.rada.gov.ua/laws/show/${encodeURIComponent(code.nreg)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).replace(/[\s,;:.–-]+$/, '') + '…';
}

interface Crumb { name: string; href: string }

function breadcrumbLd(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: SITE + c.href })),
  };
}

const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#1d4ed8;--accent-fg:#fff;--note:#78716c;--warn-bg:#fef3c7;--warn-fg:#78350f}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--accent-fg:#0c0a09;--note:#a8a29e;--warn-bg:#422006;--warn-fg:#fde68a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}header,main,footer{max-width:820px;margin:0 auto;padding:0 16px}
header{display:flex;justify-content:space-between;align-items:center;padding-top:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}
header .logo{font-weight:700;text-decoration:none;color:var(--fg);letter-spacing:.02em}header nav a{margin-left:16px;font-size:15px}
nav.crumbs{font-size:14px;color:var(--muted);margin:20px 0 8px}nav.crumbs a{color:var(--muted)}
h1{font-size:1.6rem;line-height:1.3;margin:8px 0 12px}h2{font-size:1.15rem;margin:28px 0 8px}h3{font-size:1.02rem;margin:20px 0 6px}h4{font-size:.95rem;margin:16px 0 4px;color:var(--muted)}
.meta{font-size:14px;color:var(--muted);margin-bottom:20px}.path{font-size:14px;color:var(--muted);margin:0 0 16px}
.text p{margin:0 0 12px}.text p.note{font-size:14px;color:var(--note);font-style:italic}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:12px 16px;border-radius:8px;margin:16px 0;font-size:15px}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:32px 0}
.cta h2{margin-top:0}.cta a.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}
.pager{display:flex;justify-content:space-between;gap:16px;margin:24px 0;font-size:15px}
ul.toc,ul.codes{list-style:none;padding:0;margin:0}ul.toc li{margin:4px 0}ul.codes li{padding:12px 0;border-bottom:1px solid var(--line)}
footer{font-size:13px;color:var(--muted);padding-top:24px;padding-bottom:40px;border-top:1px solid var(--line);margin-top:40px}
`;

interface PageOpts {
  title: string;
  description: string;
  path: string;
  crumbs: Crumb[];
  jsonLd: unknown[];
  body: string;
}

function page(o: PageOpts): string {
  const canonical = SITE + o.path;
  const crumbsHtml = o.crumbs
    .map((c, i) => (i === o.crumbs.length - 1 ? esc(c.name) : `<a href="${esc(c.href)}">${esc(c.name)}</a>`))
    .join(' › ');
  const ld = [breadcrumbLd(o.crumbs), ...o.jsonLd].map(j => `<script type="application/ld+json">${ldJson(j)}</script>`).join('\n');
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="LEX">
<meta property="og:locale" content="uk_UA">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/og-image.png">
<link rel="icon" href="/icon-192x192.png" type="image/png">
<style>${CSS}</style>
${ld}
</head>
<body>
<header><a class="logo" href="/product">LEX</a><nav><a href="/zakon">Кодекси</a><a href="/blog/uk">Блог</a><a href="/login">Увійти</a></nav></header>
<main>
<nav class="crumbs" aria-label="Навігація">${crumbsHtml}</nav>
${o.body}
</main>
<footer>Тексти наведено за офіційними даними Верховної Ради України (zakon.rada.gov.ua). Інформація не є юридичною консультацією. © LEX, legal.org.ua</footer>
</body>
</html>`;
}

const ROOT: Crumb[] = [{ name: 'LEX', href: '/product' }, { name: 'Кодекси України', href: '/zakon' }];

function repealedNote(code: ZakonCode, data: CodeData, repealed: boolean): string {
  if (!repealed) return '';
  return `<p class="warn">${esc(code.name)} втратив чинність. Нижче наведено текст останньої редакції від ${uaDate(data.edition.edDate)}.</p>`;
}

export function renderCodesIndex(): string {
  const items = ZAKON_CODES.map(c => `<li><a href="/zakon/${c.slug}">${esc(c.name)}</a></li>`).join('\n');
  return page({
    title: 'Кодекси України: актуальні тексти статей | LEX',
    description: 'Чинні редакції основних кодексів України: Конституція, ЦК, ЦПК, КК, КПК, ГПК, КАС, КЗпП, ПКУ, СК, ЗК, КУпАП. Текст кожної статті з навігацією за розділами й главами.',
    path: '/zakon',
    crumbs: ROOT,
    jsonLd: [],
    body: `<h1>Кодекси України</h1>
<p class="meta">Актуальні редакції за даними Верховної Ради України. Оберіть кодекс, щоб переглянути зміст і текст статей.</p>
<ul class="codes">${items}</ul>`,
  });
}

function headingTag(depth: number): string {
  return depth <= 1 ? 'h2' : depth === 2 ? 'h3' : 'h4';
}

export function renderCodeToc(code: ZakonCode, data: CodeData, repealed: boolean): string {
  const heads = new Map(data.index.map(a => [a.artNo, a.head]));
  const known = new Set(data.index.map(a => a.artNo));
  const parts: string[] = [];
  let open = false;
  let pendingHeadings: string[] = [];
  const close = () => { if (open) { parts.push('</ul>'); open = false; } };

  for (const e of data.structure.entries) {
    if (e.type === 'heading') {
      close();
      const tag = headingTag(e.depth);
      const t = e.heading.title ? `. ${esc(e.heading.title)}` : '';
      pendingHeadings.push(`<${tag}>${esc(e.heading.label)}${t}</${tag}>`);
      continue;
    }
    if (!known.has(e.artNo)) continue;
    // headings are emitted only once an article follows them (drops empty
    // headings such as "Прикінцеві положення" with no numbered articles)
    if (pendingHeadings.length) { parts.push(...pendingHeadings); pendingHeadings = []; }
    if (!open) { parts.push('<ul class="toc">'); open = true; }
    const head = heads.get(e.artNo) || '';
    const label = code.articleTitles ? head : truncate(head, 90);
    parts.push(`<li><a href="/zakon/${code.slug}/${articleSlug(e.artNo)}">Стаття ${esc(e.artNo)}</a>${label ? `. ${esc(label)}` : ''}</li>`);
  }
  close();

  // Articles the structure parser did not see (should not happen; keep them reachable).
  const seen = new Set(Object.keys(data.structure.pathByArt));
  const rest = data.index.filter(a => !seen.has(a.artNo));
  if (rest.length) {
    parts.push('<h2>Інші статті</h2><ul class="toc">');
    for (const a of rest) parts.push(`<li><a href="/zakon/${code.slug}/${articleSlug(a.artNo)}">Стаття ${esc(a.artNo)}</a>. ${esc(truncate(a.head, 90))}</li>`);
    parts.push('</ul>');
  }

  const path = `/zakon/${code.slug}`;
  return page({
    title: `${code.name}: зміст і текст статей, редакція від ${uaDate(data.edition.edDate)} | LEX`,
    description: `${code.name}: повний зміст за розділами й главами, ${data.index.length} статей. Чинна редакція від ${uaDate(data.edition.edDate)} за даними Верховної Ради України.`,
    path,
    crumbs: [...ROOT, { name: code.abbr, href: path }],
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Legislation',
      name: code.name,
      legislationIdentifier: code.nreg,
      legislationJurisdiction: 'UA',
      legislationLegalForce: repealed ? 'https://schema.org/NotInForce' : 'https://schema.org/InForce',
      inLanguage: 'uk',
      url: SITE + path,
      sameAs: radaUrl(code),
    }],
    body: `<h1>${esc(code.name)}</h1>
<p class="meta">Редакція від ${uaDate(data.edition.edDate)} · ${data.index.length} статей · <a href="${esc(radaUrl(code))}" rel="nofollow noopener">офіційний текст на zakon.rada.gov.ua</a></p>
${repealedNote(code, data, repealed)}
${parts.join('\n')}`,
  });
}

function pathLine(path: Heading[]): string {
  if (!path.length) return '';
  const txt = path.map(h => (h.title ? `${h.label}. ${h.title}` : h.label)).join(' › ');
  return `<p class="path">${esc(txt)}</p>`;
}

export function renderArticle(code: ZakonCode, data: CodeData, art: ParsedArticle, repealed: boolean): string {
  const i = data.index.findIndex(a => a.artNo === art.artNo);
  const prev = i > 0 ? data.index[i - 1] : null;
  const next = i >= 0 && i < data.index.length - 1 ? data.index[i + 1] : null;
  const ref = `Стаття ${art.artNo} ${code.articleRef}`;
  const title = art.title ? sentenceCase(art.title) : null;
  const h1 = title ? `${ref}. ${title}` : ref;
  const firstText = art.paragraphs.find(p => !p.note)?.text || '';
  const textHtml = art.paragraphs
    .map(p => (p.note ? `<p class="note">${esc(p.text)}</p>` : `<p>${esc(p.text)}</p>`))
    .join('\n');
  const codePath = `/zakon/${code.slug}`;
  const path = `${codePath}/${articleSlug(art.artNo)}`;
  const link = (a: { artNo: string }, rel: 'prev' | 'next') =>
    `<a rel="${rel}" href="${codePath}/${articleSlug(a.artNo)}">${rel === 'prev' ? '← ' : ''}Стаття ${esc(a.artNo)}${rel === 'next' ? ' →' : ''}</a>`;

  return page({
    title: `${truncate(h1, 95)} | LEX`,
    description: truncate(`${h1}. ${firstText}`, 160),
    path,
    crumbs: [...ROOT, { name: code.abbr, href: codePath }, { name: `Стаття ${art.artNo}`, href: path }],
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Legislation',
      name: h1,
      legislationIdentifier: `${code.nreg}, ст. ${art.artNo}`,
      legislationJurisdiction: 'UA',
      legislationLegalForce: repealed ? 'https://schema.org/NotInForce' : 'https://schema.org/InForce',
      inLanguage: 'uk',
      url: SITE + path,
      isPartOf: { '@type': 'Legislation', name: code.name, url: SITE + codePath },
    }],
    body: `<h1>${esc(h1)}</h1>
${pathLine(data.structure.pathByArt[art.artNo] || [])}
<p class="meta">${esc(code.name)} · редакція від ${uaDate(data.edition.edDate)} · <a href="${esc(radaUrl(code))}" rel="nofollow noopener">zakon.rada.gov.ua</a></p>
${repealedNote(code, data, repealed)}
<div class="text">
${textHtml}
</div>
<nav class="pager">${prev ? link(prev, 'prev') : '<span></span>'}<a href="${codePath}">Зміст ${esc(code.abbr)}</a>${next ? link(next, 'next') : '<span></span>'}</nav>
<section class="cta">
<h2>Судова практика за статтею ${esc(art.artNo)} ${esc(code.articleRef)}</h2>
<p>LEX знаходить рішення Верховного Суду та інших судів, які застосовують цю статтю, і пояснює правові позиції з посиланнями на джерела.</p>
<a class="btn" href="/login">Спробувати LEX безкоштовно</a>
</section>`,
  });
}

/** sitemap urlset for all /zakon pages (well under the 50k-URL limit for 13 codes). */
export function renderSitemap(entries: Array<{ path: string; lastmod: string }>): string {
  const urls = entries.map(e => `  <url><loc>${SITE}${esc(e.path)}</loc><lastmod>${e.lastmod}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
