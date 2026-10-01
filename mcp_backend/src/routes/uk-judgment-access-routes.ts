/**
 * Applying for, and granting, access to the UK judgment corpus.
 *
 * The gate in services/uk-judgment-access.ts denies by default. This is the way in:
 * a named attestation from the applicant, and a decision by us. Both are recorded,
 * because "we are confident that unqualified individuals cannot access the tool"
 * (The National Archives, 2026-08-28) has to rest on something a person said and
 * something we did, not on an inference we drew from an email address.
 */

import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { emailDomain, isFreeMailDomain, GRANT_VALIDITY_MONTHS } from '../services/uk-judgment-access.js';

export function createUKJudgmentAccessRoutes(deps: {
  db: any;
  dualAuth: any;
}): Router {
  const router = Router();

  // There is no requireAdmin middleware in this codebase — admin routes check the
  // flag themselves. Do the same rather than invent one.
  const adminOnly = (req: any, res: any, next: any) => {
    if (!req.user?.is_admin) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Administrator rights required.',
      });
      return;
    }
    next();
  };

  /** What an applicant sees about their own standing. */
  router.get('/access', deps.dualAuth, async (req: any, res: any) => {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const r = await deps.db.query(
      `SELECT status, organisation, role_stated, regulator, regulator_number,
              attested_at, decided_at, decision_note, expires_at
         FROM uk_judgment_access WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ access: r.rows[0] || { status: 'none' } });
  });

  /**
   * Apply. The attestation is the point of this endpoint: the applicant names their
   * organisation and role and states, in terms, that they are not using the service
   * to conduct their own case. Declining to attest is declining to apply.
   */
  router.post('/access', deps.dualAuth, async (req: any, res: any) => {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      organisation, role, regulator, regulator_number,
      attest_not_litigant_in_person,
    } = req.body || {};

    if (!organisation || !role) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Provide your organisation and role.',
      });
      return;
    }
    if (attest_not_litigant_in_person !== true) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Please confirm that you are not using the service to conduct your own case ' +
          'without a lawyer: send attest_not_litigant_in_person: true.',
      });
      return;
    }

    const domain = emailDomain(req.user.email);
    const freeMail = isFreeMailDomain(req.user.email);

    const saved = await deps.db.query(
      `INSERT INTO uk_judgment_access
         (user_id, status, organisation, role_stated, regulator, regulator_number,
          email_domain, domain_is_free_mail, attested_not_lip, attested_at, attested_ip)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, true, now(), $8)
       ON CONFLICT (user_id) DO UPDATE SET
         -- A live grant survives re-applying; a lapsed one goes back to review, which
         -- is how a person renews after 12 months.
         status = CASE WHEN uk_judgment_access.status = 'granted'
                            AND uk_judgment_access.expires_at > now() THEN 'granted'
                       ELSE 'pending' END,
         organisation = EXCLUDED.organisation,
         role_stated = EXCLUDED.role_stated,
         regulator = EXCLUDED.regulator,
         regulator_number = EXCLUDED.regulator_number,
         email_domain = EXCLUDED.email_domain,
         domain_is_free_mail = EXCLUDED.domain_is_free_mail,
         attested_not_lip = true,
         attested_at = now(),
         attested_ip = EXCLUDED.attested_ip,
         updated_at = now()
       RETURNING status, expires_at`,
      [req.user.id, organisation, role, regulator || null, regulator_number || null,
        domain, freeMail, req.ip || null]
    );

    logger.info('UK judgment access requested', {
      userId: req.user.id, organisation, freeMail,
    });

    // Free mail routes to review, never to refusal: a sole practitioner or a
    // barrister on a personal address is ordinary.
    // Report what is actually on record: re-applying while a grant is live keeps it.
    const status = saved?.rows?.[0]?.status ?? 'pending';
    if (status === 'granted') {
      res.json({
        status,
        expires_at: saved.rows[0].expires_at,
        note: 'Your access is already granted; your details have been updated.',
      });
      return;
    }
    res.json({
      status,
      note: freeMail
        ? 'Application received. As it uses a free-mail address, it will be reviewed by hand.'
        : 'Application received.',
    });
  });

  /** Pending applications, for whoever decides them. */
  router.get('/access/requests', deps.dualAuth, adminOnly, async (_req: any, res: any) => {
    const r = await deps.db.query(
      `SELECT a.user_id, u.email, u.name, a.status, a.organisation, a.role_stated,
              a.regulator, a.regulator_number, a.email_domain, a.domain_is_free_mail,
              a.attested_at
         FROM uk_judgment_access a JOIN users u ON u.id = a.user_id
        WHERE a.status = 'pending' ORDER BY a.created_at`
    );
    res.json({ requests: r.rows });
  });

  /**
   * Decide one. Revocation goes through the same endpoint on purpose: granting and
   * taking away should not differ in how easy they are to do.
   */
  router.post('/access/:userId/decide', deps.dualAuth, adminOnly, async (req: any, res: any) => {
    const { status, note } = req.body || {};
    if (!['granted', 'refused', 'revoked'].includes(status)) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'status must be granted, refused or revoked.',
      });
      return;
    }
    const r = await deps.db.query(
      `UPDATE uk_judgment_access
          SET status = $1, decision_note = $2, decided_by = $3, decided_at = now(),
              -- A grant is good for GRANT_VALIDITY_MONTHS, then the person is verified again.
              expires_at = CASE WHEN $1 = 'granted' THEN now() + make_interval(months => $5) ELSE NULL END,
              updated_at = now()
        WHERE user_id = $4 RETURNING user_id, status, expires_at`,
      [status, note || null, req.user?.id || null, req.params.userId, GRANT_VALIDITY_MONTHS]
    );
    if (!r.rows[0]) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logger.info('UK judgment access decided', {
      subject: req.params.userId, status, by: req.user?.id,
    });
    res.json({ access: r.rows[0] });
  });

  return router;
}
