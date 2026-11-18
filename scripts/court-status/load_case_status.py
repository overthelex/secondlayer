#!/usr/bin/env python3
"""
Accumulate the ДСА open dataset «Інформація щодо стану розгляду справ» into
court_case_status_history (migration 278).

data.gov.ua dataset 0ad60ea9-b029-456d-abc0-8c77a99b205c is republished daily as one zip that
holds only the latest ~1.5M stage events; older events fall out of each new snapshot. This
loader upserts every event it sees, so the history table keeps them all:
  - event_key = md5(court_name|case_number|case_proc|stage_date(raw)|stage_name|type|cause_result)
  - a new event is inserted with first_seen = last_seen = snapshot date;
  - a known event gets first_seen = least, last_seen = greatest, and participants / description /
    judge / judges / cause_dep / registration_date filled from the newer snapshot when it has a value.
  - a rerun of the same snapshot changes nothing (the ON CONFLICT update is guarded by WHERE), and
    a snapshot already listed in court_case_status_snapshots is skipped by --latest / --all-resources.

Modes:
  --latest                  newest zip from CKAN package_show; skip if already loaded; download,
                            load, delete the download after success.
  --all-resources           every zip/csv resource of the package not yet loaded (backfill of the
                            2022 monthly CSVs); downloads are deleted after success.
  --file PATH               a local zip (of TSV files) or a single csv/tsv file.
  --seed-from-opendata-table  one-off: copy opendata_court_case_status (snapshot of 01.11.2026).

Database access goes through the psql client (COPY FROM STDIN), so the script needs only the
Python standard library:
  DATABASE_URL=postgresql://...      -> psql "$DATABASE_URL"
  otherwise                          -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                        (defaults: secondlayer-postgres-local / secondlayer /
                                        secondlayer_local)

Each chunk (default 100,000 rows) is staged in a temp table and merged with one
INSERT ... ON CONFLICT in its own transaction, so an interrupted run resumes by rerunning:
already merged chunks are no-ops.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from typing import Iterable, Iterator

DATASET_ID = "0ad60ea9-b029-456d-abc0-8c77a99b205c"
PACKAGE_SHOW = f"https://data.gov.ua/api/3/action/package_show?id={DATASET_ID}"
SEED_SNAPSHOT = "opendata_court_case_status@2026-11-01"
SEED_DATE = dt.date(2026, 11, 1)

SOURCE_COLUMNS = [
    "court_name", "case_number", "case_proc", "registration_date", "judge", "judges",
    "participants", "stage_date", "stage_name", "cause_result", "cause_dep", "type", "description",
]
STAGE_COLUMNS = [
    "event_key", "court_name", "case_number", "case_proc", "registration_date", "judge", "judges",
    "participants", "stage_date", "stage_name", "cause_result", "cause_dep", "case_type", "description",
]

MIN_YEAR = 1990
MAX_YEAR = dt.date.today().year + 3
DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")
DOUBLED_YEAR_RE = re.compile(r"^(2[0-9])\1$")
FILENAME_DATE_RE = re.compile(r"(\d{2})[-._](\d{2})[-._](\d{4})")

csv.field_size_limit(2**31 - 1)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ─── Normalisation ──────────────────────────────────────────────────────────


def parse_court_date(raw: str | None) -> str | None:
    """DD.MM.YYYY -> ISO date, or None. Same rules as mcp_backend court-case-status-dates.ts:
    a doubled two-digit year («01.12.2323») is repaired, other implausible years are dropped."""
    s = (raw or "").strip()
    m = DATE_RE.match(s)
    if not m:
        return None
    dd, mm, yyyy = int(m.group(1)), int(m.group(2)), m.group(3)
    year = int(yyyy)
    if not (MIN_YEAR <= year <= MAX_YEAR):
        if DOUBLED_YEAR_RE.match(yyyy) and MIN_YEAR <= 2000 + int(yyyy[2:]) <= MAX_YEAR:
            year = 2000 + int(yyyy[2:])
        else:
            return None
    try:
        return dt.date(year, mm, dd).isoformat()
    except ValueError:
        return None


def clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


def event_key(raw: dict) -> str:
    parts = [raw.get(c) or "" for c in
             ("court_name", "case_number", "case_proc", "stage_date", "stage_name", "type", "cause_result")]
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()


def to_stage_row(raw: dict) -> list | None:
    court, case = clean(raw.get("court_name")), clean(raw.get("case_number"))
    if not court or not case:
        return None
    participants = clean(raw.get("participants"))
    if participants == "-":
        participants = None
    return [
        event_key(raw), court, case, clean(raw.get("case_proc")),
        parse_court_date(raw.get("registration_date")), clean(raw.get("judge")), clean(raw.get("judges")),
        participants, parse_court_date(raw.get("stage_date")), clean(raw.get("stage_name")),
        clean(raw.get("cause_result")), clean(raw.get("cause_dep")), clean(raw.get("type")),
        clean(raw.get("description")),
    ]


def copy_escape(v) -> str:
    if v is None:
        return "\\N"
    return (str(v).replace("\\", "\\\\").replace("\t", "\\t")
            .replace("\n", "\\n").replace("\r", "\\r"))


def read_records(text_stream: io.TextIOBase) -> Iterator[dict]:
    """Parse one ДСА export: tab-separated, every field quoted, header first."""
    reader = csv.reader(text_stream, delimiter="\t", quotechar='"')
    header = next(reader, None)
    if header is None:
        return
    header = [h.strip().lstrip("\ufeff").lower() for h in header]
    missing = [c for c in SOURCE_COLUMNS if c not in header]
    if missing:
        raise SystemExit(f"header lacks columns {missing}: {header}")
    idx = {c: header.index(c) for c in SOURCE_COLUMNS}
    n = len(header)
    for rec in reader:
        if not rec or (len(rec) == 1 and not rec[0]):
            continue
        if len(rec) < n:
            rec = rec + [""] * (n - len(rec))
        yield {c: rec[i] for c, i in idx.items()}


# ─── Database (psql) ────────────────────────────────────────────────────────


def psql_cmd() -> list[str]:
    base = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    url = os.environ.get("DATABASE_URL")
    if url:
        return ["psql", url, *base]
    return ["docker", "exec", "-i", os.environ.get("PG_CONTAINER", "secondlayer-postgres-local"),
            "psql", "-U", os.environ.get("PGUSER", "secondlayer"),
            "-d", os.environ.get("PGDATABASE", "secondlayer_local"), *base]


def psql(sql: str) -> str:
    r = subprocess.run(psql_cmd(), input=sql, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()}")
    return r.stdout


def lit(s: str | None) -> str:
    return "NULL" if s is None else "'" + s.replace("'", "''") + "'"


def snapshot_loaded(name: str) -> bool:
    out = psql(f"SELECT 1 FROM court_case_status_snapshots WHERE snapshot_name = {lit(name)};")
    return out.strip() == "1"


def record_snapshot(name: str, url: str | None, modified: str | None, stats: dict) -> None:
    psql(f"""
