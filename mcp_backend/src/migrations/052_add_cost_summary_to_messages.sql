-- Add cost_summary JSONB column to conversation_messages
-- Stores { total_cost_usd, tools_used } for display when loading conversation history

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS cost_summary JSONB;
