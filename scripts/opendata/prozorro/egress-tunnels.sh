#!/bin/bash
# Keeps one autossh sidecar per ProZorro egress proxy VM (LEXAI-2227).
#
# Each VM runs tinyproxy on its own 127.0.0.1:8888. The sidecar container
# pz-egress-<id> joins the openreyestr docker network and forwards its :8888 to
# that tinyproxy, so the backfill inside openreyestr-app-local uses the lane
# http://pz-egress-<id>:8888. (A tunnel bound on the host is not reachable from
# the containers: the host firewall drops it.) One line per VM in $HOSTS:
# "<id> <ip>". Idempotent; run it after editing $HOSTS or from cron.
#
#   */5 * * * * ~/SecondLayer/scripts/opendata/prozorro/egress-tunnels.sh
set -uo pipefail
HOSTS=${HOSTS:-$HOME/prozorro-egress/hosts}
KEY=${KEY:-$HOME/lawrider/pl-egress.key}
NETWORK=${NETWORK:-deployment_secondlayer-local}

[ -f "$HOSTS" ] || exit 0
while read -r id ip; do
  [ -z "${id:-}" ] || [ "${id:0:1}" = "#" ] && continue
  name="pz-egress-$id"
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] && continue
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" --restart unless-stopped --network "$NETWORK" \
    -v "$KEY:/run/egress.key:ro" alpine:3.20 sh -c \
    "apk add --no-cache openssh-client autossh >/dev/null && cp /run/egress.key /tmp/k && chmod 600 /tmp/k && \
     exec autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
     -o ExitOnForwardFailure=yes -i /tmp/k -L 0.0.0.0:8888:127.0.0.1:8888 egress@$ip" >/dev/null \
    && echo "[$(date -u +%FT%TZ)] $name -> $ip started"
done < "$HOSTS"
