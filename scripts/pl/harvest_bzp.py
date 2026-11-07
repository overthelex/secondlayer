#!/usr/bin/env python3
"""Polish procurement notices (e-Zamówienia BZP) into pl_bzp_notices (migration 252).

  python3 scripts/pl/harvest_bzp.py                       # all types, resume each
  python3 scripts/pl/harvest_bzp.py --types ContractNotice --from 2026-11-01

How the API actually behaves (measured 2026-11-07, not documented anywhere):
  * NoticeType is required; 11 values are accepted (TYPES below)
  * PageSize is capped at 500 and PageNumber is IGNORED: every page is page 1
  * PublicationDateFrom is honoured to the second, PublicationDateTo is not
    (a 00:00-09:59 window returns notices up to 13:38)
  * results come sorted by publicationDate ascending
So the harvest is a cursor: ask from the last publicationDate seen, drop the
objectIds already held, stop when a page comes back short.

The cursor per type is max(publication_date) in the table, so a killed run is
resumed by running it again.

`contractors` arrives as a Python repr string ("[{'contractorName': ...}]"),
not JSON; it is parsed with ast.literal_eval.
"""
import argparse
import ast
import datetime as dt
import json
import os
import subprocess
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

API = "https://ezamowienia.gov.pl/mo-board/api/v1/notice"
MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "252_pl_bzp_notices.sql")
TYPES = ["ContractNotice", "TenderResultNotice", "ContractPerformingNotice",
         "NoticeUpdateNotice", "AgreementIntentionNotice", "SmallContractNotice",
         "AgreementUpdateNotice", "CompetitionNotice", "CompetitionResultNotice",
         "ConcessionNotice", "ConcessionAgreementNotice"]
PAUSE = float(os.environ.get("PAUSE", "1.0"))
UA = "lawrider.pl BZP open-data harvester"
COLS = ["object_id", "notice_type", "notice_number", "bzp_number", "tender_id",
        "publication_date", "order_type", "order_object", "cpv_code",
        "below_eu_threshold", "submitting_offers_date", "procedure_result",
        "organization_name", "organization_nip", "organization_city",
        "organization_province", "contractors", "html_body", "payload", "fetched_at"]
TOP = {"objectId", "noticeType", "noticeNumber", "bzpNumber", "tenderId",
       "publicationDate", "orderType", "orderObject", "cpvCode",
       "isTenderAmountBelowEU", "submittingOffersDate", "procedureResult",
       "organizationName", "organizationNationalId", "organizationCity",
       "organizationProvince", "contractors", "htmlBody"}


def none(v):
    return None if v in (None, "None", "") else v


def contractors(v):
    v = none(v)
    if v is None:
        return None
    try:
        return json.dumps(ast.literal_eval(v), ensure_ascii=False)
    except (ValueError, SyntaxError):
        return json.dumps({"raw": v}, ensure_ascii=False)


def row(x):
    below = none(x.get("isTenderAmountBelowEU"))
    return (
        x["objectId"], x["noticeType"], none(x.get("noticeNumber")),
        none(x.get("bzpNumber")), none(x.get("tenderId")), x["publicationDate"],
        none(x.get("orderType")), none(x.get("orderObject")), none(x.get("cpvCode")),
        None if below is None else below == "True",
        none(x.get("submittingOffersDate")), none(x.get("procedureResult")),
        none(x.get("organizationName")), none(x.get("organizationNationalId")),
        none(x.get("organizationCity")), none(x.get("organizationProvince")),
        contractors(x.get("contractors")), none(x.get("htmlBody")),
        json.dumps({k: v for k, v in x.items() if k not in TOP}, ensure_ascii=False),
        time.strftime("%Y-%m-%d %H:%M:%S"),
    )


def fetch(s, ntype, since):
    params = {"NoticeType": ntype, "PublicationDateFrom": since,
              "PublicationDateTo": "2099-12-31T23:59:59", "PageSize": 500,
              "PageNumber": 1}
    for attempt in range(5):
        try:
            r = s.get(API, params=params, timeout=300)
            if r.status_code == 200:
                return r.json()
        except (requests.RequestException, ValueError):
            pass
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"{ntype} since {since}: giving up")


def cursor_of(ntype, default):
    v = plprod.scalar(
        "SELECT to_char(max(publication_date) AT TIME ZONE 'UTC', "
        "'YYYY-MM-DD\"T\"HH24:MI:SS') FROM pl_bzp_notices "
        f"WHERE notice_type = '{ntype}'")
    return v or default


def harvest(ntype, start, max_pages=0):
    s = requests.Session()
    s.headers["User-Agent"] = UA
    since = cursor_of(ntype, start)
    total = 0
    t0 = time.time()
    pages = 0
    while True:
        pages += 1
        if max_pages and pages > max_pages:
            break
        items = fetch(s, ntype, since)
        if not items:
            break
        ids = [x["objectId"] for x in items]
        held = set()
        for i in range(0, len(ids), 500):
            q = ",".join("'" + x.replace("'", "''") + "'" for x in ids[i:i + 500])
            held |= {r[0] for r in plprod.rows_of(
                f"SELECT object_id FROM pl_bzp_notices WHERE object_id IN ({q})")}
        new = [row(x) for x in items if x["objectId"] not in held]
        if new:
            plprod.upsert_rows("pl_bzp_notices", COLS, new, ["object_id"],
                               prefer_new=False, batch=250)
            total += len(new)
        last = max(x["publicationDate"] for x in items)[:19]
        print(f"{ntype} {since} -> {last}: {len(items)} got, {len(new)} new, "
              f"{total} total, {int(time.time() - t0)} s", flush=True)
        if len(items) < 500:
            break
        if last == since:
            # 500 notices inside one second would stall the cursor; never seen,
            # but stepping a second is better than looping forever.
            last = (dt.datetime.fromisoformat(last) + dt.timedelta(seconds=1)
                    ).strftime("%Y-%m-%dT%H:%M:%S")
            print(f"  cursor stuck at {since}, stepping one second", flush=True)
        since = last
        time.sleep(PAUSE)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", nargs="+", default=TYPES, choices=TYPES)
    # --from only seeds an EMPTY type: once a type has rows its cursor is
    # max(publication_date), so a smoke run must start at the real beginning
    # and be bounded with --max-pages, or the full run would skip the gap.
    ap.add_argument("--from", dest="start", default="2021-01-01T00:00:00")
    ap.add_argument("--max-pages", type=int, default=0)
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True,
                           text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    start = a.start if "T" in a.start else a.start + "T00:00:00"
    for t in a.types:
        n = harvest(t, start, a.max_pages)
        print(f"== {t}: {n} new", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
