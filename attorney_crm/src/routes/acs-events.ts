import express, { Router } from 'express';
import type { Queryable } from '../db';
import { deliveryOutcome, hookKeyMatches, parseAcsEvents, VALIDATION_EVENT } from '../mail/acs-events';
import { suppress } from '../mail/suppression';
import { tenant } from '../tenant';

// Public webhook for the Event Grid subscription on the ACS resource. No session:
// Event Grid authenticates with the derived hook key, sent as the x-acs-hook-key
// delivery attribute (or ?key= on the endpoint URL). A database error answers 500 so
// Event Grid retries the batch (it keeps trying for 24 hours); suppress() is an upsert,
// so a redelivered batch is harmless.
export function acsEventRoutes(pool: Queryable, secret: string): Router {
  const r = Router();

  r.post('/hooks/acs-events', express.json({ limit: '1mb', type: () => true }), async (req, res, next) => {
    if (!hookKeyMatches(secret, req.get('x-acs-hook-key') ?? req.query.key)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      const events = parseAcsEvents(req.body);
      const handshake = events.find((e) => e.type === VALIDATION_EVENT);
      if (handshake) {
        res.json({ validationResponse: handshake.data.validationCode });
        return;
      }
      const domain = tenant().brand.domain;
      let reports = 0;
      let suppressed = 0;
      for (const event of events) {
        const outcome = deliveryOutcome(event, domain);
        if (!outcome) continue;
        reports++;
        if (outcome.status.toLowerCase() !== 'delivered') process.stdout.write(`[attorney_crm] acs delivery ${outcome.email} ${outcome.detail}\n`);
        if (!outcome.reason) continue;
        await suppress(pool, { email: outcome.email, reason: outcome.reason, source: 'acs-event', detail: outcome.detail });
        suppressed++;
      }
      res.json({ received: events.length, reports, suppressed });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
