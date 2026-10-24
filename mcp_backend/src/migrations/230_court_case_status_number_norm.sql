-- LEXAI-2104: search_court_case_status matched case_number by raw equality, so
-- «522/9583/16» found nothing while the registry holds the same case as «522/9583/16-ц»,
-- and numbers stored with stray whitespace (" 201/14253/25", "…/16- ц") were unreachable.
-- The tool now compares a whitespace-stripped, lower-cased number and, when the user typed
-- no proceeding suffix, also matches "<number>-%" (anchored on "-", so 522/9583/16 never
-- matches 522/9583/161). text_pattern_ops serves both the equality and the left-anchored
-- LIKE under the en_US.utf8 database collation, where the plain btree on case_number cannot.
-- The expression must stay identical to CASE_NUMBER_NORM_SQL in court-status-tools.ts.
--
-- CONCURRENTLY, one statement per file (the runner sends a file as a single simple query).
-- Measured on a copy of local's 1.25M rows: lookup 0.08 ms via BitmapOr of two index scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_case_status_case_norm
  ON opendata_court_case_status ((lower(regexp_replace(case_number, '\s+', '', 'g'))) text_pattern_ops);
