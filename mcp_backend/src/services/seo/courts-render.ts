/** HTML for /sud (courts) and /suddia (judges). */
import { SITE, esc, uaDate, page, BONUS_NOTE, type Crumb } from './seo-page.js';
import type { Court, CourtListItem, StatRow, JudgeLink, Judge, CareerRow, Hearings } from './courts-repository.js';

const SOURCE = 'Дані: Єдиний державний реєстр судових рішень, реєстр суддів ДСА; статистику LEX оновлює щодня.';

export const JUSTICE_KINDS: Record<number, string> = {
  1: 'Цивільне', 2: 'Кримінальне', 3: 'Господарське', 4: 'Адміністративне', 5: 'Адмінправопорушення', 0: 'Інше',
};

const ROOT: Crumb[] = [{ name: 'LEX', href: '/product' }, { name: 'Суди України', href: '/sud' }];

const nf = new Intl.NumberFormat('uk-UA');
const n = (x: number) => nf.format(x);

/** A court with no decision for a year is shown as not operating (liquidated in the reforms). */
export function isActive(lastDecision: string | null, today = new Date()): boolean {
  if (!lastDecision) return false;
  return today.getTime() - new Date(lastDecision).getTime() < 365 * 24 * 3600 * 1000;
}

function instanceLabel(code: number | null): string {
  return code === 1 ? 'касаційна інстанція' : code === 2 ? 'апеляційна інстанція' : code === 3 ? 'перша інстанція' : '';
}

/** Year × justice kind table (latest `years` years). */
export function statsTable(rows: StatRow[], years = 10): string {
  if (!rows.length) return '<p class="meta">Рішень у реєстрі не знайдено.</p>';
  const kinds = [...new Set(rows.map(r => r.justiceKind))].sort((a, b) => (a || 99) - (b || 99));
  const ys = [...new Set(rows.map(r => r.year))].sort((a, b) => b - a).slice(0, years);
  const cell = new Map(rows.map(r => [`${r.year}:${r.justiceKind}`, r.decisions]));
  const head = `<tr><th>Рік</th>${kinds.map(k => `<th>${esc(JUSTICE_KINDS[k] ?? 'Інше')}</th>`).join('')}<th>Усього</th></tr>`;
  const body = ys.map(y => {
    const vals = kinds.map(k => cell.get(`${y}:${k}`) ?? 0);
    return `<tr><td>${y}</td>${vals.map(v => `<td>${v ? n(v) : '–'}</td>`).join('')}<td><strong>${n(vals.reduce((a, b) => a + b, 0))}</strong></td></tr>`;
  }).join('');
  return `<div class="scroll"><table class="stats"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** "Цивільне 46%, Адмінправопорушення 31%, Кримінальне 18%" over the last three years with data. */
export function kindShares(rows: StatRow[]): string {
  const ys = [...new Set(rows.map(r => r.year))].sort((a, b) => b - a).slice(0, 3);
  const recent = rows.filter(r => ys.includes(r.year));
  const total = recent.reduce((a, r) => a + r.decisions, 0);
  if (!total) return '';
  const by = new Map<number, number>();
  for (const r of recent) by.set(r.justiceKind, (by.get(r.justiceKind) ?? 0) + r.decisions);
  return [...by.entries()]
    .map(([k, v]) => ({ k, pct: Math.round((v / total) * 100) }))
    .filter(x => x.pct >= 3)
    .sort((a, b) => b.pct - a.pct)
    .map(x => `${JUSTICE_KINDS[x.k] ?? 'Інше'} ${x.pct}%`)
    .join(', ');
}

const yearTotal = (rows: StatRow[], y: number) => rows.filter(r => r.year === y).reduce((a, r) => a + r.decisions, 0);

export function renderCourtsIndex(courts: CourtListItem[]): string {
  const groups = new Map<string, CourtListItem[]>();
  for (const c of courts) {
    const g = c.instanceCode === 1 || !c.region ? 'Вищі та загальнодержавні суди' : c.region;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => (a.startsWith('Вищі') ? -1 : b.startsWith('Вищі') ? 1 : a.localeCompare(b, 'uk')));
  const active = courts.filter(c => isActive(c.lastDecision)).length;
  const sections = keys.map(k => {
    const list = groups.get(k)!;
    const live = list.filter(c => isActive(c.lastDecision));
    const old = list.filter(c => !isActive(c.lastDecision));
    const li = (c: CourtListItem) => `<li><a href="/sud/${esc(c.slug)}">${esc(c.name)}</a></li>`;
    return `<h2>${esc(k)}</h2><ul class="cols">${live.map(li).join('')}</ul>` +
      (old.length ? `<h4>Не діють (рішень понад рік немає)</h4><ul class="cols">${old.map(li).join('')}</ul>` : '');
  }).join('\n');
  return page({
    title: 'Суди України: перелік, судді, статистика рішень | LEX',
    description: `Довідник судів України: ${active} чинних судів за областями, судді кожного суду та статистика рішень за роками й видами судочинства за даними ЄДРСР.`,
    path: '/sud',
    crumbs: ROOT,
    jsonLd: [],
    source: SOURCE,
    body: `<h1>Суди України</h1>
<p class="meta">${n(active)} судів, що ухвалювали рішення протягом останнього року, і ${n(courts.length - active)} судів, які вже не діють. Оберіть суд, щоб побачити суддів і статистику рішень.</p>
${sections}`,
  });
}

const EMPTY: Hearings = { items: [], asOf: null };

/** Upcoming hearings from the court's published schedule. Parties are never shown. */
export function hearingsHtml(h: Hearings, withJudge: boolean): string {
  if (!h.items.length) return '';
  const head = `<tr><th>Дата і час</th><th>Справа</th>${withJudge ? '<th>Головуючий</th>' : ''}<th>Предмет</th><th>Зала</th></tr>`;
  const rows = h.items.map(x => `<tr><td>${esc(x.at)}</td><td>${esc(x.caseNumber)}</td>${withJudge ? `<td>${esc(x.presiding ?? '–')}</td>` : ''}<td>${esc(x.subject ?? '–')}</td><td>${esc(x.room ?? '–')}</td></tr>`).join('');
  return `<h2>Найближчі засідання</h2>
<div class="scroll"><table class="stats"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
<p class="meta">За розкладом засідань, який публікує суд (відкриті дані ДСА)${h.asOf ? `, станом на ${uaDate(h.asOf)}` : ''}. Розклад може змінитися: перевіряйте на сайті суду. Сторони справ не показуємо.</p>`;
}

function cta(title: string, text: string): string {
  return `<section class="cta"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn" href="/login">Спробувати LEX безкоштовно</a><p class="meta">${esc(BONUS_NOTE)}</p></section>`;
}

