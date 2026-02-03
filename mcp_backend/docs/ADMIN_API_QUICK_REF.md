# Admin API Quick Reference

**Base URL:** `https://dev.legal.org.ua/api/admin`
**Auth:** Bearer JWT token (requires `is_admin = true`)

---

## Quick Setup

```bash
# Set your environment
export API="https://dev.legal.org.ua"
export JWT="your-jwt-token-here"

# Test authentication
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/overview" | jq
```

---

## Dashboard & Stats

### Get Overview Stats
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/overview" | jq
```

**Returns:** Today's revenue, month revenue, user counts, alerts

### Get Revenue Chart
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/revenue-chart?days=30" | jq
```

**Returns:** Daily revenue/cost/profit for last N days

### Get Tier Distribution
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/tier-distribution" | jq
```

**Returns:** User count and balance per pricing tier

---

## User Management

### List All Users
```bash
# Basic list
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users?limit=20" | jq

# Search by email
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users?search=example.com&limit=20" | jq

# Filter by tier
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users?tier=startup&limit=20" | jq

# Filter by status
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users?status=active&limit=20" | jq
```

### Get User Details
```bash
USER_ID="uuid-here"
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users/$USER_ID" | jq
```

### Adjust User Balance
```bash
USER_ID="uuid-here"

# Add $10
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"amount": 10.00, "reason": "Promotional credit"}' \
  "$API/api/admin/users/$USER_ID/adjust-balance" | jq

# Subtract $5
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"amount": -5.00, "reason": "Adjustment"}' \
  "$API/api/admin/users/$USER_ID/adjust-balance" | jq
```

### Update User Tier
```bash
USER_ID="uuid-here"

curl -X PUT \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"tier": "business"}' \
  "$API/api/admin/users/$USER_ID/tier" | jq
```

**Valid tiers:** `free`, `startup`, `business`, `enterprise`, `internal`

### Update User Limits
```bash
USER_ID="uuid-here"

# Update both limits
curl -X PUT \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"dailyLimitUsd": 50.00, "monthlyLimitUsd": 500.00}' \
  "$API/api/admin/users/$USER_ID/limits" | jq

# Update only daily limit
curl -X PUT \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"dailyLimitUsd": 100.00}' \
  "$API/api/admin/users/$USER_ID/limits" | jq
```

---

## Transaction Management

### List Transactions
```bash
# All transactions
curl -H "Authorization: Bearer $JWT" "$API/api/admin/transactions?limit=50" | jq

# Filter by type
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?type=charge&limit=50" | jq

# Filter by status
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?status=completed&limit=50" | jq

# Filter by user
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?userId=$USER_ID&limit=50" | jq

# Combined filters
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?type=charge&status=completed&limit=50" | jq
```

**Transaction types:** `charge`, `topup`, `refund`, `admin_credit`, `admin_debit`
**Statuses:** `pending`, `completed`, `failed`, `refunded`

### Refund Transaction
```bash
TX_ID="transaction-uuid-here"

curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Duplicate charge"}' \
  "$API/api/admin/transactions/$TX_ID/refund" | jq
```

---

## Analytics

### Get Cohort Analysis
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/analytics/cohorts" | jq
```

**Returns:** Monthly cohorts with user count, active users, retention, revenue

### Get Usage Statistics
```bash
# Last 30 days
curl -H "Authorization: Bearer $JWT" "$API/api/admin/analytics/usage?days=30" | jq

# Last 7 days
curl -H "Authorization: Bearer $JWT" "$API/api/admin/analytics/usage?days=7" | jq

# Last 90 days
curl -H "Authorization: Bearer $JWT" "$API/api/admin/analytics/usage?days=90" | jq
```

**Returns:** Request count, revenue, average cost per tool

---

## System Settings

### Get All Settings
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/settings" | jq
```

**Returns:** Pricing tiers config, request presets

---

## Common Tasks

### Find User by Email
```bash
EMAIL="user@example.com"
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/users?search=$EMAIL&limit=1" | jq -r '.users[0].id'
```

### Get User's Total Spent
```bash
USER_ID="uuid-here"
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users/$USER_ID" | \
  jq '.user.total_spent_usd'
```

### Find Low Balance Users
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/users?limit=100" | \
  jq '.users[] | select(.balance_usd < 5.00) | {email, balance_usd}'
```

### Get Today's Revenue
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/overview" | \
  jq '.today.revenue_usd'
```

### Count Active Users This Month
```bash
curl -H "Authorization: Bearer $JWT" "$API/api/admin/stats/overview" | \
  jq '.users.active'
