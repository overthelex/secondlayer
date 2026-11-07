#!/usr/bin/env python3
"""Backfill pl_court_decisions from the SAOS dump API (saos.org.pl).

Walks https://www.saos.org.pl/api/dump/judgments page by page and inserts every
judgment whose id is not yet in the table (ids are "saos-<id>", the same scheme
scripts/opendata/import_pl_cz_to_db.py used for the original load). Existing
rows are never touched, so a rerun only costs the download.

Why the dump API and not search: search truncates textContent to an excerpt;
dump returns the whole text plus judgmentResult, meansOfAppeal and the source
judgmentId (the Portal Orzeczeń id), which is what lets us de-duplicate
against the hf-pl-court-raw rows later.

Resume: the state file stores the last page fully committed; start again with
the same --state-file and it continues from the next page. Pages are stable
for a fixed pageSize as long as --since is the same, so always rerun with the
same --since value (or none) until DONE.

DB: PG* environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
Run on local.lex, never on the MacBook.
"""
import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import requests

API = "https://www.saos.org.pl/api"
UA = "lawrider-pl-backfill/1.0 (+https://lawrider.pl)"

log = logging.getLogger("saos")


def get_json(session, url, params, retries=8):
    delay = 5
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=120, headers={"User-Agent": UA})
            if r.status_code == 404:
                return None  # past the last page
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            log.warning("fetch %s %s failed (%s), retry in %ss", url, params, e, delay)
            time.sleep(delay)
            delay = min(delay * 2, 300)
    raise RuntimeError(f"gave up on {url} {params}")


def load_divisions(session):
    """division id -> (court name, division name) from the commonCourts dump.

    The judgments dump only carries division.id. Best effort: if the endpoint
    is not there, rows get NULL court_name like the original load did.
    """
    out = {}
    page = 0
    while True:
        d = get_json(session, f"{API}/dump/commonCourts", {"pageSize": 100, "pageNumber": page})
        if not d or not d.get("items"):
            break
        for court in d["items"]:
            cname = court.get("name")
            for div in court.get("divisions", []) or []:
                out[div.get("id")] = (cname, div.get("name"))
        page += 1
    log.info("loaded %d common-court divisions", len(out))
    return out


def row_from_item(item, divisions):
    saos_id = item["id"]
    court_cases = item.get("courtCases") or []
    case_number = court_cases[0].get("caseNumber") if court_cases else None
    judges = item.get("judges") or []
    judge = judges[0].get("name") if judges else None
    src = item.get("source") or {}
    div = item.get("division") or {}
    court_name, division_name = divisions.get(div.get("id"), (None, None))
    if not court_name and isinstance(div.get("court"), dict):
        court_name = div["court"].get("name")
        division_name = div.get("name")
    legal_bases = [lb.get("text", lb) if isinstance(lb, dict) else lb for lb in item.get("legalBases") or []] or None
    meta = {
        "judgmentId": src.get("judgmentId"),
        "publicationDate": src.get("publicationDate"),
        "publisher": src.get("publisher"),
        "reviser": src.get("reviser"),
        "sourceCode": src.get("code"),
        "judgmentResult": item.get("judgmentResult"),
        "meansOfAppeal": item.get("meansOfAppeal"),
        "receiptDate": item.get("receiptDate") or None,
        "referencedCourtCases": item.get("referencedCourtCases") or None,
        "courtCases": court_cases if len(court_cases) > 1 else None,
        "harvested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "harvester": "harvest_saos.py",
    }
    return (
        f"saos-{saos_id}", None, "saos", item.get("courtType"), court_name, division_name,
        case_number, item.get("judgmentType"), item.get("judgmentDate") or None, judge,
        json.dumps(judges, ensure_ascii=False) if judges else None,
        item.get("keywords") or None, legal_bases,
        json.dumps(item.get("referencedRegulations"), ensure_ascii=False) if item.get("referencedRegulations") else None,
        None, item.get("summary") or None, item.get("textContent") or None,
        src.get("judgmentUrl"), json.dumps(meta, ensure_ascii=False),
    )


INSERT = """
INSERT INTO pl_court_decisions
  (id, ecli, source, court_type, court_name, division, case_number, decision_type,
   decision_date, judge, judges, keywords, legal_bases, referenced_regulations,
   parties, abstract, full_text, source_url, metadata_json)
VALUES %s
ON CONFLICT (id) DO NOTHING
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--page-size", type=int, default=100)
    ap.add_argument("--since", help="sinceModificationDate, e.g. 2026-04-01T00:00:00.000 (omit for the full dump)")
    ap.add_argument("--state-file", default=os.path.expanduser("~/lawrider/pl-saos.state"))
    ap.add_argument("--rate", type=float, default=1.0, help="max requests per second")
    ap.add_argument("--max-pages", type=int, default=0, help="stop after N pages (testing)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and parse, do not write")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    conn = psycopg2.connect("")  # PG* env
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        cur.execute("SELECT substr(id, 6)::bigint FROM pl_court_decisions WHERE source = 'saos'")
        existing = {r[0] for r in cur.fetchall()}
    conn.commit()
    log.info("existing saos rows: %d", len(existing))

    session = requests.Session()
    divisions = load_divisions(session)

    page = 0
    if os.path.exists(args.state_file):
        with open(args.state_file) as f:
            st = json.load(f)
        if st.get("since") == args.since and st.get("page_size") == args.page_size:
            page = st["last_page"] + 1
            log.info("resuming from page %d", page)
        else:
            log.warning("state file is for a different run (%s); starting from 0", st)

    inserted = seen = 0
    pages_done = 0
    min_interval = 1.0 / args.rate if args.rate > 0 else 0
    while True:
        t0 = time.time()
        params = {"pageSize": args.page_size, "pageNumber": page}
        if args.since:
            params["sinceModificationDate"] = args.since
        d = get_json(session, f"{API}/dump/judgments", params)
        items = (d or {}).get("items") or []
        if not items:
            log.info("no items on page %d: DONE", page)
            break
        seen += len(items)
        new = [it for it in items if it["id"] not in existing]
        rows = [row_from_item(it, divisions) for it in new]
        if rows and not args.dry_run:
            with conn.cursor() as cur:
                psycopg2.extras.execute_values(cur, INSERT, rows, page_size=max(len(rows), 1))
                n = cur.rowcount
            conn.commit()
            inserted += max(n, 0)
            existing.update(it["id"] for it in new)
        elif rows:
            inserted += len(rows)
        if not args.dry_run:
            with open(args.state_file, "w") as f:
                json.dump({"since": args.since, "page_size": args.page_size, "last_page": page,
                           "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}, f)
        if page % 10 == 0 or new:
            log.info("page %d: %d items, %d new (total seen %d, inserted %d)", page, len(items), len(new), seen, inserted)
        page += 1
        pages_done += 1
        if args.max_pages and pages_done >= args.max_pages:
            log.info("max pages reached")
            break
        has_next = any(l.get("rel") == "next" for l in (d.get("links") or []))
        if not has_next:
            log.info("no next link after page %d: DONE", page - 1)
            break
        dt = time.time() - t0
        if dt < min_interval:
            time.sleep(min_interval - dt)

    log.info("FINISHED seen=%d inserted=%d", seen, inserted)
    conn.close()


if __name__ == "__main__":
    main()
