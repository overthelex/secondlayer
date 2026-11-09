#!/usr/bin/env python3
"""Whole-document text for ELI acts the source publishes only as PDF.

  python3 scripts/pl/harvest_eli_pdf.py --limit 20        # smoke
  python3 scripts/pl/harvest_eli_pdf.py                   # DU from 2025 on
  python3 scripts/pl/harvest_eli_pdf.py --publisher MP --from-year 2025

Worklist: pl_snapshot_texts rows with verdict 903 (no HTML upstream). A row is
rewritten as

  906  text taken from the PDF's text layer, stored in pl_snapshot_texts.text
  907  the PDF has no usable text layer (a scan); nothing stored

A download that fails leaves the row at 903, so the next run retries it. When
the source later publishes HTML, sync_eli_changes.py deletes the 903/906/907 row
and the normal HTML pass takes over.

Articles are deliberately NOT split out. The text layer flattens superscripts,
so "Art. 304(4)" and "Art. 3044" read the same, and a wrong article number is
worse in a legal product than an unsegmented text.

Measured on DU 2025-2026: every sampled PDF has a text layer. Older acts and
Monitor Polski are often scans, which is why the default scope stops at DU 2025+.
"""
import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

API = "https://api.sejm.gov.pl/eli/acts"
RAW = os.environ.get("RAW", "/data/pl_eli/raw")
WORKERS = int(os.environ.get("WORKERS", "4"))
RATE = float(os.environ.get("RATE", "4"))
BATCH = int(os.environ.get("BATCH", "100"))
MIN_CHARS = 200
UA = "lawrider.pl ELI PDF text loader"
COLS = ["snapshot_eli", "act_eli", "http_status", "html_bytes", "article_count",
        "unit_count", "text", "n_chars", "text_hash", "fetched_at"]
HEADER = re.compile(r"^(Dziennik Ustaw|Monitor Polski|[–-]\s*\d+\s*[–-]|Poz\.\s*\d+)$")

_lock = threading.Lock()
_next = [0.0]
_local = threading.local()
counts = {"text": 0, "scan": 0, "failed": 0}
started = time.time()


def throttle():
    with _lock:
        now = time.time()
        wait = _next[0] - now
        _next[0] = max(now, _next[0]) + 1.0 / RATE
    if wait > 0:
        time.sleep(wait)


def download(eli):
    pub, year, pos = eli.split("/")
    d = os.path.join(RAW, pub, year)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{pos}.pdf")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
        s.headers["User-Agent"] = UA
    for attempt in range(4):
        throttle()
        try:
            r = s.get(f"{API}/{eli}/text.pdf", timeout=180)
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200 and r.content[:4] == b"%PDF":
            with tempfile.NamedTemporaryFile(dir=d, delete=False) as f:
                f.write(r.content)
            os.replace(f.name, path)
            return path
        if r.status_code == 404:
            return None
        time.sleep(5 * (attempt + 1))
    return None


def clean(raw):
    """pdftotext output -> text, without the running head of pages 2..n."""
    out = []
    for i, page in enumerate(raw.replace("﻿", "").split("\f")):
        lines = [ln.strip() for ln in page.splitlines()]
        if i:
            kept, head = [], True
            for ln in lines:
                if head and (not ln or HEADER.match(ln)):
                    continue
                head = False
                kept.append(ln)
            lines = kept
        out.append("\n".join(lines).strip())
    text = "\n".join(p for p in out if p).replace("\x00", "")
    return re.sub(r"\n{3,}", "\n\n", text)


def handle(row):
    act_eli, eli = row
    path = download(eli)
    if not path:
        counts["failed"] += 1
        return None
    r = subprocess.run(["pdftotext", "-enc", "UTF-8", path, "-"], capture_output=True,
                       timeout=300)
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    size = os.path.getsize(path)
    if r.returncode != 0:
        counts["failed"] += 1
        return None
    text = clean(r.stdout.decode("utf-8", "replace"))
    if len(text) < MIN_CHARS:
        counts["scan"] += 1
        return (eli, act_eli, 907, size, 0, 0, None, 0, None, now)
    counts["text"] += 1
    return (eli, act_eli, 906, size, 0, 0, text, len(text),
            hashlib.sha256(text.encode("utf-8")).hexdigest(), now)


def log(msg):
    print(f"[{int(time.time() - started):>6}s] {msg} | {counts}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--publisher", default="DU", choices=["DU", "MP"])
    ap.add_argument("--from-year", type=int, default=2025)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    work = list(plprod.rows_of(
        "SELECT t.act_eli, t.snapshot_eli FROM pl_snapshot_texts t "
        "JOIN pl_act_snapshots s ON s.snapshot_eli = t.snapshot_eli AND NOT s.has_html "
        f"WHERE t.http_status = 903 AND split_part(t.snapshot_eli, '/', 1) = '{a.publisher}' "
        f"AND split_part(t.snapshot_eli, '/', 2)::int >= {a.from_year} "
        "ORDER BY t.snapshot_eli"))
    if a.limit:
        work = work[:a.limit]
    log(f"{len(work)} snapshots to do")
    for i in range(0, len(work), BATCH):
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            rows = [r for r in pool.map(handle, work[i:i + BATCH]) if r]
        if rows:
            plprod.upsert_rows("pl_snapshot_texts", COLS, rows, ["snapshot_eli"],
                               prefer_new=False, batch=20)
        log(f"{min(i + BATCH, len(work))}/{len(work)}")
    log("finished")
    return 1 if counts["failed"] > len(work) / 100 else 0


if __name__ == "__main__":
    sys.exit(main())
