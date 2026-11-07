import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { assetUrl } from '../views/assets';
import { renderPage } from '../views/layout';
import { html } from '../views/html';

describe('assetUrl', () => {
  it('appends a content hash so a redeploy never serves a stale cached file', () => {
    const url = assetUrl('app.css');
    const css = readFileSync(path.join(__dirname, '..', '..', 'static', 'app.css'));
    const expected = createHash('sha256').update(css).digest('hex').slice(0, 10);
    expect(url).toBe(`/static/app.css?v=${expected}`);
    expect(assetUrl('app.css')).toBe(url);
  });

  it('is used by the page layout for the stylesheet, favicon and logo', () => {
    const page = renderPage({ title: 'T', body: html`<p>x</p>` });
    expect(page).toContain(`href="${assetUrl('app.css')}"`);
    expect(page).toContain(`href="${assetUrl('favicon.svg')}"`);
    expect(page).toContain(`src="${assetUrl('logo-white.png')}"`);
  });
});
