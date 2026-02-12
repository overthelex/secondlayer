-- Migration 037: Time Tracking and Billing System
-- Created: 2026-02-12
-- Description: Adds comprehensive time tracking, billing rates, invoicing, and payment tracking

-- ============================================================================
-- Time Entries Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    hourly_rate_usd DECIMAL(10,2) NOT NULL CHECK (hourly_rate_usd >= 0),
    billable BOOLEAN NOT NULL DEFAULT true,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'invoiced', 'rejected')),
    description TEXT NOT NULL,
    notes TEXT,
    invoice_id UUID, -- FK added later
    created_by UUID NOT NULL REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Indexes for common queries
    CONSTRAINT time_entries_valid_duration CHECK (duration_minutes > 0 AND duration_minutes <= 1440), -- Max 24 hours
    CONSTRAINT time_entries_valid_rate CHECK (hourly_rate_usd >= 0)
);

CREATE INDEX idx_time_entries_matter ON time_entries(matter_id);
CREATE INDEX idx_time_entries_user ON time_entries(user_id);
CREATE INDEX idx_time_entries_status ON time_entries(status);
CREATE INDEX idx_time_entries_date ON time_entries(entry_date);
CREATE INDEX idx_time_entries_billable ON time_entries(billable) WHERE billable = true;
CREATE INDEX idx_time_entries_invoice ON time_entries(invoice_id) WHERE invoice_id IS NOT NULL;

-- ============================================================================
-- Active Timers Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS active_timers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    description TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One active timer per user per matter
    UNIQUE(user_id, matter_id)
);

CREATE INDEX idx_active_timers_user ON active_timers(user_id);
CREATE INDEX idx_active_timers_matter ON active_timers(matter_id);
CREATE INDEX idx_active_timers_stale ON active_timers(last_ping_at) WHERE last_ping_at < NOW() - INTERVAL '5 minutes';

-- ============================================================================
-- User Billing Rates Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_billing_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hourly_rate_usd DECIMAL(10,2) NOT NULL CHECK (hourly_rate_usd >= 0),
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_rate_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX idx_user_billing_rates_user ON user_billing_rates(user_id);
CREATE INDEX idx_user_billing_rates_effective ON user_billing_rates(effective_from, effective_to);
CREATE UNIQUE INDEX idx_user_billing_rates_default ON user_billing_rates(user_id) WHERE is_default = true;

-- ============================================================================
-- Matter Invoices Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS matter_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled', 'void')),
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    subtotal_usd DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (subtotal_usd >= 0),
    tax_rate DECIMAL(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1),
    tax_amount_usd DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount_usd >= 0),
    total_usd DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (total_usd >= 0),
    amount_paid_usd DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid_usd >= 0),
    notes TEXT,
    terms TEXT,
    sent_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_due_date CHECK (due_date >= issue_date),
    CONSTRAINT valid_total CHECK (total_usd = subtotal_usd + tax_amount_usd)
);

CREATE INDEX idx_matter_invoices_matter ON matter_invoices(matter_id);
CREATE INDEX idx_matter_invoices_status ON matter_invoices(status);
CREATE INDEX idx_matter_invoices_number ON matter_invoices(invoice_number);
CREATE INDEX idx_matter_invoices_dates ON matter_invoices(issue_date, due_date);

-- ============================================================================
-- Invoice Line Items Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES matter_invoices(id) ON DELETE CASCADE,
    time_entry_id UUID REFERENCES time_entries(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    quantity DECIMAL(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price_usd DECIMAL(10,2) NOT NULL CHECK (unit_price_usd >= 0),
    amount_usd DECIMAL(12,2) NOT NULL CHECK (amount_usd >= 0),
    line_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_line_amount CHECK (amount_usd = quantity * unit_price_usd)
);

CREATE INDEX idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);
CREATE INDEX idx_invoice_line_items_time_entry ON invoice_line_items(time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX idx_invoice_line_items_order ON invoice_line_items(invoice_id, line_order);

-- ============================================================================
-- Invoice Payments Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES matter_invoices(id) ON DELETE CASCADE,
    amount_usd DECIMAL(12,2) NOT NULL CHECK (amount_usd > 0),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method VARCHAR(50),
    reference_number VARCHAR(100),
    notes TEXT,
    recorded_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);
CREATE INDEX idx_invoice_payments_date ON invoice_payments(payment_date);

-- ============================================================================
-- Triggers for updated_at timestamps
-- ============================================================================
CREATE OR REPLACE FUNCTION update_time_billing_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER time_entries_updated_at
    BEFORE UPDATE ON time_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_time_billing_updated_at();

CREATE TRIGGER user_billing_rates_updated_at
    BEFORE UPDATE ON user_billing_rates
    FOR EACH ROW
    EXECUTE FUNCTION update_time_billing_updated_at();

CREATE TRIGGER matter_invoices_updated_at
    BEFORE UPDATE ON matter_invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_time_billing_updated_at();

CREATE TRIGGER invoice_payments_updated_at
    BEFORE UPDATE ON invoice_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_time_billing_updated_at();

-- ============================================================================
-- Function: Auto-generate invoice number
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    sequence_num INTEGER;
    invoice_num TEXT;
