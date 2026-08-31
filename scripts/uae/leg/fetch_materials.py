#!/usr/bin/env python3
"""Harvest the article-level text of each act.

`/ar/legislations/<id>/materials-ajax?page=N` returns the act split into
articles as clean HTML - no OCR, correct ligatures, chapter headings intact.
It is strictly better than the rasterised PDF text the corpus was built from,
and it is the only route to per-article identifiers, which is what the amendment
history keys on.

`next` carries the following page, or null when the act is complete; a long act
runs to several pages, so the walk follows it rather than assuming one.

Cloudflare handling is the same as fetch_modifications.py: it scores the TLS
handshake, so a browser-shaped one is required and profiles are rotated on
refusal.
"""
import gzip
import json
import os
import random
import sys
import time

from curl_cffi import requests

BASE = "https://uaelegislation.gov.ae"
PROFILES = ["safari17_0", "chrome", "safari15_5", "chrome110"]
MAX_PAGES = 60
_state = {"s": None, "n": 0}


def session():
    if _state["s"] is None:
        s = requests.Session(impersonate=PROFILES[_state["n"] % len(PROFILES)])
        _state["n"] += 1
        try:
            s.get(BASE + "/ar", timeout=90)
        except Exception:  # noqa: BLE001
            pass
        _state["s"] = s
    return _state["s"]


def fetch_page(law_id, page, tries=5):
    for attempt in range(tries):
        try:
            r = session().get(
                "%s/ar/legislations/%d/materials-ajax?page=%d" % (BASE, law_id, page),
                timeout=90)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (404, 500):
                return None
        except Exception:  # noqa: BLE001
            pass
        _state["s"] = None
        time.sleep(2 + attempt * 2)
    raise RuntimeError("law %d page %d unreachable" % (law_id, page))


def fetch_law(law_id):
    pages, page = [], 1
    while page <= MAX_PAGES:
        data = fetch_page(law_id, page)
        if data is None:
            break
        pages.append({"page": page,
                      "index_list": data.get("index_list", ""),
                      "html_data": data.get("html_data", "")})
        if not data.get("next"):
            break
        page += 1
        time.sleep(0.3)
    return {"law_id": law_id, "pages": pages,
            "truncated": page >= MAX_PAGES}


def main():
    ids_file, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    ids = [int(x) for x in open(ids_file).read().split()]
    done = empty = failed = 0
    for law_id in ids:
        dst = os.path.join(out_dir, "%d.json.gz" % law_id)
        if os.path.exists(dst) and os.path.getsize(dst) > 40:
            continue
        try:
            rec = fetch_law(law_id)
        except RuntimeError as exc:
            failed += 1
            print("FAIL %s" % exc, flush=True)
            continue
        if not rec["pages"]:
            empty += 1
        if rec["truncated"]:
            print("TRUNCATED at %d pages: law %d" % (MAX_PAGES, law_id), flush=True)
        with gzip.open(dst, "wt", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False)
        done += 1
        if done % 50 == 0:
            print("%d done, %d without articles, %d failed" % (done, empty, failed),
                  flush=True)
        time.sleep(random.uniform(0.2, 0.5))
    print("finished: %d written, %d without articles, %d failed" % (done, empty, failed))


if __name__ == "__main__":
    main()
