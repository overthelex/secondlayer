#!/usr/bin/env python3
"""
Import ЄДЕССБ (Реєстр будівельної діяльності) open-data dumps into
opendata_edessb_documents (migration 259).

Source: data.gov.ua, CC BY 4.0, attribution «Портал ЄДЕССБ». Each dump is a
zip holding one JSON array with ONE RECORD PER LINE, so it is streamed line by
line (a year is ~560 MB of JSON; never json.load it whole).

Usage:
    python3 import_edessb.py --source y2026            # download + import one dump
    python3 import_edessb.py --source all              # every known dump
    python3 import_edessb.py --zip /path/file.zip --label public_data_2026.zip
    python3 import_edessb.py --list

DB connection: POSTGRES_HOST/PORT/USER/PASSWORD/DB (same as import-tier1-local.py).
Requires: psycopg2-binary.

Idempotent: upsert on application_id; re-running a dump refreshes its rows.
The yearly 2026 file is overwritten monthly at the same URL, so a monthly
re-run of --source y2026 keeps it current.
"""

import argparse
import io
import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.request
import zipfile

import psycopg2
from psycopg2.extras import Json, execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("edessb")

BATCH_SIZE = 2000

SOURCES = {
    # Order matters for --source all: the 2022-02-22 snapshot overlaps the 2021
    # file, which was exported later (2024), so the snapshot loads first and the
    # 2021 file overwrites the shared rows with their newer state.
    # Snapshot published 22.02.2022, covers 2021-12-31 .. 2022-02-22.
    "y2022q1": "https://data.gov.ua/dataset/d1e27dd5-a9b4-4b20-b5f7-a7b3163e9e0e/resource/ead61051-b018-40df-a86b-16892c63a8a6/download/export_data_gov_ua_data_2022-02-22.zip",
    "y2021": "https://data.gov.ua/dataset/24c0ce1c-8cc5-4f4c-9847-d713043a6a8a/resource/697f6c79-be1d-4adc-bb7b-173fa334c558/download/public_data_2021-01-01_2021-12-31.zip",
    # Current year, overwritten monthly at this URL.
    "y2026": "https://data.gov.ua/dataset/24c0ce1c-8cc5-4f4c-9847-d713043a6a8a/resource/f33311fa-dc3f-4398-a3f1-88e7d20c8e2b/download/public_data_2026-01-01_2026-11-01.zip",
}

# From api-description.xlsx shipped with the dataset.
SERVICE_TYPES = {
    "2271257284422141539": "Повідомлення про зміну даних у повідомленні про початок виконання підготовчих робіт",
    "2271257388172445290": "Заява про скасування повідомлення про початок виконання підготовчих робіт",
    "2271258322495604362": "Заява про скасування повідомлення про початок виконання будівельних робіт",
    "2271258931735037588": "Анулювання дозволу на виконання будівельних робіт",
    "2329811747344483476": "Лист про зміну даних",
    "2329812297897215135": "Лист про зміну даних",
    "2271258166945646215": "Внесення змін до повідомлення про початок виконання будівельних робіт",
    "2271258836817938065": "Зміна даних у дозволі на виконання будівельних робіт",
    "2271260252244543149": "Внесення змін до декларації про готовність до експлуатації об'єкта",
    "2379780786044798005": "Скасування сертифіката про прийняття в експлуатацію",
    "2379751183964178422": "Скасування декларації про готовність до експлуатації об'єкта",
    "2271257025960740446": "Повідомлення про початок виконання підготовчих робіт",
    "2271258078261282436": "Повідомлення про початок виконання будівельних робіт",
    "2251263360455683315": "Дозвіл на виконання будівельних робіт",
    "2271260030785291940": "Декларація про готовність до експлуатації об'єкта",
    "2271260529144104631": "Сертифікат про прийняття в експлуатацію закінченого будівництвом об'єкта",
    "2337721472488834347": "Декларація про готовність до експлуатації (за амністією)",
    "2279148412081276319": "Декларація про готовність до експлуатації (за рішенням суду)",
    "2349447558545278456": "Внесення змін до декларації про початок будівельних робіт",
    "26": "Декларація про початок підготовчих робіт",
    "25": "Декларація про початок будівельних робіт",
}

USE_STATUS = {
    1: "Діючий", 2: "Зупинений", 3: "Скасований", 4: "Не підтверджено наявність документу",
    5: "Проєктний", 6: "Повернуто без розгляду", 7: "Очікує розгляду",
    8: "Відмовлено у внесенні відомостей в систему", 9: "Відмовлено", 10: "Архівний",
    11: "Повернуто на доопрацювання", 12: "Підтверджено наявність документу",
}

