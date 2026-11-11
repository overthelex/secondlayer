import { html, raw, type RawHtml } from './html';
import type { User } from '../auth/users';
import { assetUrl } from './assets';
import { tenant } from '../tenant';
import { pbxEnabled } from '../pbx/state';

export type NavKey = 'today' | 'advocates';

export interface PageOptions {
  title: string;
  user?: User | null;
  active?: NavKey;
  body: RawHtml;
}

const HEAD = (title: string) => {
  const t = tenant();
  return html`<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${t.brand.name} CRM</title>
<link rel="icon" href="${raw(assetUrl(t.brand.mark))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${raw(assetUrl('app.css'))}">
</head>`;
};

export function renderPage(o: PageOptions): string {
  const t = tenant();
  const s = t.strings;
  const nav = (key: NavKey, href: string, label: string) =>
    html`<a href="${href}" class="${o.active === key ? 'nav-link active' : 'nav-link'}">${label}</a>`;
  return html`${HEAD(o.title)}
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="${raw(assetUrl(t.brand.logo))}" alt="${t.brand.name}" width="36" height="36"><span>${t.brand.name} <small>${t.brand.tagline}</small></span></a>
  <nav class="nav">${nav('today', '/', s.nav.today)}${nav('advocates', '/advocates', s.nav.advocates)}</nav>
  ${o.user
    ? html`<form class="user" method="post" action="/logout"><span>${o.user.displayName || o.user.email}</span><button type="submit" class="btn btn-ghost">${s.nav.logout}</button></form>`
    : ''}
</header>
<main class="page">${o.body}</main>
${o.user && pbxEnabled() ? html`<div id="pbx-toast" class="toast" hidden data-incoming="${s.pbx.incoming}" data-open="${s.pbx.open}" data-unknown="${s.pbx.unknownCaller}" data-status="${JSON.stringify(s.pbx.status)}"></div><script src="${raw(assetUrl('pbx.js'))}" defer></script>` : ''}
</body>
</html>`.value;
}

export function renderBare(title: string, body: RawHtml): string {
  return html`${HEAD(title)}<body class="bare"><main class="page page-narrow">${body}</main></body></html>`.value;
}

export { raw };
