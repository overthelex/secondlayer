/**
 * HTML for /praktyka-vs: the most cited постанови of the Supreme Court's
 * cassation courts. Official ЄДРСР text only; the added value is structure,
 * the code articles applied and links between published decisions.
 */
import { SITE, esc, uaDate, truncate, page, BONUS_NOTE, type Crumb } from './seo-page.js';
import { ZAKON_CODES, articleSlug } from './zakon-codes.js';
import type { VpArticle } from './vp-repository.js';
import {
  CASSATION_COURT_INFO, COURT_BY_CODE,
  type CassationDecision, type CassationListItem, type LinkedDecision,
} from './cassation-repository.js';
import { parseVpText, leadText } from './vp-text.js';

const SOURCE = 'Тексти постанов: Єдиний державний реєстр судових рішень (reyestr.court.gov.ua), персональні дані знеособлено в реєстрі. Текст наведено без змін. Кількість посилань підраховано за текстами рішень у ЄДРСР.';
const ROOT: Crumb[] = [{ name: 'LEX', href: '/product' }, { name: 'Практика Верховного Суду', href: '/praktyka-vs' }];
const CODE_BY_NREG = new Map(ZAKON_CODES.map(c => [c.nreg, c]));
const nf = new Intl.NumberFormat('uk-UA');

const courtName = (code: number) => COURT_BY_CODE.get(code)?.name ?? 'Касаційний суд';
const courtAbbr = (code: number) => COURT_BY_CODE.get(code)?.abbr ?? 'ВС';

export const cassationTitle = (d: { courtCode: number; date: string; causeNum: string }) =>
  `Постанова Верховного Суду (${courtName(d.courtCode)}) від ${uaDate(d.date)} у справі № ${d.causeNum}`;

/** «на справу посилаються 1 234 рішення» with the right plural form. */
export function citedByText(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'рішення' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'рішення' : 'рішень';
  const verb = m10 === 1 && m100 !== 11 ? 'посилається' : 'посилаються';
  return `${verb} ${nf.format(n)} ${word}`;
}

export function cassationListHtml(items: CassationListItem[], withCourt = true): string {
  return `<ul class="toc">${items.map(i =>
    `<li><a href="/praktyka-vs/${esc(i.slug)}">${uaDate(i.date)}, справа № ${esc(i.causeNum)}</a>${withCourt ? ` · ${esc(courtAbbr(i.courtCode))}` : ''}${i.category ? ` · ${esc(i.category)}` : ''} · ${esc(citedByText(i.citedBy))}</li>`).join('')}</ul>`;
}

function linkedListHtml(items: LinkedDecision[]): string {
  return `<ul class="toc">${items.map(i =>
    `<li><a href="${esc(i.href)}">${i.court === 'vp' ? 'ВП ВС' : esc(courtAbbr(i.court))}, ${uaDate(i.date)}, справа № ${esc(i.causeNum)}</a></li>`).join('')}</ul>`;
}

function articleLinks(arts: VpArticle[]): string {
  const links = arts
    .map(a => ({ a, code: CODE_BY_NREG.get(a.nreg) }))
    .filter(x => x.code)
    .map(({ a, code }) => `<a href="/zakon/${code!.slug}/${articleSlug(a.artNo)}">ст. ${esc(a.artNo)} ${esc(code!.articleRef)}</a>`);
  return links.length ? `<p class="path">Застосовані норми: ${links.join(', ')}</p>` : '';
}

export interface CassationLinks { cites: LinkedDecision[]; citedBy: { total: number; items: LinkedDecision[] } }

