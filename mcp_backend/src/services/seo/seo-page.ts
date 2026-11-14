/**
 * Shared HTML shell for the public SEO pages (/zakon, /sud, /suddia):
 * server-rendered, no client JS, Ukrainian. Every interpolated value goes
 * through esc().
 */
import { WELCOME_BONUS_UAH } from '../../config/welcome-bonus.js';

export const SITE = 'https://legal.org.ua';

export { WELCOME_BONUS_UAH };
/** One line under every sign-up button, so the bonus is stated the same way everywhere. */
export const BONUS_NOTE = `Після реєстрації на баланс зараховується ${WELCOME_BONUS_UAH} грн, без підписки й прив'язки картки.`;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON for a <script type="application/ld+json"> block (no "</script>" breakout). */
export function ldJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

export function uaDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).replace(/[\s,;:.–-]+$/, '') + '…';
}

export interface Crumb { name: string; href: string }

export function breadcrumbLd(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: SITE + c.href })),
  };
}

const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#1d4ed8;--accent-fg:#fff;--note:#78716c;--warn-bg:#fef3c7;--warn-fg:#78350f}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--accent-fg:#0c0a09;--note:#a8a29e;--warn-bg:#422006;--warn-fg:#fde68a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}header,main,footer{max-width:820px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center;padding-top:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}
header .logo{font-weight:700;text-decoration:none;color:var(--fg);letter-spacing:.02em}header nav a{margin-left:14px;font-size:15px;white-space:nowrap}
nav.crumbs{font-size:14px;color:var(--muted);margin:20px 0 8px}nav.crumbs a{color:var(--muted)}
h1{font-size:1.6rem;line-height:1.3;margin:8px 0 12px}h2{font-size:1.15rem;margin:28px 0 8px}h3{font-size:1.02rem;margin:20px 0 6px}h4{font-size:.95rem;margin:16px 0 4px;color:var(--muted)}
.meta{font-size:14px;color:var(--muted);margin-bottom:20px}.path{font-size:14px;color:var(--muted);margin:0 0 16px}
.text p{margin:0 0 12px}.text p.note{font-size:14px;color:var(--note);font-style:italic}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:12px 16px;border-radius:8px;margin:16px 0;font-size:15px}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:32px 0}
.cta h2{margin-top:0}.cta a.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}
.pager{display:flex;justify-content:space-between;gap:16px;margin:24px 0;font-size:15px}
ul.toc,ul.codes{list-style:none;padding:0;margin:0}ul.toc li{margin:4px 0}ul.codes li{padding:12px 0;border-bottom:1px solid var(--line)}
table.stats{border-collapse:collapse;width:100%;font-size:15px;margin:8px 0 16px}table.stats th,table.stats td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right}table.stats th:first-child,table.stats td:first-child{text-align:left}.scroll{overflow-x:auto}
ul.cols{columns:2 280px;padding-left:18px}
.lead{font-size:1.1rem;color:var(--muted);margin:0 0 20px}.hero{margin:28px 0 8px}.hero h1{font-size:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:12px 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.card h3{margin-top:0}.card p{margin:0;font-size:15px;color:var(--muted)}
.num{font-size:1.5rem;font-weight:700;display:block}details{border-bottom:1px solid var(--line);padding:10px 0}summary{cursor:pointer;font-weight:600}details p{margin:8px 0 0}
footer nav.svc{margin-bottom:10px;line-height:1.9}footer{font-size:13px;color:var(--muted);padding-top:24px;padding-bottom:40px;border-top:1px solid var(--line);margin-top:40px}
`;

export interface PageOpts {
  title: string;
  description: string;
  path: string;
  crumbs: Crumb[];
  jsonLd: unknown[];
  body: string;
  /** Source note in the footer; defaults to the Rada attribution of /zakon. */
  source?: string;
  /** Inline script placed first in <head> (the home page sends signed-in users to the app). */
  headScript?: string;
  /** og:type; "article" by default. */
  ogType?: string;
}

export function page(o: PageOpts): string {
  const canonical = SITE + o.path;
  const crumbsHtml = o.crumbs
    .map((c, i) => (i === o.crumbs.length - 1 ? esc(c.name) : `<a href="${esc(c.href)}">${esc(c.name)}</a>`))
    .join(' › ');
  const ld = [breadcrumbLd(o.crumbs), ...o.jsonLd].map(j => `<script type="application/ld+json">${ldJson(j)}</script>`).join('\n');
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.headScript ? `<script>${o.headScript}</script>\n` : ''}<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${o.ogType ?? 'article'}">
<meta property="og:site_name" content="LEX">
<meta property="og:locale" content="uk_UA">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/og-image.png">
<link rel="icon" href="/icon-192x192.png" type="image/png">
<style>${CSS}</style>
${ld}
</head>
<body>
<header><a class="logo" href="/">LEX</a><nav><a href="/zakon">Кодекси</a><a href="/sud">Суди</a><a href="/pozytsiia-vs">Практика ВП</a><a href="/pricing">Ціни</a><a href="/blog/uk">Блог</a><a href="/login">Увійти</a></nav></header>
<main>
<nav class="crumbs" aria-label="Навігація">${crumbsHtml}</nav>
${o.body}
</main>
<footer><nav class="svc" aria-label="Сервіси LEX">Сервіси LEX: <a href="/sudova-praktyka">пошук судової практики</a> · <a href="/perevirka-kontragenta">перевірка контрагента</a> · <a href="/dlia-advokativ">для адвокатів</a> · <a href="/mcp-dlia-yurystiv">MCP для Claude і ChatGPT</a> · <a href="/kalkuliator-sudovoho-zboru">калькулятор судового збору</a> · <a href="/pricing">ціни</a> · <a href="/about">про нас</a></nav>${esc(o.source ?? 'Тексти наведено за офіційними даними Верховної Ради України (zakon.rada.gov.ua).')} Інформація не є юридичною консультацією. © LEX, legal.org.ua</footer>
</body>
</html>`;
}

