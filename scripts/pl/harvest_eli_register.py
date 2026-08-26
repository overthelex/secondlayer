#!/usr/bin/env python3
"""Stage 1: build the Polish act register and the reference graph.

Two passes, both resumable, neither with a checkpoint file:

  --listings  197 year listings -> stub rows in pl_acts (the whole register)
  --details   anti-join "pl_acts WHERE detail_fetched_at IS NULL" -> full rows
              plus every edge into pl_act_references

The worklist IS the database, the rule scripts/nl/harvest_bwb_texts.py states:
a killed run just leaves fewer rows for the next one, and running it twice is a
no-op. Nothing here needs a resume file to be correct.

The /references endpoint is deliberately NOT called. The act detail payload
inlines the same edges - verified byte-identical on DU/1964/93 across all five
of its categories (223 Akty wykonawcze, 113 Akty zmieniajace, 11 Inf. o tekscie
jednolitym, 25 Orzeczenie TK, 1 Przepisy wprowadzajace) - so calling it would
double the pass for nothing. 164,213 requests saved.

Runs on local.lex; writes to prod over ssh. Roughly 7-8 h for the details pass
at the default rate.

  python3 scripts/pl/harvest_eli_register.py --listings
  python3 scripts/pl/harvest_eli_register.py --details
  python3 scripts/pl/harvest_eli_register.py --details --limit 500   # smoke run
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plprod  # noqa: E402

API = "https://api.sejm.gov.pl/eli"
WORKERS = int(os.environ.get("WORKERS", "4"))
RATE_MS = int(os.environ.get("RATE_MS", "250"))
BATCH = int(os.environ.get("BATCH", "400"))
TRIES = int(os.environ.get("TRIES", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "90"))

ACT_COLS = [
    "eli", "publisher", "year", "pos", "volume", "address", "display_address",
    "act_type", "title", "status", "in_force", "announcement_date",
    "promulgation", "entry_into_force", "valid_from", "repeal_date",
    "expiration_date", "legal_status_date", "change_date", "text_html",
    "text_pdf", "texts", "keywords", "keywords_names", "released_by",
    "obligated", "authorized_body", "directives", "prints", "detail_fetched_at",
]
REF_COLS = ["src_eli", "category", "dst_eli", "effective_date", "art_ref"]

_lock = Lock()
_last = [0.0]
counts = {"acts": 0, "refs": 0, "failed": 0}
started = time.time()


def throttle():
    gap = RATE_MS / 1000.0 / max(WORKERS, 1)
    with _lock:
        wait = _last[0] + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def fetch_json(path):
    """(parsed, http_code). curl rather than urllib: urllib raises
    CERTIFICATE_VERIFY_FAILED against this host in some environments."""
    for attempt in range(TRIES):
        throttle()
        r = subprocess.run(
            ["curl", "-s", "-m", str(TIMEOUT), "-w", "\n%{http_code}", f"{API}/{path}"],
            capture_output=True)
        if r.returncode == 0 and r.stdout:
            body, _, code = r.stdout.rpartition(b"\n")
            try:
                code = int(code)
            except ValueError:
                code = 0
            if code == 404:
                return None, 404
            if code == 200:
                if not body:
                    # A 200 with an empty body is a permanent property of this
                    # API, not a transient failure. Retrying it would multiply
                    # the run by the 60% of DU acts that have no HTML.
                    return None, 900
                try:
                    return json.loads(body), 200
                except json.JSONDecodeError:
                    return None, 901
        time.sleep(2 * (attempt + 1))
    return None, 599


def _arr(v):
    """Python list -> Postgres text[] literal."""
    if not v:
        return None
    parts = []
    for x in v:
        s = str(x).replace("\\", "\\\\").replace('"', '\\"')
        parts.append(f'"{s}"')
    return "{" + ",".join(parts) + "}"


def _json(v):
    return json.dumps(v, ensure_ascii=False) if v else None


def act_row(d, fetched=False):
    return (
        d.get("ELI"), d.get("publisher"), d.get("year"), d.get("pos"),
        d.get("volume"), d.get("address"), d.get("displayAddress"),
        d.get("type"), d.get("title"), d.get("status"), d.get("inForce"),
        d.get("announcementDate"), d.get("promulgation"), d.get("entryIntoForce"),
        d.get("validFrom"), d.get("repealDate"), d.get("expirationDate"),
        d.get("legalStatusDate"), d.get("changeDate"),
        bool(d.get("textHTML")), bool(d.get("textPDF")),
        _json(d.get("texts")), _arr(d.get("keywords")), _arr(d.get("keywordsNames")),
        _arr(d.get("releasedBy")), _arr(d.get("obligated")), _arr(d.get("authorizedBody")),
        _json(d.get("directives")), _json(d.get("prints")),
        time.strftime("%Y-%m-%d %H:%M:%S") if fetched else None,
    )


def ref_rows(eli, d):
    """Edges from the act's inlined `references` map.

    Category names are kept verbatim in Polish. The source adds categories over
    time, and an edge whose category we do not yet recognise must survive the
    load rather than be dropped by a normalising enum.
    """
    out = []
    for category, entries in (d.get("references") or {}).items():
        seen = set()
        for e in entries or []:
            # Two shapes exist: the inline form {"id": ..., "date": ...} and the
            # /references form {"act": {...}, "date": ...}. Accept both so this
            # keeps working if the payload is ever switched.
            dst = e.get("id") or (e.get("act") or {}).get("ELI")
            if not dst or (category, dst) in seen:
                continue
            seen.add((category, dst))
            out.append((eli, category, dst, e.get("date"), e.get("art")))
    return out


def log(msg):
    el = int(time.time() - started)
    rate = counts["acts"] / el if el else 0
    print(f"[{el:>6}s] {msg} | acts={counts['acts']} refs={counts['refs']} "
          f"failed={counts['failed']} | {rate:.1f} acts/s", flush=True)


def do_listings():
    """Enumerate the whole register from the year listings.

    A year listing is a full metadata dump - DU/2020 answers
    count == totalCount == 2463 - so the register costs 197 requests, and only
    the fields the listing omits (entryIntoForce, legalStatusDate, references,
    ...) need a per-act call in the details pass.
    """
    total = 0
    for pub in ("DU", "MP"):
        meta, code = fetch_json(f"acts/{pub}")
        if meta is None:
            print(f"FATAL: publisher {pub} -> HTTP {code}", file=sys.stderr)
            return 1
        years = list(meta.get("years") or [])
        declared = meta.get("actsCount")
        seen = 0

        for year in years:
            d, code = fetch_json(f"acts/{pub}/{year}?limit=5000")
            if d is None:
                print(f"  {pub}/{year}: HTTP {code}, skipped", file=sys.stderr)
                counts["failed"] += 1
                continue
            items = d.get("items") or []
            if d.get("totalCount") != len(items):
                # Every later coverage percentage is computed against this
                # denominator, so a truncated listing must stop the pass rather
                # than quietly shrink the corpus.
                print(f"FATAL: {pub}/{year} truncated: totalCount="
                      f"{d.get('totalCount')} items={len(items)}", file=sys.stderr)
                return 1
            rows = [act_row(i) for i in items if i.get("ELI")]
            plprod.upsert_rows("pl_acts", ACT_COLS, rows, ["eli"], prefer_new=True)
            counts["acts"] += len(rows)
            seen += len(rows)
            total += len(rows)
            log(f"{pub}/{year}")

        if declared is not None and seen != declared:
            print(f"FATAL: {pub} actsCount={declared} but listings gave {seen}",
                  file=sys.stderr)
            return 1
        print(f"{pub}: {seen} acts, matches declared actsCount", flush=True)

    log(f"listings done, {total} acts")
    return 0


def handle_detail(eli):
    d, code = fetch_json(f"acts/{eli}")
    if d is None:
        counts["failed"] += 1
        return None, []
    d.setdefault("ELI", eli)
    return act_row(d, fetched=True), ref_rows(eli, d)


def do_details(limit):
    """Fill in what the listing does not carry, and the reference graph."""
    done = 0
    while True:
        n = BATCH if not limit else min(BATCH, limit - done)
        if n <= 0:
            break
        work = [r[0] for r in plprod.rows_of(
            "SELECT eli FROM pl_acts WHERE detail_fetched_at IS NULL "
            f"ORDER BY publisher, year, pos LIMIT {n}")]
        if not work:
            log("worklist empty, done")
            break

        acts, refs = [], []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for row, rrows in pool.map(handle_detail, work):
                if row is not None:
                    acts.append(row)
                    refs += rrows

        if acts:
            plprod.upsert_rows("pl_acts", ACT_COLS, acts, ["eli"], prefer_new=True)
            counts["acts"] += len(acts)
        if refs:
            plprod.upsert_rows("pl_act_references", REF_COLS, refs,
                               ["src_eli", "category", "dst_eli"], prefer_new=True)
            counts["refs"] += len(refs)

        done += len(work)
        log(f"batch of {len(work)}")

        if len(acts) == 0:
            # Nothing in this batch succeeded, so the same rows come back next
            # time and the loop would spin forever. Stop and let the operator
            # look, rather than burn the night on a dead endpoint.
            print("FATAL: a whole batch failed; stopping instead of looping",
                  file=sys.stderr)
            return 1
        if limit and done >= limit:
            break

    log("details done")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listings", action="store_true")
    ap.add_argument("--details", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if not (a.listings or a.details):
        ap.error("pass --listings and/or --details")
    rc = 0
    if a.listings:
        rc = do_listings()
    if rc == 0 and a.details:
        rc = do_details(a.limit)
    return rc


if __name__ == "__main__":
    sys.exit(main())
