#!/usr/bin/env python3
"""Backfill Polish administrative-court decisions (NSA/WSA) from CBOSA.

CBOSA (https://orzeczenia.nsa.gov.pl) has no API. A date-range search is a
plain POST to /cbo/search with odDaty/doDaty (RRRR-MM-DD) - send ONLY those
two fields: adding the form's checkbox fields makes the server answer
"Niepoprawny format daty". The result list is 10 per page, paginated through
the session (/cbo/find?p=N, JSESSIONID cookie), and each decision is at
/doc/<HASH>. The hf-pl-nsa rows already in pl_court_decisions carry that same
"/doc/<HASH>" in metadata_json->>'judgment_id', so the hash is the dedup key.

Pipeline per date window (daily from 2004, monthly before): one session,
search, walk the pages, queue every hash in a local sqlite, then fetch and
insert the hashes we do not have. Windows run newest to oldest so the fresh
gap lands first. Everything is resumable: windows and docs are tracked in the
sqlite, re-running continues where it stopped.

Rows: id 'cbosa-<HASH>', source 'cbosa', court_type 'administrative court',
decision_type like hf-pl-nsa ("Wyrok WSA w Poznaniu"), full_text = Sentencja +
Uzasadnienie, abstract = Tezy when present, all form fields in metadata_json.

DB: PG* env. Run on local.lex.
"""
import argparse
import calendar
import html
import json
import logging
import os
import re
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import requests

BASE = "https://orzeczenia.nsa.gov.pl"
UA = "lawrider-pl-backfill/1.0 (+https://lawrider.pl)"
log = logging.getLogger("cbosa")


class Limiter:
    def __init__(self, rate):
        self.min_interval = 1.0 / rate if rate > 0 else 0
        self.last = 0.0

    def wait(self):
        now = time.time()
        d = self.last + self.min_interval - now
        if d > 0:
            time.sleep(d)
        self.last = time.time()


BLOCK_PAUSE = int(os.environ.get("CBOSA_BLOCK_PAUSE", "1800"))


def request(session, limiter, method, url, retries=6, **kw):
    """GET/POST with backoff. CBOSA answers a too-eager client with closed
    connections and 500s for hours (seen 07.11 after ~5 min at 4 req/s). When
    the short retries are exhausted we do not crash: we pause BLOCK_PAUSE
    seconds and try again, indefinitely, so the run resumes by itself when
    the block lifts."""
    while True:
        delay = 10
        for _ in range(retries):
            limiter.wait()
            try:
                r = session.request(method, url, timeout=120, headers={"User-Agent": UA}, **kw)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(str(r.status_code))
                r.raise_for_status()
                return r
            except requests.RequestException as e:
                log.warning("%s %s failed (%s); retry in %ss", method, url, e, delay)
                time.sleep(delay)
                delay = min(delay * 2, 300)
        log.error("%s still refused after %d tries; pausing %ds before trying again", url, retries, BLOCK_PAUSE)
        time.sleep(BLOCK_PAUSE)


def text_of(fragment):
    t = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    t = re.sub(r"</p>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t\xa0]+", " ", t)
    t = re.sub(r"\s*\n\s*", "\n", t)
    return t.strip()


# ---------------------------------------------------------------- listing
RE_COUNT = re.compile(r"Znaleziono\s+(\d+)\s+orzecze", re.I)
RE_PAGES = re.compile(r"Str\.\s*\d+\s*z\s*(\d+)")
RE_ITEM = re.compile(r'<a href="/doc/([A-F0-9]+)"\s*>(.*?)</a>', re.S)


def parse_list(page_html):
    m = RE_COUNT.search(page_html)
    total = int(m.group(1)) if m else 0
    m = RE_PAGES.search(page_html)
    pages = int(m.group(1)) if m else (1 if total else 0)
    items = [(h, text_of(t)) for h, t in RE_ITEM.findall(page_html)]
    return total, pages, items


RE_TITLE_DATE = re.compile(r"\bz\s+(\d{4}-\d{2}-\d{2})\s*$")


def in_window(title, d_from, d_to):
    """List rows also link related decisions from other dates (the snippet
    under a hit). Those belong to their own window; keep only hits whose
    title date falls inside ours. A title without a date is kept."""
    m = RE_TITLE_DATE.search(title or "")
    if not m:
        return True
    try:
        d = date.fromisoformat(m.group(1))
    except ValueError:
        return True
    return d_from <= d <= d_to


