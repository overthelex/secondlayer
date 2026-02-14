-- Migration 005: Widen narrow VARCHAR columns that cause truncation errors
-- special_forms.series was VARCHAR(20) but real data can exceed that

ALTER TABLE special_forms ALTER COLUMN series TYPE TEXT;
ALTER TABLE special_forms ALTER COLUMN form_number TYPE TEXT;

-- Also widen other columns that could hit limits with real data
ALTER TABLE bankruptcy_cases ALTER COLUMN debtor_edrpou TYPE VARCHAR(20);
ALTER TABLE enforcement_proceedings ALTER COLUMN debtor_edrpou TYPE VARCHAR(20);
ALTER TABLE enforcement_proceedings ALTER COLUMN creditor_edrpou TYPE VARCHAR(20);
ALTER TABLE debtors ALTER COLUMN debtor_edrpou TYPE VARCHAR(20);
