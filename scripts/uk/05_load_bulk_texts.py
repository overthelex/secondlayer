#!/usr/bin/env python3
"""Stage 5: load provision text from the research.legislation.gov.uk bulk archives.

Replaces the per-item crawl of stage 3 for everything the bulk collections carry.
The National Archives granted pre-release access to research.legislation.gov.uk on
2026-08-28 and publishes the whole statute book as zipped CLML, refreshed daily:

    /data/downloads/texts/{collection}/{format}/{collection}-{format}.zip

    enacted-epublished    4.55 GB    revised-all-versions   19.76 GB
    revised-current       2.50 GB    best-collection         1.34 GB

Why this exists rather than more of stage 3
-------------------------------------------
Stage 3 fetched /{id}/data.xml once per item at 4 requests per second per address
and still left 40,636 devolved items with no text, because TNA reduced the crawl
rate limits under load and started refusing us with an empty HTTP 202 (see the
note at the imports of 03_harvest_texts.py). The same content arrives here as two
downloads that took under two minutes.

Measured against the register on 2026-08-31, before loading anything:

    acts in the register                          199,067
    acts with text from the stage 3 crawl          70,296
    acts the bulk carries text for                 89,965
    of those, currently text-less                  19,842   <- what this recovers
    acts still with no text anywhere              108,929
    ids in the bulk that are NOT in the register    39,794   <- retained EU law,
                                                                eur/eudn/eudr, a
                                                                gap for later

⚠ The bulk does not supersede the crawl everywhere. nisro, uksro, gbla, ukmo and
aosp are essentially absent from these two collections (1 of 8,792 nisro, 0 of
307 uksro, 0 of 273 gbla), so the pre-1948 secondary and local material stays
text-less. best-collection has not been checked yet and may hold some of it.

Identity comes from IdURI inside each file, never from the filename: the archive
names regnal items like `aep-Hen3c23-52-23-revised-data.xml`, which no sane rule
maps back to `aep/Hen3/23`, while every file carries
IdURI="http://www.legislation.gov.uk/id/{path}" in its first kilobyte.

Usage:
  python3 05_load_bulk_texts.py --zip /path/revised-current-xml.zip --dry-run
  python3 05_load_bulk_texts.py --zip a.zip --zip b.zip
  python3 05_load_bulk_texts.py --zip a.zip --only-missing
"""

import argparse
import importlib.util
import os
import re
import sys
import zipfile
from datetime import date

import psycopg2
from psycopg2.extras import execute_values

DB_URL = os.environ.get("DATABASE_URL")

ID_RE = re.compile(rb'IdURI="https?://(?:www\.)?legislation\.gov\.uk/id/([^"]+)"')

# The provision parser is stage 3's, imported rather than copied: the two must not
# drift, because a difference in how a <P1> becomes a row would silently produce a
# corpus whose crawled half and bulk half are shaped differently.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "uk_stage3", os.path.join(_here, "03_harvest_texts.py"))
stage3 = importlib.util.module_from_spec(_spec)
_saved_argv, sys.argv = sys.argv, [sys.argv[0]]
_spec.loader.exec_module(stage3)
sys.argv = _saved_argv

INS_PROV = stage3.INS_PROV

