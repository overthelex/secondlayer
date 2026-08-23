# CH pipeline

Backfills Swiss court decisions from entscheidsuche.ch into `ch_court_decisions`
on prod. Design: `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`.

## Where it runs

On prod, always. 8 cores shared with live traffic. What each stage actually
does about that, as the code does it (`chpipe/throttle.py`):

| stage     | workers                  | priority | `CHPIPE_LOAD_CEILING` |
|-----------|--------------------------|----------|-----------------------|
| `index`   | `CHPIPE_HTTP_CONCURRENCY` (12) | `nice 10` | not checked — I/O bound |
| `fetch`   | `CHPIPE_HTTP_CONCURRENCY` (12) | `nice 10` | not checked — I/O bound |
| `extract` | `CHPIPE_CPU_WORKERS` (3) | `nice 10` | **checked before each batch** |
| `ocr`     | `CHPIPE_OCR_WORKERS` (2) | `nice 19` | **checked before each batch** |
| `load`    | 1                        | inherited | not checked — one UPDATE per row |

The ceiling is a *claiming* guard, not a preemption: a stage that finds the
one-minute load average at or above `CHPIPE_LOAD_CEILING` (default 6.0) stops
taking on new work and sleeps 60s at a time, while work already in flight
finishes rather than being abandoned half-done. Set the ceiling to `0` to
disable it — an explicit opt-out for a maintenance window, not the default.

`extract` is the one that most needs it: measured at roughly 17 CPU-hours for
800,000 documents, it occupies about 4 of 8 cores at `cpu_workers=3` and runs
for hours. `nice` alone only decides who wins a contended core; it does not
stop three worker threads filling every core in the first place.

Renicing happens in each stage's `main()`, never in `run()`: `os.nice()` is
irreversible for a non-root process, so a `run()` that renices permanently
drags down anything that calls it.

### Why `CHPIPE_CPU_WORKERS` above 3 buys nothing

`extract` spends about 50 ms per document inside `pdftotext`, which is a
subprocess and releases the GIL, and about 28 ms in pure Python (lxml text
extraction, control-character stripping, tokenising and scoring), which holds
it. The GIL-held portion is the ceiling: at `cpu_workers=3` throughput is
already ~36 documents/second against an ideal of ~38, so a fourth worker adds
contention and roughly nothing else. Raise `CHPIPE_HTTP_CONCURRENCY` if you
want the pipeline to go faster; `CHPIPE_CPU_WORKERS` is not the lever.

## Stages

    index   enumerate documents, write metadata, fill decision_date
    fetch   download the body (html preferred, pdf otherwise)
    extract body -> text, with a measured quality score
    ocr     re-read the pdfs whose text layer failed the gate
    load    read the stored text back and promote the row to loaded

Re-running `index` is the normal ongoing operation (spec section 10) and is
safe: a row already at `fetched`, `extracted`, `ocr_pending` or `loaded`
keeps its stage and only has its metadata refreshed. Rows at `indexed` or
`failed` are re-queued, which is the point — a re-index is exactly the event
that can give a failed row a body it did not have before.

`extract` deletes a PDF once its text is stored, per spec section 8, unless
the document was routed to OCR or the quality was below the threshold.
`CHPIPE_KEEP_RAW_PDF=1` keeps everything: use it for Gate A, and any time
you might want to re-run extraction without re-downloading ~160 GB from a
volunteer-run mirror. HTML bodies are always kept.

Each stage claims rows from the `stage` column with `FOR UPDATE SKIP LOCKED`.
That reduces overlap between concurrent processes, but it is **not** a
distributed lock: `db.connect()` opens the connection with `autocommit=True`,
so the row lock is released the instant the claiming `SELECT` statement
completes, not when the claiming process finishes its work. A second process
started moments later can claim the same rows before the first one writes
them back. **One process per stage is the supported mode.** Do not run two
copies of the same stage against the same spider (or against "all spiders")
concurrently; running different stages concurrently (e.g. `fetch` for one
spider while `extract` runs for another) is fine, since they claim from
different `stage` values.

