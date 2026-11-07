import { html, raw, type RawHtml } from './html';
import { emailList, orgList, phoneList } from './contacts';
import { renderPage } from './layout';
import type { AdvocateRow } from '../advocates/repo';
import type { AdvocateFilters, SortKey } from '../advocates/query';
import { JUSTICE_KINDS, NAAU_PRACTICES, STAGES, STAGE_LABELS, type Stage } from '../practices';
import type { User } from '../auth/users';

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function isOverdue(d: Date | null | undefined, now: Date = new Date()): boolean {
  if (!d) return false;
  const todayKyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
  const dKyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d);
  return dKyiv < todayKyiv;
}

export function stageChip(stage: Stage): RawHtml {
  return html`<span class="chip chip--stage ${stage}">${STAGE_LABELS[stage] ?? stage}</span>`;
}

export function practiceChips(a: Pick<AdvocateRow, 'kinds' | 'manualPractices'>): RawHtml {
  return html`${a.kinds.map((k) => html`<span class="chip" title="справ у ЄДРСР">${k.name} · ${k.cases}</span>`)}${a.manualPractices.map(
    (p) => html`<span class="chip chip--manual">${p}</span>`,
  )}`;
}

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'surname', label: 'ПІБ' },
  { key: 'city', label: 'Місто' },
  { key: 'region', label: 'Область' },
];

function queryString(f: AdvocateFilters, patch: Partial<AdvocateFilters>): string {
  const merged = { ...f, ...patch };
  const p = new URLSearchParams();
  if (merged.surnamePrefix) p.set('surname', merged.surnamePrefix);
  if (merged.city) p.set('city', merged.city);
  if (merged.region) p.set('region', merged.region);
  if (merged.justiceKind) p.set('justice_kind', String(merged.justiceKind));
  if (merged.manualPractice) p.set('practice', merged.manualPractice);
  if (merged.stage) p.set('stage', merged.stage);
  if (merged.sort) p.set('sort', merged.sort);
  if (merged.dir) p.set('dir', merged.dir);
  if (merged.page && merged.page > 1) p.set('page', String(merged.page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function sortLink(f: AdvocateFilters, key: SortKey, label: string): RawHtml {
  const active = (f.sort ?? 'surname') === key;
  const nextDir = active && f.dir !== 'desc' ? 'desc' : 'asc';
  const cls = active ? `sorted ${f.dir === 'desc' ? 'desc' : 'asc'}` : '';
  return html`<a class="${cls}" href="/advocates${queryString(f, { sort: key, dir: nextDir, page: 1 })}">${label}</a>`;
}

export interface AdvocatesPageData {
  rows: AdvocateRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: AdvocateFilters;
  cities: string[];
  regions: string[];
  user: User;
}

export function renderAdvocatesPage(d: AdvocatesPageData): string {
  const f = d.filters;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const option = (value: string, label: string, selected: boolean) =>
    html`<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;
  const casesLabel = f.justiceKind ? `Справ (${JUSTICE_KINDS[f.justiceKind] ?? f.justiceKind})` : 'Справ';

  const body = html`
<h1>Адвокати <small class="muted">${d.total.toLocaleString('uk-UA')} діючих</small></h1>
<form method="get" action="/advocates" class="filters">
  <label>Прізвище починається з<input type="text" name="surname" value="${f.surnamePrefix ?? ''}" placeholder="Ков"></label>
  <label>Місто<select name="city">${option('', 'усі', !f.city)}${d.cities.map((c) => option(c, c, f.city === c))}</select></label>
  <label>Область<select name="region">${option('', 'усі', !f.region)}${d.regions.map((c) => option(c, c, f.region === c))}</select></label>
  <label>Вид права (ЄДРСР)<select name="justice_kind">${option('', 'усі', !f.justiceKind)}${Object.entries(JUSTICE_KINDS).map(([k, v]) =>
    option(k, v, f.justiceKind === Number(k)),
  )}</select></label>
  <label>Практика (ручна)<select name="practice">${option('', 'усі', !f.manualPractice)}${NAAU_PRACTICES.map((p) =>
    option(p, p, f.manualPractice === p),
  )}</select></label>
  <label>Стадія<select name="stage">${option('', 'усі', !f.stage)}${STAGES.map((s) => option(s, STAGE_LABELS[s], f.stage === s))}</select></label>
  <input type="hidden" name="sort" value="${f.sort ?? ''}"><input type="hidden" name="dir" value="${f.dir ?? ''}">
  <div class="actions"><button type="submit" class="btn btn-primary">Показати</button><a class="btn" href="/advocates">Скинути</a></div>
</form>
<div class="table-wrap">
<table class="data">
<thead><tr>
  <th>${SORT_COLUMNS.map((c, i) => html`${i ? raw(' <span class="muted">/</span> ') : ''}${sortLink(f, c.key, c.label)}`)}</th>
  <th>Контакти</th><th>Бюро / рада</th><th>Свідоцтво</th>
  <th>Практики</th><th class="num">${sortLink(f, 'cases', casesLabel)}</th><th>Стадія</th>
  <th>${sortLink(f, 'next_contact', 'Наступний')} <span class="muted">/</span> ${sortLink(f, 'last_contact', 'останній')} контакт</th>
</tr></thead>
<tbody>
${d.rows.length === 0 ? html`<tr><td colspan="8" class="empty">Адвокатів не знайдено</td></tr>` : ''}
${d.rows.map(
  (a) => html`<tr>
  <td class="col-name"><a href="/advocates/${a.sourceId}"><strong>${a.fullName}</strong></a>
    ${a.city || a.region ? html`<span class="sub">${[a.city, a.region].filter(Boolean).join(' · ')}</span>` : ''}</td>
  <td class="col-contacts stack">${phoneList(a.phone)}${emailList(a.email)}</td>
  <td class="col-org stack">${orgList(a.orgForms)}${a.raName ? html`<span class="sub">${a.raName}</span>` : ''}</td>
  <td class="col-cert">${a.certificateNum ?? ''}${a.certificateDate ? html`<span class="sub">${fmtDate(a.certificateDate)}</span>` : ''}</td>
  <td class="col-practices">${practiceChips(a)}</td>
  <td class="num">${f.justiceKind ? a.kindCases : a.kinds.reduce((s, k) => s + k.cases, 0)}</td>
  <td>${stageChip(a.stage)}</td>
  <td class="col-dates">${a.nextContactAt ? html`<span class="line ${isOverdue(a.nextContactAt) ? 'overdue' : ''}">${fmtDate(a.nextContactAt)}</span>` : ''}${a.lastContact ? html`<span class="sub">${fmtDate(a.lastContact)}</span>` : ''}</td>
</tr>`,
)}
</tbody>
</table>
</div>
<div class="pager">
  <span>${d.page > 1 ? html`<a href="/advocates${queryString(f, { page: d.page - 1 })}">← Попередня</a>` : ''}</span>
  <span>Сторінка ${d.page} з ${pages} (всього ${d.total.toLocaleString('uk-UA')})</span>
  <span>${d.page < pages ? html`<a href="/advocates${queryString(f, { page: d.page + 1 })}">Наступна →</a>` : ''}</span>
</div>`;
  return renderPage({ title: 'Адвокати', user: d.user, active: 'advocates', body });
}