export function renderCourt(court: Court, stats: StatRow[], judges: JudgeLink[], today = new Date(), hearings: Hearings = EMPTY): string {
  const path = `/sud/${court.slug}`;
  const active = isActive(court.lastDecision, today);
  const lastYear = stats.length ? Math.max(...stats.map(s => s.year)) : null;
  const shares = kindShares(stats);
  const facts = [instanceLabel(court.instanceCode), court.region].filter(Boolean).join(' · ');
  const status = active
    ? ''
    : `<p class="warn">Суд не ухвалював рішень понад рік${court.lastDecision ? ` (останнє рішення в реєстрі від ${uaDate(court.lastDecision)})` : ''}: імовірно, його ліквідовано або реорганізовано під час судової реформи.</p>`;
  const sorted = [...judges].sort((a, b) => a.fullName.localeCompare(b.fullName, 'uk'));
  const judgesHtml = judges.length
    ? `<h2>Судді (${judges.length})</h2><ul class="cols">${sorted.map(j => `<li><a href="/suddia/${esc(j.slug)}">${esc(j.fullName)}</a></li>`).join('')}</ul>`
    : '';
  const descr = `${court.name}: ${facts}.` +
    (lastYear ? ` ${n(yearTotal(stats, lastYear))} рішень у ЄДРСР за ${lastYear} рік.` : '') +
    (hearings.items.length ? ' Розклад найближчих засідань.' : '') +
    (judges.length ? ` Судді (${judges.length}) і статистика рішень за роками.` : ' Статистика рішень за роками.');
  return page({
    title: hearings.items.length ? `${court.name}: розклад засідань, судді, статистика | LEX` : `${court.name}: судді, статистика рішень | LEX`,
    description: descr.slice(0, 300),
    path,
    crumbs: [...ROOT, { name: court.name, href: path }],
    source: SOURCE,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'GovernmentOrganization',
      name: court.name,
      url: SITE + path,
      ...(court.region ? { areaServed: { '@type': 'AdministrativeArea', name: court.region } } : {}),
      ...(judges.length ? { numberOfEmployees: { '@type': 'QuantitativeValue', value: judges.length } } : {}),
    }],
    body: `<h1>${esc(court.name)}</h1>
<p class="meta">${esc(facts)}${court.lastDecision ? ` · останнє рішення в ЄДРСР: ${uaDate(court.lastDecision)}` : ''}</p>
${status}
${shares ? `<p>Структура справ за останні три роки: ${esc(shares)}.</p>` : ''}
<h2>Рішення в ЄДРСР за роками</h2>
${statsTable(stats)}
${hearingsHtml(hearings, true)}
${judgesHtml}
${cta('Практика цього суду в LEX', 'LEX шукає рішення цього суду за суттю спору, показує позиції суддів і результати оскарження з посиланнями на тексти рішень.')}`,
  });
}