INSERT INTO court_case_status_snapshots AS s
  (snapshot_name, resource_url, resource_modified, rows_read, rows_inserted, rows_updated)
VALUES ({lit(name)}, {lit(url)}, {lit(modified)}::timestamptz,
        {stats['read']}, {stats['inserted']}, {stats['updated']})
ON CONFLICT (snapshot_name) DO UPDATE SET  -- a --force reload adds to the counts of the first load
  resource_url = COALESCE(EXCLUDED.resource_url, s.resource_url),
  resource_modified = COALESCE(EXCLUDED.resource_modified, s.resource_modified),
  rows_read = GREATEST(s.rows_read, EXCLUDED.rows_read),
  rows_inserted = s.rows_inserted + EXCLUDED.rows_inserted,
  rows_updated = s.rows_updated + EXCLUDED.rows_updated, loaded_at = NOW();
""")


def refresh_cols(col: str) -> str:
    # The newer snapshot wins when it has a value; an older one only fills gaps.
    return (f"{col} = CASE WHEN EXCLUDED.last_seen >= h.last_seen "
            f"THEN COALESCE(EXCLUDED.{col}, h.{col}) ELSE COALESCE(h.{col}, EXCLUDED.{col}) END")


REFRESHED = ["participants", "description", "judge", "judges", "cause_dep", "registration_date"]


def merge_sql(snapshot_date: dt.date, snapshot_name: str) -> str:
    cols = ", ".join(STAGE_COLUMNS)
    d = lit(snapshot_date.isoformat()) + "::date"
    sets = ",\n    ".join(
        ["first_seen = LEAST(h.first_seen, EXCLUDED.first_seen)",
         "last_seen = GREATEST(h.last_seen, EXCLUDED.last_seen)"] + [refresh_cols(c) for c in REFRESHED])
    gaps = " OR ".join(f"(h.{c} IS NULL AND EXCLUDED.{c} IS NOT NULL)" for c in REFRESHED)
    return f"""
