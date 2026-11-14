/**
 * HTML for the public /zakon pages. Server-rendered, no client JS, Ukrainian.
 * Every interpolated value goes through esc().
 */
import { ZAKON_CODES, articleSlug, type ZakonCode } from './zakon-codes.js';
import type { CodeData } from './zakon-repository.js';
import type { Heading, ParsedArticle } from './zakon-text.js';
import { sentenceCase } from './zakon-text.js';
import { SITE, esc, uaDate, truncate, page, type Crumb } from './seo-page.js';
import { vpListHtml } from './vp-render.js';
import type { VpListItem } from './vp-repository.js';

export { SITE, esc } from './seo-page.js';

export function radaUrl(code: ZakonCode): string {
  return `https://zakon.rada.gov.ua/laws/show/${encodeURIComponent(code.nreg)}`;
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

export interface ArticleVp { total: number; items: VpListItem[] }

export function renderArticle(code: ZakonCode, data: CodeData, art: ParsedArticle, repealed: boolean, vp?: ArticleVp): string {
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
${vp && vp.total ? `<section>
<h2>Постанови Великої Палати ВС, що застосовують статтю ${esc(art.artNo)} ${esc(code.articleRef)}${vp.total > vp.items.length ? ` (${vp.total})` : ''}</h2>
${vpListHtml(vp.items)}
</section>` : ''}
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