# --- register metadata, for --with-register -------------------------------
#
# Every member carries the whole register record in its <ukm:Metadata> block, so
# the weekly refresh does not need the Atom crawl stage 1 used. ⚠ That block is
# NOT within the first few kilobytes for primary legislation: the source puts one
# <ukm:UnappliedEffect> per outstanding editorial change inside it, and the Town
# and Country Planning Act 1990 has enough of them to push the metadata past
# 40 KB. Read the whole member — which this stage already does for the text.
META = {
    "title":             re.compile(rb"<dc:title>([^<]{1,1000})</dc:title>"),
    "number":            re.compile(rb"<ukm:Number\s+Value=\"([^\"]*)\""),
    "year":              re.compile(rb"<ukm:Year\s+Value=\"(\d{4})\""),
    "made_date":         re.compile(rb"<ukm:Made\s+Date=\"(\d{4}-\d{2}-\d{2})\""),
    "enactment_date":    re.compile(rb"<ukm:EnactmentDate\s+Date=\"(\d{4}-\d{2}-\d{2})\""),
    "coming_into_force": re.compile(rb"<ukm:ComingIntoForce>\s*<ukm:DateTime\s+Date=\"(\d{4}-\d{2}-\d{2})\""),
    "document_status":   re.compile(rb"<ukm:DocumentStatus\s+Value=\"([^\"]*)\""),
    "valid_date":        re.compile(rb"<dct:valid>(\d{4}-\d{2}-\d{2})"),
    "extent":            re.compile(rb"RestrictExtent=\"([^\"]*)\""),
}


def parse_meta(body, leg_id):
    out = {k: None for k in META}
    for k, rx in META.items():
        m = rx.search(body)
        if m:
            out[k] = m.group(1).decode("utf-8", "replace").strip() or None
    parts = leg_id.split("/")
    out["leg_type"] = parts[0]
    # Regnal citations put a session in the year slot (aep/Hen3/23), which is not
    # an integer and must stay NULL rather than raise.
    try:
        out["year"] = int(out["year"] or parts[1])
    except (ValueError, IndexError, TypeError):
        out["year"] = None
    out["number"] = out["number"] or (parts[2] if len(parts) > 2 else None)
    out["source_url"] = "https://www.legislation.gov.uk/" + leg_id
    return out


# ⚠⚠ version_count, unapplied_effects, first_version and last_version are NOT in
# this statement and must never be. They are stage 2's, computed from a complete
# crawl, and a refresh that recomputed unapplied_effects from an incomplete
# source once zeroed it on 33,434 acts.
#
# Everything else is fill-only — COALESCE keeps whatever the crawl established — with
# two deliberate exceptions, because these two are the fields that MOVE:
#   document_status: an item goes 'final' -> 'revised' as the editorial team works on
#     it, so the bulk value is newer than the register's by construction;
#   valid_date: GREATEST, because it is the date of the edition in hand and a refresh
#     that left it behind would describe the text we just loaded with an older date.
# year and number are filled when missing but never changed: they are identity.
UPSERT_REG = """
INSERT INTO uk_legislation
    (id, leg_type, year, number, title, document_status, extent,
     enactment_date, made_date, coming_into_force, valid_date, source_url)
VALUES %s
ON CONFLICT (id) DO UPDATE SET
    title             = COALESCE(uk_legislation.title, EXCLUDED.title),
    year              = COALESCE(uk_legislation.year, EXCLUDED.year),
    number            = COALESCE(uk_legislation.number, EXCLUDED.number),
    document_status   = COALESCE(EXCLUDED.document_status, uk_legislation.document_status),
    extent            = COALESCE(uk_legislation.extent, EXCLUDED.extent),
    enactment_date    = COALESCE(uk_legislation.enactment_date, EXCLUDED.enactment_date),
    made_date         = COALESCE(uk_legislation.made_date, EXCLUDED.made_date),
    coming_into_force = COALESCE(uk_legislation.coming_into_force, EXCLUDED.coming_into_force),
    valid_date        = GREATEST(uk_legislation.valid_date, EXCLUDED.valid_date),
    source_url        = COALESCE(uk_legislation.source_url, EXCLUDED.source_url),
    updated_at        = now()
"""

