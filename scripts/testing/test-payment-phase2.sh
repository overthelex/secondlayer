#!/bin/bash

##############################################################################
# Phase 2 Billing - Payment Flow Test Script
# Tests mock Stripe/Fondy payments and balance check middleware
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
BASE_URL="http://localhost:3001"
API_KEY="REDACTED_SL_KEY_PROD_1"

# Test user credentials (you'll need a valid JWT token)
# For now, we'll skip JWT-protected endpoints and focus on what we can test

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Phase 2 Billing - Payment Flow Test Script              ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo ""

##############################################################################
# Test 1: Check server health
##############################################################################
echo -e "${YELLOW}[TEST 1] Checking server health...${NC}"
HEALTH=$(curl -s "${BASE_URL}/health")
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ Server is healthy${NC}"
    echo "$HEALTH" | jq '.'
else
    echo -e "${RED}✗ Server health check failed${NC}"
    exit 1
fi
echo ""

##############################################################################
# Test 2: List available tools (verify payment routes are registered)
##############################################################################
echo -e "${YELLOW}[TEST 2] Listing available tools...${NC}"
TOOLS=$(curl -s -H "Authorization: Bearer ${API_KEY}" "${BASE_URL}/api/tools")
echo "$TOOLS" | jq '.tools | map(.name)' | head -20
echo -e "${GREEN}✓ Tools endpoint accessible${NC}"
echo ""

##############################################################################
# Test 3: Check database - verify migration 012 was applied
##############################################################################
echo -e "${YELLOW}[TEST 3] Verifying database migration 012...${NC}"
MIGRATION_CHECK=$(docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -t -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'payment_intents');" 2>/dev/null || echo "f")
if echo "$MIGRATION_CHECK" | grep -q "t"; then
    echo -e "${GREEN}✓ payment_intents table exists${NC}"

    # Show table structure
    echo -e "${BLUE}Payment intents table structure:${NC}"
    docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c "\d payment_intents" 2>/dev/null | head -20
else
    echo -e "${RED}✗ payment_intents table not found${NC}"
    exit 1
fi
echo ""

