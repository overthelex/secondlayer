#!/usr/bin/env python3
"""
Load the ICIJ Offshore Leaks Database (bulk CSV archive) into icij_nodes / icij_relationships
(LEXAI-2300, migration 287).

  archive  https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip
  members  nodes-entities.csv, nodes-officers.csv, nodes-intermediaries.csv, nodes-addresses.csv,
           nodes-others.csv, relationships.csv, GENERATED_ON_YYYYMMDD.txt

Licence: the database is under the Open Database License 1.0 and its contents under CC BY-SA 3.0;
ICIJ must be cited. ICIJ's disclaimer: there are legitimate uses for offshore companies and trusts,
and inclusion in the database does not suggest or imply illegal or improper conduct.

ICIJ republishes the archive rarely. A run first asks the server for the ETag and size: if an
archive with the same ETag and size is journalled in icij_snapshots, nothing is downloaded. A
downloaded archive whose sha256 is journalled is skipped too.

A load is one transaction: every row is streamed with COPY into temporary stage tables, checked
(no duplicate (node_id, node_type); no fewer than ICIJ_MIN_RATIO (default 0.8) of the rows the
tables hold), then icij_nodes and icij_relationships are truncated and refilled from the stage, and
the archive is journalled with its source URL, sha256, ETag and generation date. The tables are
locked from the TRUNCATE to the COMMIT (a few minutes).

Usage:
  load_icij.py                        # check the LATEST archive, load it if it is new
  load_icij.py --file full-oldb.zip [--source-url URL] [--force]
  load_icij.py --dry-run [--file ...] # parse only, print row counts

Database access goes through the psql client, so the script needs only the Python standard library:
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
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
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
import zipfile
from typing import IO, Iterable, Iterator

USER_AGENT = "SecondLayer-opendata-sync/1.0 (ICIJ Offshore Leaks loader)"
LATEST_URL = "https://offshoreleaks-data.icij.org/offshoreleaks/csv/full-oldb.LATEST.zip"
HTTP_TIMEOUT = int(os.environ.get("ICIJ_HTTP_TIMEOUT", "600"))
MIN_RATIO = float(os.environ.get("ICIJ_MIN_RATIO", "0.8"))

NODE_FILES = {
    "nodes-entities.csv": "entity",
    "nodes-officers.csv": "officer",
    "nodes-intermediaries.csv": "intermediary",
    "nodes-addresses.csv": "address",
    "nodes-others.csv": "other",
}
REL_FILE = "relationships.csv"

NODE_COLUMNS = [
    "node_id", "node_type", "name", "name_key", "original_name", "former_name", "jurisdiction",
    "jurisdiction_description", "country_codes", "countries", "company_type", "status",
    "service_provider", "incorporation_date", "inactivation_date", "struck_off_date", "address",
    "source_id", "source_leak", "valid_until", "note", "extra",
]
REL_COLUMNS = [
    "node_id_start", "node_id_end", "rel_type", "link", "status", "start_date", "end_date",
    "source_id", "source_leak", "metadata_json",
]

# CSV columns copied as they are into a node column of the same name.
NODE_TEXT = {"name", "original_name", "former_name", "jurisdiction", "jurisdiction_description",
             "status", "service_provider", "address", "company_type", "valid_until", "note"}
NODE_DATES = ("incorporation_date", "inactivation_date", "struck_off_date")
NODE_LISTS = {"country_codes", "countries"}
# CSV column -> node column, where the names differ.
NODE_RENAMES = {"sourceID": "source_id", "type": "company_type"}

LEAKS = ("Panama Papers", "Paradise Papers", "Pandora Papers", "Offshore Leaks", "Bahamas Leaks")
MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── Field normalisation ──────────────────────────────────────────────────


def clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


def name_key(s: str | None) -> str | None:
    """Match key: NFKD, diacritics dropped, case-folded, every run of non-alphanumerics -> one space."""
    if not s:
        return None
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).casefold()
    s = re.sub(r"[\W_]+", " ", s).strip()
    return s or None


def split_list(v: str | None) -> list[str]:
    return [p.strip() for p in (v or "").split(";") if p.strip()]


def source_leak(source_id: str | None) -> str | None:
    """'Paradise Papers - Malta corporate registry' -> 'Paradise Papers'."""
    if not source_id:
        return None
    for leak in LEAKS:
        if source_id.lower().startswith(leak.lower()):
            return leak
    return source_id.split(" - ", 1)[0].strip() or None


def _year(y: str) -> int:
    n = int(y)
    if len(y) == 2:
        return 2000 + n if n <= dt.date.today().year % 100 else 1900 + n
    return n


def _iso(y: int, m: int, d: int) -> str | None:
    try:
        return dt.date(y, m, d).isoformat() if 1800 <= y <= 2100 else None
    except ValueError:
        return None


def parse_date(s: str | None) -> str | None:
    """ICIJ dates in the forms the archive uses; None when unparseable.

    23-MAR-2006 / 23-Mar-2006 (most), 2006-03-23, Mar 23, 2006, 23.03.2006 and the Bahamas Leaks
    23/03/2006 or 23/3/06. Slash dates are day-first (360 of the 2026 archive's unambiguous ones
    are, 7 are not); a slash date whose second part exceeds 12 is read month-first.
    """
    s = (s or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", s)
    if m and m[2].lower() in MONTHS:
        return _iso(int(m[3]), MONTHS[m[2].lower()], int(m[1]))
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return _iso(int(m[1]), int(m[2]), int(m[3]))
    m = re.fullmatch(r"([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})", s)
    if m and m[1].lower() in MONTHS:
        return _iso(int(m[3]), MONTHS[m[1].lower()], int(m[2]))
    m = re.fullmatch(r"(\d{1,2})([./])(\d{1,2})\2(\d{2}|\d{4})", s)
    if m:
        a, b, y = int(m[1]), int(m[3]), _year(m[4])
        if m[2] == "/" and b > 12 >= a:
            a, b = b, a
        return _iso(y, b, a)
    return None


# ─── Rows ─────────────────────────────────────────────────────────────────


def node_row(rec: dict, node_type: str) -> dict:
    row: dict = {"node_type": node_type}
    extra: dict = {}
    for col, raw in rec.items():
        if col is None:  # surplus fields on a malformed line
            extra["_surplus"] = raw
            continue
        v = clean(raw)
        target = NODE_RENAMES.get(col, col)
        if target == "node_id":
            row["node_id"] = v
        elif target in NODE_TEXT or target == "source_id":
            row[target] = v
        elif target in NODE_LISTS:
            row[target] = split_list(v)
        elif target in NODE_DATES:
            row[target] = parse_date(v)
            if v and row[target] is None:
                extra[f"{target}_raw"] = v
        elif v is not None:
            extra[col] = v
    row["source_leak"] = source_leak(row.get("source_id"))
    row["name_key"] = name_key(row.get("name") or (row.get("address") if node_type == "address" else None))
    row["extra"] = extra or None
    return row


def rel_row(rec: dict) -> dict:
    meta: dict = {}
    row = {
        "node_id_start": clean(rec.get("node_id_start")),
        "node_id_end": clean(rec.get("node_id_end")),
        "rel_type": clean(rec.get("rel_type")),
        "link": clean(rec.get("link")),
        "status": clean(rec.get("status")),
        "source_id": clean(rec.get("sourceID")),
    }
    for k in ("start_date", "end_date"):
        v = clean(rec.get(k))
        row[k] = parse_date(v)
        if v and row[k] is None:
            meta[f"{k}_raw"] = v
    for col, raw in rec.items():
        if col is not None and col not in row and col not in ("sourceID", "start_date", "end_date") and clean(raw):
            meta[col] = clean(raw)
    row["source_leak"] = source_leak(row["source_id"])
    row["metadata_json"] = meta or None
    return row


# ─── COPY text format ─────────────────────────────────────────────────────


def pg_array(values: list) -> str:
    return "{" + ",".join('"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"' for v in values) + "}"


def copy_value(v) -> str:
    if v is None or v == []:
        return r"\N"
    if isinstance(v, dict):
        s = json.dumps(v, ensure_ascii=False)
    elif isinstance(v, list):
        s = pg_array(v)
    else:
        s = str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def copy_line(row: dict, columns: list[str]) -> str:
    return "\t".join(copy_value(row.get(c)) for c in columns) + "\n"


# ─── Archive ──────────────────────────────────────────────────────────────


class Archive:
    """The bulk ZIP; members are read in place, without extracting."""

    def __init__(self, path: str):
        self.zf = zipfile.ZipFile(path)
        self.members = {os.path.basename(n): n for n in self.zf.namelist() if not n.endswith("/")}
        missing = [f for f in [*NODE_FILES, REL_FILE] if f not in self.members]
        if missing:
            raise RuntimeError(f"archive lacks {', '.join(missing)}")
        self.generated_on = None
        for base in self.members:
            m = re.fullmatch(r"GENERATED_ON_(\d{4})(\d{2})(\d{2})\.txt", base)
            if m:
                self.generated_on = _iso(int(m[1]), int(m[2]), int(m[3]))

    def records(self, member: str) -> Iterator[dict]:
        csv.field_size_limit(sys.maxsize)
        with self.zf.open(self.members[member]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
            yield from csv.DictReader(text)

    def nodes(self, counts: dict) -> Iterator[dict]:
        for member, node_type in NODE_FILES.items():
            n = 0
            for rec in self.records(member):
                row = node_row(rec, node_type)
                if not row.get("node_id"):
                    counts["skipped"] = counts.get("skipped", 0) + 1
                    continue
                n += 1
                yield row
            counts[member] = n

    def relationships(self, counts: dict) -> Iterator[dict]:
        n = 0
        for rec in self.records(REL_FILE):
            row = rel_row(rec)
            if not row["node_id_start"] or not row["node_id_end"]:
                counts["skipped"] = counts.get("skipped", 0) + 1
                continue
            n += 1
            yield row
        counts[REL_FILE] = n


def check_counts(counts: dict) -> None:
    empty = [f for f in [*NODE_FILES, REL_FILE] if not counts.get(f)]
    if empty:
        raise RuntimeError(f"no rows parsed from {', '.join(empty)}")


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


def lit(s) -> str:
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def journalled(sha256: str | None = None, etag: str | None = None, size: int | None = None) -> bool:
    if sha256:
        where = f"file_sha256 = {lit(sha256)}"
    elif etag and size:
        where = f"etag = {lit(etag)} AND file_size = {int(size)}"
    else:
        return False
    return psql(f"SELECT 1 FROM icij_snapshots WHERE {where} LIMIT 1;").strip() == "1"


NODE_COLS_SQL = ", ".join(NODE_COLUMNS)
REL_COLS_SQL = ", ".join(REL_COLUMNS)


def sql_head() -> str:
    return f"""
