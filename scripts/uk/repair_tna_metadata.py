#!/usr/bin/env python3
"""Repair uk_court_decisions in place from the TNA Akoma Ntoso XML already on disk.

The May 2026 import (scripts/opendata/import_uk_to_db.py) inserted 53,469 rows with
three defects, all of them parser bugs rather than source gaps:

  * every source_url is the base domain concatenated onto an already-absolute
    FRBRuri (import_uk_to_db.py:127);
  * neutral_citation / case_number / court_name / metadata_json were never read out
    of the XML at all, so they are 100% NULL;
  * 6,168 rows have no decision_date although <docDate> carries one in 91% of files.

The importer uses ON CONFLICT (id) DO NOTHING, so re-running it fixes nothing. This
script UPDATEs instead. It never touches full_text.

Measured field coverage over a 400-file random sample (2026-08-22):
  uk:court 100% · FRBRname 100% · uk:cite 99.0% · neutralCitation 95.5% ·
  docDate 91.0% · party 84.2% · judge 71.2% · docketNumber 65.8% ·
  docNumber 0% · uk:summaryOfCase 0%

Read-only against TNA: no network access to caselaw.nationalarchives.gov.uk.

Usage:
  python3 repair_tna_metadata.py --dry-run          # parse + report, no writes
  python3 repair_tna_metadata.py                    # apply
  python3 repair_tna_metadata.py --limit 500        # smoke test
"""

import argparse
import json
import os
import re
import sys
from datetime import date

import psycopg2
from psycopg2.extras import execute_values

AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
UK = "https://caselaw.nationalarchives.gov.uk/akn"
A = f"{{{AKN}}}"
U = f"{{{UK}}}"

XML_ROOT = os.environ.get("UK_XML_ROOT", "/home/ubuntu/opendata/uk/national-archives")
DB_URL = os.environ.get("DATABASE_URL")

DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
WS_RE = re.compile(r"\s+")


def norm(s):
    """Collapse whitespace, strip NUL, return None for empties."""
    if not s:
        return None
    s = s.replace("\x00", "")
    s = WS_RE.sub(" ", s).strip()
    return s or None


def el_text(el):
    """Full text of an element including nested markup.

    The original importer used elem.text, which yields an empty string whenever the
    name sits inside a nested <span>. That is why judge/parties came out blank.
    """
    if el is None:
        return None
    return norm("".join(el.itertext()))


def extract_full_text(root):
    """Same space-joined recursion the original importer used (import_uk_to_db.py:37-46),
    so rows added now read identically to the 53,469 already in the table."""
    body = root.find(f".//{A}body")
    if body is None:
        body = root.find(f".//{A}judgmentBody")
    if body is None:
        return None

    def walk(elem):
        parts = []
        if elem.text:
            parts.append(elem.text)
        for child in elem:
            parts.append(walk(child))
            if child.tail:
                parts.append(child.tail)
        return " ".join(parts)

    txt = walk(body).replace("\x00", "").strip()
    return txt or None


