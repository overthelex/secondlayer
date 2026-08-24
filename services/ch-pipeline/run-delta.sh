#!/usr/bin/env bash
# Daily delta for both Swiss corpora. Installed as a cron entry (see README's
# "Deltas" section) so, unlike run-stage.sh, nobody is watching this run
# happen. Three things a supervised, one-off invocation gets away without and
# an unattended nightly job cannot:
#
#   1. Two copies must never run at once. A stage's own row-locking is
#      explicitly NOT a distributed lock (see the "Running one" section of
#      the README) -- db.connect() runs autocommit, so the claiming SELECT's
#      lock is gone the instant it completes. A previous night's run still
#      going (a slow entscheidsuche mirror, a stuck SPARQL query) plus cron
#      firing the next scheduled run on top of it is exactly the concurrent-
#      claim scenario that guarantee refuses to cover. flock -n on a fixed
#      path makes the second start a no-op instead of a race.
#   2. The log must not grow forever. run-stage.sh's log is fine because a
#      human starts it and can rm it; this one runs 365+ times a year with
#      nobody watching, so unbounded append is a slow disk leak. Rotate
#      before appending, once the log passes a size threshold, and keep only
#      one prior generation -- enough to compare last night against the
#      night before without keeping a de facto unbounded history.
#   3. A failure must be LOUD in the one place an operator actually looks
#      (`tail delta.log`), not just a nonzero exit code cron may or may not
#      mail anywhere. Every run is bracketed with a start marker and an
#      explicit OK/FAILED line carrying the exit status, via a trap so a
#      crash inside python still gets one.
set -euo pipefail

LOG_DIR=/data/ch-corpus/logs
LOG="$LOG_DIR/delta.log"
LOCK="$LOG_DIR/delta.lock"
MAX_LOG_BYTES=$((20 * 1024 * 1024))
mkdir -p "$LOG_DIR"

# Single-instance guard. -n (non-blocking): a second start while the first
# is still running exits immediately rather than queuing up behind it --
# queuing would just mean two runs back to back the moment the first one
# ever runs long, which is the opposite of what a nightly cadence wants.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "=== $(date -Is) already running (lock $LOCK held); skipping ===" >> "$LOG"
  exit 0
fi

# Rotate before this run's own output would push the file past the ceiling,
# not after -- so the file being appended to is never the one being rotated.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -ge "$MAX_LOG_BYTES" ]; then
  mv -f "$LOG" "$LOG.1"
fi

{
  # Anything from here on that fails under `set -e` -- a missing
  # .env.prod line, a bad cd, chpipe.delta itself raising -- must still
  # print a FAILED line before the script exits, not just leave the log
  # hanging on a start marker with no explanation. A plain nonzero exit is
  # not enough on its own: this job has no MAILTO configured, so the log is
  # the only place a failure is visible.
  #
  # This trap DOES reach the log, and the reason is `set -euo pipefail` on
  # line 26, not the trap's position: a failing command inside the group
  # makes the shell exit from INSIDE it, while `>> "$LOG"` is still in
  # effect. (An EXIT trap in a script WITHOUT `set -e` would fire only after
  # the group completed and its redirection was torn down, and would land on
  # cron's discarded stdout -- which is what the OK path below has to work
  # around, and why the two paths are written differently.) Measured on bash
  # 3.2.57 and 5.3.0 over a failing payload, a missing POSTGRES_PASSWORD
  # line, a missing cd target and a signal-shaped exit 143; pinned by
  # tests/test_run_delta_sh.py, which runs this script and reads the log,
  # because the invariant rests on a `set -e` twelve lines away.
  #
  # `$?` is captured into `code` as the FIRST thing the trap does, before
  # anything else runs. Round 1 shipped `echo "... (exit $?)"` directly:
  # $(date -Is) is itself a command substitution, and bash evaluates it
  # before $? is expanded in the same command line, so by the time $?
  # appears in the string it is date's OWN exit status (usually 0), not the
  # status that triggered the trap. Verified by hand: a simulated exit 3
  # printed "FAILED (exit 0)" with the old form and "FAILED (exit 3)" with
  # this one.
  trap 'code=$?; echo "=== $(date -Is) delta finished: FAILED (exit $code) ==="' EXIT
  echo "=== $(date -Is) starting delta ==="

  PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
  export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
  export CHPIPE_RAW_DIR=/data/ch-corpus/raw
  # The delta runs unattended alongside live traffic, so it is quieter than a
  # supervised backfill: fewer HTTP connections, and fewer CPU workers for
  # extract (the one CPU-bound decisions stage this run reaches). OCR is not
  # part of this script at all -- see the README: documents that fail the
  # text-layer gate wait at ocr_pending for a supervised run, so an
  # unattended job can never quietly saturate the box trying to clear them.
  export CHPIPE_HTTP_CONCURRENCY=6
  export CHPIPE_CPU_WORKERS=2

  cd ~/SecondLayer/services/ch-pipeline
  # 9>&- closes the lock fd for python specifically, so it is never
  # inherited into that process (verified: without this, `os.listdir
  # ('/dev/fd')` inside python includes fd 9). The wrapper shell above still
  # holds it for its own entire lifetime -- that is what actually enforces
  # the mutex, for as long as this script is the thing running -- but there
  # is no reason for python, which knows nothing about the lock, to hold a
  # copy neither `flock` nor this script asked it to keep.
  python3 -m chpipe.delta 9>&-

  # Reached only on success. This is NOT a re-armed trap (round 1's bug):
  # `{ ... } >> "$LOG"` tears its redirection down once the compound command
  # finishes, and an EXIT trap only actually fires once the whole script
  # process truly exits -- by which point that redirection is already gone,
  # so a trap re-armed here would print to cron's discarded stdout instead
  # of the log. Verified by hand: re-arming here landed on the terminal;
  # clearing the trap and echoing directly, right here, lands in the log,
  # because it runs as an ordinary command while the redirection is still
  # live, not deferred to process-exit time.
  trap - EXIT
  echo "=== $(date -Is) delta finished: OK ==="
} >> "$LOG" 2>&1
