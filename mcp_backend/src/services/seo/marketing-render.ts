/**
 * Public home (/ for guests), /pricing and the scenario landings. Ukrainian,
 * server-rendered, numbers from MarketingRepository only.
 */
import { SITE, esc, uaDate, page, BONUS_NOTE, WELCOME_BONUS_UAH, type Crumb } from './seo-page.js';
import type { Coverage, Pricing, PriceRow } from './marketing-repository.js';

const nf = new Intl.NumberFormat('uk-UA');
const HOME: Crumb = { name: 'LEX', href: '/' };
const SOURCE = 'Дані: ЄДРСР, Верховна Рада України (zakon.rada.gov.ua), відкриті реєстри data.gov.ua, ЄРАУ.';
const ORG = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'LEX',
  url: SITE,
  logo: `${SITE}/icon-192x192.png`,
  email: 'info@legal.org.ua',
};

/** "137 944 864" → "понад 137 млн". */
export function roughly(n: number): string {
  if (n >= 1_000_000) return `понад ${nf.format(Math.floor(n / 1_000_000))} млн`;
  if (n >= 10_000) return `понад ${nf.format(Math.floor(n / 1_000))} тис.`;
  return nf.format(n);
}

const CTA = (title = 'Спробуйте LEX', text = `Реєстрація займає хвилину, на баланс одразу зараховується ${WELCOME_BONUS_UAH} грн. Далі оплата лише за виконані запити, без абонплати.`) =>
  `<section class="cta"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn" href="/login">Зареєструватися</a> &nbsp; <a href="/pricing">Ціни</a></section>`;

const card = (title: string, text: string, href?: string) =>
  `<div class="card"><h3>${href ? `<a href="${href}">${esc(title)}</a>` : esc(title)}</h3><p>${esc(text)}</p></div>`;

const stat = (n: string, label: string, href?: string) =>
  `<div class="card"><span class="num">${esc(n)}</span><p>${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}</p></div>`;

function faqBlock(items: Array<[string, string]>) {
  return {
    html: `<h2>Питання та відповіді</h2>${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`,
    ld: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  };
}

function coverageGrid(c: Coverage): string {
  return `<div class="grid">
${c.edrsrDocs ? stat(roughly(c.edrsrDocs), 'документи Єдиного державного реєстру судових рішень') : ''}
${c.npaActs ? stat(roughly(c.npaActs), 'нормативно-правові акти з редакціями', '/zakon') : ''}
${c.vpDecisions ? stat(nf.format(c.vpDecisions), 'постанови Великої Палати Верховного Суду', '/pozytsiia-vs') : ''}
${c.courts ? stat(nf.format(c.courts), 'суди зі статистикою рішень', '/sud') : ''}
${c.judges ? stat(nf.format(c.judges), 'судді зі статистикою рішень', '/sud') : ''}
${c.advocates ? stat(roughly(c.advocates), 'адвокати з чинним правом на практику', '/advokaty') : ''}
</div>`;
}

/** Signed-in users opening / go straight to the app (the SPA keeps its token in localStorage). */
export const HOME_REDIRECT = `try{if(localStorage.getItem('auth_token'))location.replace('/chat'+location.search+location.hash)}catch(e){}`;

