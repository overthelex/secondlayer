#!/usr/bin/env python3
"""Import UK court decisions into PostgreSQL (parallel)."""

import json
import os
import sys
import time
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from xml.etree import ElementTree as ET

import psycopg2
from psycopg2.extras import execute_values

DB_URL = os.environ["DATABASE_URL"]  # never commit a credential here
MAX_WORKERS = 20
BATCH_SIZE = 500

UK_TNA_BASE = Path("/home/ubuntu/opendata/uk/national-archives")
UK_HF_BASE = Path("/home/ubuntu/opendata/uk/huggingface/uk_courts_cases")

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
NS = {"akn": AKN_NS}


def get_conn():
    return psycopg2.connect(DB_URL)


# ============================================================
# UK: National Archives Akoma Ntoso XML
# ============================================================

def _extract_text(elem):
    """Recursively extract all text content from an element."""
    parts = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        parts.append(_extract_text(child))
        if child.tail:
            parts.append(child.tail)
    return " ".join(parts)


def parse_tna_xml(filepath: str) -> tuple | None:
    """Parse a single Akoma Ntoso XML file into a row tuple."""
    try:
        tree = ET.parse(filepath)
    except ET.ParseError:
        return None

    root = tree.getroot()

    # FRBRWork identifiers
    frbr_work = root.find(f".//{{{AKN_NS}}}FRBRWork")
    frbr_uri = ""
    neutral_citation = None
    decision_date = None
    court_name = None

    if frbr_work is not None:
        uri_el = frbr_work.find(f"{{{AKN_NS}}}FRBRuri")
        if uri_el is not None:
            frbr_uri = uri_el.get("value", "")

        # Neutral citation from FRBRalias with name="cite"
        for alias in frbr_work.findall(f"{{{AKN_NS}}}FRBRalias"):
            if alias.get("name") == "cite":
                neutral_citation = alias.get("value")
                break

        # Decision date from FRBRdate with name="judgment"
        for date_el in frbr_work.findall(f"{{{AKN_NS}}}FRBRdate"):
            if date_el.get("name") == "judgment":
                decision_date = date_el.get("date")
                break

        # Court name from FRBRauthor
        author_el = frbr_work.find(f"{{{AKN_NS}}}FRBRauthor")
        if author_el is not None:
            court_name = author_el.get("href", "").lstrip("#")

    # Fallback court name from header or docTitle
    if not court_name:
        header = root.find(f".//{{{AKN_NS}}}header")
        if header is not None:
            p_el = header.find(f"{{{AKN_NS}}}p")
            if p_el is not None and p_el.text:
                court_name = p_el.text.strip()
        if not court_name:
            doc_title = root.find(f".//{{{AKN_NS}}}docTitle")
            if doc_title is not None and doc_title.text:
                court_name = doc_title.text.strip()

    # Record id from URI
    record_id = f"tna-{frbr_uri.lstrip('/')}" if frbr_uri else f"tna-{Path(filepath).stem}"

    # Court code from parent directory name
    court_code = Path(filepath).parent.name.replace("_", "/")

    # Judge(s) from judge elements
    judges = []
    for judge_el in root.findall(f".//{{{AKN_NS}}}judge"):
        judge_text = (judge_el.text or "").strip()
        if judge_text:
            judges.append(judge_text)
    judge = judges[0] if judges else None

    # Parties from party elements
    parties = []
    for party_el in root.findall(f".//{{{AKN_NS}}}party"):
        party_text = (party_el.text or "").strip()
        if party_text:
            parties.append(party_text)

    # Full text from body
    body = root.find(f".//{{{AKN_NS}}}body")
    if body is None:
        body = root.find(f".//{{{AKN_NS}}}judgmentBody")
    full_text = _extract_text(body).strip() if body is not None else None

    # Source URL
    source_url = f"https://caselaw.nationalarchives.gov.uk{frbr_uri}" if frbr_uri else None

    return (
        record_id,                                              # id
        None,                                                   # ecli
        "tna",                                                  # source
        court_name,                                             # court_name
        court_code,                                             # court_code
        None,                                                   # case_number
        neutral_citation,                                       # neutral_citation
        None,                                                   # decision_type
        decision_date,                                          # decision_date
        judge,                                                  # judge
        json.dumps(judges) if judges else None,                 # judges
        None,                                                   # subject
        None,                                                   # keywords
        json.dumps(parties) if parties else None,               # parties
        None,                                                   # abstract
        full_text,                                              # full_text
        source_url,                                             # source_url
        None,                                                   # metadata_json
    )


