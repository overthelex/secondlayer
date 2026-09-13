#!/bin/sh
# Healthcheck for nginx-local: syntax + real upstream reachability, with self-heal.
#
# `nginx -t` alone is not a healthcheck. Nginx resolves upstream host names ONCE,
# when the config is loaded, so a recreated backend container (new IP in the compose
# network) leaves nginx dialling a dead address. The config stays syntactically
# perfect, the container keeps reporting "healthy", and every backend path answers
# 502 while the frontend, whose container was not recreated, still answers 200.
# That is exactly what happened 11-13.09.2026: mcp.legal.org.ua returned 502 to
# every MCP client for two days, and nothing in the stack noticed.
#
# So: probe the backend through nginx itself, and when the upstream addresses have
# moved, reload — a reload re-resolves every name in the upstream blocks.

set -u

UPSTREAMS=/etc/nginx/includes/local-upstreams.conf
STATE=/tmp/nginx-upstream-addrs
PROBE_HOST=legal.org.ua
PROBE_URL=http://127.0.0.1/health

nginx -t 2>/dev/null || exit 1

# Current address of every host named in the upstream blocks. Read from the file
# rather than hardcoded, because the deploy rewrites it when it switches colour.
current_addrs() {
    sed -n 's/^[[:space:]]*server[[:space:]]\+\([^:;[:space:]]\+\).*/\1/p' "$UPSTREAMS" \
        | sort -u \
        | while read -r host; do
              addr=$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
              [ -n "$addr" ] && echo "$host=$addr"
          done
}

ADDRS=$(current_addrs)

# No resolution at all means Docker DNS is unhappy, not that the upstreams moved.
# Leave the recorded state alone and let the probe below decide the verdict.
if [ -n "$ADDRS" ]; then
    if [ ! -f "$STATE" ]; then
        # First run after (re)start: nginx just resolved these itself, so record
        # them as the baseline instead of reloading a freshly loaded config.
        echo "$ADDRS" > "$STATE"
    elif [ "$ADDRS" != "$(cat "$STATE")" ]; then
        echo "nginx-healthcheck: upstream addresses changed, reloading" >&2
        nginx -s reload 2>/dev/null || exit 1
        echo "$ADDRS" > "$STATE"
        sleep 2
    fi
fi

# The verdict: can nginx actually reach the backend? /health is proxied to the
# backend upstream, so a 200 here means the whole path works. Reporting unhealthy
# when the backend itself is down is intended — that outage should be visible.
wget -q -O /dev/null --timeout=5 --header="Host: ${PROBE_HOST}" "$PROBE_URL" || exit 1
