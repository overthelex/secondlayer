-- 218: history of UK corpus verification runs.
--
-- The weekly refresh (scripts/uk/run-uk-refresh.sh) can fail in two ways. It can
-- error, which is loud, or it can succeed against a source that moved under it,
-- which is silent — and silence is the failure this project has already had.
-- `cron-edrsr-sync.yml` carries the note in its own header: the workflow pointed
-- at a runner label nothing carried any more, every scheduled run sat in the
-- queue until GitHub cancelled it, "and nothing said so" — noticed only when the
-- corpus turned out to hold zero decisions for September.
--
-- So every verification run records its counts here, and the next run compares
-- against the last one. A refresh that halves the corpus is then a failed check
-- rather than a discovery made months later.
CREATE TABLE IF NOT EXISTS uk_corpus_check_run (
    id                 bigserial PRIMARY KEY,
    ran_at             timestamptz NOT NULL DEFAULT now(),
    ok                 boolean     NOT NULL,
    acts               integer     NOT NULL,
    acts_with_text     integer     NOT NULL,
    provisions         bigint      NOT NULL,
    pit_acts           integer     NOT NULL,
    pit_rows           bigint      NOT NULL,
    pit_texts          bigint      NOT NULL,
    effects            bigint      NOT NULL,
    newest_register    timestamptz,
    failures           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    warnings           jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_uk_check_ran_at ON uk_corpus_check_run (ran_at DESC);
