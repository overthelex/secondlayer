import { Router } from 'express';
import type { Queryable } from '../db';
import { getAdvocate } from '../advocates/repo';
import { ValidationError } from '../leads/repo';
import type { PbxService } from '../pbx/calls';
import type { EventHub } from '../pbx/hub';
import { tenant } from '../tenant';

// Signed-in only (mounted after requireLogin). The button posts the number it sits
// next to; the page then reloads with the new 'call' note on top. The browser also
// keeps /pbx/events open for screen pops and call status (static/pbx.js).
export function pbxRoutes(pool: Queryable, pbx: PbxService, hub: EventHub): Router {
  const r = Router();

  r.post('/advocates/:sourceId/call', async (req, res, next) => {
    const { sourceId } = req.params;
    try {
      const advocate = await getAdvocate(pool, sourceId);
      if (!advocate) return res.status(404).json({ error: 'not found' });
      const number = String(req.body?.number ?? '');
      await pbx.startOutbound(sourceId, number, res.locals.user!, advocate.fullName);
      res.redirect(`/advocates/${encodeURIComponent(sourceId)}`);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).type('text').send(err.message);
      process.stderr.write(`[attorney_crm/pbx] originate: ${(err as Error).message}\n`);
      res.status(502).type('text').send(tenant().strings.pbx.pbxError);
    }
  });

  r.get('/pbx/events', (_req, res) => hub.subscribe(res));

  return r;
}
