-- Polish public procurement notices (Biuletyn Zamówień Publicznych) for lawrider.pl.
--
-- Source: https://ezamowienia.gov.pl/mo-board/api/v1/notice, free, no key
-- (Zarządzenie 20/2022 Prezesa UZP). Data since 2021, when e-Zamówienia
-- replaced the old BZP. html_body is the full notice as published.
--
-- Idempotent: scripts/pl/harvest_bzp.py applies this file itself on start.

CREATE TABLE IF NOT EXISTS pl_bzp_notices (
    object_id          text PRIMARY KEY,
    notice_type        text        NOT NULL,
    notice_number      text,
    bzp_number         text,
    tender_id          text,                 -- OCDS id, shared by all notices of one procedure
    publication_date   timestamptz NOT NULL,
    order_type         text,
    order_object       text,
    cpv_code           text,
    below_eu_threshold boolean,
    submitting_offers_date timestamptz,
    procedure_result   text,
    organization_name  text,
    organization_nip   text,
    organization_city  text,
    organization_province text,
    contractors        jsonb,
    html_body          text,
    payload            jsonb       NOT NULL, -- every other source field
    fetched_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pl_bzp_type_date ON pl_bzp_notices (notice_type, publication_date);
CREATE INDEX IF NOT EXISTS idx_pl_bzp_tender    ON pl_bzp_notices (tender_id);
CREATE INDEX IF NOT EXISTS idx_pl_bzp_org_nip   ON pl_bzp_notices (organization_nip);
CREATE INDEX IF NOT EXISTS idx_pl_bzp_contractors ON pl_bzp_notices USING gin (contractors jsonb_path_ops);
