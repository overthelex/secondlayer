#!/usr/bin/env python3
"""Stage 0: pin the Sejm ELI corpus baseline before harvesting anything.

Fetches the two publisher records and all ~197 year listings, stores them
verbatim, and writes baseline.json - the file every later audit asserts against.

Why this exists as its own step. The corpus moves: /eli/changes/acts reported
376 changed acts in a two-week window, so "we have N acts" is only meaningful
against a pinned N with a timestamp. And the meta-lesson the Ukrainian corpus
paid for is in scripts/legislation/full-corpus/README.md: aggregates cannot tell
"absent upstream" from "we asked wrong". So this also re-measures the landmark
acts whose answers we already know, and fails loudly if any of them moved.

A year listing is a full metadata dump - GET /eli/acts/DU/2020 returns
count == totalCount == 2463 with 15 fields per item - so the whole register is
enumerable in 197 requests. Act details are NOT fetched here; that is Stage 1.

Runs anywhere with network. Intended host is local.lex.

  python3 scripts/pl/pin_baseline.py
  python3 scripts/pl/pin_baseline.py --out /data/pl_eli/baseline --landmarks-only
"""
import argparse
import json
import os
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

API = "https://api.sejm.gov.pl/eli"
PUBLISHERS = ("DU", "MP")

# Measured 2026-08-14: details sustained 11.5 req/s at 5 workers and text.html
# 4.1 req/s at 4, with no 429 across ~700 requests. 4 workers with a 250 ms
# per-worker floor is ~6 req/s aggregate, a deliberate margin rather than a
# limit the source imposed.
WORKERS = int(os.environ.get("WORKERS", "4"))
RATE_MS = int(os.environ.get("RATE_MS", "250"))
TRIES = int(os.environ.get("TRIES", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "90"))

# Every value here was fetched live on 2026-08-14. They are equalities, not
# guidance: a mismatch means either the source changed the act - in which case
# record the new value and say so - or our understanding of the API is wrong.
# Konstytucja RP is the deliberate negative case: it has no HTML, /struct
# returns 404 and text.html returns 200 with zero bytes, so any pipeline that
# assumes "act => HTML" loses the single most recognisable act in the corpus
# without noticing.
LANDMARKS = [
    # eli,           label,                   struct_arti, text_html, struct_ok
    ("DU/1964/93",   "Kodeks cywilny",               1088, True,  True),
    ("DU/1997/553",  "Kodeks karny",                  363, True,  True),
    ("DU/1997/555",  "Kodeks postepowania karnego",   682, True,  True),
    ("DU/1964/296",  "Kodeks postepowania cywilnego",1153, True,  True),
    ("DU/1974/141",  "Kodeks pracy",                  305, True,  True),
    ("DU/1960/168",  "Kodeks postepowania adm.",      196, True,  True),
    ("DU/2020/1320", "KP tekst jednolity 2020",       494, True,  True),
    ("DU/2023/1610", "KC tekst jednolity 2023",      1295, True,  True),
    ("DU/1997/483",  "Konstytucja RP (PDF only)",       0, False, False),
]

_last_call = [0.0]


def throttle():
    gap = RATE_MS / 1000.0 / max(WORKERS, 1)
    now = time.time()
    wait = _last_call[0] + gap - now
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()


def fetch(path):
    """Return (body_bytes, http_code). curl, not urllib: urllib raises
    CERTIFICATE_VERIFY_FAILED against this host in some environments while curl
    succeeds, the same class of difference scripts/nl/harvest_bwb_texts.py
    documents for KOOP."""
    url = f"{API}/{path}"
    for attempt in range(TRIES):
        throttle()
        r = subprocess.run(
            ["curl", "-s", "-m", str(TIMEOUT), "-w", "\n%{http_code}", url],
            capture_output=True)
        if r.returncode == 0 and r.stdout:
            body, _, code = r.stdout.rpartition(b"\n")
            try:
                code = int(code)
            except ValueError:
                code = 0
            # A 200 with an empty body is a permanent property of this API for
            # acts without HTML, not a transient failure - reproduced on three
            # symbol forms and two acts. Do not retry it.
            if code in (200, 404):
                return body, code
        time.sleep(2 * (attempt + 1))
    return None, 599


def fetch_json(path):
    body, code = fetch(path)
    if code != 200 or not body:
        return None, code
    try:
        return json.loads(body), code
    except json.JSONDecodeError:
        return None, 901


