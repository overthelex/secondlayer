-- Migration: Create subscription-related tables
-- Description: Subscription plans, user subscriptions, token balance, and transaction history

-- Table: subscription_plans
CREATE TABLE IF NOT EXISTS subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    price_monthly DECIMAL(10, 2) NOT NULL,
    price_yearly DECIMAL(10, 2), -- Nullable for plans without yearly option
    token_limit_monthly INTEGER, -- NULL = unlimited
    features JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of feature names
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_subscription_plans_updated_at
    BEFORE UPDATE ON subscription_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table: subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    status VARCHAR(50) NOT NULL CHECK (status IN ('active', 'cancelled', 'past_due', 'expired')),
    billing_cycle VARCHAR(20) NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
    current_period_start TIMESTAMP NOT NULL,
    current_period_end TIMESTAMP NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_subscription_id VARCHAR(255) UNIQUE, -- Nullable for non-Stripe subscriptions
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table: user_token_balance
CREATE TABLE IF NOT EXISTS user_token_balance (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_purchased INTEGER NOT NULL DEFAULT 0,
    lifetime_used INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_user_token_balance_updated_at
    BEFORE UPDATE ON user_token_balance
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table: token_transactions
CREATE TABLE IF NOT EXISTS token_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('subscription_grant', 'purchase', 'usage', 'admin_adjust', 'refund')),
    amount INTEGER NOT NULL, -- Positive for add, negative for deduct
    balance_after INTEGER NOT NULL,
    description TEXT,
    related_invoice_id UUID, -- FK added later when invoices table is created
    related_request_id UUID, -- FK to cost_tracking.request_id (added in integration migration)
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_transactions_user_id ON token_transactions(user_id);
CREATE INDEX idx_token_transactions_type ON token_transactions(type);
CREATE INDEX idx_token_transactions_created_at ON token_transactions(created_at DESC);

-- Insert default subscription plans
INSERT INTO subscription_plans (name, price_monthly, price_yearly, token_limit_monthly, features, is_active)
VALUES
    ('Free', 0.00, NULL, 10000, '["Basic search", "Limited API access", "Community support"]'::jsonb, TRUE),
    ('Starter', 10.00, 100.00, 100000, '["Advanced search", "Pattern analysis", "Email support", "API access"]'::jsonb, TRUE),
    ('Pro', 50.00, 500.00, 1000000, '["Unlimited search", "Advanced analytics", "Citation validation", "Priority support", "Team collaboration"]'::jsonb, TRUE),
    ('Enterprise', 200.00, 2000.00, NULL, '["Unlimited everything", "Dedicated support", "Custom integrations", "SLA guarantee", "Advanced security"]'::jsonb, TRUE)
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE subscription_plans IS 'Available subscription tiers with pricing and features';
COMMENT ON TABLE subscriptions IS 'User active subscriptions';
COMMENT ON TABLE user_token_balance IS 'Current token balance per user';
COMMENT ON TABLE token_transactions IS 'History of all token additions and deductions';
COMMENT ON COLUMN token_transactions.amount IS 'Positive for credits, negative for debits';
