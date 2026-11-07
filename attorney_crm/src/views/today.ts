import { html } from './html';
import { renderPage } from './layout';
import { fmtDate, fmtDateTime, stageChip } from './advocates';
import type { DueRow, NoteWithAdvocate } from '../leads/repo';
import { NOTE_KIND_LABELS } from '../practices';
import type { User } from '../auth/users';

export function renderTodayPage(d: { due: DueRow[]; notes: NoteWithAdvocate[]; user: User }): string {
  const body = html`
<h1>Сьогодні <small class="muted">${fmtDate(new Date())}</small></h1>
<section class="section">
  <h2>Подзвонити сьогодні <small class="muted">${d.due.length}</small></h2>
  ${d.due.length === 0
    ? html`<div class="card empty">На сьогодні контактів не заплановано. Призначте дату на сторінці адвоката.</div>`
    : html`<div class="table-wrap"><table class="data">
<thead><tr><th>Дата</th><th>ПІБ</th><th>Місто</th><th>Телефон</th><th>Стадія</th><th>Остання нотатка</th></tr></thead>
<tbody>${d.due.map(
  (r) => html`<tr>
  <td class="nowrap ${r.overdue ? 'overdue' : ''}">${fmtDate(r.nextContactAt)}${r.overdue ? ' · прострочено' : ''}</td>
  <td><a href="/advocates/${r.sourceId}">${r.fullName}</a></td>
  <td>${r.city ?? ''}</td><td class="nowrap">${r.phone ?? ''}</td>
  <td>${stageChip(r.stage)}</td>
  <td>${r.lastNote ? html`<small class="muted">${fmtDate(r.lastNoteAt)}</small> ${r.lastNote.length > 140 ? r.lastNote.slice(0, 140) + '…' : r.lastNote}` : ''}</td>
</tr>`,
)}</tbody></table></div>`}
</section>
<section class="section">
  <h2>Нові нотатки</h2>
  ${d.notes.length === 0 ? html`<div class="card empty">Нотаток ще немає.</div>` : ''}
  ${d.notes.map(
    (n) => html`<div class="note"><div class="meta">${fmtDateTime(n.createdAt)} · ${n.author} · ${NOTE_KIND_LABELS[n.kind] ?? n.kind} · <a href="/advocates/${n.advocateSourceId}">${n.advocateName}</a></div><div class="body">${n.body}</div></div>`,
  )}
</section>`;
  return renderPage({ title: 'Сьогодні', user: d.user, active: 'today', body });
}