# valid_from for a bulk row. Prefer the version the register already knows is
# current, so crawled and bulk rows land on the same key instead of creating a
# second, parallel version of the same text. Fall back to the item's own dates.
VALID_FROM = """
SELECT l.id,
       COALESCE(
         (SELECT v.valid_from FROM uk_legislation_versions v
           WHERE v.leg_id = l.id AND v.is_current ORDER BY v.valid_from DESC LIMIT 1),
         (SELECT max(v.valid_from) FROM uk_legislation_versions v WHERE v.leg_id = l.id),
         l.valid_date, l.made_date, l.enactment_date, l.coming_into_force,
         make_date(l.year, 1, 1))
  FROM uk_legislation l
 WHERE l.year IS NOT NULL
"""

BASE_VERSION = """
INSERT INTO uk_legislation_versions
    (leg_id, valid_from, version_label, version_uri, is_current, http_status)
VALUES %s
ON CONFLICT (leg_id, valid_from) DO NOTHING
"""

# Put the register's version counters back in step with the versions table.
#
# This is NOT the thing the warning above forbids. That forbids deriving these
# from bulk member metadata, which is an incomplete source and once zeroed
# unapplied_effects on 33,434 acts. This derives them from
# uk_legislation_versions — the table that IS the authority on versions — and
# touches only the three fields that table can answer for. unapplied_effects
# stays out: nothing local can compute it.
#
# Why it is needed: this loader writes version rows and deliberately does not
# maintain the counters per act, because recomputing them inside the load would
# be a full-table churn on every run. The cost of that choice is that the
# counters drift, and on 2026-09-19 they had drifted badly — wrong for 194,781
# of 238,926 acts, 194,100 of them claiming zero while having rows. The column
# is served to callers through registry-catalog, so it is not an internal
# detail, and 03_harvest_texts.py used to key a destructive insert off it.
#
# Only rows that actually differ are written, and none of the three columns is
# indexed (the indexes are id, leg_type+year, title, title trigram, status), so
# this stays HOT and leaves the GIN index alone.
RECONCILE = """
UPDATE uk_legislation l
   SET version_count = s.n,
       first_version = s.lo,
       last_version  = s.hi,
       updated_at    = now()
  FROM (SELECT leg_id, count(*) n, min(valid_from) lo, max(valid_from) hi
          FROM uk_legislation_versions GROUP BY leg_id) s
 WHERE s.leg_id = l.id
   AND (l.version_count IS DISTINCT FROM s.n
     OR l.first_version IS DISTINCT FROM s.lo
     OR l.last_version  IS DISTINCT FROM s.hi)
"""