WITH src AS (
  SELECT DISTINCT ON (event_key) * FROM ccsh_stage
  ORDER BY event_key, (participants IS NULL), (description IS NULL)
), up AS (
  INSERT INTO court_case_status_history AS h ({cols}, first_seen, last_seen, source_snapshot)
  SELECT {cols}, {d}, {d}, {lit(snapshot_name)} FROM src
  ON CONFLICT (event_key) DO UPDATE SET
    {sets}
  WHERE EXCLUDED.last_seen > h.last_seen OR EXCLUDED.first_seen < h.first_seen OR {gaps}
  RETURNING (xmax = 0) AS ins
)
SELECT 'RESULT|' || (SELECT count(*) FROM src) || '|'
       || count(*) FILTER (WHERE ins) || '|' || count(*) FILTER (WHERE NOT ins) FROM up;
"""


class ChunkMerger:
    """One chunk = one psql session: rows are streamed into a temp table with COPY (no buffering in
    Python, so memory stays flat), then merged with one INSERT ... ON CONFLICT and committed."""

    def __init__(self, snapshot_date: dt.date, snapshot_name: str):
        self.snapshot_date, self.snapshot_name = snapshot_date, snapshot_name
        self.rows = 0
        self.proc = subprocess.Popen(psql_cmd(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.proc.stdin.write(f"""
