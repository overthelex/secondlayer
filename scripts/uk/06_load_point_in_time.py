#!/usr/bin/env python3
"""Stage 6: load point-in-time provision text from `revised-all-versions`.

What this answers that nothing else does: "what did section 55 of the Town and
Country Planning Act 1990 say on 3 March 2004". Until now the corpus held one
snapshot per act — `select max(count(distinct valid_from)) from
uk_legislation_provisions group by leg_id` was 1 across all 1,560,686 rows — so
every historical question was unanswerable.

The archive
-----------
`https://research.legislation.gov.uk/data/downloads/texts/revised-all-versions/
xml/revised-all-versions-xml.zip`, 21.1 GB, refreshed daily, 311,826 members of
which 280,720 are XML and 186.1 GB uncompressed. Contents measured from the
central directory on 2026-09-18, files / XML:

    ukpga 61,805 / 120.4 GB      eur   84,481 / 17.2 GB
    uksi  42,603 /  24.3 GB      eudn  43,504 /  5.2 GB
    nisr  12,070 /   3.5 GB      eudr   8,032 /  4.7 GB

⚠ `ukpga` is 120 GB not because the statutes are long but because every version
repeats the entire act. Town and Country Planning Act 1990: 401 versions. So do
not extract this archive — there is not enough disk on the box and there does
not need to be. Members are streamed straight out of the zip.

⚠ The `eur`/`eudn`/`eudr` members are retained EU law, which stage 1 never
enumerated, so those ids are NOT in `uk_legislation`. Their provisions load
here regardless — the tables carry no foreign key to the register — and the
summary reports how many landed outside it. Giving them register rows is a
separate job.

Why intervals rather than snapshots
-----------------------------------
Measured before this was written, by fetching every version of four acts and
parsing them with stage 3's parser:

    ukpga/1990/8   401 versions  287,274 -> 16,456 rows (5.7%)  431 MB -> 4.7 MB
    ukpga/2006/46  200 versions  384,888 -> 28,594 rows (7.4%)  378 MB -> 4.1 MB
    uksi/2010/2955  57 versions   46,048 -> 15,431 rows (33.5%)  38 MB -> 1.9 MB
    ukpga/1998/42   29 versions    1,627 ->    137 rows (8.4%)

A snapshot table would need roughly 110 GB. Storing one row per unchanged span,
with the text itself kept once per distinct content, brings that to single-digit
gigabytes. See migration 217 for the schema.

Identity and dates
------------------
The act id is `IdURI` from inside the file, never the filename: the archive
names regnal items `aep-Hen3c23-52-23-historical-1991-02-01.xml`, which no rule
maps back to `aep/Hen3/23`. The version date is the trailing segment of
`DocumentURI` (`.../ukpga/1990/8/1991-02-01`), falling back to the filename.
⚠ Do NOT use the root `RestrictStartDate` for this — on eur/2009/1198 it reads
2009-12-08 in a file that is the 2020-12-31 version.

The provision key is the provision's own `DocumentURI` with the host and the
trailing version date stripped: `ukpga/1990/8/section/55`. The parser's `ord`
cannot be the key — it is positional, and an inserted section shifts every ord
after it, which is precisely what amendments do.

⚠ A version that parses to zero provisions is SKIPPED, not treated as a repeal
of everything. Otherwise one malformed file closes every interval in the act
and the next version reopens them, inventing an amendment that never happened.

Usage:
  python3 06_load_point_in_time.py --zip /data/uk/revised-all-versions-xml.zip --limit 50
  python3 06_load_point_in_time.py --zip /data/uk/revised-all-versions-xml.zip --workers 3
  python3 06_load_point_in_time.py --zip ... --only ukpga/1990/8 --force

After the load, build the historical FTS index by hand rather than in a
migration, because it takes hours and must not hold a transaction open:
  CREATE INDEX CONCURRENTLY idx_uk_pt_fts
      ON uk_provision_text USING gin (to_tsvector('english', text));
"""

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from multiprocessing import Pool

import psycopg2
from psycopg2.extras import execute_values

DB_URL = os.environ.get("DATABASE_URL")

