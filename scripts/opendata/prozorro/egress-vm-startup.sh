#!/bin/bash
# Startup script for a ProZorro egress proxy VM (LEXAI-2227): tinyproxy on
# 127.0.0.1:8888, HTTPS CONNECT only, reached through egress-tunnels.sh.
set -e
if ! command -v tinyproxy >/dev/null; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q tinyproxy; fi
cat > /etc/tinyproxy/tinyproxy.conf <<'CONF'
User tinyproxy
Group tinyproxy
Port 8888
Listen 127.0.0.1
Timeout 600
MaxClients 200
Allow 127.0.0.1
ConnectPort 443
LogLevel Warning
CONF
systemctl restart tinyproxy
