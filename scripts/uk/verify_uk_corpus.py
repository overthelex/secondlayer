#!/usr/bin/env python3
"""Verify the UK corpus after a refresh. Exits non-zero if anything is wrong.

This exists because of a failure this project has already had. `cron-edrsr-sync.yml`
records it in its own header: the workflow pointed at a runner label nothing carried
any more, every scheduled run sat in the queue until GitHub cancelled it, "and nothing
said so" — noticed only when the corpus turned out to hold zero decisions for a month.
A schedule existing is not the same as data arriving, so the schedule asserts.

Every check below was run against the live corpus before being written down. That
matters more than it sounds: the first version of the interval check counted 3,811
"gaps or overlaps" and would have failed on day one. Reading one of them showed
anaw/2016/1/schedule/12/paragraph/13B standing 2016-01-19 to 2016-08-05, absent, then
standing again from 2022-07-14 — a paragraph repealed and re-enacted, which is a fact
about the law and not a defect in the load. The real invariant is that intervals never
OVERLAP; gaps are data. Measured: 0 overlaps, 3,811 gaps.

Usage:
  DATABASE_URL=... python3 verify_uk_corpus.py            # check, record, exit 0/1
  DATABASE_URL=... python3 verify_uk_corpus.py --no-record
  DATABASE_URL=... python3 verify_uk_corpus.py --max-age-days 14
"""

import argparse
import json
import os
import sys
from datetime import timedelta

import psycopg2

DB_URL = os.environ.get("DATABASE_URL")

# A refresh should never shrink the corpus. It legitimately can by a hair — the source
# withdraws an instrument, an act's text is republished shorter — so the gate is a
# percentage rather than strict monotonicity, and any drop at all is still reported.
SHRINK_TOLERANCE = 0.005

# Absolute floors. The shrink gate compares against the previous run, so on the FIRST
# run — or after someone truncates the history table — an empty corpus would sail
# through with "no baseline yet". These are deliberately far below the real figures
# (238,926 / 129,897 / 1,637,159 on 2026-09-18): they are not a quality bar, they are
# a "did the data survive at all" bar.
FLOORS = {
    "acts":           150_000,
    "acts_with_text":  80_000,
    "provisions":   1_000_000,
    "pit_acts":        40_000,
    "pit_rows":     1_000_000,
    "effects":      1_000_000,
}

COUNTS = {
    "acts":           "SELECT count(*) FROM uk_legislation",
    "acts_with_text": "SELECT count(DISTINCT leg_id) FROM uk_legislation_provisions",
    "provisions":     "SELECT count(*) FROM uk_legislation_provisions",
    "pit_acts":       "SELECT count(*) FROM uk_pit_load_state",
    "pit_rows":       "SELECT count(*) FROM uk_provision_version",
    "pit_texts":      "SELECT count(*) FROM uk_provision_text",
    "effects":        "SELECT count(*) FROM uk_legislation_effects",
}

