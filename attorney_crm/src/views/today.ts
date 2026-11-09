import { html } from './html';
import { renderPage } from './layout';
import { phoneList } from './contacts';
import { fmtDate, fmtDateTime, stageChip } from './advocates';
import type { DueRow, NoteWithAdvocate } from '../leads/repo';
import type { User } from '../auth/users';
import { tenant } from '../tenant';

export function renderTodayPage(d: { due: DueRow[]; notes: NoteWithAdvocate[]; user: User }): string {
  const s = tenant().strings;
  const body = html`
<h1>${s.today.title} <small class="muted">${fmtDate(new Date())}</small></h1>
<section class="section">
  <h2>${s.today.callToday} <small class="muted">${d.due.length}</small></h2>
  ${d.due.length === 0
    ? html`<div class="card empty">${s.today.nothingDue}</div>`
    : html`<div class="table-wrap"><table class="data">
<thead><tr><th>${s.today.date}</th><th>${s.today.name}</th><th>${s.today.city}</th><th>${s.today.phone}</th><th>${s.today.stage}</th><th>${s.today.lastNote}</th></tr></thead>
<tbody>${d.due.map(
  (r) => html`<tr>
  <td class="nowrap ${r.overdue ? 'overdue' : ''}">${fmtDate(r.nextContactAt)}${r.overdue ? ` · ${s.today.overdue}` : ''}</td>
  <td><a href="/advocates/${r.sourceId}">${r.fullName}</a></td>
  <td>${r.city ?? ''}</td><td class="stack">${phoneList(r.phone)}</td>
  <td>${stageChip(r.stage)}</td>
  <td>${r.lastNote ? html`<small class="muted">${fmtDate(r.lastNoteAt)}</small> ${r.lastNote.length > 140 ? r.lastNote.slice(0, 140) + '…' : r.lastNote}` : ''}</td>
</tr>`,
)}</tbody></table></div>`}
</section>
<section class="section">
  <h2>${s.today.newNotes}</h2>
  ${d.notes.length === 0 ? html`<div class="card empty">${s.today.noNotes}</div>` : ''}
  ${d.notes.map(
    (n) => html`<div class="note"><div class="meta">${fmtDateTime(n.createdAt)} · ${n.author} · ${s.noteKinds[n.kind] ?? n.kind} · <a href="/advocates/${n.advocateSourceId}">${n.advocateName}</a></div><div class="body">${n.body}</div></div>`,
  )}
</section>`;
  return renderPage({ title: s.today.title, user: d.user, active: 'today', body });
}