export function renderCassationDecision(d: CassationDecision, arts: VpArticle[], links: CassationLinks): string {
  const doc = parseVpText(d.fullText);
  const path = `/praktyka-vs/${d.slug}`;
  const h1 = cassationTitle(d);
  const jump = [
    doc.reasoningAt !== null ? '<a href="#pozytsiia">Позиція Верховного Суду</a>' : '',
    doc.resolutiveAt !== null ? '<a href="#postanovyla">Резолютивна частина</a>' : '',
    links.citedBy.items.length ? '<a href="#tsytuiut">Цитують</a>' : '',
    links.cites.length ? '<a href="#posylaietsia">Посилається на</a>' : '',
  ].filter(Boolean).join(' · ');
  const body = doc.blocks.map(b => b.kind === 'heading'
    ? `<h2${b.id ? ` id="${b.id}"` : ''}>${esc(b.text)}</h2>`
    : `<p>${esc(b.text)}</p>`).join('\n');
  const lead = leadText(doc);
  const court = d.courtSlug
    ? `<a href="/sud/${esc(d.courtSlug)}">${esc(courtName(d.courtCode))}</a>`
    : esc(courtName(d.courtCode));
  const citedBy = links.citedBy.items.length
    ? `<section><h2 id="tsytuiut">Цитують цю справу</h2>
<p class="meta">Опубліковані на LEX постанови Верховного Суду, що посилаються на справу № ${esc(d.causeNum)}${links.citedBy.total > links.citedBy.items.length ? ` (${links.citedBy.items.length} з ${nf.format(links.citedBy.total)}, новіші)` : ''}.</p>
${linkedListHtml(links.citedBy.items)}</section>`
    : '';
  const cites = links.cites.length
    ? `<section><h2 id="posylaietsia">Посилається на</h2>
<p class="meta">Постанови Верховного Суду на LEX у справах, на які посилається це рішення.</p>
${linkedListHtml(links.cites)}</section>`
    : '';
  return page({
    title: `Постанова ${courtAbbr(d.courtCode)} від ${uaDate(d.date)}, справа № ${truncate(d.causeNum, 40)} | LEX`,
    description: truncate(`${h1}.${d.category ? ` ${d.category}.` : ''} ${lead}`.trim(), 300),
    path,
    crumbs: [...ROOT, { name: d.date.slice(0, 4), href: `/praktyka-vs/rik-${d.date.slice(0, 4)}` }, { name: `Справа № ${d.causeNum}`, href: path }],
    source: SOURCE,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: h1,
      datePublished: d.date,
      inLanguage: 'uk',
      url: SITE + path,
      author: { '@type': 'GovernmentOrganization', name: `Верховний Суд, ${courtName(d.courtCode)}`, url: 'https://supreme.court.gov.ua' },
      ...(d.category ? { about: d.category } : {}),
      sameAs: `https://reyestr.court.gov.ua/Review/${d.docId}`,
    }],
    body: `<h1>${esc(h1)}</h1>
<p class="meta">${court} · ${d.category ? `${esc(d.category)} · ` : ''}${d.judge ? `суддя-доповідач ${esc(d.judge)} · ` : ''}<a href="https://reyestr.court.gov.ua/Review/${esc(d.docId)}" rel="nofollow noopener">текст у ЄДРСР</a></p>
<p class="meta">На справу № ${esc(d.causeNum)} ${esc(citedByText(d.citedBy))} у ЄДРСР.</p>
${articleLinks(arts)}
${jump ? `<p class="meta">${jump}</p>` : ''}
${doc.header.length ? `<div class="text">${doc.header.map(l => `<p class="note">${esc(l)}</p>`).join('')}</div>` : ''}
<div class="text">
${body}
</div>
${citedBy}
${cites}
<section class="cta"><h2>Схожа практика в LEX</h2><p>LEX знаходить постанови Верховного Суду з тих самих питань, показує, чи не відступили від висновку пізніше, і дає посилання на тексти рішень.</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a><p class="meta">${esc(BONUS_NOTE)}</p></section>`,
  });
}

export function renderCassationIndex(
  years: Array<{ year: number; count: number }>,
  courts: Array<{ courtCode: number; count: number }>,
  top: Map<number, CassationListItem[]>,
): string {
  const total = years.reduce((a, y) => a + y.count, 0);
  const counts = new Map(courts.map(c => [c.courtCode, c.count]));
  const sections = CASSATION_COURT_INFO
    .filter(c => (top.get(c.code) ?? []).length)
    .map(c => `<h2>${esc(c.name)} · ${nf.format(counts.get(c.code) ?? 0)}</h2>\n${cassationListHtml(top.get(c.code)!, false)}`)
    .join('\n');
  return page({
    title: 'Найцитованіші постанови касаційних судів Верховного Суду | LEX',
    description: `${nf.format(total)} постанов КЦС, КГС, КАС і ККС Верховного Суду, на які найчастіше посилаються суди: повні тексти з ЄДРСР, застосовані статті кодексів, зв'язки між рішеннями.`,
    path: '/praktyka-vs',
    crumbs: ROOT,
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Практика Верховного Суду: найцитованіші постанови касаційних судів</h1>
<p class="meta">${nf.format(total)} постанов Касаційного цивільного, господарського, адміністративного й кримінального судів у складі Верховного Суду, відібраних за кількістю судових рішень у ЄДРСР, що посилаються на справу. Суди враховують висновки Верховного Суду щодо застосування норм права (ч. 4 ст. 263 ЦПК, ч. 4 ст. 236 ГПК, ч. 5 ст. 242 КАС). Постанови Великої Палати зібрано окремо: <a href="/pozytsiia-vs">постанови ВП ВС</a>.</p>
<h2>За роками</h2>
<ul class="toc">${years.map(y => `<li><a href="/praktyka-vs/rik-${y.year}">${y.year}</a> · ${y.count}</li>`).join('')}</ul>
${sections}`,
  });
}

export function renderCassationYear(year: number, items: CassationListItem[]): string {
  const path = `/praktyka-vs/rik-${year}`;
  return page({
    title: `Найцитованіші постанови касаційних судів ВС за ${year} рік (${items.length}) | LEX`,
    description: `${items.length} постанов КЦС, КГС, КАС і ККС Верховного Суду за ${year} рік, на які найчастіше посилаються суди: повні тексти, номер справи, категорія.`,
    path,
    crumbs: [...ROOT, { name: String(year), href: path }],
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Найцитованіші постанови касаційних судів Верховного Суду за ${year} рік</h1>
<p class="meta">${items.length} постанов, від найцитованіших.</p>
${cassationListHtml(items)}`,
  });
}
