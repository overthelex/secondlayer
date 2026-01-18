-- Migration 005: Convert UAH prices to USD
-- Removes UAH columns and converts existing UAH values to USD (1 USD = 42 UAH)

-- Step 1: Add new USD column for ZakonOnline if it doesn't exist
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS zakononline_cost_usd DECIMAL(10, 6) DEFAULT 0.00;

-- Step 2: Convert existing UAH values to USD (divide by 42)
UPDATE cost_tracking
SET zakononline_cost_usd = COALESCE(zakononline_cost_uah, 0) / 42.0
WHERE zakononline_cost_usd = 0 AND zakononline_cost_uah IS NOT NULL;

-- Step 3: Drop old UAH column
ALTER TABLE cost_tracking
DROP COLUMN IF EXISTS zakononline_cost_uah;

-- Step 4: Drop total_cost_uah column (we only use total_cost_usd now)
ALTER TABLE cost_tracking
DROP COLUMN IF EXISTS total_cost_uah;

-- Step 5: Update monthly_api_usage table - add USD column for ZakonOnline
ALTER TABLE monthly_api_usage
ADD COLUMN IF NOT EXISTS zakononline_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00;

-- Step 6: Convert existing monthly stats from UAH to USD
UPDATE monthly_api_usage
SET zakononline_total_cost_usd = COALESCE(zakononline_total_cost_uah, 0) / 42.0
WHERE zakononline_total_cost_usd = 0 AND zakononline_total_cost_uah IS NOT NULL;

-- Step 7: Drop old monthly UAH column
ALTER TABLE monthly_api_usage
DROP COLUMN IF EXISTS zakononline_total_cost_uah;
