/** HTML for /advokaty (lists) and /advokat (one advocate). Public ЄРАУ data only. */
import { SITE, esc, uaDate, page, BONUS_NOTE, type Crumb } from './seo-page.js';
import { slugify } from './translit.js';
import type { Advocate, AdvocateLink } from './advocates-repository.js';

const SOURCE = 'Дані: Єдиний реєстр адвокатів України (відкриті дані НААУ, data.gov.ua).';
const REMOVAL_EMAIL = 'info@legal.org.ua';
const ROOT: Crumb[] = [{ name: 'LEX', href: '/product' }, { name: 'Адвокати України', href: '/advokaty' }];

/** First-letter slugs; distinct for every Ukrainian letter (і/ї/й would collide under KMU-2010). */
const LETTER: Record<string, string> = {
  А: 'a', Б: 'b', В: 'v', Г: 'h', Ґ: 'g', Д: 'd', Е: 'e', Є: 'ye', Ж: 'zh', З: 'z', И: 'y', І: 'i', Ї: 'yi', Й: 'j',
  К: 'k', Л: 'l', М: 'm', Н: 'n', О: 'o', П: 'p', Р: 'r', С: 's', Т: 't', У: 'u', Ф: 'f', Х: 'kh', Ц: 'ts', Ч: 'ch',
  Ш: 'sh', Щ: 'shch', Ь: 'mz', Ю: 'yu', Я: 'ya',
};
const LETTER_BY_SLUG = new Map(Object.entries(LETTER).map(([k, v]) => [v, k]));

export const letterSlug = (letter: string): string | null => LETTER[letter] ?? null;
export const letterFromSlug = (slug: string): string | null => LETTER_BY_SLUG.get(slug) ?? null;

/** "Рада адвокатів Київської області" → "kyivskoi-oblasti". */
export const councilSlug = (council: string): string =>
  slugify(council.replace(/^рада\s+адвокатів\s+/iu, '')) || slugify(council);

export const fullName = (a: AdvocateLink) => [a.familyName, a.name, a.additionalName].filter(Boolean).join(' ');
export const advocateSlug = (a: AdvocateLink) => `${slugify(fullName(a), 70) || 'advokat'}-${a.id}`;

/** Trailing ЄРАУ id of an /advokat slug. */
export function idFromSlug(slug: string): string | null {
  const m = /^(?:[a-z0-9]+-)*?(\d{1,9})$/.exec(slug);
  return m ? m[1] : null;
}

const nf = new Intl.NumberFormat('uk-UA');

export function renderAdvocatesIndex(councils: Array<{ council: string; count: number }>): string {
  const total = councils.reduce((a, c) => a + c.count, 0);
  return page({
    title: 'Адвокати України: реєстр за радами адвокатів регіонів | LEX',
    description: `${nf.format(total)} адвокатів України з чинним правом на заняття адвокатською діяльністю за даними ЄРАУ: пошук за радою адвокатів регіону та прізвищем, номер і дата свідоцтва.`,
    path: '/advokaty',
    crumbs: ROOT,
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Адвокати України</h1>
<p class="meta">${nf.format(total)} адвокатів з чинним правом на заняття адвокатською діяльністю. Оберіть раду адвокатів регіону.</p>
<ul class="cols">${councils.map(c => `<li><a href="/advokaty/${esc(councilSlug(c.council))}">${esc(c.council)}</a> · ${nf.format(c.count)}</li>`).join('')}</ul>`,
  });
}

export function renderCouncil(council: string, letters: Array<{ letter: string; count: number }>): string {
  const cs = councilSlug(council);
  const path = `/advokaty/${cs}`;
  const total = letters.reduce((a, l) => a + l.count, 0);
  const items = letters
    .filter(l => letterSlug(l.letter))
    .map(l => `<li><a href="${path}/${letterSlug(l.letter)}">${esc(l.letter)}</a> · ${nf.format(l.count)}</li>`)
    .join('');
  return page({
    title: `Адвокати: ${council} (${nf.format(total)}) | LEX`,
    description: `${nf.format(total)} адвокатів, внесених до ЄРАУ (${council}), з чинним правом на заняття адвокатською діяльністю. Перелік за першою літерою прізвища.`,
    path,
    crumbs: [...ROOT, { name: council, href: path }],
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Адвокати: ${esc(council)}</h1>
<p class="meta">${nf.format(total)} адвокатів. Оберіть першу літеру прізвища.</p>
<ul class="cols">${items}</ul>`,
  });
}

