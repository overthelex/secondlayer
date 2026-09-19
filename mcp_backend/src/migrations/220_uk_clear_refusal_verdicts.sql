-- A refusal is not a verdict about the act.
--
-- 03_harvest_texts.py recorded every failed fetch as provision_count = 0, and
-- its worklist keys on provision_count IS NULL. So an act the source declined to
-- answer was written down as having no text and removed from every future run.
--
-- Verdict 900 is "HTTP 200 with a zero-length body", which is how Cloudflare
-- turns away a transport it has decided against. It is never a document. On
-- 2026-09-19 this corpus carried 100,361 version rows in that state, built up
-- over earlier runs, each one asserting that an act has no text when what
-- actually happened is that we were refused. 901 (a 200 that is not the XML
-- asked for) and 902 (over budget) mean the same thing; 599 means we gave up
-- retrying.
--
-- This puts them back to unresolved so the worklist can pick them up again. It
-- does not delete any text: rows with provisions are untouched by construction,
-- since a successful parse records 200.
--
-- The code no longer writes these — see REFUSAL_VERDICTS in 03_harvest_texts.py
-- — so this is a one-off repair of history. Idempotent: on a corpus that never
-- had the bug it updates nothing.
UPDATE uk_legislation_versions
   SET provision_count = NULL,
       char_len        = NULL,
       http_status     = NULL,
       fetched_at      = NULL
 WHERE http_status IN (599, 900, 901, 902)
   AND COALESCE(provision_count, 0) = 0;
