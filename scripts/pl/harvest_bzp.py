#!/usr/bin/env python3
"""Polish procurement notices (e-Zamówienia BZP) into pl_bzp_notices (migration 252).

  python3 scripts/pl/harvest_bzp.py                       # all types, resume each
  python3 scripts/pl/harvest_bzp.py --types ContractNotice --from 2026-11-01

How the API actually behaves (measured 2026-11-07, not documented anywhere):
  * NoticeType is required; 11 values are accepted (TYPES below)
  * PageSize is capped at 500 and PageNumber is IGNORED: every page is page 1
  * the date filter is [PublicationDateFrom, PublicationDateTo + 24 h).
    To=From gives one day; To earlier than From is accepted, so an exact
    window [A, B) is From=A, To=B-24h (1 h windows 08-09 and 09-10 gave 62 and
    67, the 08-10 window 129)
  * order is by internal id, which is NOT publication order for 2021-2022
  * one response can carry the same objectId twice (seen 2024-02-13)
So the harvest walks exact windows: start with one day, halve while a window
fills the 500 cap, grow (up to a week) while windows come back small.

pl_bzp_progress.done_until per type is the end of the last complete window,
so a killed run resumes exactly where it stopped.

`contractors` arrives as a JSON list; a Python repr string of one is accepted
too. Text can carry NUL characters, which Postgres rejects, so they are removed.
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
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    try:
        return json.dumps(ast.literal_eval(v), ensure_ascii=False)
    except (ValueError, SyntaxError):
        return json.dumps({"raw": v}, ensure_ascii=False)


def strip_nul(v):
    if isinstance(v, str):
        return v.replace("\x00", "")
    if isinstance(v, list):
        return [strip_nul(i) for i in v]
    if isinstance(v, dict):
        return {k: strip_nul(i) for k, i in v.items()}
    return v


def row(x):
    x = strip_nul(x)
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


FMT = "%Y-%m-%dT%H:%M:%S"


def fetch(s, ntype, lo, hi):
    """Every notice of ntype with lo <= publicationDate < hi, or None if the
    window is too full to tell (the 500 cap)."""
    params = {"NoticeType": ntype, "PublicationDateFrom": lo.strftime(FMT),
              "PublicationDateTo": (hi - dt.timedelta(hours=24)).strftime(FMT),
              "PageSize": 500, "PageNumber": 1}
    for attempt in range(5):
        try:
            r = s.get(API, params=params, timeout=300)
            if r.status_code == 200:
                items = r.json()
                return None if len(items) >= 500 else items
        except (requests.RequestException, ValueError):
            pass
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"{ntype} {lo}..{hi}: giving up")


def progress(ntype, default):
    v = plprod.scalar(
        "SELECT to_char(done_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') "
        f"FROM pl_bzp_progress WHERE notice_type = '{ntype}'")
    return dt.datetime.strptime(v or default, FMT)


def held_ids(ids):
    held = set()
    for i in range(0, len(ids), 500):
        q = ",".join("'" + x.replace("'", "''") + "'" for x in ids[i:i + 500])
        held |= {r[0] for r in plprod.rows_of(
            f"SELECT object_id FROM pl_bzp_notices WHERE object_id IN ({q})")}
    return held


def harvest(ntype, start, until):
    s = requests.Session()
    s.headers["User-Agent"] = UA
    lo = progress(ntype, start)
    step = dt.timedelta(days=1)
    total, calls, t0 = 0, 0, time.time()
    while lo < until:
        hi = min(lo + step, until)
        items = fetch(s, ntype, lo, hi)
        calls += 1
        time.sleep(PAUSE)
        if items is None:
            if step <= dt.timedelta(minutes=1):
                raise RuntimeError(f"{ntype}: >=500 notices within a minute at {lo}")
            step = step / 2
            continue
        # the API can return the same objectId twice in one response
        items = list({x["objectId"]: x for x in items}.values())
        held = held_ids([x["objectId"] for x in items])
        new = [row(x) for x in items if x["objectId"] not in held]
        if new:
            plprod.upsert_rows("pl_bzp_notices", COLS, new, ["object_id"],
                               prefer_new=False, batch=250)
            total += len(new)
        plprod.psql(
            "INSERT INTO pl_bzp_progress (notice_type, done_until) "
            f"VALUES ('{ntype}', '{hi.strftime(FMT)}+00') ON CONFLICT (notice_type) "
            "DO UPDATE SET done_until = EXCLUDED.done_until, updated_at = now()")
        if calls % 20 == 0 or len(items) > 250:
            print(f"{ntype} {lo:%Y-%m-%d %H:%M} +{step}: {len(items)} got, "
                  f"{len(new)} new, {total} total, {calls} calls, "
                  f"{int(time.time() - t0)} s", flush=True)
        lo = hi
        if len(items) < 150 and step < dt.timedelta(days=7):
            step = step * 2
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", nargs="+", default=TYPES, choices=TYPES)
    # --from only seeds a type with no pl_bzp_progress row; after that the
    # stored done_until wins. A smoke run is bounded with --until, and the
    # full run then carries on from there.
    ap.add_argument("--from", dest="start", default="2021-01-01T00:00:00")
    ap.add_argument("--until", help="default: today 00:00 UTC")
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True,
                           text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    start = a.start if "T" in a.start else a.start + "T00:00:00"
    until = (dt.datetime.strptime(a.until if "T" in a.until else a.until + "T00:00:00", FMT)
             if a.until else dt.datetime.utcnow().replace(hour=0, minute=0, second=0,
                                                          microsecond=0))
    for t in a.types:
        n = harvest(t, start, until)
        print(f"== {t}: {n} new", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
