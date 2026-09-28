-- Migration 222: judgments kept in the holding but hidden from every search
--
-- The 28.09.2026 audit of uk_court_decisions found rows that are not judgments:
-- Find Case Law placeholders left where a judgment was withdrawn, removed by order
-- of the court or moved to another citation ("withdrawn", "Removed by order of the
-- court 16/Dec/2020 12:28", "Moved to: [2016] EWCOP 57"), and two rows with no text
-- at all. Licence principle 9 commits us to not serving what the court has taken
-- down, so they leave the search results.
--
-- Hidden rather than deleted, at the owner's instruction: the rows stay in
-- uk_court_decisions for the record, and a re-harvest can decide their fate.
--
-- ⚠ [2012] EWHC 3030 (Admin) matched the same text pattern ("the appeal has been
-- withdrawn") but is a real judgment. It is deliberately NOT in this list.
--
-- Read by uk_search_judgments and by the uk_court_decisions registry (baseWhere).

CREATE TABLE IF NOT EXISTS uk_court_decision_hidden (
    id         TEXT PRIMARY KEY REFERENCES uk_court_decisions (id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    hidden_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only ids that exist are inserted, so this is a no-op on a database without the
-- UK holding (legal.org.ua, lawrider.ch). The reason quotes the stored text itself.
INSERT INTO uk_court_decision_hidden (id, reason)
SELECT d.id,
       CASE WHEN COALESCE(length(d.full_text), 0) = 0 THEN 'empty full_text'
            ELSE 'Find Case Law placeholder, not a judgment: ' ||
                 btrim(regexp_replace(d.full_text, '\s+', ' ', 'g')) END
  FROM uk_court_decisions d
 WHERE d.id IN (
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2004/2064',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2006/2892',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/comm/2011/68',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2013/3158',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2014/693',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2015/1842',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/admin/2015/847',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2016/3256',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/ch/2017/350',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ukut/lc/2017/135',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewfc/2020/62',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2020/3396',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2020/3510',
    'tna-https://caselaw.nationalarchives.gov.uk/id/ewhc/fam/2020/3790'
 )
ON CONFLICT (id) DO NOTHING;
