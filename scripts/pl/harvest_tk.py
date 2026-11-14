#!/usr/bin/env python3
"""Backfill Constitutional Tribunal (TK) rulings from the official collection
OTK ZU (otkzu.trybunal.gov.pl).

SAOS stopped mirroring TK on 2015-12-09. OTK ZU publishes every ruling as a
position in a yearly series: A = decisions on the merits (wyroki, postanowienia),
B = preliminary control. Position pages are plain GETs at /<year>/<series>/<pos>
with the docket, ruling type, date and a PDF (/downloadOTK?mpo=<id>); positions
are numbered 1..N and a missing one answers HTTP 500, so a year is walked until
a few consecutive misses. Text comes out of the PDF with pdftotext -layout.

Rows: id 'otkzu-<year>-<series>-<pos>', source 'otkzu', court_type
'CONSTITUTIONAL_TRIBUNAL' (the SAOS value). A ruling whose (case_number,
decision_date) already exists among TK rows is skipped.

Network: the portal does not answer cthulhu directly; run with HTTPS_PROXY set
to the SOCKS tunnel (socks5h://127.0.0.1:1080). The server hangs on HTTP/1.1
and only answers HTTP/2, which python-requests cannot speak, so fetching goes
through curl (which honours HTTPS_PROXY). PG* env. Resumable via sqlite.
"""
import argparse
import html
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import date, datetime, timezone

import psycopg2
import psycopg2.extras

BASE = "https://otkzu.trybunal.gov.pl"
UA = "lawrider-pl-backfill/1.0 (+https://lawrider.pl)"
log = logging.getLogger("tk")

MONTHS = {"stycznia": 1, "lutego": 2, "marca": 3, "kwietnia": 4, "maja": 5, "czerwca": 6, "lipca": 7,
          "sierpnia": 8, "września": 9, "października": 10, "listopada": 11, "grudnia": 12}


class Limiter:
    def __init__(self, rate):
        self.min_interval = 1.0 / rate if rate > 0 else 0
        self.last = 0.0

    def wait(self):
        d = self.last + self.min_interval - time.time()
        if d > 0:
            time.sleep(d)
        self.last = time.time()


class Resp:
    def __init__(self, status, content):
        self.status_code, self.content = status, content
        self.text = content.decode("utf-8", "replace")


def request(session, limiter, url, retries=8):
    """GET via curl (HTTP/2); returns Resp with any status, raises after retries on transport errors."""
    delay = 10
    for _ in range(retries):
        limiter.wait()
        r = subprocess.run(["curl", "-s", "--max-time", "120", "-A", UA, "-w", "\n%{http_code}", url],
                           capture_output=True, timeout=180)
        body, _, code = r.stdout.rpartition(b"\n")
        if r.returncode == 0 and code.strip().isdigit() and int(code) != 0:
            return Resp(int(code), body)
        log.warning("GET %s failed (curl rc=%s %s); retry in %ss", url, r.returncode, r.stderr[:100], delay)
        time.sleep(delay)
        delay = min(delay * 2, 600)
    raise RuntimeError(f"gave up on {url}")


def to_text(page):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", page, flags=re.S)
    t = re.sub(r"<[^>]+>", "\n", t)
    t = html.unescape(t)
    return [ln.strip() for ln in t.split("\n") if ln.strip()]


def pl_date(s):
    m = re.search(r"(\d{1,2})\s+(\w+)\s+(\d{4})", s or "")
    if not m or m.group(2).lower() not in MONTHS:
        return None
    return date(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1))).isoformat()


def parse_item(page):
    """Label/value pairs come as consecutive lines: 'Sygnatura', 'U 2/26', 'link do IPO', ..."""
    lines = to_text(page)
    out = {}
    labels = {"Sygnatura": "case_number", "Rodzaj orzeczenia": "decision_type", "Data": "decision_date",
              "Data publikacji": "publication_date", "Miejsce publikacji": "publication"}
    for i, ln in enumerate(lines[:-1]):
        if ln in labels and labels[ln] not in out:
            out[labels[ln]] = lines[i + 1]
    m = re.search(r'href="(/downloadOTK\?mpo=(\d+))"', page)
    if m:
        out["pdf"] = BASE + html.unescape(m.group(1))
        out["mpo"] = int(m.group(2))
    m = re.search(r'href="(https?://ipo\.trybunal\.gov\.pl[^"]*)"', page)
    if m:
        out["ipo"] = html.unescape(m.group(1))
    return out


