import { Router } from 'express';
import type { Queryable } from '../db';
import { getAdvocate, getPracticeProfile } from '../advocates/repo';
import { addNote, getLead, listNotes, saveLead, ValidationError } from '../leads/repo';
import { renderAdvocatePage } from '../views/advocate';
import type { NoteKind, Stage } from '../practices';
import { renderPage } from '../views/layout';
import { html } from '../views/html';
import { tenant } from '../tenant';
import { utcOffsetMinutes } from '../leads/repo';

/** 'YYYY-MM-DD' typed in the tenant's zone → local midnight as an instant; empty → null; other → undefined (ignored). */
export function parseLocalDate(s: unknown, tz: string = tenant().timeZone): Date | null | undefined {
  if (typeof s !== 'string') return undefined;
  const v = s.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(utcMidnight - utcOffsetMinutes(new Date(utcMidnight), tz) * 60_000);
}

/** Kept for the Ukrainian tenant and its tests. */
export const parseKyivDate = (s: unknown): Date | null | undefined => parseLocalDate(s, 'Europe/Kyiv');

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v !== '') return [v];
  return [];
}

export function advocateRoutes(pool: Queryable): Router {
  const r = Router();

  async function render(res: import('express').Response, sourceId: string, error?: string, status = 200): Promise<void> {
    const advocate = await getAdvocate(pool, sourceId);
    if (!advocate) {
      const s = tenant().strings.detail;
      res.status(404).type('html').send(renderPage({ title: s.notFoundTitle, user: res.locals.user, active: 'advocates', body: html`<h1>${s.notFoundHeading}</h1><p class="muted">${s.notFoundBody(sourceId)}</p>` }));
      return;
    }
    const [profile, lead, notes] = await Promise.all([getPracticeProfile(pool, sourceId), getLead(pool, sourceId), listNotes(pool, sourceId)]);
    res.status(status).type('html').send(renderAdvocatePage({ advocate, profile, lead, notes, user: res.locals.user!, error }));
  }

  r.get('/advocates/:sourceId', (req, res, next) => render(res, req.params.sourceId).catch(next));

  r.post('/advocates/:sourceId/lead', async (req, res, next) => {
    const { sourceId } = req.params;
    try {
      await saveLead(pool, sourceId, {
        stage: req.body?.stage as Stage | undefined,
        nextContactAt: parseLocalDate(req.body?.next_contact_at),
        manualPractices: asList(req.body?.manual_practices),
      }, res.locals.user!.id);
      res.redirect(`/advocates/${encodeURIComponent(sourceId)}`);
    } catch (err) {
      if (err instanceof ValidationError) return render(res, sourceId, err.message, 400).catch(next);
      next(err);
    }
  });

  r.post('/advocates/:sourceId/notes', async (req, res, next) => {
    const { sourceId } = req.params;
    try {
      await addNote(pool, sourceId, res.locals.user!.id, String(req.body?.kind ?? 'call') as NoteKind, String(req.body?.body ?? ''));
      res.redirect(`/advocates/${encodeURIComponent(sourceId)}`);
    } catch (err) {
      if (err instanceof ValidationError) return render(res, sourceId, err.message, 400).catch(next);
      next(err);
    }
  });

  return r;
}
