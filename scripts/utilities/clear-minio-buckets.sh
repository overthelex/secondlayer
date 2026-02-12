#!/usr/bin/env bash
# Clear all user buckets from MinIO storage.
# Usage:
#   ./scripts/utilities/clear-minio-buckets.sh              # local (localhost:9000)
#   ./scripts/utilities/clear-minio-buckets.sh dev           # dev   (localhost:9002)
#   ./scripts/utilities/clear-minio-buckets.sh stage         # stage (localhost:9004)
#
# Env overrides: MINIO_ENDPOINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY
#
# Requires: mc (MinIO Client) — https://min.io/docs/minio/linux/reference/minio-mc.html

set -euo pipefail

ENV="${1:-local}"

case "$ENV" in
  local) PORT="${MINIO_PORT:-9000}" ;;
  dev)   PORT="${MINIO_PORT:-9002}" ;;
  stage) PORT="${MINIO_PORT:-9004}" ;;
  *)     echo "Unknown env: $ENV (use local|dev|stage)"; exit 1 ;;
esac

ENDPOINT="${MINIO_ENDPOINT:-localhost}"
ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
ALIAS="minio_cleanup_$$"
URL="http://${ENDPOINT}:${PORT}"

# Check mc is installed
if ! command -v mc &>/dev/null; then
  echo "Error: 'mc' (MinIO Client) is not installed."
  echo "Install: https://min.io/docs/minio/linux/reference/minio-mc.html"
  exit 1
fi

# Register temp alias
mc alias set "$ALIAS" "$URL" "$ACCESS_KEY" "$SECRET_KEY" --api S3v4 >/dev/null 2>&1

cleanup() { mc alias remove "$ALIAS" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# List user buckets (pattern: user-*)
BUCKETS=$(mc ls "$ALIAS" 2>/dev/null | awk '{print $NF}' | sed 's:/$::' | grep '^user-' || true)

if [ -z "$BUCKETS" ]; then
  echo "No user buckets found on $URL"
  exit 0
fi

COUNT=$(echo "$BUCKETS" | wc -l)
echo "Found $COUNT user bucket(s) on $URL:"
echo "$BUCKETS" | sed 's/^/  - /'
echo ""
read -rp "Delete all $COUNT bucket(s)? [y/N] " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

DELETED=0
FAILED=0
for BUCKET in $BUCKETS; do
  echo -n "Deleting $BUCKET ... "
  if mc rb --force "$ALIAS/$BUCKET" >/dev/null 2>&1; then
    echo "ok"
    ((DELETED++))
  else
    echo "FAILED"
    ((FAILED++))
  fi
done

echo ""
echo "Done: $DELETED deleted, $FAILED failed."
