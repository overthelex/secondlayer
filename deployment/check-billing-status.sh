#!/bin/bash
##############################################################################
# Check Billing and Credits Status
# Shows current state of user_billing and user_credits for all users
##############################################################################

set -e

# Configuration
CONTAINER_NAME="${CONTAINER_NAME:-stage-secondlayer-postgres}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_msg() {
    local color=$1
    shift
    echo -e "${color}$@${NC}"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --container)
            CONTAINER_NAME="$2"
            shift 2
            ;;
        --help)
            cat << EOF
Check Billing and Credits Status

Usage: $0 [OPTIONS]

Options:
  --container NAME     PostgreSQL container name (default: stage-secondlayer-postgres)
  --help              Show this help message

Examples:
  # Check stage environment
  $0

  # Check production
  $0 --container prod-secondlayer-postgres

EOF
            exit 0
            ;;
        *)
            print_msg "$RED" "Unknown option: $1"
            exit 1
            ;;
    esac
done

print_msg "$BLUE" ""
print_msg "$BLUE" "════════════════════════════════════════════════════════════════"
print_msg "$BLUE" "  Billing & Credits Status Report"
print_msg "$BLUE" "════════════════════════════════════════════════════════════════"
print_msg "$BLUE" ""

# Check if container exists
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_msg "$RED" "❌ Container '$CONTAINER_NAME' not found or not running"
    exit 1
fi

# Execute status queries
docker exec -i "$CONTAINER_NAME" psql -U secondlayer -d secondlayer_db <<'EOF'
\set QUIET on
\pset border 2
\pset format wrapped

-- Overall summary
\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  SYSTEM SUMMARY'
\echo '════════════════════════════════════════════════════════════════'
\echo ''

SELECT
  'Total Users' AS metric,
  COUNT(*) AS value
FROM users
UNION ALL
SELECT
  'Users with USD Balance',
  COUNT(*)
FROM user_billing
WHERE balance_usd > 0
UNION ALL
SELECT
  'Users with Credits',
  COUNT(*)
FROM user_credits
WHERE balance > 0
UNION ALL
SELECT
  'Migrated Users',
  COUNT(*)
FROM billing_migration_log
WHERE status = 'success'
UNION ALL
SELECT
  'Pending Migration',
  COUNT(*)
FROM user_billing
WHERE balance_usd > 0
  AND user_id NOT IN (SELECT user_id FROM billing_migration_log WHERE status = 'success');

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  USER BALANCES'
\echo '════════════════════════════════════════════════════════════════'
\echo ''

SELECT
  u.email,
  LEFT(u.id::TEXT, 8) || '...' AS user_id,
  COALESCE(ub.balance_usd, 0) AS "USD Balance",
  COALESCE(uc.balance, 0) AS "Credit Balance",
  CASE
    WHEN ml.status = 'success' THEN '✅ Migrated'
    WHEN ub.balance_usd > 0 THEN '⚠️  Pending'
    WHEN uc.balance > 0 THEN '✨ Credits Only'
    ELSE '📭 Empty'
  END AS status,
  ml.migrated_at AS "Migrated At"
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id
LEFT JOIN user_credits uc ON u.id = uc.user_id
LEFT JOIN billing_migration_log ml ON u.id = ml.user_id
ORDER BY ub.balance_usd DESC NULLS LAST, uc.balance DESC NULLS LAST;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  CHATGPT OAUTH USER STATUS'
\echo '════════════════════════════════════════════════════════════════'
\echo ''

SELECT
  u.email,
  u.id AS user_id,
  COALESCE(ub.balance_usd, 0) AS "USD Balance",
  COALESCE(uc.balance, 0) AS "Credit Balance",
  COALESCE(uc.total_earned, 0) AS "Total Earned",
  COALESCE(uc.total_spent, 0) AS "Total Spent",
  -- Check if user can make a tool call
  (SELECT has_credits FROM check_user_balance(u.id, 1)) AS "Can Use Tools?",
  -- Last credit transaction
  (SELECT transaction_type || ' (' || amount || ')'
   FROM credit_transactions
   WHERE user_id = u.id
   ORDER BY created_at DESC
   LIMIT 1) AS "Last Transaction"
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id
LEFT JOIN user_credits uc ON u.id = uc.user_id
WHERE u.id = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  MIGRATION LOG (Last 10)'
\echo '════════════════════════════════════════════════════════════════'
\echo ''

SELECT
  u.email,
  LEFT(ml.user_id::TEXT, 8) || '...' AS user_id,
  ml.old_balance_usd AS "Old USD",
  ml.new_credits AS "New Credits",
  ml.status,
  ml.migrated_at AS "Migrated At"
FROM billing_migration_log ml
JOIN users u ON ml.user_id = u.id
ORDER BY ml.migrated_at DESC
LIMIT 10;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '  RECENT CREDIT TRANSACTIONS (Last 10)'
\echo '════════════════════════════════════════════════════════════════'
\echo ''

SELECT
  u.email,
  LEFT(ct.user_id::TEXT, 8) || '...' AS user_id,
  ct.transaction_type AS type,
  ct.amount,
  ct.balance_after AS "Balance After",
  ct.source,
  LEFT(ct.description, 40) || '...' AS description,
  ct.created_at AS "Created At"
FROM credit_transactions ct
JOIN users u ON ct.user_id = u.id
ORDER BY ct.created_at DESC
LIMIT 10;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo ''
EOF

print_msg "$GREEN" "Report complete!"
print_msg "$BLUE" ""
