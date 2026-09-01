-- mcp_backend/src/migrations/206_ch_cantonal_aliases.sql
-- Cantonal abbreviation aliases: ch_act_alias learns which jurisdiction an
-- abbreviation belongs to.
--
-- Migration 199 built ch_act_alias for federal acts only, and migration 201
-- then put the cantonal collections into the same ch_act -- which the alias
-- seeding stage reads with no jurisdiction filter. Two consequences this
-- migration exists to fix:
--
--   1. A cantonal abbreviation is only unambiguous WITHIN its canton
--      ("LPA-VD" is Vaud's administrative-procedure act, "LPJA" is a
--      different act in BE, VS and elsewhere). Without a jurisdiction on the
--      alias row, the resolver cannot try "the citing canton's aliases and
--      never another canton's".
--
--   2. The existing seeding already leaked cantonal rows: 5,934
--      'fedlex_abbreviation' alias rows on prod (2026-08-31) actually came
--      from cantonal acts' abbreviation column, and 517 of them carry an
--      sr_number a FEDERAL act also uses -- so e.g. "EG ZGB" (a cantonal
--      introductory act) resolved to the unrelated federal act filed under
--      the same number. 87,082 resolved citations went through such rows.
--      Backfilling jurisdiction='CH' below is deliberately wrong for those
--      rows: aliases_stage's reconcile pass (which now scopes every derived
--      source by jurisdiction) deletes them on its next run and re-seeds
--      them under their real canton.
--
-- The PRIMARY KEY gains jurisdiction as its LAST column: two cantons may
-- legitimately map the same (abbr, lang) to the same systematic number
-- (cantonal collections copy each other's numbering plans), and appending
-- rather than prepending keeps every existing (abbr, ...) prefix lookup on
-- the PK index working unchanged -- the resolver's per-abbreviation probe
-- included.
--
-- Idempotent: the DO block re-keys the PK only when jurisdiction is not yet
-- part of it, the CHECK is guarded by duplicate_object, and everything else
-- is IF NOT EXISTS / OR REPLACE territory.

SET lock_timeout = '3s';

ALTER TABLE public.ch_act_alias
    ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'CH';

-- Same closed list as migration 201's ch_act_jurisdiction_chk: 'CH' plus the
-- 26 cantons. An alias row for a jurisdiction ch_act cannot hold is a row
-- the resolver could never join anyway.
DO $$ BEGIN
    ALTER TABLE public.ch_act_alias
        ADD CONSTRAINT ch_act_alias_jurisdiction_chk
        CHECK (jurisdiction IN ('CH',
            'AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU',
            'NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS',
            'ZG','ZH'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Re-key the PK from (abbr, lang, sr_number) to (abbr, lang, sr_number,
-- jurisdiction). Only when jurisdiction is not already in it, so a re-run is
-- a no-op; the table holds ~12K rows, so the rebuild is instant.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.key_column_usage k
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = k.constraint_name
           AND tc.table_schema = k.table_schema
         WHERE tc.table_schema = 'public'
           AND tc.table_name = 'ch_act_alias'
           AND tc.constraint_type = 'PRIMARY KEY'
           AND k.column_name = 'jurisdiction') THEN
        ALTER TABLE public.ch_act_alias DROP CONSTRAINT ch_act_alias_pkey;
        ALTER TABLE public.ch_act_alias
            ADD CONSTRAINT ch_act_alias_pkey
            PRIMARY KEY (abbr, lang, sr_number, jurisdiction);
    END IF;
END $$;

-- The batched retry pass (citations_resolve_stage, CHPIPE_CIT_RETRY_UNRESOLVED)
-- walks "WHERE match_method = 'unresolved_abbr' AND id > ? ORDER BY id".
-- 1.84M such rows sit scattered across a 17.6M-row table; without the
-- partial index every batch is a filtered walk of the PK.
CREATE INDEX IF NOT EXISTS idx_ch_leg_cit_unresolved_abbr
    ON public.ch_legislation_citations (id)
    WHERE match_method = 'unresolved_abbr';

COMMENT ON COLUMN public.ch_act_alias.jurisdiction IS
    'CH for federal aliases, two-letter canton code for a cantonal act''s '
    'abbreviation. A cantonal abbreviation is only meaningful within its own '
    'canton: the resolver tries CH aliases first, then the citing canton''s, '
    'never another canton''s.';