SET statement_timeout = '3h';
SET lock_timeout = '10min';
BEGIN;
CREATE TEMP TABLE icij_stage_nodes (LIKE icij_nodes INCLUDING DEFAULTS) ON COMMIT DROP;
CREATE TEMP TABLE icij_stage_rels (
  node_id_start text, node_id_end text, rel_type text, link text, status text,
  start_date date, end_date date, source_id text, source_leak text, metadata_json jsonb
) ON COMMIT DROP;
"""


def sql_copy(table: str, cols: str) -> str:
    return f"COPY {table} ({cols}) FROM STDIN WITH (FORMAT text, NULL '\\N');\n"


def sql_tail(source_url: str, sha256: str, etag: str | None, last_modified: str | None, size: int,
             generated_on: str | None, counts: dict) -> str:
    return f"""
DO $$
DECLARE staged_n bigint; staged_r bigint; held_n bigint; held_r bigint; dup bigint;
BEGIN
  SELECT count(*) INTO staged_n FROM icij_stage_nodes;
  SELECT count(*) INTO staged_r FROM icij_stage_rels;
  SELECT count(*) INTO held_n FROM icij_nodes;
  SELECT count(*) INTO held_r FROM icij_relationships;
  SELECT count(*) INTO dup FROM (SELECT 1 FROM icij_stage_nodes GROUP BY node_id, node_type HAVING count(*) > 1) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'ICIJ: % duplicate (node_id, node_type) keys in the archive, not loaded', dup;
  END IF;
  IF (held_n > 0 AND staged_n < held_n * {MIN_RATIO}) OR (held_r > 0 AND staged_r < held_r * {MIN_RATIO}) THEN
    RAISE EXCEPTION 'ICIJ: archive has % nodes / % edges, tables hold % / % (min ratio {MIN_RATIO}), not loaded',
      staged_n, staged_r, held_n, held_r;
  END IF;