export function renderHome(c: Coverage): string {
  const faq = faqBlock([
    ['Що таке LEX?', 'LEX – AI-асистент для юристів і адвокатів. Він шукає судові рішення, правові позиції Верховного Суду, норми законодавства та дані реєстрів і відповідає з посиланнями на першоджерела.'],
    ['Звідки беруться дані?', 'Судові рішення – з Єдиного державного реєстру судових рішень, тексти законів і кодексів – з офіційного сайту Верховної Ради, відомості про юридичних осіб, боржників, закупівлі та санкції – з відкритих державних реєстрів, адвокати – з Єдиного реєстру адвокатів України.'],
    ['Скільки коштує LEX?', `Абонплати немає: після реєстрації на баланс зараховується ${WELCOME_BONUS_UAH} грн, далі ви поповнюєте баланс і платите за кожен виконаний запит. Ціни на кожен інструмент опубліковано на сторінці «Ціни». Поповнити баланс можна банківською карткою, для компаній доступна оплата за рахунком.`],
    ['Чи можна підключити LEX до Claude або ChatGPT?', 'Так. LEX працює як MCP-сервер: інструменти пошуку практики, законодавства й реєстрів можна підключити до Claude, ChatGPT та інших AI-клієнтів, що підтримують MCP.'],
    ['Чи можна покладатися на відповіді AI?', 'LEX наводить посилання на рішення, статті та записи реєстрів, на яких ґрунтується відповідь, щоб їх можна було перевірити. Відповіді не є юридичною консультацією: висновки у справі робить юрист.'],
  ]);
  return page({
    title: 'LEX – AI-асистент для юристів: судова практика, законодавство, реєстри',
    description: `Пошук судової практики та позицій Верховного Суду, кодекси з редакціями, перевірка контрагентів за відкритими реєстрами. ${roughly(c.edrsrDocs)} судових документів, відповіді з посиланнями на джерела.`,
    path: '/',
    crumbs: [HOME],
    ogType: 'website',
    headScript: HOME_REDIRECT,
    source: SOURCE,
    jsonLd: [ORG, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'LEX', url: SITE, inLanguage: 'uk' }, faq.ld],
    body: `<section class="hero"><h1>AI-асистент для юристів: судова практика, законодавство, реєстри</h1>
<p class="lead">LEX знаходить судові рішення й позиції Верховного Суду, норми кодексів і дані державних реєстрів та відповідає з посиланнями на першоджерела.</p>
<a class="btn" style="display:inline-block;background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600" href="/login">Спробувати LEX</a> &nbsp; <a href="/pricing">Ціни</a>
<p class="meta">${esc(BONUS_NOTE)}</p></section>
<h2>Що можна робити в LEX</h2>
<div class="grid">
${card('Судова практика', 'Пошук рішень за обставинами справи, позиції Великої Палати й касаційних судів, підбірки практики «за» і «проти».', '/sudova-praktyka')}
${card('Перевірка контрагента', 'Юридична особа за кодом ЄДРПОУ: бенефіціари, боржники, виконавчі провадження, банкрутство, закупівлі, санкції.', '/perevirka-kontragenta')}
${card('Для адвокатів', 'Підготовка позиції у справі: практика, норми, статистика суду й судді, аналіз документів справи.', '/dlia-advokativ')}
${card('LEX у Claude і ChatGPT', 'Підключіть інструменти LEX до свого AI-клієнта через MCP і працюйте з українським правом у звичному чаті.', '/mcp-dlia-yurystiv')}
</div>
<h2>Дані</h2>
${coverageGrid(c)}
<p>Частина даних відкрита без реєстрації: <a href="/zakon">кодекси України</a>, <a href="/pozytsiia-vs">постанови Великої Палати ВС</a>, <a href="/sud">суди й судді</a>, <a href="/advokaty">реєстр адвокатів</a>.</p>
${faq.html}
${CTA()}`,
  });
}

const GROUPS: Array<[string, RegExp]> = [
  ['Законодавство', /legislation|npa|edrnpa|^rada_/],
  ['Реєстри та перевірка контрагентів', /^openreyestr_|company|registry|prozorro|passport|spending|trademark|ip_object|vkks|vrp|notar/],
];

/** Tools for other jurisdictions (pl_, ch_, uk_ …) are priced elsewhere. */
const FOREIGN = /^(pl|ch|uk|nl|de|fr|ee|us|eu|ae)_/;

export function groupPrices(rows: PriceRow[]): Array<{ group: string; rows: PriceRow[] }> {
  const out = new Map<string, PriceRow[]>([...GROUPS.map(([g]) => [g, []] as [string, PriceRow[]]), ['Судова практика та аналіз', []]]);
  for (const r of rows) {
    if (FOREIGN.test(r.tool)) continue;
    const g = GROUPS.find(([, re]) => re.test(r.tool))?.[0] ?? 'Судова практика та аналіз';
    out.get(g)!.push(r);
  }
  return [...out].filter(([, rs]) => rs.length).map(([group, rs]) => ({ group, rows: rs.sort((a, b) => a.name.localeCompare(b.name, 'uk')) }));
}

export function formatPrice(usd: number, rate: number | null): string {
  if (rate) {
    const uah = usd * rate;
    return `${uah < 0.1 ? uah.toFixed(3).replace('.', ',') : uah.toFixed(2).replace('.', ',')} грн`;
  }
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}

