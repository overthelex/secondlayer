#!/usr/bin/env python3
"""Polish SLPS case-assignment reports into pl_slps_* (migration 253).

  python3 scripts/pl/harvest_slps.py               # every report not yet loaded
  python3 scripts/pl/harvest_slps.py --limit 3     # smoke

dane.gov.pl dataset 4549 publishes one resource per day (626 on 2026-11-07),
each a ZIP holding Raport_<day>.json (~39 MB, ~17,700 assignments in ~1,400
departments). The worklist is the resource list minus pl_slps_reports, so a
killed run resumes by running it again. A report's rows are written in one
transaction together with its pl_slps_reports row, so a report is either fully
loaded or not at all.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import zipfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

DANE = "https://api.dane.gov.pl/1.4"
DATASET = 4549
MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "253_pl_slps.sql")
UA = "lawrider.pl SLPS open-data loader"
DRAW_COLS = ["resource_id", "file_name", "draw_no", "draw_date", "court_name",
             "department_id", "department_name", "case_signature", "category",
             "symbol", "draw_result", "presiding_judge", "pool_size", "candidates",
             "court_case_in_draw_id", "meta"]
JUDGE_COLS = ["day", "department_id", "full_name", "court_name", "department_name",
              "in_pool", "workload", "delegated_77_9"]
CAND = "caseCouldHaveBeenAssignedToTheFollowingJudgesReferendaries"


def resources(s):
    """Daily report resources, deduplicated. Sorted by id, because the default
    order shifts between pages and repeats or skips rows. The dataset also
    holds a JSON schema resource, which is not a report."""
    out, page = {}, 1
    while True:
        d = s.get(f"{DANE}/datasets/{DATASET}/resources",
                  params={"per_page": 100, "page": page, "sort": "id"},
                  timeout=120).json()
        for r in d["data"]:
            a = r["attributes"]
            if re.match(r"Raport \d{4}-\d{2}-\d{2}", a.get("title") or ""):
                out[int(r["id"])] = (int(r["id"]), a.get("title"), a.get("download_url"))
        if len(d["data"]) < 100:
            return list(out.values())
        page += 1


def parse(blob, rid):
    """-> (report_day, documents, draw rows, judge rows)."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.endswith(".json"))
        d = json.loads(z.read(name))
    draws, judges, docs, day0 = [], {}, 0, None
    for day in d.get("days") or []:
        dday = day.get("day")
        day0 = day0 or dday
        for dep in day.get("departments") or []:
            dep_id = str(dep.get("departmentZSRKId"))
            for doc in dep.get("documents") or []:
                docs += 1
                r = doc.get("reportOfRandomCaseAssignment") or {}
                for n, dr in enumerate(r.get("draws") or []):
                    cands = dr.get(CAND) or []
                    sel = dr.get("drawWasMadeAmongCandidatesWithLowestWorkloadWhoWere"
                                 "RandomlyAssignedPositionNumber") or {}
                    meta = {k: v for k, v in dr.items()
                            if k not in (CAND, "presidingJudge", "drawDate",
                                         "drawResult", "courtCaseInDrawId")}
                    draws.append((
                        rid, doc.get("fileName"), n, dr.get("drawDate"),
                        r.get("courtName"), dep_id, r.get("departmentName"),
                        r.get("caseSignature"), r.get("category"), r.get("symbol"),
                        dr.get("drawResult"),
                        (dr.get("presidingJudge") or {}).get("fullName"),
                        sel.get("poolSize"), len(cands), dr.get("courtCaseInDrawId"),
                        json.dumps(meta, ensure_ascii=False)))
                    for c in cands:
                        nm = c.get("fullName")
                        if nm:
                            # later documents of the same day overwrite earlier
                            # ones: the last workload of the day is kept
                            judges[(dday, dep_id, nm)] = (
                                dday, dep_id, nm, r.get("courtName"),
                                r.get("departmentName"), c.get("inPool"),
                                c.get("currentWorkload"), c.get("delegatedUnderArticle77_9"))
    return day0, docs, draws, list(judges.values())


def copy_block(table, cols, rows):
    data = "".join("\t".join(plprod.esc(c) for c in r) + "\n" for r in rows)
    return (f"COPY {table} ({', '.join(cols)}) FROM STDIN WITH (FORMAT text);\n"
            + data + "\\.\n")


def load(s, rid, title, url):
    t0 = time.time()
    blob = s.get(url, timeout=600).content
    day, docs, draws, judges = parse(blob, rid)
    t = (title or "").replace("'", "''")
    # judges: a day can come in two resources (re-publication); keep one row
    sql = ("BEGIN;\n"
           f"DELETE FROM pl_slps_draws WHERE resource_id = {rid};\n"
           + copy_block("pl_slps_draws", DRAW_COLS, draws)
           + "CREATE TEMP TABLE _j (LIKE pl_slps_department_judges) ON COMMIT DROP;\n"
           + copy_block("_j", JUDGE_COLS, judges)
           + f"INSERT INTO pl_slps_department_judges SELECT * FROM _j "
             "ON CONFLICT (day, department_id, full_name) DO UPDATE SET "
             "in_pool = EXCLUDED.in_pool, workload = EXCLUDED.workload, "
             "delegated_77_9 = EXCLUDED.delegated_77_9;\n"
           + "INSERT INTO pl_slps_reports (resource_id, report_day, title, documents, draws) "
             f"VALUES ({rid}, {('%s' % repr(day)) if day else 'NULL'}, '{t}', {docs}, {len(draws)}) "
             "ON CONFLICT (resource_id) DO UPDATE SET loaded_at = now();\n"
           "COMMIT;\n")
    r = subprocess.run(plprod._argv(), input=sql, capture_output=True, text=True,
                       timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"resource {rid}: {r.stderr.strip()[:600]}")
    print(f"{rid} {day}: {docs} documents, {len(draws)} draws, {len(judges)} judge-rows, "
          f"{len(blob) // 1024} KB zip, {time.time() - t0:.0f} s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True,
                           text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    s = requests.Session()
    s.headers["User-Agent"] = UA
    res = resources(s)
    have = {int(x[0]) for x in plprod.rows_of("SELECT resource_id FROM pl_slps_reports")}
    todo = [x for x in res if x[0] not in have and x[2]]
    # oldest first, by the date in the title
    todo.sort(key=lambda x: re.search(r"\d{4}-\d{2}-\d{2}", x[1] or "") and
              re.search(r"\d{4}-\d{2}-\d{2}", x[1]).group(0) or "")
    print(f"{len(res)} resources, {len(have)} loaded, {len(todo)} to load", flush=True)
    if a.limit:
        todo = todo[:a.limit]
    failed = 0
    for rid, title, url in todo:
        try:
            load(s, rid, title, url)
        except Exception as e:
            failed += 1
            print(f"{rid} {title}: FAILED {e}", file=sys.stderr, flush=True)
        time.sleep(1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