## Running one

    chmod +x run-stage.sh
    ./run-stage.sh index                # all 54 spiders
    ./run-stage.sh index CH_BVGer       # one spider
    ./run-stage.sh fetch CH_BVGer       # one spider

`index`'s spider filter went through `CHPIPE_SPIDER` from the start for
`fetch`/`extract`/`ocr`/`load`, but `index_stage.py`'s `__main__` originally
read `sys.argv` instead and never looked at the env var — so
`./run-stage.sh index CH_BVGer` silently walked all 54 spiders. Fixed: its
`__main__` now honours `CHPIPE_SPIDER` (used by `run-stage.sh`, which never
passes argv) and still accepts multiple spiders via argv for a direct
invocation (`python -m chpipe.stages.index_stage SpiderA SpiderB`, useful
when driving `index` by hand instead of through the wrapper).

Under supervision, so it survives a disconnect and is visible:

    tmux new -d -s ch-fetch './run-stage.sh fetch'
    tmux ls
    tail -f /data/ch-corpus/logs/fetch.log

Liveness check, since a tmux session outliving its process looks identical to
a healthy one:

    pgrep -af 'chpipe.stages' | grep -v pgrep

## Retrying failures

`failed` is reachable from five places, so a failed row records both WHY
(`last_error`) and WHERE (`failed_stage`). Read both before retrying:

    psql -c "SELECT failed_stage, count(*) FROM ch_court_decisions
             WHERE stage='failed' GROUP BY 1 ORDER BY 2 DESC"

    psql -c "SELECT failed_stage, last_error, count(*) FROM ch_court_decisions
             WHERE stage='failed' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20"

(`chpipe.db.failed_by_stage(conn)` is the first of those as a function.)

Then, once the cause is understood:

    python3 -c "from chpipe.config import Settings; from chpipe import db; \
                c=db.connect(Settings.from_env()); print(db.retry_failed(c))"

`retry_failed()` with no stage returns **each row to the stage it actually
failed in**. Do not pass a stage unless you mean it: the earlier version of
this section hardcoded `'indexed'`, which sends an OCR-terminal row back to
the front of the queue and re-runs days of OCR on a document that has
already been read twice.

`last_error` is preserved across a retry — it is the evidence the decision
to retry was based on, and clearing it on the way out would destroy it.
`stage_updated_at` IS touched, so a retried row does not look stale to the
progress checks below. Rows whose `failed_stage` is NULL are skipped: they
never entered a queue stage (`index` found neither HTML nor PDF for them),
so they need another `index` run, not another `fetch`.

### Retry timing

A failed row is not offered again immediately. Per spec section 8 it waits
**1 minute after the first failure, 5 after the second, 30 after the third**
(`CHPIPE_RETRY_BACKOFF_MINUTES`, default `1,5,30`; set it to an empty value
to disable). This is enforced in `db.claim` against `stage_updated_at`,
which `db.fail` already stamps — no extra column. Without it a 30-second
source hiccup burns a document's whole retry budget within seconds of the
same run and retires it as permanently broken.

A consequence worth knowing at the keyboard: a row does not exhaust its
three attempts inside one `run()` any more. It fails, the run drains, and
the row is picked up by a later run. Schedule stages to be re-run rather
than expecting one invocation to finish everything.

## Gates

Never report coverage without these. See `chpipe/reports.py`.

- **Gate A** (`reports.gate_a`) — HTML/PDF/OCR split and mean quality on a
  sample, before committing to a full run.
- **Gate B** — `trg_jstats` counts the mass NULL -> text `UPDATE` correctly.
  That transition is performed by **`extract`**, not by `load`: migration 156
  attaches the trigger `AFTER INSERT OR DELETE OR UPDATE OF full_text`, and
  `load` only writes `stage`. Measuring Gate B around a `load` run reports a
  delta of exactly zero and reads as a dead trigger. See
  `tests/test_jstats_trigger.py`, which measures both directions against the
  real trigger function.