export function renderPricing(p: Pricing): string {
  const groups = groupPrices(p.rows);
  const all = groups.flatMap(g => g.rows);
  const rateNote = p.rate
    ? `Ціни в гривнях розраховано за курсом НБУ ${p.rate.toFixed(2).replace('.', ',')} грн/$${p.rateDate ? ` на ${uaDate(p.rateDate)}` : ''}; облік ведеться в доларах США, тож сума в гривнях змінюється разом із курсом.`
    : 'Ціни вказано в доларах США; при оплаті в гривнях діє курс НБУ на день списання.';
  const lows = all.map(r => r.usd * (p.rate ?? 1));
  const tables = groups.map(g => `<h2>${esc(g.group)}</h2>
<div class="scroll"><table class="stats"><tr><th>Інструмент</th><th>Ціна запиту</th></tr>
${g.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${formatPrice(r.usd, p.rate)}</td></tr>`).join('\n')}
</table></div>`).join('\n');
  const faq = faqBlock([
    ['Чи є абонплата?', 'Ні. Ви поповнюєте баланс і платите лише за виконані запити за цінами з цієї сторінки.'],
    ['Як поповнити баланс?', 'Банківською карткою в особистому кабінеті (у гривнях або доларах). Для компаній і ФОП доступна оплата за рахунком.'],
    ['Чому ціна AI-чату не фіксована?', 'Запит до AI-чату може задіяти кілька інструментів і різний обсяг тексту, тому він тарифікується за фактичним використанням. Інструменти з таблиці мають фіксовану мінімальну ціну запиту.'],
    ['Чи списуються кошти за невдалий запит?', 'Ні, запит, що завершився помилкою, не тарифікується.'],
  ]);
  return page({
    title: 'Ціни LEX: оплата за запит, без абонплати | LEX',
    description: `Ціни на пошук судової практики, законодавства та реєстрів у LEX: ${all.length} інструментів від ${formatPrice(Math.min(...all.map(r => r.usd)), p.rate)} за запит. Без абонплати, ${WELCOME_BONUS_UAH} грн на баланс після реєстрації.`,
    path: '/pricing',
    crumbs: [HOME, { name: 'Ціни', href: '/pricing' }],
    source: 'Ціни сформовано автоматично з чинного прайсу LEX.',
    jsonLd: [ORG, {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'LEX – AI-асистент для юристів',
      provider: { '@type': 'Organization', name: 'LEX', url: SITE },
      areaServed: 'UA',
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: p.rate ? 'UAH' : 'USD',
        lowPrice: Math.min(...lows).toFixed(2),
        highPrice: Math.max(...lows).toFixed(2),
        offerCount: all.length,
      },
    }, faq.ld],
    body: `<h1>Ціни LEX</h1>