export function renderLetter(council: string, letter: string, list: AdvocateLink[]): string {
  const cs = councilSlug(council);
  const path = `/advokaty/${cs}/${letterSlug(letter)}`;
  const sorted = [...list].sort((a, b) => fullName(a).localeCompare(fullName(b), 'uk'));
  return page({
    title: `Адвокати на літеру «${letter}»: ${council} | LEX`,
    description: `${list.length} адвокатів на літеру «${letter}» (${council}) за даними Єдиного реєстру адвокатів України.`,
    path,
    crumbs: [...ROOT, { name: council, href: `/advokaty/${cs}` }, { name: letter, href: path }],
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Адвокати на літеру «${esc(letter)}»</h1>
<p class="meta">${esc(council)} · ${list.length}</p>
<ul class="cols">${sorted.map(a => `<li><a href="/advokat/${esc(advocateSlug(a))}">${esc(fullName(a))}</a></li>`).join('')}</ul>`,
  });
}

export function renderAdvocate(a: Advocate): string {
  const name = fullName(a);
  const path = `/advokat/${advocateSlug(a)}`;
  const place = [a.city, a.region && a.city !== a.region ? `${a.region} обл.` : null].filter(Boolean).join(', ');
  const cert = a.certificateNum
    ? `№ ${esc(a.certificateNum)}${a.certificateDate ? ` від ${uaDate(a.certificateDate)}` : ''}`
    : '';
  const rows: Array<[string, string]> = [
    ['Право на заняття адвокатською діяльністю', 'діє'],
    ...(cert ? [['Свідоцтво', cert] as [string, string]] : []),
    ...(a.authority ? [['Видано', esc(a.authority)] as [string, string]] : []),
    ...(a.council ? [['Рада адвокатів регіону', `<a href="/advokaty/${esc(councilSlug(a.council))}">${esc(a.council)}</a>`] as [string, string]] : []),
    ...(place ? [['Робоче місце', esc(place)] as [string, string]] : []),
    ...a.orgs.map(o => [esc(o.type || 'Організаційна форма'), esc(o.name || '')] as [string, string]),
  ];
  return page({
    title: `${name}, адвокат${a.city ? ` (${a.city})` : ''} | LEX`,
    description: `${name}: адвокат${cert ? `, свідоцтво ${cert.replace(/<[^>]+>/g, '')}` : ''}${a.council ? `, ${a.council}` : ''}. Відомості Єдиного реєстру адвокатів України.`.slice(0, 300),
    path,
    crumbs: [...ROOT, ...(a.council ? [{ name: a.council, href: `/advokaty/${councilSlug(a.council)}` }] : []), { name, href: path }],
    source: SOURCE,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Person',
      name,
      jobTitle: 'Адвокат',
      url: SITE + path,
      ...(a.city ? { workLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: a.city, addressCountry: 'UA' } } } : {}),
    }],
    body: `<h1>${esc(name)}</h1>
<p class="meta">Адвокат${a.importedAt ? ` · за даними ЄРАУ станом на ${uaDate(a.importedAt)}` : ''}</p>
<div class="scroll"><table class="stats">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></div>
<p class="meta">Сторінка містить лише відкриті відомості Єдиного реєстру адвокатів України (ст. 17 Закону України «Про адвокатуру та адвокатську діяльність»), без контактних даних. Щоб прибрати її з legal.org.ua, напишіть на <a href="mailto:${REMOVAL_EMAIL}">${REMOVAL_EMAIL}</a>, вказавши номер свідоцтва.</p>
<section class="cta"><h2>LEX для адвокатів</h2><p>Пошук судової практики й позицій Верховного Суду, аналіз документів і реєстрів в одному місці, з посиланнями на джерела.</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a><p class="meta">${esc(BONUS_NOTE)}</p></section>`,
  });
}