SET statement_timeout = '{os.environ.get('CCSH_STATEMENT_TIMEOUT', '30min')}';
SET lock_timeout = '60s';
BEGIN;
CREATE TEMP TABLE ccsh_stage (
  event_key text, court_name text, case_number text, case_proc text, registration_date date,
  judge text, judges text, participants text, stage_date date, stage_name text,
  cause_result text, cause_dep text, case_type text, description text
) ON COMMIT DROP;
COPY ccsh_stage ({", ".join(STAGE_COLUMNS)}) FROM STDIN;
""")

    def add(self, row: list) -> None:
        try:
            self.proc.stdin.write("\t".join(copy_escape(v) for v in row) + "\n")
        except BrokenPipeError:
            self.finish()  # raises with psql's error message
        self.rows += 1

    def finish(self) -> tuple[int, int, int]:
        """Returns (distinct, inserted, updated)."""
        try:
            self.proc.stdin.write("\\.\n")
            self.proc.stdin.write(merge_sql(self.snapshot_date, self.snapshot_name))
            self.proc.stdin.write("COMMIT;\n")
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        out, err = self.proc.stdout.read(), self.proc.stderr.read()
        if self.proc.wait() != 0:
            raise RuntimeError(f"merge failed: {err.strip()[:2000]}")
        for line in out.splitlines():
            if line.startswith("RESULT|"):
                _, distinct, ins, upd = line.split("|")
                return int(distinct), int(ins), int(upd)
        raise RuntimeError(f"merge returned no RESULT line: {out[:500]} {err[:500]}")


def load_records(records: Iterable[dict], snapshot_date: dt.date, snapshot_name: str,
                 stats: dict, chunk_rows: int, label: str) -> None:
    t0 = time.time()
    merger: ChunkMerger | None = None

    def flush() -> None:
        nonlocal merger
        if merger is None:
            return
        n = merger.rows
        distinct, ins, upd = merger.finish()
        merger = None
        stats["distinct"] += distinct
        stats["inserted"] += ins
        stats["updated"] += upd
        log(f"  {label}: merged {n} rows ({distinct} distinct): +{ins} new, {upd} updated, "
            f"{distinct - ins - upd} unchanged [{time.time() - t0:.0f}s]")

    for raw in records:
        stats["read"] += 1
        row = to_stage_row(raw)
        if row is None:
            stats["skipped"] += 1
            continue
        if merger is None:
            merger = ChunkMerger(snapshot_date, snapshot_name)
        merger.add(row)
        if merger.rows >= chunk_rows:
            flush()
    flush()


# ─── Sources ────────────────────────────────────────────────────────────────


def snapshot_date_from_name(name: str) -> dt.date:
    """Last DD-MM-YYYY in the name: «...vid-17-11-2026.zip» -> 17.11.2026,
    «...z-01-04-2022-po-01-05-2022.csv» -> 01.05.2022. Falls back to today."""
    found = FILENAME_DATE_RE.findall(os.path.basename(name))
    for dd, mm, yyyy in reversed(found):
        try:
            return dt.date(int(yyyy), int(mm), int(dd))
        except ValueError:
            continue
    return dt.date.today()


def member_order(name: str):
    m = re.search(r"_(\d+)\.\w+$", name)
    return (int(m.group(1)) if m else 10**9, name)


def load_file(path: str, snapshot_name: str, snapshot_date: dt.date, chunk_rows: int) -> dict:
    stats = dict(read=0, skipped=0, distinct=0, inserted=0, updated=0, files=0)
    log(f"loading {path} as snapshot {snapshot_name} ({snapshot_date})")
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            members = sorted((m for m in zf.namelist() if not m.endswith("/")), key=member_order)
            for m in members:
                with zf.open(m) as fh:
                    text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
                    before = stats["read"]
                    load_records(read_records(text), snapshot_date, snapshot_name, stats, chunk_rows, m)
                    log(f"  {m}: {stats['read'] - before} rows")
                    stats["files"] += 1
    else:
        with open(path, encoding="utf-8-sig", newline="") as fh:
            load_records(read_records(fh), snapshot_date, snapshot_name, stats, chunk_rows,
                         os.path.basename(path))
            stats["files"] = 1
    log(f"done {snapshot_name}: files={stats['files']} read={stats['read']} skipped={stats['skipped']} "
        f"distinct={stats['distinct']} inserted={stats['inserted']} updated={stats['updated']}")
    return stats


def seed_from_opendata_table(chunk_rows: int) -> dict:
    """One-off: copy opendata_court_case_status (the 01.11.2026 snapshot) into the history.
    Its dates were already repaired by migration 233, so a few event keys built from those dates
    differ from the raw-date keys of the daily files (about 1 row in 13,000)."""
    stats = dict(read=0, skipped=0, distinct=0, inserted=0, updated=0, files=1)
    cols = ", ".join(c if c != "type" else "case_type AS type" for c in SOURCE_COLUMNS)
    sql = (f"COPY (SELECT {cols} FROM opendata_court_case_status ORDER BY id) "
           "TO STDOUT WITH (FORMAT csv, DELIMITER E'\\t', HEADER, FORCE_QUOTE *)")
    cmd = [c for c in psql_cmd() if c not in ("-A", "-t")] + ["-c", sql]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    log(f"seeding from opendata_court_case_status as {SEED_SNAPSHOT}")
    text = io.TextIOWrapper(proc.stdout, encoding="utf-8", newline="")
    load_records(read_records(text), SEED_DATE, SEED_SNAPSHOT, stats, chunk_rows,
                 "opendata_court_case_status")
    if proc.wait() != 0:
        raise RuntimeError("COPY from opendata_court_case_status failed")
    log(f"seed done: read={stats['read']} inserted={stats['inserted']} updated={stats['updated']}")
    return stats


def ckan_resources() -> list[dict]:
    req = urllib.request.Request(PACKAGE_SHOW, headers={"User-Agent": "secondlayer-opendata-loader"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    return body["result"]["resources"]


def resource_name(res: dict) -> str:
    return res.get("name") or os.path.basename(urllib.parse.urlparse(res["url"]).path)


def download(url: str, dest: str) -> None:
    part = dest + ".part"
    log(f"downloading {url} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "secondlayer-opendata-loader"})
    with urllib.request.urlopen(req, timeout=300) as r, open(part, "wb") as out:
        total = 0
        while True:
            b = r.read(8 << 20)
            if not b:
                break
            out.write(b)
            total += len(b)
    os.replace(part, dest)
    log(f"downloaded {total / 1e6:.0f} MB")


def load_resource(res: dict, work_dir: str, chunk_rows: int, keep: bool) -> None:
    name = resource_name(res)
    if snapshot_loaded(name):
        log(f"{name}: already loaded, skipping")
        return
    os.makedirs(work_dir, exist_ok=True)
    dest = os.path.join(work_dir, os.path.basename(urllib.parse.urlparse(res["url"]).path))
    expected = res.get("size")
    if not (os.path.exists(dest) and expected and os.path.getsize(dest) == int(expected)):
        download(res["url"], dest)
    stats = load_file(dest, name, snapshot_date_from_name(name), chunk_rows)
    record_snapshot(name, res["url"], res.get("last_modified"), stats)
    if not keep:
        os.remove(dest)
        log(f"removed {dest}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--latest", action="store_true")
    g.add_argument("--all-resources", action="store_true")
    g.add_argument("--file")
    g.add_argument("--seed-from-opendata-table", action="store_true")
    ap.add_argument("--snapshot-name", help="--file: name recorded in court_case_status_snapshots "
                    "(default: file basename; use the CKAN resource name to make --latest skip it)")
    ap.add_argument("--snapshot-date", help="--file: YYYY-MM-DD (default: from the file name, else today)")
    ap.add_argument("--work-dir", default=os.environ.get("CCSH_WORK_DIR", "/tmp/dsa-case-status"))
    ap.add_argument("--chunk-rows", type=int, default=int(os.environ.get("CCSH_CHUNK_ROWS", "100000")))
    ap.add_argument("--keep-download", action="store_true")
    ap.add_argument("--force", action="store_true", help="--file/--seed: load even if already recorded")
    a = ap.parse_args()
    t0 = time.time()

    if a.latest or a.all_resources:
        resources = ckan_resources()
        if a.latest:
            zips = [r for r in resources if re.search(r"\.zip$", r["url"], re.I)]
            if not zips:
                raise SystemExit("package has no zip resource")
            zips.sort(key=lambda r: r.get("last_modified") or r.get("created") or "", reverse=True)
            targets = zips[:1]
        else:
            targets = [r for r in resources if re.search(r"\.(zip|csv)$", r["url"], re.I)]
        for res in targets:
            load_resource(res, a.work_dir, a.chunk_rows, a.keep_download)
    elif a.file:
        name = a.snapshot_name or os.path.basename(a.file)
        if not a.force and snapshot_loaded(name):
            log(f"{name}: already loaded, skipping (use --force to reload)")
            return 0
        sdate = dt.date.fromisoformat(a.snapshot_date) if a.snapshot_date else snapshot_date_from_name(name)
        stats = load_file(a.file, name, sdate, a.chunk_rows)
        record_snapshot(name, None, None, stats)
    else:
        if not a.force and snapshot_loaded(SEED_SNAPSHOT):
            log(f"{SEED_SNAPSHOT}: already loaded, skipping (use --force to reload)")
            return 0
        stats = seed_from_opendata_table(a.chunk_rows)
        record_snapshot(SEED_SNAPSHOT, None, None, stats)

    log(f"finished in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
