# CH pipeline

Backfills Swiss court decisions from entscheidsuche.ch into `ch_court_decisions`
on prod. Design: `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`.

## Where it runs

On prod, always. 8 cores shared with live traffic, so stages are throttled by
`CHPIPE_CPU_WORKERS`, `CHPIPE_OCR_WORKERS` and `CHPIPE_LOAD_CEILING`.

## Stages

    index   enumerate documents, write metadata, fill decision_date
    fetch   download the body (html preferred, pdf otherwise)
    extract body -> text, with a measured quality score
    ocr     re-read the pdfs whose text layer failed the gate
    load    promote extracted rows to loaded

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
    ./run-stage.sh fetch CH_BVGer       # one spider

Under supervision, so it survives a disconnect and is visible:

    tmux new -d -s ch-fetch './run-stage.sh fetch'
    tmux ls
    tail -f /data/ch-corpus/logs/fetch.log

Liveness check, since a tmux session outliving its process looks identical to
a healthy one:

    pgrep -af 'chpipe.stages' | grep -v pgrep

## Retrying failures

Failed rows keep their `last_error`. Read it before retrying:

    psql -c "SELECT last_error, count(*) FROM ch_court_decisions
             WHERE stage='failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 20"

Then, once the cause is understood:

    python3 -c "from chpipe.config import Settings; from chpipe import db; \
                c=db.connect(Settings.from_env()); print(db.retry_failed(c,'indexed'))"

## Gates

Never report coverage without these. See `chpipe/reports.py`.

- **Gate A** (`reports.gate_a`) — HTML/PDF/OCR split and mean quality on a
  sample, before committing to a full run.
- **Gate B** — `trg_jstats` fires correctly on the mass NULL -> text `UPDATE`
  that `load` performs. Not automated; verify by hand against
  `v_jurisdiction_fulltext_stats` before and after a `load` run.
- **Gate C** (`reports.quality_distribution`) — the distribution of the
  quality score itself, never a bare count of "rows with text".
- **Gate D** (`reports.completeness`) — our per-spider counts against
  entscheidsuche's own daily snapshot (`/docs/Snapshots/{date}.json`,
  `total` key). Read the caveat below before trusting its output.

### Gate D: the snapshot key mismatch is real and material

`reports.completeness()` matches snapshot keys to our `spider` values by
exact string equality. That undercounts badly, and the shape of the mismatch
matters:

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
`TI_Gerichte`, and so on).

At the correct like-for-like level (the 131 mid-level, one-per-court keys,
which alone sum to `total_alle`), the 7 name-matched courts account for
216,963 of 793,500 documents — **27.3%** of the corpus. The remaining 124
mid-level keys — **576,537 documents, 72.7% of `total_alle`** — have no
name match and are therefore invisible to `reports.completeness()` as a
credit to any of our spiders.

Worse: `reports.completeness()` as written does not stop at the mid level —
it iterates every one of the 519 keys in `total` (top, mid, and leaf mixed
together) and treats each one as if it were a spider name. Run against a
real snapshot, every single key comes back `needs_investigation: True`
(verified locally with an empty table, where every key trivially reports a
100% gap; against real prod counts the 7 name-matched keys will show a real
number, but the other 512 will still all read as "100% missing", because
`ours.get(that_key, 0)` is always 0 for a string that is never a `spider`
value in our table).

**Conclusion: do not run Gate D as `reports.completeness()` is currently
written and read the "spiders short by >1%" count as a real number** — as
written it will report on the order of ~500 false failures out of 519,
dominated by keys that were never meant to match a spider name 1:1 (canton
rollups, chamber leaves) plus 47 real courts that need a name mapping this
codebase does not yet have. Before Gate D is trustworthy, someone needs to
build a `spider -> {matching snapshot key(s)}` table for the 47 unmapped
spiders and change `reports.completeness()` to compare against it instead of
raw string equality — out of scope for this task; this section exists so the
gap is visible before anyone relies on the gate's raw output.

## Deferred to the supervised operations phase

Everything below requires a human at the keyboard watching prod, not another
`chpipe` commit. Work through it in order; do not skip Gate A or Gate B to
save time before a full run.

- [ ] **Apply migration 196 to prod.** `mcp_backend/src/migrations/196_ch_court_pipeline.sql`
      adds the queue columns and re-enrolls all 678,165 existing rows (most
      of them back into `indexed`, since the existing CH_BGer text is
      mojibake — see the migration's own comment). Confirm the migration
      runner picked it up and check `SELECT stage, count(*) FROM
      ch_court_decisions GROUP BY 1` afterwards against the numbers the
      migration comment predicts.
- [ ] **Gate B: confirm `trg_jstats` on the mass NULL -> text `UPDATE`.**
      `load` is the only stage that flips rows to `'loaded'`, which is the
      transition the trigger watches. Snapshot
      `v_jurisdiction_fulltext_stats` before running `load` on a small
      batch (`CHPIPE_LIMIT=500`), run it, and confirm the delta matches the
      number of rows actually promoted (`LoadReport.loaded`), not the
      number claimed.
- [ ] **Confirm tesseract's `deu`/`fra`/`ita` language packs on the prod
      box.** `ocr_stage` will silently produce garbage (or fail every row)
      if a pack is missing. `tesseract --list-langs` before the first real
      `ocr` run; install any of `tesseract-ocr-deu`, `tesseract-ocr-fra`,
      `tesseract-ocr-ita` that are absent.
- [ ] **Gate A on a 2,000-document sample.** Run `index` -> `fetch` ->
      `extract` for a handful of spiders capped around 2,000 documents
      total, then read `chpipe.reports.gate_a(conn)`. Look specifically at
      `by_source`, `ocr_pending` and `mean_quality` before committing to the
      full backfill — this is the cheap check that catches a systemic
      extraction problem before it burns hours on the full corpus.
- [ ] **Gate D against real production counts**, with the caveat above in
      hand: at minimum, check the 7 name-matched spiders directly (they are
      trustworthy as written), and treat any "spiders short by >1%" number
      from the unmodified `reports.completeness()` as noise, not signal,
      until the court-code mapping is built.
- [ ] **The full stage runs themselves**, in order, under `tmux`, one stage
      at a time per the "Running one" section above: `index`, `fetch`,
      `extract`, `ocr`, `load`. Confirm liveness with `pgrep -af
      'chpipe.stages'` after each backgrounded start, and check
      `stage_updated_at` progress periodically rather than assuming a tmux
      session that is still listed is still doing work.
