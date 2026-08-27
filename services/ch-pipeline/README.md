# CH pipeline

Three pipelines over one package:

- **Decisions** — backfills Swiss court decisions from entscheidsuche.ch into
  `ch_court_decisions` (migration 196). Stages `index`, `fetch`, `extract`,
  `ocr`, `load`.
- **Legislation** — builds the Swiss federal legislation corpus from Fedlex
  into `ch_act` / `ch_act_version` / `ch_act_article` / `ch_act_change`
  (migration 197), and projects it back into the old flat `ch_legislation`.
  Stages `acts`, `versions`, `fetch-xml`, `parse-akn`, `diff`,
  `project-legacy`. **[Jump to the legislation half](#the-legislation-half).**
- **Registries** — the company register (Zefix, from LINDAS) and the
  Official Gazette of Commerce (SHAB), into `ch_zefix_companies` /
  `ch_zefix_municipality` / `ch_shab_publications` (migration 202, extending
  migration 129). Stages `zefix`, `shab-list`,
  `shab-detail`. **[Jump to the registries half](#the-registries-half).**

Design: `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`.

# The decisions half

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

`0` is the *only* way to ask for that. A non-finite value is refused at
start-up (`Settings.from_env`): `float()` parses `nan` happily and every
comparison against `nan` is False, so `CHPIPE_LOAD_CEILING=nan` disabled the
guard entirely while still printing in the log as though it were in effect.

`CHPIPE_HTTP_CONCURRENCY` has **no** such opt-out, and `0` is refused for the
opposite reason: `asyncio.Semaphore(0)` never grants, so a stage set to 0
would await forever with no error, no timeout and no log line. The
ceiling's "0 disables the guard" convention is exactly what makes that a
mistake worth refusing loudly.

`extract` is the one that most needs it: measured at roughly 17 CPU-hours for
800,000 documents, it occupies about 4 of 8 cores at `cpu_workers=3` and runs
for hours. `nice` alone only decides who wins a contended core; it does not
stop three worker threads filling every core in the first place.

Renicing happens in each stage's `main()`, never in `run()`: `os.nice()` is
irreversible for a non-root process, so a `run()` that renices permanently
drags down anything that calls it.

### What `CHPIPE_CPU_WORKERS` actually buys

Measured per document on the real 39-page Zug PDF fixture, 15 repeats
(Apple Silicon laptop, not the prod box — read the ratios, not the absolute
milliseconds):

    pdftotext subprocess (GIL RELEASED)          58.82 ms
    decode + strip control characters (held)      0.45 ms
    text_quality.score (held)                    18.33 ms
    ------------------------------------------------------
    GIL-held per PDF document                    18.78 ms
    GIL-free per PDF document                    58.82 ms

Total 77.6 ms of CPU per document, which is where the ~17 CPU-hours for
800,000 documents comes from (800,000 x 0.0776 s = 17.2 CPU-hours).

The GIL-held share is the parallelism ceiling: however many threads run,
they cannot overlap those 18.78 ms. That caps `extract` at roughly 53
documents/second no matter what, and the knee is at about **4** workers
(~51/s), not 3 (~39/s).

**The default stays 3 anyway, and it is a policy choice, not a throughput
one.** The box has 8 cores and is serving live traffic; three workers plus
their `pdftotext` children is already about half of it. Raise
`CHPIPE_CPU_WORKERS` only in a window where nothing else needs the machine,
and expect no more than ~35% over the default before the GIL flattens the
curve.

(This is one of the numbers the control-character fix moved: before it, the
GIL-held share was ~29 ms and the ceiling really was at 3 workers. Anything
that shifts work between the two columns moves the knee, so re-measure
before changing this rather than trusting the table above.)

HTML documents are an order of magnitude cheaper: 0.16 ms to extract and
1.22 ms to score, all of it GIL-held, no subprocess at all.

## Stages

    index              enumerate documents, write metadata, fill decision_date
    fetch              download the body (html preferred, pdf otherwise)
    extract            body -> text, with a measured quality score
    ocr                re-read the pdfs whose text layer failed the gate
    load               read the stored text back and promote the row to loaded
    aliases            seed ch_act_alias from ch_act's own abbreviation, title
                       parentheses, and a curated map -- no spider, no argument
    citations          extract raw case/statute citations from `loaded` text
    citations-resolve  resolve those raw edges to acts, editions, articles
                       and court decisions -- no spider, no argument

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
    ./run-stage.sh citations CH_BVGer   # one spider -- same CHPIPE_SPIDER family
    ./run-stage.sh aliases              # no second argument
    ./run-stage.sh citations-resolve    # no second argument

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

## Deferred to the supervised operations phase (decisions)

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
- [ ] **A resumed `extract` over HTML written before the fetch-stage UTF-8
      guarantee will retire it, not just re-extract it.** `from_html()`
      requires `payload` to already be UTF-8; a non-UTF-8 body raises
      `UnicodeDecodeError` (see `chpipe/text_extract.py:192-201`), which
      `extract_stage`'s per-document guard turns into `db.fail()`. On a
      resumed run over raw HTML a pre-fix version of this pipeline wrote to
      `$CHPIPE_RAW_DIR`, that burns all three attempts and retires the
      document as `failed`, with no path back except deleting the file and
      re-fetching it.
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
- [ ] **Drop `idx_ch_court_fts` before `extract`, rebuild it after `load`.**
      It is a 2.5 GB GIN over `to_tsvector('simple', ... full_text ...)`,
      and every `full_text` UPDATE re-tokenises the document into it. On
      the first prod backfill that was the whole extract throughput:
      ~70 ms per row, serialised on the main thread, 850 docs/min with
      the box 95% idle -- six workers and a higher load ceiling moved it
      by 17%. Nothing reads the index today. Save the definition first:

          \copy (SELECT indexdef || ';' FROM pg_indexes WHERE indexname = 'idx_ch_court_fts') TO '/tmp/idx_ch_court_fts.rebuild.sql'
          DROP INDEX idx_ch_court_fts;

      and after the backfill rebuild it from that file with `CONCURRENTLY`
      added, in a window: GIN builds are single-threaded on PG16, so expect
      hours over 1.2M documents. The saved file from 24.08.2026 is at
      `/data/ch-corpus/idx_ch_court_fts.rebuild.sql` on the AWS box.
- [ ] **The full stage runs themselves**, in order, under `tmux`, one stage
      at a time per the "Running one" section above: `index`, `fetch`,
      `extract`, `ocr`, `load`. Confirm liveness with `pgrep -af
      'chpipe.stages'` after each backgrounded start, and check
      `stage_updated_at` progress periodically rather than assuming a tmux
      session that is still listed is still doing work.

# The legislation half

Swiss federal legislation from [Fedlex](https://fedlex.data.admin.ch), the
Confederation's own SPARQL endpoint and file store. Migration 197.

What it replaces: `ch_legislation` is a flat table keyed `(eli_uri, lang)`,
so it can hold exactly **one edition per act** and therefore no amendment
history whatsoever. Measured on prod, 5,382 of its 5,594 rows hold a CSS
blob rather than legislation text — the old importer built filestore URLs by
string pattern, got HTML error pages back, and a tag-stripping fallback
turned a stylesheet into "full text". 212 rows carry genuine Akoma Ntoso.

## Legislation stages

Run them in this order. Each is idempotent; re-running one is safe.

    acts            17,293 Systematic Compilation works -> ch_act
    versions        their consolidated editions         -> ch_act_version
    fetch-xml       download each edition's Akoma Ntoso XML
    parse-akn       XML -> ch_act_article + full_text
    diff            consecutive editions -> ch_act_change (the amendment log)
    provenance      AKN footnotes -> ch_article_provenance (the other one)
    as-bbl          Official Compilation + Federal Gazette -> ch_as_act
    basic-act       jolux:basicAct etc. -> ch_act_as_link
    project-legacy  latest parsed edition per (act, lang) -> ch_legislation

`acts` and `versions` are SPARQL walks and write straight through — they have
no queue. `fetch-xml` and `parse-akn` are queue stages over
`ch_act_version.stage` (`discovered` -> `fetched` -> `parsed`), with the same
claim/complete/fail discipline, the same retry backoff and the same
`failed` terminal state as the decisions queue. `diff`, `provenance` and
`project-legacy` read `parsed` rows in place and do not advance them.
`as-bbl` and `basic-act` are SPARQL walks over the Official Compilation and
do not touch the edition queue at all.

### What `ch_article_provenance` does and does not claim

`provenance` reads the `<authorialNote>` prose Fedlex embeds in the Akoma
Ntoso — "Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit
1. Juli 1991 (AS 1991 846; BBl 1986 II 354)" — because Fedlex publishes no
`amends` predicate at all. Together with `diff`'s computed change log these
are the only two sources of amendment history this corpus has.

**Read `anchor_level` before reading anything else.** Fedlex attaches an
insertion or an act-wide terminology change ONCE, to the enclosing
`<chapter>`/`<title>`/`<level>`/`<part>`/`<proviso>`/`<transitional>`, and
never repeats it on the articles beneath — 10.4% to 10.6% of the amendment
events in the three language editions of the OR, measured 2026-08-24. Those
rows carry `anchor_level = 'container'`, `e_id` naming the container, and
`container_articles` saying how many articles it holds. **A container row is
not a claim about any single article inside it.** A query about one
provision must filter `anchor_level = 'article'`; an act-level history wants
both.

They are stored that way rather than inherited by every article underneath
because inheritance fabricates. On the German OR it would have turned 782
rows into 1,590, and 498 of those 1,590 (31%) are contradicted by the
receiving article's own footnotes, which name a LATER amending act — worst
case, `part_3`'s "Fassung gemäss BG vom 18. Dez. 1936" landing on art. 964a,
a provision inserted in 2021.

One shape is promoted rather than kept as a container: a `<level>` whose only
article is its direct child, which is how Fedlex writes an ordinary article's
marginal-note heading. Measured on all three languages, every such case is a
direct parent of exactly one article, so the note names that article and
nothing else. 51 of the German OR's 93 container-attached events are this.

What is still dropped: a note with no eId-bearing ancestor at all (one
preamble note on the German and French OR, none on the Italian). It is still
in `ch_act_version.akn_xml` — unindexed, not lost.

The stage is a full replacement per edition, and that includes an edition
whose parse now yields nothing: re-running after a parser fix REMOVES rows
the fix invalidated, and the run report's `cleared` counter says how many
editions that happened to. An edition with no `akn_xml` at all is the one
case left alone — that is a hole in the corpus, not evidence about its
provenance — and it has its own counter, `versions_without_xml`, so a fetch
gap never hides inside `versions_without_notes`.

Resource discipline, as the code does it (`chpipe/throttle.py`), same table
as the decisions half above:

| stage            | priority  | `CHPIPE_LOAD_CEILING` |
|------------------|-----------|-----------------------|
| `acts`           | `nice 10` | not checked — bounded by Fedlex, not by cores |
| `versions`       | `nice 10` | not checked — same |
| `as-bbl`         | `nice 10` | not checked — same |
| `basic-act`      | `nice 10` | not checked — same |
| `fetch-xml`      | `nice 10` | not checked — network bound |
| `parse-akn`      | `nice 10` | **checked before each claim** |
| `diff`           | `nice 10` | **checked before each act** |
| `provenance`     | `nice 10` | **checked before each version** |
| `project-legacy` | `nice 10` | not checked — the load is Postgres-side, bounded by the batch size and the statement timeout |

`parse-akn` (12,033 lxml parses), `diff` (a corpus walk holding two article
sets per comparison) and `provenance` (an lxml walk over the same ~12,033
TOASTed `akn_xml` payloads) are the CPU stages; they get the ceiling for the
same reason `extract` does. The table listed six stages while the code ran
nine — `provenance` in particular reads as an unthrottled full-corpus lxml
walk when the code has taken `NICE_CPU` and the per-version capacity wait
since it was written. `throttle.py`'s own docstring says a stage added later
belongs in this list; three of them had not been added.

**`CHPIPE_CPU_WORKERS` is not read by any legislation stage.** All six are
single-threaded, so setting it before a parse-akn run changes nothing — the
knob belongs to `extract` and `ocr` on the decisions half. Threading a
per-item Postgres writer needs its own measurement, and the decisions half's
`CHPIPE_CPU_WORKERS=3` rests on a GIL-share number that does not transfer to
lxml. Turn the throughput of these two stages up with `CHPIPE_LOAD_CEILING`
and a quiet window, not with worker counts.

## Running one

    ./run-stage.sh acts
    ./run-stage.sh versions
    ./run-stage.sh fetch-xml
    ./run-stage.sh parse-akn
    ./run-stage.sh diff            # German; ./run-stage.sh diff fr for French
    ./run-stage.sh provenance      # same: language as the second argument
    ./run-stage.sh as-bbl
    ./run-stage.sh basic-act
    ./run-stage.sh project-legacy

Under `tmux`, and check liveness with `pgrep -af 'chpipe.stages'` — a tmux
session outliving its process looks identical to a healthy one.

`CHPIPE_LIMIT` caps `fetch-xml` and `parse-akn` (useful for a first small
run). `CHPIPE_LANG` selects `diff`'s language. Neither legislation stage
takes a spider; `run-stage.sh` rejects a second argument for the ones that
take none rather than exporting it and ignoring it.

## Retrying failed editions

The legislation queue has its **own** recovery pair. `db.retry_failed()` and
`db.failed_by_stage()` read `ch_court_decisions` and will answer 0 here,
which reads like "nothing to retry" rather than "wrong table":

    psql -c "SELECT failed_stage, count(*) FROM ch_act_version
             WHERE stage='failed' GROUP BY 1 ORDER BY 2 DESC"

    psql -c "SELECT failed_stage, last_error, count(*) FROM ch_act_version
             WHERE stage='failed' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20"

(`chpipe.db.failed_by_stage_versions(conn)` is the first of those as a
function.) Then, once the cause is understood:

    python3 -c "from chpipe.config import Settings; from chpipe import db; \
                c=db.connect(Settings.from_env()); print(db.retry_failed_versions(c))"

Same three rules as the decisions side: with no `stage` each row goes back to
the stage it actually died in, a row with a NULL `failed_stage` is left alone
(there is nowhere to send it), and `last_error` survives the retry because it
is the evidence the retry was based on. `act_id=` narrows a retry to one act.

Retry timing is `CHPIPE_RETRY_BACKOFF_MINUTES` (default `1,5,30`), enforced
in `db.claim_versions` against `stage_updated_at` — so a failed edition does
not exhaust three attempts inside one run. Schedule the stages to be re-run
rather than expecting one invocation to finish everything.

## Gate E, and its ceiling

`chpipe/reports_leg.py`. Three control acts whose shape is independently
known: **SR 220** (Code of Obligations), **SR 210** (Civil Code), **SR 311.0**
(Criminal Code).

    from chpipe import fedlex_queries as fq, reports_leg
    from chpipe.sparql import SparqlClient
    client = SparqlClient(fq.ENDPOINT)
    for row in reports_leg.cross_check_fedlex(reports_leg.gate_e(conn), client):
        print(row.get("coverage") or f"{row['sr_number']}: {row['note']}")

Live on 2026-08-24:

    220:   14 of 100 (XML: 14 of 14)
    210:   11 of  70 (XML: 11 of 11)
    311.0: 19 of 120 (XML: 19 of 20)

**Read the first pair.** It is this corpus against every consolidated edition
Fedlex publishes for the act. The parenthesised pair is this corpus against
the XML subset — and both sides of *that* comparison carry the same
XML-only limitation, so it can only ever confirm that we fetched what we
chose to look for. An earlier version of this gate printed only the
parenthesised pair, which made 14% coverage read as a green tick.

Both numbers are worth having. The XML pair is the only one that can catch
an edition this pipeline *could* have fetched and did not — which is what SR
311.0's 19-of-20 is, and it is diagnosed: consolidation `.../20190101`'s
German expression has a manifestation typed `userFormat=xml` with no
`isExemplifiedBy` triple at all, so there is genuinely no file to retrieve.
Its four siblings (pdf-a, html, doc, docx) all carry one. A mismatch here is
a prompt to diagnose exactly like that, not proof of a bug.

`found: False` on a control act means "not loaded into this database", not
"missing from the corpus" — expected on a partially seeded database, and the
row says so in its own `note`.

`reports_leg.corpus_summary(conn)` is the whole-corpus counterpart: acts, in
force, with an SR number, versions, parsed, articles, changes. Every number
is a `count(*)`; `n_live_tup` has been observed badly wrong on this database.

## What this corpus does not contain

Four scope limits. None is a defect, and each one is invisible from the
schema, so state them before quoting a number off these tables.

**1. XML editions only.** The corpus is built from consolidations Fedlex
serves as Akoma Ntoso XML — 12,033 of 56,326. Everything else exists on
Fedlex as PDF or HTML only, which this pipeline does not parse into articles
at all. That is the gap between the two pairs Gate E prints.

**2. `ch_act_change` is not an act's full amendment history.** It is the
diff between consecutive *XML* editions. For SR 220 — in force since 1912 —
Fedlex serves 14 German XML editions, the earliest dated 2021-01-01, so the
computed change log covers **5.75 years, not 114**. "The amendment history of
the OR" reads as complete and is not. Read `ch_act_version`'s own date range
for the act before presenting its change log.

**3. Twelve works have contradictory in-force statuses.** Fedlex's own graph
asserts `inForceStatus` 0 (in force) *and* 3 (no longer in force) for the
same work — always that exact pair, verified twice against the live graph:
`cc/2003/31`, `cc/2010/724`, `cc/2018/335`, `cc/2018/615`, `cc/2020/711`,
`cc/2020/982`, `cc/2020/1073`, `cc/2021/217`, `cc/2021/302`, `cc/2022/278`,
`cc/2022/544`, `cc/2023/135`. `acts` refuses to pick one: it stores
`enforcement_status = NULL` and records both codes under
`metadata_json -> 'status_conflict'`, so the row explains why it is unknown
instead of looking like one of the ~4,296 works Fedlex publishes no status
for at all. Find them with:

    SELECT eli_work_uri, sr_number, metadata_json -> 'status_conflict'
      FROM ch_act WHERE metadata_json -> 'status_conflict' IS NOT NULL;

To clear one, decide which status is true *from a source outside Fedlex's
graph* and write it:

    UPDATE ch_act
       SET enforcement_status = 0,
           metadata_json = metadata_json - 'status_conflict'
     WHERE eli_work_uri = 'https://fedlex.data.admin.ch/eli/cc/2003/31';

(`in_force` is a generated column and follows automatically.) **The next
`acts` run will re-flag it** — the resolution lives in your head, not in the
graph, and `acts` re-reads the graph. That is deliberate: a pipeline that
remembered your override would go on asserting it after Fedlex changed its
mind. Re-apply the update after a re-run, or fix it upstream.

**4. Some parsed editions have no articles, and that is real data.**
`stage = 'parsed'` is not the same claim as "usable". Fedlex serves genuine
nineteenth-century declarations whose `<act>` has no `<body>` at all — e.g.
`eli/cc/1/598_557_598/18750702`, a one-page 1875 Bundesbeschluss whose text
is in the `<preamble>` — and `chpipe.akn` correctly parses those into zero
articles. `project_legacy_stage.empty_latest_editions(conn)` counts them
before a projection, and every projected row carries its own count:

    SELECT count(*) FROM ch_legislation
     WHERE (metadata_json ->> 'article_count')::int = 0;

## project-legacy, and the rows it does not touch

The projection upserts on `(eli_uri, lang)`, so any pre-existing junk row
whose `eli_uri` this corpus never re-derives **survives**, indistinguishable
at a glance from a row the run wrote. It is not blind-deleted: nobody has
reviewed which of the 5,594 rows are junk and which are among the 212 real
ones. Instead every written row carries
`metadata_json ->> 'projected_from' = 'ch_act_version'`, and
`project_legacy_stage.unaccounted_rows(conn)` counts (and the run logs) how
many rows this pass did not write or update. Decide what to do about them
deliberately, on that evidence.

The write is batched (250 editions per statement) under a 10-minute
statement timeout, with progress logged per batch, and each batch commits on
its own — so an interrupted run keeps what it finished and the next run
completes the rest. `sr_number` now holds the real SR number ("220") rather
than the ELI fragment the old importer derived ("1971/1069_1068_1068"),
which is a deliberate change of meaning for that column.

## Before the first legislation run on prod

- [ ] **Apply migration 197 by hand, in a window.** It creates four tables
      and their indexes; it does not touch `ch_court_decisions` and does not
      rewrite `ch_legislation`. Small compared to 196, but run it
      deliberately rather than on a deploy:

          SET statement_timeout = '30min';
          \i 197_ch_legislation_corpus.sql

- [ ] **Run `acts` first, then `versions`.** `versions` drives its walk from
      `ch_act`; an empty `ch_act` means an empty driving set and it issues no
      queries at all rather than walking the graph blind. Check `orphaned`
      in the `versions` log afterwards — it should be 0, and a non-zero value
      means the two queries disagree about what exists.
- [ ] **Cap the first `fetch-xml` and `parse-akn` runs** with
      `CHPIPE_LIMIT=500` and read the reports before committing to ~12,000
      downloads against a government file store.
- [ ] **Gate E after `parse-akn` and after `diff`**, with the network
      cross-check, and read the first pair of each line.
- [ ] **Read `unaccounted_rows()` after `project-legacy`** and decide, in
      writing, what happens to the survivors.

## Citation graph

Three stages, run in this order, that turn `ch_court_decisions.full_text`
into a graph of who cites what: `aliases` (act abbreviation → SR number),
`citations` (raw edges, per decision), `citations-resolve` (raw edges →
resolved rows). Migration 199 is the schema: `ch_act_alias`,
`ch_case_citations`, `ch_legislation_citations`. Migration 200 adds
`ch_citation_state`, the per-decision queue.

**The citation stages never write `ch_court_decisions`.** The bookkeeping —
has this decision's text been scanned, when, how many times has it raised
and with what error — lives in `ch_citation_state`: one narrow row per
decision, keyed by `ecli`, with `spider`, `extracted_at` (NULL = queued),
`attempts`, `last_error` and `updated_at`, and two partial indexes on
`WHERE extracted_at IS NULL` — `(ecli)` for the corpus-wide claim and
`(spider, ecli)` for the per-spider one — which between them are the claim
query's whole predicate.

**`spider` is denormalised onto the state row on purpose.** A per-spider
claim (`./run-stage.sh citations CH_BGer`) filters on `s.spider`, not on
`d.spider`: the two always agree — every writer copies it off the decision
row — and the difference is which table the planner can use to eliminate
rows. On the state table it is the leading column of
`idx_ch_citation_state_pending_spider` and the claim seeks straight to that
spider's pending rows; on the joined table every pending row in a mixed
backlog has to be read and joined before it can be discarded, for a claim
that wants 200.

**The claim is ordered by `s.ecli`** — the state table's own primary key,
and a performance choice rather than a priority one (the queue has no
priority; the order only has to be stable, so a skipped row is not re-offered
behind the whole backlog forever). The pre-200 claim ordered by
`spider, doc_id`, which was cheap only because of the `(spider, doc_id)`
partial index **on `ch_court_decisions`** that migration 200 drops with the
flag it indexed. Keeping that order afterwards costs a hash join plus an
external sort: measured on a 200k-row backlog, **255 ms** per 200-row claim,
materialising `full_text` for every pending row just to sort them. Ordering
by the state table's key is an index scan feeding a nested loop —
**0.8 ms** for the same claim. If this query is ever edited again, keep the
`ORDER BY` on `ch_citation_state`'s own key.

It started life as a flag column on the decisions table itself
(`citations_extracted_at`, migration 199) and that was a mistake, measured
on prod 2026-08-25. `ch_court_decisions` is 19 GB with a 7.6 GB full-text
GIN, and the flag sat inside a partial index predicate — which means it
could never be updated HOT, so **every stamp and every unstamp rewrote the
whole row into every index on the table**, the GIN included. A bulk unstamp
of 1.22M rows (the reset for a full re-extraction) ran 22+ minutes against
the table the live product reads, and the GIN grew 0.6 GB in a day of that
churn. On the side table the same reset is seconds and a stamp is one narrow
HOT update. Migration 200 leaves the old column in place (it is the only
surviving copy of the pre-migration stamps, and dropping a column on a 19 GB
table takes an ACCESS EXCLUSIVE lock); nothing reads or writes it any more,
and a later migration may drop it.

**Apply migrations 199 and 200 outside the 07:15 UTC delta window.** The
migration runner applies a whole file as one implicit transaction, so 199's
`ALTER TABLE ch_court_decisions ADD COLUMN citations_extracted_at` holds an
ACCESS EXCLUSIVE lock on a 1.22M-row table until the file's last statement
commits — and the two `ch_court_decisions` indexes after it are built while
that lock is still held (tens of seconds on the production table, during
which nothing else can read or write it). 200 is far cheaper (it reads that
table and drops one index on it) but shares the rule. Both files start with
`SET lock_timeout = '3s'`, so if the table is already busy the migration
fails fast and can be retried in a quiet window instead of queueing —
and blocking everything that arrives behind it.

**Migration 200 seeds `ch_citation_state` from the stamps already on
`ch_court_decisions`**, once, and only into an empty table. Seeding NULLs
instead would have queued the entire extracted corpus for a multi-hour
re-extraction on the first nightly delta after the deploy. From then on a
decision enters the queue when `load` promotes it
(`db.complete(-> 'loaded')` ensures a state row) and re-enters it when
`extract`/`ocr` give it new text (`db.complete(-> 'extracted')` sets
`extracted_at` back to NULL and clears the attempt counter with it).

**Re-extracting the whole corpus** is one narrow `UPDATE`:

```sql
UPDATE ch_citation_state SET extracted_at = NULL;   -- seconds, 1.22M rows
```

then `./run-stage.sh citations` (and `citations-resolve` after it). Nothing
in that touches `ch_court_decisions`, which is the point — the same reset
against the old flag column took 22+ minutes and bloated the full-text GIN.
`services/ch-pipeline/scripts/reextract-citations.sh` is the versioned copy
of the whole sequence (aliases → reset → citations → resolve-all → report).

**`aliases`** seeds `ch_act_alias` — the abbreviation a decision actually
writes ("OR", "CO", "Cst.", "StGB") mapped to the SR number the legislation
corpus keys on — from three additive, idempotent sources: `ch_act`'s own
German `abbreviation` column, the abbreviation Fedlex puts in parentheses at
the end of each language's title, and a hand-curated map for the acts whose
title carries no parenthesised abbreviation at all (the big codes: OR, ZGB,
StGB, Cst. …). Re-running it after `ch_act` gains new acts, or after the
curated map grows, costs nothing beyond what actually changed.

**A title-derived abbreviation two acts both claim is not seeded at all.**
"(KV)" ends the title of every cantonal constitution filed under SR 131.xxx,
so seeding it maps one abbreviation onto 26 acts — and a Uri court's
"Art. 12 KV" then resolves to whichever of them step 1's ranking reaches
first (it resolved to Appenzell's). An alias that names 26 acts identifies
none of them, and a citation left at `unresolved_abbr` is visible in
`reports_cit`'s top-unresolved list while a citation resolved to the wrong
act is visible nowhere. The skip is per (abbr, lang) and per SR number — two
`ch_act` rows of the same act are one act — and it applies to `title_paren`
only: `curated` is hand-checked and `fedlex_abbreviation` is Fedlex's own
assertion about one act. Each run logs how many abbreviations it skipped per
language.

**What `citations` deliberately does not extract.** A 200-row judged sample
of resolved statute citations from the first full backfill measured 98%
extraction, 97.4% act and 100% article accuracy; the misses it found are
four rules in `chpipe/citations.py`, each trading a handful of real
citations for a much larger number of invented ones:

- A **cantonal suffix** stays on the abbreviation (`LPA-VD`, `LPA-GE`, and
  the other 24 canton codes). `ch_act_alias` carries federal acts only, so
  these stay at `unresolved_abbr` — which is right: cut down to "LPA" they
  resolved to the *federal* animal-protection act (SR 455) the court never
  mentioned.
- A **single-digit ordinance suffix** stays too (`OPP 2`, `BVV 2`) — "OPP"
  alone resolved to an unrelated aviation ordinance. Bounded to an
  abbreviation of at least three letters followed by one space, one digit
  1–3 and a non-digit, so "Art. 5 OR 2019" stays "OR".
- A **range wider than five article numbers** drops both its endpoints:
  "Kommentar zu den Art. 308-327a ZPO" is a commentary's scope, not two
  articles applied to the case. "Art. 8-10 ZGB" is unaffected. Failure
  mode: a court really applying two articles more than five apart in one
  range loses both.
- A **paragraph number above 12** ends the paragraph list and starts an
  article list: "art. 5 al. 1 et 2, 9, 26 et 36 Cst." is five articles of
  the constitution, not a paragraph 36 of article 5. "Art. 42 Abs. 1 und 2
  BGG" is unaffected. Failure mode: a genuine paragraph 13 or beyond, and
  everything after it, is re-read as further articles.

**`citations`** claims from `ch_citation_state` — rows with
`extracted_at IS NULL` and attempts left, in `ecli` order, filtered on
`s.spider` when a spider is given, joined to `ch_court_decisions` for the
text and the `stage = 'loaded'` predicate — runs `chpipe.citations` over
each one's text in a thread pool, and writes the raw edges it finds —
BGE/docket/ECLI case references into `ch_case_citations`, article references
into `ch_legislation_citations` — then stamps `extracted_at` on the state
row. This is extraction only: nothing here resolves a citation to the row it
points at. A decision whose extraction raises is **not** stamped and its
edges are **not** touched: it keeps whatever it already had, one of its
`attempts` is spent, `ch_citation_state.last_error` records the reason, and
the next run tries again — until `CHPIPE_MAX_ATTEMPTS` is reached, at which
point the claim stops offering it. (That is `ch_citation_state.last_error`,
this stage's own; `ch_court_decisions.last_error` belongs to the stage-column
queue and is never written here.) The exception is logged with the
decision's ecli and counted in `failed`. Within a single run the attempt
counter is not enough — the claim keeps offering the row until the next
run — so the run also remembers the eclis that raised and skips them in its
later batches; a batch that is nothing but those ends the run with a warning
naming the count. `python -m chpipe.reports_cit` shows `retried` and
`max_attempts` alongside `loaded`/`stamped`: a `max_attempts` that has
reached `CHPIPE_MAX_ATTEMPTS` means some decisions have been retired from
the queue unstamped and want looking at.

`CHPIPE_CIT_BATCH` (default 200) sets how many decisions are claimed per
batch. The claim selects `full_text` for the whole batch at once, so it is
this stage's memory knob — turn it down on a host where long decisions make
a batch too heavy. The queue is a flag on a narrow side table, so a smaller
batch costs nothing but extra round-trips.

**A decision that gets NEW text must be re-scanned, not left stamped
against the OLD text.** `db.complete(conn, doc_id, 'extracted', ...)` — the
statement both `extract_stage` and `ocr_stage` use to write `full_text` —
unconditionally puts the decision's `ch_citation_state` row back to
`extracted_at IS NULL` (and clears its `attempts`/`last_error`: those were
spent on text the decision no longer has) whenever it moves a row to
`'extracted'`. The next `load` puts the row back at `loaded`,
and the next `citations` run picks it up again, over the new text, exactly
like a decision that has never been scanned at all — and that run **deletes
the decision's existing edges before inserting** the ones its current text
produces (`db.delete_citations`, scoped to the `from_ecli` values of the
decisions that extracted **cleanly** — a failed one keeps its edges,
otherwise a re-extraction whose new text raises would delete real citations
with nothing to put back). Re-extraction is a replacement, not an addition: `ON CONFLICT DO
NOTHING` makes an edge the new text still contains collide harmlessly with
the row already there, but an edge the new text no longer contains has
nothing to collide with, and left alone it would outlive the text it came
from forever.

**`citations-resolve`** is four `UPDATE ... FROM` statements, run in a fixed
order because each one's input is the previous one's output, over the
raw edges `citations` wrote:

1. **act** — `abbr_raw` → `ch_act_alias` → `sr_number`/`act_id`. Among the
   acts `ch_act_alias` names for that abbreviation, prefer the one whose
   alias is written in the citation's own language, then the one whose
   `[date_entry_force, date_no_longer_in_force)` actually contains the
   citation's `from_date`; failing that (no `from_date`, or none covers it),
   prefer the act currently in force, then the one with the latest
   `date_entry_force`. `match_method` becomes `act_only` on a hit,
   `unresolved_abbr` when `ch_act_alias` has nothing for that abbreviation
   at all. **Language ranks the candidates; it does not filter them.** A
   citation's `lang` is what the extractor inferred, and it falls back to
   `de` whenever no keyword in the reference decides — "les art. 9 et 10
   LPGA" is French text with no paragraph keyword, so it arrives here as
   `de`. Filtering on the language would refuse the `fr`-only LPGA alias and
   park a perfectly resolvable citation at the terminal `unresolved_abbr`.
2. **edition** — `act_id` (+ `lang`, `from_date`) → `ch_act_version` →
   `version_id`. The parsed edition whose
   `[date_applicability, date_end_applicability]` contains `from_date` —
   **`date_end_applicability` is inclusive**, the last day the edition is in
   force, not the first day it no longer is (verified on prod: 19,428
   consecutive parsed editions of the same act+lang have
   `next.date_applicability = prev.date_end_applicability + 1 day`) — or,
   when `from_date` is `NULL` — **the parsed edition with the greatest
   `date_applicability` not in the future** (`latest_edition`). Tries the
   citation's own language first and falls back to `de` only when nothing in
   that language satisfies the date condition.
3. **article** — `version_id` (+ article number) → `ch_act_article` →
   `article_id`. Several rows can share the same bare `article_number` (a
   top-level `art_336` and a transitional-provision `disp_u17/art_336` both
   carry `article_number = '336'`); the path-shaped `e_id` (contains `/`) is
   the one that loses — a top-level article is always preferred over a
   transitional duplicate of the same number.
4. **case** — `to_raw` (+ `cite_kind`) → `ch_court_decisions.ecli`. `bge`
   matches `docket_number` restricted to `spider = 'CH_BGE'` (ATF/DTF
   numbers are only ever CH_BGE's own docket format); `docket` matches
   `docket_number` under any spider, preferring `CH_BGer` when several
   decisions carry the same docket number, and breaking any remaining tie on
   `ecli` so a docket number shared by two decisions (a correction, a
   re-publication) resolves to the same one every run rather than to
   whatever order Postgres happens to return matching rows in; `ecli`
   matches `ecli` directly.

Steps 1 and 4 are the two entry points — each picks up every row whose
`match_method` is still `NULL`, i.e. every row `citations` has extracted and
nothing has ever tried to resolve, and each sets `match_method` to a
*terminal* value even on failure (`unresolved_abbr` / `unresolved`) so a
plain re-run finds nothing left to do there. Steps 2 and 3 are the one path
that legitimately gets a second try without `CHPIPE_CIT_RESOLVE_ALL`: a row
that found its act but not yet an edition stays at `act_only` rather than a
dead end, and a row that found its edition but not yet an article keeps
`article_id NULL` under `edition_at_date`/`latest_edition` — so if
`versions-stage`/`parse-akn` later fill in the edition or article this row
was missing, the next ordinary `citations-resolve` run picks it up again.
Steps 1 and 4 do not get that same second chance: `ch_act_alias` and
`ch_court_decisions` both grow over time (a new alias, a newly indexed
decision), and re-scanning the full `unresolved_abbr`/`unresolved` backlog on
every run to catch that would turn a bounded set-based pass into an
unbounded one.

**What that second chance costs every night.** Steps 2 and 3 re-scan their
whole backlog on every run, not just tonight's new rows: a citation of an
act the legislation corpus has no *parsed* edition of (an act Fedlex
publishes but `parse-akn` has not reached, or has no edition covering the
citation's `from_date`) stays at `act_only` permanently, and step 2 probes
it again every night for an edition that may never appear. The same holds
for step 3 over rows sitting at `edition_at_date`/`latest_edition` with a
`NULL` `article_id` — an article number the edition does not contain (a
citation to a repealed article, or a misprint) is re-probed nightly.
This is known and deliberate — it is what makes a newly parsed edition
resolve by itself — and it is bounded: both probes are single indexed
lookups per row (`idx_ch_act_version_act` on
`(act_id, lang, date_applicability)` in migration 197, and
`idx_ch_act_article_version_number` on `(version_id, article_number)` added
in 199 for exactly this — measured 6.6x on the article probe). Watch it in `python -m chpipe.reports_cit`'s
per-`match_method` counts: a permanently growing `act_only` count is the
signal that the legislation half, not this stage, is what needs attention.

**`CHPIPE_CIT_RESOLVE_ALL=1`** is the deliberate, operator-driven way to pay
that cost when the alias map or the decision corpus has grown enough to be
worth it: it resets every column this stage owns back to `NULL`/`false` —
only on rows a previous run actually touched (`match_method IS NOT NULL`),
so a fresh corpus with nothing resolved yet pays nothing extra — then runs
the same four statements, which recompute everything now that
`match_method` is `NULL` again everywhere.

    CHPIPE_CIT_RESOLVE_ALL=1 ./run-stage.sh citations-resolve

**The `2021-01-01` placeholder.** `decision_date` on the CH_BGer rows
migration 196 enrolled is `2021-01-01` for every one of them — the source's
placeholder for "no decision date known", not a real fact about when any of
those decisions were handed down. `citations_stage._from_date()` maps that
exact date back to `NULL` before it is ever written into
`ch_case_citations.from_date` / `ch_legislation_citations.from_date` —
citing it as a real `from_date` would assert a fact the source never had,
and it would silently make every one of those citations resolve as though
decided on 1 January 2021 (step 2's date-interval match, step 1's
in-force-at-that-date preference). A citation with `from_date IS NULL` is
exactly what falls through to the `latest_edition` branch of step 2 instead.

`chpipe/reports_cit.py`'s `summary(conn)` is the citation graph's own
numbers: extraction totals per `cite_kind`, resolution shares overall and
per language, counts per `match_method`, the top 20 unresolved
abbreviations (what the alias map should be extended with next), the top 20
most-cited BGE rulings, and how much of the loaded corpus `citations` has
actually reached (`stamped` vs `loaded`). Run it as
`python -m chpipe.reports_cit` (reads `CHPIPE_DSN`, prints JSON) or call
`reports_cit.summary(conn)` directly.

# The registries half

Two Swiss company data sources, three stages, migration 202 (extending
migration 129's `ch_zefix_companies` / `ch_shab_publications`):

- **`zefix`** — the live company register, from
  [LINDAS](https://lindas.admin.ch) (the Confederation's linked-data
  endpoint). Fills `ch_zefix_companies` and `ch_zefix_municipality`, walking
  the 2,111 municipality partitions the source is organised by. Resumable
  by `run_date`: `ch_zefix_progress` gets one row per finished partition per
  day, and a partition that already has one is skipped, so a killed run
  picks up where it stopped the same day and starts fresh the next.
  Companies no longer in the active Zefix set are not deleted — a SHAB
  publication may still reference one — they are marked `status='inactive'`
  once every partition for the day has reported in. That sweep also has a
  magnitude guard: a walk that confirmed less than half of what is currently
  active is treated as a source failure rather than as 400,000 companies
  leaving the register, and strikes nothing off (`sweep_skipped` in the
  report, plus a `WARNING` carrying both numbers).
- **`shab-list`** — publication *pointers* (id, date, rubric, a title-parsed
  company name) from the [Swiss Official Gazette of Commerce
  (SHAB)](https://amtsblattportal.ch) bulk export, into
  `ch_shab_publications`. Two rubrics, `KK` (debt collection / bankruptcy)
  and `HR` (commercial register), 2,509,068 publications backfilled
  (measured 2026-08-26: HR 2,293,215 + KK 215,853).
  Prod needs `CREATE EXTENSION pg_trgm` (superuser) before the backfill:
  migration 202 creates `idx_ch_shab_name_trgm` only if the extension is
  already there, and without it `ch_search_companies`' SHAB-name fallback
  scans all 2.5M publications.
- **`shab-detail`** — turns each pointer into a record: the register's own
  company name, the UID that joins a publication to a `ch_zefix_companies`
  row, the legal form, the seat, the full publication text, fetched one XML
  per row from `/api/v1/publications/{id}/xml`. The queue *is* the two
  detail columns — `detail_fetched_at IS NULL AND detail_attempts < 3` — so
  there is no separate claimed state to leak on a killed run. Claiming a row
  raises `detail_attempts` in the same statement that reads it, so
  **`detail_attempts` counts claims, not fetch failures**: three claims that
  never ended in a `detail_fetched_at` stamp retire the row, and a run killed
  mid-batch costs the rows it was holding one claim each. The bump is what
  makes the claim exclusive — `FOR UPDATE SKIP LOCKED` alone holds nothing on
  an autocommit connection, and two workers sharing this queue were measured
  fetching the same publications — so several workers, or the nightly delta
  beside the standalone backfill, can drain it together. A claim prefers rows
  nobody has claimed and only falls back to retrying claimed-but-unstamped
  rows once there are none left.

## Env vars

| var | stage(s) | meaning |
|-----|----------|---------|
| `CHPIPE_SHAB_FROM` | `shab-list` | first month to walk, `"YYYY-MM"` (default `2000-01`) — the backfill's starting point, irrelevant once every month before it has a `done_at` progress row |
| `CHPIPE_SHAB_RPS` | `shab-list`, `shab-detail` | requests/second ceiling against amtsblattportal.ch (default `10`) — one rate limiter shared by both stages, since they hit the same host |
| `CHPIPE_SHAB_CONCURRENCY` | `shab-list`, `shab-detail` | in-flight requests each stage's `Fetcher` runs (default `4`, must be an integer 1-32); `Settings.shab_concurrency`, see `_shab_concurrency()` in `chpipe/config.py`. Through the SOCKS tunnel to prod (~0.4-0.7 s RTT per hop), throughput is roughly concurrency / RTT regardless of `CHPIPE_SHAB_RPS` — 4 in flight caps a run at ~5-10 req/s no matter how high the rate limiter is set — so raise this together with `CHPIPE_SHAB_RPS` to actually get more throughput |
| `CHPIPE_SHAB_MONTHS` | `shab-list` | walk only the last N months (delta mode); unset = every month back to `CHPIPE_SHAB_FROM` (backfill mode) |
| `CHPIPE_SHAB_BUDGET_SECONDS` | `shab-detail` | stop after N seconds, checked between batches; `""` (unset) means no budget — the shape `shab-detail`'s own `main()` reads via `budget_seconds()`. The **nightly delta** reads a *different* source for the same name: `Settings.shab_budget_seconds`, populated from the same env var but defaulting to `5400` (90 minutes) rather than "no budget" — the cron job must never run unbounded even if the var is unset |
| `CHPIPE_LIMIT` | `shab-detail` (and the decisions/legislation claiming stages) | stop after N rows — a smoke run |
| `CHPIPE_SHAB_PROXY` | `shab-list`, `shab-detail` | proxy URL for amtsblattportal.ch only, e.g. `socks5h://127.0.0.1:1080`; `""` or unset = fetch directly. Required on any cloud box — see **amtsblattportal blocks cloud IPs** below. Deliberately *not* `HTTPS_PROXY`: zefix's LINDAS traffic must stay direct |
| `CHPIPE_ZEFIX_MUNICIPALITIES` | `zefix` | comma-separated municipality ids, for a targeted re-run; unset = every partition. Only a full unfiltered run triggers the inactivation sweep |

## amtsblattportal blocks cloud IPs

**amtsblattportal.ch does not answer AWS IPs at all.** Not a 403, not a
challenge page — the TCP connection hangs until it times out, so a
`shab-list` or `shab-detail` run on the AWS box looks like a stalled network
rather than a refusal. Measured on prod 2026-08-26 from the same host on the
same afternoon: LINDAS, Fedlex and entscheidsuche all answered normally,
amtsblattportal.ch answered nothing. Only these two stages are affected;
every other source in this pipeline is reachable directly.

The fix in operation is a **reverse SOCKS tunnel from the local server**,
which is on a Swiss consumer uplink the portal does answer. Run this **on the
local server**, not on the cloud box (`-R` means "open the listener at the
far end"):

    ssh -R 127.0.0.1:1080 prod

That leaves a SOCKS5 proxy listening on the cloud box's own loopback, with
the traffic emerging from the local server. Then, in `ch-pipeline.env`:

    CHPIPE_SHAB_PROXY=socks5h://127.0.0.1:1080

`socks5h`, not `socks5`: the `h` makes the *proxy* resolve the hostname, so
DNS for amtsblattportal.ch also comes from the Swiss side. `127.0.0.1` is
correct and must not be widened — the listener is bound to loopback so the
tunnel is not an open proxy to anyone who can reach the box.

`socksio` must be installed in the venv (it is in `requirements.txt`).
Without it httpx raises `ImportError` the moment a `socks5h://` URL reaches
`AsyncClient` — at Fetcher construction inside the stage, not at start-up.

**The nightly delta needs the tunnel to be persistent.** A plain
`ssh -R` dies with the terminal that started it, and with it every SHAB fetch
from 07:15 UTC onward — silently, as a stage that hangs on its rate limiter
rather than one that errors. Note also that today's crontab line sources no
env file, so `CHPIPE_SHAB_PROXY` has to reach cron explicitly: a `CHPIPE_SHAB_PROXY=...`
assignment line in the crontab next to `CRON_TZ=`, or a wrapper that sources
`ch-pipeline.env` before `run-delta.sh`.

Either `autossh` or a systemd unit **on the local server** keeps the tunnel
up. Documented, not created — installing it is an operator decision about a
machine this repo does not deploy to:

    # /etc/systemd/system/shab-tunnel.service  (on the LOCAL server)
    [Unit]
    Description=Reverse SOCKS tunnel to prod for amtsblattportal.ch
    After=network-online.target
    Wants=network-online.target

    [Service]
    User=<the user whose ~/.ssh has the prod key>
    ExecStart=/usr/bin/ssh -N -T \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -R 127.0.0.1:1080 prod
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target

`ExitOnForwardFailure=yes` is the load-bearing option: without it, an ssh
that connects but *fails* to open the forward (port 1080 already held by a
stale session) stays up and reports success, and systemd never restarts it —
so the unit is green while the delta fetches nothing. `-N -T` because this
session carries no command and needs no tty. Prod's sshd also needs
`ClientAliveInterval` short enough, or a tunnel idle between nightly runs is
reaped by the far end and only `Restart=always` notices.

Nothing enforces any of this in code: with the tunnel down, `CHPIPE_SHAB_PROXY`
still points at a dead loopback port and the stages fail their fetches the
ordinary way — retries, then the claim counter running out. Check the delta
log for a `shab-list`/`shab-detail` step that claims rows and fetches none before
suspecting the portal itself.

## The lossy-paging rule

`shab-list` never asks amtsblattportal.ch for an offset. Two measurements
(live, 2026-08-26, HR rubric) say why:

- **The offset cap.** `page * size >= 10000` is refused outright — August
  2026 alone holds 18,764 HR publications, so a single month cannot be
  paged even in principle once it is recent enough.
- **Paging is lossy well before that cap.** The two-day window
  2026-08-03..04 reports `total=2048`; walking it as four pages of 500
  returned 2,000 publications of which only 1,927 were distinct — 3.6% of
  the window silently missing, because the result set is not ordered
  stably across requests. A row that shifts across a page boundary between
  two requests is served twice or not at all. `pageRequest.sortOrders`
  does not help: the endpoint answers 200 to a sort on a field that does
  not exist and reproduces the identical duplication.
- **Unpaged is exact.** The same-sized single-day window 2026-08-03 alone
  (`total=1,095`) returns all 1,095 distinct publications in one request.

So the unit of fetching is a date window **halved until it fits in a single
page** — the probe that decides this asks for one row and reads `<total>`.
A month of 2000-era HR is one probe and one request; a month of modern HR
is 31 probes and 16 requests. The unit of *progress* stays the month:
`ch_shab_progress` gets one row per `(rubric, month)`, written whether the
month finished or not (`fetched < total`, `done_at NULL` on a failure), so
the backfill is killable and resumable at the month grain regardless of how
many windows a given month took underneath.

`done_at` — the column the skip list reads — is stamped only when a month is
**complete *and* over**. The current month is still being published into, so
a complete walk of it records its counters with `done_at NULL` and is walked
again the next night; stamping it on the first night of the month would
freeze it and the nightly delta would make zero requests until the month
turned. The previous month is walked one last time after the boundary and
frozen then, which is the window that catches a publication landing in the
last hours of a month — and the reason the delta asks for two months.

## Backfill order on prod

Run the three stages **in this order**, under `tmux` (see "Where it runs"
above for why — hours-long unattended network walks must survive a
disconnect):

1. **`./run-stage.sh zefix`** — first, always. Its own walk is
   ~2,100 SPARQL queries and finishes in minutes to low tens of minutes, but
   the real reason it goes first is `shab-detail`: `shab-detail` resolves a
   publication's `legal_form` *code* to a German *label* by reading the
   eCH-0097 map `zefix` wrote into `ch_zefix_companies`
   (`legal_form_labels()` in `shab_detail_stage.py`). Run `shab-detail`
   before `zefix` has ever populated that table and nothing fails — every
   `legal_form` just holds a bare code (`"0107"`) instead of its label
   (`"Aktiengesellschaft"`) — a silent quality loss with no error to notice
   it by, not a crash. See the caveat below for the accepted follow-up cost.
2. **`./run-stage.sh shab-list`** (no month argument — the unset default
   walks everything from `CHPIPE_SHAB_FROM`, i.e. the whole 2000-present
   backfill). 2.5M publication pointers; restartable at the month grain
   (above), so a `tmux` session that gets killed loses at most the month it
   was mid-window on.
3. **`./run-stage.sh shab-detail`** last, once `shab-list` has actually
   produced rows to detail. KK before HR and newest-first within a rubric
   are baked into the claim query's `ORDER BY`, not a stage argument — KK is
   a twelfth of HR's volume and it is the half that answers "is this
   counterparty bankrupt", so a run stopped partway through has still
   delivered the more valuable rubric. At `CHPIPE_SHAB_RPS`'s default of 10
   requests/second, 2.5M rows is roughly 70 hours end to end — run it
   without `CHPIPE_SHAB_BUDGET_SECONDS` set (or explicitly unset it) for the
   backfill; the nightly delta is what supplies a budget, not this
   invocation.

**Legal-form code resolution caveat.** Running `shab-detail` before `zefix`
has completed at least once does not corrupt anything and does not need a
special recovery step — `legal_form` labels are read fresh from
`ch_zefix_companies` on every `shab-detail` call (not cached, not stamped
onto the row as final), so once `zefix` has run, the **next** `shab-detail`
pass over the same rows fills in the labels retroactively via its normal
`coalesce()` update. The cost of getting the order wrong is only a
temporary quality gap, not permanent data loss — but there is no reason to
pay even that on a fresh backfill, hence the order above.

## Delta behaviour

`chpipe.delta.run_registries()` is the nightly counterpart to the backfill
above, wired into `chpipe.delta.main()` as a third independent guarded step
(see "Priority" and the guard-shape discussion under **Deltas** below for
what "guarded" means here — a LINDAS timeout or an amtsblattportal outage
costs the registries half only, exactly like a bad night on decisions or
legislation costs only that corpus).

- **`zefix`** runs with no municipality filter — the whole register,
  every night, the same reasoning as `run_decisions` needing the whole
  snapshot. It is not a full re-fetch in cost, though: `run()` resumes by
  `run_date`, so this is one full walk per calendar day, measured at
  roughly 10-20 minutes.
- **`shab-list`** runs with `months=2`, not the full backfill range. A SHAB
  publication is never backdated, so only the current and previous
  calendar month can hold anything new; two months rather than one covers
  a publication landing in the last days of a month before the boundary
  rolls over.
- **`shab-detail`** runs with `budget_seconds=settings.shab_budget_seconds`
  — 90 minutes by default (`CHPIPE_SHAB_BUDGET_SECONDS`, default `5400`) —
  because the detail queue it claims from is shared with the standalone
  backfill and can be arbitrarily large the first time this runs on a given
  night. It stops on the clock, not a row count; nothing is left
  half-claimed (the queue model is `FOR UPDATE SKIP LOCKED`, no separate
  claimed state), so tomorrow's run resumes the same query where tonight's
  left off.

Same ordering rule as the backfill applies inside `run_registries()`: zefix
runs before shab-detail, for the identical legal-form-label reason.

## Deltas

Once the backfill for all three halves is done, `run-delta.sh` is what keeps them
from rotting. It runs nightly at **07:15 UTC** from cron on prod — after
entscheidsuche's own scrapes (their `Snapshots` file is generated at 06:00
UTC; the `Status` files show spider runs finishing around 23:57 UTC) and
away from the backup window.

Round 1 of this task shipped this at "04:17" with no timezone stated and a
rationale that only makes sense read as UTC — except 04:17 UTC is still
*before* 06:00 UTC, so even on its own terms the file it is waiting for does
not exist yet. Verified live against the real endpoint: at 04:04 UTC the
day's `Snapshots` file 404s. At that schedule the four-day lookback fired
*every single night*, which makes the `INFO "no snapshot at ..."` line pure
nightly noise — indistinguishable from the one thing it exists to announce,
a real entscheidsuche outage. 07:15 UTC leaves over an hour of margin after
06:00 UTC. **Prod's crontab runs in whatever timezone `crontab -l`'s entries
are interpreted in on that box, not necessarily UTC — confirm with `date` on
prod before installing, and adjust the hour if it is not UTC.** The install
line below sets `CRON_TZ=UTC` for this one entry so the schedule does not
depend on that guess (supported by `cronie`/modern Vixie cron, which prod's
Ubuntu image ships); verify with `crontab -l` after installing that the line
still reads `CRON_TZ=UTC` immediately above the job.

    ( crontab -l 2>/dev/null | grep -v 'ch-pipeline/run-delta.sh' | grep -v '^CRON_TZ='; \
      echo 'CRON_TZ=UTC'; \
      echo '15 7 * * * cd $HOME/SecondLayer/services/ch-pipeline && ./run-delta.sh' ) | crontab -

**Decisions.** Reads `https://entscheidsuche.ch/docs/Snapshots/{date}.json`
(falling back up to three days if today's file is not published yet, or is
published but does not parse into the shape this job expects — see below),
and compares its per-court counter map against
`$CHPIPE_RAW_DIR/snapshot-state.json`, the map stored after the previous
successful run. `total` in that file is not flat: it mixes three independent
levels that each separately sum to `total_alle` — a per-canton rollup (e.g.
`"ZH"`), a per-court-code level (e.g. `"ZH_OG"`), and a per-chamber level
(e.g. `"CH_BGer_001"`). The first and third are structurally dropped (a bare
two-letter code, or a trailing `_<digits>` chamber suffix) — neither names a
spider at any granularity, so neither can be re-indexed. What remains is
compared key by key against the stored map, in **both directions**: a change
either way re-walks that court, because a shrinking count (or a key vanishing
from the map entirely) means the source withdrew documents, not just that
nothing new arrived.

**Turning a changed key into a spider to re-index.** Some keys already spell
one of our 54 spider directory names exactly (`reports.completeness()`
measured this against the live 2026-08-23 file and found exact matches for
only 7 of 54 — `"ZH_OG"` is our `"ZH_Obergericht"`, `"GE_CJ"` is our
`"GE_Gerichte"`). For the rest, `chpipe.delta.court_code_spider_map()` builds
root-court-code → spider straight from what is already loaded:
`ch_court_decisions.court_code` is written from the document JSON's own
`"Signatur"` field — entscheidsuche's own identifier, in the same vocabulary
`Snapshots` uses, one level finer (chamber, e.g. `"ZG_OG_001"`) than the
court-code level `total` needs; stripping the same `_<digits>` suffix
spiders_that_grew already treats as noise recovers the right level. This
table is only ever as complete as what has actually been indexed, and it is
rebuilt from the database fresh every run rather than trusted stale — a
spider with zero rows so far contributes no entry, which is correct, not a
gap to invent an entry for. A grown key that resolves through **neither** the
exact-name check **nor** this map is real signal this run still cannot act
on. It is not silently dropped, and — just as important — **its growth is
never retired**: the stored baseline advances only for keys this run
actually walked, so an unresolvable court's counter is held at its previous
value and tomorrow sees the same growth again. The `WARNING` names those
keys and reports **how many detected documents are still unindexed**, which
therefore accumulates night after night rather than resetting. (An earlier
shape advanced every key including these, so the warning fired exactly once
— on the night the court grew — and those documents were never detected
again.) **A recurring, RISING warning here is the signal to act on** — the
corpus keeps growing at courts this run cannot resolve from the loaded data
alone (a spider that has never successfully indexed a single document yet),
and the fix is a manual `run-stage.sh index <spider>` to seed at least one
court_code row for it, not a change to this script.

The same hold-back rule covers a listing that failed: `index_stage.run()`
swallows a per-spider failure into `failed_spiders` rather than raising, and
**every** snapshot key that resolved to that spider is rolled back, not just
one of them. Several court-code keys resolving to one spider is the normal
shape here — the 2026-08-23 snapshot has 131 court-code keys against 54
spiders — so `AG_OG` and `AG_VG` both mapping to `AG_Gerichte` is routine,
and advancing one of the two while restoring the other would retire a real
night's growth at whichever court lost the coin toss.

It covers **document**-level failures too, for the same reason one level
down. `index_stage` counts a document whose JSON 404s, decodes badly or
fails to write in `report.failed` and carries on — one bad file must not
cost a court — and reports the count per spider in `failed_per_spider`. A
spider with any such failure has its baseline held back exactly as a failed
listing does, because the snapshot counter is the only record those
documents were ever supposed to be here. The cost is accepted: a document
that fails *permanently* keeps its court on the nightly re-walk list until
somebody looks, which is the escalating signal — the alternative is a legal
corpus that quietly stops containing a decision.

A listing that returns HTTP 200 and names **zero** documents is a failed
spider, not an empty court. All 54 spiders are established courts with
documents already in the corpus, so zero entries is a parse or layout
failure by construction. Both shapes of it fail — an Apache index that
rendered nothing, and a body that is not a directory listing at all — and
the `Index of` marker in the first chunk only decides which of the two the
log names, because nothing else separates them (an empty Apache index still
carries its Parent Directory link, and so does a changed template, and so
does a 200 error page). A court that genuinely emptied would therefore be
reported failed every night: a loud, cheap, visible false alarm, taken
deliberately over a broken parser reporting a clean zero.

**Legislation.** Re-runs `acts` and `versions` in full — both are idempotent
upserts over the whole graph, and the whole graph is a few minutes of SPARQL,
which is simpler and more reliable than trying to filter by a modification
date Fedlex does not reliably expose. Newly discovered editions land at
stage `discovered`; `fetch-xml` and `parse-akn` drain that queue in the same
run, so a new consolidation is fetched and parsed the same night it appears
rather than merely recorded as pending.

Parsing is not what makes an edition readable, so the run does not stop
there. For each act that actually gained a parsed edition that night, and in
each language it gained one in, `diff` re-derives that act's change log and
`provenance` its footnote record; then `project-legacy` runs once, over
whatever is pending, to put the new edition in the table the product serves.
Without those three, every edition of an act had a change log, a provenance
record and a served row **except the newest** — the one a reader is most
likely to ask about — until somebody happened to run the stages by hand.

They are narrowed to the acts that moved, not run corpus-wide: on a quiet
night `diff` and `provenance` are not called at all and `project-legacy` is
one query. The narrowing is by ACT rather than by edition because that is
their unit of work — `diff` re-does every consecutive edition pair of an act
and `provenance` every parsed edition of it, which is exactly what makes
both idempotent.

**OCR is not part of this script**, deliberately. Documents whose text layer
fails the gate accumulate at `ocr_pending` and are cleared by a supervised
`ocr` run — see "Deferred to the supervised operations phase" above. An
unattended cron job must never be the thing that decides to spend CPU on
that queue.

**Registries.** `chpipe.delta.run_registries()` — see "Delta behaviour"
under [The registries half](#the-registries-half) above for what each of
the three stages runs with (`zefix` unfiltered, `shab-list months=2`,
`shab-detail budget_seconds=settings.shab_budget_seconds`) and why. Its own
independent guard, same shape as decisions/legislation: a LINDAS timeout or
an amtsblattportal outage is logged, added to `failures`, and does not skip
the alias seed or citations-resolve below — zefix/SHAB feed no table either
of those reads.

**Citation graph.** `citations` runs once per grown spider, right after that
spider's `load` (twice if extract's second lap ran too — see above), so a
decision's citation graph is only ever as many nights stale as its text is.
`aliases` and `citations-resolve` are not per-spider: they run once each,
after BOTH halves have had their turn and in that order — `aliases` first,
because step 1 of resolution reads `ch_act_alias` and the legislation half
that just ran may have discovered acts whose abbreviation is not in that
table yet. Seeding after the resolve instead of before it would leave every
citation of a newly discovered act stamped `unresolved_abbr`, a terminal
state no ordinary run revisits, until an operator ran
`CHPIPE_CIT_RESOLVE_ALL` by hand. Each is its own independent guard, not
folded into the decisions/legislation try/except above: a failure in either
half must not skip them (raw edges from an earlier run, or from decisions
that DID land tonight even if legislation died, are still worth resolving),
a failing alias seed must not cost that night its resolve pass, and neither
failure may be swallowed by the others. `aliases` is cheap to re-run
nightly — three `ON CONFLICT DO NOTHING` sources over `ch_act`, so it costs
only what actually changed — and the curated map, still a manual edit, is
picked up by the same nightly run rather than needing a separate one.

**The first nightly delta after deploying the citation graph would try to
backfill the whole corpus.** `citations` claims every decision at `loaded`
whose `ch_citation_state.extracted_at` is NULL — which, on the night
migration 199 first lands, is all 1.22M of them, not just the handful
tonight's spiders grew. (Migration 200 does not repeat that: its seed copies
the stamps that already exist rather than starting everything at NULL.) That is a multi-hour CPU job, and the delta would run it unattended,
under `flock`, straight into the next morning. **Run the supervised backfill
first** — `./run-stage.sh citations` (optionally per spider, and with
`CHPIPE_LIMIT` to size the first batch), watched, until
`python -m chpipe.reports_cit` shows `stamped` caught up with `loaded` —
and only then let the nightly delta take over the tail. After that first
backfill the nightly claim is bounded by what actually changed: a decision
is only ever re-claimed when it gets new text (see the re-extraction rule in
"Citation graph" above).

**Priority.** `run_decisions`/`run_legislation` call each stage's `run()`
directly, not its `main()`, so none of the individual `renice()` calls each
stage's own `main()` would normally trigger actually fire. `chpipe.delta.main()`
calls `throttle.renice(throttle.NICE_IO)` once at start-up to stand in for
all of them, guarded by `assert throttle.NICE_IO == throttle.NICE_CPU` right
before the call — `NICE_IO` and `NICE_CPU` are both 10 today, and every
stage this script reaches (including `parse-akn`, the one CPU-bound stage in
the mix, and `citations`, the other one) resolves to one or the other, so
one call reproduces what a sequence of each stage's own `main()` would have
set, without stacking `os.nice()`'s cumulative increment once per stage. If
the two constants ever diverge, the assertion fails loudly instead of
silently reniceing `parse-akn` at the wrong priority with no test able to
catch it after the fact (`os.nice()` cannot be corrected back in-process).
The load-average ceiling needs no extra wiring here: it already lives inside
`extract_stage.run()`, `citations_stage.run()` and `parse_akn_stage.run()`
themselves, so calling `run()` directly still gets it.

Compared to `run-stage.sh`, the wrapper itself carries a few things a
supervised one-off invocation can get away without:

- a `flock` so a slow previous run and the next scheduled one can never
  claim the same rows at once (row-locking here is explicitly not a
  distributed lock — see "Running one" above). The lock fd is deliberately
  **not** inherited by the `python3` child (`9>&-` on that line) — the
  wrapper shell holds it for its own whole lifetime, which is what enforces
  the mutex, and there is no reason for a process that knows nothing about
  the lock to also hold a copy of it.
- log rotation at 20 MB so a job running 365+ times a year with nobody
  watching does not grow the log file forever.
- an explicit `FAILED`/`OK` marker on every run, via a shell `trap` that
  captures `$?` into a variable as its very first action (a command
  substitution earlier in the same line — `$(date -Is)` — runs first and
  resets `$?` before it would otherwise be read, so capturing it immediately
  is what makes the reported exit code the real one) — there is no `MAILTO`
  configured for this cron entry, so the log is the only place a failure is
  visible at all. The `OK` line is written as an ordinary command with the
  trap cleared, not by re-arming the trap: an `EXIT` trap only actually
  fires once the *whole script process* exits, by which point
  `{ ... } >> "$LOG"` has already torn its own redirection down, so a
  trap re-armed there prints to cron's discarded stdout instead of the log.

**Checking last night's run:**

    tail -80 /data/ch-corpus/logs/delta.log
    # last line should read "... delta finished: OK ===". FAILED, or no
    # matching line for last night at all, both need investigation.
    grep 'resolve to no spider' /data/ch-corpus/logs/delta.log | tail -5
    psql -c "SELECT stage, count(*) FROM ch_court_decisions GROUP BY 1"
    psql -c "SELECT stage, count(*) FROM ch_act_version GROUP BY 1"
    psql -c "SELECT count(*), count(*) FILTER (WHERE detail_fetched_at IS NOT NULL)
             FROM ch_shab_publications"
    python -m chpipe.reports_cit   # citation graph totals and resolution shares

**Recovering from a night that did not work:** the delta is restartable and
idempotent by construction — every stage it calls upserts, and
`snapshot-state.json` is only overwritten after a successful pass (never for
a spider whose listing failed this run — its old value is kept so the next
run sees it as changed again — and never for a snapshot that failed to parse
into the expected shape), so a crashed run leaves the previous night's state
in place and the next scheduled run (or a manual `./run-delta.sh`) picks up
the full gap since then, not just one night's worth.

The file is written to a temp file beside it and moved into place with
`os.replace()`, so a kill during the write leaves the previous night's map
whole rather than a prefix of the new one — a baseline is the one piece of
state here that decides which documents are retired unfetched. If it ever
does become unreadable (a full disk, a bad restore, a hand-edit), the run
logs a WARNING and continues with **no** baseline, which makes every court
read as changed and re-walks all 54. That is the safe direction — an
expensive night, never a lost document — and the WARNING is there so a full
re-walk is never a mystery.

**If a run needs to be stopped, or looks stuck: do NOT delete
`delta.lock`.** `flock` is advisory on the *open file descriptor*, not the
file name — removing the file releases nothing a live process still holds,
and it opens a window where a fresh run locks the new inode while the old
process is still writing against the database under the previous one. There
is also no "stale lock after a reboot" case to clean up: a reboot kills
whatever held the fd, and the OS releases the lock with it automatically —
nothing to remove by hand either way. Instead, check what is actually
running (`pgrep -fa run-delta.sh`; `pgrep -fa chpipe.delta` separately, since
the `python3` child does not hold the lock fd and can keep running after the
wrapper is gone) and kill the real process. Once nothing holds the fd, the
lock releases itself.

## Cantonal legislation (Lexwork, 19 cantons) and the LexFind registry

Spec: `docs/superpowers/specs/2026-08-26-ch-cantonal-legislation-design.md`.
Migration 201 adds `ch_act.jurisdiction` ('CH' or a canton code),
`ch_act_version.source` ('fedlex' | 'lexwork'), `ch_act_change_document`
(the canton's amending acts) and `ch_cantonal_registry` (LexFind's view of
all 26 cantons). Cantonal acts live in the same tables as federal law, so
`diff`, `project-legacy` and the point-in-time tools work unchanged; the
MCP tools take an optional `canton`.

Stages (`run-stage.sh <stage> [canton]`, `CHPIPE_CANTON` is the env twin):

| stage | what it does |
|---|---|
| `lexfind-registry [canton]` | all 26 cantons (or one): every act and its version list from lexfind.ch into `ch_cantonal_registry`. ~33K acts, hours at 2 req/s; idempotent |
| `cantonal-acts [canton]` | Lexwork host(s): acts + versions (stage `discovered`, source `lexwork`) + change documents. Driving set = host index + change-document index + the registry's numbers for the canton (that is how abrogated acts get in). Comma-separated codes allowed |
| `cantonal-fetch [canton]` | show_as_json payload per version into `akn_xml` (+ audit copy `raw/cantonal/{version_id}.json`). One canton or all; sibling languages share one download |
| `cantonal-parse [canton]` | articles (`ch_act_article`), `full_text`, and provenance from the modification table (`ch_article_provenance`, linked to `ch_act_change_document`) |
| `diff`, `project-legacy` | unchanged; `diff` walks cantonal acts too (`e_id` = Lexwork uid) |
| `reports-cantonal [canton]` | Gate F: Lexwork corpus against the LexFind registry, quality counters, amendment counters |

Backfill order, supervised (never let the first walk happen under the
nightly flock): `lexfind-registry`, then `cantonal-acts BE` as a pilot,
`cantonal-fetch BE`, `cantonal-parse BE`, `diff` (all langs of BE: de, fr),
`reports-cantonal BE`, and read 20 articles against the site before the
other 18 cantons. Then `project-legacy`. Only after Gate F is clean, seed
the delta baseline: `raw/cantonal-state.json` is written by the first
nightly run with today's date per canton and a warning (it walks nothing
on that night); from the next night `run_cantonal` pages each host's
`status/recent_changes` since the baseline and re-walks only the acts
named there. A canton whose host fails keeps its baseline and is retried
the next night. Weekly full re-walk (Sunday 04:00 UTC) alongside the OCR
cron:

    0 4 * * 0 PATH=... /home/ubuntu/SecondLayer/services/ch-pipeline/run-stage.sh cantonal-acts
    0 5 * * 0 PATH=... /home/ubuntu/SecondLayer/services/ch-pipeline/run-stage.sh lexfind-registry

Env: `CHPIPE_CANTONAL_PER_HOST` (default 2) caps requests in flight per
cantonal host; `CHPIPE_HTTP_CONCURRENCY` still caps the total.
`CHPIPE_LIMIT` bounds fetch/parse runs as for the federal stages.

Failure reasons worth knowing: `language 'x' not in payload` means
`cantons.py` expects a language the version does not have (a counted
reason, not a bug in the version); `dates_unparsed` in `cantonal-acts`
means a version date string the parser has not seen (fix the regex, the
version was skipped, never defaulted); `not_on_host` is a LexFind number
the host answers 404 to (BE: 288 old abrogated acts the host dropped, LexFind
keeps them as PDFs); `pdf_only` in `cantonal-fetch` is a version the host
holds only as a PDF (retired at once, reason in `last_error`); and
`tables_unrecognised` in `cantonal-parse` is a modification table whose
header vocabulary `lexwork.py` does not know yet: the edition parsed, its
amendment history did not, add the host's words to `_HEADERS`.

Measured on the BE pilot (2026-08-26): acts ~8/s, fetch ~1K rows/min (367 KB
average payload, sibling languages share one download), parse ~1.6K rows/min,
narrowed diff ~5 acts/s per language; BE end to end 13 minutes.

Phase 2 (not built): text for ZH, VD, TI, NE, GE, JU, SZ from LexFind PDFs
or their own portals; the registry already holds their acts and versions.

## PDF editions (Lexwork PDF-only versions, LexFind PDFs)

Two kinds of edition have no HTML: a Lexwork host's version without a
structured document (`pdf_only` in `cantonal-fetch`: 18,777 rows on
2026-08-26, 670 in-force acts whose CURRENT edition is one; LEXAI-2010),
and the editions only lexfind.ch holds (the seven cantons without a host,
and editions older than a host's history; ~55K PDFs, LEXAI-2016/2017).
Both go through one stage, `pdf-text` (`chpipe/stages/pdf_text_stage.py`),
which claims `ch_act_version` rows with `source IN ('lexwork_pdf',
'lexfind')` at stage `discovered`, downloads `xml_url` (a PDF URL), keeps
the file under `raw/pdf/{version_id}.pdf`, runs `chpipe/pdf_text.py`
(pdftotext -layout, then the split) and stores the raw pdftotext output in
`akn_xml`, the articles in `ch_act_article` and `full_text` -- stage
`parsed`, like the HTML path. `pdf_text.split_text(akn_xml)` re-splits an
edition offline, so a better splitter never needs the PDF again.

The extractor was gated before it was trusted (`scripts/pdf_gate.py`, the
numbers are in its docstring): 60 editions from 9 hosts in de/fr/it/rm
that exist BOTH as HTML and as the host's PDF, compared article by article
-- 60/60 with the same article count, per-article text ratio median 1.000
(p25 1.000, 927 articles), Lexwork uid reproduced for 100% of them, so
`diff` can key a PDF edition against an HTML one of the same act. Known
shapes below 0.9: tables inside a provision (pdftotext emits rows, the
HTML walks cells) and pre-2015 conversions with older layouts (VS 101.1 of
2008 loses two of 103 article headings). Article-less acts (a coat of
arms, an accession decision: 3 of 20 PDF-only editions sampled) are stored
with `article_count = 0` and counted as `empty`, as `cantonal-parse` does;
under 200 characters of text is retired as `text too short`.

Install on prod (once): `pdftotext` is poppler-utils, already on the box
(22.02) for the decisions corpus; the venv needs nothing new
(`~/ch-pipeline-venv` has httpx, lxml, psycopg). Check with
`which pdftotext && ~/ch-pipeline-venv/bin/python -c "import chpipe.pdf_text"`.

Order, supervised (tmux, never under the nightly flock):

    # 1. the 670 in-force acts first: one tol request per act, no PDFs yet
    CHPIPE_CURRENT_ONLY=1 ./run-stage.sh lexwork-pdf-requeue          # or one canton: ... FR
    # 2. their PDFs
    ./run-stage.sh pdf-text                                            # CHPIPE_SOURCE=lexwork_pdf to leave LexFind rows alone
    # 3. read 20 of them against the host, then the rest of the host backlog
    ./run-stage.sh lexwork-pdf-requeue
    ./run-stage.sh pdf-text
    # 4. LexFind (the rows lexfind-registry materialised as source 'lexfind')
    CHPIPE_SOURCE=lexfind ./run-stage.sh pdf-text

`lexwork-pdf-requeue` fetches each act's tol record once (cache per act)
and, per PDF-only row, sets `source = 'lexwork_pdf'`, `stage =
'discovered'`, `xml_url = https://{host}/api/{lang}/versions/{id}/pdf_file`
-- the one URL shape every host uses (read off 60 parsed versions on 9
hosts, confirmed 20/20 live on PDF-only rows across 7 hosts; the tol record
itself lists versions WITHOUT a pdf link). A version the host has since
given a structured document goes back to the HTML path instead
(`requeued_html`); a version the host no longer lists stays failed
(`pdf_only: version not listed by host`). `pdf-text` retires LexFind's
"shadow" rows (same-day replaced editions, `date_end_applicability` one
day before `date_applicability`, ~12.5K) with `last_error =
'shadow_edition'` before its first claim, so they are never downloaded.

Rate: `CHPIPE_PDF_RPS` (default 2) request starts per second per host,
`CHPIPE_CANTONAL_PER_HOST` (default 2) in flight per host, pdftotext
bounded by `CHPIPE_CPU_WORKERS`. Expected runtime: the 18,777 host PDFs
are spread over 18 hosts, and FR (6,172) and GR (4,980) bound the run at
2 req/s: ~52 minutes for FR, ~42 for GR, the other hosts finish inside
that -- about an hour end to end for LEXAI-2010, a few minutes for the
in-force subset (178 FR + 150 GR rows). The ~55K LexFind PDFs are one host
(lexfind.ch) at 2 req/s: ~7.6 hours. Sizes: 100-850 KB per PDF, ~5 GB on
disk for LexFind, ~4 GB for the hosts.

Re-splitting without a download: the first prod pass (2026-08-27, in-force
acts) left 389 of 692 parsed editions with text but `article_count = 0`.
Read on 98 of them: ~175 are decisions in numbered clauses ("1. Der Kanton
tritt ... bei", GR/SO/OW/AG accession decrees), ~30 lists, tables, tariffs
and ballot templates, 28 FR one-paragraph notices ("published only in
French / not in the SGF"), and three heading shapes the splitter did not
know: `Art. 1. Ziele` (number with a dot, 40 rows, SO concordats), a
centred `§1` with the marginal on the next line (ZG/AI accession decrees,
~20) and a left-column marginal on the article's own line (AR 88258). The
three are handled now; the rest have no articles. To apply a splitter
change to what is already stored:

    CHPIPE_RESPLIT=1 ./run-stage.sh pdf-text          # or one canton: ... SO

reads `akn_xml` of every `source IN ('lexwork_pdf','lexfind')` row at
`parsed` with `article_count = 0`, re-runs `pdf_text.split_text` and
rewrites `ch_act_article` + `full_text` for the rows that now split
(`recovered` in the log); nothing is fetched. Expected on the 389: ~60
recovered (15%), the rest are genuinely article-less.

Failure reasons: `not a PDF (...)` (the host answered HTML -- a login page
or an error; retried within the attempt budget), `text too short`,
`pdftotext: ...` (poppler refused the file), `shadow_edition`. Retry with
`db.retry_failed_versions()` as for the other legislation stages.

## Point-in-time benchmark (chpipe.bench)

`chpipe/bench` is a separate package from the two pipelines above. It does
not backfill or maintain any table — it reads `ch_act_change` and the
`ch_act_version`/`ch_act_article` editions on either side of each change
(both already built by the legislation half) and turns them into a
benchmark: dated questions in German, French and Italian asking for the
verbatim text of a specific article as it stood on a specific date, plus a
deterministic scorer that tells a "grounded in the right edition" answer
apart from a "grounded in the wrong edition" one. See
`chpipe/bench/CARD.md` for the full dataset card — construction rules,
every JSONL field, the scorer's thresholds and why they are set where they
are, the licence, and known limits. This section is only the commands.

First run results (build 2026-08-25, oracle 1.000, Haiku 4.5 0.000, Sonnet
4.6 0.003) are in `chpipe/bench/RESULTS.md`.

Not a `run-stage.sh` dispatch target — the benchmark is an occasional,
hand-triggered export and evaluation run, not a nightly pipeline stage.
Run each step from `services/ch-pipeline`.

**1. Build the item files.**

    python -m chpipe.bench.build --langs de,fr,it --out /data/ch-corpus/bench

Reads `ch_act_change` per language, applies the selection rules (modified
rows only, both texts >= 200 normalised chars and not the same string once
normalised, the act in force, the article number unambiguous within both
editions, an abbreviation resolvable for that language, the two editions
not overlapping in the days they claim to be in force, at least one
discriminating unit — see CARD.md, "Construction"), samples down to the
caps (50 changes per act, 5,000 items per language, seeded per language),
and writes `bench-de.jsonl`, `bench-fr.jsonl`, `bench-it.jsonl` plus
`build-report.json` (per-language counts and skip reasons) into `--out`.

The "texts differ" rule is an inequality, not a similarity threshold: a
ratio gate would drop the one-number amendment this benchmark is built to
ask about. See CARD.md, "Construction".

Each surviving change yields an `after` item dated on the change itself and
a `before` item dated on the **old edition's last day in force** (its
inclusive `date_end_applicability`) — not simply the change date minus one
day, which can fall in a gap where Fedlex published no consolidation and no
edition answers the question at all. A change whose old edition's end date
reaches into the new edition's validity is dropped whole
(`overlapping_editions`): on such a day two editions are in force at once
and a covering lookup returns the newer one, so no date is left to ask
about. Whichever half of a pair has the
shorter, wholly-contained text as its gold is dropped (the `after` half of a
deletion, the `before` half of an addition): there is no wording there that
could tell a correct answer from a wrong one. Both rules are spelled out in
CARD.md, "Construction".

**2. Run the oracle.**

    python -m chpipe.bench.run_oracle --items /data/ch-corpus/bench --out /data/ch-corpus/bench

Answers every item straight from the database, the same way the product
tool `ch_get_act_article` resolves an article, with no LLM involved, and
scores each answer. Writes `results-oracle.jsonl`. This run must come back
100% `grounded_correct` — anything less is a bug in the builder or the
scorer, not a fact about the database, and should be treated as a blocker
before running any LLM baseline against the same item files.

**3. Run the Bedrock baselines.**

    python -m chpipe.bench.run_llm --items /data/ch-corpus/bench --out /data/ch-corpus/bench --sample-per-lang 300

Every Bedrock call costs money, so this is gated. Run without
`CHPIPE_BENCH_CONFIRM=1` first: it prints a JSON cost estimate (priced from
item lengths at roughly 4 characters per token against the module's price
table) and exits 2 without calling Bedrock at all. Only once that estimate
looks reasonable, re-run with the confirmation set:

    CHPIPE_BENCH_CONFIRM=1 python -m chpipe.bench.run_llm --items /data/ch-corpus/bench --out /data/ch-corpus/bench --sample-per-lang 300

Default models are the two inference-profile ids baked into `run_llm.py`
(Haiku 4.5 and Sonnet 4.6, `eu-central-1`, re-verify both the ids and the
per-token prices against `aws bedrock list-inference-profiles` before a
real run — see the comments at the top of `run_llm.py`); pass
`--models <id>,<id>,...` to override. Sampling is 300 items per language by
default (`--sample-per-lang`), stratified by `kind` (`before`/`after`) and
seeded the same way the builder's own sampling is. No retrieval: the model
sees only the item's `question` field and the system prompt quoted in
CARD.md, nothing from `gold`/`distractor`. Writes one
`results-llm-{model}.jsonl` per model plus `llm-run-report.json` (the cost
estimate alongside the actual per-model token counts and spend, with the
combined spend in a top-level `actual_total_usd`).

Interrupted runs resume: re-running with the same `--out` skips every item
already answered, re-asks any item whose line records an error, and repairs
a partial line left by a kill mid-write. Nothing already paid for is asked
twice.

**4. Report.**

    python -m chpipe.bench.report --results /data/ch-corpus/bench/results-oracle.jsonl /data/ch-corpus/bench/results-llm-haiku-4-5.jsonl /data/ch-corpus/bench/results-llm-sonnet-4-6.jsonl --items /data/ch-corpus/bench --out /data/ch-corpus/bench/report.json

Pass any number of `results-*.jsonl` files (oracle and/or one or more LLM
runs) to compare them in a single table. Reduces every result line to
per-(language, system, `kind`) counts — plus an `all` row per (language,
system) — with label shares, mean coverages, an `errors` count, the
correct-answer share split on `gold_is_current`, and the "point-in-time
grounding score" (the share of `grounded_correct`); prints a Markdown table
to stdout and writes the same summary as JSON to `--out`.

Read the `gold_is_current = false` column, not the headline score: an item
whose gold edition is still the current wording can be answered correctly
by a system that recites today's text and never resolves the date at all.

**Publication.** Building the benchmark, running the oracle and the
baselines, and writing the report do not publish anything — no dataset
upload, no scorer release. That is a separate, user-approved step; see
`chpipe/bench/CARD.md` for what a publication would carry.
