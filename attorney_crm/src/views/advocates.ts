import { html, raw, type RawHtml } from './html';
import { emailList, orgList, phoneList } from './contacts';
import { renderPage } from './layout';
import type { AdvocateRow } from '../advocates/repo';
import type { AdvocateFilters, SortKey } from '../advocates/query';
import { JUSTICE_KINDS, STAGES, type Stage } from '../practices';
import type { User } from '../auth/users';
import { tenant } from '../tenant';

export function fmtDate(d: Date | null | undefined, tz: string = tenant().timeZone, locale: string = tenant().locale): string {
  if (!d) return '';
  return new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function fmtDateTime(d: Date | null | undefined, tz: string = tenant().timeZone, locale: string = tenant().locale): string {
  if (!d) return '';
  return new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function isOverdue(d: Date | null | undefined, now: Date = new Date(), tz: string = tenant().timeZone): boolean {
  if (!d) return false;
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const dLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  return dLocal < todayLocal;
}

export function stageChip(stage: Stage): RawHtml {
  return html`<span class="chip chip--stage ${stage}">${tenant().strings.stages[stage] ?? stage}</span>`;
}

export function practiceChips(a: Pick<AdvocateRow, 'kinds' | 'manualPractices'>): RawHtml {
  return html`${a.kinds.map((k) => html`<span class="chip" title="${tenant().strings.list.derivedTitle}">${k.name} · ${k.cases}</span>`)}${a.manualPractices.map(
    (p) => html`<span class="chip chip--manual">${p}</span>`,
  )}`;
}

const SORT_COLUMNS = (): { key: SortKey; label: string }[] => {
  const s = tenant().strings;
  return [
    { key: 'surname', label: s.today.name },
    { key: 'city', label: s.list.city },
    { key: 'region', label: s.list.region },
  ];
};

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
  const t = tenant();
  const s = t.strings;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const option = (value: string, label: string, selected: boolean) =>
    html`<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;
  const casesLabel = f.justiceKind ? s.list.casesFor(JUSTICE_KINDS[f.justiceKind] ?? String(f.justiceKind)) : s.list.casesColumn;
  const total = d.total.toLocaleString(t.locale);

  const body = html`
<h1>${s.list.title} <small class="muted">${total} ${s.list.countSuffix}</small></h1>
<form method="get" action="/advocates" class="filters">
  <label>${s.list.surnameStartsWith}<input type="text" name="surname" value="${f.surnamePrefix ?? ''}" placeholder="${s.list.surnamePlaceholder}"></label>
  <label>${s.list.city}<select name="city">${option('', s.list.all, !f.city)}${d.cities.map((c) => option(c, c, f.city === c))}</select></label>
  <label>${s.list.region}<select name="region">${option('', s.list.all, !f.region)}${d.regions.map((c) => option(c, c, f.region === c))}</select></label>
  <label>${s.list.derivedPractice}<select name="justice_kind">${option('', s.list.all, !f.justiceKind)}${Object.entries(JUSTICE_KINDS).map(([k, v]) =>
    option(k, v, f.justiceKind === Number(k)),
  )}</select></label>
  <label>${s.list.manualPractice}<select name="practice">${option('', s.list.all, !f.manualPractice)}${t.practices.map((p) =>
    option(p, t.practiceLabel(p), f.manualPractice === p),
  )}</select></label>
  <label>${s.list.stage}<select name="stage">${option('', s.list.all, !f.stage)}${STAGES.map((st) => option(st, s.stages[st], f.stage === st))}</select></label>
  <input type="hidden" name="sort" value="${f.sort ?? ''}"><input type="hidden" name="dir" value="${f.dir ?? ''}">
  <div class="actions"><button type="submit" class="btn btn-primary">${s.list.show}</button><a class="btn" href="/advocates">${s.list.reset}</a></div>
</form>
<div class="table-wrap">
<table class="data">
<thead><tr>
  <th>${SORT_COLUMNS().map((c, i) => html`${i ? raw(' <span class="muted">/</span> ') : ''}${sortLink(f, c.key, c.label)}`)}</th>
  <th>${s.list.contacts}</th><th>${s.list.orgColumn}</th><th>${s.list.certColumn}</th>
  <th>${s.list.practicesColumn}</th><th class="num">${sortLink(f, 'cases', casesLabel)}</th><th>${s.list.stageColumn}</th>
  <th>${sortLink(f, 'next_contact', s.list.nextContact)} <span class="muted">/</span> ${sortLink(f, 'last_contact', s.list.lastContact)} ${s.list.contactWord}</th>
</tr></thead>
<tbody>
${d.rows.length === 0 ? html`<tr><td colspan="8" class="empty">${s.list.empty}</td></tr>` : ''}
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
  <span>${d.page > 1 ? html`<a href="/advocates${queryString(f, { page: d.page - 1 })}">${s.list.prev}</a>` : ''}</span>
  <span>${s.list.pageOf(d.page, pages, total)}</span>
  <span>${d.page < pages ? html`<a href="/advocates${queryString(f, { page: d.page + 1 })}">${s.list.next}</a>` : ''}</span>
</div>`;
  return renderPage({ title: s.list.title, user: d.user, active: 'advocates', body });
}
