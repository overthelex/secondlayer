# Billing System Migration Guide
**From: `user_billing` (USD) → To: `user_credits` (Credits)**

## Overview

This guide covers migrating from the old USD-based billing system (`user_billing` table) to the new credit-based system (`user_credits` table).

### Why Migrate?

- **Unified System**: Single credit currency instead of USD/UAH tracking
- **Better Integration**: Works seamlessly with ChatGPT OAuth and MCP tools
- **Simplified Pricing**: Tool pricing in credits (not dynamic USD)
- **Audit Trail**: Better transaction tracking via `credit_transactions` table

## Quick Fix for ChatGPT User

If you just need to fix the ChatGPT integration immediately:

```bash
# On remote server (mail.lexapp.co.ua)
cd /home/vovkes/SecondLayer/deployment
./add-credits-stage.sh 100
```

Or locally (if Docker is running):
```bash
ssh vovkes@mail.lexapp.co.ua "docker exec -i stage-secondlayer-postgres psql -U secondlayer -d secondlayer_db -c \"SELECT * FROM add_credits('abfa4cd8-61de-4908-a778-4d23c1574f0a'::uuid, 100, 'bonus', 'manual_grant', 'chatgpt-fix', 'Credits for ChatGPT', NULL);\""
```

## Full Migration Process

### Step 1: Apply Database Migration

First, apply the migration SQL to create necessary tables and functions:

```bash
# On remote server (or via SSH)
cd /home/vovkes/SecondLayer/mcp_backend

docker exec -i stage-secondlayer-postgres psql -U secondlayer -d secondlayer_db < src/migrations/021_migrate_billing_to_credits.sql
```

This creates:
- `credit_transactions` table (if not exists)
- `billing_migration_log` table (tracks migration status)
- `migrate_user_billing_to_credits()` function
- `billing_migration_status` view (to check progress)

### Step 2: Preview Migration (Dry Run)

See what will be migrated without making changes:

```bash
cd /home/vovkes/SecondLayer/deployment
./migrate-billing-to-credits.sh --dry-run
```

Expected output:
```
════════════════════════════════════════════════════════════════
  Migration 021: Billing USD → Credits (DRY RUN)
════════════════════════════════════════════════════════════════

User: igor@legal.org.ua (abfa4cd8-...) - $100.00 → 100 credits - Would migrate
User: test@legal.org.ua (xyz-...) - $50.00 → 50 credits - Would migrate

────────────────────────────────────────────────────────────────
Summary:
  Users to migrate: 2
  Total USD: $150.00
  Total credits: 150
────────────────────────────────────────────────────────────────

⚠️  This was a DRY RUN - no changes were made
```

### Step 3: Execute Migration

When ready, run the actual migration:

```bash
./migrate-billing-to-credits.sh --execute
```

You'll be prompted for confirmation:
```
⚠️  WARNING: This will modify the database!
   - Convert all USD balances to credits
   - Zero out user_billing.balance_usd
   - Create transaction records

Are you sure you want to continue? (yes/no): yes
```

### Step 4: Verify Migration

Check migration status:

```bash
docker exec -i stage-secondlayer-postgres psql -U secondlayer -d secondlayer_db -c "SELECT * FROM billing_migration_status;"
```

Expected output:
```
 user_id | email              | credit_balance | migration_status | migrated_at
---------+--------------------+----------------+------------------+-------------
 abfa... | igor@legal.org.ua  | 100.00         | success          | 2026-02-06
```

Check individual user:
```bash
docker exec -i stage-secondlayer-postgres psql -U secondlayer -d secondlayer_db -c "
  SELECT balance, total_earned, total_spent, updated_at
  FROM user_credits
  WHERE user_id = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';
"
```

Check transactions:
```bash
docker exec -i stage-secondlayer-postgres psql -U secondlayer -d secondlayer_db -c "
  SELECT transaction_type, amount, balance_before, balance_after, description, created_at
  FROM credit_transactions
  WHERE user_id = 'abfa4cd8-61de-4908-a778-4d23c1574f0a'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

## Advanced Options

### Custom Conversion Rate

By default, 1 USD = 1 credit. To use a different rate:

```bash
# 1 USD = 10 credits
./migrate-billing-to-credits.sh --execute --rate 10.0

# 1 USD = 0.5 credits
./migrate-billing-to-credits.sh --execute --rate 0.5
```

### Different Environment

```bash
# Production
./migrate-billing-to-credits.sh --execute --container prod-secondlayer-postgres

# Development
./migrate-billing-to-credits.sh --execute --container dev-secondlayer-postgres

# Local
./migrate-billing-to-credits.sh --execute --container local-secondlayer-postgres
```

### Manual SQL Execution

If you prefer to run SQL directly:

```sql
-- Dry run
SELECT * FROM migrate_user_billing_to_credits(1.0, true);

