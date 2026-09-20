-- A refusal is not a verdict about the act — but verdict 900 meant two things.
--
-- 03_harvest_texts.py recorded every failed fetch as provision_count = 0, and
-- its worklist keys on provision_count IS NULL, so an act the source declined to
-- answer was written down as having no text and dropped out of every future run.
-- Verdict 900 is "200 with a zero-length body", which is how the origin turns
-- away a client it has decided against. It is never a document.
--
-- ⚠ The same 900 was ALSO written on the SUCCESS path, for an act that fetched
-- cleanly and genuinely has no provisions. One code, two opposite facts. Clearing
-- every 900 therefore destroys real verdicts along with the refusals — measured
-- on this corpus, 100,331 of them.
--
-- They are separable, by luck rather than design: only the success path writes a
-- text_hash, and for an act with no provisions that hash is sha256 of the empty
-- string. The refusal path passes NULL. So:
--
--   http_status 900 + text_hash NULL      -> refusal, clear it
--   http_status 900 + text_hash sha256('') -> real verdict, keep it, and correct
--                                             the status to the 200 it actually
--                                             was
--
-- The code no longer writes 900 on the success path, and a refusal no longer
-- records a provision count, so this repairs history only. Idempotent.
--
-- 903 is deliberately NOT in the refusal list: it means the body arrived and
-- does not parse, which is a fact about the document. An act whose XML is
-- broken has to be recorded, or it is retried forever against bytes that will
-- never parse.

-- 1. Refusals: back to unresolved so the worklist picks them up again.
--
-- provision_count and char_len only. http_status and fetched_at stay, because
-- they are the record of what happened and the worklist does not read them —
-- it keys on provision_count IS NULL. This matches what the code now writes for
-- a refusal, so history and future runs describe the same state the same way.
UPDATE uk_legislation_versions
   SET provision_count = NULL, char_len = NULL
 WHERE http_status IN (599, 900, 901, 902)
   AND text_hash IS NULL
   AND provision_count IS NOT NULL;

-- 2. Real verdicts wearing a refusal's code: say what actually happened.
UPDATE uk_legislation_versions
   SET http_status = 200
 WHERE http_status = 900
   AND text_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
