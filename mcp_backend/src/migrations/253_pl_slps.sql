-- Polish random case assignment system (System Losowego Przydziału Spraw)
-- for lawrider.pl. Source: dane.gov.pl dataset 4549 (Ministerstwo
-- Sprawiedliwości, CC0), one ZIP of JSON per day, every random assignment in
-- every department of every common court: case signature, presiding judge,
-- and the pool of judges it could have gone to with their workload.
--
-- The case signature joins to court decisions, which is the only public
-- source of who sat on a case. Judges' names are public in this dataset by
-- design (the assignment record is published for transparency).
--
-- Stored compactly: one row per draw, and one row per judge per department
-- per day (the last report of that department that day), not the full
-- candidate list on every draw, which would repeat ~8 names 17K times a day.
--
-- Idempotent: scripts/pl/harvest_slps.py applies this file itself on start.

CREATE TABLE IF NOT EXISTS pl_slps_reports (
    resource_id  integer PRIMARY KEY,       -- dane.gov.pl resource id
    report_day   date,
    title        text,
    documents    integer,
    draws        integer,
    loaded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pl_slps_draws (
    resource_id      integer  NOT NULL,
    file_name        text     NOT NULL,
    draw_no          smallint NOT NULL,
    draw_date        date,
    court_name       text,
    department_id    text,
    department_name  text,
    case_signature   text,
    category         text,
    symbol           text,
    draw_result      text,
    presiding_judge  text,
    pool_size        smallint,
    candidates       smallint,
    court_case_in_draw_id bigint,
    meta             jsonb,                 -- the rest of the draw record
    PRIMARY KEY (resource_id, file_name, draw_no)
);

CREATE INDEX IF NOT EXISTS idx_pl_slps_draws_sig   ON pl_slps_draws (case_signature);
CREATE INDEX IF NOT EXISTS idx_pl_slps_draws_judge ON pl_slps_draws (presiding_judge);
CREATE INDEX IF NOT EXISTS idx_pl_slps_draws_dept  ON pl_slps_draws (department_id, draw_date);

CREATE TABLE IF NOT EXISTS pl_slps_department_judges (
    day             date    NOT NULL,
    department_id   text    NOT NULL,
    full_name       text    NOT NULL,
    court_name      text,
    department_name text,
    in_pool         boolean,
    workload        real,
    delegated_77_9  boolean,
    PRIMARY KEY (day, department_id, full_name)
);

CREATE INDEX IF NOT EXISTS idx_pl_slps_judges_name ON pl_slps_department_judges (full_name);