- **Gate C** (`reports.quality_distribution`) — the distribution of the
  quality score itself, never a bare count of "rows with text".
- **Gate D** (`reports.completeness`) — our counts against entscheidsuche's
  own daily snapshot (`/docs/Snapshots/{date}.json`: `total` map and
  `total_alle` grand total). Returns three independently-scoped pieces —
  read `corpus` first. See the section below for why.

### Gate D: read `corpus`, not just `per_spider`

`Snapshots.total` is not a flat per-spider count. Checked against the
2026-08-20 snapshot (`total_alle: 793,500`), it is three nested views of the
*same* 793,500 documents, mixed into one flat dict of 519 keys, and each
view independently sums to `total_alle`:

- 28 top-level keys, one per canton plus `CH` (e.g. `ZH: 84411`) — a
  cantonal rollup.
- 131 mid-level keys, one per court (e.g. `ZH_OG: 29503`, `GE_CJ: 88373`,
  `CH_BGer: 177809`) — this is the granularity that actually corresponds to
  a spider.
- 360 leaf keys, one per chamber within a court (e.g. `CH_BGer_001: 27404`)
  — children of the mid-level keys, already counted there.

Of our 54 spiders (`index_stage.ALL_SPIDERS`), only **7** match a snapshot
key by exact string: `CH_BGE`, `CH_BGer`, `CH_BSTG`, `CH_VB`, `SH_OG`,
`TA_SST`, `TG_OG`. That is a coincidence of naming, not a mapping — those 7
happen to be spelled the same way in both systems. The other **47 spiders
have no matching key at all**, because entscheidsuche's court-level keys use
a different, shorter naming convention (`ZH_OG` vs. our `ZH_Obergericht`,
`GE_CJ` vs. our `GE_Gerichte`, `VD_TC` vs. our `VD_FindInfo`/`VD_Omni`,
`BE_VG` vs. our `BE_Verwaltungsgericht`, `TI_TRAC`/`TI_TCAS` vs. our
`TI_Gerichte`, and so on). At the correct like-for-like level (the 131
mid-level, one-per-court keys, which alone sum to `total_alle`), the 7
name-matched courts account for 216,963 of 793,500 documents — **27.3%** of
the corpus. A gate that only reported the 7 matched spiders would be worse
than no gate: a clean result would read as "the backfill is done" while
actually covering about a quarter of the corpus, and the other 72.7% would
never surface.

Rather than guess a `spider -> snapshot key` mapping across that nested
structure (fragile — a new naming quirk fails silently), `reports.completeness()`
now returns three pieces so the gate states its own coverage instead of
hiding it:

- **`corpus`** — `{ours, theirs, gap_pct, needs_investigation}`, our total
  row count against `total_alle`. Exact, level-independent, does not depend
  on any name match. **This is the number that actually answers "did we get
  everything" — always check it first.**
- **`per_spider`** — one row per snapshot key that matches a known spider
  name, unchanged in meaning from before (still `{spider, ours, theirs,
  gap_pct, needs_investigation}`, still a >1% gap flags
  `needs_investigation`). Only covers those 7-ish name-matched spiders — a
  clean `per_spider` on its own proves nothing about the rest.
- **`uncovered`** — `{key_count, docs, share_pct}` for the snapshot keys
  that match no known spider name at all — the gate's own blind spot,
  stated rather than dropped. Because `total` mixes the three nested levels
  above, `uncovered.share_pct` sums values from more than one level at once
  and can legitimately read over 100% — that is the nested structure
  showing through, not a bug. Do not read it as "percent of the corpus
  missing"; read `corpus.gap_pct` for that.

Call it as `reports.completeness(conn, snap["total"], snap["total_alle"])`.

## Deferred to the supervised operations phase