ID_RE   = re.compile(rb'IdURI="https?://(?:www\.)?legislation\.gov\.uk/id/([^"]+)"')
DOC_RE  = re.compile(rb'DocumentURI="https?://(?:www\.)?legislation\.gov\.uk/([^"]+)"')
NAME_RE = re.compile(r"-historical(-welsh)?-(\d{4}-\d{2}-\d{2})\.xml$")
DATE_TAIL = re.compile(r"/(\d{4}-\d{2}-\d{2})$")

# stage 3's parser, imported rather than copied, for the same reason stage 5
# imports it: a divergence in how a <P1> becomes a row would silently give the
# point-in-time half of the corpus a different shape from the current half.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "uk_stage3", os.path.join(_here, "03_harvest_texts.py"))
stage3 = importlib.util.module_from_spec(_spec)
_saved_argv, sys.argv = sys.argv, [sys.argv[0]]
_spec.loader.exec_module(stage3)
sys.argv = _saved_argv

INS_TEXT = """
INSERT INTO uk_provision_text (text_hash, text, n_chars)
VALUES %s ON CONFLICT (text_hash) DO NOTHING
"""

INS_VER = """
INSERT INTO uk_provision_version
    (leg_id, provision_key, valid_from, valid_to, ord, provision_label,
     provision_type, part, chapter, schedule_no, title, text_hash)
VALUES %s
ON CONFLICT (leg_id, provision_key, valid_from) DO UPDATE SET
    valid_to        = EXCLUDED.valid_to,
    ord             = EXCLUDED.ord,
    provision_label = EXCLUDED.provision_label,
    provision_type  = EXCLUDED.provision_type,
    part            = EXCLUDED.part,
    chapter         = EXCLUDED.chapter,
    schedule_no     = EXCLUDED.schedule_no,
    title           = EXCLUDED.title,
    text_hash       = EXCLUDED.text_hash
"""

INS_STATE = """
INSERT INTO uk_pit_load_state
    (leg_id, versions, versions_empty, rows_written, first_version, last_version,
     source, loaded_at)
VALUES %s
ON CONFLICT (leg_id) DO UPDATE SET
    versions       = EXCLUDED.versions,
    versions_empty = EXCLUDED.versions_empty,
    rows_written   = EXCLUDED.rows_written,
    first_version  = EXCLUDED.first_version,
    last_version   = EXCLUDED.last_version,
    source         = EXCLUDED.source,
    loaded_at      = EXCLUDED.loaded_at
"""


def provision_key(uri, leg_id, prov):
    """Stable identity of a provision across versions."""
    if uri:
        path = re.sub(r"^https?://(?:www\.)?legislation\.gov\.uk/", "", uri)
        return DATE_TAIL.sub("", path.strip("/"))
    # No DocumentURI on the P1 at all. Rare, but a positional fallback would
    # make the key move under amendment, so compose one from what is stable.
    return "%s/%s/%s" % (leg_id, prov.get("provision_type") or "p",
                         prov.get("provision_label") or "?")


# --------------------------------------------------------------------------
# pass 1: what is in the archive
# --------------------------------------------------------------------------

def build_index(zip_path, cache_path, include_welsh=False):
    """member name -> (leg_id, version_date), read from inside each file.

    Reading the first 3 KB of a deflate member decompresses only its first
    block, so this is far cheaper than it looks: one pass over 280,720 members.
    """
    if cache_path and os.path.exists(cache_path):
        with gzip.open(cache_path, "rt") as fh:
            idx = json.load(fh)
        print(f"index loaded from cache: {len(idx)} members", flush=True)
        return idx

    z = zipfile.ZipFile(zip_path)
    names = [n for n in z.namelist() if n.lower().endswith(".xml")]
    idx, skipped_welsh, no_id, no_date = {}, 0, 0, 0
    for i, name in enumerate(names, 1):
        m = NAME_RE.search(name)
        if m and m.group(1) and not include_welsh:
            skipped_welsh += 1
            continue
        try:
            head = z.open(name).read(3000)
        except Exception:
            no_id += 1
            continue
        mi = ID_RE.search(head)
        if not mi:
            no_id += 1
            continue
        leg_id = mi.group(1).decode().strip("/")
        vdate = None
        md = DOC_RE.search(head)
        if md:
            mt = DATE_TAIL.search(md.group(1).decode().rstrip("/"))
            if mt:
                vdate = mt.group(1)
        if not vdate and m:
            vdate = m.group(2)
        if not vdate:
            no_date += 1
            continue
        idx[name] = (leg_id, vdate)
        if i % 25000 == 0:
            print(f"  indexed {i}/{len(names)} members", flush=True)

    print(f"index built: {len(idx)} members | welsh skipped {skipped_welsh} | "
          f"no IdURI {no_id} | no version date {no_date}", flush=True)
    if cache_path:
        with gzip.open(cache_path, "wt") as fh:
            json.dump(idx, fh)
    return idx


