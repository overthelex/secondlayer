import { html } from './html';
import { renderPage } from './layout';
import { fmtDate, fmtDateTime, isOverdue, practiceChips, stageChip } from './advocates';
import { emailList, orgList, phoneList } from './contacts';
import type { AdvocateRow, PracticeProfile } from '../advocates/repo';
import type { Lead, NoteWithAuthor } from '../leads/repo';
import { NOTE_KINDS, STAGES } from '../practices';
import type { User } from '../auth/users';
import { tenant } from '../tenant';

function dateInput(d: Date | null, tz: string = tenant().timeZone): string {
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) : '';
}

export function renderAdvocatePage(d: { advocate: AdvocateRow; profile: PracticeProfile; lead: Lead | null; notes: NoteWithAuthor[]; user: User; error?: string }): string {
  const a = d.advocate;
  const t = tenant();
  const s = t.strings;
  const stage = d.lead?.stage ?? 'new';
  const manual = new Set(d.lead?.manualPractices ?? []);
  const next = d.lead?.nextContactAt ?? null;
  const body = html`
<p><a href="/advocates">${s.detail.back}</a></p>
<h1>${a.fullName} <span class="status ${a.status}">${s.status[a.status] ?? a.status}</span></h1>
${d.error ? html`<p class="error" role="alert">${d.error}</p>` : ''}
<div class="grid-2">
  <section class="card section">
    <h2>${s.detail.registrySection}</h2>
    <dl class="props">
      <dt>${s.detail.phone}</dt><dd class="stack">${a.phone ? phoneList(a.phone) : '—'}</dd>
      <dt>${s.detail.email}</dt><dd class="stack">${a.email ? emailList(a.email) : '—'}</dd>
      <dt>${s.detail.address}</dt><dd>${a.workAddress ?? '—'}</dd>
      <dt>${s.detail.cityRegion}</dt><dd>${[a.city, a.region].filter(Boolean).join(', ') || '—'}</dd>
      <dt>${s.detail.org}</dt><dd class="stack">${a.orgForms ? orgList(a.orgForms) : '—'}</dd>
      <dt>${s.detail.council}</dt><dd>${a.raName ?? '—'}</dd>
      <dt>${s.detail.certificate}</dt><dd>${a.certificateNum ?? '—'}${a.certificateDate ? ` ${s.detail.from} ${fmtDate(a.certificateDate)}` : ''}</dd>
      <dt>${s.detail.decision}</dt><dd>${a.decisionNum ?? '—'}${a.decisionDate ? ` ${s.detail.from} ${fmtDate(a.decisionDate)}` : ''}</dd>
      <dt>${s.detail.authority}</dt><dd>${a.authorityName ?? '—'}</dd>
      ${a.statusDescription ? html`<dt>${s.detail.status}</dt><dd>${a.statusDescription}</dd>` : ''}
      <dt>${s.detail.registryId}</dt><dd>${a.sourceId}</dd>
    </dl>
  </section>
  <section class="card section">
    <h2>${s.detail.practiceSection}</h2>
    ${d.profile.kinds.length === 0
      ? html`<p class="muted">${s.detail.noMentions}</p>`
      : html`<ul>${d.profile.kinds.map(
          (k) => html`<li><strong>${k.name}</strong>: ${k.cases} ${s.list.casesColumn.toLowerCase()}${k.firstYear ? `, ${k.firstYear}${k.lastYear && k.lastYear !== k.firstYear ? `–${k.lastYear}` : ''}` : ''}</li>`,
        )}</ul>`}
    ${d.profile.topCategories.length ? html`<h3>${s.detail.topCategories}</h3><ul>${d.profile.topCategories.map((c) => html`<li>${c.name} <small>· ${c.cases}</small></li>`)}</ul>` : ''}
    <p>${practiceChips({ kinds: a.kinds, manualPractices: [...manual] })}</p>
  </section>
</div>
<section class="card section">
  <h2>${s.detail.leadSection} ${stageChip(stage)}</h2>
  <form method="post" action="/advocates/${a.sourceId}/lead" class="form">
    <div class="row">
      <label>${s.detail.stageField}<select name="stage">${STAGES.map((st) => html`<option value="${st}" ${st === stage ? 'selected' : ''}>${s.stages[st]}</option>`)}</select></label>
      <label>${s.detail.nextContactField}<input type="date" name="next_contact_at" value="${dateInput(next)}">${next && isOverdue(next) ? html`<small class="overdue">${s.detail.overdue}</small>` : ''}</label>
    </div>
    <p class="muted">${s.detail.manualTags}</p>
    <div>${t.practices.map((p) => html`<label class="check"><input type="checkbox" name="manual_practices" value="${p}" ${manual.has(p) ? 'checked' : ''}>${t.practiceLabel(p)}</label>`)}</div>
    <p><button type="submit" class="btn btn-primary">${s.detail.save}</button></p>
  </form>
</section>
<section class="card section">
  <h2>${s.detail.notesSection}</h2>
  <form method="post" action="/advocates/${a.sourceId}/notes" class="form">
    <div>${NOTE_KINDS.map((k, i) => html`<label class="check"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}>${s.noteKinds[k]}</label>`)}</div>
    <label>${s.detail.noteBody}<textarea name="body" required></textarea></label>
    <p><button type="submit" class="btn btn-primary">${s.detail.addNote}</button></p>
  </form>
  ${d.notes.length === 0 ? html`<p class="muted">${s.detail.noNotes}</p>` : ''}
  ${d.notes.map((n) => html`<div class="note"><div class="meta">${fmtDateTime(n.createdAt)} · ${n.author} · ${s.noteKinds[n.kind] ?? n.kind}</div><div class="body">${n.body}</div></div>`)}
</section>`;
  return renderPage({ title: a.fullName, user: d.user, active: 'advocates', body });
}
