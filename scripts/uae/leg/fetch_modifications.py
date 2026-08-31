#!/usr/bin/env python3
"""Harvest the amendment history of each UAE federal act.

The portal keeps a full per-article history that the downloadable PDFs do not
show: `/ar/legislations/<id>/modifications` carries the act's dates, gazette
reference and status, and `POST /ar/legislations/<id>/modifications/list`
returns, per year, every amending act together with the *new and the previous
text of each article it touched*.  That pair is what makes "what changed, and
when" answerable rather than merely assertable.

Cloudflare fronts the site and scores each request on its TLS fingerprint, not
on the IP: a plain curl gets 403 from anywhere, while a browser-shaped handshake
gets 200 from the same machine.  Hence curl_cffi with impersonation, a session
per law so the CSRF token and its cookie agree, and a rotation of profiles on
refusal.

Raw HTML is what gets stored.  Parsing is a separate step so that a parser fix
never costs another pass over the site.
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
YEAR = re.compile(r'name="year"\s+value="(\d{4})"')
TOKEN = re.compile(r'_token:\s*"([^"]+)"')
LAST_UPDATE = re.compile(r'التشريع وفقاً لآخر تحديث في\s*([^<]+)<')
TAGS = re.compile(r"<[^>]+>")


def clean(s):
    return re.sub(r"\s+", " ", TAGS.sub(" ", s)).strip()


_session = {"s": None, "profile": 0}


def _new_session():
    """A warmed session: the homepage hands out the cookies the rest relies on."""
    profile = PROFILES[_session["profile"] % len(PROFILES)]
    _session["profile"] += 1
    s = requests.Session(impersonate=profile)
    try:
        s.get(BASE + "/ar", timeout=90)
    except Exception:  # noqa: BLE001
        pass
    _session["s"] = s
    return s


def fetch_law(law_id, tries=5):
    """Return the act's header metadata plus one HTML blob per amendment year.

    An act with no amendments has no modifications page at all and the portal
    answers 500 for it, so that status is an answer, not a failure to retry.
    """
    last_status = None
    for attempt in range(tries):
        session = _session["s"] or _new_session()
        try:
            page = session.get("%s/ar/legislations/%d/modifications" % (BASE, law_id),
                               timeout=90)
        except Exception:  # noqa: BLE001 - transport hiccups are expected here
            _new_session()
            time.sleep(2 + attempt)
            continue
        last_status = page.status_code
        if page.status_code == 404:
            return {"law_id": law_id, "missing": True}
        if page.status_code == 500:
            return {"law_id": law_id, "no_modifications": True}
        if page.status_code != 200:
            _new_session()
            time.sleep(2 + attempt * 2)
            continue

        html = page.text
        meta = {clean(k): clean(v) for k, v in CARD.findall(html)}
        upd = LAST_UPDATE.search(html)
        years = sorted(set(YEAR.findall(html)))
        token = TOKEN.search(html)

        lists = {}
        if token and years:
            for year in years:
                for sub in range(3):
                    try:
                        resp = session.post(
                            "%s/ar/legislations/%d/modifications/list" % (BASE, law_id),
                            json={"_token": token.group(1), "year": year}, timeout=90)
                        if resp.status_code == 200:
                            lists[year] = resp.json().get("html", "")
                            break
                    except Exception:  # noqa: BLE001
                        pass
                    time.sleep(1.5 * (sub + 1))
        return {
            "law_id": law_id,
            "meta": meta,
            "last_update": clean(upd.group(1)) if upd else None,
            "years": years,
            "lists": lists,
        }
    return {"law_id": law_id, "error": "http %s" % last_status}


def main():
    ids_file, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    ids = [int(x) for x in open(ids_file).read().split()]
    done = failed = 0
    for law_id in ids:
        dst = os.path.join(out_dir, "%d.json.gz" % law_id)
        if os.path.exists(dst) and os.path.getsize(dst) > 40:
            continue
        rec = fetch_law(law_id)
        if rec.get("error"):
            failed += 1
            print("FAIL %d %s" % (law_id, rec["error"]), flush=True)
            continue
        with gzip.open(dst, "wt", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False)
        done += 1
        if done % 25 == 0:
            print("%d done, %d failed" % (done, failed), flush=True)
        time.sleep(random.uniform(0.3, 0.8))
    print("finished: %d written, %d failed" % (done, failed))


if __name__ == "__main__":
    main()
