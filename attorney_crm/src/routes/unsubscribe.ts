import { Router } from 'express';
import type { Queryable } from '../db';
import { suppress } from '../mail/suppression';
import { verifyUnsubscribeToken } from '../mail/token';
import { html, raw, type RawHtml } from '../views/html';
import { renderBare } from '../views/layout';
import { tenant } from '../tenant';

// Public, no session. GET shows a confirmation (link scanners and preview fetchers
// follow GETs, so a GET must not change anything); POST records the unsubscribe.
// The POST also serves RFC 8058 one-click, whose body is List-Unsubscribe=One-Click.

// Cloudflare's e-mail obfuscation rewrites addresses on the page into "[email protected]"
// for clients without JS; the <!--email_off--> markers tell it to leave this one alone.
export function withAddress(template: (email: string) => string, email: string): RawHtml {
  const [before, after = ''] = template('\u0000').split('\u0000');
  return html`${before}${raw('<!--email_off-->')}${email}${raw('<!--/email_off-->')}${after}`;
}

export function unsubscribeRoutes(pool: Queryable, secret: string): Router {
  const r = Router();

  const invalid = (res: import('express').Response) => {
    const s = tenant().strings.unsubscribe;
    res.status(404).type('html').send(renderBare(s.title, html`<h1>${s.invalidHeading}</h1><p class="muted">${s.invalidBody}</p>`));
  };

  r.get('/u/:token', (req, res) => {
    const email = verifyUnsubscribeToken(secret, req.params.token);
    if (!email) return invalid(res);
    const s = tenant().strings.unsubscribe;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      renderBare(
        s.title,
        html`<h1>${s.heading}</h1>
<p>${withAddress(s.body, email)}</p>
<form method="post" action="/u/${req.params.token}"><button type="submit" class="btn btn-primary">${s.confirm}</button></form>`,
      ),
    );
  });

  r.post('/u/:token', async (req, res, next) => {
    const email = verifyUnsubscribeToken(secret, req.params.token);
    if (!email) return invalid(res);
    try {
      const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
      await suppress(pool, { email, reason: 'unsubscribe', source: oneClick ? 'one-click' : 'link' });
      const s = tenant().strings.unsubscribe;
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(renderBare(s.title, html`<h1>${s.doneHeading}</h1><p>${withAddress(s.doneBody, email)}</p>`));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