Everything below requires a human at the keyboard watching prod, not another
`chpipe` commit. Work through it in order; do not skip Gate A or Gate B to
save time before a full run.

- [ ] **Apply migration 196 to prod BY HAND, in a maintenance window.**
      `mcp_backend/src/migrations/196_ch_court_pipeline.sql` adds the queue
      columns and re-enrols all 678,165 existing rows (most of them back
      into `indexed`, since the existing CH_BGer text is mojibake — see the
      migration's own comment). Do **not** leave this to the migration
      runner on a normal deploy: the enrolment `UPDATE` runs a regex over
      `full_text`, which detoasts roughly 165,000 full judgment texts on a
      2,229 MB table, and the three `CREATE INDEX` statements take locks on
      a table serving live queries. Together that is minutes of heavy I/O
      and lock contention in the middle of whatever else the deploy is
      doing.

      Run it in a window, with a statement timeout, and watch it:

          SET statement_timeout = '30min';
          \i 196_ch_court_pipeline.sql

      Consider running the three `CREATE INDEX` statements separately with
      `CONCURRENTLY` (they cannot be `CONCURRENTLY` inside the file, since
      that cannot run in a transaction block). Afterwards check the
      enrolment against what the migration comment predicts:

          SELECT stage, count(*) FROM ch_court_decisions GROUP BY 1;
- [ ] **Verify the legacy `ecli` format BEFORE running `index`.** Every
      upsert keys on `ON CONFLICT (ecli)` and builds its key as
      `ECLI:CH:{spider}:{doc_id}` (`es_document.parse`). If the 678,165 rows
      already on prod use any other shape, `index` inserts 678,165 duplicates
      instead of healing the existing rows, and `doc_id` stays NULL on the
      originals — which means `db.claim` will never hand them out and the
      backfill silently covers only the new copies. Run:

          SELECT count(*) AS total,
                 count(*) FILTER (WHERE ecli LIKE 'ECLI:CH:%')            AS ch_prefixed,
                 count(*) FILTER (WHERE ecli = 'ECLI:CH:' || spider || ':' ||
                                         split_part(ecli, ':', 4))        AS spider_shaped
            FROM ch_court_decisions;

          SELECT spider, min(ecli), max(ecli) FROM ch_court_decisions
           GROUP BY 1 ORDER BY 1;

      Read the second query's samples by eye against
      `ECLI:CH:{spider}:{doc_id}` — do not accept the first query's counts
      alone. **`tests/test_es_document.py::test_ecli_is_stable_with_the_existing_678k_rows`
      is not evidence for this**: it asserts the format against the very
      function that produces it, so it is a tautology. Nothing in this repo
      has ever read a real `ecli` off prod.

- [ ] **Check how many rows `index` failed to key.** After `index`, before
      `fetch`:

          SELECT stage, count(*) FROM ch_court_decisions
           WHERE doc_id IS NULL GROUP BY 1;

      `db.claim` refuses rows with a NULL `doc_id` (it cannot write them
      back, so claiming them is an endless loop), and every claiming stage
      logs this count at start-up. A non-zero number here is work that will
      never be done: either the `ecli` shapes did not match, or those
      documents have been withdrawn from the entscheidsuche listing and
      cannot be re-indexed at all. Decide which, in writing, before
      declaring the backfill complete.

- [ ] **Gate B: confirm `trg_jstats` on the mass NULL -> text `UPDATE`.**
      Measure it around **`extract`**, not `load`. The trigger is
      `AFTER INSERT OR DELETE OR UPDATE OF full_text` (migration 156);
      `load` writes only `stage`, so a Gate B run against `load` measures a
      delta of exactly zero and looks like a broken trigger.

      Snapshot both numbers before a small `extract` run
      (`CHPIPE_LIMIT=500`):

          SELECT fulltext_decisions FROM v_jurisdiction_fulltext_stats
           WHERE jurisdiction_code = 'CH';
          SELECT count(*) FROM ch_court_decisions WHERE full_text IS NOT NULL;

      Run `extract`, then take both again. **The delta to expect is the
      number of extracted rows whose `full_text` was NULL beforehand, not
      `ExtractReport.extracted`.** The 165,363 CH_BGer rows already carry
      (mojibake) text, so re-extracting them is text -> text:
      `(OLD.full_text IS NULL) <> (NEW.full_text IS NULL)` is false and the
      counter correctly does not move. Count the NULLs first if you want an
      exact expectation:

          SELECT count(*) FROM ch_court_decisions
           WHERE stage = 'fetched' AND full_text IS NULL;

      The check that always holds, and the one spec section 9 actually
      asks for, is that the two numbers above **agree with each other**
      afterwards. If they diverge, the trigger has drifted and
      `v_jurisdiction_fulltext_stats` cannot be trusted for CH.
- [ ] **Confirm tesseract's `deu`/`fra`/`ita` language packs on the prod
      box.** `ocr_stage` will silently produce garbage (or fail every row)
      if a pack is missing. `tesseract --list-langs` before the first real
      `ocr` run; install any of `tesseract-ocr-deu`, `tesseract-ocr-fra`,
      `tesseract-ocr-ita` that are absent. Confirm `pdfinfo` is there too
      (`pdfinfo -v`): it ships in the same `poppler-utils` package as
      `pdftoppm` and `pdftotext`, and `ocr` uses it to get a page count so
      it can render one page at a time.

- [ ] **Watch `$CHPIPE_RAW_DIR/.ocr-tmp` during the `ocr` run.** Page images
      go there, on the raw corpus volume, not in `/tmp` on the root
      filesystem. One page at 300 dpi is ~8 MB and is deleted as soon as
      tesseract has read it, so at `ocr_workers=2` the steady state is tens
      of megabytes. If that directory grows into gigabytes, a run died
      without cleaning up; `find $CHPIPE_RAW_DIR/.ocr-tmp -name
      'chpipe-ocr-*' -mmin +120` finds the orphans, and nothing may delete
      them while an `ocr` process is alive (`pgrep -af chpipe.stages.ocr`).
- [ ] **Gate A on a 2,000-document sample, with `CHPIPE_KEEP_RAW_PDF=1`.**
      Run `index` -> `fetch` -> `extract` for a handful of spiders capped
      around 2,000 documents total, then read `chpipe.reports.gate_a(conn)`.
      Look specifically at `by_source`, `ocr_pending` and `mean_quality`
      before committing to the full backfill — this is the cheap check that
      catches a systemic extraction problem before it burns hours on the
      full corpus. **Set `CHPIPE_KEEP_RAW_PDF=1` for the sample**: `extract`
      otherwise deletes each PDF once its text is stored (spec section 8),
      and a Gate A finding you cannot open the source document for is not
      much of a finding. `mean_quality` is `None` when nothing was measured
      — that means the gate has no population, not that the quality was
      zero.
- [ ] **Gate D against real production counts.** Run
      `reports.completeness(conn, snap["total"], snap["total_alle"])`
      against a fresh `/docs/Snapshots/{date}.json` and prod's real
      `ch_court_decisions`. Check `result["corpus"]` first — that is the
      real completeness number. `result["per_spider"]` is only trustworthy
      for the ~7 name-matched spiders; `result["uncovered"]` tells you how
      much of the raw snapshot dict still has no spider mapping (expect a
      large, possibly >100%, number per the nested-hierarchy note above —
      that is expected, not a new bug).
- [ ] **The full stage runs themselves**, in order, under `tmux`, one stage
      at a time per the "Running one" section above: `index`, `fetch`,
      `extract`, `ocr`, `load`. Confirm liveness with `pgrep -af
      'chpipe.stages'` after each backgrounded start, and check
      `stage_updated_at` progress periodically rather than assuming a tmux
      session that is still listed is still doing work.