def list_window(session, limiter, d_from, d_to):
    """Yield (hash, title) for every decision dated in [d_from, d_to]."""
    r = request(session, limiter, "POST", f"{BASE}/cbo/search",
                data={"odDaty": d_from.isoformat(), "doDaty": d_to.isoformat()})
    total, pages, items = parse_list(r.text)
    if "Niepoprawny format daty" in r.text:
        raise RuntimeError("CBOSA rejected the date format")
    seen = set()
    skipped = 0
    for h, t in items:
        seen.add(h)
        if in_window(t, d_from, d_to):
            yield h, t
        else:
            skipped += 1
    for p in range(2, pages + 1):
        r = request(session, limiter, "GET", f"{BASE}/cbo/find", params={"p": p})
        _, _, items = parse_list(r.text)
        if not items:
            log.warning("empty page %d/%d for %s..%s", p, pages, d_from, d_to)
            break
        for h, t in items:
            if h in seen:
                continue
            seen.add(h)
            if in_window(t, d_from, d_to):
                yield h, t
            else:
                skipped += 1
    if len(seen) - skipped != total:
        log.warning("window %s..%s: listed %d in-window of %d (plus %d related from other dates)",
                    d_from, d_to, len(seen) - skipped, total, skipped)


# ---------------------------------------------------------------- document
RE_HEADER = re.compile(r'class="war_header"[^>]*>(.*?)</', re.S)
RE_FIELD = re.compile(r'<td class="info-list-label"[^>]*>(.*?)</td>\s*<td class="info-list-value"[^>]*>(.*?)</td>', re.S)
RE_SECTION = re.compile(r'<div class="lista-label">(.*?)</div>\s*<span class="info-list-value-uzasadnienie">(.*?)</span>\s*</td>', re.S)
RE_TITLE = re.compile(r"^(.*?)\s+-\s+(Wyrok|Postanowienie|Uchwała|Zarządzenie|Orzeczenie)\s+(.*?)(?:\s+z\s+(\d{4}-\d{2}-\d{2}))?$", re.S)


def parse_doc(page_html, h):
    fields = {}
    for lab, val in RE_FIELD.findall(page_html):
        fields[text_of(lab)] = text_of(val)
    sections = {}
    for lab, val in RE_SECTION.findall(page_html):
        sections[text_of(lab)] = text_of(val)
    m = RE_HEADER.search(page_html)
    header = text_of(m.group(1)) if m else ""
    case_number = decision_kind = court_short = None
    m = RE_TITLE.match(header)
    if m:
        case_number, decision_kind, court_short = m.group(1).strip(), m.group(2), m.group(3).strip()
    decision_type = f"{decision_kind} {court_short}".strip() if decision_kind else None
    judges_raw = [j for j in (fields.get("Sędziowie") or "").split("\n") if j.strip()]
    judges = []
    judge = None
    for j in judges_raw:
        name = re.sub(r"\s*/.*?/\s*", " ", j).strip()
        roles = re.findall(r"/(.*?)/", j)
        judges.append({"name": name, "roles": roles} if roles else {"name": name})
        if roles and any("przewodnicz" in r for r in roles) and not judge:
            judge = name
    if not judge and judges:
        judge = judges[0]["name"]
    keywords = [k.strip() for k in (fields.get("Hasła tematyczne") or "").split("\n") if k.strip()] or None
    legal = [k.strip() for k in (fields.get("Powołane przepisy") or "").split("\n") if k.strip()] or None
    sentencja = sections.get("Sentencja")
    uzasadnienie = sections.get("Uzasadnienie")
    tezy = sections.get("Tezy")
    parts = []
    if sentencja:
        parts.append(sentencja)
    if uzasadnienie:
        parts.append("UZASADNIENIE\n\n" + uzasadnienie)
    full_text = "\n\n".join(parts) or None
    dd = fields.get("Data orzeczenia") or ""
    m = re.match(r"(\d{4}-\d{2}-\d{2})", dd)
    decision_date = m.group(1) if m else None
    finality = None
    if "prawomocne" in dd:
        finality = "orzeczenie prawomocne" if "nieprawomocne" not in dd else "orzeczenie nieprawomocne"
    meta = {
        "judgment_id": f"/doc/{h}",
        "header": header,
        "finality": finality,
        "fields": fields,
        "sections_present": sorted(sections.keys()),
        "source": "cbosa",
        "harvested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "harvester": "harvest_cbosa.py",
    }
    return (
        f"cbosa-{h}", None, "cbosa", "administrative court", fields.get("Sąd"), None,
        case_number, decision_type, decision_date, judge,
        json.dumps(judges, ensure_ascii=False) if judges else None,
        keywords, legal, None, None, tezy, full_text, f"{BASE}/doc/{h}",
        json.dumps(meta, ensure_ascii=False),
    )


