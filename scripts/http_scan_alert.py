#!/usr/bin/env python3
"""Детектор HTTP-сканування legal.org.ua по аналітиці Cloudflare (scripts/mcp-security-alert.sh).

Бекенд бачить лише MCP/REST-виклики, що дійшли до нього; сканер вразливостей, який
перебирає /.env, /.git/config, /.aws/credentials, swagger, actuator, phpinfo тощо, б'є у
фронтенд (SPA віддає index.html) або у WAF Cloudflare і в БД не лишає нічого. Тому це джерело —
GraphQL httpRequestsAdaptiveGroups зони.

За вікно SINCE..NOW (UTC, ISO) рахує по кожному клієнтському IP:
  1. влучання у сканерні шляхи (SCAN_PATTERNS) або запити на нестандартні порти (host з ":8");
  2. перебір: кількість РІЗНИХ шляхів з відповіддю 403/404.
IP потрапляє у звіт, якщо (1) >= SCAN_MIN_HITS або (2) >= PROBE_MIN_PATHS. Для кожного такого IP
шукає в БД (mcp_access_log, cost_tracking, audit_log за 7 днів) пов'язані акаунти.

Stdout: перший рядок — кількість IP у звіті, далі HTML-таблиця (формат psql -H, щоб
mcp_key_usage_mail.render_html її стилізував). Код виходу 0; при помилці Cloudflare — 1 і текст
у stderr (аларм тоді надсилає решту секцій і пише попередження в лог).

Env: CLOUDFLARE_GLOBAL_API_KEY, CLOUDFLARE_EMAIL (з .env.cloudflare), CF_ZONE_ID
     (legal.org.ua за замовчуванням), SINCE, NOW, SCAN_MIN_HITS (3), PROBE_MIN_PATHS (20),
     PSQL_CMD (команда psql для збагачення; порожньо = без збагачення).
"""
from __future__ import annotations

import html
import json
import os
import shlex
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ZONE = os.environ.get("CF_ZONE_ID", "9318befc0707ebccefbcac28128720d2")
SCAN_MIN_HITS = int(os.environ.get("SCAN_MIN_HITS", "3"))
PROBE_MIN_PATHS = int(os.environ.get("PROBE_MIN_PATHS", "20"))

# SQL-LIKE шаблони для clientRequestPath_like (регістр як у запиті).
SCAN_PATTERNS = [
    "%/.env%", "%/.git%", "%/.aws%", "%/.ssh%", "%/.svn%", "%/.DS_Store", "%/.npmrc", "%/.htaccess",
    "%/actuator%", "%swagger%", "%/api-docs%", "%/v3/api-docs%", "%/openapi.%",
    "%phpinfo%", "%.php", "%/wp-%", "%/xmlrpc%", "%/phpmyadmin%", "%/cgi-bin/%",
    "%.sql", "%.bak", "%.tfstate", "%credentials%", "%id_rsa%", "%service_account%",
    "%/server-status", "%docker-compose%", "%/config.yaml", "%/config.yml", "%/.config%",
    "%/_profiler%", "%/telescope%", "%/console/%", "%/vendor/%", "%/backup%", "%/dump%",
]


def iso(s: str) -> str:
    """GraphQL Time: без мікросекунд, у форматі YYYY-MM-DDTHH:MM:SSZ."""
    s = s.strip().replace("+00:00", "Z")
    if "." in s:
        s = s.split(".")[0] + "Z"
    return s


