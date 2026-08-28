-- mcp_backend/src/migrations/204_ch_fedlex_pdf.sql
-- Widen ch_act_version.source for the federal PDF-era backfill. Written to
-- work whether or not 203 (feat/ch-cantonal-phase2, applied on prod by hand)
-- is present: DROP IF EXISTS + ADD NOT VALID + VALIDATE.
ALTER TABLE public.ch_act_version DROP CONSTRAINT IF EXISTS ch_act_version_source_chk;
ALTER TABLE public.ch_act_version ADD CONSTRAINT ch_act_version_source_chk
  CHECK (source IN ('fedlex','fedlex_pdf','lexwork','lexwork_pdf','lexfind','sil','ti_rl','zhlex')) NOT VALID;
ALTER TABLE public.ch_act_version VALIDATE CONSTRAINT ch_act_version_source_chk;
