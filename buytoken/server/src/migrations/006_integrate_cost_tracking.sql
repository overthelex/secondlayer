-- Migration: Integrate with existing MCP backend tables
-- Description: Add user_id columns to cost_tracking and monthly_api_usage tables

-- Add user_id to cost_tracking table (if it exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cost_tracking') THEN
        -- Add user_id column if not exists
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'cost_tracking' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE cost_tracking
                ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;

            CREATE INDEX idx_cost_tracking_user_id ON cost_tracking(user_id);

            RAISE NOTICE 'Added user_id column to cost_tracking table';
        END IF;
    ELSE
        RAISE NOTICE 'cost_tracking table does not exist yet - will be created by MCP backend';
    END IF;
END $$;

-- Add user_id to monthly_api_usage table (if it exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'monthly_api_usage') THEN
        -- Add user_id column if not exists
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'monthly_api_usage' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE monthly_api_usage
                ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;

            CREATE INDEX idx_monthly_api_usage_user_id ON monthly_api_usage(user_id);

            RAISE NOTICE 'Added user_id column to monthly_api_usage table';
        END IF;
    ELSE
        RAISE NOTICE 'monthly_api_usage table does not exist yet - will be created by MCP backend';
    END IF;
END $$;

-- Add FK constraint from token_transactions to cost_tracking (if both tables exist)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cost_tracking') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_token_transactions_request'
        ) THEN
            -- Check if cost_tracking has request_id column
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'cost_tracking' AND column_name = 'request_id'
            ) THEN
                ALTER TABLE token_transactions
                    ADD CONSTRAINT fk_token_transactions_request
                    FOREIGN KEY (related_request_id) REFERENCES cost_tracking(request_id) ON DELETE SET NULL;

                RAISE NOTICE 'Added FK constraint from token_transactions to cost_tracking';
            END IF;
        END IF;
    END IF;
END $$;

-- Create view to combine user usage with cost tracking
CREATE OR REPLACE VIEW user_usage_summary AS
SELECT
    u.id AS user_id,
    u.email,
    u.name,
    COALESCE(tb.balance, 0) AS current_balance,
    COALESCE(tb.lifetime_purchased, 0) AS lifetime_purchased,
    COALESCE(tb.lifetime_used, 0) AS lifetime_used,
    s.status AS subscription_status,
    sp.name AS subscription_plan,
    sp.token_limit_monthly,
    COALESCE(umu.tokens_used, 0) AS tokens_used_this_month,
    COALESCE(umu.api_calls, 0) AS api_calls_this_month,
    COALESCE(umu.cost_usd, 0) AS cost_usd_this_month
FROM users u
LEFT JOIN user_token_balance tb ON u.id = tb.user_id
LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
LEFT JOIN user_monthly_usage umu ON u.id = umu.user_id AND umu.year_month = TO_CHAR(NOW(), 'YYYY-MM');

COMMENT ON VIEW user_usage_summary IS 'Comprehensive view of user subscription, balance, and usage statistics';

-- Create function to initialize token balance for new users
CREATE OR REPLACE FUNCTION initialize_user_token_balance()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_token_balance (user_id, balance, lifetime_purchased, lifetime_used)
    VALUES (NEW.id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_initialize_user_token_balance
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION initialize_user_token_balance();

COMMENT ON FUNCTION initialize_user_token_balance IS 'Automatically create token balance record for new users';