# "Статус опрацювання" (proces_status): the only status field in the 2022-02-22
# snapshot, which predates use_status_universal / reg_status_universal.
PROCESS_STATUS = {
    1: "Чернетка", 2: "Зареєстровано", 3: "На перевірці", 4: "На підписанні", 5: "Відправлено",
    6: "Відмовлено в реєстрації", 7: "Повернуто на доопрацювання", 8: "Виправлення технічної помилки",
    10: "Скасовано", 11: "Зареєстровано (очікує підписання реєстратором)",
    12: "Відмовлено (очікує підписання реєстратором)",
    13: "Повернуто на доопрацювання (очікує підписання реєстратором)", 15: "Очікує розгляду",
    16: "Повернуто без розгляду",
}

BUILD_TYPE = {
    1: "Нове будівництво", 2: "Реконструкція", 3: "Реставрація", 4: "Капітальний ремонт",
    5: "Реконструкція без зміни зовнішніх геометричних розмірів",
    6: "Реставрація без зміни зовнішніх геометричних розмірів",
}

BUILD_WAY = {1: "З залученням підрядника", 2: "Господарський (власними силами)"}

LEGAL_STATUS = {1: "Фізична особа", 2: "ФОП", 3: "Юридична особа"}

EDRPOU_RE = re.compile(r"^\d{8}$")
POINT_RE = re.compile(r"POINT\(\s*([-\d.]+)\s+([-\d.]+)\s*\)")

COLUMNS = [
    "application_id", "reg_date", "service_id", "doc_type", "reg_status", "use_status",
    "status_label", "consequence_class", "code_dkbs", "build_type", "build_way", "object_name",
    "region", "gromada", "city", "address", "katottg_city", "lon", "lat", "land_number",
    "land_numbers", "customer_type", "customer_edrpou", "customer_name", "contractor_edrpou",
    "contractor_name", "contract_date", "designer_edrpou", "designer_name", "expertise_edrpou",
    "expertise_name", "issuer_edrpou", "issuer_name", "incoming_doc_number", "incoming_doc_date",
    "history_ids", "old_registry_id", "raw", "source_file",
]


def get_db():
    return psycopg2.connect(
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ.get("POSTGRES_USER", "secondlayer"),
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ.get("POSTGRES_DB", "secondlayer_local"),
    )


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def edrpou(v):
    s = str(v or "").strip()
    return s if EDRPOU_RE.match(s) else None


def date_or_none(v):
    s = str(v or "")[:10]
    return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None


def clean(s):
    if s is None:
        return None
    s = str(s).strip()
    return s or None


def first_org(items):
    """First (edrpou, name) among dicts with a valid ЄДРПОУ, else first name only."""
    items = [x for x in as_list(items) if isinstance(x, dict)]
    for x in items:
        e = edrpou(x.get("org_edrpo"))
        if e:
            return e, clean(x.get("org_name"))
    for x in items:
        if clean(x.get("org_name")):
            return None, clean(x.get("org_name"))
    return None, None


def transform(r, source_file):
    obj = r.get("uservices_object") or {}
    apps = [a for a in as_list(r.get("uservices_applicant")) if isinstance(a, dict)]
    legal = [a for a in apps if edrpou(a.get("ap_edrpou"))]
    cust = legal[0] if legal else (apps[0] if apps else {})
    cust_edrpou = edrpou(cust.get("ap_edrpou"))
    cust_name = clean(cust.get("ap_organiz_name")) if cust_edrpou else None
    cust_type = LEGAL_STATUS.get(cust.get("ap_legal_status")) if cust else None

    contractor_edrpou, contractor_name = first_org(r.get("uservices_contractor_doc"))
    cds = [x for x in as_list(r.get("uservices_contractor_doc")) if isinstance(x, dict)]
    contract_date = date_or_none(cds[0].get("cd_doc_date")) if cds else None
    designer_edrpou, designer_name = first_org(r.get("uservices_projdoc"))
    expertise_edrpou, expertise_name = first_org(r.get("uservices_expertise"))

    locs = [x for x in as_list(r.get("uservices_object_loc")) if isinstance(x, dict)]
    loc = locs[0] if locs else {}
    addr_parts = [loc.get("obj_addr_region"), loc.get("obj_addr_city"), loc.get("obj_street_name"),
                  loc.get("build_num") or loc.get("obj_house_number"), loc.get("obj_build_number")]
    address = ", ".join(str(p).strip() for p in addr_parts if p and str(p).strip()) or None

    # Current dumps: [{"land_number": ..., "land_purpose": ...}]; 2022 snapshot: ["3510100000:45:347:0094"].
    lands = [clean(x.get("land_number") if isinstance(x, dict) else x) for x in as_list(r.get("uservices_object_land"))]
    lands = [x for x in lands if x]

    lon = lat = None
    m = POINT_RE.search(str(obj.get("geometry") or ""))
    if m:
        lon, lat = float(m.group(1)), float(m.group(2))

    hist = [str(x) for x in as_list(r.get("application_history")) if x]
    use_status = r.get("use_status_universal")
    reg_status = r.get("reg_status_universal")
    status_label = USE_STATUS.get(use_status)
    if status_label is None and r.get("proces_status") is not None:
        reg_status = r.get("proces_status")
        status_label = PROCESS_STATUS.get(reg_status)
    cls = r.get("obj_edesb_class") or obj.get("obj_edesb_class")
    sid = str(r.get("service_id") or "") or None

    return (
        r["application_id"], date_or_none(r.get("reg_date")), sid, SERVICE_TYPES.get(sid or ""),
        reg_status, use_status, status_label,
        cls if cls in (1, 2, 3) else None, clean(r.get("code_dkbs") or obj.get("code_dkbs")),
        BUILD_TYPE.get(obj.get("object_type")), BUILD_WAY.get(obj.get("build_way")),
        clean(obj.get("object_name")),
        clean(loc.get("obj_addr_region")), clean(loc.get("ter_gromad_name")), clean(loc.get("obj_addr_city")),
        address, clean(loc.get("city_codifier")), lon, lat,
        lands[0] if lands else None, lands or None,
        cust_type, cust_edrpou, cust_name,
        contractor_edrpou, contractor_name, contract_date,
        designer_edrpou, designer_name, expertise_edrpou, expertise_name,
        edrpou(r.get("org_edrpo")), clean(r.get("org_name")),
        clean(r.get("incoming_doc_number")), date_or_none(r.get("incoming_doc_date")),
        hist or None, clean(r.get("application_id_parent_old")),
        Json(r), source_file,
    )


