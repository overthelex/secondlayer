-- REPAIR: verdict 900 meant two opposite things (2026-09-19)
--
-- Not a migration. This repairs damage that happened to specific databases at a
-- specific time; a deployment that never had the damage must not run it, and
-- running it is a decision someone makes while watching, not something that
-- happens during a deploy.
--
-- Run with: .github/workflows/run-repair.yml
--
-- ── what happened ────────────────────────────────────────────────────────────
-- 03_harvest_texts.py recorded every failed fetch as provision_count = 0, and
-- its worklist keys on provision_count IS NULL. So an act the source declined to
-- answer was written down as having no text and dropped out of every future run.
-- Verdict 900 is "HTTP 200 with a zero-length body" — how the origin turns away
-- a client it has decided against. It is never a document.
--
-- ⚠ The same 900 was ALSO written on the SUCCESS path, by `200 if rows else 900`,
-- for an act that fetched cleanly and genuinely has no provisions. One code, two
-- opposite facts. Clearing every 900 destroys real verdicts along with refusals:
-- 100,331 of them on the UK corpus, measured.
--
-- They are separable, by luck rather than design. Only the success path writes a
-- text_hash, and for an act with no provisions that hash is sha256 of the empty
-- string; the refusal path passes NULL.
--
-- ── measured before running ──────────────────────────────────────────────────
--   lawrider.uk (London)   100,361 rows with verdict 900
--   legal.org.ua (cthulhu) none — every version row there is already 200
--
-- Idempotent. A no-op on a database that never had the bug.

-- 1. Real verdicts wearing a refusal's code. The fetch WAS a 200 and the act has
--    no provisions; both are facts, and the row should say so.
UPDATE uk_legislation_versions
   SET http_status = 200
 WHERE http_status = 900
   AND text_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

-- 2. Genuine refusals: back to unresolved so the worklist picks them up again.
--    provision_count and char_len only — http_status and fetched_at are the
--    record of what happened, and the worklist reads neither.
UPDATE uk_legislation_versions
   SET provision_count = NULL, char_len = NULL
 WHERE http_status IN (599, 900, 901, 902)
   AND text_hash IS NULL
   AND provision_count IS NOT NULL;

-- 3. If an earlier, blunter version of this repair cleared real verdicts too,
--    put them back. Safe to run when it did not: the predicate matches nothing.
--    ⚠ fetched_at cannot be recovered and is stamped now(). The verdict and the
--    count are right; the timestamp is not the original.
UPDATE uk_legislation_versions
   SET provision_count = 0, char_len = 0, http_status = 200, fetched_at = now()
 WHERE provision_count IS NULL
   AND text_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