def parse_date(raw):
    """Accept only a real YYYY-MM-DD. A bare year or 'unknown' aborted whole batches
    of 500 in the original importer, silently losing every row in the batch."""
    if not raw:
        return None
    m = DATE_RE.match(raw.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        date(y, mo, d)
    except ValueError:
        return None
    if not (1900 <= y <= 2100):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def court_code_from_uri(uri):
    """https://caselaw.nationalarchives.gov.uk/id/ewhc/admin/2011/1108 -> ewhc/admin"""
    if not uri:
        return None
    path = uri.split("nationalarchives.gov.uk", 1)[-1]
    parts = [p for p in path.split("/") if p]
    if parts and parts[0] == "id":
        parts = parts[1:]
    # trailing /<year>/<number>
    while parts and re.fullmatch(r"\d+", parts[-1]):
        parts.pop()
    return "/".join(parts) or None


def parse_file(path, want_text=False):
    """Return a dict of repaired fields, or None if the file cannot be used.

    Unlike the original importer, every rejection carries a reason so the file/row
    delta can be explained instead of guessed at.
    """
    import xml.etree.ElementTree as ET

    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        return {"_error": f"parse_error: {e}"}
    except OSError as e:
        return {"_error": f"read_error: {e}"}

    ident = root.find(f".//{A}identification")
    if ident is None:
        return {"_error": "no_identification"}

    work = ident.find(f"{A}FRBRWork")
    expr = ident.find(f"{A}FRBRExpression")
    if work is None:
        return {"_error": "no_frbrwork"}

    uri_el = work.find(f"{A}FRBRuri")
    work_uri = uri_el.get("value", "").strip() if uri_el is not None else ""
    if not work_uri:
        return {"_error": "no_frbruri"}

    # Matches import_uk_to_db.py:100 exactly, so the join back to the DB is lossless.
    row_id = f"tna-{work_uri.lstrip('/')}"

    # FRBRExpression/FRBRuri is the human-facing page (no /id/); FRBRWork/FRBRuri is
    # the /id/ identifier form that TNA 303-redirects. Prefer the former for a link.
    source_url = None
    if expr is not None:
        e_uri = expr.find(f"{A}FRBRuri")
        if e_uri is not None:
            source_url = norm(e_uri.get("value"))
    if not source_url:
        source_url = work_uri.replace("/id/", "/", 1)

    # --- proprietary block: the citation, court token and TNA hashes -------------
    prop = root.find(f".//{A}proprietary")
    meta = {}
    neutral_citation = None
    if prop is not None:
        for child in prop:
            tag = child.tag.split("}")[-1]
            val = norm(child.text)
            if val:
                meta[tag] = val
        neutral_citation = meta.get("cite")

    # <neutralCitation> in the header is the fallback (95.5% vs 99.0% for uk:cite)
    if not neutral_citation:
        nc = root.find(f".//{A}neutralCitation")
        neutral_citation = el_text(nc)

    # FRBRname is the CASE NAME, not the citation. Keep it as the party fallback.
    name_el = work.find(f"{A}FRBRname")
    case_name = norm(name_el.get("value")) if name_el is not None else None
    if case_name:
        meta["case_name"] = case_name

    # --- case number --------------------------------------------------------
    # docNumber does not occur in this corpus at all; docketNumber does (65.8%).
    case_number = el_text(root.find(f".//{A}docketNumber"))

    # --- dates ---------------------------------------------------------------
    decision_date = None
    for d_el in work.findall(f"{A}FRBRdate"):
        if d_el.get("name") == "judgment":
            decision_date = parse_date(d_el.get("date"))
            break
    if not decision_date:
        doc_date = root.find(f".//{A}docDate")
        if doc_date is not None:
            decision_date = parse_date(doc_date.get("date"))

    # --- court ----------------------------------------------------------------
    author = work.find(f"{A}FRBRauthor")
    author_id = (author.get("href", "") or "").lstrip("#") if author is not None else ""
    court_name = None
    if author_id:
        for org in root.findall(f".//{A}TLCOrganization"):
            if org.get("eId") == author_id:
                court_name = norm(org.get("showAs")) or norm(org.get("shortForm"))
                break
    # NB: do NOT take court_code from uk:court. That element uses a different
    # taxonomy (EWCA-Civil, EWHC-QBD-Admin, UKFTT-GRC) than the one already in the
    # column and in every existing breakdown (ewca/civ, ewhc/admin, ukftt/grc).
    # The URI path carries the taxonomy we actually use. uk:court stays in metadata.
    court_code = court_code_from_uri(work_uri)
    if court_code:
        court_code = court_code.lower()

    # --- judges ---------------------------------------------------------------
    judges = []
    for j in root.findall(f".//{A}judge"):
        t = el_text(j)
        if t and t not in judges:
            judges.append(t)

    # --- parties --------------------------------------------------------------
    parties = []
    for p in root.findall(f".//{A}party"):
        t = el_text(p)
        if t and t not in parties:
            parties.append(t)
    if not parties:
        for p in root.findall(f".//{A}TLCPerson"):
            t = norm(p.get("showAs"))
            if t and t not in parties:
                parties.append(t)
    # FRBRname is the publisher's own clean case title ("Bashir, R (on the
    # application of) v The Independent Adjudicator") and is present in 100% of the
    # corpus. Joining raw <party> elements interleaves role text and produces
    # "THE QUEEN v on the application of v IMRAN BASHIR v ...", so it is the fallback.
    parties_str = case_name or (" v ".join(parties) if parties else None)

    return {
        "id": row_id,
        "source_url": source_url,
        "neutral_citation": neutral_citation,
        "case_number": case_number,
        "court_name": court_name,
        "court_code": court_code,
        "decision_date": decision_date,
        "judge": judges[0] if judges else None,
        # judges is jsonb in the live schema, not text. Passing "A; B" here is what
        # made 711 of the 984 backfilled rows fail with InvalidTextRepresentation.
        "judges": json.dumps(judges, ensure_ascii=False) if judges else None,
        "parties": parties_str,
        "metadata_json": json.dumps(meta, ensure_ascii=False) if meta else None,
        "full_text": extract_full_text(root) if want_text else None,
    }


# Every column of a VALUES list fed through execute_values arrives as `unknown`,
# so assigning to the jsonb and date columns needs an explicit cast. Without them
# Postgres rejects the whole statement with DatatypeMismatch and nothing updates.
UPDATE_SQL = """
UPDATE uk_court_decisions AS t SET
    source_url       = v.source_url::text,
    neutral_citation = COALESCE(v.neutral_citation::text, t.neutral_citation),
    case_number      = COALESCE(v.case_number::text,      t.case_number),
    court_name       = COALESCE(v.court_name::text,       t.court_name),
    court_code       = COALESCE(v.court_code::text,       t.court_code),
    decision_date    = COALESCE(v.decision_date::date,    t.decision_date),
    judge            = COALESCE(v.judge::text,            t.judge),
    judges           = COALESCE(v.judges::jsonb,          t.judges),
    parties          = COALESCE(v.parties::text,          t.parties),
    metadata_json    = COALESCE(v.metadata_json::jsonb,   t.metadata_json),
    updated_at       = now()
FROM (VALUES %s) AS v(id, source_url, neutral_citation, case_number, court_name,
                      court_code, decision_date, judge, judges, parties, metadata_json)
WHERE t.id = v.id::text
"""

INSERT_SQL = """
INSERT INTO uk_court_decisions
    (id, source, source_url, neutral_citation, case_number, court_name, court_code,
     decision_date, judge, judges, parties, metadata_json, full_text)
SELECT v.id::text, v.source::text, v.source_url::text, v.neutral_citation::text,
       v.case_number::text, v.court_name::text, v.court_code::text,
       v.decision_date::date, v.judge::text, v.judges::jsonb, v.parties::text,
       v.metadata_json::jsonb, v.full_text::text
  FROM (VALUES %s) AS v(id, source, source_url, neutral_citation, case_number,
                        court_name, court_code, decision_date, judge, judges,
                        parties, metadata_json, full_text)
ON CONFLICT (id) DO NOTHING
"""

INSERT_COLS = ["id", "source_url", "neutral_citation", "case_number", "court_name",
               "court_code", "decision_date", "judge", "judges", "parties",
               "metadata_json", "full_text"]

COLS = ["id", "source_url", "neutral_citation", "case_number", "court_name",
        "court_code", "decision_date", "judge", "judges", "parties", "metadata_json"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--root", default=XML_ROOT)
    ap.add_argument("--insert-missing", action="store_true",
                    help="also INSERT the files that parsed but never made it into the DB")
    ap.add_argument("--missing-out", default="/tmp/uk_missing_ids.jsonl",
                    help="files parsed OK whose id is absent from the DB")
    args = ap.parse_args()

    if not DB_URL:
        sys.exit("DATABASE_URL is required (no hardcoded fallback: see plan 1.4)")

    files = []
    for d, _, fs in os.walk(args.root):
        for f in fs:
            if f.endswith(".xml"):
                files.append(os.path.join(d, f))
    files.sort()
    if args.limit:
        files = files[: args.limit]
    print(f"files on disk: {len(files)}", flush=True)

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SELECT id FROM uk_court_decisions")
    known = {r[0] for r in cur.fetchall()}
    print(f"rows in uk_court_decisions: {len(known)}", flush=True)

    stats = {"parsed": 0, "updated": 0, "inserted": 0, "not_in_db": 0, "dup_id": 0}
    errors = {}       # parse-time rejections, counted against the file total
    write_errors = {} # write-time failures, counted against rows
    seen = set()
    batch = []
    ins_batch = []
    missing = []

    def flush():
        if not batch or args.dry_run:
            batch.clear()
            return 0
        try:
            execute_values(cur, UPDATE_SQL, batch, page_size=len(batch))
            n = cur.rowcount
            conn.commit()
        except Exception as e:
            conn.rollback()
            # One bad row must not cost the other 499, which is exactly how the
            # original import lost whole batches without saying so.
            print(f"  batch failed ({e}); retrying row by row", flush=True)
            n = 0
            for row in batch:
                try:
                    execute_values(cur, UPDATE_SQL, [row], page_size=1)
                    n += cur.rowcount
                    conn.commit()
                except Exception as e2:
                    conn.rollback()
                    k = f"update: {type(e2).__name__}"
                    write_errors[k] = write_errors.get(k, 0) + 1
        batch.clear()
        return n

    def flush_insert():
        if not ins_batch or args.dry_run:
            ins_batch.clear()
            return 0
        try:
            execute_values(cur, INSERT_SQL,
                           [(r[0], "tna") + r[1:] for r in ins_batch],
                           page_size=len(ins_batch))
            n = cur.rowcount
            conn.commit()
        except Exception as e:
            conn.rollback()
            print(f"  insert batch failed ({e}); retrying row by row", flush=True)
            n = 0
            for row in ins_batch:
                try:
                    execute_values(cur, INSERT_SQL, [(row[0], "tna") + row[1:]], page_size=1)
                    n += cur.rowcount
                    conn.commit()
                except Exception as e2:
                    conn.rollback()
                    k = f"insert: {type(e2).__name__}"
                    write_errors[k] = write_errors.get(k, 0) + 1
        ins_batch.clear()
        return n

    for i, path in enumerate(files, 1):
        rec = parse_file(path, want_text=args.insert_missing)
        if rec is None or "_error" in rec:
            reason = rec["_error"] if rec else "none"
            key = reason.split(":")[0]
            errors[key] = errors.get(key, 0) + 1
            continue
        stats["parsed"] += 1
        if rec["id"] in seen:
            stats["dup_id"] += 1
            continue
        seen.add(rec["id"])
        if rec["id"] not in known:
            stats["not_in_db"] += 1
            missing.append({"id": rec["id"], "file": path,
                            "date": rec["decision_date"], "cite": rec["neutral_citation"]})
            if args.insert_missing:
                ins_batch.append(tuple(rec[c] for c in INSERT_COLS))
                if len(ins_batch) >= args.batch:
                    stats["inserted"] += flush_insert()
            continue
        batch.append(tuple(rec[c] for c in COLS))
        if len(batch) >= args.batch:
            stats["updated"] += flush()
        if i % 5000 == 0:
            print(f"  {i}/{len(files)} parsed={stats['parsed']} updated={stats['updated']}",
                  flush=True)

    stats["updated"] += flush()
    stats["inserted"] += flush_insert()

    if missing:
        with open(args.missing_out, "w", encoding="utf-8") as fh:
            for m in missing:
                fh.write(json.dumps(m, ensure_ascii=False) + "\n")

    print("\n=== summary ===")
    print(f"  files on disk     : {len(files)}")
    print(f"  parsed ok         : {stats['parsed']}")
    print(f"  duplicate FRBRuri : {stats['dup_id']}")
    print(f"  parsed, not in DB : {stats['not_in_db']}  -> {args.missing_out}")
    print(f"  rows updated      : {stats['updated']}")
    print(f"  rows inserted     : {stats['inserted']}")
    if errors:
        print("  parse rejections:")
        for k, v in sorted(errors.items(), key=lambda x: -x[1]):
            print(f"    {k}: {v}")
    if write_errors:
        print("  write failures:")
        for k, v in sorted(write_errors.items(), key=lambda x: -x[1]):
            print(f"    {k}: {v}")
    accounted = stats["parsed"] + sum(errors.values())
    print(f"  files accounted   : {accounted} / {len(files)}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
