-- Migration 279: hearing lookup by normalised case number.
--
-- ~127K court_sessions rows (0.4%) carry whitespace in case_number: trailing/leading spaces,
-- NBSP or line breaks that btrim() does not remove. An exact case_number = ANY(...) misses them,
-- so search_case_status_by_party / get_case_status_details match on the same normalisation as
-- court_case_status_history (idx_ccsh_case_norm): lower(regexp_replace(case_number, '\s+', '', 'g')).
--
-- Single statement on purpose: CONCURRENTLY cannot run inside the implicit transaction of a
-- multi-statement query. Built by hand on prod 18.11.2026 (30M rows), so on deploy this is a no-op.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_court_sessions_case_norm
  ON court_sessions (lower(regexp_replace(case_number, '\s+', '', 'g')) text_pattern_ops);