END $$;
INSERT INTO icij_snapshots (file_sha256, source_url, etag, last_modified, file_size, generated_on, rows_parsed)
VALUES ({lit(sha256)}, {lit(source_url)}, {lit(etag)}, {lit(last_modified)}, {int(size)},
        {lit(generated_on)}::date, {lit(json.dumps(counts))}::jsonb)
ON CONFLICT (file_sha256) DO UPDATE SET loaded_at = NOW(), etag = EXCLUDED.etag,
  last_modified = EXCLUDED.last_modified, rows_parsed = EXCLUDED.rows_parsed;
TRUNCATE icij_relationships RESTART IDENTITY;
TRUNCATE icij_nodes;
INSERT INTO icij_nodes ({NODE_COLS_SQL}, snapshot_id)
SELECT {NODE_COLS_SQL}, (SELECT id FROM icij_snapshots WHERE file_sha256 = {lit(sha256)}) FROM icij_stage_nodes;
INSERT INTO icij_relationships ({REL_COLS_SQL}, snapshot_id)
SELECT {REL_COLS_SQL}, (SELECT id FROM icij_snapshots WHERE file_sha256 = {lit(sha256)}) FROM icij_stage_rels;
UPDATE icij_snapshots SET nodes_loaded = (SELECT count(*) FROM icij_nodes),
  relationships_loaded = (SELECT count(*) FROM icij_relationships)