def import_tna_batch(filepaths: list[str]) -> int:
    """Parse and insert a batch of TNA XML files."""
    rows = []
    for fp in filepaths:
        row = parse_tna_xml(fp)
        if row is not None:
            rows.append(row)

    if not rows:
        return 0

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            execute_values(cur, """
                INSERT INTO uk_court_decisions
                    (id, ecli, source, court_name, court_code,
                     case_number, neutral_citation, decision_type, decision_date,
                     judge, judges, subject, keywords, parties,
                     abstract, full_text, source_url, metadata_json)
                VALUES %s
                ON CONFLICT (id) DO NOTHING
            """, rows, page_size=BATCH_SIZE)
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def import_uk_tna():
    """Import National Archives Akoma Ntoso XML files."""
    if not UK_TNA_BASE.exists():
        print(f"TNA directory not found: {UK_TNA_BASE}")
        return 0

    files = sorted(UK_TNA_BASE.rglob("*.xml"))
    print(f"\nUK TNA: {len(files)} XML files to import")
    if not files:
        return 0

    # Chunk files into batches for workers
    batches = [
        [str(f) for f in files[i : i + BATCH_SIZE]]
        for i in range(0, len(files), BATCH_SIZE)
    ]

    imported = 0
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(import_tna_batch, batch): idx for idx, batch in enumerate(batches)}
        done = 0
        for future in as_completed(futures):
            batch_idx = futures[future]
            try:
                count = future.result()
                imported += count
                done += 1
                if done % 10 == 0 or done == len(batches):
                    elapsed = time.time() - t0
                    rate = imported / elapsed if elapsed > 0 else 0
                    print(f"  TNA: {done}/{len(batches)} batches | {imported} rows | {rate:.0f}/s")
            except Exception as e:
                print(f"  TNA FAILED batch {batch_idx}: {e}")

    print(f"  TNA complete: {imported} rows in {time.time()-t0:.0f}s")
    return imported


# ============================================================
# UK: HuggingFace Parquet
# ============================================================

def import_uk_hf_file(filepath: str) -> int:
    """Import a single HuggingFace parquet file."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        print("pyarrow not installed, skipping HF parquet import")
        return 0

    table = pq.read_table(filepath)
    df_cols = table.column_names
    batch_rows = []
    total = 0

    for i in range(table.num_rows):
        row = {col: table.column(col)[i].as_py() for col in df_cols}

        record_id = f"hf-uk-courts-{i}-{Path(filepath).stem}"
        full_text = row.get("text") or row.get("content") or row.get("full_text", "")
        case_number = row.get("case_number") or row.get("caseNumber") or row.get("signature")
        court_name = row.get("court_name") or row.get("courtName") or row.get("court")
        court_code = row.get("court_code") or row.get("courtCode")
        neutral_citation = row.get("neutral_citation") or row.get("citation")
        decision_date = row.get("date") or row.get("decision_date") or row.get("judgment_date")
        decision_type = row.get("type") or row.get("decision_type") or row.get("judgment_type")
        judge_name = row.get("judge") or row.get("chairman")
        ecli = row.get("ecli")
        subject = row.get("subject")
        keywords = row.get("keywords")
        parties = row.get("parties")
        abstract = row.get("abstract") or row.get("summary")
        source_url = row.get("source_url") or row.get("url")

        meta = {
            k: v for k, v in row.items()
            if k not in (
                "text", "content", "full_text", "case_number", "caseNumber", "signature",
                "court_name", "courtName", "court", "court_code", "courtCode",
                "neutral_citation", "citation", "date", "decision_date", "judgment_date",
                "type", "decision_type", "judgment_type", "judge", "chairman",
                "ecli", "subject", "keywords", "parties", "abstract", "summary",
                "source_url", "url",
            )
        }

        batch_rows.append((
            record_id,
            ecli,
            "hf-uk-courts",
            court_name,
            court_code,
            case_number,
            neutral_citation,
            decision_type,
            str(decision_date)[:10] if decision_date else None,
            judge_name,
            None,                                                   # judges
            subject,
            json.dumps(keywords) if keywords and not isinstance(keywords, str) else keywords,
            json.dumps(parties) if parties and not isinstance(parties, str) else parties,
            abstract,
            full_text,
            source_url,
            json.dumps(meta, default=str) if meta else None,
        ))

        if len(batch_rows) >= BATCH_SIZE:
            _flush_uk_batch(batch_rows)
            total += len(batch_rows)
            batch_rows = []

    if batch_rows:
        _flush_uk_batch(batch_rows)
        total += len(batch_rows)

    return total


def _flush_uk_batch(rows):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            execute_values(cur, """
                INSERT INTO uk_court_decisions
                    (id, ecli, source, court_name, court_code,
                     case_number, neutral_citation, decision_type, decision_date,
                     judge, judges, subject, keywords, parties,
                     abstract, full_text, source_url, metadata_json)
                VALUES %s
                ON CONFLICT (id) DO NOTHING
            """, rows, page_size=BATCH_SIZE)
        conn.commit()
    finally:
        conn.close()


def import_uk_hf():
    """Import HuggingFace Parquet files for UK courts."""
    if not UK_HF_BASE.exists():
        print(f"HF directory not found: {UK_HF_BASE}")
        return 0

    files = sorted(UK_HF_BASE.glob("**/*.parquet"))
    if not files:
        print(f"  No parquet files in {UK_HF_BASE}")
        return 0

    print(f"\nUK HF: {len(files)} parquet files")

    imported = 0
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(import_uk_hf_file, str(f)): f.name for f in files}
        done = 0
        for future in as_completed(futures):
            fname = futures[future]
            try:
                count = future.result()
                imported += count
                done += 1
                elapsed = time.time() - t0
                rate = imported / elapsed if elapsed > 0 else 0
                print(f"  HF: {done}/{len(files)} files | {imported} rows | {rate:.0f}/s")
            except Exception as e:
                print(f"  HF FAILED {fname}: {e}")

    print(f"  HF complete: {imported} rows in {time.time()-t0:.0f}s")
    return imported


# ============================================================
# Main
# ============================================================

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    if mode in ("all", "tna"):
        import_uk_tna()
    if mode in ("all", "hf"):
        import_uk_hf()

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM uk_court_decisions")
            uk_count = cur.fetchone()[0]
        print(f"\n{'='*60}")
        print(f"Total UK court decisions: {uk_count:,}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
