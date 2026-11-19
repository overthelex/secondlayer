#!/usr/bin/env python3
"""
US Open Data Import — parallel download + PostgreSQL import.
Downloads 10 free federal data sources simultaneously and imports into prod DB.

Usage:
    python3 import-us-opendata.py                     # import all sources
    python3 import-us-opendata.py --source osha       # single source
    python3 import-us-opendata.py --source fec_committees --source osha
    python3 import-us-opendata.py --list              # list available sources
    python3 import-us-opendata.py --dry-run           # download only, no import
    python3 import-us-opendata.py --create-tables     # create tables only

Environment:
    POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
    DATA_DIR (default: /mnt/opendata/us)

Requires: pip install aiohttp aiofiles psycopg2-binary
"""

import argparse
import asyncio
import csv
import io
import json
import logging
import os
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import aiohttp
import aiofiles
import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("us-opendata")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/mnt/opendata/us"))
BATCH_SIZE = 5000
USER_AGENT = "SecondLayer-Legal-Platform/1.0 (+https://legal.org.ua) opendata-import"


def get_db():
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ.get("POSTGRES_USER", "secondlayer"),
        password=os.environ.get("POSTGRES_PASSWORD", "secondlayer"),
        dbname=os.environ.get("POSTGRES_DB", "secondlayer_prod"),
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TABLE DEFINITIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE_TABLES_SQL = """
-- OFAC Specially Designated Nationals
CREATE TABLE IF NOT EXISTS us_ofac_sanctions (
    uid TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL,
    sdn_name TEXT NOT NULL,
    sdn_type TEXT,
    program TEXT,
    title TEXT,
    remarks TEXT,
    call_sign TEXT,
    vessel_type TEXT,
    tonnage TEXT,
    grt TEXT,
    vessel_flag TEXT,
    vessel_owner TEXT,
    addresses JSONB DEFAULT '[]',
    aliases JSONB DEFAULT '[]',
    ids JSONB DEFAULT '[]',
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_ofac_name_fts ON us_ofac_sanctions USING gin(to_tsvector('simple', sdn_name));
CREATE INDEX IF NOT EXISTS idx_us_ofac_program ON us_ofac_sanctions(program);
CREATE INDEX IF NOT EXISTS idx_us_ofac_type ON us_ofac_sanctions(sdn_type);

-- SAM.gov Exclusions (debarment)
CREATE TABLE IF NOT EXISTS us_sam_exclusions (
    sam_number TEXT PRIMARY KEY,
    uei TEXT,
    cage_code TEXT,
    name TEXT NOT NULL,
    prefix TEXT,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    suffix TEXT,
    entity_type TEXT,
    address_1 TEXT,
    address_2 TEXT,
    city TEXT,
    state_province TEXT,
    country TEXT,
    zip_code TEXT,
    duns TEXT,
    exclusion_type TEXT,
    exclusion_program TEXT,
    excluding_agency TEXT,
    ct_code TEXT,
    active_date DATE,
    termination_date DATE,
    record_status TEXT,
    cross_reference JSONB DEFAULT '[]',
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_sam_name_fts ON us_sam_exclusions USING gin(to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_us_sam_excl_type ON us_sam_exclusions(exclusion_type);
CREATE INDEX IF NOT EXISTS idx_us_sam_agency ON us_sam_exclusions(excluding_agency);

-- FEC Committees
CREATE TABLE IF NOT EXISTS us_fec_committees (
    committee_id TEXT PRIMARY KEY,
    committee_name TEXT NOT NULL,
    treasurer_name TEXT,
    street_1 TEXT,
    street_2 TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    committee_designation TEXT,
    committee_type TEXT,
    party TEXT,
    filing_frequency TEXT,
    interest_group_category TEXT,
    connected_org_name TEXT,
    candidate_id TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_fec_comm_name_fts ON us_fec_committees USING gin(to_tsvector('simple', committee_name));
CREATE INDEX IF NOT EXISTS idx_us_fec_comm_party ON us_fec_committees(party);
CREATE INDEX IF NOT EXISTS idx_us_fec_comm_type ON us_fec_committees(committee_type);

-- FEC Individual Contributions (current cycle)
CREATE TABLE IF NOT EXISTS us_fec_contributions (
    id BIGSERIAL PRIMARY KEY,
    committee_id TEXT,
    amendment_indicator TEXT,
    report_type TEXT,
    transaction_pgi TEXT,
    image_num TEXT,
    transaction_type TEXT,
    entity_type TEXT,
    contributor_name TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    employer TEXT,
    occupation TEXT,
    transaction_date DATE,
    transaction_amount NUMERIC,
    other_id TEXT,
    tran_id TEXT,
    file_num TEXT,
    memo_cd TEXT,
    memo_text TEXT,
    sub_id BIGINT UNIQUE,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_fec_contrib_name_fts ON us_fec_contributions USING gin(to_tsvector('simple', contributor_name));
CREATE INDEX IF NOT EXISTS idx_us_fec_contrib_committee ON us_fec_contributions(committee_id);
CREATE INDEX IF NOT EXISTS idx_us_fec_contrib_date ON us_fec_contributions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_us_fec_contrib_amount ON us_fec_contributions(transaction_amount);

-- FARA Foreign Agent Registrations
CREATE TABLE IF NOT EXISTS us_fara_registrants (
    registration_number TEXT PRIMARY KEY,
    registrant_name TEXT NOT NULL,
    address TEXT,
    state TEXT,
    country TEXT,
    registration_date DATE,
    termination_date DATE,
    status TEXT,
    foreign_principals JSONB DEFAULT '[]',
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_fara_name_fts ON us_fara_registrants USING gin(to_tsvector('simple', registrant_name));
CREATE INDEX IF NOT EXISTS idx_us_fara_status ON us_fara_registrants(status);
CREATE INDEX IF NOT EXISTS idx_us_fara_country ON us_fara_registrants(country);

-- CFPB Consumer Complaints
CREATE TABLE IF NOT EXISTS us_cfpb_complaints (
    complaint_id BIGINT PRIMARY KEY,
    date_received DATE,
    product TEXT,
    sub_product TEXT,
    issue TEXT,
    sub_issue TEXT,
    consumer_complaint_narrative TEXT,
    company_public_response TEXT,
    company TEXT,
    state TEXT,
    zip_code TEXT,
    tags TEXT,
    consumer_consent_provided TEXT,
    submitted_via TEXT,
    date_sent_to_company DATE,
    company_response TEXT,
    timely_response TEXT,
    consumer_disputed TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_cfpb_company_fts ON us_cfpb_complaints USING gin(to_tsvector('simple', company));
CREATE INDEX IF NOT EXISTS idx_us_cfpb_product ON us_cfpb_complaints(product);
CREATE INDEX IF NOT EXISTS idx_us_cfpb_date ON us_cfpb_complaints(date_received);
CREATE INDEX IF NOT EXISTS idx_us_cfpb_state ON us_cfpb_complaints(state);

-- OSHA Inspections
CREATE TABLE IF NOT EXISTS us_osha_inspections (
    activity_nr BIGINT PRIMARY KEY,
    reporting_id TEXT,
    state_flag TEXT,
    estab_name TEXT,
    site_address TEXT,
    site_city TEXT,
    site_state TEXT,
    site_zip TEXT,
    owner_type TEXT,
    owner_code TEXT,
    adv_notice TEXT,
    safety_hlth TEXT,
    sic_code TEXT,
    naics_code TEXT,
    insp_type TEXT,
    insp_scope TEXT,
    why_no_insp TEXT,
    union_status TEXT,
    safety_manuf TEXT,
    safety_const TEXT,
    safety_marit TEXT,
    health_manuf TEXT,
    health_const TEXT,
    health_marit TEXT,
    migrant TEXT,
    mail_street TEXT,
    mail_city TEXT,
    mail_state TEXT,
    mail_zip TEXT,
    host_est_key TEXT,
    nr_in_estab INTEGER,
    open_date DATE,
    case_mod_date DATE,
    close_conf_date DATE,
    close_case_date DATE,
    open_year INTEGER,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_osha_estab_fts ON us_osha_inspections USING gin(to_tsvector('simple', estab_name));
CREATE INDEX IF NOT EXISTS idx_us_osha_state ON us_osha_inspections(site_state);
CREATE INDEX IF NOT EXISTS idx_us_osha_naics ON us_osha_inspections(naics_code);
CREATE INDEX IF NOT EXISTS idx_us_osha_open_date ON us_osha_inspections(open_date);

-- NHTSA Vehicle Recalls
CREATE TABLE IF NOT EXISTS us_nhtsa_recalls (
    nhtsa_campaign_number TEXT PRIMARY KEY,
    manufacturer TEXT,
    subject TEXT,
    component TEXT,
    mfr_campaign_number TEXT,
    recall_type TEXT,
    potentially_affected INTEGER,
    report_received_date DATE,
    recall_initiation_date DATE,
    defect_summary TEXT,
    consequence_summary TEXT,
    corrective_summary TEXT,
    park_it TEXT,
    park_outside TEXT,
    do_not_drive TEXT,
    notes TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_nhtsa_mfr_fts ON us_nhtsa_recalls USING gin(to_tsvector('simple', manufacturer));
CREATE INDEX IF NOT EXISTS idx_us_nhtsa_subject_fts ON us_nhtsa_recalls USING gin(to_tsvector('simple', subject));
CREATE INDEX IF NOT EXISTS idx_us_nhtsa_date ON us_nhtsa_recalls(report_received_date);

-- FDA Enforcement Actions (recalls)
CREATE TABLE IF NOT EXISTS us_fda_enforcement (
    recall_number TEXT PRIMARY KEY,
    event_id TEXT,
    status TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    voluntary_mandated TEXT,
    initial_firm_notification TEXT,
    recall_initiation_date DATE,
    center_classification_date DATE,
    termination_date DATE,
    classification TEXT,
    product_type TEXT,
    product_description TEXT,
    reason_for_recall TEXT,
    distribution_pattern TEXT,
    product_quantity TEXT,
    recalling_firm TEXT,
    report_date DATE,
    code_info TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_fda_firm_fts ON us_fda_enforcement USING gin(to_tsvector('simple', recalling_firm));
CREATE INDEX IF NOT EXISTS idx_us_fda_product_fts ON us_fda_enforcement USING gin(to_tsvector('simple', product_description));
CREATE INDEX IF NOT EXISTS idx_us_fda_classification ON us_fda_enforcement(classification);
CREATE INDEX IF NOT EXISTS idx_us_fda_date ON us_fda_enforcement(report_date);

-- EPA ECHO Facilities
CREATE TABLE IF NOT EXISTS us_epa_facilities (
    registry_id TEXT PRIMARY KEY,
    fac_name TEXT,
    fac_street TEXT,
    fac_city TEXT,
    fac_state TEXT,
    fac_zip TEXT,
    fac_county TEXT,
    fac_fips_code TEXT,
    fac_epa_region TEXT,
    fac_lat NUMERIC,
    fac_long NUMERIC,
    fac_naics_codes TEXT,
    fac_sic_codes TEXT,
    fac_indian_cntry_flg TEXT,
    fac_federal_flg TEXT,
    fac_active_flag TEXT,
    fac_qtrs_with_nc INTEGER,
    fac_compliance_status TEXT,
    fac_penalty_count INTEGER,
    fac_last_penalty_amt NUMERIC,
    fac_informal_count INTEGER,
    fac_formal_count INTEGER,
    fac_date_last_inspection DATE,
    fac_date_last_formal_act DATE,
    caa_flag TEXT,
    cwa_flag TEXT,
    rcra_flag TEXT,
    sdwa_flag TEXT,
    tri_flag TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_us_epa_name_fts ON us_epa_facilities USING gin(to_tsvector('simple', fac_name));
CREATE INDEX IF NOT EXISTS idx_us_epa_state ON us_epa_facilities(fac_state);
CREATE INDEX IF NOT EXISTS idx_us_epa_compliance ON us_epa_facilities(fac_compliance_status);
CREATE INDEX IF NOT EXISTS idx_us_epa_naics ON us_epa_facilities(fac_naics_codes);

-- Register in import_source_catalog
INSERT INTO import_source_catalog (name, title, source_type, source_url, target_table, rate_limit_ms, enabled)
VALUES
    ('us_ofac_sdn', 'OFAC — Specially Designated Nationals (SDN)', 'file_download', 'https://www.treasury.gov/ofac/downloads/sdn_xml.zip', 'us_ofac_sanctions', 0, true),
    ('us_sam_exclusions', 'SAM.gov — Exclusions/Debarment List', 'file_download', 'https://sam.gov/api/prod/fileextract/v1/api/listExclusions?random=LATEST', 'us_sam_exclusions', 0, true),
    ('us_fec_committees', 'FEC — Committee Master File', 'file_download', 'https://www.fec.gov/files/bulk-downloads/2024/cm24.zip', 'us_fec_committees', 0, true),
    ('us_fec_contributions', 'FEC — Individual Contributions', 'file_download', 'https://www.fec.gov/files/bulk-downloads/2024/indiv24.zip', 'us_fec_contributions', 0, true),
    ('us_fara_registrants', 'FARA — Foreign Agent Registrations', 'api_paginated', 'https://efile.fara.gov/ords/fara/q/registrantDt', 'us_fara_registrants', 500, true),
    ('us_cfpb_complaints', 'CFPB — Consumer Complaints', 'file_download', 'https://files.consumerfinance.gov/ccdb/complaints.csv.zip', 'us_cfpb_complaints', 0, true),
    ('us_osha_inspections', 'OSHA — Workplace Inspections', 'file_download', 'https://enforcedata.dol.gov/views/data_summary/osha_inspection.csv.zip', 'us_osha_inspections', 0, true),
    ('us_nhtsa_recalls', 'NHTSA — Vehicle Recalls', 'file_download', 'https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL.zip', 'us_nhtsa_recalls', 0, true),
    ('us_fda_enforcement', 'FDA — Enforcement/Recall Actions', 'api_paginated', 'https://api.fda.gov/drug/enforcement.json', 'us_fda_enforcement', 250, true),
    ('us_epa_facilities', 'EPA ECHO — Regulated Facilities', 'file_download', 'https://echo.epa.gov/files/echodownloads/fac_downloads.zip', 'us_epa_facilities', 0, true)
ON CONFLICT (name) DO UPDATE SET
    source_url = EXCLUDED.source_url,
    enabled = EXCLUDED.enabled;
"""


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SOURCE DEFINITIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@dataclass
class ImportSource:
    name: str
    title: str
    url: str
    file_type: str  # 'zip_csv', 'zip_xml', 'csv', 'json_api', 'zip_flat'
    target_table: str
    desc: str = ""


