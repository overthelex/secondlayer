-- Migration 055: Add is_favorite column to user_prompts

ALTER TABLE user_prompts ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_user_prompts_favorite ON user_prompts(user_id, is_favorite);
