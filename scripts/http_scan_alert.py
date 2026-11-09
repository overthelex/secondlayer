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

Звіт ділиться на дві частини, бо боти з 100 % 403 (їх уже зарізав WAF) не варті негайного листа:
  ТЕРМІНОВО (OUT_DIR/urgent.html) — є акаунт з цього IP, або сканерний шлях отримав 2xx,
                                     або запити на нестандартні порти;
  ТИХО     (OUT_DIR/quiet.html)  — решта; аларм складає їх у добовий дайджест.
Автоблок (AUTO_BLOCK=1): IP без акаунта з >= AUTO_BLOCK_HITS влучань блокується через
CF_BLOCK_CMD (scripts/cf-block-ip.sh); rule id і дата пишуться в AUTO_BLOCK_STATE, через
AUTO_BLOCK_DAYS блок знімається (--unblock). Ніколи не блокує IP з акаунтом і мережі з
AUTO_BLOCK_NEVER (за замовчуванням — егреси Cloudflare WARP, бо вони спільні для багатьох людей).

Stdout: один рядок "<urgent> <quiet>" (кількості IP). Код виходу 0; при помилці Cloudflare — 1
і текст у stderr (аларм тоді надсилає решту секцій і пише попередження в лог).

Env: CLOUDFLARE_GLOBAL_API_KEY, CLOUDFLARE_EMAIL (з .env.cloudflare), CF_ZONE_ID
     (legal.org.ua за замовчуванням), SINCE, NOW, OUT_DIR, SCAN_MIN_HITS (3),
     PROBE_MIN_PATHS (20), PSQL_CMD (команда psql для збагачення; порожньо = без збагачення),
     AUTO_BLOCK (0), AUTO_BLOCK_HITS (20), AUTO_BLOCK_DAYS (7), AUTO_BLOCK_STATE
     (~/.cf-autoblock.json), AUTO_BLOCK_NEVER (CIDR через кому), CF_BLOCK_CMD (cf-block-ip.sh
     поруч зі скриптом), DRY_RUN=1 — не блокувати, лише позначити «заблокував би».