export function renderJudge(j: Judge, career: CareerRow[], stats: StatRow[], hearings: Hearings = EMPTY): string {
  const path = `/suddia/${j.slug}`;
  const listed = j.lastSeen !== null && j.lastSeen === j.registerDate;
  const courtName = j.court?.name ?? j.courtName ?? '';
  const courtHtml = j.court ? `<a href="/sud/${esc(j.court.slug)}">${esc(j.court.name)}</a>` : esc(j.courtName ?? '');
  const status = listed
    ? `<p class="meta">Суддя ${courtHtml} · за реєстром суддів станом на ${uaDate(j.registerDate!)}</p>`
    : `<p class="warn">У чинному реєстрі суддів не значиться. Востаннє значився ${j.lastSeen ? `станом на ${uaDate(j.lastSeen)}` : ''}${courtName ? ` (${esc(courtName)})` : ''}.</p>`;
  const careerHtml = career.length > 1 || (career.length === 1 && !listed)
    ? `<h2>Місця роботи за реєстром суддів</h2><ul>${career.map(c => `<li>${esc(c.courtName)}: ${uaDate(c.from)} – ${uaDate(c.to)}</li>`).join('')}</ul><p class="meta">Реєстр суддів відстежується з червня 2021 року.</p>`
    : '';
  const lastYear = stats.length ? Math.max(...stats.map(s => s.year)) : null;
  const shares = kindShares(stats);
  const statsHtml = j.court
    ? `<h2>Рішення судді в ЄДРСР (${esc(j.court.name)})</h2>${statsTable(stats)}<p class="meta">Рішення пов’язано за прізвищем та ініціалами в межах суду.</p>`
    : '';
  const descr = `${j.fullName}, суддя${courtName ? ` (${courtName})` : ''}.` +
    (lastYear ? ` ${n(yearTotal(stats, lastYear))} рішень у ЄДРСР за ${lastYear} рік.` : '') +
    (hearings.items.length ? ' Найближчі засідання за розкладом суду.' : '') +
    ' Місце роботи і статистика рішень за роками та видами судочинства.';
  return page({
    title: `${j.fullName}, суддя${courtName ? `: ${courtName}` : ''} | LEX`,
    description: descr.slice(0, 300),
    path,
    crumbs: [...ROOT, ...(j.court ? [{ name: j.court.name, href: `/sud/${j.court.slug}` }] : []), { name: j.fullName, href: path }],
    source: SOURCE,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: j.fullName,
      jobTitle: 'Суддя',
      url: SITE + path,
      ...(j.court && listed ? { worksFor: { '@type': 'GovernmentOrganization', name: j.court.name, url: `${SITE}/sud/${j.court.slug}` } } : {}),
    }],
    body: `<h1>${esc(j.fullName)}</h1>
${status}
${shares ? `<p>Структура справ за останні три роки: ${esc(shares)}.</p>` : ''}
${statsHtml}
${hearingsHtml(hearings, false)}
${careerHtml}
${cta('Практика цього судді в LEX', 'LEX знаходить рішення цього судді за суттю спору, показує типові результати розгляду та їх долю в апеляції й касації.')}`,
  });
}
