#!/usr/bin/env python3
"""
Import spending.gov.ua JSON files (acts, addendums, peny) into PostgreSQL.

Usage:
    python3 import_spending.py                          # all types
    python3 import_spending.py --type acts              # only acts
    python3 import_spending.py --type addendums
    python3 import_spending.py --type peny
"""

import argparse
import json
import os
import sys
import time
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

DATA_DIR = os.environ.get("DATA_DIR", "/home/ubuntu/SecondLayer/scripts/opendata/spending/data")
DB_URL = os.environ.get("DATABASE_URL")  # required; never commit a credential here

TABLE_MAP = {
    "acts": "spending_acts",
    "addendums": "spending_addendums",
    "peny": "spending_peny",
}


def import_type(doc_type, conn, data_dir=DATA_DIR):
    table = TABLE_MAP[doc_type]
    data_path = os.path.join(data_dir, doc_type)

    if not os.path.exists(data_path):
        log.error(f"Directory not found: {data_path}")
        return

    files = sorted([f for f in os.listdir(data_path) if f.endswith(".json")])
    log.info(f"[{doc_type}] Found {len(files)} JSON files -> {table}")

    cur = conn.cursor()

    # Check current count
    cur.execute(f"SELECT count(*) FROM {table}")
    current = cur.fetchone()[0]
    log.info(f"[{doc_type}] Current count: {current}")

    imported = 0
    skipped = 0
    errors = 0
    total_docs = 0
    start_time = time.time()

    for i, filename in enumerate(files):
        filepath = os.path.join(data_path, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            docs = data.get("documents", [])
            if not docs:
                skipped += 1
                continue

            for doc in docs:
                try:
                    doc_id = doc.get("id")
                    if not doc_id:
                        continue

                    cur.execute(f"""
                        INSERT INTO {table} (id, edrpou, document_number, document_date, sign_date,
                            amount, currency, pdv_include, pdv_amount, parent_id,
                            contractors, specifications, procurement_items, signature)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO NOTHING
                    """, (
                        doc_id,
                        str(doc.get("edrpou", ""))[:10],
                        str(doc.get("documentNumber", ""))[:255] if doc.get("documentNumber") else None,
                        doc.get("documentDate"),
                        doc.get("signDate"),
                        doc.get("amount"),
                        str(doc.get("currency", "UAH"))[:10],
                        doc.get("pdvInclude", False),
                        doc.get("pdvAmount"),
                        doc.get("parentId"),
                        json.dumps(doc.get("contractors", []), ensure_ascii=False) if doc.get("contractors") else None,
                        json.dumps(doc.get("specifications", []), ensure_ascii=False) if doc.get("specifications") else None,
                        json.dumps(doc.get("procurementItems", []), ensure_ascii=False) if doc.get("procurementItems") else None,
                        json.dumps(doc.get("signature", {}), ensure_ascii=False) if doc.get("signature") else None,
                    ))
                    total_docs += 1
                except Exception as e:
                    errors += 1
                    if errors <= 10:
                        log.error(f"  Doc error {doc.get('id')}: {e}")

            conn.commit()
            imported += 1

        except Exception as e:
            conn.rollback()
            errors += 1
            if errors <= 10:
                log.error(f"  File error {filename}: {e}")

        if (i + 1) % 500 == 0 or i + 1 == len(files):
            elapsed = time.time() - start_time
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            log.info(
                f"[{doc_type}] {i+1}/{len(files)} files ({(i+1)*100//len(files)}%) "
                f"| {total_docs} docs | {errors} errors | {rate:.1f} files/s"
            )

    # Final count
    cur.execute(f"SELECT count(*) FROM {table}")
    final = cur.fetchone()[0]
    elapsed = time.time() - start_time

    log.info(
        f"[{doc_type}] Done in {elapsed/60:.1f}m: {imported} files, {total_docs} docs, "
        f"{skipped} empty, {errors} errors. DB: {current} -> {final} ({final - current} new)"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--type", choices=list(TABLE_MAP.keys()) + ["all"], default="all")
    parser.add_argument("--db-url", default=DB_URL)
    parser.add_argument("--data-dir", default=DATA_DIR)
    args = parser.parse_args()

    data_dir = args.data_dir

    try:
        import psycopg2
    except ImportError:
        log.error("pip install psycopg2-binary")
        return

    conn = psycopg2.connect(args.db_url)
    conn.autocommit = False

    types = list(TABLE_MAP.keys()) if args.type == "all" else [args.type]

    for doc_type in types:
        import_type(doc_type, conn, data_dir)

    conn.close()
    log.info("All done!")


if __name__ == "__main__":
    main()
