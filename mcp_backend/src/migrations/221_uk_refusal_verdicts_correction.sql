-- Corrects 220_uk_clear_refusal_verdicts.sql, which cannot be edited in place.
--
-- 220 is already recorded as applied on at least one database, and the runner
-- skips a recorded filename forever. Editing it would silently do nothing where
-- it matters most — the environments that already ran the bad version.
--
-- What 220 got wrong: it cleared EVERY row with verdict 900, on the belief that
-- 900 always means "the transport was refused". It does not. 03_harvest_texts.py
-- also wrote 900 on its SUCCESS path, via `200 if rows else 900`, for an act
-- that fetched cleanly and genuinely has no provisions. One code, two opposite
-- facts, and 220 destroyed the second kind along with the first.
--
-- They are separable because only the success path writes a text_hash, and for
-- an act with no provisions that hash is sha256 of the empty string. The refusal
-- path passes NULL.
--
-- Idempotent, and a no-op on a database that never had the bug.

-- 1. Put back the real verdicts 220 cleared. These acts WERE fetched, the fetch
--    WAS a 200, and the act has no provisions — all three are facts.
--    ⚠ fetched_at is not recoverable; 220 cleared it and there is nowhere to
--    read the original from. now() is a stamp, not the truth.
UPDATE uk_legislation_versions
   SET provision_count = 0, char_len = 0, http_status = 200, fetched_at = now()
 WHERE provision_count IS NULL
   AND text_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

-- 2. Rows 220 did not reach: a success-path 900 that still carries its count.
--    Say what actually happened instead of wearing a refusal's code.
UPDATE uk_legislation_versions
   SET http_status = 200
 WHERE http_status = 900
   AND text_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

-- 3. Genuine refusals: unresolved, so the worklist picks them up again, but
--    keep http_status and fetched_at — they are the record of what happened and
--    the worklist keys only on provision_count IS NULL. This is what the code
--    now writes, so history and future runs describe the same state alike.
UPDATE uk_legislation_versions
   SET provision_count = NULL, char_len = NULL
 WHERE http_status IN (599, 900, 901, 902)
   AND text_hash IS NULL
   AND provision_count IS NOT NULL;
