#!/bin/bash
# Keeps SSH tunnels from cthulhu to the ProZorro egress proxies (LEXAI-2227).
#
# Each proxy VM runs tinyproxy on its own 127.0.0.1:8888; the tunnel publishes it
# on the docker bridge gateway, so the backfill inside openreyestr-app-local can
# use it as http://<gateway>:<port>. One line per VM in $HOSTS: "<local port> <ip>".
#
#   */2 * * * * ~/SecondLayer/scripts/opendata/prozorro/egress-tunnels.sh
set -uo pipefail
HOSTS=${HOSTS:-$HOME/prozorro-egress/hosts}
KEY=${KEY:-$HOME/lawrider/pl-egress.key}
BIND=${BIND:-172.18.0.1}

[ -f "$HOSTS" ] || exit 0
while read -r port ip; do
  [ -z "${port:-}" ] || [ "${port:0:1}" = "#" ] && continue
  pgrep -f "^ssh .*-L $BIND:$port:127.0.0.1:8888 " >/dev/null && continue
  ssh -f -N -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
    -L "$BIND:$port:127.0.0.1:8888" "egress@$ip" \
    && echo "[$(date -u +%FT%TZ)] tunnel $port -> $ip up"
done < "$HOSTS"
