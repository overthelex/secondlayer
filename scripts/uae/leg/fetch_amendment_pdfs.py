#!/usr/bin/env python3
"""Download the PDF of each amending act.

The amendment list gives each one its own id under
`/ar/constitution/modifications/<id>/download`.  These are the instruments
themselves - worth holding alongside the parsed article changes, since the
portal's own rendering is a summary of them.

Same Cloudflare handling as fetch_modifications.py, and the same rule as the
rest of this portal: a missing document answers 200 with an HTML shell, so a
file counts as downloaded only if it starts with %PDF.
"""
import json
import os
import random
import sys
import time

from curl_cffi import requests

BASE = "https://uaelegislation.gov.ae"
PROFILES = ["safari17_0", "chrome", "safari15_5", "chrome110"]
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


def fetch(mod_id, dst, tries=4):
    for attempt in range(tries):
        try:
            r = session().get("%s/ar/constitution/modifications/%d/download" % (BASE, mod_id),
                              timeout=120)
            if r.status_code == 200 and r.content[:4] == b"%PDF":
                with open(dst, "wb") as fh:
                    fh.write(r.content)
                return True
            if r.status_code == 200:
                return False  # a shell, not a document - retrying will not help
        except Exception:  # noqa: BLE001
            pass
        _state["s"] = None
        time.sleep(2 + attempt * 2)
    return False


def main():
    amendments_jsonl, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    ids = sorted({json.loads(l).get("modification_id")
                  for l in open(amendments_jsonl, encoding="utf-8")} - {None})
    got = shell = 0
    for mod_id in ids:
        dst = os.path.join(out_dir, "%d.pdf" % mod_id)
        if os.path.exists(dst) and os.path.getsize(dst) > 1000:
            got += 1
            continue
        if fetch(mod_id, dst):
            got += 1
        else:
            shell += 1
            print("no document for %d" % mod_id, flush=True)
        if (got + shell) % 50 == 0:
            print("%d/%d done" % (got + shell, len(ids)), flush=True)
        time.sleep(random.uniform(0.3, 0.7))
    print("amendment PDFs: %d downloaded, %d unavailable, %d listed" % (got, shell, len(ids)))


if __name__ == "__main__":
    main()
