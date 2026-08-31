#!/usr/bin/env python3
"""Fetch publication metadata for acts that have no amendment page.

The gazette reference, the issue and effective dates and the in-force status sit
on the act's own page as well, so the 90% of the corpus that was never amended -
and therefore has no modifications page at all - can still be dated and given a
status.  Without this the status column would only ever describe amended acts,
which is the opposite of a representative sample.
"""
import gzip
import json
import os
import random
import re
import sys
import time

from curl_cffi import requests

BASE = "https://uaelegislation.gov.ae"
PROFILES = ["safari17_0", "chrome", "safari15_5", "chrome110"]
CARD = re.compile(
    r'<div class="widget_card_v2">.*?<div class="name_">\s*<p>(.*?)</p>.*?<h4>(.*?)</h4>',
    re.S)
LAST_UPDATE = re.compile(r'التشريع وفقاً لآخر تحديث في\s*([^<]+)<')
TAGS = re.compile(r"<[^>]+>")
_state = {"s": None, "n": 0}


def clean(s):
    return re.sub(r"\s+", " ", TAGS.sub(" ", s or "")).strip()


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


def fetch(law_id, tries=5):
    for attempt in range(tries):
        try:
            r = session().get("%s/ar/legislations/%d" % (BASE, law_id), timeout=90)
            if r.status_code == 200:
                upd = LAST_UPDATE.search(r.text)
                return {"law_id": law_id,
                        "meta": {clean(k): clean(v) for k, v in CARD.findall(r.text)},
                        "last_update": clean(upd.group(1)) if upd else None,
                        "lists": {}, "years": []}
            if r.status_code == 404:
                return {"law_id": law_id, "missing": True}
        except Exception:  # noqa: BLE001
            pass
        _state["s"] = None
        time.sleep(2 + attempt * 2)
    return None


def main():
    ids_file, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    ids = [int(x) for x in open(ids_file).read().split()]
    done = failed = 0
    for law_id in ids:
        dst = os.path.join(out_dir, "%d.json.gz" % law_id)
        if os.path.exists(dst) and os.path.getsize(dst) > 40:
            continue
        rec = fetch(law_id)
        if rec is None:
            failed += 1
            print("FAIL %d" % law_id, flush=True)
            continue
        with gzip.open(dst, "wt", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False)
        done += 1
        if done % 50 == 0:
            print("%d done, %d failed" % (done, failed), flush=True)
        time.sleep(random.uniform(0.2, 0.5))
    print("finished: %d written, %d failed" % (done, failed))


if __name__ == "__main__":
    main()
