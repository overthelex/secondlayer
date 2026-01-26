-- Migration 010: Fix cost_tracking schema - add missing columns
-- Ensures cost_tracking table has all required columns for current code

-- Add missing columns from original schema
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS total_cost_usd DECIMAL(10, 6) DEFAULT 0.00;

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS openai_total_tokens INTEGER DEFAULT 0;

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS openai_prompt_tokens INTEGER DEFAULT 0;

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS openai_completion_tokens INTEGER DEFAULT 0;

ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS openai_calls JSONB DEFAULT '[]';

-- Rename duration_ms to execution_time_ms if it exists
-- IMPORTANT: Must run BEFORE adding execution_time_ms column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cost_tracking' AND column_name = 'duration_ms'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cost_tracking' AND column_name = 'execution_time_ms'
  ) THEN
    ALTER TABLE cost_tracking RENAME COLUMN duration_ms TO execution_time_ms;
  END IF;
END $$;

-- Add execution_time_ms if it still doesn't exist (when duration_ms didn't exist)
ALTER TABLE cost_tracking
ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;

-- Update total_cost_usd based on individual cost components
UPDATE cost_tracking
SET total_cost_usd = COALESCE(openai_cost_usd, 0) +
                     COALESCE(zakononline_cost_usd, 0) +
                     COALESCE(secondlayer_cost_usd, 0)
WHERE total_cost_usd = 0;

-- Add index for total_cost_usd
CREATE INDEX IF NOT EXISTS idx_cost_tracking_total_cost ON cost_tracking(total_cost_usd);
