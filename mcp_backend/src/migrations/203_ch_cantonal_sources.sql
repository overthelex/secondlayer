-- 203: more sources for cantonal editions (phase 2 of the cantonal corpus).
--
-- 201 allowed ch_act_version.source IN ('fedlex', 'lexwork'). Phase 2 adds:
--   lexfind  a PDF served by lexfind.ch (/tolv/{version}/{lang}): the 7 cantons
--            without a Lexwork host, abrogated acts the hosts do not serve, and
--            editions older than a host's history (~2015)
--   sil      Word-HTML from the SIL platform (GE silgeneve.ch, NE rsn.ne.ch)
--   ti_rl    HTML from Ticino's Raccolta delle leggi (www3.ti.ch)
--   zhlex    Zürich's ZH-Lex (zh.ch JSON index, PDF on notes.zh.ch)
-- and records where a PDF-only Lexwork edition's text came from:
--   lexwork_pdf  the host's own PDF (pdf_link_tol) run through the PDF path
-- Idempotent: drop + re-add the constraint under its 201 name.
DO $$
BEGIN
    ALTER TABLE public.ch_act_version DROP CONSTRAINT IF EXISTS ch_act_version_source_chk;
    ALTER TABLE public.ch_act_version
        ADD CONSTRAINT ch_act_version_source_chk
        CHECK (source IN ('fedlex', 'lexwork', 'lexwork_pdf', 'lexfind', 'sil', 'ti_rl', 'zhlex'));
END $$;

COMMENT ON COLUMN public.ch_act_version.source IS
    'fedlex: AKN XML from Fedlex; lexwork: show_as_json payload of a Lexwork host; '
    'lexwork_pdf: the host''s PDF of a version it holds without a structured document; '
    'lexfind: PDF from lexfind.ch; sil: SIL Word-HTML (GE, NE); ti_rl: Ticino RLeggi HTML; '
    'zhlex: ZH-Lex. akn_xml holds the raw payload for every source.';
