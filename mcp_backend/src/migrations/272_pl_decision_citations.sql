-- Citation graph: Polish court decision -> act (ELI) -> article (LEXAI-2241).
--
-- Built by scripts/pl/build_decision_citations.py from the legal bases the sources already
-- carry, no full-text regex:
--   hf-pl-nsa, hf-pl-court-raw  metadata_json->'extracted_legal_bases'  (ISAP link WDU20120000270)
--   saos                        referenced_regulations                   (journalYear / journalEntry)
--
-- act_eli is the base act, cited_eli the edition as cited. NSA cites the consolidated text
-- (an obwieszczenie, e.g. DU/2012/270 for the PPSA of DU/2002/1270), so citations are folded
-- onto the base act through pl_acts.consolidates_eli and one query on the base act finds them all.
--
-- One row per (decision, cited edition, article); art_no NULL when the reference names the act
-- only or only a paragraph (§) of a rozporządzenie. art_no uses the pl_act_articles form
-- (415, 22^1, 18^3a). raw keeps the source fragments. act_resolved / art_resolved say whether
-- the edition is in pl_acts and the article in pl_act_articles of the base act.
--
-- Columns of the decision (date, court type) are copied in so the tool's counts by court and
-- year never touch the 105 GB pl_court_decisions table.
--
-- On pg-lawrider the lookup indexes were built by hand with CREATE INDEX CONCURRENTLY after the
-- first load; IF NOT EXISTS makes them a no-op there.

CREATE TABLE IF NOT EXISTS pl_decision_citations (
  decision_id   TEXT NOT NULL,
  source        TEXT NOT NULL,
  decision_date DATE,
  court_type    TEXT,
  act_eli       TEXT NOT NULL,
  cited_eli     TEXT NOT NULL,
  art_no        TEXT,
  raw           TEXT NOT NULL,
  act_resolved  BOOLEAN NOT NULL DEFAULT false,
  art_resolved  BOOLEAN NOT NULL DEFAULT false
);

-- The loader replaces a shard by deleting its decisions first.
CREATE INDEX IF NOT EXISTS idx_pl_dec_cit_decision ON pl_decision_citations (decision_id);

-- pl_find_decisions_by_article: by article, and by act when no article is given.
CREATE INDEX IF NOT EXISTS idx_pl_dec_cit_article
  ON pl_decision_citations (act_eli, art_no, decision_date DESC NULLS LAST) INCLUDE (court_type, decision_id);
CREATE INDEX IF NOT EXISTS idx_pl_dec_cit_act
  ON pl_decision_citations (act_eli, decision_date DESC NULLS LAST) INCLUDE (court_type, decision_id);

-- One row per loaded shard (source + month of decision_date, or 'other'): resume and audit.
CREATE TABLE IF NOT EXISTS pl_decision_citation_shards (
  source         TEXT NOT NULL,
  shard          TEXT NOT NULL,
  n_decisions    INTEGER NOT NULL,
  n_with_cites   INTEGER NOT NULL,
  n_rows         INTEGER NOT NULL,
  n_act_resolved INTEGER NOT NULL,
  n_art_rows     INTEGER NOT NULL,
  n_art_resolved INTEGER NOT NULL,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, shard)
);
