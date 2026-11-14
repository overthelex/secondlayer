/** HTML for /pozytsiia-vs: Grand Chamber decisions, official ЄДРСР text only. */
import { SITE, esc, uaDate, truncate, page, BONUS_NOTE, type Crumb } from './seo-page.js';
import { ZAKON_CODES, articleSlug } from './zakon-codes.js';
import type { VpDecision, VpListItem, VpArticle } from './vp-repository.js';
import { parseVpText, leadText } from './vp-text.js';

const SOURCE = 'Тексти постанов: Єдиний державний реєстр судових рішень (reyestr.court.gov.ua), персональні дані знеособлено в реєстрі. Текст наведено без змін.';
const ROOT: Crumb[] = [{ name: 'LEX', href: '/product' }, { name: 'Постанови Великої Палати ВС', href: '/pozytsiia-vs' }];
const CODE_BY_NREG = new Map(ZAKON_CODES.map(c => [c.nreg, c]));

export const vpTitle = (d: { date: string; causeNum: string }) =>
  `Постанова Великої Палати Верховного Суду від ${uaDate(d.date)} у справі № ${d.causeNum}`;

export function vpListHtml(items: VpListItem[]): string {
  return `<ul class="toc">${items.map(i =>
    `<li><a href="/pozytsiia-vs/${esc(i.slug)}">${uaDate(i.date)}, справа № ${esc(i.causeNum)}</a>${i.category ? ` · ${esc(i.category)}` : ''}</li>`).join('')}</ul>`;
}

function articleLinks(arts: VpArticle[]): string {
  const links = arts
    .map(a => ({ a, code: CODE_BY_NREG.get(a.nreg) }))
    .filter(x => x.code)
    .map(({ a, code }) => `<a href="/zakon/${code!.slug}/${articleSlug(a.artNo)}">ст. ${esc(a.artNo)} ${esc(code!.articleRef)}</a>`);
  return links.length ? `<p class="path">Застосовані норми: ${links.join(', ')}</p>` : '';
}

export function renderVpDecision(d: VpDecision, arts: VpArticle[]): string {
  const doc = parseVpText(d.fullText);
  const path = `/pozytsiia-vs/${d.slug}`;
  const h1 = vpTitle(d);
  const jump = [
    doc.reasoningAt !== null ? '<a href="#pozytsiia">Позиція Великої Палати</a>' : '',
    doc.resolutiveAt !== null ? '<a href="#postanovyla">Резолютивна частина</a>' : '',
  ].filter(Boolean).join(' · ');
  const body = doc.blocks.map(b => b.kind === 'heading'
    ? `<h2${b.id ? ` id="${b.id}"` : ''}>${esc(b.text)}</h2>`
    : `<p>${esc(b.text)}</p>`).join('\n');
  const lead = leadText(doc);
  return page({
    title: `Постанова ВП ВС від ${uaDate(d.date)}, справа № ${truncate(d.causeNum, 40)} | LEX`,
    description: truncate(`${h1}.${d.category ? ` ${d.category}.` : ''} ${lead}`, 300),
    path,
    crumbs: [...ROOT, { name: d.date.slice(0, 4), href: `/pozytsiia-vs/rik-${d.date.slice(0, 4)}` }, { name: `Справа № ${d.causeNum}`, href: path }],
    source: SOURCE,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: h1,
      datePublished: d.date,
      inLanguage: 'uk',
      url: SITE + path,
      author: { '@type': 'GovernmentOrganization', name: 'Верховний Суд', url: 'https://supreme.court.gov.ua' },
      ...(d.category ? { about: d.category } : {}),
      sameAs: `https://reyestr.court.gov.ua/Review/${d.docId}`,
    }],
    body: `<h1>${esc(h1)}</h1>
<p class="meta">${d.category ? `${esc(d.category)} · ` : ''}${d.judge ? `суддя-доповідач ${esc(d.judge)} · ` : ''}<a href="https://reyestr.court.gov.ua/Review/${esc(d.docId)}" rel="nofollow noopener">текст у ЄДРСР</a></p>
${articleLinks(arts)}
${jump ? `<p class="meta">${jump}</p>` : ''}
${doc.header.length ? `<div class="text">${doc.header.map(l => `<p class="note">${esc(l)}</p>`).join('')}</div>` : ''}
<div class="text">
${body}
</div>
<section class="cta"><h2>Схожа практика в LEX</h2><p>LEX знаходить постанови Верховного Суду з тих самих питань, показує, чи не відступили від висновку пізніше, і дає посилання на тексти рішень.</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a><p class="meta">${esc(BONUS_NOTE)}</p></section>`,
  });
}

export function renderVpIndex(years: Array<{ year: number; count: number }>, latest: VpListItem[]): string {
  const total = years.reduce((a, y) => a + y.count, 0);
  return page({
    title: 'Постанови Великої Палати Верховного Суду: тексти й правові позиції | LEX',
    description: `${total} постанов Великої Палати Верховного Суду з 2018 року: повні тексти з ЄДРСР, позиція ВП та застосовані статті кодексів. Пошук за роками.`,
    path: '/pozytsiia-vs',
    crumbs: ROOT,
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Постанови Великої Палати Верховного Суду</h1>
<p class="meta">${total} постанов з повним текстом. Суди враховують висновки Верховного Суду щодо застосування норм права (ч. 4 ст. 263 ЦПК, ч. 4 ст. 236 ГПК, ч. 5 ст. 242 КАС).</p>
<h2>За роками</h2>
<ul class="toc">${years.map(y => `<li><a href="/pozytsiia-vs/rik-${y.year}">${y.year}</a> · ${y.count}</li>`).join('')}</ul>
<h2>Нові постанови</h2>
${vpListHtml(latest)}`,
  });
}

export function renderVpYear(year: number, items: VpListItem[]): string {
  const path = `/pozytsiia-vs/rik-${year}`;
  return page({
    title: `Постанови Великої Палати ВС за ${year} рік (${items.length}) | LEX`,
    description: `Усі ${items.length} постанов Великої Палати Верховного Суду за ${year} рік з повними текстами: дата, номер справи, категорія.`,
    path,
    crumbs: [...ROOT, { name: String(year), href: path }],
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Постанови Великої Палати Верховного Суду за ${year} рік</h1>
<p class="meta">${items.length} постанов, від нових до старіших.</p>
${vpListHtml(items)}`,
  });
}
