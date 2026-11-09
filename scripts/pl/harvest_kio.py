#!/usr/bin/env python3
"""Backfill Krajowa Izba Odwoławcza (KIO) rulings from orzeczenia.uzp.gov.pl.

SAOS stopped mirroring KIO on 2018-09-06. The UZP portal lists documents via
POST /Home/GetResults (an AJAX endpoint; 10 per page, page in `Pg`, date
range in `Dt` as "dd.mm.yyyy - dd.mm.yyyy", `Kind=KIO`) and serves each ruling
as a PDF at /Home/PdfContent/<id>?Kind=KIO, with a small metadata page at
/Home/Details/<id>. Text comes out of the PDF with pdftotext -layout; the PDF
itself is kept under --raw-dir for provenance.

Rows: id 'kio-<id>', source 'kio', court_type 'NATIONAL_APPEAL_CHAMBER'
(the SAOS value), court_name 'Krajowa Izba Odwoławcza'. A ruling whose
(case_number, decision_date) already exists among the SAOS KIO rows is
skipped, so the two sources do not double up.

Calendar-week windows, newest first, state in sqlite, resumable; windows from
the last --recheck-days are re-listed on every run because the portal
publishes late. Some documents have an empty PDF on the portal (status
pdf_error) and one is a test record ('Treść testowa'). PG* env. local.lex.
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
from datetime import date, datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests

BASE = "https://orzeczenia.uzp.gov.pl"
UA = "lawrider-pl-backfill/1.0 (+https://lawrider.pl)"
log = logging.getLogger("kio")


class Limiter:
    def __init__(self, rate):
        self.min_interval = 1.0 / rate if rate > 0 else 0
        self.last = 0.0

    def wait(self):
        d = self.last + self.min_interval - time.time()
        if d > 0:
            time.sleep(d)
        self.last = time.time()


def request(session, limiter, method, url, retries=8, **kw):
    delay = 10
    for _ in range(retries):
        limiter.wait()
        try:
            r = session.request(method, url, timeout=180, headers={"User-Agent": UA, "X-Requested-With": "XMLHttpRequest"}, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(str(r.status_code))
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            log.warning("%s %s failed (%s); retry in %ss", method, url, e, delay)
            time.sleep(delay)
            delay = min(delay * 2, 600)
    raise RuntimeError(f"gave up on {url}")


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


RE_COUNT = re.compile(r"Liczba znalezionych dokumentów:\s*(\d+)")
# Each hit starts with the rate-wrapper div and ends at its "Wyświetl szczegóły" link.
RE_ITEM = re.compile(r'<div class="search-result-item__rate-wrapper">(.*?)href="/Home/Details/(\d+)"', re.S)
RE_LABEL = re.compile(r"<label>(.*?)</label>\s*(.*?)(?=</p>|</div>)", re.S)


def parse_results(page_html):
    m = RE_COUNT.search(page_html)
    total = int(m.group(1)) if m else 0
    items = []
    for body, did in RE_ITEM.findall(page_html):
        f = {clean(k).rstrip(":"): clean(v) for k, v in RE_LABEL.findall(body)}
        items.append((int(did), f))
    return total, items


def list_window(session, limiter, d_from, d_to):
    dt = f"{d_from:%d.%m.%Y} - {d_to:%d.%m.%Y}"
    seen = {}
    page = 1
    total = None
    while True:
        r = request(session, limiter, "POST", f"{BASE}/Home/GetResults",
                    data={"Dt": dt, "Phrase": "", "Sign": "", "Fle": "1", "SCnt": "1", "Kind": "KIO", "Pg": str(page)})
        t, items = parse_results(r.text)
        if total is None:
            total = t
        new = 0
        for did, f in items:
            if did not in seen:
                seen[did] = f
                new += 1
        if not items or new == 0 or len(seen) >= total:
            break
        page += 1
        if page > 400:
            log.warning("window %s: runaway paging, stopping", dt)
            break
    if total and len(seen) != total:
        log.warning("window %s: listed %d of %d", dt, len(seen), total)
    return seen


RE_DET = re.compile(r"<label>(.*?)</label>\s*(.*?)</(?:p|div|td)>", re.S)


def parse_details(page_html):
    out = {}
    for k, v in RE_DET.findall(page_html):
        k = clean(k).rstrip(":")
        if k:
            out[k] = clean(v)
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


def to_iso(d):
    m = re.match(r"(\d{2})-(\d{2})-(\d{4})", d or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


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
    ap.add_argument("--from", dest="d_from", default="2007-12-01")
    ap.add_argument("--to", dest="d_to", default=date.today().isoformat())
    ap.add_argument("--rate", type=float, default=1.5)
    ap.add_argument("--db", default=os.path.expanduser("~/lawrider/kio/queue.sqlite"))
    ap.add_argument("--raw-dir", default="/data/pl_kio/raw")
    ap.add_argument("--max-windows", type=int, default=0)
    ap.add_argument("--recheck-days", type=int, default=120,
                    help="always re-list windows ending within this many days (late publications)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    os.makedirs(args.raw_dir, exist_ok=True)

    q = sqlite3.connect(args.db)
    q.execute("CREATE TABLE IF NOT EXISTS windows (w TEXT PRIMARY KEY, total INT, done_at TEXT)")
    q.execute("CREATE TABLE IF NOT EXISTS docs (id INT PRIMARY KEY, w TEXT, status TEXT, fetched_at TEXT)")
    q.commit()

    conn = psycopg2.connect("")
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        cur.execute("SELECT substr(id, 5)::int FROM pl_court_decisions WHERE source = 'kio'")
        known_ids = {r[0] for r in cur.fetchall()}
        cur.execute("""SELECT case_number, decision_date FROM pl_court_decisions
                       WHERE court_type = 'NATIONAL_APPEAL_CHAMBER' AND source <> 'kio'
                         AND case_number IS NOT NULL""")
        known_cases = {(re.sub(r"\s+", " ", c).strip(), d.isoformat()) for c, d in cur.fetchall() if d}
    conn.commit()
    log.info("known kio ids %d, known KIO case/date pairs %d", len(known_ids), len(known_cases))

    limiter = Limiter(args.rate)
    d_from, d_to = date.fromisoformat(args.d_from), date.fromisoformat(args.d_to)
    inserted = skipped_dup = 0
    n_windows = 0
    w_to = d_to
    while w_to >= d_from:
        # Windows are calendar weeks (Mon..Sun), so their keys are the same on every run;
        # anchoring them to --to made a rerun on another day re-list the whole period.
        w_from = max(w_to - timedelta(days=w_to.weekday()), d_from)
        w_end = w_to
        wkey = f"{w_from}..{w_end}"
        w_to = w_from - timedelta(days=1)
        # The portal publishes with a lag of weeks, so a recent window is never final.
        recent = (date.today() - w_end).days <= args.recheck_days
        if not recent and q.execute("SELECT 1 FROM windows WHERE w=? AND done_at IS NOT NULL", (wkey,)).fetchone():
            continue
        session = requests.Session()
        listed = list_window(session, limiter, w_from, w_end)
        rows = []
        for did, f in listed.items():
            q.execute("INSERT OR IGNORE INTO docs (id, w, status) VALUES (?, ?, 'queued')", (did, wkey))
            if did in known_ids:
                continue
            case_number = re.sub(r"\s+", " ", f.get("Sygnatura", "")).strip() or None
            decision_date = to_iso(f.get("Data wydania"))
            if case_number and decision_date and (case_number, decision_date) in known_cases:
                skipped_dup += 1
                q.execute("UPDATE docs SET status='dup_saos' WHERE id=?", (did,))
                continue
            det = parse_details(request(session, limiter, "GET", f"{BASE}/Home/Details/{did}").text)
            pdf = request(session, limiter, "GET", f"{BASE}/Home/PdfContent/{did}", params={"Kind": "KIO"})
            try:
                text = pdf_text(pdf.content, os.path.join(args.raw_dir, f"{did}.pdf"))
            except Exception as e:  # noqa: BLE001
                log.error("pdf failed for %s: %s", did, e)
                q.execute("UPDATE docs SET status='pdf_error' WHERE id=?", (did,))
                continue
            legal = [x.strip() for x in re.split(r"[;,]\s*(?=art\.)", det.get("Kluczowe przepisy ustawy Pzp", "")) if x.strip()] or None
            meta = {
                "portal_id": did,
                "list_fields": f,
                "details": det,
                "outcome": det.get("Sygnatura akt / Sposób rozstrzygnięcia"),
                "pdf": f"{BASE}/Home/PdfContent/{did}?Kind=KIO",
                "harvested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "harvester": "harvest_kio.py",
            }
            rows.append((
                f"kio-{did}", None, "kio", "NATIONAL_APPEAL_CHAMBER", "Krajowa Izba Odwoławcza", None,
                case_number, (f.get("Rodzaj dokumentu") or None), decision_date, None, None, None, legal, None,
                None, None, text or None, f"{BASE}/Home/Details/{did}", json.dumps(meta, ensure_ascii=False),
            ))
        if rows and not args.dry_run:
            with conn.cursor() as cur:
                # one batch, so rowcount covers every row (it only reports the last batch)
                psycopg2.extras.execute_values(cur, INSERT, rows, page_size=max(len(rows), 1))
                n = max(cur.rowcount, 0)
            conn.commit()
            inserted += n
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            q.executemany("UPDATE docs SET status='inserted', fetched_at=? WHERE id=?", [(now, int(r[0][4:])) for r in rows])
            known_ids.update(int(r[0][4:]) for r in rows)
        elif rows:
            inserted += len(rows)
        if not args.dry_run:
            q.execute("INSERT OR REPLACE INTO windows (w, total, done_at) VALUES (?, ?, ?)",
                      (wkey, len(listed), datetime.now(timezone.utc).isoformat(timespec="seconds")))
        q.commit()
        log.info("window %s: listed %d, new %d, dup-saos so far %d, inserted so far %d", wkey, len(listed), len(rows), skipped_dup, inserted)
        n_windows += 1
        if args.max_windows and n_windows >= args.max_windows:
            break
    log.info("FINISHED windows=%d inserted=%d dup_saos=%d", n_windows, inserted, skipped_dup)


if __name__ == "__main__":
    main()
