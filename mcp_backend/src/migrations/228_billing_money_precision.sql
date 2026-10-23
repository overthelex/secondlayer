-- Migration 228: keep sub-cent amounts in the billing ledger.
--
-- user_billing and billing_transactions stored money as NUMERIC(10,2), so a per-call charge
-- below half a cent was rounded away (balance_usd 38.69 - 0.003133 = 38.69) and every other
-- charge was rounded to a whole cent. With per-call list prices (migrations 227, cost-tracker
-- list-price floor) most MCP tools cost $0.0003-$0.025, so the ledger has to hold 6 decimals.
--
-- Four views read these columns, and ALTER COLUMN TYPE refuses to run under a view, so their
-- definitions and grants are saved, the views dropped, the columns widened and the views
-- recreated as they were. Idempotent: does nothing once balance_usd already has scale 6.

DO $$
DECLARE
  v record;
  g record;
BEGIN
  IF (SELECT numeric_scale FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'user_billing' AND column_name = 'balance_usd') = 6 THEN
    RAISE NOTICE 'billing money columns already NUMERIC(*,6), skipping';
    RETURN;
  END IF;

  CREATE TEMP TABLE _billing_views ON COMMIT DROP AS
    SELECT c.oid, c.relname, pg_get_viewdef(c.oid) AS def
      FROM pg_class c
     WHERE c.relkind = 'v'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('billing_migration_status', 'pricing_tier_stats',
                         'user_billing_summary', 'user_full_settings');

  CREATE TEMP TABLE _billing_view_grants ON COMMIT DROP AS
    SELECT c.relname, pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid IN (SELECT oid FROM _billing_views)
       AND a.grantee <> c.relowner
       AND a.grantee <> 0;

  FOR v IN SELECT relname FROM _billing_views LOOP
    EXECUTE format('DROP VIEW public.%I', v.relname);
  END LOOP;

  ALTER TABLE user_billing
    ALTER COLUMN balance_usd     TYPE NUMERIC(16,6),
    ALTER COLUMN balance_uah     TYPE NUMERIC(16,6),
    ALTER COLUMN total_spent_usd TYPE NUMERIC(16,6),
    ALTER COLUMN total_spent_uah TYPE NUMERIC(16,6);

  ALTER TABLE billing_transactions
    ALTER COLUMN amount_usd         TYPE NUMERIC(16,6),
    ALTER COLUMN amount_uah         TYPE NUMERIC(16,6),
    ALTER COLUMN balance_before_usd TYPE NUMERIC(16,6),
    ALTER COLUMN balance_after_usd  TYPE NUMERIC(16,6),
    ALTER COLUMN balance_before_uah TYPE NUMERIC(16,6),
    ALTER COLUMN balance_after_uah  TYPE NUMERIC(16,6);

  FOR v IN SELECT relname, def FROM _billing_views LOOP
    EXECUTE format('CREATE VIEW public.%I AS %s', v.relname, v.def);
  END LOOP;

  FOR g IN SELECT * FROM _billing_view_grants LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', g.privilege_type, g.relname, g.grantee);
  END LOOP;
END $$;