INVARIANTS = [
    (
        "no overlapping intervals",
        """SELECT count(*) FROM (
             SELECT valid_to, lead(valid_from) OVER (
                      PARTITION BY leg_id, provision_key ORDER BY valid_from) AS nxt
               FROM uk_provision_version) s
            WHERE nxt IS NOT NULL AND nxt < valid_to""",
        "two versions of the same provision claim the same day, so 'as at date D' has "
        "more than one answer",
    ),
    (
        "an open interval is always the last one",
        """SELECT count(*) FROM (
             SELECT valid_to, lead(valid_from) OVER (
                      PARTITION BY leg_id, provision_key ORDER BY valid_from) AS nxt
               FROM uk_provision_version) s
            WHERE valid_to IS NULL AND nxt IS NOT NULL""",
        "a provision is recorded as still standing and then superseded, which reads as "
        "current text that is not current",
    ),
    (
        "at most one open interval per provision",
        """SELECT count(*) FROM (
             SELECT leg_id, provision_key,
                    count(*) FILTER (WHERE valid_to IS NULL) AS open_intervals
               FROM uk_provision_version GROUP BY 1, 2) s
            WHERE open_intervals > 1""",
        "the same provision is current in two different wordings at once",
    ),
    (
        "one current snapshot per act",
        """SELECT count(*) FROM (
             SELECT leg_id FROM uk_legislation_provisions
              GROUP BY leg_id HAVING count(DISTINCT valid_from) > 1) s""",
        "uk_legislation_provisions holds CURRENT text; a second valid_from means an old "
        "revision is sitting there claiming to be current too",
    ),
    (
        "no point-in-time rows for acts the loader never recorded",
        """SELECT count(DISTINCT v.leg_id) FROM uk_provision_version v
            LEFT JOIN uk_pit_load_state s ON s.leg_id = v.leg_id
            WHERE s.leg_id IS NULL""",
        "rows from a run that died before its checkpoint — they will never be refreshed, "
        "because the loader plans from the checkpoint",
    ),
    (
        "every act in the register can reach its text",
        """SELECT count(*) FROM uk_legislation l
            WHERE NOT EXISTS (SELECT 1 FROM uk_legislation_versions v
                               WHERE v.leg_id = l.id)
              AND l.document_status IS NOT NULL
              AND left(l.document_status, 6) <> 'fetch-'
              AND l.year IS NOT NULL""",
        "an act with no version row has no xml_url and no text pass, so it is invisible "
        "to every later stage — 21,972 of them accumulated unnoticed before 2026-09-19 "
        "(LEXAI-2052). The fetch-599 pair is excluded: those are a retry queue, not a "
        "hole",
    ),
    (
        "no act stranded between the version paths",
        """SELECT count(*) FROM uk_legislation l
            WHERE l.document_status IS NOT NULL
              AND left(l.document_status, 6) <> 'fetch-'
              AND EXISTS (SELECT 1 FROM uk_legislation_versions v
                           WHERE v.leg_id = l.id)
              AND NOT EXISTS (SELECT 1 FROM uk_legislation_versions v
                               WHERE v.leg_id = l.id AND v.is_current)
              AND NOT EXISTS (SELECT 1 FROM uk_legislation_provisions p
                               WHERE p.leg_id = l.id)""",
        "an act with versions, none current and no text falls through both paths: the "
        "base-version insert skips it because it has versions, and the stage 3 worklist "
        "never sees it because that requires is_current. Reported rather than repaired "
        "automatically — promoting a version is irreversible, and picking the wrong one "
        "labels the in-force text with a prospective date",
    ),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age-days", type=int, default=10,
                    help="fail if the register has not been touched in this many days")
    ap.add_argument("--no-record", action="store_true",
                    help="do not write a row to uk_corpus_check_run")
    args = ap.parse_args()

    if not DB_URL:
        sys.exit("DATABASE_URL is required")

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    cur = conn.cursor()

    failures, warnings = [], []

    counts = {}
    for name, sql in COUNTS.items():
        cur.execute(sql)
        counts[name] = cur.fetchone()[0]
    print("=== counts")
    for k, v in counts.items():
        print(f"  {k:<16} {v:>12,}")

    print("=== floors")
    for k, floor in FLOORS.items():
        if counts[k] < floor:
            failures.append({"check": f"{k} below floor", "value": counts[k],
                             "floor": floor,
                             "why": "the corpus is a fraction of its known size — this "
                                    "passes the shrink gate on a first run, so the floor "
                                    "is the only thing standing between an empty load "
                                    "and a green tick"})
            print(f"  FAIL  {k}: {counts[k]:,} < {floor:,}")
        else:
            print(f"  ok    {k} >= {floor:,}")

    print("=== invariants")
    for title, sql, why in INVARIANTS:
        cur.execute(sql)
        bad = cur.fetchone()[0]
        if bad:
            failures.append({"check": title, "violations": int(bad), "why": why})
            print(f"  FAIL  {title}: {bad:,} — {why}")
        else:
            print(f"  ok    {title}")

    # Freshness. The refresh can succeed while doing nothing at all: if the scheduler
    # stopped firing, every query above still passes on a corpus frozen in August.
    cur.execute("SELECT max(updated_at), now() - max(updated_at) FROM uk_legislation")
    newest, age = cur.fetchone()
    print("=== freshness")
    print(f"  register last touched {newest} ({age} ago)")
    # Compared as a timedelta, not in whole days. `age.days > n` silently ignores the
    # fractional part, so --max-age-days 0 passed on a register two hours stale and the
    # gate could not be exercised at all — a detector nobody has seen fire is not a
    # detector. With a timedelta, 0 means "must have been written just now", which is
    # exactly what makes it testable.
    limit = timedelta(days=args.max_age_days)
    if age is None or age > limit:
        failures.append({
            "check": "register freshness",
            "age": None if age is None else str(age),
            "why": f"uk_legislation has not been written in over {args.max_age_days} days — "
                   "the refresh is not running, or it is running and importing nothing",
        })
        print(f"  FAIL  register freshness: {age} old")
    else:
        print("  ok    register freshness")

    # Stage 6 has its own clock. The register check above passes on a run where stage 5
    # worked and stage 6 died, because uk_legislation was written either way.
    cur.execute("SELECT max(loaded_at), now() - max(loaded_at) FROM uk_pit_load_state")
    pit_newest, pit_age = cur.fetchone()
    print(f"  point-in-time last loaded {pit_newest} ({pit_age} ago)")
    # A WARNING, not a failure, and deliberately so: stage 6 writes nothing in a week
    # where no act gained a version, so an old loaded_at is ordinary quiet as often as
    # it is a stalled stage. Sixty days of silence across 62,866 acts is worth a look
    # without being worth a red build.
    if pit_age is None or pit_age > timedelta(days=60):
        warnings.append({
            "check": "point-in-time freshness",
            "age": None if pit_age is None else str(pit_age),
            "why": "uk_pit_load_state has not been written in 60 days — either nothing "
                   "was revised in that time, or stage 6 is failing while stage 5 keeps "
                   "the register looking healthy",
        })
        print(f"  warn  point-in-time freshness: {pit_age} old")
    else:
        print("  ok    point-in-time freshness")

    # Regression against the previous run.
    print("=== against the previous run")
    cur.execute("""SELECT ran_at, acts, acts_with_text, provisions, pit_acts, pit_rows,
                          pit_texts, effects
                     FROM uk_corpus_check_run ORDER BY ran_at DESC LIMIT 1""")
    prev = cur.fetchone()
    if not prev:
        print("  (no baseline yet — this run becomes it)")
    else:
        keys = ["acts", "acts_with_text", "provisions", "pit_acts", "pit_rows",
                "pit_texts", "effects"]
        for i, k in enumerate(keys, start=1):
            before, now_ = prev[i], counts[k]
            delta = now_ - before
            if delta < 0:
                drop = -delta / before if before else 1.0
                entry = {"check": f"{k} shrank", "before": before, "after": now_,
                         "drop_pct": round(drop * 100, 3)}
                if drop > SHRINK_TOLERANCE:
                    failures.append({**entry, "why": "a refresh that removes this much is "
                                                     "a bug, not an upstream correction"})
                    print(f"  FAIL  {k}: {before:,} -> {now_:,} ({drop*100:.2f}% smaller)")
                else:
                    warnings.append(entry)
                    print(f"  warn  {k}: {before:,} -> {now_:,} (within tolerance)")
            else:
                print(f"  ok    {k}: {before:,} -> {now_:,} (+{delta:,})")

    ok = not failures
    if not args.no_record:
        cur.execute(
            """INSERT INTO uk_corpus_check_run
                 (ok, acts, acts_with_text, provisions, pit_acts, pit_rows, pit_texts,
                  effects, newest_register, failures, warnings)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (ok, counts["acts"], counts["acts_with_text"], counts["provisions"],
             counts["pit_acts"], counts["pit_rows"], counts["pit_texts"],
             counts["effects"], newest, json.dumps(failures), json.dumps(warnings)))

    print(f"\n=== {'PASS' if ok else 'FAIL'} — {len(failures)} failure(s), "
          f"{len(warnings)} warning(s)")
    for f in failures:
        print(f"  ! {json.dumps(f, default=str)}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
