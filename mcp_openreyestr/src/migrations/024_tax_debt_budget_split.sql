-- ДПС borg.json gives the debt as ZN_ALL (consolidated budget) = ZN_STATE + ZN_LOCAL, UAH.
-- 011 modelled it as tax/penalty/fine, which the source does not have; the first load
-- filled none of them (LEXAI-2194). debt_total holds ZN_ALL; these two hold the split.
ALTER TABLE tax_debt ADD COLUMN IF NOT EXISTS debt_state_budget NUMERIC;
ALTER TABLE tax_debt ADD COLUMN IF NOT EXISTS debt_local_budget NUMERIC;
