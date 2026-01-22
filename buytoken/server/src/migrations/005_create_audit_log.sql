-- Migration: Create audit log and usage tracking tables
-- Description: Compliance audit trail and monthly usage aggregation

-- Table: audit_log
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Nullable if user deleted
    admin_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Nullable for user actions
    action VARCHAR(100) NOT NULL, -- 'login', 'api_key_created', 'subscription_changed', etc.
    resource_type VARCHAR(50), -- 'user', 'subscription', 'invoice', etc.
    resource_id UUID, -- ID of the affected resource
    details JSONB, -- Additional context (e.g., changed fields, old/new values)
    ip_address INET, -- Client IP address
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_admin_id ON audit_log(admin_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);

-- Table: user_monthly_usage
CREATE TABLE IF NOT EXISTS user_monthly_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year_month VARCHAR(7) NOT NULL, -- Format: 'YYYY-MM'
    tokens_used INTEGER NOT NULL DEFAULT 0,
    api_calls INTEGER NOT NULL DEFAULT 0,
    cost_usd DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    PRIMARY KEY (user_id, year_month)
);

CREATE INDEX idx_user_monthly_usage_year_month ON user_monthly_usage(year_month DESC);

-- Function to log audit events
CREATE OR REPLACE FUNCTION log_audit_event(
    p_user_id UUID,
    p_admin_id UUID,
    p_action VARCHAR(100),
    p_resource_type VARCHAR(50),
    p_resource_id UUID,
    p_details JSONB,
    p_ip_address INET
)
RETURNS UUID AS $$
DECLARE
    log_id UUID;
BEGIN
    INSERT INTO audit_log (user_id, admin_id, action, resource_type, resource_id, details, ip_address)
    VALUES (p_user_id, p_admin_id, p_action, p_resource_type, p_resource_id, p_details, p_ip_address)
    RETURNING id INTO log_id;

    RETURN log_id;
END;
$$ LANGUAGE plpgsql;

-- Function to update monthly usage
CREATE OR REPLACE FUNCTION update_monthly_usage(
    p_user_id UUID,
    p_tokens_used INTEGER,
    p_cost_usd DECIMAL(10, 2)
)
RETURNS VOID AS $$
DECLARE
    current_month VARCHAR(7);
BEGIN
    current_month := TO_CHAR(NOW(), 'YYYY-MM');

    INSERT INTO user_monthly_usage (user_id, year_month, tokens_used, api_calls, cost_usd)
    VALUES (p_user_id, current_month, p_tokens_used, 1, p_cost_usd)
    ON CONFLICT (user_id, year_month)
    DO UPDATE SET
        tokens_used = user_monthly_usage.tokens_used + EXCLUDED.tokens_used,
        api_calls = user_monthly_usage.api_calls + 1,
        cost_usd = user_monthly_usage.cost_usd + EXCLUDED.cost_usd;
END;
$$ LANGUAGE plpgsql;

-- Trigger to log user creation
CREATE OR REPLACE FUNCTION log_user_creation()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM log_audit_event(
        NEW.id,
        NULL,
        'user_registered',
        'user',
        NEW.id,
        jsonb_build_object('email', NEW.email, 'auth_method',
            CASE
                WHEN NEW.google_id IS NOT NULL THEN 'google_oauth'
                ELSE 'email_password'
            END
        ),
        NULL
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_log_user_creation
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION log_user_creation();

-- Trigger to log subscription changes
CREATE OR REPLACE FUNCTION log_subscription_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM log_audit_event(
            NEW.user_id,
            NULL,
            'subscription_created',
            'subscription',
            NEW.id,
            jsonb_build_object('plan_id', NEW.plan_id, 'billing_cycle', NEW.billing_cycle),
            NULL
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        PERFORM log_audit_event(
            NEW.user_id,
            NULL,
            'subscription_status_changed',
            'subscription',
            NEW.id,
            jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status),
            NULL
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_log_subscription_change
    AFTER INSERT OR UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION log_subscription_change();

COMMENT ON TABLE audit_log IS 'Compliance audit trail for all sensitive operations';
COMMENT ON TABLE user_monthly_usage IS 'Aggregated usage statistics per user per month';
COMMENT ON FUNCTION log_audit_event IS 'Helper function to create audit log entries';
COMMENT ON FUNCTION update_monthly_usage IS 'Helper function to update monthly usage statistics';
