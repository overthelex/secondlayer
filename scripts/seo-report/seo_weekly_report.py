#!/usr/bin/env python3
"""
Weekly SEO report for legal.org.ua, mailed from cthulhu (deployment/cron/seo-weekly-crontab).

Reads the edge nginx access log (container nginx-local, local-ssl-access.log) and compares
the last 7 full days with the 7 before:
  - visits from search engines (Referer google./bing./…) per section,
  - Googlebot / Bingbot page fetches per section and distinct URLs fetched,
  - pages that answered 404 / 5xx to the bots.
Only page requests count (GET, no /api, assets or MCP). The User-Agent is not verified
against the bots' IP ranges: the numbers are for trends, not an audit.

Search Console numbers (impressions, clicks, indexed pages) are not here: the domain
property was verified on 13.11.2026 and has no API access set up yet.

Env: MAIL_TO / MAIL_FROM (vladimir@legal.org.ua), SMTP_HOST (smtp.azurecomm.net),
     SMTP_PORT (587), SMTP_ENV_FILE (~/.acs-smtp.env: ACS_SMTP_USER, ACS_SMTP_PASS),
     NGINX_CONTAINER (nginx-local), LOG_FILE (/var/log/nginx/local-ssl-access.log),
     DRY_RUN=1 prints the report instead of mailing it.
"""
import collections
import datetime as dt
import html
import os
import re
import smtplib
import subprocess
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

SECTIONS = ['zakon', 'sud', 'suddia', 'pozytsiia-vs', 'advokaty', 'advokat', 'pricing', 'sudova-praktyka',
            'perevirka-kontragenta', 'dlia-advokativ', 'mcp-dlia-yurystiv', 'blog', 'product', 'about',
            'developer', 'ua', 'en']
LINE = re.compile(r'\[(\d{2})/(\w{3})/(\d{4}):[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
SKIP = re.compile(r'^/(api|assets|sse|mcp/|mcp$|oauth|\.well-known)|\.(js|css|png|jpe?g|svg|ico|webp|woff2?|json|txt|map|xml)(\?|$)')
MONTHS = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}
SEARCH = [('Google', re.compile(r'^https?://(www\.)?google\.')), ('Bing', re.compile(r'^https?://(www\.)?bing\.')),
          ('інші', re.compile(r'duckduckgo|yandex|ecosia|search\.brave|yahoo\.'))]


def section(path: str) -> str:
    p = path.split('?', 1)[0]
    if p == '/':
        return '/'
    first = p.split('/')[1]
    return '/' + first if first in SECTIONS else 'інше'


def read_log():
    cmd = ['docker', 'exec', os.environ.get('NGINX_CONTAINER', 'nginx-local'), 'cat',
           os.environ.get('LOG_FILE', '/var/log/nginx/local-ssl-access.log')]
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, errors='replace') as p:
        yield from p.stdout


def collect(lines, start: dt.date, mid: dt.date, end: dt.date):
    """Counters for [start, mid) as 'prev' and [mid, end) as 'cur'."""
    c = {k: collections.Counter() for k in ('search', 'bot', 'bad')}
    urls = {'prev': collections.defaultdict(set), 'cur': collections.defaultdict(set)}
    for line in lines:
        m = LINE.search(line)
        if not m:
            continue
        d, mon, y, meth, path, st, ref, ua = m.groups()
        day = dt.date(int(y), MONTHS.get(mon, 1), int(d))
        if not (start <= day < end) or meth != 'GET' or SKIP.search(path):
            continue
        per = 'cur' if day >= mid else 'prev'
        sec = section(path)
        bot = 'Googlebot' if 'Googlebot' in ua else 'Bingbot' if 'bingbot' in ua else None
        if bot:
            if st == '200':
                c['bot'][(per, bot, sec)] += 1
                urls[per][(bot, sec)].add(path.split('?', 1)[0])
            elif st == '404' or st.startswith('5'):
                c['bad'][(per, bot, st, path.split('?', 1)[0])] += 1
            continue
        if st != '200':
            continue
        for name, rx in SEARCH:
            if rx.search(ref):
                c['search'][(per, name, sec)] += 1
                break
    return c, urls


def delta(cur: int, prev: int) -> str:
    if prev == 0:
        return f'{cur}' if cur == 0 else f'{cur} (нове)'
    pct = round((cur - prev) * 100 / prev)
    return f'{cur} ({"+" if pct >= 0 else ""}{pct}%)'