# --------------------------------------------------------------------------
# pass 2: one act at a time
# --------------------------------------------------------------------------

_W = {}


def _worker_init(zip_path, dry_run):
    _W["zip"] = zipfile.ZipFile(zip_path)
    _W["dry"] = dry_run
    if not dry_run:
        conn = psycopg2.connect(DB_URL)
        conn.autocommit = False
        _W["conn"] = conn


def build_intervals(leg_id, versions, z):
    """versions: [(date_str, member_name)] in ascending date order.

    Returns (texts, rows, n_parsed, n_empty) where texts maps hash -> (text,
    n_chars) and rows are ready for INS_VER.
    """
    timeline = defaultdict(list)      # key -> [(date, hash_or_None)]
    meta = {}                         # (key, hash) -> first-seen facets
    texts = {}                        # hash -> (text, n_chars)
    seen_keys = set()
    n_parsed = n_empty = 0

    for vdate, name in versions:
        try:
            body = z.open(name).read()
            provs = stage3.parse_provisions(body.decode("utf-8", "replace"), leg_id)
        except Exception:
            n_empty += 1
            continue
        if not provs:
            # Not a repeal of the whole act — see the module docstring.
            n_empty += 1
            continue
        n_parsed += 1

        present = {}
        for p in provs:
            key = provision_key(p.get("provision_uri"), leg_id, p)
            txt = p.get("text") or ""
            h = hashlib.sha1(txt.encode("utf-8")).digest()
            present[key] = h
            if h not in texts:
                texts[h] = (txt, len(txt))
            if (key, h) not in meta:
                meta[(key, h)] = (p.get("ord"), p.get("provision_label") or "?",
                                  p.get("provision_type"), p.get("part"),
                                  p.get("chapter"), p.get("schedule_no"),
                                  p.get("title"))
        for key, h in present.items():
            timeline[key].append((vdate, h))
        # a key known from an earlier version and absent now has gone
        for key in seen_keys - present.keys():
            if timeline[key] and timeline[key][-1][1] is not None:
                timeline[key].append((vdate, None))
        seen_keys |= present.keys()

    rows = []
    for key, seq in timeline.items():
        run_start, run_hash = None, None
        for vdate, h in seq:
            if h == run_hash:
                continue
            if run_hash is not None:
                rows.append(_row(leg_id, key, run_start, vdate, meta[(key, run_hash)],
                                 run_hash))
            run_start, run_hash = vdate, h
        if run_hash is not None:
            # still standing in the last version the archive carries
            rows.append(_row(leg_id, key, run_start, None, meta[(key, run_hash)],
                             run_hash))

    used = {r[11] for r in rows}
    texts = {h: v for h, v in texts.items() if h in used}
    return texts, rows, n_parsed, n_empty


def _row(leg_id, key, vfrom, vto, m, h):
    # the hash stays raw bytes here so it can be compared against the keys of
    # `texts`; psycopg2.Binary is applied once, at insert time
    return (leg_id, key, vfrom, vto, m[0], m[1], m[2], m[3], m[4], m[5], m[6], h)