<p class="lead">Без абонплати й мінімального пакета: після реєстрації на баланс зараховується ${WELCOME_BONUS_UAH} грн, далі поповнюєте баланс і платите за кожен виконаний запит.</p>
<div class="grid">
${card('Інструменти даних', `Пошук рішень, норм і записів реєстрів: фіксована ціна за запит, від ${formatPrice(Math.min(...all.map(r => r.usd)), p.rate)}.`)}
${card('AI-чат', `За фактичним використанням${p.chatAvgUsd ? `, у середньому близько ${formatPrice(p.chatAvgUsd, p.rate)} за запит` : ''}. Складні запити з кількома джерелами коштують більше.`)}
${card('Для компаній', 'Оплата за рахунком, денні й місячні ліміти витрат, доступ через API та MCP.')}
</div>
<p class="meta">${esc(rateNote)} Ціна аналітичних інструментів, що використовують AI, – мінімальна: якщо обробка великого обсягу коштує більше, списується фактична вартість.</p>
${tables}
${faq.html}
${CTA(`Почніть з ${WELCOME_BONUS_UAH} грн на балансі`, 'Зареєструйтеся, спробуйте інструменти за рахунок вітального бонусу, а далі поповнюйте баланс на зручну суму й платіть лише за те, чим користуєтеся.')}`,
  });
}

export interface Landing {
  path: string;
  title: string;
  h1: string;
  description: string;
  lead: string;
  cards: Array<[string, string, string?]>;
  extra?: (c: Coverage) => string;
  faq: Array<[string, string]>;
}

export const LANDINGS: Landing[] = [
  {
    path: '/sudova-praktyka',
    title: 'Пошук судової практики з AI: ЄДРСР і позиції Верховного Суду | LEX',
    h1: 'Пошук судової практики з AI',
    description: 'Знаходьте судові рішення за обставинами справи, а не лише за ключовими словами: ЄДРСР, правові позиції Великої Палати й касаційних судів, практика «за» і «проти».',
    lead: 'Опишіть ситуацію своїми словами – LEX знайде релевантні рішення в ЄДРСР, виділить позиції Верховного Суду й покаже, як суди вирішували схожі спори.',
    cards: [
      ['Пошук за фактами', 'Семантичний пошук рішень зі схожими обставинами, а не лише зі збігом слів.'],
      ['Позиції Верховного Суду', 'Висновки Великої Палати та касаційних судів, які суди враховують при застосуванні норм.', '/pozytsiia-vs'],
      ['Практика «за» і «проти»', 'Підбірка рішень на користь кожної зі сторін для оцінки перспектив справи.'],
      ['Чинність позиції', 'Перевірка, чи не відступив Верховний Суд від позиції, на яку ви посилаєтеся.'],
      ['Граф цитувань', 'Які рішення посилаються на дану постанову і які норми в ній застосовано.'],
      ['Повний текст рішення', 'Текст рішення з реєстру з посиланням на оригінал у ЄДРСР.'],
    ],
    extra: c => `<h2>Обсяг даних</h2>${coverageGrid({ ...c, advocates: 0, npaActs: 0 })}`,
    faq: [
      ['Чим LEX відрізняється від пошуку на сайті ЄДРСР?', 'Пошук у ЄДРСР працює за реквізитами й ключовими словами. LEX шукає за змістом: можна описати обставини справи, і система знайде рішення зі схожими фактами, навіть якщо в них інші формулювання.'],
      ['Чи показує LEX позиції Верховного Суду?', 'Так. LEX окремо шукає постанови Великої Палати та касаційних судів і виділяє висновки щодо застосування норм права. Постанови Великої Палати також відкриті без реєстрації в розділі «Практика ВП».'],
      ['Чи можна перевірити, що рішення справжнє?', 'Кожне рішення має номер справи, дату й посилання на оригінал у ЄДРСР.'],
    ],
  },
  {
    path: '/perevirka-kontragenta',
    title: 'Перевірка контрагента за ЄДРПОУ: реєстри, борги, суди, санкції | LEX',
    h1: 'Перевірка контрагента за кодом ЄДРПОУ',
    description: 'Досьє юридичної особи з відкритих державних реєстрів: ЄДР і бенефіціари, податковий борг, виконавчі провадження, банкрутство, Prozorro, санкції РНБО, судові справи.',
    lead: 'Введіть код ЄДРПОУ або назву – LEX збере відомості з відкритих державних реєстрів і судової практики та вкаже джерело й дату кожного розділу.',
    cards: [
      ['ЄДР і бенефіціари', 'Дані про юридичну особу, керівників і кінцевих бенефіціарних власників.'],
      ['Борги та стягнення', 'Податковий борг, борг з ЄСВ, реєстр боржників, виконавчі провадження.'],
      ['Банкрутство', 'Справи про банкрутство та відомості про арбітражних керуючих.'],
      ['Закупівлі', 'Участь у закупівлях Prozorro як замовника чи постачальника.'],
      ['Санкції', 'Перевірка за санкційними списками РНБО.'],
      ['Судові справи', 'Справи за участю компанії в ЄДРСР і їхній результат.', '/sudova-praktyka'],
    ],
    faq: [
      ['Звідки дані для перевірки контрагента?', 'З відкритих державних реєстрів, опублікованих на data.gov.ua та офіційних порталах, і з Єдиного державного реєстру судових рішень. Для кожного розділу LEX вказує джерело та дату актуальності.'],
      ['Скільки коштує перевірка?', `Кожен запит до реєстру оплачується окремо за цінами зі сторінки «Ціни», без абонплати. Перші перевірки можна зробити за рахунок ${WELCOME_BONUS_UAH} грн, які зараховуються на баланс після реєстрації.`],
      ['Чи можна перевірити фізичну особу-підприємця?', 'Так, у межах відомостей, які відкриті в державних реєстрах.'],
    ],
  },
  {
    path: '/dlia-advokativ',
    title: 'LEX для адвокатів: практика, норми, аналіз справи з AI | LEX',
    h1: 'LEX для адвокатів',
    description: 'AI-асистент для адвоката: судова практика й позиції ВС під обставини справи, норми з історією редакцій, статистика суду й судді, аналіз документів справи.',
    lead: 'LEX бере на себе пошук і першу обробку матеріалів, щоб адвокат витрачав час на позицію у справі, а не на пошук рішень.',
    cards: [
      ['Практика під справу', 'Рішення зі схожими обставинами та позиції Верховного Суду з посиланнями на ЄДРСР.', '/sudova-praktyka'],
      ['Норми з редакціями', 'Текст статті в редакції на потрібну дату та історія змін.', '/zakon'],
      ['Суд і суддя', 'Статистика рішень суду та судді за роками й видами судочинства.', '/sud'],
      ['Документи справи', 'Аналіз і порівняння документів, витяг ключових положень договорів.'],
      ['Процесуальні строки', 'Процесуальний чекліст і норми процесуальних кодексів.'],
      ['Контрагенти', 'Перевірка сторін за відкритими реєстрами.', '/perevirka-kontragenta'],
    ],
    faq: [
      ['Чи зберігає LEX документи моїх клієнтів?', 'Документи, які ви завантажуєте, зберігаються у вашому особистому сховищі й доступні лише вашому обліковому запису.'],
      ['Чи замінює LEX юриста?', 'Ні. LEX шукає й упорядковує практику, норми та дані, а оцінку й висновки у справі робить адвокат.'],
      ['Як знайти адвоката в реєстрі?', 'Публічний перелік адвокатів з чинним правом на заняття адвокатською діяльністю за даними ЄРАУ – у розділі «Адвокати України».'],
    ],
  },
  {
    path: '/mcp-dlia-yurystiv',
    title: 'MCP для юристів: українське право в Claude і ChatGPT | LEX',
    h1: 'Українське право в Claude і ChatGPT через MCP',
    description: 'Підключіть LEX як MCP-сервер до Claude, ChatGPT чи іншого AI-клієнта: судова практика ЄДРСР, законодавство з редакціями та відкриті реєстри України прямо в чаті.',
    lead: 'MCP (Model Context Protocol) дозволяє AI-асистенту викликати зовнішні інструменти. Підключіть LEX – і ваш Claude або ChatGPT шукатиме українську судову практику, норми й реєстри з посиланнями на джерела.',
    cards: [
      ['Claude', 'Додайте LEX як конектор у Claude і користуйтеся інструментами в будь-якому чаті.'],
      ['ChatGPT', 'Підключіть LEX у налаштуваннях ChatGPT як застосунок з MCP-сервером.'],
      ['Власні агенти', 'Викликайте інструменти LEX з власних AI-агентів через API-ключ.', '/developer/docs'],
    ],
    extra: () => `<h2>Як підключити</h2>
