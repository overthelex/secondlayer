-- Migration 024: Add Invoice Metadata to Billing Transactions
-- Adds invoice number and generation tracking to billing_transactions

ALTER TABLE billing_transactions
ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50),
ADD COLUMN IF NOT EXISTS invoice_generated_at TIMESTAMP;

-- Create index for invoice lookups
CREATE INDEX IF NOT EXISTS idx_billing_transactions_invoice_number
ON billing_transactions(invoice_number) WHERE invoice_number IS NOT NULL;

COMMENT ON COLUMN billing_transactions.invoice_number IS 'Unique invoice identifier (e.g., INV-ABC123-XYZ)';
COMMENT ON COLUMN billing_transactions.invoice_generated_at IS 'Timestamp when invoice PDF was last generated';
