#!/bin/bash

# SecondLayer Payment System - SSL Certificate Renewal Script
# Run this script periodically (via cron) to renew Let's Encrypt certificates
# Let's Encrypt certificates expire after 90 days

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="./certbot/renewal.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$DATE] Starting certificate renewal check..." | tee -a "$LOG_FILE"

# Attempt to renew certificates
# Certbot will only renew if certificates are due for renewal (< 30 days remaining)
docker-compose run --rm certbot renew 2>&1 | tee -a "$LOG_FILE"

RENEWAL_EXIT_CODE=${PIPESTATUS[0]}

if [ $RENEWAL_EXIT_CODE -eq 0 ]; then
    echo "[$DATE] Certificate renewal check completed successfully" | tee -a "$LOG_FILE"

    # Reload nginx to use new certificates
    echo "[$DATE] Reloading nginx..." | tee -a "$LOG_FILE"
    docker-compose exec payment-frontend nginx -s reload 2>&1 | tee -a "$LOG_FILE"

    if [ $? -eq 0 ]; then
        echo "[$DATE] Nginx reloaded successfully" | tee -a "$LOG_FILE"
    else
        echo "[$DATE] WARNING: Failed to reload nginx" | tee -a "$LOG_FILE"
        # Restart nginx as fallback
        echo "[$DATE] Restarting nginx container..." | tee -a "$LOG_FILE"
        docker-compose restart payment-frontend 2>&1 | tee -a "$LOG_FILE"
    fi
else
    echo "[$DATE] ERROR: Certificate renewal failed with exit code $RENEWAL_EXIT_CODE" | tee -a "$LOG_FILE"
    exit $RENEWAL_EXIT_CODE
fi

echo "[$DATE] Certificate renewal process complete" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