# And acts whose versions have all gone away, or that never had any: the counter
# should say zero rather than keep a number from a crawl that no longer holds.
RECONCILE_EMPTY = """
UPDATE uk_legislation l
   SET version_count = 0, first_version = NULL, last_version = NULL,
       updated_at = now()
 WHERE NOT EXISTS (SELECT 1 FROM uk_legislation_versions v WHERE v.leg_id = l.id)
   AND (l.version_count <> 0 OR l.first_version IS NOT NULL
        OR l.last_version IS NOT NULL)
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", action="append", required=True,
                    help="bulk archive; repeat for several")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip items that already have provisions")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=2000)
    ap.add_argument("--replace", action="store_true",
                    help="delete an act's existing provisions before inserting "
                         "the ones just parsed. uk_legislation_provisions is "
                         "meant to hold CURRENT text, and on a refresh an act "
                         "whose revision date moved would otherwise keep its old "
                         "snapshot alongside the new one under a different "
                         "valid_from — two 'current' versions, no way to tell "
                         "which. Only ever deletes when the new parse actually "
                         "produced provisions, so a malformed file cannot empty "
                         "an act. History lives in stage 6, not here.")
    ap.add_argument("--with-register", action="store_true",
                    help="also upsert uk_legislation from each member's own "
                         "<ukm:Metadata>. This is what makes the weekly refresh "
                         "possible without the Atom crawl of stage 1, and it is "
                         "how ids the register has never seen — retained EU law, "
                         "anything published since the last harvest — get a row "
                         "at all. Existing rows are only filled where they are "
                         "empty; version_count and unapplied_effects are never "
                         "touched by the upsert — see --reconcile-counters for "
                         "how the first three are put right afterwards.")
    ap.add_argument("--reconcile-counters", action="store_true",
                    help="after loading, recompute version_count, first_version "
                         "and last_version from uk_legislation_versions for the "
                         "rows where they disagree. Not derived from the bulk "
                         "metadata — derived from our own versions table, which "
                         "is what those three fields describe. unapplied_effects "
                         "is untouched: nothing local can compute it.")
    ap.add_argument("--reconcile-only", action="store_true",
                    help="do only that, read no archive. --zip is still required "
                         "by argparse; pass any path, it is not opened.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DB_URL and not args.dry_run:
        sys.exit("DATABASE_URL is required")

    if args.reconcile_only:
        conn = psycopg2.connect(DB_URL)
        with conn, conn.cursor() as cur:
            cur.execute(RECONCILE);       n1 = cur.rowcount
            cur.execute(RECONCILE_EMPTY); n2 = cur.rowcount
        print(f"counters reconciled: {n1} acts from their versions, "
              f"{n2} reset to zero", flush=True)
        conn.close()
        return

    conn = cur = None
    valid_from = {}
    have_text = set()
    if not args.dry_run:
        conn = psycopg2.connect(DB_URL)
        # NOT autocommit. --replace deletes an act's provisions and then inserts the
        # replacements; under autocommit the delete commits on its own, so a crash or a
        # failed insert in between leaves the act with no text at all and nothing to say
        # so. One transaction per flush makes the swap atomic.
        conn.autocommit = False
        cur = conn.cursor()
        cur.execute(VALID_FROM)
        valid_from = {r[0]: r[1] for r in cur.fetchall()}
        print(f"register items with a resolvable version date: {len(valid_from)}",
              flush=True)
        if args.only_missing:
            cur.execute("SELECT DISTINCT leg_id FROM uk_legislation_provisions")
            have_text = {r[0] for r in cur.fetchall()}
            print(f"already carrying text: {len(have_text)}", flush=True)

    rows = []
    reg_rows = []
    replaced = []
    stats = {"files": 0, "no_id": 0, "not_in_register": 0, "skipped": 0,
             "parsed": 0, "empty": 0, "provisions": 0, "failed": 0,
             "registered": 0}
    seen_versions = []
    # Acts written earlier in this run. revised-current is processed first and is
    # the better text where both archives carry an act, so enacted-epublished must
    # not overwrite it.
    done = set()

    def flush():
        # Deduplicate on the primary key before the upsert. ON CONFLICT DO UPDATE
        # raises "cannot affect row a second time" if one statement carries the
        # same (leg_id, valid_from, ord) twice, which happens as soon as an act
        # appears in both archives — revised-current and enacted-epublished
        # overlap heavily — and aborts the whole batch rather than that one row.
        if args.dry_run:
            rows.clear()
            reg_rows.clear()
            replaced.clear()
            seen_versions.clear()
            return
        if reg_rows:
            # Same dedupe reason as below: one act appears in both archives, and
            # two rows with the same id in one statement abort it entirely.
            uniq_r = {r[0]: r for r in reg_rows}
            execute_values(cur, UPSERT_REG, list(uniq_r.values()), page_size=1000)
            reg_rows.clear()
        if replaced:
            cur.execute("DELETE FROM uk_legislation_provisions WHERE leg_id = ANY(%s)",
                        (replaced,))
            replaced.clear()
        if not rows:
            # The register upsert and any deletes above are still open work; commit
            # them here or they sit in a transaction until some later flush decides to.
            conn.commit()
            seen_versions.clear()
            return
        if seen_versions:
            uniq_v = {(r[0], r[1]): r for r in seen_versions}
            execute_values(cur, BASE_VERSION, list(uniq_v.values()), page_size=1000)
            seen_versions.clear()
        uniq = {(r[0], r[1], r[2]): r for r in rows}
        execute_values(cur, INS_PROV, list(uniq.values()), page_size=1000)
        conn.commit()
        rows.clear()

    for zp in args.zip:
        z = zipfile.ZipFile(zp)
        names = [f for f in z.namelist() if f.endswith(".xml")]
        print(f"\n=== {os.path.basename(zp)}: {len(names)} xml", flush=True)
        for name in names:
            if args.limit and stats["files"] >= args.limit:
                break
            stats["files"] += 1
            try:
                body = z.open(name).read()
            except Exception:
                stats["failed"] += 1
                continue
            m = ID_RE.search(body[:2000])
            if not m:
                stats["no_id"] += 1
                continue
            leg_id = m.group(1).decode().strip("/")
            meta = parse_meta(body, leg_id) if args.with_register else None
            if leg_id not in valid_from and not args.dry_run:
                if not args.with_register:
                    # Retained EU law and anything else stage 1 never enumerated.
                    stats["not_in_register"] += 1
                    continue
                stats["registered"] += 1
            if meta:
                # Recorded even when the text is skipped below: an act whose text
                # we already hold can still be missing a title or a date.
                reg_rows.append((
                    leg_id, meta["leg_type"], meta["year"], meta["number"],
                    meta["title"], meta["document_status"], meta["extent"],
                    meta["enactment_date"], meta["made_date"],
                    meta["coming_into_force"], meta["valid_date"],
                    meta["source_url"]))
                if len(reg_rows) >= args.batch:
                    flush()
            if leg_id in have_text or leg_id in done:
                stats["skipped"] += 1
                continue
            vf = (valid_from.get(leg_id)
                  or (meta and (meta["valid_date"] or meta["made_date"]
                                or meta["enactment_date"] or meta["coming_into_force"]))
                  or date(1900, 1, 1))
            try:
                provs = stage3.parse_provisions(body.decode("utf-8", "replace"), leg_id)
            except Exception:
                stats["failed"] += 1
                continue
            stats["parsed"] += 1
            if not provs:
                stats["empty"] += 1
                continue
            if args.replace:
                # Safe because we are inside `if provs:` — an act is only cleared
                # when there is something to put back.
                replaced.append(leg_id)
            seen_versions.append((leg_id, vf, "bulk", None, False, 200))
            done.add(leg_id)
            for p in provs:
                # the parser's own ord, not a fresh enumerate: it skips P1s with no
                # text, and renumbering here would give the bulk half a different
                # key from the crawled half for the same act
                rows.append((leg_id, vf, p["ord"], p.get("provision_label"),
                             p.get("provision_type"), p.get("provision_uri"),
                             p.get("part"), p.get("chapter"), p.get("schedule_no"),
                             p.get("title"), p.get("text"),
                             len(p.get("text") or "")))
                stats["provisions"] += 1
            if len(rows) >= args.batch:
                flush()
            if stats["files"] % 5000 == 0:
                print(f"  {stats['files']} files | parsed={stats['parsed']} "
                      f"provisions={stats['provisions']} empty={stats['empty']} "
                      f"outside={stats['not_in_register']}", flush=True)
        flush()

    flush()

    # After the load, not during it: the counters describe the finished state,
    # and recomputing them per act mid-run is the churn this loader avoids.
    if args.reconcile_counters and conn is not None and not args.dry_run:
        with conn, conn.cursor() as c2:
            c2.execute(RECONCILE);       n1 = c2.rowcount
            c2.execute(RECONCILE_EMPTY); n2 = c2.rowcount
        print(f"\ncounters reconciled: {n1} acts from their versions, "
              f"{n2} reset to zero", flush=True)

    print("\n=== summary", flush=True)
    for k in ("files", "parsed", "provisions", "empty", "skipped",
              "registered", "not_in_register", "no_id", "failed"):
        print(f"  {k:<16} {stats[k]}", flush=True)


if __name__ == "__main__":
    main()
