#!/usr/bin/env python3
"""
Load the Cyprus register of companies (DRCOR) from data.gov.cy (LEXAI-2301).

Source: data.gov.cy dataset 1026 «Μητρώο Εγγεγραμμένων Εταιρειών, Εμπορικών Επωνυμιών και
Συνεταιρισμών στην Κύπρο», Department of Registrar of Companies and Intellectual Property,
CC BY 4.0, updated monthly. Three CSV resources (UTF-8 with BOM, CRLF):

  resource                 file (name changes every update)   table
  organisations            organisations_<n>.csv               cy_companies
  registered_office        registered_office_<n>.csv           cy_registered_offices
  organisation_officials   organisation_officials_<n>.csv      cy_officials

The current file URLs are read from the dataset's DCAT-AP record (falling back to the dataset page).
Officials are published with name and position only; shareholders are not published.

The export does not quote fields, so a name that contains a line break splits a record: the first
line holds the name padded with empty fields, the next line holds the rest, sometimes without the
registration number. The parser joins such pieces; a record that still has no registration number
or a valid organisation type is rejected and counted (rows_rejected in the journal).

All files of a run are loaded in one transaction: each is staged with COPY, upserted (a row is
rewritten only when its content changed), rows absent from the new file are deleted, and the file
is journalled in cy_drcor_snapshots with its sha256, snapshot date (Last-Modified) and source URL.
A file whose sha256 is already journalled is skipped. A file with fewer than MIN_ROWS rows, or with
fewer than CY_DRCOR_MIN_RATIO (default 0.9) of the rows the table holds, aborts the transaction.

Usage:
  load_drcor.py                         # discover, download and load the three files
  load_drcor.py --dir DIR [--snapshot-date 2026-11-02] [--source-url-base URL]
                                        # load local files (picked by name prefix)
  load_drcor.py --dry-run               # download and parse only, print counts
  load_drcor.py --force                 # reload files already journalled

Database access goes through the psql client, so the script needs only the Python standard library:
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import email.utils
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Iterable, Iterator

USER_AGENT = "SecondLayer-opendata-sync/1.0 (DRCOR loader)"
HTTP_TIMEOUT = int(os.environ.get("CY_DRCOR_HTTP_TIMEOUT", "600"))
MIN_RATIO = float(os.environ.get("CY_DRCOR_MIN_RATIO", "0.9"))

DATASET_PAGE = "https://www.data.gov.cy/en/dataset/1026"
DCAT_URL = DATASET_PAGE + "/dcat-ap-2.0/json"
FILES_BASE = "https://www.data.gov.cy/sites/default/files/"

TYPE_CODES = {"C", "O", "B", "P", "N"}
# Latin prefixes of DRCOR registration numbers, as quoted in ЄДР and in company documents.
REG_PREFIX = {"C": "HE", "O": "AE"}

# November 2026: 575,754 organisations, 209,956 addresses, 1,188,285 officials.
MIN_ROWS = {"organisations": 400_000, "registered_office": 150_000, "organisation_officials": 800_000}
MIN_ROWS_SCALE = float(os.environ.get("CY_DRCOR_MIN_ROWS_SCALE", "1"))


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── Resources ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Resource:
    name: str
    prefix: str        # file name prefix: organisations_103.csv -> "organisations_"
    table: str
    width: int         # columns in the CSV
    header: tuple
    columns: tuple     # stage columns, in COPY order
    key: tuple
    data_columns: tuple  # columns compared to decide whether a row changed


ORG = Resource(
    "organisations", "organisations_", "cy_companies", 11,
    ("ORGANISATION_NAME", "REGISTRATION_NO", "ORGANISATION_TYPE_CODE", "ORGANISATION_TYPE",
     "ORGANISATION_SUB_TYPE", "NAME_STATUS_CODE", "NAME_STATUS", "REGISTRATION_DATE",
     "ORGANISATION_STATUS", "ORGANISATION_STATUS_DATE", "ADDRESS_SEQ_NO"),
    ("org_type_code", "registration_no", "registration_code", "name", "org_type", "org_sub_type",
     "name_status_code", "name_status", "registration_date", "status", "status_date", "address_seq_no"),
    ("org_type_code", "registration_no"),
    ("registration_code", "name", "org_type", "org_sub_type", "name_status_code", "name_status",
     "registration_date", "status", "status_date", "address_seq_no"),
)
OFFICE = Resource(
    "registered_office", "registered_office_", "cy_registered_offices", 4,
    ("ADDRESS_SEQ_NO", "STREET", "BUILDING", "TERRITORY"),
    ("address_seq_no", "street", "building", "territory"),
    ("address_seq_no",),
    ("street", "building", "territory"),
)
OFFICIAL = Resource(
    "organisation_officials", "organisation_officials_", "cy_officials", 6,
    ("ORGANISATION_NAME", "REGISTRATION_NO", "ORGANISATION_TYPE_CODE", "ORGANISATION_TYPE",
     "PERSON_OR_ORGANISATION_NAME", "OFFICIAL_POSITION"),
    ("org_type_code", "registration_no", "person_name", "position", "organisation_name"),
    ("org_type_code", "registration_no", "person_name", "position"),
    ("organisation_name", "occurrences"),
)
RESOURCES = (OFFICE, ORG, OFFICIAL)  # load order


# ─── Parsing ──────────────────────────────────────────────────────────────


@dataclass
class Stats:
    parsed: int = 0
    rejected: int = 0
    repaired: int = 0
    duplicates: int = 0
    reasons: dict = field(default_factory=dict)

    def reject(self, why: str) -> None:
        self.rejected += 1
        self.reasons[why] = self.reasons.get(why, 0) + 1


def clean(s: str | None) -> str | None:
    if s is None:
        return None
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def parse_dmy(s: str | None) -> str | None:
    """dd/mm/yyyy -> ISO date; anything else (including year 5594) -> None."""
    m = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*", s or "")
    if not m:
        return None
    d, mo, y = int(m[1]), int(m[2]), int(m[3])
    if not 1800 <= y <= 2100:
        return None
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def parse_int(s: str | None) -> int | None:
    s = (s or "").strip()
    return int(s) if s.isdigit() else None


def registration_code(type_code: str, reg_no: str) -> str | None:
    p = REG_PREFIX.get(type_code)
    return f"{p}{reg_no}" if p else None


def repaired_rows(lines: Iterable[str], width: int, stats: Stats,
                  type_idx: int | None = 2) -> Iterator[list[str]]:
    """CSV records split by line breaks inside unquoted fields, joined back.

    The export pads every physical line to the column count, so a piece of a broken record shows
    up as a line whose first field is set and the rest empty (a fragment):
      * head of a record (line break inside the name): the next non-blank line starts with the
        type code (registration number lost, "" is put in its place) or with a number followed by
        the type code (only the name was split); the fragment becomes the name;
      * tail of a record (line break before the last field, e.g. the official's position): the
        previous record has an empty last field and the next line is a complete record; the
        fragment becomes that last field.
    Anything else is rejected and counted.
    """
    reader = csv.reader(lines)
    if next(reader, None) is None:
        return
    pending: str | None = None
    held: list[str] | None = None   # last record, kept back so a tail fragment can complete it

    def fit(row: list[str], why: str) -> list[str] | None:
        if len(row) > width:
            if any(c.strip() for c in row[width:]):
                stats.reject(why)
                return None
            row = row[:width]
        return row

    for row in reader:
        if len(row) < width:
            row = row + [""] * (width - len(row))
        if not any(c.strip() for c in row):
            continue
        if type_idx is not None and row[0].strip() and not any(c.strip() for c in row[1:]):
            if pending is not None:
                stats.reject("orphan name fragment")
            pending = row[0]
            continue
        if pending is not None:
            first, second = row[0].strip(), row[1].strip()
            if first in TYPE_CODES:
                row = [pending, ""] + row
            elif first.isdigit() and second in TYPE_CODES:
                row = [pending] + row
            elif held is not None and not held[-1].strip():
                held[-1] = pending
                stats.repaired += 1
                pending = None
            else:
                stats.reject("orphan name fragment")
                pending = None
            if pending is not None:
                pending = None
                stats.repaired += 1
                fitted = fit(row, "too many fields after repair")
                if fitted is None:
                    continue
                row = fitted
        fitted = fit(row, "too many fields")
        if fitted is None:
            continue
        if held is not None:
            yield held
        held = fitted
    if pending is not None:
        if held is not None and not held[-1].strip():
            held[-1] = pending
            stats.repaired += 1
        else:
            stats.reject("orphan name fragment")
    if held is not None:
        yield held


def check_header(lines: Iterator[str], res: Resource) -> Iterator[str]:
    """Pass lines through after checking the header names the expected columns."""
    first = next(lines, "")
    got = tuple(c.strip() for c in next(csv.reader([first.lstrip("\ufeff")]), []))
    if got != res.header:
        raise RuntimeError(f"{res.name}: unexpected header {got}, expected {res.header}")

    def gen() -> Iterator[str]:
        yield first.lstrip("\ufeff")
        yield from lines
    return gen()


def parse_organisations(lines: Iterable[str], stats: Stats) -> Iterator[dict]:
    seen: set = set()
    for r in repaired_rows(check_header(iter(lines), ORG), ORG.width, stats):
        name, reg, tcode = clean(r[0]), (r[1] or "").strip(), (r[2] or "").strip()
        if tcode not in TYPE_CODES:
            stats.reject("bad organisation type")
            continue
        if not reg.isdigit():
            stats.reject("no registration number")
            continue
        if not name:
            stats.reject("no name")
            continue
        k = (tcode, reg)
        if k in seen:
            stats.duplicates += 1
            continue
        seen.add(k)
        stats.parsed += 1
        yield {
            "org_type_code": tcode, "registration_no": reg,
            "registration_code": registration_code(tcode, reg),
            "name": name, "org_type": clean(r[3]), "org_sub_type": clean(r[4]),
            "name_status_code": clean(r[5]), "name_status": clean(r[6]),
            "registration_date": parse_dmy(r[7]), "status": clean(r[8]),
            "status_date": parse_dmy(r[9]), "address_seq_no": parse_int(r[10]),
        }


def clean_address(s: str | None) -> str | None:
    s = clean(s)
    return clean(s.rstrip(" ,")) if s else None


def parse_offices(lines: Iterable[str], stats: Stats) -> Iterator[dict]:
    """A line break typed into TERRITORY ends the quoted field early; the rest of the territory
    arrives as a line that does not start with an address number. It is appended to the previous
    record's territory."""
    seen: set = set()
    prev: dict | None = None
    for r in repaired_rows(check_header(iter(lines), OFFICE), OFFICE.width, stats, type_idx=None):
        seq = parse_int(r[0])
        if seq is None:
            parts = [clean(c.replace('"', " ")) for c in r]
            tail = ", ".join(p for p in parts if p)
            if prev is not None and tail:
                prev["territory"] = clean_address(", ".join(x for x in (prev["territory"], tail) if x))
                stats.repaired += 1
            else:
                stats.reject("no address number")
            continue
        if seq in seen:
            stats.duplicates += 1
            continue
        seen.add(seq)
        if prev is not None:
            yield prev
        stats.parsed += 1
        prev = {"address_seq_no": seq, "street": clean_address(r[1]),
                "building": clean_address(r[2]), "territory": clean_address(r[3])}
    if prev is not None:
        yield prev


def parse_officials(lines: Iterable[str], stats: Stats) -> Iterator[dict]:
    for r in repaired_rows(check_header(iter(lines), OFFICIAL), OFFICIAL.width, stats):
        reg, tcode, person = (r[1] or "").strip(), (r[2] or "").strip(), clean(r[4])
        if tcode not in TYPE_CODES:
            stats.reject("bad organisation type")
            continue
        if not reg.isdigit():
            stats.reject("no registration number")
            continue
        if not person:
            stats.reject("no person name")
            continue
        stats.parsed += 1
        yield {"org_type_code": tcode, "registration_no": reg, "person_name": person,
               "position": clean(r[5]) or "", "organisation_name": clean(r[0])}


PARSERS = {"organisations": parse_organisations, "registered_office": parse_offices,
           "organisation_officials": parse_officials}


# ─── Discovery and download ───────────────────────────────────────────────


def http_open(url: str, accept: str = "*/*"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    last: Exception | None = None
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=HTTP_TIMEOUT)
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def urls_from_dcat(record: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for d in record.get("dcat:Distribution", []):
        url = (d.get("dcat:downloadURL") or {}).get("@rdf:resource") or ""
        fname = url.rsplit("/", 1)[-1]
        for res in RESOURCES:
            if re.fullmatch(re.escape(res.prefix) + r"\d+\.csv", fname):
                out[res.name] = url
    return out


def urls_from_page(page: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for res in RESOURCES:
        m = re.search(r'/sites/default/files/(' + re.escape(res.prefix) + r'\d+\.csv)', page)
        if m:
            out[res.name] = FILES_BASE + m[1]
    return out


def discover() -> dict[str, str]:
    try:
        with http_open(DCAT_URL, "application/json") as r:
            urls = urls_from_dcat(json.loads(r.read()))
    except Exception as e:  # noqa: BLE001 - fall back to the dataset page
        log(f"DCAT record unavailable ({e}); reading the dataset page")
        urls = {}
    if len(urls) < len(RESOURCES):
        with http_open(DATASET_PAGE, "text/html") as r:
            urls = {**urls_from_page(r.read().decode("utf-8", "replace")), **urls}
    missing = [r.name for r in RESOURCES if r.name not in urls]
    if missing:
        raise RuntimeError(f"data.gov.cy dataset 1026 lists no file for: {', '.join(missing)}")
    return urls


@dataclass
class File:
    resource: Resource
    path: str
    source_url: str
    sha256: str
    size: int
    snapshot_date: str | None


def download(res: Resource, url: str, tmpdir: str) -> File:
    path = os.path.join(tmpdir, url.rsplit("/", 1)[-1])
    h = hashlib.sha256()
    size = 0
    with http_open(url, "text/csv") as r, open(path, "wb") as f:
        lm = r.headers.get("Last-Modified")
        expected = r.headers.get("Content-Length")
        while chunk := r.read(1 << 20):
            h.update(chunk)
            f.write(chunk)
            size += len(chunk)
    if expected and int(expected) != size:
        raise RuntimeError(f"{res.name}: got {size} bytes, Content-Length {expected}")
    snap = email.utils.parsedate_to_datetime(lm).date().isoformat() if lm else None
    return File(res, path, url, h.hexdigest(), size, snap)


def local_file(res: Resource, directory: str, snapshot_date: str | None,
               url_base: str | None) -> File:
    names = sorted(n for n in os.listdir(directory)
                   if re.fullmatch(re.escape(res.prefix) + r"\d+\.csv", n))
    if not names:
        raise RuntimeError(f"{res.name}: no {res.prefix}<n>.csv in {directory}")
    name = names[-1]
    path = os.path.join(directory, name)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    snap = snapshot_date or dt.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    url = (url_base.rstrip("/") + "/" + name) if url_base else FILES_BASE + name
    return File(res, path, url, h.hexdigest(), os.path.getsize(path), snap)


def open_lines(path: str) -> io.TextIOWrapper:
    return open(path, encoding="utf-8-sig", newline="")


# ─── Database (psql) ──────────────────────────────────────────────────────


def psql_cmd() -> list[str]:
    base = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    url = os.environ.get("DATABASE_URL")
    if url:
        return ["psql", url, *base]
    return ["docker", "exec", "-i", os.environ.get("PG_CONTAINER", "secondlayer-postgres-local"),
            "psql", "-U", os.environ.get("PGUSER", "secondlayer"),
            "-d", os.environ.get("PGDATABASE", "secondlayer_local"), *base]


def psql(sql: str) -> str:
    r = subprocess.run(psql_cmd(), input=sql, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[-2000:]}")
    return r.stdout


def lit(s: str | int | None) -> str:
    if s is None:
        return "NULL"
    if isinstance(s, int):
        return str(s)
    return "'" + s.replace("'", "''") + "'"


def copy_value(v) -> str:
    if v is None:
        return r"\N"
    return str(v).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def copy_line(res: Resource, row: dict) -> str:
    return "\t".join(copy_value(row.get(c)) for c in res.columns) + "\n"


def stage_sql(res: Resource) -> str:
    stage = f"stage_{res.table}"
    types = {"address_seq_no": "BIGINT", "registration_date": "DATE", "status_date": "DATE"}
    cols = ", ".join(f"{c} {types.get(c, 'TEXT')}" for c in res.columns)
    return (f"CREATE TEMP TABLE {stage} ({cols}) ON COMMIT DROP;\n"
            f"COPY {stage} ({', '.join(res.columns)}) FROM STDIN WITH (FORMAT text, NULL '\\N');\n")


def merge_sql(f: File, stats: Stats) -> str:
    res = f.resource
    stage = f"stage_{res.table}"
    key = ", ".join(res.key)
    if res is OFFICIAL:
        src = (f"SELECT {key}, max(organisation_name) AS organisation_name, count(*)::int AS occurrences "
               f"FROM {stage} GROUP BY {key}")
    else:
        src = f"SELECT * FROM {stage}"
    data = res.data_columns
    cols = list(res.key) + list(data)
    col_list = ", ".join(cols)
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in data)
    changed = " OR ".join(f"t.{c} IS DISTINCT FROM EXCLUDED.{c}" for c in data)
    join = " AND ".join(f"s.{k} = t.{k}" for k in res.key)
    meta = f"{lit(f.snapshot_date)}::date, {lit(f.source_url)}"
    return f"""
DO $$
DECLARE staged bigint; held bigint;
BEGIN
  SELECT count(*) INTO staged FROM {stage};
  SELECT count(*) INTO held FROM {res.table};
  IF held > 0 AND staged < held * {MIN_RATIO} THEN
    RAISE EXCEPTION '{res.name}: snapshot has % rows, table holds % (min ratio {MIN_RATIO}), not loaded',
      staged, held;
  END IF;
END $$;
WITH src AS ({src}),
up AS (
  INSERT INTO {res.table} AS t ({col_list}, snapshot_date, source_url)
  SELECT {col_list}, {meta} FROM src
  ON CONFLICT ({key}) DO UPDATE SET {sets}, snapshot_date = EXCLUDED.snapshot_date,
    source_url = EXCLUDED.source_url, updated_at = NOW()
  WHERE {changed}
  RETURNING 1
), del AS (
  DELETE FROM {res.table} t
   WHERE NOT EXISTS (SELECT 1 FROM {stage} s WHERE {join})
  RETURNING 1
), j AS (
  INSERT INTO cy_drcor_snapshots
    (resource, file_sha256, snapshot_date, source_url, file_size, rows_parsed, rows_rejected,
     rows_upserted, rows_removed)
  SELECT {lit(res.name)}, {lit(f.sha256)}, {meta}, {f.size}, {stats.parsed}, {stats.rejected},
         (SELECT count(*) FROM up), (SELECT count(*) FROM del)
  ON CONFLICT (resource, file_sha256) DO UPDATE SET
    rows_upserted = EXCLUDED.rows_upserted, rows_removed = EXCLUDED.rows_removed, loaded_at = NOW()
  RETURNING rows_upserted, rows_removed
)
SELECT 'RESULT|{res.name}|' || rows_upserted || '|' || rows_removed FROM j;
"""


def check_stats(res: Resource, stats: Stats) -> None:
    floor = int(MIN_ROWS[res.name] * MIN_ROWS_SCALE)
    if stats.parsed < floor:
        raise RuntimeError(f"{res.name}: only {stats.parsed} rows parsed (minimum {floor}), not loaded")
    if stats.parsed and stats.rejected > max(100, stats.parsed // 1000):
        raise RuntimeError(f"{res.name}: {stats.rejected} rows rejected of {stats.parsed}: {stats.reasons}")


def already_loaded(res: Resource, sha256: str) -> bool:
    out = psql(f"SELECT 1 FROM cy_drcor_snapshots WHERE resource = {lit(res.name)} "
               f"AND file_sha256 = {lit(sha256)};")
    return out.strip() == "1"


def load(files: list[File]) -> None:
    """Stream all files into one psql session and transaction."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(psql_cmd(), stdin=subprocess.PIPE, stdout=out, stderr=err)
        assert p.stdin is not None
        w = io.TextIOWrapper(p.stdin, encoding="utf-8", newline="\n", write_through=False)
        aborted: Exception | None = None
        try:
            w.write("BEGIN;\n")
            for f in files:
                stats = Stats()
                w.write(stage_sql(f.resource))
                with open_lines(f.path) as fh:
                    for row in PARSERS[f.resource.name](fh, stats):
                        w.write(copy_line(f.resource, row))
                w.write("\\.\n")
                log(f"{f.resource.name}: {stats.parsed} rows staged, {stats.rejected} rejected "
                    f"({stats.reasons or '-'}), {stats.repaired} repaired, {stats.duplicates} duplicates")
                try:
                    check_stats(f.resource, stats)
                except RuntimeError as e:
                    aborted = e
                    w.write("ROLLBACK;\n")
                    break
                w.write(merge_sql(f, stats))
            else:
                w.write("COMMIT;\n")
            w.close()
        except BrokenPipeError:
            pass
        rc = p.wait()
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")
    if aborted:
        raise aborted
    if rc != 0:
        raise RuntimeError(f"psql failed: {stderr.strip()[-2000:]}")
    for m in re.finditer(r"RESULT\|(\w+)\|(\d+)\|(\d+)", stdout):
        log(f"{m[1]}: {m[2]} rows inserted or changed, {m[3]} removed")


# ─── Main ─────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", help="load local files from this directory instead of downloading")
    ap.add_argument("--snapshot-date", help="--dir: snapshot date (default: file mtime)")
    ap.add_argument("--source-url-base", help="--dir: base URL stored as source_url")
    ap.add_argument("--dry-run", action="store_true", help="download and parse only")
    ap.add_argument("--force", action="store_true", help="reload files already journalled")
    a = ap.parse_args(argv)

    t0 = time.time()
    tmpdir = None
    try:
        if a.dir:
            files = [local_file(r, a.dir, a.snapshot_date, a.source_url_base) for r in RESOURCES]
        else:
            urls = discover()
            tmpdir = tempfile.mkdtemp(prefix="drcor-", dir=os.environ.get("CY_DRCOR_TMPDIR"))
            files = []
            for r in RESOURCES:
                log(f"{r.name}: downloading {urls[r.name]}")
                files.append(download(r, urls[r.name], tmpdir))
        for f in files:
            log(f"{f.resource.name}: {f.size // 1024} KB, snapshot {f.snapshot_date}, sha256 {f.sha256[:12]}")

        if a.dry_run:
            for f in files:
                stats = Stats()
                with open_lines(f.path) as fh:
                    for _ in PARSERS[f.resource.name](fh, stats):
                        pass
                log(f"{f.resource.name}: {stats.parsed} rows, {stats.rejected} rejected "
                    f"({stats.reasons or '-'}), {stats.repaired} repaired, {stats.duplicates} duplicates")
                check_stats(f.resource, stats)
            return 0

        todo = [f for f in files if a.force or not already_loaded(f.resource, f.sha256)]
        for f in files:
            if f not in todo:
                log(f"{f.resource.name}: this file is already loaded, skipping (use --force to reload)")
        if todo:
            load(todo)
        log(f"done ({time.time() - t0:.0f}s)")
        return 0
    except Exception as e:  # noqa: BLE001 - reported, non-zero exit
        log(f"ERROR: {e}")
        return 1
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