def pdf_text(pdf_bytes, raw_path):
    with open(raw_path, "wb") as f:
        f.write(pdf_bytes)
    r = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", raw_path, "-"], capture_output=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"pdftotext: {r.stderr[:200]!r}")
    t = r.stdout.decode("utf-8", "replace").replace("\f", "\n")
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


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
    ap.add_argument("--from-year", type=int, default=2015)
    ap.add_argument("--to-year", type=int, default=date.today().year)
    ap.add_argument("--series", default="A,B")
    ap.add_argument("--rate", type=float, default=1.0)
    ap.add_argument("--db", default=os.path.expanduser("~/lawrider/tk/queue.sqlite"))
    ap.add_argument("--raw-dir", default=os.path.expanduser("~/lawrider/tk/raw"))
    ap.add_argument("--miss-limit", type=int, default=5, help="consecutive missing positions that end a series/year")
    ap.add_argument("--max-docs", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    os.makedirs(args.raw_dir, exist_ok=True)

    q = sqlite3.connect(args.db)
    q.execute("CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, status TEXT, case_number TEXT, decision_date TEXT, fetched_at TEXT)")
    q.execute("CREATE TABLE IF NOT EXISTS series_done (ys TEXT PRIMARY KEY, last_pos INT, done_at TEXT)")
    q.commit()

    conn = psycopg2.connect("")
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        cur.execute("SELECT id FROM pl_court_decisions WHERE source = 'otkzu'")
        known_ids = {r[0] for r in cur.fetchall()}
        cur.execute("""SELECT case_number, decision_date FROM pl_court_decisions
                       WHERE court_type = 'CONSTITUTIONAL_TRIBUNAL' AND case_number IS NOT NULL""")
        known_cases = {(re.sub(r"\s+", " ", c).strip(), d.isoformat()) for c, d in cur.fetchall() if d}
    conn.commit()
    log.info("known otkzu ids %d, known TK case/date pairs %d", len(known_ids), len(known_cases))

    limiter = Limiter(args.rate)
    session = None
    inserted = skipped_dup = n_docs = 0
    for year in range(args.to_year, args.from_year - 1, -1):
        for series in args.series.split(","):
            ys = f"{year}/{series}"
            if year < date.today().year and q.execute("SELECT 1 FROM series_done WHERE ys=?", (ys,)).fetchone():
                continue
            pos, misses, last_ok = 0, 0, 0
            while misses < args.miss_limit:
                pos += 1
                key = f"otkzu-{year}-{series}-{pos}"
                row = q.execute("SELECT status FROM docs WHERE key=?", (key,)).fetchone()
                if row and row[0] in ("inserted", "dup_saos", "no_pdf") or key in known_ids:
                    misses, last_ok = 0, pos
                    continue
                r = request(session, limiter, f"{BASE}/{year}/{series}/{pos}")
                if r.status_code != 200 or "downloadOTK" not in r.text:
                    misses += 1
                    continue
                misses, last_ok = 0, pos
                item = parse_item(r.text)
                case_number = re.sub(r"\s+", " ", item.get("case_number", "")).strip() or None
                decision_date = pl_date(item.get("decision_date"))
                if case_number and decision_date and (case_number, decision_date) in known_cases:
                    skipped_dup += 1
                    q.execute("INSERT OR REPLACE INTO docs VALUES (?, 'dup_saos', ?, ?, ?)",
                              (key, case_number, decision_date, datetime.now(timezone.utc).isoformat(timespec="seconds")))
                    q.commit()
                    continue
                if "pdf" not in item:
                    log.warning("%s: no pdf link", key)
                    q.execute("INSERT OR REPLACE INTO docs VALUES (?, 'no_pdf', ?, ?, ?)", (key, case_number, decision_date, None))
                    q.commit()
                    continue
                pdf = request(session, limiter, item["pdf"])
                if pdf.status_code != 200 or not pdf.content.startswith(b"%PDF"):
                    log.error("%s: pdf http=%s", key, pdf.status_code)
                    q.execute("INSERT OR REPLACE INTO docs VALUES (?, 'pdf_error', ?, ?, ?)", (key, case_number, decision_date, None))
                    q.commit()
                    continue
                try:
                    text = pdf_text(pdf.content, os.path.join(args.raw_dir, f"{year}_{series}_{pos}.pdf"))
                except Exception as e:  # noqa: BLE001
                    log.error("%s: pdftotext failed: %s", key, e)
                    q.execute("INSERT OR REPLACE INTO docs VALUES (?, 'pdf_error', ?, ?, ?)", (key, case_number, decision_date, None))
                    q.commit()
                    continue
                meta = {
                    "otkzu": {"year": year, "series": series, "position": pos, "mpo": item.get("mpo")},
                    "publication": item.get("publication"),
                    "publication_date": pl_date(item.get("publication_date")),
                    "pdf": item["pdf"],
                    "ipo_url": item.get("ipo"),
                    "harvested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "harvester": "harvest_tk.py",
                }
                db_row = (
                    key, None, "otkzu", "CONSTITUTIONAL_TRIBUNAL", "Trybunał Konstytucyjny", f"OTK ZU {series}/{year}",
                    case_number, item.get("decision_type") or None, decision_date, None, None, None, None, None,
                    None, None, text or None, f"{BASE}/{year}/{series}/{pos}", json.dumps(meta, ensure_ascii=False),
                )
                n_docs += 1
                if args.dry_run:
                    log.info("DRY %s %s %s %s text=%d", key, case_number, item.get("decision_type"), decision_date, len(text))
                else:
                    with conn.cursor() as cur:
                        psycopg2.extras.execute_values(cur, INSERT, [db_row])
                        n = max(cur.rowcount, 0)
                    conn.commit()
                    inserted += n
                    known_ids.add(key)
                    if case_number and decision_date:
                        known_cases.add((case_number, decision_date))
                    q.execute("INSERT OR REPLACE INTO docs VALUES (?, 'inserted', ?, ?, ?)",
                              (key, case_number, decision_date, datetime.now(timezone.utc).isoformat(timespec="seconds")))
                    q.commit()
                    if inserted % 25 == 0:
                        log.info("%s: inserted so far %d, dup-saos %d", key, inserted, skipped_dup)
                if args.max_docs and n_docs >= args.max_docs:
                    log.info("max docs reached"); log.info("FINISHED inserted=%d dup_saos=%d", inserted, skipped_dup); return
            log.info("%s: last position %d; inserted so far %d, dup-saos %d", ys, last_ok, inserted, skipped_dup)
            if not args.dry_run and year < date.today().year:
                q.execute("INSERT OR REPLACE INTO series_done VALUES (?, ?, ?)", (ys, last_ok, datetime.now(timezone.utc).isoformat(timespec="seconds")))
                q.commit()
    log.info("FINISHED inserted=%d dup_saos=%d", inserted, skipped_dup)


if __name__ == "__main__":
    main()