"""
from __future__ import annotations

import html
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ZONE = os.environ.get("CF_ZONE_ID", "9318befc0707ebccefbcac28128720d2")
SCAN_MIN_HITS = int(os.environ.get("SCAN_MIN_HITS", "3"))
PROBE_MIN_PATHS = int(os.environ.get("PROBE_MIN_PATHS", "20"))
AUTO_BLOCK = os.environ.get("AUTO_BLOCK", "0") == "1"
AUTO_BLOCK_HITS = int(os.environ.get("AUTO_BLOCK_HITS", "20"))
AUTO_BLOCK_DAYS = int(os.environ.get("AUTO_BLOCK_DAYS", "7"))
AUTO_BLOCK_STATE = Path(os.environ.get("AUTO_BLOCK_STATE") or Path.home() / ".cf-autoblock.json")
CF_BLOCK_CMD = os.environ.get("CF_BLOCK_CMD") or str(HERE / "cf-block-ip.sh")
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"
# Егреси Cloudflare WARP / Workers: спільні адреси, блок зачепить сторонніх людей.
AUTO_BLOCK_NEVER = [ipaddress.ip_network(x.strip()) for x in
                    os.environ.get("AUTO_BLOCK_NEVER", "104.28.0.0/16,2a06:98c0::/29,2a09:bac0::/29").split(",")
                    if x.strip()]

# SQL-LIKE шаблони для clientRequestPath_like (регістр як у запиті).
SCAN_PATTERNS = [
    "%/.env%", "%/.git%", "%/.aws%", "%/.ssh%", "%/.svn%", "%/.DS_Store", "%/.npmrc", "%/.htaccess",
    "%/.docker%", "%/.vscode%", "%/.idea%", "%/.claude%", "%/.cursor%",
    "%/actuator%", "%swagger%", "%/api-docs%", "%/v3/api-docs%", "%/openapi.%",
    "%phpinfo%", "%.php", "%/wp-%", "%/xmlrpc%", "%/phpmyadmin%", "%/cgi-bin/%",
    "%.sql", "%.bak", "%.tfstate", "%credentials%", "%id_rsa%", "%service_account%",
    "%/server-status", "%/server-info", "%docker-compose%", "%/config.yaml", "%/config.yml", "%/.config%",
    "%/_profiler%", "%/telescope%", "%/console/%", "%/vendor/%", "%/backup%", "%/dump%", "%/storage/logs%",
]


def iso(s: str) -> str:
    """GraphQL Time: без мікросекунд, у форматі YYYY-MM-DDTHH:MM:SSZ."""
    s = s.strip().replace("+00:00", "Z")
    if "." in s:
        s = s.split(".")[0] + "Z"
    return s


def gql(query: str) -> list[dict]:
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


# ---- автоблок -----------------------------------------------------------------------------

def load_state() -> dict:
    try:
        return json.loads(AUTO_BLOCK_STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    if DRY_RUN:
        return
    tmp = AUTO_BLOCK_STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1, ensure_ascii=False))
    tmp.replace(AUTO_BLOCK_STATE)


def cf_block(ip: str, note: str) -> str | None:
    """Повертає rule id або None."""
    if DRY_RUN:
        return "dry-run"
    try:
        out = subprocess.run([CF_BLOCK_CMD, ip, note], capture_output=True, text=True, timeout=60)
    except Exception as e:  # noqa: BLE001
        print(f"автоблок {ip}: {e}", file=sys.stderr)
        return None
    m = re.search(r"rule id ([0-9a-f]{32})", out.stdout)
    if out.returncode != 0 or not m:
        print(f"автоблок {ip} не вдався: {out.stdout.strip()} {out.stderr.strip()}"[:300], file=sys.stderr)
        return None
    return m.group(1)


def cf_unblock(rule_id: str) -> bool:
    if DRY_RUN:
        return True
    try:
        out = subprocess.run([CF_BLOCK_CMD, "--unblock", rule_id], capture_output=True, text=True, timeout=60)
        return out.returncode == 0 and "ok" in out.stdout
    except Exception as e:  # noqa: BLE001
        print(f"зняти блок {rule_id}: {e}", file=sys.stderr)
        return False


def expire_blocks(state: dict, now_dt: datetime) -> list[str]:
    """Знімає автоблоки, старші за AUTO_BLOCK_DAYS; повертає список знятих IP."""
    freed = []
    for ip, rec in list(state.items()):
        try:
            created = datetime.fromisoformat(rec["created"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if now_dt - created >= timedelta(days=AUTO_BLOCK_DAYS):
            if rec.get("rule_id") in (None, "dry-run") or cf_unblock(rec["rule_id"]):
                freed.append(ip)
                del state[ip]
    return freed


def never_block(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return any(a in n for n in AUTO_BLOCK_NEVER)


# ---- звіт ---------------------------------------------------------------------------------

def table(rows: list[tuple]) -> str:
    e = html.escape
    out = ["<table border=\"1\">", "  <tr>"]
    for h in ("ip", "країна", "акаунти з цього IP (7 дн.)", "ознаки", "статуси CF", "дія",
              "шляхи (приклади)", "user_agent"):
        out.append(f"    <th align=\"center\">{h}</th>")
    out.append("  </tr>")
    for ip, p, reasons, action in rows[:50]:
        sample = p["paths"][:8] or sorted(p["probe_paths"])[:8]
        st = ", ".join(f"{k}×{v}" for k, v in sorted(p["status"].items()))
        out += ["  <tr valign=\"top\">",
                f"    <td align=\"left\">{e(ip)}</td>",
                f"    <td align=\"left\">{e(', '.join(sorted(p['country'])))}</td>",
                f"    <td align=\"left\">{e(p['emails'] or '—')}</td>",
                f"    <td align=\"left\">{e('; '.join(reasons))}</td>",
                f"    <td align=\"left\">{e(st or '—')}</td>",
                f"    <td align=\"left\">{e(action)}</td>",
                f"    <td align=\"left\">{e(' '.join(sample))}</td>",
                f"    <td align=\"left\">{e(' | '.join(sorted(p['ua']))[:120])}</td>",
                "  </tr>"]
    out.append("</table>")
    return "\n".join(out)


def main() -> int:
    now = iso(os.environ.get("NOW") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    now_dt = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    since = iso(os.environ.get("SINCE") or "")
    if not since:
        since = (now_dt - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Аналітика Cloudflare на Free зберігається обмежено; довше за добу назад не дивимось.
    floor = (now_dt - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if since < floor:
        since = floor
    out_dir = Path(os.environ.get("OUT_DIR") or ".")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "urgent.html").write_text("")
    (out_dir / "quiet.html").write_text("")

    state = load_state() if AUTO_BLOCK else {}
    freed = expire_blocks(state, now_dt) if AUTO_BLOCK else []
    if freed:
        print(f"знято автоблоки старші за {AUTO_BLOCK_DAYS} дн.: {', '.join(freed)}", file=sys.stderr)

    if since >= now:
        if AUTO_BLOCK:
            save_state(state)
        print("0 0")
        return 0

    ors = ", ".join(f'{{clientRequestPath_like:"{p}"}}' for p in SCAN_PATTERNS)
    ors += ', {clientRequestHTTPHost_like:"%:8%"}'
    scan = groups(since, now, f", OR:[{ors}]",
                  "clientIP clientCountryName clientRequestHTTPHost clientRequestPath edgeResponseStatus userAgent", 2000)
    probe = groups(since, now, ", edgeResponseStatus_in:[403,404]",
                   "clientIP clientRequestPath edgeResponseStatus", 5000)

    per = defaultdict(lambda: {"hits": 0, "paths": [], "status": Counter(), "country": set(), "emails": "",
                               "hosts": set(), "ua": set(), "probe_paths": set(), "ok2xx": 0})
    for g in scan:
        d = g["dimensions"]; p = per[d["clientIP"]]
        p["hits"] += g["count"]
        p["status"][d["edgeResponseStatus"]] += g["count"]
        if 200 <= d["edgeResponseStatus"] < 300:
            p["ok2xx"] += g["count"]
        p["country"].add(d["clientCountryName"])
        p["hosts"].add(d["clientRequestHTTPHost"])
        p["ua"].add(d["userAgent"][:60])
        if d["clientRequestPath"] not in p["paths"]:
            p["paths"].append(d["clientRequestPath"])
    for g in probe:
        d = g["dimensions"]; p = per[d["clientIP"]]
        p["probe_paths"].add(d["clientRequestPath"])

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
            flagged.append((ip, p, reasons, bool(alt)))

    emails = enrich([f[0] for f in flagged])
    urgent, quiet = [], []
    for ip, p, reasons, alt in sorted(flagged, key=lambda f: f[1]["hits"] + len(f[1]["probe_paths"]), reverse=True):
        p["emails"] = emails.get(ip, "")
        if p["ok2xx"]:
            reasons.append(f"пройшло повз WAF: {p['ok2xx']} × 2xx")
        action = "—"
        if ip in state:
            action = f"вже в автоблоці з {state[ip].get('created', '?')[:10]}"
        elif AUTO_BLOCK and not p["emails"] and p["hits"] >= AUTO_BLOCK_HITS:
            if never_block(ip):
                action = "не блокую: спільна мережа (WARP/Workers)"
            else:
                rid = cf_block(ip, f"{now[:10]} autoblock: {p['hits']} scanner hits, {', '.join(sorted(p['country']))}")
                if rid:
                    state[ip] = {"rule_id": rid, "created": now, "hits": p["hits"]}
                    action = "АВТОБЛОК у Cloudflare" + (" (dry-run)" if DRY_RUN else "")
                else:
                    action = "автоблок не вдався, див. лог"
        is_urgent = bool(p["emails"]) or p["ok2xx"] > 0 or alt
        (urgent if is_urgent else quiet).append((ip, p, reasons, action))

    if AUTO_BLOCK:
        save_state(state)
    if urgent:
        (out_dir / "urgent.html").write_text(table(urgent))
    if quiet:
        (out_dir / "quiet.html").write_text(table(quiet))
    print(len(urgent), len(quiet))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"http_scan_alert: {exc}", file=sys.stderr)
        sys.exit(1)
