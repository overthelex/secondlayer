-- Migration 054: Add user_prompts table for saved chat prompts

CREATE TABLE IF NOT EXISTS user_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_prompts_user_id ON user_prompts(user_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_user_prompts_updated_at'
  ) THEN
    CREATE TRIGGER update_user_prompts_updated_at
      BEFORE UPDATE ON user_prompts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
