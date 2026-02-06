#!/bin/bash
##############################################################################
# Migrate User Billing (USD) to Credits System
# Converts all user_billing.balance_usd to user_credits.balance
##############################################################################

set -e

# Configuration
CONTAINER_NAME="${CONTAINER_NAME:-stage-secondlayer-postgres}"
CONVERSION_RATE="${CONVERSION_RATE:-1.0}"
DRY_RUN="${DRY_RUN:-true}"

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

# Print usage
usage() {
    cat << EOF
Migrate User Billing to Credits

Usage: $0 [OPTIONS]

Options:
  --container NAME     PostgreSQL container name (default: stage-secondlayer-postgres)
  --rate RATE         Conversion rate: 1 USD = RATE credits (default: 1.0)
  --dry-run           Show what would be migrated without making changes (default)
  --execute           Actually execute the migration
  --help              Show this help message

Examples:
  # Dry run (preview)
  $0 --dry-run

  # Execute migration with 1:1 conversion (1 USD = 1 credit)
  $0 --execute

  # Execute with custom conversion rate (1 USD = 10 credits)
  $0 --execute --rate 10.0

  # Execute on different environment
  $0 --execute --container prod-secondlayer-postgres

EOF
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --container)
            CONTAINER_NAME="$2"
            shift 2
            ;;
        --rate)
            CONVERSION_RATE="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --execute)
            DRY_RUN=false
            shift
            ;;
        --help)
            usage
            ;;
        *)
            print_msg "$RED" "Unknown option: $1"
            usage
            ;;
    esac
done

print_msg "$BLUE" ""
print_msg "$BLUE" "════════════════════════════════════════════════════════════════"
print_msg "$BLUE" "  Migrate User Billing (USD) → Credits"
print_msg "$BLUE" "════════════════════════════════════════════════════════════════"
print_msg "$BLUE" ""
print_msg "$BLUE" "Configuration:"
print_msg "$BLUE" "  Container: $CONTAINER_NAME"
print_msg "$BLUE" "  Conversion Rate: 1 USD = $CONVERSION_RATE credits"

if [ "$DRY_RUN" = true ]; then
    print_msg "$YELLOW" "  Mode: DRY RUN (no changes will be made)"
else
    print_msg "$GREEN" "  Mode: EXECUTE (will migrate balances)"
fi

print_msg "$BLUE" ""
print_msg "$BLUE" "════════════════════════════════════════════════════════════════"
print_msg "$BLUE" ""

# Check if container exists
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_msg "$RED" "❌ Container '$CONTAINER_NAME' not found or not running"
    print_msg "$YELLOW" "Available containers:"
    docker ps --format "  - {{.Names}}"
    exit 1
fi

# Confirmation for execute mode
if [ "$DRY_RUN" = false ]; then
    print_msg "$YELLOW" "⚠️  WARNING: This will modify the database!"
    print_msg "$YELLOW" "   - Convert all USD balances to credits"
    print_msg "$YELLOW" "   - Zero out user_billing.balance_usd"
    print_msg "$YELLOW" "   - Create transaction records"
    print_msg "$YELLOW" ""
    read -p "Are you sure you want to continue? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        print_msg "$RED" "Migration cancelled"
        exit 1
    fi
    print_msg "$GREEN" ""
    print_msg "$GREEN" "Starting migration..."
    print_msg "$GREEN" ""
fi

# Execute migration
docker exec -i "$CONTAINER_NAME" psql -U secondlayer -d secondlayer_db <<EOF
-- Execute migration function
SELECT
  user_id,
  email,
  old_balance_usd AS "Old USD",
  new_credits AS "New Credits",
  status,
  message
FROM migrate_user_billing_to_credits($CONVERSION_RATE, $DRY_RUN)
ORDER BY old_balance_usd DESC;

-- Show summary
DO \$\$
DECLARE
  v_migrated INTEGER;
  v_pending INTEGER;
  v_total_credits DECIMAL;
BEGIN
  SELECT COUNT(*) INTO v_migrated
  FROM billing_migration_log
  WHERE status = 'success';

  SELECT COUNT(*) INTO v_pending
  FROM user_billing
  WHERE balance_usd > 0;

  SELECT SUM(balance) INTO v_total_credits
  FROM user_credits;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  Migration Summary';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'Users migrated: %', COALESCE(v_migrated, 0);
  RAISE NOTICE 'Users pending: %', COALESCE(v_pending, 0);
  RAISE NOTICE 'Total credits in system: %', COALESCE(v_total_credits, 0);
  RAISE NOTICE '';

  IF $DRY_RUN THEN
    RAISE NOTICE '⚠️  DRY RUN - No changes were made';
    RAISE NOTICE '';
    RAISE NOTICE 'To execute migration:';
    RAISE NOTICE '  ./migrate-billing-to-credits.sh --execute';
  ELSE
    RAISE NOTICE '✅ Migration completed successfully!';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
END \$\$;
EOF

if [ "$DRY_RUN" = true ]; then
    print_msg "$YELLOW" ""
    print_msg "$YELLOW" "This was a dry run. To execute the migration:"
    print_msg "$YELLOW" "  $0 --execute"
    print_msg "$YELLOW" ""
else
    print_msg "$GREEN" ""
    print_msg "$GREEN" "✅ Migration completed!"
    print_msg "$GREEN" ""
    print_msg "$GREEN" "You can verify the migration with:"
    print_msg "$GREEN" "  docker exec -i $CONTAINER_NAME psql -U secondlayer -d secondlayer_db -c 'SELECT * FROM billing_migration_status;'"
    print_msg "$GREEN" ""
fi
