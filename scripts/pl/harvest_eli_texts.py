#!/usr/bin/env python3
"""Stages 3+4: fetch each snapshot's struct and text.html, split into articles.

One pass over one worklist, not two. The parser needs both documents at the same
time - it walks the struct tree and looks each node up in the DOM - so fetching
them in separate passes would double the resume bookkeeping for no gain.

Worklist is an anti-join, no checkpoint file:

    pl_act_snapshots LEFT JOIN pl_snapshot_texts ... WHERE the text row is absent

Every snapshot ends with a pl_snapshot_texts row, success or not, so "never
fetched" and "fetched, came back empty" are never the same state. That also
means a failed snapshot is not retried forever: retrying is an explicit

    DELETE FROM pl_snapshot_texts WHERE http_status IN (599, 900, 902);

before re-running, which keeps the intent visible instead of burying it in a
loop condition.

Snapshots the source never published in machine-readable form (has_html = false:
every Monitor Polski act and 58,571 DU acts, including Konstytucja RP) get
verdict 903 written WITHOUT a fetch. 903 is not a failure - it is the honest
statement that no text exists upstream, and it is what separates a gap in the
source from a gap in our harvest.

Raw documents are staged under --raw before parsing, so changing the extraction
rules is a reparse rather than a refetch. Budget ~3 GB.

  python3 scripts/pl/harvest_eli_texts.py --mark-no-html
  python3 scripts/pl/harvest_eli_texts.py --limit 200      # smoke first
  python3 scripts/pl/harvest_eli_texts.py
  python3 scripts/pl/harvest_eli_texts.py --reparse        # no network
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import lxml.html

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plprod  # noqa: E402
import pl_article_parser as P  # noqa: E402

API = "https://api.sejm.gov.pl/eli"
RAW = os.environ.get("RAW", "/data/pl_eli/raw")
WORKERS = int(os.environ.get("WORKERS", "4"))
RATE_MS = int(os.environ.get("RATE_MS", "250"))
BATCH = int(os.environ.get("BATCH", "200"))
TRIES = int(os.environ.get("TRIES", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "180"))

ART_COLS = ["act_eli", "snapshot_eli", "ord", "symbol", "struct_id", "art_no",
            "art_display", "art_sort_1", "art_sort_2", "art_title", "text", "n_chars"]
UNIT_COLS = ["snapshot_eli", "ord", "parent_ord", "depth", "struct_id", "symbol",
             "unit_type", "name", "title", "article_ord", "char_from", "char_to",
             "in_annex"]
TXT_COLS = ["snapshot_eli", "act_eli", "http_status", "html_bytes", "struct_bytes",
            "struct_articles", "article_count", "unit_count", "text", "n_chars",
            "text_hash", "label_mismatches", "nonmonotonic", "annex_part_id"]

_lock = Lock()
_last = [0.0]
counts = {"ok": 0, "no_text": 0, "failed": 0, "articles": 0}
started = time.time()


def log(msg):
    el = int(time.time() - started)
    done = counts["ok"] + counts["no_text"] + counts["failed"]
    print(f"[{el:>6}s] {msg} | done={done} ok={counts['ok']} "
          f"notext={counts['no_text']} failed={counts['failed']} "
          f"arts={counts['articles']} | {done/el if el else 0:.1f}/s", flush=True)


def throttle():
    gap = RATE_MS / 1000.0 / max(WORKERS, 1)
    with _lock:
        wait = _last[0] + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def raw_path(eli, ext):
    pub, year, pos = eli.split("/")
    d = os.path.join(RAW, pub, year)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{pos}{ext}")


def fetch(url, path, use_cache=True):
    """(bytes, verdict). Cached on disk so a reparse costs no requests."""
    if use_cache and os.path.exists(path):
        with open(path, "rb") as f:
            body = f.read()
        return (body, P.OK) if body else (b"", 900)

    for attempt in range(TRIES):
        throttle()
        r = subprocess.run(["curl", "-s", "-m", str(TIMEOUT), "-w", "\n%{http_code}", url],
                           capture_output=True)
        if r.returncode == 0 and r.stdout:
            body, _, code = r.stdout.rpartition(b"\n")
            try:
                code = int(code)
            except ValueError:
                code = 0
            if code == 404:
                return b"", 404
            if code == 200:
                # A 200 with an empty body is a permanent property of this API,
                # reproduced across acts and symbol forms. Retrying it would
                # multiply the run by the acts that have no HTML.
                if not body:
                    return b"", 900
                with open(path, "wb") as f:
                    f.write(body)
                return body, P.OK
        time.sleep(2 * (attempt + 1))
    return b"", 599


def _full_text(html):
    """Whole-document text, gloss footnotes removed.

    Stored ONLY when no article came out, so a provision is never held twice -
    the rule migration 191 inherits from nl_law_edition_texts.
    """
    doc = lxml.html.document_fromstring(
        html, parser=lxml.html.HTMLParser(encoding="utf-8"))
    P.strip_glosses(doc)
    return P._clean("".join(doc.itertext()))


def handle(row, reparse=False):
    act_eli, snap_eli, is_cons = row[0], row[1], row[2] == "t"

    html, hv = fetch(f"{API}/acts/{snap_eli}/text.html",
                     raw_path(snap_eli, ".html"), use_cache=True)
    if hv != P.OK:
        counts["failed"] += 1
        return [], [], [(snap_eli, act_eli, hv, len(html), None, None, 0, 0,
                         None, 0, None, 0, 0, None)]

    sj, sv = fetch(f"{API}/acts/{snap_eli}/struct",
                   raw_path(snap_eli, ".struct.json"), use_cache=True)
    if sv != P.OK:
        # The act says it has HTML but publishes no structure. Distinct verdict
        # (902) rather than lumping it with a fetch failure: it needs a
        # different fix, not a retry.
        counts["failed"] += 1
        return [], [], [(snap_eli, act_eli, P.NO_STRUCT, len(html), len(sj), None,
                         0, 0, None, 0, None, 0, 0, None)]

    try:
        # Not json.loads: ISAP does not escape ASCII double quotes inside string
        # values, so any act whose title closes a „ quotation with a straight "
        # returns unparseable JSON. DU/2024/561 is 76 KB of valid structure
        # behind one such quote, and 140 articles would be lost with it.
        struct, _repaired = P.repair_struct_json(sj)
    except json.JSONDecodeError:
        counts["failed"] += 1
        # Still store the document text. Without a struct there are no articles,
        # but losing the act entirely is worse than holding it unsegmented, and
        # verdict 901 records exactly which of the two this row is.
        full = _full_text(html)
        return [], [], [(snap_eli, act_eli, 901, len(html), len(sj), None, 0, 0,
                         full, len(full), None, 0, 0, None)]

    r = P.parse(struct, html, is_consolidation=is_cons)

    arts = [(act_eli, snap_eli, a["ord"], a["symbol"], a["struct_id"], a["art_no"],
             a["art_display"], a["art_sort_1"], a["art_sort_2"], a["art_title"],
             a["text"], a["n_chars"]) for a in r.articles]
    units = [(snap_eli, u["ord"], u["parent_ord"], u["depth"], u["struct_id"],
              u["symbol"], u["unit_type"], u["name"], u["title"], u["article_ord"],
              u["char_from"], u["char_to"], u["in_annex"]) for u in r.units]

    joined = "\n".join(a["text"] for a in r.articles)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest() if joined else None

    # Whole-document text is kept ONLY when no article came out, so a provision
    # is never stored twice (the rule migration 182 set for the Dutch corpus).
    full = _full_text(html) if not r.articles else None

    if r.verdict == P.OK:
        counts["ok"] += 1
    else:
        counts["failed"] += 1
    counts["articles"] += len(arts)

    return arts, units, [(snap_eli, act_eli, r.verdict, len(html), len(sj),
                          r.struct_articles, len(arts), len(units), full,
                          len(full) if full else 0, digest, r.label_mismatches,
                          r.nonmonotonic, r.annex_part_id)]


def mark_no_html():
    """Write verdict 903 for every snapshot the source never published as HTML.

    Done in SQL, in one statement: it covers ~125k snapshots and there is
    nothing to fetch. Re-runnable - the anti-join skips rows already written.
    """
    n = plprod.psql("""
        INSERT INTO pl_snapshot_texts
            (snapshot_eli, act_eli, http_status, article_count, unit_count, n_chars)
        SELECT s.snapshot_eli, s.act_eli, 903, 0, 0, 0
          FROM pl_act_snapshots s
          LEFT JOIN pl_snapshot_texts t ON t.snapshot_eli = s.snapshot_eli
         WHERE t.snapshot_eli IS NULL AND NOT s.has_html
        RETURNING 1;""")
    print(f"marked no-html snapshots: {n.strip().splitlines()[-1] if n else '?'}",
          flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--raw", default=RAW)
    ap.add_argument("--mark-no-html", action="store_true")
    ap.add_argument("--reparse", action="store_true",
                    help="parse from the on-disk cache only, no network")
    a = ap.parse_args()

    globals()["RAW"] = a.raw
    os.makedirs(a.raw, exist_ok=True)

    if a.mark_no_html:
        mark_no_html()
        return 0

    done = 0
    while True:
        n = BATCH if not a.limit else min(BATCH, a.limit - done)
        if n <= 0:
            break
        work = list(plprod.rows_of(
            "SELECT s.act_eli, s.snapshot_eli, "
            "  CASE WHEN s.snapshot_kind='jednolity' THEN 't' ELSE 'f' END "
            "FROM pl_act_snapshots s "
            "LEFT JOIN pl_snapshot_texts t ON t.snapshot_eli = s.snapshot_eli "
            "WHERE t.snapshot_eli IS NULL AND s.has_html "
            f"ORDER BY s.act_eli, s.seq LIMIT {n}"))
        if not work:
            log("worklist empty, done")
            break

        arts, units, txts = [], [], []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for aa, uu, tt in pool.map(lambda r: handle(r, a.reparse), work):
                arts += aa
                units += uu
                txts += tt

        # Text rows last: they are what the anti-join keys on, so writing them
        # before their articles would let a crash in between leave a snapshot
        # marked done with no articles.
        if arts:
            plprod.copy_rows("pl_act_articles", ART_COLS, arts)
        if units:
            plprod.copy_rows("pl_act_units", UNIT_COLS, units)
        if txts:
            plprod.copy_rows("pl_snapshot_texts", TXT_COLS, txts)

        done += len(work)
        log(f"batch of {len(work)}")
        if a.limit and done >= a.limit:
            break

    log("finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
