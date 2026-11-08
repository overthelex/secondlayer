#!/usr/bin/env python3
"""Stage 5: incremental sync of the Polish act register from the ELI change feed.

    GET https://api.sejm.gov.pl/eli/changes/acts?since=<ts>&limit=500&offset=<n>

returns every act whose record changed after <ts>, one row per act (an act
changed twice appears once, with its latest changeDate), in changeDate order.
Measured 2026-11-07: since=2026-08-14 -> totalCount 5001, not capped.

The feed row is close to a detail payload but not equal to one: it has no
legalStatusDate, and that field is what dates a consolidated text. So the feed
is used only as the WORKLIST, and every changed act goes back through the
ordinary details pass of harvest_eli_register.py.

Steps, each idempotent, so a killed run is resumed by running it again:

  1. page the feed from --since (default: max(change_date) in pl_acts minus
     --overlap-days) and upsert each row as a listing stub; new acts appear here
  2. for every act in the feed: drop its outgoing edges and clear
     detail_fetched_at, so the details pass refetches it and the edges are
     replaced, not accumulated (the source does remove edges)
  3. details pass (harvest_eli_register.do_details) over detail_fetched_at IS NULL
  4. rebuild the snapshot chain (build_pl_snapshots.sql, pure SQL)
  5. drop verdict-903 text rows whose snapshot now HAS html: the source
     publishes PDF first and HTML weeks or months later (all DU 2025-2026 acts
     were PDF-only on 2026-11-07), so "no html" is a state to re-poll, not a fact
  6. texts pass (harvest_eli_texts.py --mark-no-html, then the fetch pass)

Step 2 runs before step 3 and the worklist is the database, so if the run dies
after step 2 the next run still refetches those acts even though its own --since
no longer reaches them.

On cthulhu, against pg-lawrider (lawrider.pl):

  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/sync_eli_changes.py --dry-run
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/sync_eli_changes.py
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402
import harvest_eli_register as R  # noqa: E402

PAGE = 500


def eli_of(item):
    """The feed carries ELI on most rows; fall back to publisher/year/pos."""
    if item.get("ELI"):
        return item["ELI"]
    return f"{item['publisher']}/{item['year']}/{item['pos']}"


def default_since(overlap_days):
    """Latest change_date we hold, minus an overlap.

    The overlap covers acts the source stamps with a changeDate slightly in the
    past, and acts we missed because the feed shifted under offset paging.
    Refetching a few hundred acts twice is cheap; missing one is silent.
    """
    v = plprod.scalar(
        "SELECT to_char(max(change_date) - interval '%d days', "
        "'YYYY-MM-DD\"T\"HH24:MI:SS') FROM pl_acts" % overlap_days)
    if not v:
        raise SystemExit("pl_acts has no change_date; run the full harvest first")
    return v


def page_feed(since):
    """All feed rows since <since>, deduplicated by ELI.

    Offset paging over a list that is ordered by changeDate can skip a row: an
    act changed while we page moves to the end and every later row shifts one
    place left. The end of the list is re-read on the next pass, so the only
    risk is a skip, and a second full pass when the count comes up short closes
    it.
    """
    seen = {}
    total = None
    for attempt in range(2):
        offset = 0
        while True:
            d, code = R.fetch_json(
                f"changes/acts?since={since}&limit={PAGE}&offset={offset}")
            if d is None:
                raise SystemExit(f"FATAL: change feed offset={offset} -> HTTP {code}")
            total = d.get("totalCount")
            items = d.get("items") or []
            for it in items:
                seen[eli_of(it)] = it
            offset += len(items)
            if not items or offset >= (total or 0):
                break
        if total is None or len(seen) >= total:
            break
        print(f"feed gave {len(seen)} distinct of totalCount={total}; second pass",
              flush=True)
    if total is not None and len(seen) < total:
        print(f"WARNING: {total - len(seen)} feed rows not seen after two passes",
              file=sys.stderr)
    return list(seen.values()), total


def sql_list(elis):
    return ",".join("'" + e.replace("'", "''") + "'" for e in elis)


def run_sql_file(path):
    with open(path, encoding="utf-8") as f:
        sql = f.read()
    r = subprocess.run(plprod._argv(), input=sql, capture_output=True, text=True,
                       timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"{os.path.basename(path)} failed: {r.stderr.strip()[:600]}")


def counts_snapshot():
    return plprod.psql(
        "SELECT (SELECT count(*) FROM pl_acts) acts, "
        "(SELECT count(*) FROM pl_act_references) refs, "
        "(SELECT count(*) FROM pl_act_snapshots) snaps, "
        "(SELECT count(*) FROM pl_snapshot_texts WHERE http_status=200) texts_ok, "
        "(SELECT count(*) FROM pl_act_articles) articles").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="ISO timestamp, e.g. 2026-08-14T00:00:00")
    ap.add_argument("--overlap-days", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true",
                    help="page the feed and report; write nothing")
    ap.add_argument("--skip-texts", action="store_true")
    a = ap.parse_args()

    t0 = time.time()
    since = a.since or default_since(a.overlap_days)
    items, total = page_feed(since)
    elis = [eli_of(i) for i in items]
    known = set()
    for i in range(0, len(elis), 2000):
        chunk = elis[i:i + 2000]
        known |= {r[0] for r in plprod.rows_of(
            f"SELECT eli FROM pl_acts WHERE eli IN ({sql_list(chunk)})")}
    new = [e for e in elis if e not in known]
    print(f"since={since} feed totalCount={total} distinct={len(elis)} "
          f"new={len(new)} changed={len(elis) - len(new)}", flush=True)
    if a.dry_run:
        print("new sample:", new[:10])
        return 0
    if not elis:
        print("nothing changed")
        return 0

    print("before:", counts_snapshot(), flush=True)

    # 1. stubs (new acts get a row; changed acts get the feed's fresher fields)
    rows = [R.act_row(dict(i, ELI=eli_of(i))) for i in items]
    plprod.upsert_rows("pl_acts", R.ACT_COLS, rows, ["eli"], prefer_new=True)

    # 2. reset the changed acts so the details pass picks them up
    for i in range(0, len(elis), 2000):
        chunk = sql_list(elis[i:i + 2000])
        plprod.psql(
            "BEGIN; "
            f"DELETE FROM pl_act_references WHERE src_eli IN ({chunk}); "
            f"UPDATE pl_acts SET detail_fetched_at = NULL WHERE eli IN ({chunk}); "
            "COMMIT;")

    # 3. details
    rc = R.do_details(0)
    if rc != 0:
        # do_details stops when a whole batch fails, which is also how it ends
        # when only a handful of permanently failing acts are left (they sort to
        # the head of every batch). A few stragglers must not block the rebuild;
        # they keep detail_fetched_at NULL and the next run retries them.
        left = int(plprod.scalar(
            "SELECT count(*) FROM pl_acts WHERE detail_fetched_at IS NULL"))
        if left > max(20, len(elis) // 100):
            print(f"FATAL: {left} acts still without details", file=sys.stderr)
            return rc
        print(f"WARNING: {left} acts without details, retried next run",
              file=sys.stderr)

    # 4. snapshot chain
    run_sql_file(os.path.join(HERE, "build_pl_snapshots.sql"))
    print("snapshots rebuilt", flush=True)

    # 5. re-poll snapshots whose HTML has appeared since we marked them 903
    out = plprod.psql(
        "DELETE FROM pl_snapshot_texts t USING pl_act_snapshots s "
        "WHERE s.snapshot_eli = t.snapshot_eli AND t.http_status = 903 "
        "AND s.has_html RETURNING 1")
    flipped = sum(1 for line in out.splitlines() if line.strip() == "1")
    print(f"snapshots that gained html: {flipped}", flush=True)

    # 6. texts
    if not a.skip_texts:
        texts = os.path.join(HERE, "harvest_eli_texts.py")
        for extra in (["--mark-no-html"], []):
            r = subprocess.run([sys.executable, texts, *extra])
            if r.returncode != 0:
                return r.returncode

    print("after: ", counts_snapshot(), flush=True)
    print(f"sync done in {int(time.time() - t0)} s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
