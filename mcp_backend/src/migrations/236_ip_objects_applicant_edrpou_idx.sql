-- LEXAI-2162: search_ip_objects / search_trademarks owner_edrpou now matches the holder's
-- code OR the first applicant's code. The importer (scripts/opendata/nipo/import_ndjson.py)
-- fills owner_edrpou from the holder only, and ~68.6K registered trademarks have an empty
-- holder EDRPOU while the applicant's is present (e.g. m201704396 → 22415322). Without
-- this index the applicant arm seq-scans ip_objects (measured on prod: 8.0 s for
-- owner_edrpou='22415322'); with it the filter is a BitmapOr of two index scans.
--
-- The expression must stay identical to APPLICANT_EDRPOU_SQL in
-- src/api/tools/ip-objects-tools.ts, and the predicate is implied by the query arm
-- `obj_type = 4 AND <expr> = $n`.
--
-- ip_objects is created by the NIPO importer, not by a migration: guarded so a database
-- without the table skips this. On such a database the importer's schema provisioning
-- (scripts/opendata/nipo/import_ndjson.py CREATE_SQL) creates the same index when it
-- creates the table, so the index exists either way. No data change, no backfill (status/owner are derived at
-- read time). Plain CREATE INDEX (CONCURRENTLY cannot run inside DO): reads continue;
-- importer upserts wait for the build.
SET statement_timeout = '15min';

DO $$
BEGIN
  IF to_regclass('public.ip_objects') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_ip_objects_applicant_edrpou
      ON ip_objects ((raw_data #>> '{ApplicantDetails,Applicant,0,ApplicantAddressBook,FormattedNameAddress,Name,FreeFormatName,EDRPOU}'))
      WHERE obj_type = 4;
  END IF;
END $$;
