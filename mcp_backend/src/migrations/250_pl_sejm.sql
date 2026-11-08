-- Polish Sejm open data (https://api.sejm.gov.pl/sejm) for lawrider.pl.
--
-- One table for every object kind the API serves (MP, committee, print,
-- legislative process with its stages, bill, sitting, voting with the
-- per-MP result, interpellation, written question). Payloads are kept as the
-- source sends them: the API adds fields over time (2026-02-18 /bills,
-- 2026-08-25 oathDate/mandateExpiryDate) and a jsonb column keeps them without
-- a migration per change. Typed views can come once tools need them.
--
-- process payloads carry ELI of the resulting act, which joins to pl_acts.eli.
--
-- Idempotent: scripts/pl/harvest_sejm.py applies this file itself on start.

CREATE TABLE IF NOT EXISTS pl_sejm_objects (
    kind        text        NOT NULL,   -- mp | committee | print | process | bill | proceeding | voting | interpellation | written_question
    term        smallint    NOT NULL,
    key         text        NOT NULL,   -- number / id / "proceeding/voting"
    title       text,
    changed_at  timestamptz,            -- source changeDate / lastModified when it has one
    payload     jsonb       NOT NULL,
    source_url  text        NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, term, key)
);

CREATE INDEX IF NOT EXISTS idx_pl_sejm_process_eli
    ON pl_sejm_objects ((payload->>'ELI')) WHERE kind = 'process';
CREATE INDEX IF NOT EXISTS idx_pl_sejm_title_fts
    ON pl_sejm_objects USING gin (to_tsvector('simple', coalesce(title, '')));