def process_act(job):
    leg_id, versions = job
    z = _W["zip"]
    try:
        texts, rows, n_parsed, n_empty = build_intervals(leg_id, versions, z)
    except Exception as exc:                        # one bad act must not stop the run
        return (leg_id, 0, 0, 0, f"{type(exc).__name__}: {exc}")

    if _W["dry"]:
        return (leg_id, len(versions), n_empty, len(rows), None)

    conn = _W["conn"]
    try:
        with conn.cursor() as cur:
            if texts:
                execute_values(cur, INS_TEXT,
                               [(psycopg2.Binary(h), t, n) for h, (t, n) in texts.items()],
                               page_size=500)
            if rows:
                execute_values(cur, INS_VER,
                               [r[:11] + (psycopg2.Binary(r[11]),) for r in rows],
                               page_size=500)
            dates = [v[0] for v in versions]
            execute_values(cur, INS_STATE, [(
                leg_id, n_parsed, n_empty, len(rows),
                min(dates) if dates else None, max(dates) if dates else None,
                "revised-all-versions", datetime.now(timezone.utc))], page_size=1)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        return (leg_id, 0, 0, 0, f"{type(exc).__name__}: {exc}")
    return (leg_id, n_parsed, n_empty, len(rows), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--index-cache", default=None,
                    help="gzipped json of the pass-1 index (default: <zip>.index.json.gz)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="acts, not files")
    ap.add_argument("--only", action="append", help="load just these leg_ids")
    ap.add_argument("--only-type", action="append",
                    help="restrict to these types, e.g. --only-type ukpga")
    ap.add_argument("--exclude-type", action="append",
                    help="skip these types. The point of this is splitting one "
                         "archive across two machines: ukpga alone is 120.4 GB of "
                         "the 186.1 GB, so `--only-type ukpga` on the big box and "
                         "`--exclude-type ukpga` on the small one is a real split "
                         "rather than a cosmetic one. Both write the same tables "
                         "and never touch the same act, so the keys cannot collide.")
    ap.add_argument("--force", action="store_true",
                    help="reload acts already in uk_pit_load_state")
    ap.add_argument("--include-welsh", action="store_true",
                    help="also load the Welsh-language variants (no language column "
                         "exists yet, so they would collide — off by default)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DB_URL and not args.dry_run:
        sys.exit("DATABASE_URL is required")

    cache = args.index_cache or (args.zip + ".index.json.gz")
    idx = build_index(args.zip, cache, args.include_welsh)

    by_act = defaultdict(list)
    for name, (leg_id, vdate) in idx.items():
        by_act[leg_id].append((vdate, name))
    for leg_id in by_act:
        by_act[leg_id].sort()
    print(f"acts in archive: {len(by_act)}", flush=True)

    if args.only:
        by_act = {k: v for k, v in by_act.items() if k in set(args.only)}
    if args.only_type:
        types = set(args.only_type)
        by_act = {k: v for k, v in by_act.items() if k.split("/")[0] in types}
    if args.exclude_type:
        skip = set(args.exclude_type)
        by_act = {k: v for k, v in by_act.items() if k.split("/")[0] not in skip}

    done = set()
    registered = set()
    if not args.dry_run:
        conn = psycopg2.connect(DB_URL)
        with conn.cursor() as cur:
            if not args.force:
                cur.execute("SELECT leg_id FROM uk_pit_load_state")
                done = {r[0] for r in cur.fetchall()}
            cur.execute("SELECT id FROM uk_legislation")
            registered = {r[0] for r in cur.fetchall()}
        conn.close()
        if done:
            print(f"already loaded, skipping: {len(done)}", flush=True)

    jobs = [(k, v) for k, v in sorted(by_act.items()) if k not in done]
    if args.limit:
        jobs = jobs[:args.limit]
    outside = sum(1 for k, _ in jobs if registered and k not in registered)
    print(f"acts to load: {len(jobs)} | of those outside the register: {outside}",
          flush=True)

    tot = {"acts": 0, "versions": 0, "empty": 0, "rows": 0, "failed": 0}
    errors = []
    with Pool(args.workers, initializer=_worker_init,
              initargs=(args.zip, args.dry_run)) as pool:
        for leg_id, nv, ne, nr, err in pool.imap_unordered(process_act, jobs,
                                                           chunksize=4):
            tot["acts"] += 1
            if err:
                tot["failed"] += 1
                if len(errors) < 20:
                    errors.append(f"{leg_id}: {err}")
            else:
                tot["versions"] += nv
                tot["empty"] += ne
                tot["rows"] += nr
            if tot["acts"] % 250 == 0:
                print(f"  {tot['acts']}/{len(jobs)} acts | versions={tot['versions']} "
                      f"rows={tot['rows']} empty={tot['empty']} failed={tot['failed']}",
                      flush=True)

    print("\n=== summary", flush=True)
    for k in ("acts", "versions", "empty", "rows", "failed"):
        print(f"  {k:<10} {tot[k]}", flush=True)
    if outside:
        print(f"  {'outside':<10} {outside} acts have no row in uk_legislation "
              f"(retained EU law and anything else stage 1 never enumerated)",
              flush=True)
    for e in errors:
        print(f"  ! {e}", flush=True)


if __name__ == "__main__":
    main()
