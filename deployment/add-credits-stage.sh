#!/bin/bash
##############################################################################
# Add Credits to ChatGPT OAuth User - Stage Environment
# Executes SQL directly in the stage PostgreSQL container
##############################################################################

set -e

# Configuration
USER_ID="abfa4cd8-61de-4908-a778-4d23c1574f0a"
CREDITS="${1:-100}"  # Default 100 credits, or pass as first argument
CONTAINER_NAME="stage-secondlayer-postgres"

echo "💳 Adding $CREDITS credits to ChatGPT user..."
echo "   User ID: $USER_ID"
echo "   Container: $CONTAINER_NAME"
echo ""

# Execute SQL in PostgreSQL container
docker exec -i "$CONTAINER_NAME" psql -U secondlayer -d secondlayer_db <<EOF
-- Check current balance
SELECT
  user_id,
  balance AS current_balance
FROM user_credits
WHERE user_id = '$USER_ID';

-- Add credits
SELECT
  success,
  new_balance,
  transaction_id
FROM add_credits(
  '$USER_ID'::uuid,
  $CREDITS,
  'bonus',
  'manual_grant',
  'chatgpt-fix-$(date +%Y%m%d)',
  'Credits added for ChatGPT MCP integration',
  NULL
);

-- Verify new balance
SELECT
  user_id,
  balance AS new_balance,
  total_earned,
  total_spent,
  updated_at
FROM user_credits
WHERE user_id = '$USER_ID';

-- Check if user can make tool calls
SELECT
  has_credits,
  current_balance,
  reason
FROM check_user_balance('$USER_ID'::uuid, 1);
EOF

echo ""
echo "✅ Credits added successfully!"
echo "🎉 ChatGPT user can now use MCP tools!"