def gql(query: str) -> dict:
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={
            "X-Auth-Key": os.environ["CLOUDFLARE_GLOBAL_API_KEY"],
            "X-Auth-Email": os.environ["CLOUDFLARE_EMAIL"],
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if d.get("errors"):
        raise RuntimeError("Cloudflare GraphQL: " + d["errors"][0].get("message", "?")[:300])
    return d["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]


def groups(since: str, now: str, extra_filter: str, dims: str, limit: int) -> list[dict]:
    q = f"""{{viewer{{zones(filter:{{zoneTag:"{ZONE}"}}){{
      httpRequestsAdaptiveGroups(limit:{limit},
        filter:{{datetime_geq:"{since}", datetime_lt:"{now}" {extra_filter}}},
        orderBy:[count_DESC]) {{ count dimensions{{ {dims} }} }} }} }} }}"""
    return gql(q)


def enrich(ips: list[str]) -> dict[str, str]:
    """IP -> акаунти, що ходили з нього за 7 днів (mcp_access_log, cost_tracking, audit_log)."""
    cmd = os.environ.get("PSQL_CMD", "").strip()
    if not cmd or not ips:
        return {}
    lit = ",".join("'" + ip.replace("'", "") + "'" for ip in ips)
    sql = f"""
    WITH hits AS (
      SELECT l.client_ip AS ip, u.email FROM mcp_access_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.created_at > now() - interval '7 days' AND host(l.client_ip) IN ({lit})
      UNION ALL
      SELECT c.client_ip, u.email FROM cost_tracking c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.created_at > now() - interval '7 days' AND c.client_ip IS NOT NULL AND host(c.client_ip) IN ({lit})
      UNION ALL
      SELECT a.ip_address, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.created_at > now() - interval '7 days' AND a.ip_address IS NOT NULL AND host(a.ip_address) IN ({lit}))
    SELECT host(ip), string_agg(DISTINCT email, ', ') FROM hits WHERE email IS NOT NULL GROUP BY ip"""
    try:
        out = subprocess.run(shlex.split(cmd) + ["-tA", "-F", "\t", "-c", sql],
                             capture_output=True, text=True, timeout=60, check=True).stdout
    except Exception as e:  # збагачення не критичне
        print(f"збагачення з БД не вдалося: {e}", file=sys.stderr)
        return {}
    res = {}
    for line in out.splitlines():
        if "\t" in line:
            ip, emails = line.split("\t", 1)
            res[ip] = emails
    return res


def main() -> int:
    now = iso(os.environ.get("NOW") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    since = iso(os.environ.get("SINCE") or "")
    if not since:
        since = (datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Аналітика Cloudflare на Free зберігається обмежено; довше за добу назад не дивимось.
    floor = (datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if since < floor:
        since = floor
    if since >= now:
        print(0)
        return 0

    ors = ", ".join(f'{{clientRequestPath_like:"{p}"}}' for p in SCAN_PATTERNS)
    ors += ', {clientRequestHTTPHost_like:"%:8%"}'
    scan = groups(since, now, f", OR:[{ors}]",
                  "clientIP clientCountryName clientRequestHTTPHost clientRequestPath edgeResponseStatus userAgent", 2000)
    probe = groups(since, now, ", edgeResponseStatus_in:[403,404]",
                   "clientIP clientRequestPath edgeResponseStatus", 5000)

    per = defaultdict(lambda: {"hits": 0, "paths": [], "status": Counter(), "country": set(),
                               "hosts": set(), "ua": set(), "probe_paths": set(), "probe_n": 0})
    for g in scan:
        d = g["dimensions"]; p = per[d["clientIP"]]
        p["hits"] += g["count"]
        p["status"][d["edgeResponseStatus"]] += g["count"]
        p["country"].add(d["clientCountryName"])
        p["hosts"].add(d["clientRequestHTTPHost"])
        p["ua"].add(d["userAgent"][:60])
        if d["clientRequestPath"] not in p["paths"]:
            p["paths"].append(d["clientRequestPath"])
    for g in probe:
        d = g["dimensions"]; p = per[d["clientIP"]]
        p["probe_paths"].add(d["clientRequestPath"])
        p["probe_n"] += g["count"]

    flagged = []
    for ip, p in per.items():
        reasons = []
        if p["hits"] >= SCAN_MIN_HITS:
            reasons.append(f"сканерні шляхи: {p['hits']}")
        if len(p["probe_paths"]) >= PROBE_MIN_PATHS:
            reasons.append(f"перебір: {len(p['probe_paths'])} різних шляхів з 403/404")
        alt = sorted(h for h in p["hosts"] if ":" in h)
        if alt:
            reasons.append("порти " + ", ".join(h.split(":")[1] for h in alt))
        if reasons:
            flagged.append((p["hits"] + len(p["probe_paths"]), ip, p, reasons))
    flagged.sort(reverse=True)

    print(len(flagged))
    if not flagged:
        return 0

    emails = enrich([f[1] for f in flagged])
    e = html.escape
    rows = ["<table border=\"1\">", "  <tr>",
            "    <th align=\"center\">ip</th>", "    <th align=\"center\">країна</th>",
            "    <th align=\"center\">акаунти з цього IP (7 дн.)</th>", "    <th align=\"center\">ознаки</th>",
            "    <th align=\"center\">статуси CF</th>", "    <th align=\"center\">шляхи (приклади)</th>",
            "    <th align=\"center\">user_agent</th>", "  </tr>"]
    for _, ip, p, reasons in flagged[:50]:
        sample = p["paths"][:8] or sorted(p["probe_paths"])[:8]
        st = ", ".join(f"{k}×{v}" for k, v in sorted(p["status"].items()))
        rows += ["  <tr valign=\"top\">",
                 f"    <td align=\"left\">{e(ip)}</td>",
                 f"    <td align=\"left\">{e(', '.join(sorted(p['country'])))}</td>",
                 f"    <td align=\"left\">{e(emails.get(ip, '—'))}</td>",
                 f"    <td align=\"left\">{e('; '.join(reasons))}</td>",
                 f"    <td align=\"left\">{e(st or '—')}</td>",
                 f"    <td align=\"left\">{e(' '.join(sample))}</td>",
                 f"    <td align=\"left\">{e(' | '.join(sorted(p['ua']))[:120])}</td>",
                 "  </tr>"]
    rows.append("</table>")
    print("\n".join(rows))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"http_scan_alert: {exc}", file=sys.stderr)
        sys.exit(1)