-- Execute migration
SELECT * FROM migrate_user_billing_to_credits(1.0, false);

-- Check status
SELECT * FROM billing_migration_status;

-- View migration log
SELECT * FROM billing_migration_log ORDER BY migrated_at DESC;
```

## What Gets Migrated

### Before Migration

**user_billing table:**
```sql
user_id                              | balance_usd | balance_uah
-------------------------------------+-------------+-------------
abfa4cd8-61de-4908-a778-4d23c1574f0a | 100.00      | 0.00
```

**user_credits table:**
```sql
user_id                              | balance | total_earned | total_spent
-------------------------------------+---------+--------------+-------------
abfa4cd8-61de-4908-a778-4d23c1574f0a | 0.00    | 0.00         | 0.00
```

### After Migration

**user_billing table** (zeroed out):
```sql
user_id                              | balance_usd | balance_uah
-------------------------------------+-------------+-------------
abfa4cd8-61de-4908-a778-4d23c1574f0a | 0.00        | 0.00
```

**user_credits table** (updated):
```sql
user_id                              | balance | total_earned | total_spent
-------------------------------------+---------+--------------+-------------
abfa4cd8-61de-4908-a778-4d23c1574f0a | 100.00  | 100.00       | 0.00
```

**credit_transactions table** (new record):
```sql
id      | user_id  | transaction_type | amount  | balance_before | balance_after | source
--------+----------+------------------+---------+----------------+---------------+------------------------
uuid... | abfa4... | migration        | 100.00  | 0.00           | 100.00        | billing_usd_to_credits

description: "Migrated from user_billing: $100.00 USD → 100 credits (rate: 1.0x)"
```

## Rollback (If Needed)

If something goes wrong, you can rollback by:

1. **Restore old balances** (if you have a backup):
```sql
-- Restore from billing_migration_log
UPDATE user_billing ub
SET balance_usd = ml.old_balance_usd,
    balance_uah = ml.old_balance_uah
FROM billing_migration_log ml
WHERE ub.user_id = ml.user_id
  AND ml.status = 'success';
```

2. **Remove migrated credits**:
```sql
-- Delete migration transactions
DELETE FROM credit_transactions
WHERE source = 'billing_usd_to_credits';

-- Reset user_credits (manually adjust if needed)
UPDATE user_credits uc
SET balance = balance - ml.new_credits,
    total_earned = total_earned - ml.new_credits
FROM billing_migration_log ml
WHERE uc.user_id = ml.user_id
  AND ml.status = 'success';
```

## Troubleshooting

### "Insufficient credits" Error Still Appears

1. Check if migration ran:
```sql
SELECT * FROM billing_migration_log WHERE user_id = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';
```

2. Check current balance:
```sql
SELECT * FROM user_credits WHERE user_id = 'abfa4cd8-61de-4908-a778-4d23c1574f0a';
```

3. Manually add credits if needed:
```sql
SELECT * FROM add_credits(
  'abfa4cd8-61de-4908-a778-4d23c1574f0a'::uuid,
  100,
  'bonus',
  'manual_grant',
  'troubleshooting',
  'Manual credit addition',
  NULL
);
```

### Container Not Found

List available containers:
```bash
docker ps --format "{{.Names}}"
```

Use the correct container name:
```bash
./migrate-billing-to-credits.sh --execute --container <correct-name>
```

### Migration Shows 0 Users

This means:
- No users have positive USD balances in `user_billing`
- All users already migrated
- Wrong database/container

Check if users have balances:
```sql
SELECT user_id, balance_usd, balance_uah
FROM user_billing
WHERE balance_usd > 0 OR balance_uah > 0;
```

## Post-Migration Checklist

- [ ] All users migrated successfully
- [ ] ChatGPT integration working (no "insufficient credits" errors)
- [ ] Old `user_billing.balance_usd` values are zeroed
- [ ] New `user_credits.balance` values are correct
- [ ] Transaction records created in `credit_transactions`
- [ ] Migration log shows all successes
- [ ] Test MCP tool execution with real users

## Files Created

- `/mcp_backend/src/migrations/021_migrate_billing_to_credits.sql` - Database migration
- `/deployment/migrate-billing-to-credits.sh` - Migration execution script
- `/deployment/add-credits-stage.sh` - Quick fix for individual users
- `/deployment/BILLING_MIGRATION_GUIDE.md` - This guide

## Support

If you encounter issues:
1. Check the migration log: `SELECT * FROM billing_migration_log;`
2. Check the status view: `SELECT * FROM billing_migration_status;`
3. Review server logs: `./manage-gateway.sh logs stage`
4. Run dry-run again to see current state

---

**Last Updated:** 2026-02-06
**Migration Version:** 021
**Status:** Ready for Production ✅