```

### List Recent Failed Transactions
```bash
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?status=failed&limit=10" | \
  jq '.transactions[] | {id, user_email, amount_usd, created_at}'
```

---

## Response Examples

### Dashboard Stats
```json
{
  "today": {
    "revenue_usd": 12.45,
    "profit_usd": 3.74,
    "requests": 87
  },
  "month": {
    "revenue_usd": 345.60,
    "profit_usd": 103.68,
    "requests": 2431
  },
  "users": {
    "total": 152,
    "active": 89,
    "low_balance": 12
  },
  "alerts": {
    "failed_requests_today": 3
  }
}
```

### User List
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "created_at": "2026-01-15T10:30:00Z",
      "balance_usd": 25.50,
      "total_spent_usd": 142.30,
      "pricing_tier": "startup",
      "daily_limit_usd": 50.00,
      "monthly_limit_usd": 500.00,
      "total_requests": 234,
      "last_request_at": "2026-02-01T08:15:00Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 152
  }
}
```

### Transaction List
```json
{
  "transactions": [
    {
      "id": "tx-uuid",
      "user_id": "user-uuid",
      "user_email": "user@example.com",
      "transaction_type": "charge",
      "amount_usd": 0.05,
      "status": "completed",
      "created_at": "2026-02-01T10:15:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1234
  }
}
```

---

## Error Handling

### 401 Unauthorized
```json
{
  "error": "Authentication required"
}
```

**Fix:** Provide valid JWT token in Authorization header

### 403 Forbidden
```json
{
  "error": "Admin access required"
}
```

**Fix:** Ensure user has `is_admin = true` in database:
```sql
UPDATE users SET is_admin = true WHERE email = 'your-email@example.com';
```

### 404 Not Found
```json
{
  "error": "User not found"
}
```

**Fix:** Verify the UUID is correct

### 400 Bad Request
```json
{
  "error": "Invalid pricing tier"
}
```

**Fix:** Check request body format and valid values

---

## Bash Functions for Common Tasks

Add to `~/.bashrc`:

```bash
# Admin API helpers
export ADMIN_API="https://dev.legal.org.ua/api/admin"
export ADMIN_JWT="your-jwt-token"

admin_stats() {
  curl -s -H "Authorization: Bearer $ADMIN_JWT" "$ADMIN_API/stats/overview" | jq
}

admin_users() {
  local search="${1:-}"
  local url="$ADMIN_API/users?limit=20"
  [[ -n "$search" ]] && url+="&search=$search"
  curl -s -H "Authorization: Bearer $ADMIN_JWT" "$url" | jq
}

admin_user() {
  local user_id="$1"
  curl -s -H "Authorization: Bearer $ADMIN_JWT" "$ADMIN_API/users/$user_id" | jq
}

admin_add_balance() {
  local user_id="$1"
  local amount="$2"
  local reason="${3:-Manual adjustment}"
  curl -s -X POST \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d "{\"amount\": $amount, \"reason\": \"$reason\"}" \
    "$ADMIN_API/users/$user_id/adjust-balance" | jq
}

admin_set_tier() {
  local user_id="$1"
  local tier="$2"
  curl -s -X PUT \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d "{\"tier\": \"$tier\"}" \
    "$ADMIN_API/users/$user_id/tier" | jq
}

admin_transactions() {
  local type="${1:-}"
  local url="$ADMIN_API/transactions?limit=50"
  [[ -n "$type" ]] && url+="&type=$type"
  curl -s -H "Authorization: Bearer $ADMIN_JWT" "$url" | jq
}
```

**Usage:**
```bash
# Get stats
admin_stats

# Search users
admin_users "example.com"

# Get user details
admin_user "user-uuid-here"

# Add $10 balance
admin_add_balance "user-uuid" 10.00 "Promo credit"

# Change tier
admin_set_tier "user-uuid" "business"

# List charge transactions
admin_transactions "charge"
```

---

## Testing Checklist

- [ ] Can access dashboard stats
- [ ] Can list and search users
- [ ] Can view user details
- [ ] Can adjust user balance
- [ ] Can change user tier
- [ ] Can update user limits
- [ ] Can list transactions
- [ ] Can refund transaction
- [ ] Can view cohort analytics
- [ ] Can view usage analytics
- [ ] Non-admin users get 403 error
- [ ] All actions logged to audit log

---

**Last Updated:** 2026-02-01
**Documentation:** `/mcp_backend/docs/ADMIN_DEPLOYMENT.md`
**Testing Demo:** `/mcp_backend/docs/admin-api-demo.html`
