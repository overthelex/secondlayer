-- Migration: Create payment-related tables
-- Description: Payment methods and invoices for billing history

-- Table: payment_methods
CREATE TABLE IF NOT EXISTS payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('stripe_card', 'monobank', 'crypto_wallet')),
    stripe_payment_method_id VARCHAR(255), -- Stripe PM ID (nullable for non-Stripe)
    card_brand VARCHAR(50), -- 'visa', 'mastercard', etc. (nullable)
    card_last4 VARCHAR(4), -- Last 4 digits of card (nullable)
    wallet_address VARCHAR(255), -- Crypto wallet address (nullable)
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_methods_user_id ON payment_methods(user_id);
CREATE INDEX idx_payment_methods_default ON payment_methods(user_id, is_default) WHERE is_default = TRUE;

CREATE TRIGGER update_payment_methods_updated_at
    BEFORE UPDATE ON payment_methods
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table: invoices
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL, -- Nullable for one-time purchases
    invoice_number VARCHAR(50) UNIQUE NOT NULL, -- Format: INV-YYYY-NNNN
    type VARCHAR(50) NOT NULL CHECK (type IN ('subscription', 'token_purchase', 'refund')),
    amount_usd DECIMAL(10, 2) NOT NULL,
    tokens_granted INTEGER, -- Nullable for refunds
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL, -- Nullable if payment method deleted
    stripe_invoice_id VARCHAR(255) UNIQUE, -- Nullable for non-Stripe payments
    issued_at TIMESTAMP NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMP, -- Nullable until paid
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_invoice_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_issued_at ON invoices(issued_at DESC);

CREATE TRIGGER update_invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add FK constraint to token_transactions (now that invoices table exists)
ALTER TABLE token_transactions
    ADD CONSTRAINT fk_token_transactions_invoice
    FOREIGN KEY (related_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- Function to generate invoice number
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    sequence_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := TO_CHAR(NOW(), 'YYYY');

    -- Get the next sequence number for this year
    SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM 'INV-\d{4}-(\d+)')::INTEGER), 0) + 1
    INTO next_number
    FROM invoices
    WHERE invoice_number LIKE 'INV-' || year_part || '-%';

    sequence_part := LPAD(next_number::TEXT, 4, '0');

    RETURN 'INV-' || year_part || '-' || sequence_part;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate invoice number if not provided
CREATE OR REPLACE FUNCTION set_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
        NEW.invoice_number := generate_invoice_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_invoice_number_trigger
    BEFORE INSERT ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION set_invoice_number();

COMMENT ON TABLE payment_methods IS 'Saved payment methods for users (cards, bank accounts, crypto wallets)';
COMMENT ON TABLE invoices IS 'Payment invoices and billing history';
COMMENT ON COLUMN invoices.invoice_number IS 'Auto-generated invoice number (INV-YYYY-NNNN)';
COMMENT ON FUNCTION generate_invoice_number() IS 'Generates sequential invoice numbers per year';