WHERE file_sha256 = {lit(sha256)}
RETURNING 'RESULT|' || nodes_loaded || '|' || relationships_loaded;
COMMIT;
ANALYZE icij_nodes;
ANALYZE icij_relationships;
"""


def stream_load(archive: Archive, out: IO[str], source_url: str, sha256: str, etag: str | None,
                last_modified: str | None, size: int) -> dict:
    """Write the whole load script to out (psql's stdin); returns the per-file row counts."""
    counts: dict = {}
    out.write(sql_head())
    out.write(sql_copy("icij_stage_nodes", NODE_COLS_SQL))
    for row in archive.nodes(counts):
        out.write(copy_line(row, NODE_COLUMNS))
    out.write("\\.\n")
    out.write(sql_copy("icij_stage_rels", REL_COLS_SQL))
    for row in archive.relationships(counts):
        out.write(copy_line(row, REL_COLUMNS))
    out.write("\\.\n")
    check_counts(counts)  # raising here leaves the transaction uncommitted
    out.write(sql_tail(source_url, sha256, etag, last_modified, size, archive.generated_on, counts))
    return counts


def load(archive: Archive, source_url: str, sha256: str, etag: str | None, last_modified: str | None,
         size: int) -> tuple[dict, str]:
    with tempfile.TemporaryFile("w+", encoding="utf-8") as so, tempfile.TemporaryFile("w+", encoding="utf-8") as se:
        p = subprocess.Popen(psql_cmd(), stdin=subprocess.PIPE, stdout=so, stderr=se, text=True, encoding="utf-8")
        try:
            counts = stream_load(archive, p.stdin, source_url, sha256, etag, last_modified, size)
            p.stdin.close()
        except BaseException:
            p.kill()
            p.wait()
            raise
        rc = p.wait()
        so.seek(0)
        se.seek(0)
        stdout, stderr = so.read(), se.read()
    if rc != 0:
        raise RuntimeError(f"psql failed: {stderr.strip()[-2000:]}")
    return counts, stdout


# ─── Downloads ────────────────────────────────────────────────────────────


def head(url: str) -> tuple[str | None, str | None, int | None]:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            size = r.headers.get("Content-Length")
            return r.headers.get("ETag"), r.headers.get("Last-Modified"), int(size) if size else None
    except Exception as e:  # noqa: BLE001 - the download decides
        log(f"HEAD {url} failed ({e}); downloading")
        return None, None, None


def download(url: str, dest: IO[bytes]) -> tuple[str, int]:
    last: Exception | None = None
    for attempt in range(3):
        try:
            dest.seek(0)
            dest.truncate()
            h = hashlib.sha256()
            n = 0
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                expected = r.headers.get("Content-Length")
                while chunk := r.read(1 << 20):
                    h.update(chunk)
                    dest.write(chunk)
                    n += len(chunk)
            if expected and int(expected) != n:
                raise RuntimeError(f"truncated download: {n} of {expected} bytes")
            dest.flush()
            return h.hexdigest(), n
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


# ─── Main ─────────────────────────────────────────────────────────────────


def run(path: str, source_url: str, sha: str, size: int, etag: str | None, last_modified: str | None,
        dry_run: bool, force: bool) -> None:
    t0 = time.time()
    archive = Archive(path)
    log(f"archive generated on {archive.generated_on}, {size // (1 << 20)} MB, sha256 {sha[:12]}")
    if dry_run:
        counts: dict = {}
        for _ in archive.nodes(counts):
            pass
        for _ in archive.relationships(counts):
            pass
        check_counts(counts)
        log(f"dry run: {json.dumps(counts)} ({time.time() - t0:.0f}s)")
        return
    if not force and journalled(sha256=sha):
        if etag:  # an archive first loaded with --file: remember its ETag so later runs skip the download
            psql(f"UPDATE icij_snapshots SET etag = {lit(etag)}, last_modified = {lit(last_modified)} "
                 f"WHERE file_sha256 = {lit(sha)} AND etag IS DISTINCT FROM {lit(etag)};")
        log("this archive is already loaded, skipping (use --force to reload)")
        return
    counts, out = load(archive, source_url, sha, etag, last_modified, size)
    m = re.search(r"RESULT\|(\d+)\|(\d+)", out)
    nodes, rels = (m[1], m[2]) if m else ("?", "?")
    log(f"loaded {nodes} nodes, {rels} relationships; parsed {json.dumps(counts)} ({time.time() - t0:.0f}s)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=LATEST_URL, help="archive URL (default: the LATEST archive)")
    ap.add_argument("--file", help="load a local archive instead of downloading")
    ap.add_argument("--source-url", help="--file: URL the archive was downloaded from (stored as source_url)")
    ap.add_argument("--dry-run", action="store_true", help="parse only, print row counts")
    ap.add_argument("--force", action="store_true", help="reload an archive already journalled")
    a = ap.parse_args(argv)

    try:
        if a.file:
            run(a.file, a.source_url or f"file:{os.path.basename(a.file)}", file_sha256(a.file),
                os.path.getsize(a.file), None, None, a.dry_run, a.force)
            return 0
        etag, last_modified, size = head(a.url)
        if not a.force and not a.dry_run and journalled(etag=etag, size=size):
            log(f"ICIJ archive unchanged (ETag {etag}, {size} bytes, {last_modified}), skipping")
            return 0
        tmpdir = tempfile.mkdtemp(prefix="icij-")
        try:
            path = os.path.join(tmpdir, "full-oldb.zip")
            log(f"downloading {a.url}")
            with open(path, "wb") as f:
                sha, n = download(a.url, f)
            run(path, a.url, sha, n, etag, last_modified, a.dry_run, a.force)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception as e:  # noqa: BLE001 - reported, non-zero exit
        log(f"ERROR: {e}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