INSERT = """
INSERT INTO pl_court_decisions
  (id, ecli, source, court_type, court_name, division, case_number, decision_type,
   decision_date, judge, judges, keywords, legal_bases, referenced_regulations,
   parties, abstract, full_text, source_url, metadata_json)
VALUES %s
ON CONFLICT (id) DO NOTHING
"""


# ---------------------------------------------------------------- windows
def windows(d_from, d_to):
    """Newest first. Daily from 2004-01-01, monthly before (CBOSA is thin there)."""
    out = []
    d = d_to
    while d >= d_from:
        if d >= date(2004, 1, 1):
            out.append((d, d))
            d -= timedelta(days=1)
        else:
            first = d.replace(day=1)
            out.append((max(first, d_from), d))
            d = first - timedelta(days=1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d_from", default="1900-01-01")
    ap.add_argument("--to", dest="d_to", default=date.today().isoformat())
    ap.add_argument("--rate", type=float, default=2.0, help="max requests per second")
    ap.add_argument("--db", default=os.path.expanduser("~/lawrider/cbosa/queue.sqlite"))
    ap.add_argument("--max-windows", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    q = sqlite3.connect(args.db)
    q.execute("CREATE TABLE IF NOT EXISTS windows (w TEXT PRIMARY KEY, total INT, listed INT, done_at TEXT)")
    q.execute("CREATE TABLE IF NOT EXISTS docs (hash TEXT PRIMARY KEY, title TEXT, w TEXT, status TEXT, fetched_at TEXT)")
    q.commit()

    conn = psycopg2.connect("")
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        cur.execute("""SELECT substr(metadata_json->>'judgment_id', 6) FROM pl_court_decisions
                       WHERE source IN ('hf-pl-nsa', 'cbosa') AND metadata_json->>'judgment_id' LIKE '/doc/%'""")
        known = {r[0] for r in cur.fetchall()}
    conn.commit()
    log.info("known CBOSA hashes in DB: %d", len(known))

    limiter = Limiter(args.rate)
    d_from, d_to = date.fromisoformat(args.d_from), date.fromisoformat(args.d_to)
    inserted = listed_total = 0
    n_windows = 0
    for w_from, w_to in windows(d_from, d_to):
        wkey = f"{w_from}..{w_to}"
        if q.execute("SELECT done_at FROM windows WHERE w=? AND done_at IS NOT NULL", (wkey,)).fetchone():
            continue
        session = requests.Session()
        new_hashes = []
        n_listed = 0
        for h, title in list_window(session, limiter, w_from, w_to):
            n_listed += 1
            q.execute("INSERT OR IGNORE INTO docs (hash, title, w, status) VALUES (?, ?, ?, 'queued')", (h, title, wkey))
            if h not in known:
                new_hashes.append(h)
        q.commit()
        listed_total += n_listed
        rows = []
        for h in new_hashes:
            if q.execute("SELECT 1 FROM docs WHERE hash=? AND status='inserted'", (h,)).fetchone():
                continue
            r = request(session, limiter, "GET", f"{BASE}/doc/{h}")
            try:
                row = parse_doc(r.text, h)
            except Exception as e:  # noqa: BLE001 - log and keep going
                log.error("parse failed for %s: %s", h, e)
                q.execute("UPDATE docs SET status='parse_error' WHERE hash=?", (h,))
                continue
            if not row[16]:
                log.warning("no text for %s (%s)", h, row[6])
            rows.append(row)
        if rows and not args.dry_run:
            with conn.cursor() as cur:
                # one batch, so rowcount covers every row (it only reports the last batch)
                psycopg2.extras.execute_values(cur, INSERT, rows, page_size=max(len(rows), 1))
                n = max(cur.rowcount, 0)
            conn.commit()
            inserted += n
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            q.executemany("UPDATE docs SET status='inserted', fetched_at=? WHERE hash=?", [(now, r[0][6:]) for r in rows])
            known.update(r[0][6:] for r in rows)
        elif rows:
            inserted += len(rows)
        if not args.dry_run:
            q.execute("INSERT OR REPLACE INTO windows (w, total, listed, done_at) VALUES (?, ?, ?, ?)",
                      (wkey, n_listed, n_listed, datetime.now(timezone.utc).isoformat(timespec="seconds")))
        q.commit()
        log.info("window %s: listed %d, new %d, inserted so far %d", wkey, n_listed, len(rows), inserted)
        n_windows += 1
        if args.max_windows and n_windows >= args.max_windows:
            break
    log.info("FINISHED windows=%d listed=%d inserted=%d", n_windows, listed_total, inserted)


if __name__ == "__main__":
    main()