SOURCES = {
    # OFAC moved to scripts/sanctions/load_sanctions.py (LEXAI-2299): SDN + Consolidated,
    # keyed by (uid, entry_type), scheduled by opendata-sync.
    "sam_exclusions": ImportSource(
        name="sam_exclusions",
        title="SAM.gov Exclusions",
        url="https://sam.gov/api/prod/fileextract/v2/exclusions?api_key=DEMO_KEY&format=csv&fileName=SAM_Exclusions_Public_Extract",
        file_type="csv",
        target_table="us_sam_exclusions",
        desc="Government contractor debarment list — 163K+ records",
    ),
    "fec_committees": ImportSource(
        name="fec_committees",
        title="FEC Committees",
        url="https://www.fec.gov/files/bulk-downloads/2024/cm24.zip",
        file_type="zip_flat",
        target_table="us_fec_committees",
        desc="Federal Election Commission committee master file",
    ),
    "fec_contributions": ImportSource(
        name="fec_contributions",
        title="FEC Individual Contributions",
        url="https://www.fec.gov/files/bulk-downloads/2024/indiv24.zip",
        file_type="zip_flat",
        target_table="us_fec_contributions",
        desc="Individual political contributions >$200 (current cycle)",
    ),
    "fara": ImportSource(
        name="fara",
        title="FARA Foreign Agents",
        url="https://efile.fara.gov/ords/fara/q/registrantDt",
        file_type="json_api",
        target_table="us_fara_registrants",
        desc="Foreign Agents Registration Act registrants",
    ),
    "cfpb": ImportSource(
        name="cfpb",
        title="CFPB Consumer Complaints",
        url="https://files.consumerfinance.gov/ccdb/complaints.csv.zip",
        file_type="zip_csv",
        target_table="us_cfpb_complaints",
        desc="Consumer financial complaints — 5M+ records",
    ),
    "osha": ImportSource(
        name="osha",
        title="OSHA Inspections",
        url="https://www.osha.gov/sites/default/files/osha_inspection.csv.zip",
        file_type="zip_csv",
        target_table="us_osha_inspections",
        desc="Workplace safety inspections — 5M records since 1973",
    ),
    "nhtsa": ImportSource(
        name="nhtsa",
        title="NHTSA Vehicle Recalls",
        url="https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL.zip",
        file_type="zip_csv",
        target_table="us_nhtsa_recalls",
        desc="Vehicle safety recalls — all campaigns",
    ),
    "fda": ImportSource(
        name="fda",
        title="FDA Enforcement Actions",
        url="https://api.fda.gov/drug/enforcement.json?limit=1000",
        file_type="json_api",
        target_table="us_fda_enforcement",
        desc="Drug and food recall/enforcement actions",
    ),
    "epa": ImportSource(
        name="epa",
        title="EPA ECHO Facilities",
        url="https://echo.epa.gov/files/echodownloads/frs_downloads.zip",
        file_type="zip_csv",
        target_table="us_epa_facilities",
        desc="EPA-regulated facilities — 1.5M+ with compliance data",
    ),
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DOWNLOAD UTILITIES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def download_file(session: aiohttp.ClientSession, url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info(f"  Downloading {url} -> {dest.name}")
    async with session.get(url) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        async with aiofiles.open(dest, "wb") as f:
            async for chunk in resp.content.iter_chunked(1024 * 256):
                await f.write(chunk)
                downloaded += len(chunk)
                if total > 0 and downloaded % (10 * 1024 * 1024) < 256 * 1024:
                    pct = downloaded * 100 // total
                    log.info(f"    {dest.name}: {downloaded // (1024*1024)} MB / {total // (1024*1024)} MB ({pct}%)")
    log.info(f"  Downloaded {dest.name}: {dest.stat().st_size // (1024*1024)} MB")
    return dest


async def download_json_paginated(session: aiohttp.ClientSession, base_url: str, source_name: str) -> list:
    all_results = []
    url = base_url
    page = 0
    while url:
        page += 1
        log.info(f"  [{source_name}] Fetching page {page}...")
        async with session.get(url) as resp:
            if resp.status != 200:
                log.error(f"  [{source_name}] HTTP {resp.status}")
                break
            data = await resp.json()

        if isinstance(data, list):
            all_results.extend(data)
            break
        elif "results" in data:
            all_results.extend(data["results"])
            url = data.get("meta", {}).get("next") or data.get("next")
        elif "REGISTRANT" in data:
            all_results.extend(data["REGISTRANT"] if isinstance(data["REGISTRANT"], list) else [data["REGISTRANT"]])
            break
        else:
            all_results.append(data)
            break

        await asyncio.sleep(0.5)
    log.info(f"  [{source_name}] Total records from API: {len(all_results)}")
    return all_results


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# IMPORTERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def parse_date(val: Optional[str]) -> Optional[str]:
    if not val or val.strip() in ("", "N/A", "null"):
        return None
    val = val.strip()[:10]
    if len(val) == 10 and val[4] == "-":
        return val
    if len(val) == 8 and val.isdigit():
        return f"{val[:4]}-{val[4:6]}-{val[6:8]}"
    if "/" in val:
        parts = val.split("/")
        if len(parts) == 3:
            m, d, y = parts
            if len(y) == 2:
                y = "20" + y if int(y) < 50 else "19" + y
            return f"{y}-{m.zfill(2)}-{d.zfill(2)}"
    return None


def import_cfpb(data_dir: Path):
    """Import CFPB complaints CSV."""
    csv_dir = data_dir / "cfpb"
    csv_file = None
    zip_path = csv_dir / "complaints.csv.zip"
    if zip_path.exists():
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                if name.endswith(".csv"):
                    zf.extract(name, csv_dir)
                    csv_file = csv_dir / name
                    break
    if not csv_file:
        csv_files = list(csv_dir.glob("*.csv"))
        csv_file = csv_files[0] if csv_files else None
    if not csv_file:
        log.error("[cfpb] No CSV file found")
        return 0

    log.info(f"[cfpb] Importing {csv_file.name}...")
    conn = get_db()
    cur = conn.cursor()
    total = 0
    batch = []

    with open(csv_file, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            complaint_id = row.get("Complaint ID") or row.get("complaint_id")
            if not complaint_id:
                continue
            batch.append((
                int(complaint_id),
                parse_date(row.get("Date received", "")),
                row.get("Product", ""),
                row.get("Sub-product", ""),
                row.get("Issue", ""),
                row.get("Sub-issue", ""),
                row.get("Consumer complaint narrative", ""),
                row.get("Company public response", ""),
                row.get("Company", ""),
                row.get("State", ""),
                row.get("ZIP code", ""),
                row.get("Tags", ""),
                row.get("Consumer consent provided?", ""),
                row.get("Submitted via", ""),
                parse_date(row.get("Date sent to company", "")),
                row.get("Company response to consumer", ""),
                row.get("Timely response?", ""),
                row.get("Consumer disputed?", ""),
            ))
            if len(batch) >= BATCH_SIZE:
                execute_values(cur, """
                    INSERT INTO us_cfpb_complaints (complaint_id, date_received, product, sub_product,
                        issue, sub_issue, consumer_complaint_narrative, company_public_response,
                        company, state, zip_code, tags, consumer_consent_provided, submitted_via,
                        date_sent_to_company, company_response, timely_response, consumer_disputed)
                    VALUES %s ON CONFLICT (complaint_id) DO NOTHING
                """, batch)
                conn.commit()
                total += len(batch)
                batch = []
                if total % 100000 == 0:
                    log.info(f"  [cfpb] {total:,} records...")

    if batch:
        execute_values(cur, """
            INSERT INTO us_cfpb_complaints (complaint_id, date_received, product, sub_product,
                issue, sub_issue, consumer_complaint_narrative, company_public_response,
                company, state, zip_code, tags, consumer_consent_provided, submitted_via,
                date_sent_to_company, company_response, timely_response, consumer_disputed)
            VALUES %s ON CONFLICT (complaint_id) DO NOTHING
        """, batch)
        conn.commit()
        total += len(batch)

    cur.close()
    conn.close()
    log.info(f"[cfpb] Imported {total:,} complaints")
    return total


def import_osha(data_dir: Path):
    """Import OSHA inspections CSV."""
    csv_dir = data_dir / "osha"
    zip_path = csv_dir / "osha_inspection.csv.zip"
    csv_file = None
    if zip_path.exists():
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                if "inspection" in name.lower() and name.endswith(".csv"):
                    zf.extract(name, csv_dir)
                    csv_file = csv_dir / name
                    break
    if not csv_file:
        csv_files = list(csv_dir.glob("*inspection*.csv"))
        csv_file = csv_files[0] if csv_files else None
    if not csv_file:
        log.error("[osha] No inspection CSV found")
        return 0

    log.info(f"[osha] Importing {csv_file.name}...")
    conn = get_db()
    cur = conn.cursor()
    total = 0
    batch = []

    with open(csv_file, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            activity_nr = row.get("activity_nr")
            if not activity_nr:
                continue
            try:
                nr_in_estab = int(row.get("nr_in_estab", 0) or 0)
            except (ValueError, TypeError):
                nr_in_estab = None
            batch.append((
                int(activity_nr),
                row.get("reporting_id"),
                row.get("state_flag"),
                row.get("estab_name"),
                row.get("site_address"),
                row.get("site_city"),
                row.get("site_state"),
                row.get("site_zip"),
                row.get("owner_type"),
                row.get("owner_code"),
                row.get("adv_notice"),
                row.get("safety_hlth"),
                row.get("sic_code"),
                row.get("naics_code"),
                row.get("insp_type"),
                row.get("insp_scope"),
                row.get("why_no_insp"),
                row.get("union_status"),
                row.get("safety_manuf"),
                row.get("safety_const"),
                row.get("safety_marit"),
                row.get("health_manuf"),
                row.get("health_const"),
                row.get("health_marit"),
                row.get("migrant"),
                row.get("mail_street"),
                row.get("mail_city"),
                row.get("mail_state"),
                row.get("mail_zip"),
                row.get("host_est_key"),
                nr_in_estab,
                parse_date(row.get("open_date")),
                parse_date(row.get("case_mod_date")),
                parse_date(row.get("close_conf_date")),
                parse_date(row.get("close_case_date")),
                int(row.get("open_date", "0000")[:4]) if row.get("open_date") else None,
            ))
            if len(batch) >= BATCH_SIZE:
                execute_values(cur, """
                    INSERT INTO us_osha_inspections (activity_nr, reporting_id, state_flag, estab_name,
                        site_address, site_city, site_state, site_zip, owner_type, owner_code,
                        adv_notice, safety_hlth, sic_code, naics_code, insp_type, insp_scope,
                        why_no_insp, union_status, safety_manuf, safety_const, safety_marit,
                        health_manuf, health_const, health_marit, migrant, mail_street, mail_city,
                        mail_state, mail_zip, host_est_key, nr_in_estab, open_date, case_mod_date,
                        close_conf_date, close_case_date, open_year)
                    VALUES %s ON CONFLICT (activity_nr) DO NOTHING
                """, batch)
                conn.commit()
                total += len(batch)
                batch = []
                if total % 100000 == 0:
                    log.info(f"  [osha] {total:,} records...")

    if batch:
        execute_values(cur, """
            INSERT INTO us_osha_inspections (activity_nr, reporting_id, state_flag, estab_name,
                site_address, site_city, site_state, site_zip, owner_type, owner_code,
                adv_notice, safety_hlth, sic_code, naics_code, insp_type, insp_scope,
                why_no_insp, union_status, safety_manuf, safety_const, safety_marit,
                health_manuf, health_const, health_marit, migrant, mail_street, mail_city,
                mail_state, mail_zip, host_est_key, nr_in_estab, open_date, case_mod_date,
                close_conf_date, close_case_date, open_year)
            VALUES %s ON CONFLICT (activity_nr) DO NOTHING
        """, batch)
        conn.commit()
        total += len(batch)

    cur.close()
    conn.close()
    log.info(f"[osha] Imported {total:,} inspections")
    return total


def import_fec_committees(data_dir: Path):
    """Import FEC committee master file (pipe-delimited, no header)."""
    csv_dir = data_dir / "fec_committees"
    zip_path = csv_dir / "cm24.zip"
    csv_file = None
    if zip_path.exists():
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                if name.endswith(".txt"):
                    zf.extract(name, csv_dir)
                    csv_file = csv_dir / name
                    break
    if not csv_file:
        txt_files = list(csv_dir.glob("*.txt"))
        csv_file = txt_files[0] if txt_files else None
    if not csv_file:
        log.error("[fec_committees] No data file found")
        return 0

    log.info(f"[fec_committees] Importing {csv_file.name}...")
    conn = get_db()
    cur = conn.cursor()
    total = 0
    batch = []

    with open(csv_file, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            fields = line.rstrip("\n").split("|")
            if len(fields) < 15:
                continue
            batch.append((
                fields[0],   # committee_id
                fields[1],   # committee_name
                fields[2],   # treasurer_name
                fields[3],   # street_1
                fields[4],   # street_2
                fields[5],   # city
                fields[6],   # state
                fields[7],   # zip
                fields[8],   # committee_designation
                fields[9],   # committee_type
                fields[10],  # party
                fields[11],  # filing_frequency
                fields[12],  # interest_group_category
                fields[13],  # connected_org_name
                fields[14],  # candidate_id
            ))
            if len(batch) >= BATCH_SIZE:
                execute_values(cur, """
                    INSERT INTO us_fec_committees (committee_id, committee_name, treasurer_name,
                        street_1, street_2, city, state, zip, committee_designation, committee_type,
                        party, filing_frequency, interest_group_category, connected_org_name, candidate_id)
                    VALUES %s ON CONFLICT (committee_id) DO UPDATE SET
                        committee_name=EXCLUDED.committee_name, treasurer_name=EXCLUDED.treasurer_name, imported_at=NOW()
                """, batch)
                conn.commit()
                total += len(batch)
                batch = []

    if batch:
        execute_values(cur, """
            INSERT INTO us_fec_committees (committee_id, committee_name, treasurer_name,
                street_1, street_2, city, state, zip, committee_designation, committee_type,
                party, filing_frequency, interest_group_category, connected_org_name, candidate_id)
            VALUES %s ON CONFLICT (committee_id) DO UPDATE SET
                committee_name=EXCLUDED.committee_name, treasurer_name=EXCLUDED.treasurer_name, imported_at=NOW()
        """, batch)
        conn.commit()
        total += len(batch)

    cur.close()
    conn.close()
    log.info(f"[fec_committees] Imported {total:,} committees")
    return total


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN ORCHESTRATOR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IMPORTER_MAP = {
    "cfpb": import_cfpb,
    "osha": import_osha,
    "fec_committees": import_fec_committees,
}


async def download_source(session: aiohttp.ClientSession, source: ImportSource):
    """Download a single source's data files."""
    dest_dir = DATA_DIR / source.name
    dest_dir.mkdir(parents=True, exist_ok=True)

    if source.file_type == "json_api":
        data = await download_json_paginated(session, source.url, source.name)
        json_path = dest_dir / f"{source.name}.json"
        async with aiofiles.open(json_path, "w") as f:
            await f.write(json.dumps(data, ensure_ascii=False))
        return json_path
    else:
        filename = source.url.split("/")[-1].split("?")[0]
        if not filename or len(filename) > 100:
            filename = f"{source.name}_data.zip"
        dest_file = dest_dir / filename
        return await download_file(session, source.url, dest_file)


async def run_downloads(sources_to_run: list[ImportSource]):
    """Download all sources in parallel."""
    timeout = aiohttp.ClientTimeout(total=3600, connect=30)
    headers = {"User-Agent": USER_AGENT}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        tasks = [download_source(session, src) for src in sources_to_run]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for src, result in zip(sources_to_run, results):
            if isinstance(result, Exception):
                log.error(f"[{src.name}] Download FAILED: {result}")
            else:
                log.info(f"[{src.name}] Download OK: {result}")
        return results


def run_imports(sources_to_run: list[ImportSource]):
    """Run import for each downloaded source."""
    results = {}
    for src in sources_to_run:
        importer = IMPORTER_MAP.get(src.name)
        if importer:
            try:
                count = importer(DATA_DIR)
                results[src.name] = count
                log.info(f"[{src.name}] Import complete: {count:,} records")
            except Exception as e:
                log.error(f"[{src.name}] Import FAILED: {e}", exc_info=True)
                results[src.name] = -1
        else:
            log.warning(f"[{src.name}] No importer implemented yet — skipping DB import (file downloaded)")
            results[src.name] = 0
    return results


def create_tables():
    """Create all US opendata tables."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(CREATE_TABLES_SQL)
    conn.commit()
    cur.close()
    conn.close()
    log.info("All US opendata tables created successfully")


def main():
    parser = argparse.ArgumentParser(description="US Open Data Import Pipeline")
    parser.add_argument("--source", action="append", help="Source(s) to import (repeat for multiple)")
    parser.add_argument("--list", action="store_true", help="List available sources")
    parser.add_argument("--dry-run", action="store_true", help="Download only, no DB import")
    parser.add_argument("--create-tables", action="store_true", help="Create tables only")
    parser.add_argument("--import-only", action="store_true", help="Skip download, import existing files")
    args = parser.parse_args()

    if args.list:
        print(f"\n{'Name':<18} {'Title':<35} {'Description'}")
        print("-" * 90)
        for name, src in SOURCES.items():
            print(f"{name:<18} {src.title:<35} {src.desc}")
        print(f"\nTotal: {len(SOURCES)} sources")
        return

    if args.create_tables:
        create_tables()
        return

    sources_to_run = []
    if args.source:
        for s in args.source:
            if s not in SOURCES:
                log.error(f"Unknown source: {s}. Use --list to see available.")
                sys.exit(1)
            sources_to_run.append(SOURCES[s])
    else:
        sources_to_run = list(SOURCES.values())

    log.info(f"=== US Open Data Import: {len(sources_to_run)} sources ===")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Create tables
    create_tables()

    # Step 2: Download all in parallel
    if not args.import_only:
        log.info(f"--- Downloading {len(sources_to_run)} sources in parallel ---")
        t0 = time.time()
        asyncio.run(run_downloads(sources_to_run))
        log.info(f"--- Downloads complete in {time.time() - t0:.1f}s ---")

    # Step 3: Import into DB
    if not args.dry_run:
        log.info(f"--- Importing into PostgreSQL ---")
        t0 = time.time()
        results = run_imports(sources_to_run)
        log.info(f"--- Import complete in {time.time() - t0:.1f}s ---")
        log.info("=== RESULTS ===")
        for name, count in results.items():
            status = f"{count:,} records" if count >= 0 else "FAILED"
            log.info(f"  {name:<18} {status}")
    else:
        log.info("--- Dry run: skipping DB import ---")


if __name__ == "__main__":
    main()
