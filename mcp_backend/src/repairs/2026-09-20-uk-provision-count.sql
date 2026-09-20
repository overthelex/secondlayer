-- REPAIR: version rows claiming fewer provisions than the act holds (2026-09-20)
--
-- Not a migration: this corrects damage on databases that ran the old
-- 03_harvest_texts.py, and a deployment that never did must not run it.
-- Run with .github/workflows/run-repair.yml.
--
-- ── what happened ────────────────────────────────────────────────────────────
-- Stage 3 wrote provision_count and char_len from ITS OWN parse of the bare
-- URI. It is not the only writer of uk_legislation_provisions — stage 5 fills
-- the same key from the bulk archives — and the bare URI often serves a thinner
-- representation than the archive does. ukpga/Vict/47-48/54 answers 200 with
-- NumberOfProvisions=3 while the archive yields 51, so stage 3 recorded zero
-- for an act holding 51 provisions.
--
-- The text was never lost: INS_PROV upserts, so the rows stayed. What broke was
-- the column describing them, which is worse than a missing column because it
-- reads as an answer.
--
-- ── measured before running ──────────────────────────────────────────────────
-- 25 version rows on the lawrider.uk corpus, every one of them claiming FEWER
-- than the act holds, seven claiming zero against 51, 43 and 39 actual.
--
-- The code no longer does this — when a parse yields no provisions the count is
-- taken from the table instead of asserted as zero — so this repairs history.
-- Idempotent, and a no-op where the counts already agree.
-- All three columns, not just the count. char_len and text_hash describe the
-- same rows and drift for the same reason; a predicate testing only the count
-- would leave a version whose text changed without changing how many there are.
--
-- char_len reproduces len("\n".join(texts)) exactly — the characters plus one
-- separator between each adjacent pair — because that is what the harvester has
-- always written and the column is compared across runs.
UPDATE uk_legislation_versions v
   SET provision_count = a.n,
       char_len        = a.chars,
       text_hash       = a.hash
  FROM (SELECT leg_id, valid_from,
               count(*) AS n,
               coalesce(sum(n_chars), 0) + greatest(count(*) - 1, 0) AS chars,
               encode(sha256(convert_to(
                 coalesce(string_agg(text, E'\n' ORDER BY ord), ''), 'UTF8')), 'hex') AS hash
          FROM uk_legislation_provisions
         GROUP BY leg_id, valid_from) a
 WHERE a.leg_id = v.leg_id
   AND a.valid_from = v.valid_from
   AND v.provision_count IS NOT NULL
   AND (v.provision_count IS DISTINCT FROM a.n
     OR v.char_len        IS DISTINCT FROM a.chars
     OR v.text_hash       IS DISTINCT FROM a.hash);