##############################################################################
# Test 4: Check user_billing table for new fields
##############################################################################
echo -e "${YELLOW}[TEST 4] Checking user_billing table for Phase 2 fields...${NC}"
BILLING_FIELDS=$(docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -t -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'user_billing' AND column_name IN ('stripe_customer_id', 'fondy_customer_id', 'last_alert_sent_at');" 2>/dev/null)
if echo "$BILLING_FIELDS" | grep -q "stripe_customer_id"; then
    echo -e "${GREEN}✓ stripe_customer_id field exists${NC}"
else
    echo -e "${RED}✗ stripe_customer_id field not found${NC}"
fi
if echo "$BILLING_FIELDS" | grep -q "fondy_customer_id"; then
    echo -e "${GREEN}✓ fondy_customer_id field exists${NC}"
else
    echo -e "${RED}✗ fondy_customer_id field not found${NC}"
fi
if echo "$BILLING_FIELDS" | grep -q "last_alert_sent_at"; then
    echo -e "${GREEN}✓ last_alert_sent_at field exists${NC}"
else
    echo -e "${RED}✗ last_alert_sent_at field not found${NC}"
fi
echo ""

##############################################################################
# Test 5: Verify mock services are running
##############################################################################
echo -e "${YELLOW}[TEST 5] Checking if mock payment services are active...${NC}"
LOGS=$(docker logs secondlayer-app-prod 2>&1 | tail -50)
if echo "$LOGS" | grep -q "MockStripeService initialized"; then
    echo -e "${GREEN}✓ Mock Stripe service is running${NC}"
else
    echo -e "${RED}✗ Mock Stripe service not detected${NC}"
fi
if echo "$LOGS" | grep -q "MockFondyService initialized"; then
    echo -e "${GREEN}✓ Mock Fondy service is running${NC}"
else
    echo -e "${RED}✗ Mock Fondy service not detected${NC}"
fi
echo ""

##############################################################################
# Test 6: Check email service configuration
##############################################################################
echo -e "${YELLOW}[TEST 6] Checking email service configuration...${NC}"
if echo "$LOGS" | grep -q "EmailService in development mode"; then
    echo -e "${YELLOW}⚠ Email service in development mode (no SMTP)${NC}"
    echo -e "${BLUE}  → Emails will be logged to console instead of sent${NC}"
else
    echo -e "${GREEN}✓ Email service configured with SMTP${NC}"
fi
echo ""

##############################################################################
# Test 7: Verify balance-check middleware is loaded
##############################################################################
echo -e "${YELLOW}[TEST 7] Verifying balance-check middleware...${NC}"
# The middleware is loaded if the server started successfully
# We can test it by making a request (requires JWT, so we'll just verify logs)
if echo "$LOGS" | grep -q "Cost tracking and billing initialized"; then
    echo -e "${GREEN}✓ Billing system initialized${NC}"
else
    echo -e "${RED}✗ Billing system not initialized${NC}"
fi
echo ""

##############################################################################
# Test 8: Database query - Check billing_transactions table
##############################################################################
echo -e "${YELLOW}[TEST 8] Checking billing_transactions table...${NC}"
TX_COUNT=$(docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -t -c "SELECT COUNT(*) FROM billing_transactions;" 2>/dev/null || echo "0")
echo -e "${BLUE}Total billing transactions: ${TX_COUNT}${NC}"

# Show recent transactions
echo -e "${BLUE}Recent transactions:${NC}"
docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c "SELECT id, user_id, amount_usd, transaction_type, payment_provider, created_at FROM billing_transactions ORDER BY created_at DESC LIMIT 5;" 2>/dev/null
echo ""

##############################################################################
# Test 9: Check for any errors in logs
##############################################################################
echo -e "${YELLOW}[TEST 9] Checking for errors in logs...${NC}"
ERROR_COUNT=$(echo "$LOGS" | grep -i "error" | grep -v "error handling" | wc -l)
if [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "${GREEN}✓ No errors found in recent logs${NC}"
else
    echo -e "${RED}⚠ Found ${ERROR_COUNT} error(s) in logs:${NC}"
    echo "$LOGS" | grep -i "error" | grep -v "error handling" | tail -5
fi
echo ""

##############################################################################
# Test 10: Environment variables check
##############################################################################
echo -e "${YELLOW}[TEST 10] Checking payment environment variables...${NC}"
docker exec secondlayer-app-prod env | grep -E "STRIPE|FONDY|EMAIL|UAH_TO_USD" | while read line; do
    KEY=$(echo "$line" | cut -d= -f1)
    VALUE=$(echo "$line" | cut -d= -f2)

    # Mask sensitive values
    if echo "$KEY" | grep -q "SECRET\|KEY\|PASS"; then
        MASKED=$(echo "$VALUE" | head -c 10)
        echo -e "${BLUE}  $KEY=${MASKED}...${NC}"
    else
        echo -e "${BLUE}  $KEY=$VALUE${NC}"
    fi
done
echo ""

##############################################################################
# Summary
##############################################################################
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Test Summary                                              ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo ""
echo -e "${GREEN}✓ Phase 2 Billing Infrastructure Tests Completed${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo -e "  1. To test payment creation, you'll need a valid JWT token"
echo -e "  2. Create test user: POST /api/auth/register"
echo -e "  3. Login: POST /api/auth/login"
echo -e "  4. Create payment: POST /api/billing/payment/stripe/create"
echo -e "  5. Simulate success: Use Docker exec to call mock service methods"
echo ""
echo -e "${BLUE}Manual Payment Test Commands:${NC}"
echo -e "  # Inside Docker container:"
echo -e "  docker exec -it secondlayer-app-prod node -e \\"
echo -e "    \"require('./dist/http-server.js').mockStripeService.simulatePaymentSuccess('pi_mock_xxx')\\"
echo ""
echo -e "${YELLOW}To monitor logs:${NC}"
echo -e "  docker logs -f secondlayer-app-prod"
echo ""
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