def year_listing(pub, year):
    """One year of one publisher. limit=500 is below the year sizes we see
    (max ~2500), but the API returns the whole year regardless: DU/2020 answered
    count == totalCount == 2463. The assertion below is what proves that, per
    year, rather than assuming it."""
    d, code = fetch_json(f"acts/{pub}/{year}?limit=5000")
    if d is None:
        return year, None, code, "fetch_failed"
    total, got = d.get("totalCount"), len(d.get("items") or [])
    status = "ok" if total == got else "TRUNCATED"
    return year, d, code, status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.environ.get("OUT", "/data/pl_eli/baseline"))
    ap.add_argument("--landmarks-only", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    started = time.time()
    report = {"pinned_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "api": API,
              "publishers": {}, "landmarks": [], "problems": []}

    if not args.landmarks_only:
        for pub in PUBLISHERS:
            meta, code = fetch_json(f"acts/{pub}")
            if meta is None:
                report["problems"].append(f"publisher {pub}: HTTP {code}")
                continue
            # Publisher record is {actsCount, code, name, shortName, years:[int]}.
            # DU reports actsCount 97681 over 105 years, MP 66532 over 92.
            years = list(meta.get("years") or [])
            if not years:
                report["problems"].append(f"publisher {pub}: no years listed")
                continue
            with open(os.path.join(args.out, f"{pub}_publisher.json"), "w") as f:
                json.dump(meta, f, ensure_ascii=False)

            per_year, html_by_year, type_counts = {}, {}, Counter()
            total_acts = total_html = 0

            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                for year, d, code, status in pool.map(
                        lambda y: year_listing(pub, y), years):
                    if d is None:
                        report["problems"].append(f"{pub}/{year}: HTTP {code}")
                        continue
                    if status == "TRUNCATED":
                        report["problems"].append(
                            f"{pub}/{year}: listing truncated, "
                            f"totalCount={d.get('totalCount')} items={len(d.get('items') or [])}")
                    with open(os.path.join(args.out, f"{pub}_{year}.json"), "w") as f:
                        json.dump(d, f, ensure_ascii=False)
                    items = d.get("items") or []
                    n_html = sum(1 for i in items if i.get("textHTML"))
                    per_year[year] = len(items)
                    html_by_year[year] = n_html
                    total_acts += len(items)
                    total_html += n_html
                    type_counts.update(i.get("type") for i in items)
                    print(f"  {pub}/{year}: {len(items):>5} acts, {n_html:>5} html", flush=True)

            # The publisher record states its own total. If the year listings do
            # not add up to it, the enumeration is incomplete and every later
            # coverage percentage would be computed against the wrong
            # denominator - the exact way a corpus reports 99% and is wrong.
            declared = meta.get("actsCount")
            if declared is not None and declared != total_acts:
                report["problems"].append(
                    f"{pub}: actsCount={declared} but year listings sum to {total_acts} "
                    f"(delta {total_acts - declared})")

            report["publishers"][pub] = {
                "declared_acts_count": declared,
                "total_acts": total_acts,
                "total_html": total_html,
                "html_pct": round(100.0 * total_html / total_acts, 2) if total_acts else 0.0,
                "years": len(per_year),
                "acts_by_year": per_year,
                "html_by_year": html_by_year,
                "top_types": type_counts.most_common(20),
            }
            print(f"{pub}: {total_acts} acts, {total_html} with HTML "
                  f"({100.0*total_html/max(total_acts,1):.1f}%)", flush=True)

    # Landmarks. Measured, then compared - never asserted from memory.
    for eli, label, want_arti, want_html, want_struct in LANDMARKS:
        meta, code = fetch_json(f"acts/{eli}")
        row = {"eli": eli, "label": label, "http": code}
        if meta is None:
            row["result"] = "FAIL: detail unavailable"
            report["problems"].append(f"landmark {eli}: detail HTTP {code}")
            report["landmarks"].append(row)
            continue

        got_html = bool(meta.get("textHTML"))
        struct, s_code = fetch_json(f"acts/{eli}/struct")
        got_struct = struct is not None

        n_arti = 0
        if got_struct:
            def walk(node):
                nonlocal n_arti
                if node.get("type") == "arti":
                    n_arti += 1
                for c in node.get("children") or []:
                    walk(c)
            nodes = struct if isinstance(struct, list) else \
                (struct.get("children") or [struct])
            for n in nodes:
                walk(n)

        row.update({"title": meta.get("title"), "type": meta.get("type"),
                    "status": meta.get("status"),
                    "legal_status_date": meta.get("legalStatusDate"),
                    "text_html": got_html, "struct_http": s_code,
                    "struct_arti": n_arti, "expected_arti": want_arti})

        bad = []
        if got_html != want_html:
            bad.append(f"textHTML {got_html} != {want_html}")
        if got_struct != want_struct:
            bad.append(f"struct present {got_struct} != {want_struct}")
        if want_struct and n_arti != want_arti:
            bad.append(f"arti {n_arti} != {want_arti}")
        row["result"] = "ok" if not bad else "MISMATCH: " + "; ".join(bad)
        if bad:
            report["problems"].append(f"landmark {eli} ({label}): {row['result']}")
        print(f"  landmark {eli:<14} {label:<32} {row['result']}", flush=True)
        report["landmarks"].append(row)

    path = os.path.join(args.out, "baseline.json")
    with open(path, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\nwrote {path} in {int(time.time()-started)}s")
    if report["problems"]:
        print(f"\n{len(report['problems'])} problem(s):")
        for p in report["problems"][:40]:
            print(f"  - {p}")
        # A landmark mismatch must stop the pipeline, not colour a log line.
        return 1
    print("no problems: baseline pinned, landmarks all match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
