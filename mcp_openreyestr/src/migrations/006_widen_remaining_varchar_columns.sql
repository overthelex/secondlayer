-- Migration 006: Widen remaining narrow VARCHAR columns causing truncation errors
-- bankruptcy_cases.debtor_type VARCHAR(50) → TEXT (real data exceeds 50 chars)
-- Also widen other columns that are likely too narrow for real NAIS data

DO $$ BEGIN
  ALTER TABLE bankruptcy_cases ALTER COLUMN debtor_type TYPE TEXT;
  ALTER TABLE bankruptcy_cases ALTER COLUMN case_number TYPE TEXT;
  ALTER TABLE bankruptcy_cases ALTER COLUMN registration_number TYPE TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE enforcement_proceedings ALTER COLUMN debtor_type TYPE TEXT;
  ALTER TABLE enforcement_proceedings ALTER COLUMN creditor_type TYPE TEXT;
  ALTER TABLE enforcement_proceedings ALTER COLUMN proceeding_number TYPE TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE debtors ALTER COLUMN debtor_type TYPE TEXT;
  ALTER TABLE debtors ALTER COLUMN executor_phone TYPE TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE administrative_units ALTER COLUMN unit_type TYPE TEXT;
  ALTER TABLE administrative_units ALTER COLUMN koatuu TYPE TEXT;
  ALTER TABLE administrative_units ALTER COLUMN parent_koatuu TYPE TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE streets ALTER COLUMN street_id TYPE TEXT;
  ALTER TABLE streets ALTER COLUMN settlement_koatuu TYPE TEXT;
  ALTER TABLE streets ALTER COLUMN street_type TYPE TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