def build(c, urls, mid: dt.date, end: dt.date):
    rows = []  # (title, header, [(cells)])
    total = lambda per, key_fn: sum(v for k, v in c['search'].items() if k[0] == per and key_fn(k))
    eng = [(n, delta(total('cur', lambda k, n=n: k[1] == n), total('prev', lambda k, n=n: k[1] == n))) for n, _ in SEARCH]
    rows.append(('Переходи з пошукових систем', ['Пошуковик', 'Цей тиждень (зміна)'], eng))
    secs = sorted({k[2] for k in c['search']}, key=lambda s: -sum(v for k, v in c['search'].items() if k[0] == 'cur' and k[2] == s))
    rows.append(('Переходи з пошуку за розділами', ['Розділ', 'Цей тиждень (зміна)'],
                 [(s, delta(total('cur', lambda k, s=s: k[2] == s), total('prev', lambda k, s=s: k[2] == s))) for s in secs]))
    for bot in ('Googlebot', 'Bingbot'):
        bsecs = sorted({k[2] for k in c['bot'] if k[1] == bot}, key=lambda s: -c['bot'][('cur', bot, s)])
        rows.append((f'{bot}: сторінки, які він завантажив', ['Розділ', 'Запити (зміна)', 'Унікальні URL'],
                     [(s, delta(c['bot'][('cur', bot, s)], c['bot'][('prev', bot, s)]), str(len(urls['cur'][(bot, s)]))) for s in bsecs]))
    bad = sorted(((v, k) for k, v in c['bad'].items() if k[0] == 'cur'), reverse=True)[:15]
    rows.append(('Помилки, які отримали боти (цей тиждень, топ-15)', ['Бот', 'Код', 'URL', 'Разів'],
                 [(k[1], k[2], k[3], str(v)) for v, k in bad]))
    period = f'{mid:%d.%m}–{end - dt.timedelta(days=1):%d.%m.%Y}'
    return period, rows


def render_text(period, rows):
    out = [f'SEO legal.org.ua за {period} (у дужках зміна до попередніх 7 днів)', '']
    for title, head, data in rows:
        out.append(title)
        out.append('  ' + ' | '.join(head))
        out += ['  ' + ' | '.join(r) for r in data] or ['  —']
        out.append('')
    out.append('Джерело: лог nginx (Referer і User-Agent, без перевірки IP ботів). Дані Search Console: search.google.com/search-console')
    return '\n'.join(out)


def render_html(period, rows):
    parts = [f'<h2 style="font-family:system-ui">SEO legal.org.ua за {html.escape(period)}</h2>',
             '<p style="font-family:system-ui;color:#555">У дужках зміна до попередніх 7 днів.</p>']
    for title, head, data in rows:
        parts.append(f'<h3 style="font-family:system-ui">{html.escape(title)}</h3>')
        parts.append('<table style="border-collapse:collapse;font-family:system-ui;font-size:14px">')
        parts.append('<tr>' + ''.join(f'<th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 10px">{html.escape(h)}</th>' for h in head) + '</tr>')
        for r in data or [['—']]:
            parts.append('<tr>' + ''.join(f'<td style="border-bottom:1px solid #eee;padding:4px 10px">{html.escape(x)}</td>' for x in r) + '</tr>')
        parts.append('</table>')
    parts.append('<p style="font-family:system-ui;color:#777;font-size:12px">Джерело: лог nginx (Referer і User-Agent, без перевірки IP ботів).</p>')
    return '\n'.join(parts)


def send(subject, text, html_body):
    m = EmailMessage()
    m['From'] = os.environ.get('MAIL_FROM', 'vladimir@legal.org.ua')
    m['To'] = os.environ.get('MAIL_TO', 'vladimir@legal.org.ua')
    m['Subject'] = subject
    m['Date'] = formatdate(localtime=True)
    m['Message-ID'] = make_msgid(domain=m['From'].split('@')[1])
    m.set_content(text + '\n')
    m.add_alternative(html_body, subtype='html')
    creds = {}
    env_file = os.environ.get('SMTP_ENV_FILE', os.path.expanduser('~/.acs-smtp.env'))
    if env_file and os.path.exists(env_file):
        for line in open(env_file):  # KEY=VALUE; never printed
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.rstrip('\n').split('=', 1)
                creds[k.strip()] = v.strip().strip('"').strip("'")
    with smtplib.SMTP(os.environ.get('SMTP_HOST', 'smtp.azurecomm.net'), int(os.environ.get('SMTP_PORT', '587')), timeout=30) as s:
        s.ehlo('cthulhu')
        if creds.get('ACS_SMTP_USER'):
            s.starttls()
            s.ehlo('cthulhu')
            s.login(creds['ACS_SMTP_USER'], creds['ACS_SMTP_PASS'])
        s.send_message(m)
    print('sent:', m['Message-ID'], 'to', m['To'])


def main():
    end = dt.date.today()  # today excluded: the day is not over
    mid = end - dt.timedelta(days=7)
    start = mid - dt.timedelta(days=7)
    c, urls = collect(read_log(), start, mid, end)
    period, rows = build(c, urls, mid, end)
    text = render_text(period, rows)
    if os.environ.get('DRY_RUN'):
        print(text)
        return 0
    send(f'SEO legal.org.ua: тиждень {period}', text, render_html(period, rows))
    return 0


if __name__ == '__main__':
    sys.exit(main())