UPSERT_SQL = (
    f"INSERT INTO opendata_edessb_documents ({', '.join(COLUMNS)}) VALUES %s "
    "ON CONFLICT (application_id) DO UPDATE SET "
    + ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "application_id")
    + ", imported_at = NOW()"
)


def iter_records(zpath):
    z = zipfile.ZipFile(zpath)
    names = [n for n in z.namelist() if n.lower().endswith(".json")]
    if len(names) != 1:
        raise SystemExit(f"expected exactly one .json in {zpath}, got {names}")
    with z.open(names[0]) as fh:
        for raw in io.TextIOWrapper(fh, encoding="utf-8"):
            line = raw.strip()
            if line in ("[", "]", ""):
                continue
            line = line.lstrip("[").rstrip("]").rstrip(",").strip()
            if line:
                yield json.loads(line)


def import_zip(zpath, label):
    conn = get_db()
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SET statement_timeout = '10min'")
    batch, total, t0 = [], 0, time.time()
    stats = {"legal_customer": 0, "contractor_edrpou": 0, "no_id": 0}
    for r in iter_records(zpath):
        if not r.get("application_id"):
            stats["no_id"] += 1
            continue
        row = transform(r, label)
        stats["legal_customer"] += row[COLUMNS.index("customer_edrpou")] is not None
        stats["contractor_edrpou"] += row[COLUMNS.index("contractor_edrpou")] is not None
        batch.append(row)
        if len(batch) >= BATCH_SIZE:
            execute_values(cur, UPSERT_SQL, batch, page_size=BATCH_SIZE)
            conn.commit()
            total += len(batch)
            batch = []
            if total % 20000 == 0:
                log.info(f"[{label}] {total} rows, {total / (time.time() - t0):.0f} rows/s")
    if batch:
        execute_values(cur, UPSERT_SQL, batch, page_size=BATCH_SIZE)
        conn.commit()
        total += len(batch)
    cur.close()
    conn.close()
    log.info(f"[{label}] done: {total} rows in {time.time() - t0:.0f}s; {stats}")
    return total


def download(url, dest):
    log.info(f"downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "opendata-importer/1.0"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    log.info(f"saved {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", help=f"one of {', '.join(SOURCES)} or 'all'")
    ap.add_argument("--zip", help="import a local zip instead of downloading")
    ap.add_argument("--label", help="source_file label for --zip (default: zip basename)")
    ap.add_argument("--keep-dir", help="keep downloaded zips in this directory")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.list:
        for k, v in SOURCES.items():
            print(f"{k:8} {v}")
        return
    if a.zip:
        import_zip(a.zip, a.label or os.path.basename(a.zip))
        return
    if not a.source:
        ap.error("--source or --zip is required")
    keys = list(SOURCES) if a.source == "all" else [a.source]
    for k in keys:
        if k not in SOURCES:
            ap.error(f"unknown source {k}")
        url = SOURCES[k]
        workdir = a.keep_dir or tempfile.mkdtemp(prefix="edessb-")
        os.makedirs(workdir, exist_ok=True)
        dest = os.path.join(workdir, os.path.basename(url))
        download(url, dest)
        import_zip(dest, os.path.basename(url))
        if not a.keep_dir:
            os.remove(dest)


if __name__ == "__main__":
    sys.exit(main())
