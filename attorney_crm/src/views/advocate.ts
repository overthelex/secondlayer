import { html } from './html';
import { renderPage } from './layout';
import { fmtDate, fmtDateTime, isOverdue, practiceChips, stageChip } from './advocates';
import type { AdvocateRow, PracticeProfile } from '../advocates/repo';
import type { Lead, NoteWithAuthor } from '../leads/repo';
import { NAAU_PRACTICES, NOTE_KINDS, NOTE_KIND_LABELS, STAGES, STAGE_LABELS } from '../practices';
import type { User } from '../auth/users';

const STATUS_LABELS = { active: 'Діє', suspended: 'Право зупинено', terminated: 'Право припинено' } as const;

function dateInput(d: Date | null): string {
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(d) : '';
}

export function renderAdvocatePage(d: { advocate: AdvocateRow; profile: PracticeProfile; lead: Lead | null; notes: NoteWithAuthor[]; user: User; error?: string }): string {
  const a = d.advocate;
  const stage = d.lead?.stage ?? 'new';
  const manual = new Set(d.lead?.manualPractices ?? []);
  const next = d.lead?.nextContactAt ?? null;
  const body = html`
<p><a href="/advocates">← Адвокати</a></p>
<h1>${a.fullName} <span class="status ${a.status}">${STATUS_LABELS[a.status]}</span></h1>
${d.error ? html`<p class="error" role="alert">${d.error}</p>` : ''}
<div class="grid-2">
  <section class="card section">
    <h2>Реєстр НААУ</h2>
    <dl class="props">
      <dt>Телефон</dt><dd>${a.phone ?? '—'}</dd>
      <dt>E-mail</dt><dd>${a.email ? html`<a href="mailto:${a.email}">${a.email}</a>` : '—'}</dd>
      <dt>Адреса</dt><dd>${a.workAddress ?? '—'}</dd>
      <dt>Місто / область</dt><dd>${[a.city, a.region].filter(Boolean).join(', ') || '—'}</dd>
      <dt>Бюро / об'єднання</dt><dd>${a.orgForms ?? '—'}</dd>
      <dt>Рада адвокатів</dt><dd>${a.raName ?? '—'}</dd>
      <dt>Свідоцтво</dt><dd>${a.certificateNum ?? '—'}${a.certificateDate ? ` від ${fmtDate(a.certificateDate)}` : ''}</dd>
      <dt>Рішення</dt><dd>${a.decisionNum ?? '—'}${a.decisionDate ? ` від ${fmtDate(a.decisionDate)}` : ''}</dd>
      <dt>Орган</dt><dd>${a.authorityName ?? '—'}</dd>
      ${a.statusDescription ? html`<dt>Статус</dt><dd>${a.statusDescription}</dd>` : ''}
      <dt>ID реєстру</dt><dd>${a.sourceId}</dd>
    </dl>
  </section>
  <section class="card section">
    <h2>Практика за ЄДРСР</h2>
    ${d.profile.kinds.length === 0
      ? html`<p class="muted">Згадок у рішеннях 2024–2026 ще не знайдено.</p>`
      : html`<ul>${d.profile.kinds.map(
          (k) => html`<li><strong>${k.name}</strong>: ${k.cases} справ${k.firstYear ? `, ${k.firstYear}${k.lastYear && k.lastYear !== k.firstYear ? `–${k.lastYear}` : ''}` : ''}</li>`,
        )}</ul>`}
    ${d.profile.topCategories.length ? html`<h3>Найчастіші категорії</h3><ul>${d.profile.topCategories.map((c) => html`<li>${c.name} <small>· ${c.cases}</small></li>`)}</ul>` : ''}
    <p>${practiceChips({ kinds: a.kinds, manualPractices: [...manual] })}</p>
  </section>
</div>
<section class="card section">
  <h2>Робота з лідом ${stageChip(stage)}</h2>
  <form method="post" action="/advocates/${a.sourceId}/lead" class="form">
    <div class="row">
      <label>Стадія<select name="stage">${STAGES.map((s) => html`<option value="${s}" ${s === stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`)}</select></label>
      <label>Наступний контакт<input type="date" name="next_contact_at" value="${dateInput(next)}">${next && isOverdue(next) ? html`<small class="overdue">прострочено</small>` : ''}</label>
    </div>
    <p class="muted">Практики (ручні теги)</p>
    <div>${NAAU_PRACTICES.map((p) => html`<label class="check"><input type="checkbox" name="manual_practices" value="${p}" ${manual.has(p) ? 'checked' : ''}>${p}</label>`)}</div>
    <p><button type="submit" class="btn btn-primary">Зберегти</button></p>
  </form>
</section>
<section class="card section">
  <h2>Нотатки</h2>
  <form method="post" action="/advocates/${a.sourceId}/notes" class="form">
    <div>${NOTE_KINDS.map((k, i) => html`<label class="check"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}>${NOTE_KIND_LABELS[k]}</label>`)}</div>
    <label>Опис дзвінка, листа або зустрічі<textarea name="body" required></textarea></label>
    <p><button type="submit" class="btn btn-primary">Додати нотатку</button></p>
  </form>
  ${d.notes.length === 0 ? html`<p class="muted">Нотаток ще немає.</p>` : ''}
  ${d.notes.map((n) => html`<div class="note"><div class="meta">${fmtDateTime(n.createdAt)} · ${n.author} · ${NOTE_KIND_LABELS[n.kind] ?? n.kind}</div><div class="body">${n.body}</div></div>`)}
</section>`;
  return renderPage({ title: a.fullName, user: d.user, active: 'advocates', body });
}