BEGIN
    year_part := TO_CHAR(CURRENT_DATE, 'YYYY');

    -- Get the next sequence number for this year
    SELECT COALESCE(MAX(
        CASE
            WHEN invoice_number ~ ('^INV-' || year_part || '-[0-9]+$')
            THEN CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)
            ELSE 0
        END
    ), 0) + 1
    INTO sequence_num
    FROM matter_invoices
    WHERE invoice_number LIKE 'INV-' || year_part || '-%';

    invoice_num := 'INV-' || year_part || '-' || LPAD(sequence_num::TEXT, 4, '0');

    RETURN invoice_num;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function: Clean up stale timers (older than 24 hours without ping)
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_stale_timers()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM active_timers
    WHERE last_ping_at < NOW() - INTERVAL '24 hours';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function: Get current billing rate for user
-- ============================================================================
CREATE OR REPLACE FUNCTION get_user_billing_rate(p_user_id UUID, p_date DATE DEFAULT CURRENT_DATE)
RETURNS DECIMAL AS $$
DECLARE
    rate DECIMAL(10,2);
BEGIN
    SELECT hourly_rate_usd INTO rate
    FROM user_billing_rates
    WHERE user_id = p_user_id
      AND effective_from <= p_date
      AND (effective_to IS NULL OR effective_to >= p_date)
    ORDER BY effective_from DESC
    LIMIT 1;

    -- If no rate found, try to get default rate
    IF rate IS NULL THEN
        SELECT hourly_rate_usd INTO rate
        FROM user_billing_rates
        WHERE user_id = p_user_id
          AND is_default = true
        LIMIT 1;
    END IF;

    RETURN COALESCE(rate, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function: Calculate invoice totals
-- ============================================================================
CREATE OR REPLACE FUNCTION calculate_invoice_totals(p_invoice_id UUID)
RETURNS void AS $$
DECLARE
    v_subtotal DECIMAL(12,2);
    v_tax_rate DECIMAL(5,4);
    v_tax_amount DECIMAL(12,2);
    v_total DECIMAL(12,2);
BEGIN
    -- Get sum of line items
    SELECT COALESCE(SUM(amount_usd), 0)
    INTO v_subtotal
    FROM invoice_line_items
    WHERE invoice_id = p_invoice_id;

    -- Get tax rate from invoice
    SELECT tax_rate INTO v_tax_rate
    FROM matter_invoices
    WHERE id = p_invoice_id;

    -- Calculate tax and total
    v_tax_amount := ROUND(v_subtotal * v_tax_rate, 2);
    v_total := v_subtotal + v_tax_amount;

    -- Update invoice
    UPDATE matter_invoices
    SET subtotal_usd = v_subtotal,
        tax_amount_usd = v_tax_amount,
        total_usd = v_total,
        updated_at = NOW()
    WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Trigger: Recalculate invoice totals when line items change
-- ============================================================================
CREATE OR REPLACE FUNCTION trigger_recalculate_invoice_totals()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM calculate_invoice_totals(OLD.invoice_id);
    ELSE
        PERFORM calculate_invoice_totals(NEW.invoice_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_line_items_totals
    AFTER INSERT OR UPDATE OR DELETE ON invoice_line_items
    FOR EACH ROW
    EXECUTE FUNCTION trigger_recalculate_invoice_totals();

-- ============================================================================
-- Trigger: Update invoice status when payments recorded
-- ============================================================================
CREATE OR REPLACE FUNCTION update_invoice_payment_status()
RETURNS TRIGGER AS $$
DECLARE
    v_total_paid DECIMAL(12,2);
    v_invoice_total DECIMAL(12,2);
BEGIN
    -- Calculate total payments for this invoice
    SELECT COALESCE(SUM(amount_usd), 0)
    INTO v_total_paid
    FROM invoice_payments
    WHERE invoice_id = NEW.invoice_id;

    -- Get invoice total
    SELECT total_usd INTO v_invoice_total
    FROM matter_invoices
    WHERE id = NEW.invoice_id;

    -- Update invoice
    UPDATE matter_invoices
    SET amount_paid_usd = v_total_paid,
        status = CASE
            WHEN v_total_paid >= v_invoice_total THEN 'paid'
            WHEN status = 'draft' THEN 'sent'
            ELSE status
        END,
        paid_at = CASE
            WHEN v_total_paid >= v_invoice_total THEN NOW()
            ELSE paid_at
        END
    WHERE id = NEW.invoice_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_payments_status
    AFTER INSERT ON invoice_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_invoice_payment_status();

-- ============================================================================
-- Sample Data (optional - for testing)
-- ============================================================================
-- Uncomment to add sample billing rates for existing users
-- INSERT INTO user_billing_rates (user_id, hourly_rate_usd, effective_from, is_default, created_by)
-- SELECT id, 150.00, CURRENT_DATE, true, id
-- FROM users
-- WHERE role = 'attorney'
-- ON CONFLICT DO NOTHING;

-- ============================================================================
-- Permissions (grant to application user if needed)
-- ============================================================================
-- GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON active_timers TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON user_billing_rates TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON matter_invoices TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line_items TO secondlayer_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_payments TO secondlayer_app;

COMMENT ON TABLE time_entries IS 'Tracks billable and non-billable time spent on matters';
COMMENT ON TABLE active_timers IS 'Tracks currently running timers for automatic time entry creation';
COMMENT ON TABLE user_billing_rates IS 'Hourly billing rates for users with effective date ranges';
COMMENT ON TABLE matter_invoices IS 'Invoice headers for matters';
COMMENT ON TABLE invoice_line_items IS 'Individual line items (time entries and other charges) on invoices';
COMMENT ON TABLE invoice_payments IS 'Payment records for invoices';


-- Add FK after both tables exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_invoice_id_fkey') THEN
        ALTER TABLE time_entries ADD CONSTRAINT time_entries_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES matter_invoices(id) ON DELETE SET NULL;
    END IF;
END $$;