<ol><li>Зареєструйтеся в LEX: на баланс одразу зарахується ${WELCOME_BONUS_UAH} грн, яких вистачить, щоб спробувати інструменти.</li><li>Відкрийте сторінку <a href="/mcp-connect">підключення MCP</a> і скопіюйте адресу сервера.</li><li>Додайте сервер у своєму AI-клієнті та увійдіть через обліковий запис LEX або вкажіть API-ключ.</li></ol>
<p>Технічні подробиці – у <a href="/developer/docs">документації для розробників</a>.</p>`,
    faq: [
      ['Що таке MCP?', 'Model Context Protocol – відкритий стандарт, за яким AI-асистенти підключаються до зовнішніх інструментів і даних. Його підтримують Claude, ChatGPT та інші клієнти.'],
      ['Скільки коштує використання LEX через MCP?', 'Так само, як і в застосунку: кожен виклик інструменту оплачується з балансу за цінами зі сторінки «Ціни».'],
      ['Чи потрібна передплата Claude або ChatGPT?', 'Підключення власних MCP-серверів залежить від тарифу вашого AI-клієнта; умови варто перевірити в його документації.'],
    ],
  },
];

export function renderLanding(l: Landing, c: Coverage): string {
  const faq = faqBlock(l.faq);
  return page({
    title: l.title,
    description: l.description,
    path: l.path,
    crumbs: [HOME, { name: l.h1, href: l.path }],
    ogType: 'website',
    source: SOURCE,
    jsonLd: [faq.ld],
    body: `<section class="hero"><h1>${esc(l.h1)}</h1><p class="lead">${esc(l.lead)}</p></section>
<div class="grid">${l.cards.map(([t, d, h]) => card(t, d, h)).join('\n')}</div>
${l.extra ? l.extra(c) : ''}
${faq.html}
${CTA()}`,
  });
}
