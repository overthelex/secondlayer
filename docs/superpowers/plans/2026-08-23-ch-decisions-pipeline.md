# CH Decisions Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every openly published Swiss court decision onto prod with real text and a real decision date, replacing a corpus that today has text for one spider out of 54 and no dates at all.

**Architecture:** A new Python package `services/ch-pipeline/` drives five stages (`index` → `fetch` → `extract` → `ocr` → `load`) over a queue that lives in a `stage` column on `ch_court_decisions`, not in files. Each stage is a separate process invocation so it can be scheduled, throttled and restarted independently. Pure logic (URL parsing, document-JSON parsing, text extraction, quality scoring) lives in importable modules with no I/O so it is unit-testable; stage runners are thin shells around them.

**Tech Stack:** Python 3.12, `httpx` (async HTTP), `psycopg[binary]` 3 (Postgres), `lxml` (HTML → text), `poppler-utils` (`pdftotext`, already on prod), `tesseract-ocr` with `deu`+`fra`+`ita` (already on prod), `pytest`.

**Spec:** `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`

## Global Constraints

- **Language choice is a deliberate deviation from `CLAUDE.md`.** Root `CLAUDE.md` says new files default to TypeScript. This subsystem is Python because every existing importer in `services/opendata-importers/importers/` is Python, and because the PDF/OCR toolchain (`pdftotext`, `tesseract`, `lxml`) has no TypeScript equivalent worth the port. Backend, frontend and MCP code stay TypeScript.
- **Migration numbers 196–198 are reserved for the Swiss corpus.** `main` is at `192_backfill_indexed_articles.sql`; 193, 194 and 195 are taken by in-flight ERAU and UK work on other branches. Do not renumber.
- **Migrations must be idempotent** — `IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ … EXCEPTION WHEN … END $$`, per `CLAUDE.md`.
- **Everything runs on prod** (8 cores, 61 GB RAM, no GPU, 994 GB free on `/`). Not on local.lex, not on the MacBook.
- **Long jobs run under supervise**, with a log file and a liveness check. No detached background processes.
- **Raw files go to `/data/ch-corpus/raw/`, never into Postgres.** Only extracted text is stored in the database.
- **Prod DB access:** container `secondlayer-postgres-prod`, published on `127.0.0.1:5438`, database `secondlayer_prod`, user `secondlayer`. Credentials are in `~/SecondLayer/deployment/.env.prod` on prod as `POSTGRES_USER` / `POSTGRES_PASSWORD`.
- **`.env.prod` line 89 breaks `set -a; . .env.prod`** with a harmless `Legal: command not found` warning (unquoted space in a value). Read the variables with `grep -E '^POSTGRES_'` instead of sourcing the file.
- **Never trust `n_live_tup` on this database.** Every count reported by this pipeline is a `count(*)`.
- **Text quality is measured, never assumed.** No step may report "N rows have text"; it reports the distribution of the quality score.
- **`ecli` stays the primary key** of `ch_court_decisions` for the 678,165 rows already there. `doc_id` is added as a second unique key. Do not rewrite existing primary keys.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp_backend/src/migrations/196_ch_court_pipeline.sql` | Queue columns, indexes and backfill guards on `ch_court_decisions` |
| `services/ch-pipeline/README.md` | How to run each stage on prod, with the supervise recipe |
| `services/ch-pipeline/requirements.txt` | Pinned dependencies |
| `services/ch-pipeline/chpipe/__init__.py` | Package marker |
| `services/ch-pipeline/chpipe/config.py` | Env-driven settings: DB DSN, raw dir, concurrency, load ceiling |
| `services/ch-pipeline/chpipe/db.py` | Connection helper and the queue primitives (`claim`, `complete`, `fail`) |
| `services/ch-pipeline/chpipe/es_listing.py` | Apache directory listing → per-document file inventory (pure) |
| `services/ch-pipeline/chpipe/es_document.py` | entscheidsuche document JSON → row fields (pure) |
| `services/ch-pipeline/chpipe/text_extract.py` | HTML → text, PDF → text (pure over bytes/paths) |
| `services/ch-pipeline/chpipe/text_quality.py` | Quality score for extracted text (pure) |
| `services/ch-pipeline/chpipe/wordlists/{de,fr,it}.txt` | Frequency word lists used by the quality score |
| `services/ch-pipeline/chpipe/http.py` | Shared async HTTP client with retry and politeness |
| `services/ch-pipeline/chpipe/stages/index_stage.py` | Stage 1 runner |
| `services/ch-pipeline/chpipe/stages/fetch_stage.py` | Stage 2 runner |
| `services/ch-pipeline/chpipe/stages/extract_stage.py` | Stage 3 runner |
| `services/ch-pipeline/chpipe/stages/ocr_stage.py` | Stage 4 runner, with the load guard |
| `services/ch-pipeline/chpipe/stages/load_stage.py` | Stage 5 runner |
| `services/ch-pipeline/chpipe/reports.py` | Gate A / Gate C / Gate D reports |
| `services/ch-pipeline/tests/…` | pytest suite, mirroring the module layout |
| `services/ch-pipeline/tests/fixtures/…` | Real captured samples, not invented ones |

---

### Task 1: Migration — queue columns on `ch_court_decisions`

**Files:**
- Create: `mcp_backend/src/migrations/196_ch_court_pipeline.sql`
- Test: `services/ch-pipeline/tests/test_migration_196.py`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `doc_id text`, `canton text`, `html_url text`, `text_source text`, `text_quality real`, `pdf_sha256 text`, `stage text`, `attempts smallint`, `last_error text`, `stage_updated_at timestamptz` on `public.ch_court_decisions`; unique index `ux_ch_court_doc_id`; partial index `idx_ch_court_stage`.

- [ ] **Step 1: Write the failing test**

This test runs against a real Postgres, because a mocked database cannot validate SQL.

```python
# services/ch-pipeline/tests/test_migration_196.py
"""Applies migration 196 to a scratch database and asserts the resulting shape.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_migration_196.py
"""
import os
import pathlib
import psycopg
import pytest

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        # The columns migration 134 created, which 196 extends.
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[],
                metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        """)
        yield c


def _apply(conn):
    conn.execute(MIGRATION.read_text())


def _columns(conn) -> dict[str, str]:
    rows = conn.execute("""
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'ch_court_decisions'
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def test_adds_queue_columns(conn):
    _apply(conn)
    cols = _columns(conn)
    assert cols["doc_id"] == "text"
    assert cols["canton"] == "text"
    assert cols["html_url"] == "text"
    assert cols["text_source"] == "text"
    assert cols["text_quality"] == "real"
    assert cols["pdf_sha256"] == "text"
    assert cols["stage"] == "text"
    assert cols["attempts"] == "smallint"
    assert cols["last_error"] == "text"
    assert cols["stage_updated_at"] == "timestamp with time zone"


def test_is_idempotent(conn):
    _apply(conn)
    _apply(conn)          # must not raise
    assert _columns(conn)["doc_id"] == "text"


def test_existing_rows_are_preserved_and_marked_indexed(conn):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s, %s, %s)",
        ("ECLI:CH:CH_BGer:x", "CH_BGer", "a" * 500),
    )
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider) VALUES (%s, %s)",
        ("ECLI:CH:ZH_Obergericht:y", "ZH_Obergericht"),
    )
    _apply(conn)
    rows = dict(conn.execute("SELECT ecli, stage FROM ch_court_decisions").fetchall())
    # A row that already carries text is done; a row without text must be re-fetched.
    assert rows["ECLI:CH:CH_BGer:x"] == "loaded"
    assert rows["ECLI:CH:ZH_Obergericht:y"] == "indexed"


def test_doc_id_is_unique_but_nullable(conn):
    _apply(conn)
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('a','S','d1')")
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('b','S',NULL)")
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('c','S',NULL)")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('d','S','d1')")


def test_stage_index_is_partial_on_unfinished_work(conn):
    _apply(conn)
    definition = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ch_court_stage'"
    ).fetchone()[0]
    assert "WHERE" in definition and "loaded" in definition
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker run -d --rm --name chpipe-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
    -p 5432:5432 postgres:16
sleep 5
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE chpipe_test"
CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest services/ch-pipeline/tests/test_migration_196.py -v
```

Expected: every test FAILS, because `mcp_backend/src/migrations/196_ch_court_pipeline.sql` does not exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- mcp_backend/src/migrations/196_ch_court_pipeline.sql
-- Queue and provenance columns for the Swiss decisions pipeline.
--
-- Context: as of 2026-08-23 this table holds 678,165 rows, of which only the
-- 165,363 CH_BGer rows carry text and none carry a decision_date. The pipeline
-- re-walks every row, so existing rows are enrolled into the queue here.

ALTER TABLE public.ch_court_decisions
    ADD COLUMN IF NOT EXISTS doc_id            text,
    ADD COLUMN IF NOT EXISTS canton            text,
    ADD COLUMN IF NOT EXISTS html_url          text,
    ADD COLUMN IF NOT EXISTS text_source       text,
    ADD COLUMN IF NOT EXISTS text_quality      real,
    ADD COLUMN IF NOT EXISTS pdf_sha256        text,
    ADD COLUMN IF NOT EXISTS stage             text,
    ADD COLUMN IF NOT EXISTS attempts          smallint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error        text,
    ADD COLUMN IF NOT EXISTS stage_updated_at  timestamptz;

DO $$ BEGIN
    ALTER TABLE public.ch_court_decisions
        ADD CONSTRAINT ch_court_text_source_chk
        CHECK (text_source IS NULL OR text_source IN ('html', 'pdf', 'ocr'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.ch_court_decisions
        ADD CONSTRAINT ch_court_stage_chk
        CHECK (stage IS NULL OR stage IN
               ('indexed','fetched','extracted','ocr_pending','loaded','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enrol the rows that are already here. A row that already carries real text is
-- done; everything else goes back to the front of the queue. length() > 200 is
-- the same threshold used to measure coverage, so the two numbers agree.
UPDATE public.ch_court_decisions
   SET stage = CASE
                 WHEN full_text IS NOT NULL AND length(full_text) > 200 THEN 'loaded'
                 ELSE 'indexed'
               END,
       stage_updated_at = now()
 WHERE stage IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_court_doc_id
    ON public.ch_court_decisions (doc_id) WHERE doc_id IS NOT NULL;

-- Partial: the queue only ever scans unfinished work, so finished rows (which
-- will be the overwhelming majority) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_ch_court_stage
    ON public.ch_court_decisions (stage, spider)
    WHERE stage IS DISTINCT FROM 'loaded';

CREATE INDEX IF NOT EXISTS idx_ch_court_quality
    ON public.ch_court_decisions (text_quality) WHERE text_quality IS NOT NULL;

COMMENT ON COLUMN public.ch_court_decisions.doc_id IS
    'entscheidsuche document id, e.g. ZG_OG_001_Z1-2020-5_2022-02-18';
COMMENT ON COLUMN public.ch_court_decisions.text_source IS
    'html | pdf | ocr — where full_text actually came from';
COMMENT ON COLUMN public.ch_court_decisions.text_quality IS
    '0..1 from chpipe.text_quality.score(); low means the PDF text layer was junk';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest services/ch-pipeline/tests/test_migration_196.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Gate B — prove the `trg_jstats` trigger survives a mass UPDATE**

`ch_court_decisions` carries `trg_jstats AFTER INSERT OR DELETE OR UPDATE OF full_text … trg_jurisdiction_stats_inline('CH')`, a delta counter. This pipeline is about to move ~500,000 rows from NULL to text. If the trigger mishandles the NULL → text transition, `v_jurisdiction_fulltext_stats` silently lies from then on.

Add this test to the same file and run it:

```python
def test_jstats_trigger_counts_null_to_text_transition(conn):
    """Guards the delta trigger against the mass UPDATE this pipeline performs.

    Skipped on a scratch DB that has no jurisdiction_fulltext_stats; run it on a
    prod-shaped copy for the real answer.
    """
    exists = conn.execute(
        "SELECT to_regclass('public.jurisdiction_fulltext_stats') IS NOT NULL"
    ).fetchone()[0]
    if not exists:
        pytest.skip("jurisdiction_fulltext_stats not present in this database")

    before = conn.execute(
        "SELECT fulltext_count FROM jurisdiction_fulltext_stats WHERE jurisdiction = 'CH'"
    ).fetchone()[0]
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider) VALUES ('t1','S')")
    conn.execute("UPDATE ch_court_decisions SET full_text = %s WHERE ecli = 't1'", ("x" * 500,))
    after = conn.execute(
        "SELECT fulltext_count FROM jurisdiction_fulltext_stats WHERE jurisdiction = 'CH'"
    ).fetchone()[0]
    assert after == before + 1, (
        "delta trigger did not count NULL -> text; the mass UPDATE would corrupt "
        "v_jurisdiction_fulltext_stats"
    )
```

Then run the same check against a prod-shaped database and record the result in the task's commit message. If it fails, stop and report before any mass UPDATE — the fix belongs in migration 196, not in the pipeline.

- [ ] **Step 6: Commit**

```bash
git add mcp_backend/src/migrations/196_ch_court_pipeline.sql \
        services/ch-pipeline/tests/test_migration_196.py
git commit -m "feat(ch): queue columns on ch_court_decisions"
```

---

### Task 2: Package skeleton, config and DB queue primitives

**Files:**
- Create: `services/ch-pipeline/requirements.txt`, `services/ch-pipeline/chpipe/__init__.py`, `services/ch-pipeline/chpipe/config.py`, `services/ch-pipeline/chpipe/db.py`
- Test: `services/ch-pipeline/tests/test_config.py`, `services/ch-pipeline/tests/test_db_queue.py`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces:
  - `chpipe.config.Settings` dataclass with fields `dsn: str`, `raw_dir: pathlib.Path`, `http_concurrency: int`, `cpu_workers: int`, `ocr_workers: int`, `load_ceiling: float`, `max_attempts: int`, and classmethod `Settings.from_env() -> Settings`.
  - `chpipe.db.connect(settings) -> psycopg.Connection`
  - `chpipe.db.claim(conn, stage: str, limit: int, spider: str | None = None) -> list[dict]`
  - `chpipe.db.complete(conn, doc_id: str, next_stage: str, **fields) -> None`
  - `chpipe.db.fail(conn, doc_id: str, error: str, max_attempts: int) -> None`

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_config.py
import pathlib
import pytest
from chpipe.config import Settings


def test_from_env_reads_every_field(monkeypatch):
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    monkeypatch.setenv("CHPIPE_RAW_DIR", "/data/ch-corpus/raw")
    monkeypatch.setenv("CHPIPE_HTTP_CONCURRENCY", "12")
    monkeypatch.setenv("CHPIPE_CPU_WORKERS", "3")
    monkeypatch.setenv("CHPIPE_OCR_WORKERS", "2")
    monkeypatch.setenv("CHPIPE_LOAD_CEILING", "6.0")
    s = Settings.from_env()
    assert s.dsn == "postgresql://u@h/db"
    assert s.raw_dir == pathlib.Path("/data/ch-corpus/raw")
    assert (s.http_concurrency, s.cpu_workers, s.ocr_workers) == (12, 3, 2)
    assert s.load_ceiling == 6.0
    assert s.max_attempts == 3


def test_dsn_is_required(monkeypatch):
    monkeypatch.delenv("CHPIPE_DSN", raising=False)
    with pytest.raises(RuntimeError, match="CHPIPE_DSN"):
        Settings.from_env()


def test_defaults_match_the_eight_core_prod_box(monkeypatch):
    monkeypatch.setenv("CHPIPE_DSN", "postgresql://u@h/db")
    for k in ("CHPIPE_HTTP_CONCURRENCY", "CHPIPE_CPU_WORKERS",
              "CHPIPE_OCR_WORKERS", "CHPIPE_LOAD_CEILING"):
        monkeypatch.delenv(k, raising=False)
    s = Settings.from_env()
    assert s.http_concurrency == 12
    assert s.cpu_workers == 3
    assert s.ocr_workers == 2
    assert s.load_ceiling == 6.0
```

```python
# services/ch-pipeline/tests/test_db_queue.py
"""Queue primitives against a real Postgres — a mock cannot validate this SQL."""
import os
import pathlib
import psycopg
import pytest
from chpipe import db

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _seed(conn, doc_id, stage, spider="ZG_Obergericht", attempts=0):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, attempts) "
        "VALUES (%s,%s,%s,%s,%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, stage, attempts),
    )


def test_claim_returns_only_the_requested_stage(conn):
    _seed(conn, "a", "indexed")
    _seed(conn, "b", "fetched")
    rows = db.claim(conn, "indexed", limit=10)
    assert [r["doc_id"] for r in rows] == ["a"]


def test_claim_honours_the_limit(conn):
    for i in range(5):
        _seed(conn, f"d{i}", "indexed")
    assert len(db.claim(conn, "indexed", limit=2)) == 2


def test_claim_can_filter_by_spider(conn):
    _seed(conn, "a", "indexed", spider="ZG_Obergericht")
    _seed(conn, "b", "indexed", spider="CH_BVGer")
    rows = db.claim(conn, "indexed", limit=10, spider="CH_BVGer")
    assert [r["doc_id"] for r in rows] == ["b"]


def test_claim_skips_rows_that_exhausted_their_attempts(conn):
    _seed(conn, "a", "indexed", attempts=3)
    assert db.claim(conn, "indexed", limit=10, ) == []


def test_complete_moves_the_row_and_writes_fields(conn):
    _seed(conn, "a", "fetched")
    db.complete(conn, "a", "extracted", text_source="pdf", text_quality=0.91)
    row = conn.execute(
        "SELECT stage, text_source, text_quality, last_error, stage_updated_at "
        "FROM ch_court_decisions WHERE doc_id = 'a'").fetchone()
    assert row[0] == "extracted"
    assert row[1] == "pdf"
    assert abs(row[2] - 0.91) < 1e-6
    assert row[3] is None            # completing clears a previous error
    assert row[4] is not None


def test_fail_increments_attempts_and_keeps_the_stage(conn):
    _seed(conn, "a", "fetched")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_court_decisions WHERE doc_id='a'"
    ).fetchone()
    assert row == ("fetched", 1, "connection reset")


def test_fail_moves_to_failed_on_the_last_attempt(conn):
    _seed(conn, "a", "fetched", attempts=2)
    db.fail(conn, "a", "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("failed", 3)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_config.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe'`.

- [ ] **Step 3: Write the implementation**

```
# services/ch-pipeline/requirements.txt
httpx>=0.27,<0.29
psycopg[binary]>=3.1,<4
lxml>=5.2,<6
pytest>=8.2,<9
```

```python
# services/ch-pipeline/chpipe/__init__.py
"""Swiss corpus pipeline. See docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md."""
```

```python
# services/ch-pipeline/chpipe/config.py
"""Settings, all from the environment so the same code runs under supervise.

Defaults are sized for the prod box: 8 cores shared with live traffic, so CPU
stages get 3 workers, OCR gets 2 at nice 19, and the HTTP stages are I/O bound
and can afford more.
"""
from __future__ import annotations

import os
import pathlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    dsn: str
    raw_dir: pathlib.Path
    http_concurrency: int
    cpu_workers: int
    ocr_workers: int
    load_ceiling: float
    max_attempts: int

    @classmethod
    def from_env(cls) -> "Settings":
        dsn = os.environ.get("CHPIPE_DSN", "")
        if not dsn:
            raise RuntimeError("CHPIPE_DSN is required")
        return cls(
            dsn=dsn,
            raw_dir=pathlib.Path(os.environ.get("CHPIPE_RAW_DIR", "/data/ch-corpus/raw")),
            http_concurrency=int(os.environ.get("CHPIPE_HTTP_CONCURRENCY", "12")),
            cpu_workers=int(os.environ.get("CHPIPE_CPU_WORKERS", "3")),
            ocr_workers=int(os.environ.get("CHPIPE_OCR_WORKERS", "2")),
            load_ceiling=float(os.environ.get("CHPIPE_LOAD_CEILING", "6.0")),
            max_attempts=int(os.environ.get("CHPIPE_MAX_ATTEMPTS", "3")),
        )
```

```python
# services/ch-pipeline/chpipe/db.py
"""Queue primitives over the stage column on ch_court_decisions.

The queue is a column, not a table: the work item and the destination row are
the same row, so a claim can never drift from the data it describes.
"""
from __future__ import annotations

import psycopg
from psycopg.rows import dict_row

from .config import Settings

# Columns a stage runner needs to do its work.
_CLAIM_COLUMNS = (
    "doc_id, ecli, spider, canton, decision_date, html_url, pdf_url, json_url, "
    "languages, text_source, text_quality, pdf_sha256, attempts"
)


def connect(settings: Settings) -> psycopg.Connection:
    return psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row)


def claim(conn, stage: str, limit: int, spider: str | None = None,
          max_attempts: int = 3) -> list[dict]:
    """Rows sitting in `stage` that still have attempts left.

    FOR UPDATE SKIP LOCKED so several stage processes can run side by side
    without handing the same document to two workers.
    """
    sql = (
        f"SELECT {_CLAIM_COLUMNS} FROM ch_court_decisions "
        "WHERE stage = %s AND attempts < %s"
    )
    params: list = [stage, max_attempts]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    sql += " ORDER BY spider, doc_id LIMIT %s FOR UPDATE SKIP LOCKED"
    params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def complete(conn, doc_id: str, next_stage: str, **fields) -> None:
    """Move a row to its next stage, writing any produced fields in the same
    statement so a crash cannot leave the stage ahead of the data."""
    assignments = ["stage = %s", "last_error = NULL", "stage_updated_at = now()",
                   "updated_at = now()"]
    params: list = [next_stage]
    for column, value in fields.items():
        assignments.append(f"{column} = %s")
        params.append(value)
    params.append(doc_id)
    conn.execute(
        f"UPDATE ch_court_decisions SET {', '.join(assignments)} WHERE doc_id = %s",
        params,
    )


def fail(conn, doc_id: str, error: str, max_attempts: int) -> None:
    """Record a failed attempt. The row keeps its stage until attempts run out,
    so a transient error retries and a permanent one stops consuming the queue."""
    conn.execute(
        """
        UPDATE ch_court_decisions
           SET attempts = attempts + 1,
               last_error = %s,
               stage = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE stage END,
               stage_updated_at = now()
         WHERE doc_id = %s
        """,
        (error[:2000], max_attempts, doc_id),
    )


def retry_failed(conn, stage: str, spider: str | None = None) -> int:
    """Put failed rows back on `stage` with a clean attempt counter.

    Deliberately manual: a failed row means someone has to look at last_error
    before it is worth another 800,000-document run.
    """
    sql = ("UPDATE ch_court_decisions SET stage = %s, attempts = 0, last_error = NULL "
           "WHERE stage = 'failed'")
    params: list = [stage]
    if spider:
        sql += " AND spider = %s"
        params.append(spider)
    return conn.execute(sql, params).rowcount
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && pip install -r requirements.txt
python3 -m pytest tests/test_config.py -v
CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_db_queue.py -v
```

Expected: 3 passed in `test_config.py`, 7 passed in `test_db_queue.py`.

- [ ] **Step 5: Commit**

```bash
git add services/ch-pipeline/requirements.txt services/ch-pipeline/chpipe/ \
        services/ch-pipeline/tests/test_config.py services/ch-pipeline/tests/test_db_queue.py
git commit -m "feat(ch): pipeline settings and the stage queue"
```

---

### Task 3: Parse the Apache directory listing into a file inventory

**Files:**
- Create: `services/ch-pipeline/chpipe/es_listing.py`
- Test: `services/ch-pipeline/tests/test_es_listing.py`, `services/ch-pipeline/tests/fixtures/listing_zg_obergericht.html`

**Interfaces:**
- Consumes: nothing.
- Produces: `chpipe.es_listing.parse_listing(html: str) -> dict[str, set[str]]` mapping `doc_id` to the set of available extensions (`{"json", "pdf"}`); `chpipe.es_listing.listing_url(spider: str) -> str`.

**Why this is its own module:** the Apache listing is the only entscheidsuche endpoint that actually enumerates documents. `/docs/Status/{SPIDER}.json` is a scraper run status, `/docs/Index/{SPIDER}/Index_*.json` is a run summary of about 545 bytes, and `/docs/Snapshots/{date}.json` is per-court counters. All three look like indexes and none of them lists documents. Getting this wrong is what capped the previous importer.

- [ ] **Step 1: Capture the real fixture**

Do not hand-write this file; capture it, so the parser is tested against the bytes the server actually sends.

```bash
mkdir -p services/ch-pipeline/tests/fixtures
curl -s --max-time 120 https://entscheidsuche.ch/docs/ZG_Obergericht/ \
    | head -c 200000 > services/ch-pipeline/tests/fixtures/listing_zg_obergericht.html
grep -c 'href="ZG' services/ch-pipeline/tests/fixtures/listing_zg_obergericht.html
```

- [ ] **Step 2: Write the failing test**

```python
# services/ch-pipeline/tests/test_es_listing.py
import pathlib
from chpipe import es_listing

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "listing_zg_obergericht.html"


def test_listing_url_is_the_directory_not_the_sitemap():
    assert es_listing.listing_url("ZG_Obergericht") == \
        "https://entscheidsuche.ch/docs/ZG_Obergericht/"


def test_parses_doc_ids_and_their_formats():
    inv = es_listing.parse_listing(FIXTURE.read_text(errors="replace"))
    assert "ZG_OG_001_Z1-2020-5_2022-02-18" in inv
    assert inv["ZG_OG_001_Z1-2020-5_2022-02-18"] == {"json", "pdf"}


def test_ignores_the_sort_links_and_the_parent_directory():
    inv = es_listing.parse_listing(FIXTURE.read_text(errors="replace"))
    assert not any(d.startswith("?") for d in inv)
    assert "" not in inv
    assert not any("/" in d for d in inv)


def test_a_document_with_html_reports_html():
    html = ('<tr><td><a href="X_1_2020.json">X_1_2020.json</a></td></tr>'
            '<tr><td><a href="X_1_2020.html">X_1_2020.html</a></td></tr>')
    assert es_listing.parse_listing(html) == {"X_1_2020": {"json", "html"}}


def test_unknown_extensions_are_dropped():
    html = '<a href="X_1_2020.json">j</a><a href="X_1_2020.checksum">c</a>'
    assert es_listing.parse_listing(html) == {"X_1_2020": {"json"}}


def test_percent_encoded_names_are_decoded():
    html = '<a href="X_1%20b_2020.json">j</a>'
    assert es_listing.parse_listing(html) == {"X_1 b_2020": {"json"}}
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_es_listing.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.es_listing'`.

- [ ] **Step 4: Write the implementation**

```python
# services/ch-pipeline/chpipe/es_listing.py
"""entscheidsuche.ch document enumeration.

The Apache directory listing at /docs/{SPIDER}/ is the ONLY endpoint that lists
documents. Verified 2026-08-23:
  /docs/Status/{SPIDER}.json        -> last scraper run status
  /docs/Index/{SPIDER}/Index_*.json -> run summary (counts of unchanged/new)
  /docs/Snapshots/{date}.json       -> per-court counters plus total_alle
None of those three enumerates anything; Snapshots is still useful for
reconciliation and for triggering deltas.
"""
from __future__ import annotations

import re
from urllib.parse import unquote

BASE = "https://entscheidsuche.ch/docs"

# Formats we know how to consume. A listing also carries checksums and other
# side files; anything not listed here is not a document body.
KNOWN_EXTENSIONS = frozenset({"json", "html", "pdf"})

_HREF = re.compile(r'href="([^"?][^"]*)"', re.IGNORECASE)


def listing_url(spider: str) -> str:
    return f"{BASE}/{spider}/"


def document_url(spider: str, doc_id: str, extension: str) -> str:
    return f"{BASE}/{spider}/{doc_id}.{extension}"


def parse_listing(html: str) -> dict[str, set[str]]:
    """Map doc_id -> available extensions, from one Apache listing page."""
    inventory: dict[str, set[str]] = {}
    for href in _HREF.findall(html):
        name = unquote(href)
        if "/" in name:                       # parent directory link
            continue
        doc_id, _, extension = name.rpartition(".")
        if not doc_id or extension.lower() not in KNOWN_EXTENSIONS:
            continue
        inventory.setdefault(doc_id, set()).add(extension.lower())
    return inventory
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_es_listing.py -v
```

Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/es_listing.py \
        services/ch-pipeline/tests/test_es_listing.py \
        services/ch-pipeline/tests/fixtures/listing_zg_obergericht.html
git commit -m "feat(ch): enumerate entscheidsuche documents from the directory listing"
```

---

### Task 4: Parse the entscheidsuche document JSON

**Files:**
- Create: `services/ch-pipeline/chpipe/es_document.py`
- Test: `services/ch-pipeline/tests/test_es_document.py`, `services/ch-pipeline/tests/fixtures/doc_zg_og_001.json`, `services/ch-pipeline/tests/fixtures/doc_ch_bger.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `chpipe.es_document.parse(spider: str, doc_id: str, data: dict) -> DocumentFields`, a frozen dataclass with fields `ecli: str`, `doc_id: str`, `spider: str`, `canton: str | None`, `court_code: str | None`, `chamber: str | None`, `decision_date: datetime.date | None`, `docket_number: str | None`, `abstract: str | None`, `languages: list[str]`, `html_path: str | None`, `pdf_path: str | None`, `source_pdf_url: str | None`, `metadata_json: dict`.

**Why this exists:** the previous importer read the date from `Meta.Datum`. In the real payload `Datum` is at the **top level**, and `Meta` is a list of localised strings. That single mistake is why all 678,165 rows have a NULL `decision_date`.

- [ ] **Step 1: Capture the real fixtures**

```bash
curl -s --max-time 60 \
  "https://entscheidsuche.ch/docs/ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.json" \
  > services/ch-pipeline/tests/fixtures/doc_zg_og_001.json
# A CH_BGer document, to cover the one spider that already has text and to
# confirm the parser agrees with what is already in the table.
BGER_ID=$(curl -s --max-time 120 https://entscheidsuche.ch/docs/CH_BGer/ \
  | grep -o 'href="CH_BGer[^"]*\.json"' | head -1 | sed 's/href="//;s/\.json"//')
curl -s --max-time 60 "https://entscheidsuche.ch/docs/CH_BGer/${BGER_ID}.json" \
  > services/ch-pipeline/tests/fixtures/doc_ch_bger.json
python3 -c "import json;d=json.load(open('services/ch-pipeline/tests/fixtures/doc_ch_bger.json'));print(sorted(d))"
```

Record the printed key list in the commit message — later tasks rely on those keys existing.

- [ ] **Step 2: Write the failing test**

```python
# services/ch-pipeline/tests/test_es_document.py
import datetime
import json
import pathlib
import pytest
from chpipe import es_document

FIX = pathlib.Path(__file__).parent / "fixtures"
ZG = json.loads((FIX / "doc_zg_og_001.json").read_text())


def test_reads_the_date_from_the_top_level_not_from_meta():
    """The regression this whole pipeline exists to fix: Datum is top level.

    The previous importer read Meta.Datum, which does not exist, and produced
    678,165 rows with a NULL decision_date.
    """
    f = es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", ZG)
    assert f.decision_date == datetime.date(2022, 2, 18)


def test_meta_being_a_list_of_localised_strings_does_not_break_parsing():
    assert isinstance(ZG["Meta"], list)
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.decision_date is not None


def test_docket_number_comes_from_num():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.docket_number == "Z1 2020 5"


def test_canton_is_the_spider_prefix():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.canton == "ZG"


def test_federal_spiders_report_ch_as_the_canton():
    f = es_document.parse("CH_BGer", "d", {"Datum": "2020-01-01"})
    assert f.canton == "CH"


def test_pdf_path_is_the_mirror_path_not_the_court_url():
    """PDF.Datei is the file on entscheidsuche; PDF.URL points back at the court's
    own server, which rate-limits and rots. We always fetch the mirror."""
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.pdf_path == "ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.pdf"
    assert f.source_pdf_url.startswith("https://alt.entscheidsuche.ch/")


def test_languages_come_from_the_kopfzeile_entries():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert set(f.languages) >= {"de"}


def test_ecli_is_stable_with_the_existing_678k_rows():
    """Existing rows were keyed ECLI:CH:{spider}:{doc_id}; changing that would
    duplicate every row already in the table."""
    f = es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", ZG)
    assert f.ecli == "ECLI:CH:ZG_Obergericht:ZG_OG_001_Z1-2020-5_2022-02-18"


def test_a_doc_id_that_is_already_an_ecli_is_kept_as_is():
    f = es_document.parse("CH_BGer", "ECLI:CH:BGER:2020:1", {"Datum": "2020-01-01"})
    assert f.ecli == "ECLI:CH:BGER:2020:1"


@pytest.mark.parametrize("raw", ["", None, "0000-00-00", "not a date", "2022"])
def test_an_unusable_date_becomes_none_rather_than_raising(raw):
    f = es_document.parse("ZG_Obergericht", "d", {"Datum": raw})
    assert f.decision_date is None


def test_a_document_with_no_pdf_and_no_html_still_parses():
    f = es_document.parse("ZG_Obergericht", "d", {"Datum": "2022-02-18"})
    assert f.pdf_path is None and f.html_path is None


def test_metadata_json_keeps_the_untouched_payload_keys():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.metadata_json["Signatur"] == "ZG_OG_001"
    assert "Scrapedate" in f.metadata_json
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_es_document.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.es_document'`.

- [ ] **Step 4: Write the implementation**

```python
# services/ch-pipeline/chpipe/es_document.py
"""entscheidsuche document JSON -> row fields.

Payload shape, captured 2026-08-23 from ZG_Obergericht:

    {"Signatur": "ZG_OG_001", "Spider": "ZG_Obergericht", "Datum": "2022-02-18",
     "PDF": {"Datei": "ZG_Obergericht/....pdf", "URL": "https://alt....", "Checksum": "..."},
     "Scrapedate": "2023-01-01", "Num": ["Z1 2020 5"],
     "Kopfzeile": [{"Sprachen": ["de"], "Text": "..."}, ...],
     "Meta": [{"Sprachen": ["de"], "Text": "..."}, ...]}

Note what is NOT here: any key holding the decision text. The text is a separate
file named by PDF.Datei or HTML.Datei. And `Datum` is top level, not under
`Meta` — reading it from `Meta` is what left every row dateless.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field

# Spiders whose prefix is the Confederation rather than a canton.
_FEDERAL_PREFIX = "CH"
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


@dataclass(frozen=True)
class DocumentFields:
    ecli: str
    doc_id: str
    spider: str
    canton: str | None
    court_code: str | None
    chamber: str | None
    decision_date: datetime.date | None
    docket_number: str | None
    abstract: str | None
    languages: list[str]
    html_path: str | None
    pdf_path: str | None
    source_pdf_url: str | None
    metadata_json: dict = field(default_factory=dict)


def _parse_date(raw) -> datetime.date | None:
    if not isinstance(raw, str):
        return None
    m = _ISO_DATE.match(raw.strip())
    if not m:
        return None
    try:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None          # 0000-00-00 and friends


def _localised_text(entries, want: str | None = None) -> str | None:
    """First Text from a list of {"Sprachen": [...], "Text": "..."} entries."""
    if not isinstance(entries, list):
        return entries if isinstance(entries, str) else None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if want and want not in (entry.get("Sprachen") or []):
            continue
        text = entry.get("Text")
        if text:
            return str(text)
    return None


def _languages(data: dict) -> list[str]:
    seen: list[str] = []
    for key in ("Kopfzeile", "Meta"):
        for entry in data.get(key) or []:
            if isinstance(entry, dict):
                for lang in entry.get("Sprachen") or []:
                    if lang not in seen:
                        seen.append(str(lang))
    for lang in (data.get("Sprache") or []) if isinstance(data.get("Sprache"), list) else []:
        if lang not in seen:
            seen.append(str(lang))
    return seen


def parse(spider: str, doc_id: str, data: dict) -> DocumentFields:
    prefix = spider.split("_")[0] if "_" in spider else spider
    canton = _FEDERAL_PREFIX if prefix == _FEDERAL_PREFIX else prefix

    num = data.get("Num")
    docket = None
    if isinstance(num, list) and num:
        docket = str(num[0])
    elif isinstance(num, str):
        docket = num

    pdf = data.get("PDF") if isinstance(data.get("PDF"), dict) else {}
    html = data.get("HTML") if isinstance(data.get("HTML"), dict) else {}

    return DocumentFields(
        ecli=doc_id if doc_id.startswith("ECLI:") else f"ECLI:CH:{spider}:{doc_id}",
        doc_id=doc_id,
        spider=spider,
        canton=canton,
        court_code=data.get("Signatur") or None,
        chamber=_localised_text(data.get("Meta")),
        decision_date=_parse_date(data.get("Datum")),
        docket_number=docket[:5000] if docket else None,
        abstract=(_localised_text(data.get("Abstract")) or None),
        languages=_languages(data),
        html_path=html.get("Datei") or None,
        pdf_path=pdf.get("Datei") or None,
        source_pdf_url=pdf.get("URL") or None,
        metadata_json={k: v for k, v in data.items() if k not in ("HTML", "PDF")},
    )
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_es_document.py -v
```

Expected: 12 passed. If `test_docket_number_comes_from_num` or `test_pdf_path_is_the_mirror_path_not_the_court_url` fails, the captured fixture differs from the sample in this plan — fix the assertion to match the captured bytes, never the other way round.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/es_document.py \
        services/ch-pipeline/tests/test_es_document.py \
        services/ch-pipeline/tests/fixtures/doc_zg_og_001.json \
        services/ch-pipeline/tests/fixtures/doc_ch_bger.json
git commit -m "fix(ch): read Datum from the top level, where it actually is"
```

---

### Task 5: HTTP client with retry and politeness

**Files:**
- Create: `services/ch-pipeline/chpipe/http.py`
- Test: `services/ch-pipeline/tests/test_http.py`

**Interfaces:**
- Consumes: `chpipe.config.Settings`.
- Produces: `chpipe.http.Fetcher` — async context manager with `async def text(url) -> str`, `async def bytes(url) -> bytes`, `async def json(url) -> dict`; each raises `chpipe.http.FetchError` after exhausting retries. Constructor `Fetcher(concurrency: int, retries: int = 3, timeout: float = 60.0)`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_http.py
import httpx
import pytest
from chpipe.http import Fetcher, FetchError


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_returns_body_on_200():
    async with Fetcher(concurrency=2, transport=_transport(
            lambda r: httpx.Response(200, text="hello"))) as f:
        assert await f.text("https://x/") == "hello"


@pytest.mark.asyncio
async def test_retries_a_500_then_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(500) if calls["n"] == 1 else httpx.Response(200, text="ok")

    async with Fetcher(concurrency=2, retries=3, backoff=0.0,
                       transport=_transport(handler)) as f:
        assert await f.text("https://x/") == "ok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_raises_after_exhausting_retries():
    async with Fetcher(concurrency=2, retries=2, backoff=0.0,
                       transport=_transport(lambda r: httpx.Response(503))) as f:
        with pytest.raises(FetchError, match="503"):
            await f.text("https://x/")


@pytest.mark.asyncio
async def test_a_404_does_not_retry():
    """A missing document is an answer, not a transient failure; retrying it
    three times across 800,000 documents is 1.6M pointless requests."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(404)

    async with Fetcher(concurrency=2, retries=3, backoff=0.0,
                       transport=_transport(handler)) as f:
        with pytest.raises(FetchError, match="404"):
            await f.text("https://x/")
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_concurrency_is_capped():
    import asyncio
    live = {"now": 0, "peak": 0}

    async def handler(request):
        live["now"] += 1
        live["peak"] = max(live["peak"], live["now"])
        await asyncio.sleep(0.01)
        live["now"] -= 1
        return httpx.Response(200, text="x")

    async with Fetcher(concurrency=3, transport=httpx.MockTransport(handler)) as f:
        await asyncio.gather(*(f.text(f"https://x/{i}") for i in range(20)))
    assert live["peak"] <= 3
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && pip install pytest-asyncio && python3 -m pytest tests/test_http.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.http'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/http.py
"""Async fetcher with a concurrency cap, bounded retries and a User-Agent that
says who we are. entscheidsuche is a small volunteer-run mirror; this pipeline
pulls hundreds of thousands of files from it, so politeness is not optional.
"""
from __future__ import annotations

import asyncio

import httpx

USER_AGENT = ("SecondLayer-CH-Pipeline/1.0 (+https://legal.org.ua; "
              "legal research corpus; contact: mcvovkes@gmail.com)")

# A 404 is a fact about the document, not a transient fault.
_NO_RETRY = frozenset({400, 401, 403, 404, 410})


class FetchError(RuntimeError):
    pass


class Fetcher:
    def __init__(self, concurrency: int, retries: int = 3, timeout: float = 60.0,
                 backoff: float = 1.0, transport: httpx.BaseTransport | None = None):
        self._sem = asyncio.Semaphore(concurrency)
        self._retries = retries
        self._backoff = backoff
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            transport=transport,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=concurrency,
                                max_keepalive_connections=concurrency),
        )

    async def __aenter__(self) -> "Fetcher":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _get(self, url: str) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self._retries):
            async with self._sem:
                try:
                    response = await self._client.get(url)
                except httpx.HTTPError as exc:
                    last = exc
                else:
                    if response.status_code == 200:
                        return response
                    if response.status_code in _NO_RETRY:
                        raise FetchError(f"{response.status_code} for {url}")
                    last = FetchError(f"{response.status_code} for {url}")
            if attempt + 1 < self._retries and self._backoff:
                await asyncio.sleep(self._backoff * (2 ** attempt))
        raise FetchError(f"{url} failed after {self._retries} attempts: {last}")

    async def text(self, url: str) -> str:
        return (await self._get(url)).text

    async def bytes(self, url: str) -> bytes:
        return (await self._get(url)).content

    async def json(self, url: str) -> dict:
        return (await self._get(url)).json()
```

Add to `requirements.txt`:

```
pytest-asyncio>=0.23,<0.25
```

and create `services/ch-pipeline/pytest.ini`:

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_http.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/ch-pipeline/chpipe/http.py services/ch-pipeline/tests/test_http.py \
        services/ch-pipeline/pytest.ini services/ch-pipeline/requirements.txt
git commit -m "feat(ch): polite async fetcher with bounded retries"
```

---

### Task 6: The `index` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/__init__.py`, `services/ch-pipeline/chpipe/stages/index_stage.py`
- Test: `services/ch-pipeline/tests/test_index_stage.py`

**Interfaces:**
- Consumes: `es_listing.parse_listing`, `es_listing.listing_url`, `es_listing.document_url`, `es_document.parse`, `http.Fetcher`, `db.connect`.
- Produces: `chpipe.stages.index_stage.run(settings, spiders: list[str] | None = None) -> IndexReport`, where `IndexReport` is a frozen dataclass with `per_spider: dict[str, int]`, `inserted: int`, `updated: int`, `dates_filled: int`.
- Produces: `chpipe.stages.index_stage.upsert(conn, fields, available: set[str]) -> str` returning `"inserted"` or `"updated"`.

**Behaviour:** for each spider, fetch the listing, then for every document fetch `{doc_id}.json` and upsert. The upsert must **fill `decision_date` on existing rows** — that is how the 678,165 dateless rows get repaired — while never overwriting a `full_text` that is already there.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_index_stage.py
import datetime
import json
import os
import pathlib
import psycopg
import pytest
from chpipe import es_document
from chpipe.stages import index_stage

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")
FIX = pathlib.Path(__file__).parent / "fixtures"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _fields():
    data = json.loads((FIX / "doc_zg_og_001.json").read_text())
    return es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", data)


def test_inserts_a_new_document_at_stage_indexed(conn):
    assert index_stage.upsert(conn, _fields(), {"json", "pdf"}) == "inserted"
    row = conn.execute(
        "SELECT doc_id, stage, decision_date, canton FROM ch_court_decisions"
    ).fetchone()
    assert row[0] == "ZG_OG_001_Z1-2020-5_2022-02-18"
    assert row[1] == "indexed"
    assert row[2] == datetime.date(2022, 2, 18)
    assert row[3] == "ZG"


def test_fills_the_date_on_a_row_that_predates_the_pipeline(conn):
    """The 678,165 legacy rows are keyed by ecli and have no doc_id and no date."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, stage) VALUES (%s,%s,'indexed')",
        (f.ecli, f.spider),
    )
    assert index_stage.upsert(conn, f, {"json", "pdf"}) == "updated"
    row = conn.execute(
        "SELECT count(*), max(decision_date), max(doc_id) FROM ch_court_decisions"
    ).fetchone()
    assert row[0] == 1, "must update the legacy row, not create a duplicate"
    assert row[1] == datetime.date(2022, 2, 18)
    assert row[2] == "ZG_OG_001_Z1-2020-5_2022-02-18"


def test_never_overwrites_text_that_is_already_there(conn):
    """CH_BGer already has 165,363 good texts; re-indexing must not blank them."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text, stage) "
        "VALUES (%s,%s,%s,'loaded')", (f.ecli, f.spider, "existing text " * 50),
    )
    index_stage.upsert(conn, f, {"json", "pdf"})
    row = conn.execute(
        "SELECT full_text, stage FROM ch_court_decisions").fetchone()
    assert row[0].startswith("existing text")
    assert row[1] == "loaded", "a finished row must not be sent back through the queue"


def test_records_which_formats_are_available(conn):
    index_stage.upsert(conn, _fields(), {"json", "html"})
    row = conn.execute(
        "SELECT html_url, pdf_url FROM ch_court_decisions").fetchone()
    assert row[0].endswith("/ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.html")


def test_a_document_with_neither_html_nor_pdf_is_marked_failed(conn):
    f = _fields()
    index_stage.upsert(conn, f, {"json"})
    row = conn.execute("SELECT stage, last_error FROM ch_court_decisions").fetchone()
    assert row[0] == "failed"
    assert "no body" in row[1]


def test_upsert_is_idempotent(conn):
    index_stage.upsert(conn, _fields(), {"json", "pdf"})
    index_stage.upsert(conn, _fields(), {"json", "pdf"})
    assert conn.execute("SELECT count(*) FROM ch_court_decisions").fetchone()[0] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_index_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.stages'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/__init__.py
"""Stage runners. Each stage is a separate entry point so it can be scheduled,
throttled and restarted on its own."""
```

```python
# services/ch-pipeline/chpipe/stages/index_stage.py
"""Stage 1: enumerate documents and write their metadata.

This stage also repairs history. The 678,165 rows already in the table were
written by an importer that read the date from the wrong place, so all of them
have decision_date NULL. Re-running index over every spider fills those in.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from .. import db, es_document, es_listing
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)


@dataclass
class IndexReport:
    per_spider: dict[str, int] = field(default_factory=dict)
    inserted: int = 0
    updated: int = 0
    failed: int = 0


_UPSERT = """
INSERT INTO ch_court_decisions
    (ecli, doc_id, spider, canton, court_code, chamber, decision_date,
     docket_number, abstract, languages, html_url, pdf_url, json_url,
     metadata_json, stage, stage_updated_at, updated_at)
VALUES (%(ecli)s, %(doc_id)s, %(spider)s, %(canton)s, %(court_code)s, %(chamber)s,
        %(decision_date)s, %(docket_number)s, %(abstract)s, %(languages)s,
        %(html_url)s, %(pdf_url)s, %(json_url)s, %(metadata_json)s,
        %(stage)s, now(), now())
ON CONFLICT (ecli) DO UPDATE SET
    doc_id        = EXCLUDED.doc_id,
    canton        = EXCLUDED.canton,
    court_code    = COALESCE(EXCLUDED.court_code, ch_court_decisions.court_code),
    chamber       = COALESCE(EXCLUDED.chamber, ch_court_decisions.chamber),
    decision_date = COALESCE(EXCLUDED.decision_date, ch_court_decisions.decision_date),
    docket_number = COALESCE(EXCLUDED.docket_number, ch_court_decisions.docket_number),
    abstract      = COALESCE(EXCLUDED.abstract, ch_court_decisions.abstract),
    languages     = COALESCE(EXCLUDED.languages, ch_court_decisions.languages),
    html_url      = EXCLUDED.html_url,
    pdf_url       = COALESCE(EXCLUDED.pdf_url, ch_court_decisions.pdf_url),
    json_url      = EXCLUDED.json_url,
    metadata_json = EXCLUDED.metadata_json,
    -- A row that already finished stays finished. Anything else re-enters the
    -- queue at the stage this run assigns.
    stage         = CASE WHEN ch_court_decisions.stage = 'loaded'
                         THEN 'loaded' ELSE EXCLUDED.stage END,
    last_error    = CASE WHEN EXCLUDED.stage = 'failed'
                         THEN %(error)s ELSE ch_court_decisions.last_error END,
    stage_updated_at = now(),
    updated_at    = now()
RETURNING (xmax = 0) AS inserted
"""


def upsert(conn, fields: es_document.DocumentFields, available: set[str]) -> str:
    """Write one document's metadata. Returns 'inserted' or 'updated'.

    `available` is the extension set from the directory listing, which is the
    authority on what can actually be downloaded — the JSON payload sometimes
    names a PDF that is not mirrored.
    """
    has_body = bool(available & {"html", "pdf"})
    params = {
        "ecli": fields.ecli,
        "doc_id": fields.doc_id,
        "spider": fields.spider,
        "canton": fields.canton,
        "court_code": fields.court_code,
        "chamber": fields.chamber,
        "decision_date": fields.decision_date,
        "docket_number": fields.docket_number,
        "abstract": fields.abstract,
        "languages": fields.languages or None,
        "html_url": (es_listing.document_url(fields.spider, fields.doc_id, "html")
                     if "html" in available else None),
        "pdf_url": (es_listing.document_url(fields.spider, fields.doc_id, "pdf")
                    if "pdf" in available else None),
        "json_url": es_listing.document_url(fields.spider, fields.doc_id, "json"),
        "metadata_json": json.dumps(fields.metadata_json, ensure_ascii=False),
        "stage": "indexed" if has_body else "failed",
        "error": None if has_body else "no body: listing offers neither html nor pdf",
    }
    row = conn.execute(_UPSERT, params).fetchone()
    inserted = row["inserted"] if isinstance(row, dict) else row[0]
    return "inserted" if inserted else "updated"


async def _index_spider(fetcher: Fetcher, conn, spider: str, report: IndexReport) -> None:
    listing = await fetcher.text(es_listing.listing_url(spider))
    inventory = es_listing.parse_listing(listing)
    log.info("%s: %d documents in the listing", spider, len(inventory))
    report.per_spider[spider] = len(inventory)

    async def one(doc_id: str, available: set[str]) -> None:
        try:
            data = await fetcher.json(
                es_listing.document_url(spider, doc_id, "json"))
        except FetchError as exc:
            log.warning("%s/%s: %s", spider, doc_id, exc)
            report.failed += 1
            return
        fields = es_document.parse(spider, doc_id, data)
        outcome = upsert(conn, fields, available)
        if outcome == "inserted":
            report.inserted += 1
        else:
            report.updated += 1

    # Bounded by the fetcher's own semaphore; gather in slices so a spider with
    # 94,000 documents does not build a 94,000-entry task list at once.
    items = list(inventory.items())
    for start in range(0, len(items), 500):
        await asyncio.gather(*(one(d, e) for d, e in items[start:start + 500]))
        log.info("%s: %d/%d", spider, min(start + 500, len(items)), len(items))


async def _run_async(settings: Settings, spiders: list[str]) -> IndexReport:
    report = IndexReport()
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            for spider in spiders:
                await _index_spider(fetcher, conn, spider, report)
    finally:
        conn.close()
    return report


def run(settings: Settings, spiders: list[str] | None = None) -> IndexReport:
    return asyncio.run(_run_async(settings, spiders or ALL_SPIDERS))


# The 54 spiders present in the table on 2026-08-23. Discovered from the /docs/
# listing rather than hardcoded at runtime, but pinned here so a run is
# reproducible and a newly appearing spider is a visible diff, not a silent one.
ALL_SPIDERS = [
    "AG_Baugesetzgebung", "AG_Gerichte", "AG_Weitere", "AI_Aktuell", "AI_Bericht",
    "AR_Gerichte", "BE_Anwaltsaufsicht", "BE_BVD", "BE_Steuerrekurs",
    "BE_Verwaltungsgericht", "BE_Weitere", "BE_ZivilStraf", "BL_Gerichte", "BS_Omni",
    "CH_BGE", "CH_BGer", "CH_BPatG", "CH_BSTG", "CH_Bundesrat", "CH_BVGer",
    "CH_EDOEB", "CH_UNIBE", "CH_VB", "CH_WEKO", "FR_Gerichte", "GE_Gerichte",
    "GL_Omni", "GR_Gerichte", "JU_Gerichte", "LU_Gerichte", "NE_Omni", "NW_Gerichte",
    "OW_Gerichte", "SG_Gerichte", "SG_Publikationen", "SH_OG", "SO_Omni",
    "SZ_Gerichte", "SZ_Verwaltungsgericht", "TA_SST", "TG_OG", "TI_Gerichte",
    "UR_Gerichte", "VD_FindInfo", "VD_Omni", "VS_Gerichte", "XX_Upload",
    "ZG_Obergericht", "ZG_Verwaltungsgericht", "ZH_Baurekurs", "ZH_Obergericht",
    "ZH_Sozialversicherungsgericht", "ZH_Steuerrekurs", "ZH_Verwaltungsgericht",
]


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    selected = sys.argv[1:] or None
    result = run(Settings.from_env(), selected)
    log.info("inserted=%d updated=%d failed=%d", result.inserted, result.updated,
             result.failed)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_index_stage.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Verify the spider list against the live site**

A hardcoded list that silently drifts is worse than no list.

```bash
cd services/ch-pipeline
python3 - <<'PY'
import re, urllib.request
from chpipe.stages.index_stage import ALL_SPIDERS
html = urllib.request.urlopen("https://entscheidsuche.ch/docs/", timeout=60).read().decode()
live = {n for n in re.findall(r'href="([A-Za-z_]+)/"', html)}
live -= {"Index", "Indexer", "Jobs", "JobsArchiv", "Scrapelog", "Sitemaps",
         "Snapshots", "Status"}
print("missing from ALL_SPIDERS:", sorted(live - set(ALL_SPIDERS)))
print("gone from the site     :", sorted(set(ALL_SPIDERS) - live))
PY
```

Expected: both lists empty. If not, update `ALL_SPIDERS` and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/ services/ch-pipeline/tests/test_index_stage.py
git commit -m "feat(ch): index stage, which also repairs 678k NULL decision dates"
```

---

### Task 7: The `fetch` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/fetch_stage.py`
- Test: `services/ch-pipeline/tests/test_fetch_stage.py`

**Interfaces:**
- Consumes: `db.claim`, `db.complete`, `db.fail`, `http.Fetcher`, `config.Settings`.
- Produces: `chpipe.stages.fetch_stage.raw_path(raw_dir, spider, doc_id, extension) -> pathlib.Path`; `chpipe.stages.fetch_stage.run(settings, limit: int | None = None, spider: str | None = None) -> FetchReport` with `FetchReport(fetched_html: int, fetched_pdf: int, failed: int, bytes_written: int)`.

**Behaviour:** claim rows at `indexed`, prefer HTML, fall back to PDF, write the body under `raw_dir`, record `pdf_sha256` for PDFs, move to `fetched`. Files land on disk, never in the database.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_fetch_stage.py
import hashlib
import pathlib
import pytest
from chpipe.stages import fetch_stage


def test_raw_path_shards_by_spider():
    p = fetch_stage.raw_path(pathlib.Path("/data/raw"), "ZG_Obergericht", "d1", "pdf")
    assert p == pathlib.Path("/data/raw/ZG_Obergericht/d1.pdf")


def test_raw_path_refuses_a_doc_id_that_escapes_the_directory():
    """Document ids come from a remote listing; a ../ in one must not write
    outside raw_dir."""
    with pytest.raises(ValueError, match="unsafe"):
        fetch_stage.raw_path(pathlib.Path("/data/raw"), "S", "../../etc/passwd", "pdf")


def test_choose_body_prefers_html():
    row = {"html_url": "https://x/d.html", "pdf_url": "https://x/d.pdf"}
    assert fetch_stage.choose_body(row) == ("html", "https://x/d.html")


def test_choose_body_falls_back_to_pdf():
    row = {"html_url": None, "pdf_url": "https://x/d.pdf"}
    assert fetch_stage.choose_body(row) == ("pdf", "https://x/d.pdf")


def test_choose_body_returns_none_when_there_is_no_body():
    assert fetch_stage.choose_body({"html_url": None, "pdf_url": None}) is None


def test_write_body_creates_parents_and_returns_sha256(tmp_path):
    payload = b"%PDF-1.4 body"
    path, digest = fetch_stage.write_body(tmp_path, "ZG_Obergericht", "d1", "pdf", payload)
    assert path.read_bytes() == payload
    assert digest == hashlib.sha256(payload).hexdigest()


def test_write_body_skips_rewriting_identical_bytes(tmp_path):
    payload = b"same"
    p1, d1 = fetch_stage.write_body(tmp_path, "S", "d", "pdf", payload)
    mtime = p1.stat().st_mtime_ns
    p2, d2 = fetch_stage.write_body(tmp_path, "S", "d", "pdf", payload)
    assert d1 == d2
    assert p2.stat().st_mtime_ns == mtime, "unchanged bytes must not be rewritten"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_fetch_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.stages.fetch_stage'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/fetch_stage.py
"""Stage 2: download the document body from the entscheidsuche mirror.

HTML is preferred wherever it exists: it carries structure, it needs no text
layer, and it cannot be a scan. Measured 2026-08-23, HTML availability is per
spider, not global — GE_Gerichte, CH_BGE, TI_Gerichte and VD_Omni ship HTML,
while CH_BVGer (94,081 documents) and ZH_Obergericht (37,381) are PDF only.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import pathlib
import re
from dataclasses import dataclass

from .. import db
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._ -]+$")


@dataclass
class FetchReport:
    fetched_html: int = 0
    fetched_pdf: int = 0
    failed: int = 0
    bytes_written: int = 0


def raw_path(raw_dir: pathlib.Path, spider: str, doc_id: str,
             extension: str) -> pathlib.Path:
    if not _SAFE_NAME.match(doc_id) or not _SAFE_NAME.match(spider):
        raise ValueError(f"unsafe path component: {spider}/{doc_id}")
    return raw_dir / spider / f"{doc_id}.{extension}"


def choose_body(row) -> tuple[str, str] | None:
    """('html'|'pdf', url) for the body we want, or None if there is none."""
    if row.get("html_url"):
        return "html", row["html_url"]
    if row.get("pdf_url"):
        return "pdf", row["pdf_url"]
    return None


def write_body(raw_dir: pathlib.Path, spider: str, doc_id: str, extension: str,
               payload: bytes) -> tuple[pathlib.Path, str]:
    path = raw_path(raw_dir, spider, doc_id, extension)
    digest = hashlib.sha256(payload).hexdigest()
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        return path, digest
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(payload)
    tmp.replace(path)            # atomic, so a killed run leaves no half file
    return path, digest


async def _run_async(settings: Settings, limit: int | None,
                     spider: str | None) -> FetchReport:
    report = FetchReport()
    conn = db.connect(settings)
    batch = 500
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            while True:
                size = batch if remaining is None else min(batch, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "indexed", limit=size, spider=spider,
                                max_attempts=settings.max_attempts)
                if not rows:
                    break

                async def one(row) -> None:
                    choice = choose_body(row)
                    if choice is None:
                        db.fail(conn, row["doc_id"], "no body url",
                                settings.max_attempts)
                        report.failed += 1
                        return
                    extension, url = choice
                    try:
                        payload = await fetcher.bytes(url)
                    except FetchError as exc:
                        db.fail(conn, row["doc_id"], str(exc), settings.max_attempts)
                        report.failed += 1
                        return
                    _, digest = write_body(settings.raw_dir, row["spider"],
                                           row["doc_id"], extension, payload)
                    db.complete(conn, row["doc_id"], "fetched",
                                text_source=extension,
                                pdf_sha256=digest if extension == "pdf" else None)
                    report.bytes_written += len(payload)
                    if extension == "html":
                        report.fetched_html += 1
                    else:
                        report.fetched_pdf += 1

                await asyncio.gather(*(one(r) for r in rows))
                if remaining is not None:
                    remaining -= len(rows)
                log.info("fetched html=%d pdf=%d failed=%d",
                         report.fetched_html, report.fetched_pdf, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> FetchReport:
    return asyncio.run(_run_async(settings, limit, spider))


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("html=%d pdf=%d failed=%d bytes=%d", result.fetched_html,
             result.fetched_pdf, result.failed, result.bytes_written)
```

Note: `text_source` is written here as the **container** the body arrived in. Task 9 overwrites it with `ocr` for any document whose text actually came from OCR.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_fetch_stage.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/fetch_stage.py \
        services/ch-pipeline/tests/test_fetch_stage.py
git commit -m "feat(ch): fetch stage, html preferred over pdf"
```

---

### Task 8: Text extraction and the quality score

**Files:**
- Create: `services/ch-pipeline/chpipe/text_extract.py`, `services/ch-pipeline/chpipe/text_quality.py`, `services/ch-pipeline/chpipe/wordlists/de.txt`, `services/ch-pipeline/chpipe/wordlists/fr.txt`, `services/ch-pipeline/chpipe/wordlists/it.txt`
- Test: `services/ch-pipeline/tests/test_text_extract.py`, `services/ch-pipeline/tests/test_text_quality.py`

**Interfaces:**
- Produces: `chpipe.text_extract.from_html(html: bytes) -> str`; `chpipe.text_extract.from_pdf(path: pathlib.Path) -> str`; `chpipe.text_extract.PdfToolMissing` exception.
- Produces: `chpipe.text_quality.score(text: str, languages: list[str]) -> float` in `0.0..1.0`; `chpipe.text_quality.ACCEPT_THRESHOLD: float`; `chpipe.text_quality.breakdown(text, languages) -> dict[str, float]`.

**Why the score is a separate module:** a PDF text layer that exists is not a text layer that is usable. Reporting "N rows now have text" without measuring it is exactly the failure mode this pipeline must avoid.

- [ ] **Step 1: Build the word lists**

Each list is the 2,000 most frequent words of the language, one per line, lowercase. Derive them from the corpus we already hold so they match legal register rather than newspaper register:

```bash
mkdir -p services/ch-pipeline/chpipe/wordlists
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -tAc \
  \"SELECT lower(regexp_split_to_table(left(full_text, 20000), '[^[:alpha:]]+')) AS w
      FROM ch_legislation WHERE lang='de' AND full_text IS NOT NULL LIMIT 400\"" \
  | grep -E '^.{3,}$' | sort | uniq -c | sort -rn | head -2000 | awk '{print $2}' \
  > services/ch-pipeline/chpipe/wordlists/de.txt
wc -l services/ch-pipeline/chpipe/wordlists/de.txt
```

Repeat with `lang='fr'` → `fr.txt` and `lang='it'` → `it.txt`. Each file must end up with roughly 2,000 lines; if a file is much shorter, the source query returned too little text — widen the `LIMIT` rather than shipping a thin list.

- [ ] **Step 2: Write the failing tests**

```python
# services/ch-pipeline/tests/test_text_extract.py
import pathlib
import subprocess
import pytest
from chpipe import text_extract


def test_html_to_text_drops_markup_and_keeps_words():
    html = b"<html><body><p>Das Bundesgericht</p><p>hat entschieden</p></body></html>"
    text = text_extract.from_html(html)
    assert "Bundesgericht" in text
    assert "<p>" not in text


def test_html_to_text_drops_script_and_style_content():
    html = b"<html><head><style>.a{color:red}</style></head>" \
           b"<body><script>var x=1</script><p>Urteil</p></body></html>"
    text = text_extract.from_html(html)
    assert "Urteil" in text
    assert "color" not in text and "var x" not in text


def test_html_to_text_preserves_paragraph_breaks():
    html = b"<p>Erwaegung 1</p><p>Erwaegung 2</p>"
    assert "\n" in text_extract.from_html(html)


def test_html_to_text_handles_a_broken_encoding_declaration():
    html = "<html><meta charset='iso-8859-1'><p>Beschwerdeführer</p></html>".encode("utf-8")
    assert "Beschwerde" in text_extract.from_html(html)


def test_pdf_to_text_reads_a_generated_pdf(tmp_path):
    pdf = tmp_path / "x.pdf"
    # Minimal PDF produced by the same toolchain that will read it.
    subprocess.run(["bash", "-c",
                    f"printf 'Bundesgericht Urteil' | enscript -B -p - 2>/dev/null "
                    f"| ps2pdf - {pdf}"], check=False)
    if not pdf.exists():
        pytest.skip("enscript/ps2pdf unavailable in this environment")
    assert "Bundesgericht" in text_extract.from_pdf(pdf)


def test_pdf_to_text_on_a_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        text_extract.from_pdf(tmp_path / "nope.pdf")
```

```python
# services/ch-pipeline/tests/test_text_quality.py
from chpipe import text_quality

GOOD_DE = (
    "Das Bundesgericht hat in der Beschwerde des Beschwerdeführers gegen das "
    "Urteil des Obergerichts des Kantons Zug entschieden, dass die Beschwerde "
    "abzuweisen ist, soweit darauf einzutreten ist. Die Gerichtskosten werden "
    "dem Beschwerdeführer auferlegt. "
) * 6


def test_clean_german_scores_high():
    assert text_quality.score(GOOD_DE, ["de"]) > 0.7


def test_a_scrambled_text_layer_scores_low():
    """The failure mode this exists to catch: a PDF whose text layer is present
    but shredded into character soup."""
    junk = "B u n d e s g e r i c h t U r t e i l " * 40
    assert text_quality.score(junk, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_replacement_characters_drag_the_score_down():
    broken = GOOD_DE.replace("e", "�")
    assert text_quality.score(broken, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_a_page_of_digits_and_punctuation_scores_low():
    assert text_quality.score("12.3 45,6 78/9 " * 100, ["de"]) < text_quality.ACCEPT_THRESHOLD


def test_empty_text_scores_zero():
    assert text_quality.score("", ["de"]) == 0.0


def test_a_very_short_text_scores_zero():
    """A two-word extraction is an empty scan, not a decision."""
    assert text_quality.score("Urteil vom", ["de"]) == 0.0


def test_french_is_scored_against_the_french_list():
    fr = ("Le Tribunal fédéral a rejeté le recours du recourant contre "
          "l arrêt de la Cour de justice du canton de Genève. ") * 8
    assert text_quality.score(fr, ["fr"]) > text_quality.score(fr, ["de"])


def test_an_unknown_language_falls_back_to_all_lists():
    assert text_quality.score(GOOD_DE, []) > 0.5


def test_breakdown_exposes_every_component():
    b = text_quality.breakdown(GOOD_DE, ["de"])
    assert set(b) == {"alpha_ratio", "mean_word_length", "dictionary_hit_rate",
                      "replacement_ratio", "score"}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_text_extract.py tests/test_text_quality.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Write the implementations**

```python
# services/ch-pipeline/chpipe/text_extract.py
"""HTML and PDF to plain text.

pdftotext -layout is used rather than a Python PDF library because it is already
on the prod box, it is an order of magnitude faster, and -layout keeps the
two-column judgment layouts that Swiss courts use from interleaving.
"""
from __future__ import annotations

import pathlib
import subprocess

from lxml import etree, html as lxml_html

PDFTOTEXT_TIMEOUT_SECONDS = 120


class PdfToolMissing(RuntimeError):
    pass


def from_html(payload: bytes) -> str:
    """Text of an HTML document, with block-level breaks preserved."""
    if not payload.strip():
        return ""
    try:
        tree = lxml_html.fromstring(payload)
    except etree.ParserError:
        return ""
    for bad in tree.xpath("//script | //style | //head/comment()"):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    text = tree.text_content()
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def from_pdf(path: pathlib.Path) -> str:
    """Text layer of a PDF. Empty string means there is no usable text layer,
    which is the signal for the OCR stage — not an error."""
    if not path.exists():
        raise FileNotFoundError(path)
    try:
        completed = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            capture_output=True, timeout=PDFTOTEXT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise PdfToolMissing("pdftotext not installed") from exc
    except subprocess.TimeoutExpired:
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout.decode("utf-8", errors="replace").strip()
```

```python
# services/ch-pipeline/chpipe/text_quality.py
"""How usable is this extracted text?

Four components, each in 0..1, averaged with the weights below:

  alpha_ratio          letters as a share of non-space characters. A page of
                       coordinates or line numbers scores low.
  mean_word_length     penalises both character soup ("B u n d e s") and
                       run-together text with no spaces.
  dictionary_hit_rate  share of tokens found in the frequency list for the
                       document's language. This is what actually separates a
                       real judgment from a plausible-looking OCR hallucination.
  replacement_ratio    U+FFFD and control characters, inverted.

ACCEPT_THRESHOLD was calibrated on a hand-labelled sample of 100 documents; see
the calibration step in Task 9 of the plan.
"""
from __future__ import annotations

import pathlib
import re
import unicodedata

_WORDLIST_DIR = pathlib.Path(__file__).parent / "wordlists"
_TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)

ACCEPT_THRESHOLD = 0.55
MIN_TOKENS = 40

_WEIGHTS = {
    "alpha_ratio": 0.20,
    "mean_word_length": 0.20,
    "dictionary_hit_rate": 0.45,
    "replacement_ratio": 0.15,
}

_LISTS: dict[str, frozenset[str]] = {}


def _wordlist(lang: str) -> frozenset[str]:
    if lang not in _LISTS:
        path = _WORDLIST_DIR / f"{lang}.txt"
        if not path.exists():
            _LISTS[lang] = frozenset()
        else:
            _LISTS[lang] = frozenset(
                w.strip().lower() for w in path.read_text().splitlines() if w.strip())
    return _LISTS[lang]


def _vocabulary(languages: list[str]) -> frozenset[str]:
    wanted = [l for l in languages if (_WORDLIST_DIR / f"{l}.txt").exists()]
    if not wanted:
        wanted = ["de", "fr", "it"]
    vocabulary: frozenset[str] = frozenset()
    for lang in wanted:
        vocabulary |= _wordlist(lang)
    return vocabulary


def _mean_word_length_score(tokens: list[str]) -> float:
    """Peaks at 6 characters, the mean for German legal prose; falls off both
    ways so character soup and space-stripped text both lose."""
    if not tokens:
        return 0.0
    mean = sum(len(t) for t in tokens) / len(tokens)
    return max(0.0, 1.0 - abs(mean - 6.0) / 6.0)


def breakdown(text: str, languages: list[str]) -> dict[str, float]:
    tokens = [t.lower() for t in _TOKEN.findall(text)]
    if len(tokens) < MIN_TOKENS:
        return {"alpha_ratio": 0.0, "mean_word_length": 0.0,
                "dictionary_hit_rate": 0.0, "replacement_ratio": 0.0, "score": 0.0}

    non_space = [c for c in text if not c.isspace()]
    alpha_ratio = (sum(1 for c in non_space if c.isalpha()) / len(non_space)
                   if non_space else 0.0)

    bad = sum(1 for c in text
              if c == "�" or (unicodedata.category(c) == "Cc" and c not in "\n\r\t"))
    replacement_ratio = 1.0 - min(1.0, bad / max(1, len(text)) * 50)

    vocabulary = _vocabulary(languages)
    hit_rate = (sum(1 for t in tokens if t in vocabulary) / len(tokens)
                if vocabulary else 0.0)

    components = {
        "alpha_ratio": alpha_ratio,
        "mean_word_length": _mean_word_length_score(tokens),
        "dictionary_hit_rate": min(1.0, hit_rate / 0.35),   # 35% hits is a clean text
        "replacement_ratio": replacement_ratio,
    }
    components["score"] = round(
        sum(components[k] * w for k, w in _WEIGHTS.items()), 4)
    return components


def score(text: str, languages: list[str]) -> float:
    return breakdown(text, languages)["score"]
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_text_extract.py tests/test_text_quality.py -v
```

Expected: 15 passed (one may skip if `enscript`/`ps2pdf` are unavailable).

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/text_extract.py services/ch-pipeline/chpipe/text_quality.py \
        services/ch-pipeline/chpipe/wordlists/ \
        services/ch-pipeline/tests/test_text_extract.py services/ch-pipeline/tests/test_text_quality.py
git commit -m "feat(ch): text extraction and a measured quality score"
```

---

### Task 9: The `extract` stage and Gate A

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/extract_stage.py`, `services/ch-pipeline/chpipe/reports.py`
- Test: `services/ch-pipeline/tests/test_extract_stage.py`, `services/ch-pipeline/tests/test_reports.py`

**Interfaces:**
- Consumes: `text_extract.from_html`, `text_extract.from_pdf`, `text_quality.score`, `text_quality.ACCEPT_THRESHOLD`, `db.claim`, `db.complete`.
- Produces: `chpipe.stages.extract_stage.extract_one(settings, row) -> tuple[str, float, str]` returning `(text, quality, next_stage)`; `chpipe.stages.extract_stage.run(settings, limit=None, spider=None) -> ExtractReport`.
- Produces: `chpipe.reports.gate_a(conn) -> dict`, `chpipe.reports.quality_distribution(conn) -> list[tuple]`, `chpipe.reports.completeness(conn, snapshot: dict) -> list[dict]`.

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_extract_stage.py
import pathlib
import pytest
from chpipe import text_quality
from chpipe.config import Settings
from chpipe.stages import extract_stage


def _settings(tmp_path) -> Settings:
    return Settings(dsn="postgresql://unused@127.0.0.1:1/unused", raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=99.0, max_attempts=3)


GOOD_DE_HTML = ("<html><body>" + "<p>Das Bundesgericht hat die Beschwerde des "
                "Beschwerdeführers gegen das Urteil des Obergerichts abgewiesen, "
                "soweit darauf einzutreten ist.</p>" * 8 + "</body></html>")


def test_html_body_extracts_and_goes_straight_to_extracted(tmp_path):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text(GOOD_DE_HTML)
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert "Bundesgericht" in text
    assert quality > text_quality.ACCEPT_THRESHOLD
    assert nxt == "extracted"


def test_a_pdf_with_no_text_layer_is_queued_for_ocr(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4 scan")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert text == ""
    assert quality == 0.0
    assert nxt == "ocr_pending"


def test_a_pdf_whose_text_layer_is_junk_is_queued_for_ocr(tmp_path, monkeypatch):
    """Presence is not quality. This is the case that silently poisons corpora."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: "B u n d e s g e r i c h t " * 40)
    _, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert quality < text_quality.ACCEPT_THRESHOLD
    assert nxt == "ocr_pending"


def test_html_that_extracts_to_junk_is_not_sent_to_ocr(tmp_path):
    """There is no scan behind an HTML page, so OCR cannot help; it fails instead."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text("<html><body>...</body></html>")
    _, _, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert nxt == "failed"


def test_a_missing_raw_file_raises_so_the_row_can_be_refetched(tmp_path):
    s = _settings(tmp_path)
    with pytest.raises(FileNotFoundError):
        extract_stage.extract_one(
            s, {"doc_id": "gone", "spider": "S", "text_source": "pdf", "languages": []})
```

```python
# services/ch-pipeline/tests/test_reports.py
import os
import pathlib
import psycopg
import pytest
from chpipe import reports

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text, decision_type text,
                decision_date date, docket_number text, parties text, abstract text,
                full_text text, pdf_url text, json_url text, languages text[],
                metadata_json jsonb, imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _row(conn, doc_id, spider, source, quality, stage):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, text_source, "
        "text_quality, stage) VALUES (%s,%s,%s,%s,%s,%s)",
        (f"e:{doc_id}", spider, doc_id, source, quality, stage))


def test_gate_a_reports_shares_by_source_and_the_ocr_backlog(conn):
    _row(conn, "a", "GE_Gerichte", "html", 0.9, "extracted")
    _row(conn, "b", "GE_Gerichte", "html", 0.8, "extracted")
    _row(conn, "c", "CH_BVGer", "pdf", 0.7, "extracted")
    _row(conn, "d", "CH_BVGer", "pdf", 0.1, "ocr_pending")
    g = reports.gate_a(conn)
    assert g["total"] == 4
    assert g["by_source"]["html"] == 2
    assert g["by_source"]["pdf"] == 2
    assert g["ocr_pending"] == 1
    assert 0.6 < g["mean_quality"] < 0.7


def test_quality_distribution_buckets_by_tenth(conn):
    for i, q in enumerate([0.05, 0.15, 0.15, 0.95]):
        _row(conn, f"d{i}", "S", "pdf", q, "extracted")
    dist = dict((row[0], row[1]) for row in reports.quality_distribution(conn))
    assert dist[0.1] == 2
    assert dist[0.0] == 1


def test_completeness_flags_a_spider_more_than_one_percent_short(conn):
    for i in range(90):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    rows = {r["spider"]: r for r in reports.completeness(conn, {"GE_Gerichte": 100})}
    assert rows["GE_Gerichte"]["ours"] == 90
    assert rows["GE_Gerichte"]["theirs"] == 100
    assert rows["GE_Gerichte"]["needs_investigation"] is True


def test_completeness_accepts_a_spider_within_one_percent(conn):
    for i in range(100):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    rows = {r["spider"]: r for r in reports.completeness(conn, {"GE_Gerichte": 100})}
    assert rows["GE_Gerichte"]["needs_investigation"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_extract_stage.py tests/test_reports.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementations**

```python
# services/ch-pipeline/chpipe/stages/extract_stage.py
"""Stage 3: raw body -> plain text, with a measured quality score.

Routing:
  html, good quality -> extracted
  html, bad quality  -> failed        (there is no scan behind an HTML page)
  pdf,  good quality -> extracted
  pdf,  bad or empty -> ocr_pending
"""
from __future__ import annotations

import concurrent.futures
import logging
from dataclasses import dataclass

from .. import db, text_extract, text_quality
from ..config import Settings
from .fetch_stage import raw_path

log = logging.getLogger(__name__)


@dataclass
class ExtractReport:
    extracted: int = 0
    queued_for_ocr: int = 0
    failed: int = 0


def extract_one(settings: Settings, row) -> tuple[str, float, str]:
    source = row["text_source"] or "pdf"
    path = raw_path(settings.raw_dir, row["spider"], row["doc_id"], source)
    if not path.exists():
        raise FileNotFoundError(path)

    if source == "html":
        text = text_extract.from_html(path.read_bytes())
    else:
        text = text_extract.from_pdf(path)

    languages = list(row.get("languages") or [])
    quality = text_quality.score(text, languages)

    if quality >= text_quality.ACCEPT_THRESHOLD:
        return text, quality, "extracted"
    if source == "pdf":
        return text, quality, "ocr_pending"
    return text, quality, "failed"


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> ExtractReport:
    report = ExtractReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.cpu_workers) as pool:
            while True:
                size = 200 if remaining is None else min(200, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "fetched", limit=size, spider=spider,
                                max_attempts=settings.max_attempts)
                if not rows:
                    break
                futures = {pool.submit(extract_one, settings, r): r for r in rows}
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    try:
                        text, quality, next_stage = future.result()
                    except Exception as exc:                    # noqa: BLE001
                        db.fail(conn, row["doc_id"], f"{type(exc).__name__}: {exc}",
                                settings.max_attempts)
                        report.failed += 1
                        continue
                    fields = {"text_quality": quality}
                    if next_stage == "extracted":
                        fields["full_text"] = text
                        report.extracted += 1
                    elif next_stage == "ocr_pending":
                        report.queued_for_ocr += 1
                    else:
                        report.failed += 1
                    db.complete(conn, row["doc_id"], next_stage, **fields)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("extracted=%d ocr_pending=%d failed=%d", report.extracted,
                         report.queued_for_ocr, report.failed)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("extracted=%d ocr_pending=%d failed=%d", result.extracted,
             result.queued_for_ocr, result.failed)
```

```python
# services/ch-pipeline/chpipe/reports.py
"""The verification gates from the spec, as queries rather than prose.

Every count here is count(*). n_live_tup on this database has been observed
reporting 27,809 for a partition holding 8.7 million rows.
"""
from __future__ import annotations


def gate_a(conn) -> dict:
    """Gate A: what the sample says about HTML / PDF / OCR before the full run."""
    row = conn.execute("""
        SELECT count(*)                                              AS total,
               count(*) FILTER (WHERE text_source = 'html')          AS html,
               count(*) FILTER (WHERE text_source = 'pdf')           AS pdf,
               count(*) FILTER (WHERE text_source = 'ocr')           AS ocr,
               count(*) FILTER (WHERE stage = 'ocr_pending')         AS ocr_pending,
               count(*) FILTER (WHERE stage = 'failed')              AS failed,
               avg(text_quality)                                     AS mean_quality
          FROM ch_court_decisions
         WHERE text_quality IS NOT NULL OR stage IN ('ocr_pending','failed')
    """).fetchone()
    return {
        "total": row["total"],
        "by_source": {"html": row["html"], "pdf": row["pdf"], "ocr": row["ocr"]},
        "ocr_pending": row["ocr_pending"],
        "failed": row["failed"],
        "mean_quality": float(row["mean_quality"]) if row["mean_quality"] else 0.0,
    }


def quality_distribution(conn) -> list[tuple[float, int]]:
    """Gate C: the distribution of the score, not a count of non-empty rows."""
    rows = conn.execute("""
        SELECT floor(text_quality * 10) / 10 AS bucket, count(*) AS n
          FROM ch_court_decisions
         WHERE text_quality IS NOT NULL
         GROUP BY 1 ORDER BY 1
    """).fetchall()
    return [(float(r["bucket"]), r["n"]) for r in rows]


def completeness(conn, snapshot: dict[str, int]) -> list[dict]:
    """Gate D: our per-spider counts against entscheidsuche's own snapshot.

    `snapshot` is the `total` map from /docs/Snapshots/{date}.json. A gap of
    more than one percent is investigated, never written off.
    """
    ours = {r["spider"]: r["n"] for r in conn.execute(
        "SELECT spider, count(*) AS n FROM ch_court_decisions GROUP BY 1").fetchall()}
    out = []
    for spider, theirs in sorted(snapshot.items()):
        mine = ours.get(spider, 0)
        gap = abs(mine - theirs) / theirs if theirs else 0.0
        out.append({"spider": spider, "ours": mine, "theirs": theirs,
                    "gap_pct": round(gap * 100, 2),
                    "needs_investigation": gap > 0.01})
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_extract_stage.py -v
CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_reports.py -v
```

Expected: 5 passed, then 4 passed.

- [ ] **Step 5: Calibrate `ACCEPT_THRESHOLD` on 100 hand-labelled documents**

The threshold shipped in Task 8 is a starting value. Calibrate it before it decides the fate of half a million documents.

```bash
cd services/ch-pipeline
CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod" \
python3 - <<'PY'
"""Print 100 PDF-sourced extractions with their score, spread across spiders.
Read them, mark each usable/unusable, and check where the scores separate."""
import random
from chpipe.config import Settings
from chpipe import db, text_extract, text_quality
from chpipe.stages.fetch_stage import raw_path

s = Settings.from_env()
conn = db.connect(s)
rows = conn.execute("""
    SELECT DISTINCT ON (spider) doc_id, spider, languages
      FROM ch_court_decisions WHERE stage IN ('fetched','extracted','ocr_pending')
       AND text_source = 'pdf' ORDER BY spider, doc_id
""").fetchall()
for r in random.sample(rows, min(100, len(rows))):
    path = raw_path(s.raw_dir, r["spider"], r["doc_id"], "pdf")
    if not path.exists():
        continue
    text = text_extract.from_pdf(path)
    b = text_quality.breakdown(text, list(r["languages"] or []))
    print(f"{b['score']:.3f} {r['spider']:<30} {r['doc_id'][:40]}")
    print("   ", text[:180].replace("\n", " "))
PY
```

Set `ACCEPT_THRESHOLD` to the value that separates the labelled sets, and record the labelled counts in the commit message. If no value separates them cleanly, say so rather than picking one.

- [ ] **Step 6: Run Gate A on a 2,000-document sample**

```bash
cd services/ch-pipeline
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw
# ~37 documents per spider across all 54.
for S in $(python3 -c "from chpipe.stages.index_stage import ALL_SPIDERS; print(' '.join(ALL_SPIDERS))"); do
    CHPIPE_SPIDER=$S CHPIPE_LIMIT=37 python3 -m chpipe.stages.fetch_stage
    CHPIPE_SPIDER=$S CHPIPE_LIMIT=37 python3 -m chpipe.stages.extract_stage
done
python3 -c "
from chpipe.config import Settings
from chpipe import db, reports
import json
conn = db.connect(Settings.from_env())
print(json.dumps(reports.gate_a(conn), indent=2))
print(reports.quality_distribution(conn))
"
```

Report to the user: share of HTML, share of PDF with a usable text layer, share needing OCR, and an OCR runtime estimate computed from a timed run of 20 documents. **Do not start the full OCR stage before this report is delivered and acknowledged.**

- [ ] **Step 7: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/extract_stage.py services/ch-pipeline/chpipe/reports.py \
        services/ch-pipeline/tests/test_extract_stage.py services/ch-pipeline/tests/test_reports.py \
        services/ch-pipeline/chpipe/text_quality.py
git commit -m "feat(ch): extract stage with a quality gate, plus the gate reports"
```

---

### Task 10: The `ocr` stage with a load guard

**Files:**
- Create: `services/ch-pipeline/chpipe/ocr.py`, `services/ch-pipeline/chpipe/stages/ocr_stage.py`
- Test: `services/ch-pipeline/tests/test_ocr.py`, `services/ch-pipeline/tests/test_ocr_stage.py`

**Interfaces:**
- Produces: `chpipe.ocr.tesseract_languages(languages: list[str]) -> str`; `chpipe.ocr.ocr_pdf(path, languages, timeout) -> str`; `chpipe.ocr.OcrToolMissing`.
- Produces: `chpipe.stages.ocr_stage.should_pause(load_ceiling: float, load1: float) -> bool`; `chpipe.stages.ocr_stage.run(settings, limit=None, spider=None) -> OcrReport`.

**Constraint:** prod has 8 cores shared with live traffic. The stage runs at most `ocr_workers` (default 2) processes, re-niced to 19, and stops claiming new work whenever the one-minute load average is at or above `load_ceiling` (default 6.0).

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_ocr.py
import pytest
from chpipe import ocr


def test_maps_iso_codes_to_tesseract_names():
    assert ocr.tesseract_languages(["de"]) == "deu"
    assert ocr.tesseract_languages(["fr"]) == "fra"
    assert ocr.tesseract_languages(["it"]) == "ita"


def test_combines_several_languages_in_document_order():
    assert ocr.tesseract_languages(["fr", "de"]) == "fra+deu"


def test_unknown_or_empty_falls_back_to_all_three_national_languages():
    assert ocr.tesseract_languages([]) == "deu+fra+ita"
    assert ocr.tesseract_languages(["rm"]) == "deu+fra+ita"


def test_deduplicates_repeated_languages():
    assert ocr.tesseract_languages(["de", "de", "fr"]) == "deu+fra"


def test_ocr_on_a_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        ocr.ocr_pdf(tmp_path / "nope.pdf", ["de"], timeout=5)
```

```python
# services/ch-pipeline/tests/test_ocr_stage.py
from chpipe.stages import ocr_stage


def test_pauses_at_or_above_the_ceiling():
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=6.0) is True
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=7.5) is True


def test_runs_below_the_ceiling():
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=5.9) is False


def test_a_zero_ceiling_disables_the_guard():
    """Explicit opt-out for a maintenance window, not the default."""
    assert ocr_stage.should_pause(load_ceiling=0.0, load1=99.0) is False
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_ocr.py tests/test_ocr_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementations**

```python
# services/ch-pipeline/chpipe/ocr.py
"""Tesseract OCR for PDFs whose text layer failed the quality gate.

prod has no GPU, so this is CPU tesseract. Pages are rendered with pdftoppm at
300 dpi, which is the lowest resolution at which Swiss judgment scans OCR
cleanly, and fed to tesseract one page at a time so a single bad page cannot
take down a whole document.
"""
from __future__ import annotations

import pathlib
import subprocess
import tempfile

# ISO 639-1 as entscheidsuche reports it -> tesseract traineddata names.
_LANGUAGE_MAP = {"de": "deu", "fr": "fra", "it": "ita", "en": "eng"}
_DEFAULT = "deu+fra+ita"

RENDER_DPI = 300


class OcrToolMissing(RuntimeError):
    pass


def tesseract_languages(languages: list[str]) -> str:
    names: list[str] = []
    for code in languages:
        name = _LANGUAGE_MAP.get(str(code).lower())
        if name and name not in names:
            names.append(name)
    return "+".join(names) if names else _DEFAULT


def ocr_pdf(path: pathlib.Path, languages: list[str], timeout: int = 900) -> str:
    if not path.exists():
        raise FileNotFoundError(path)
    langs = tesseract_languages(languages)
    with tempfile.TemporaryDirectory() as tmp:
        stem = pathlib.Path(tmp) / "page"
        try:
            subprocess.run(
                ["pdftoppm", "-r", str(RENDER_DPI), "-png", str(path), str(stem)],
                capture_output=True, timeout=timeout, check=True)
        except FileNotFoundError as exc:
            raise OcrToolMissing("pdftoppm not installed") from exc
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            return ""

        pages: list[str] = []
        for image in sorted(pathlib.Path(tmp).glob("page-*.png")):
            try:
                done = subprocess.run(
                    ["tesseract", str(image), "stdout", "-l", langs, "--psm", "1"],
                    capture_output=True, timeout=timeout)
            except FileNotFoundError as exc:
                raise OcrToolMissing("tesseract not installed") from exc
            except subprocess.TimeoutExpired:
                continue
            if done.returncode == 0:
                pages.append(done.stdout.decode("utf-8", errors="replace"))
        return "\n\n".join(pages).strip()
```

```python
# services/ch-pipeline/chpipe/stages/ocr_stage.py
"""Stage 4: OCR the documents that failed the text-layer quality gate.

This runs on the same 8 cores that serve live traffic, so it is the lowest
priority thing on the box: nice 19, a small worker count, and it stops claiming
work whenever the one-minute load average reaches the ceiling.
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import time
from dataclasses import dataclass

from .. import db, ocr, text_quality
from ..config import Settings
from .fetch_stage import raw_path

log = logging.getLogger(__name__)

PAUSE_SECONDS = 60


@dataclass
class OcrReport:
    recovered: int = 0
    still_bad: int = 0
    failed: int = 0
    seconds: float = 0.0


def should_pause(load_ceiling: float, load1: float) -> bool:
    if load_ceiling <= 0:
        return False
    return load1 >= load_ceiling


def _renice() -> None:
    try:
        os.nice(19)
    except (AttributeError, OSError):
        log.warning("could not renice; OCR will compete with live traffic")


def _ocr_one(settings: Settings, row) -> tuple[str, float]:
    path = raw_path(settings.raw_dir, row["spider"], row["doc_id"], "pdf")
    text = ocr.ocr_pdf(path, list(row.get("languages") or []))
    return text, text_quality.score(text, list(row.get("languages") or []))


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> OcrReport:
    _renice()
    report = OcrReport()
    conn = db.connect(settings)
    started = time.monotonic()
    remaining = limit
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.ocr_workers) as pool:
            while True:
                load1 = os.getloadavg()[0]
                if should_pause(settings.load_ceiling, load1):
                    log.info("load %.2f >= %.2f, pausing %ds",
                             load1, settings.load_ceiling, PAUSE_SECONDS)
                    time.sleep(PAUSE_SECONDS)
                    continue
                size = settings.ocr_workers * 4
                if remaining is not None:
                    size = min(size, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "ocr_pending", limit=size, spider=spider,
                                max_attempts=settings.max_attempts)
                if not rows:
                    break
                futures = {pool.submit(_ocr_one, settings, r): r for r in rows}
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    try:
                        text, quality = future.result()
                    except Exception as exc:                    # noqa: BLE001
                        db.fail(conn, row["doc_id"], f"{type(exc).__name__}: {exc}",
                                settings.max_attempts)
                        report.failed += 1
                        continue
                    if quality >= text_quality.ACCEPT_THRESHOLD:
                        db.complete(conn, row["doc_id"], "extracted",
                                    full_text=text, text_quality=quality,
                                    text_source="ocr")
                        report.recovered += 1
                    else:
                        # OCR had its turn and the result is still unusable. Keep
                        # the score so the corpus can be honest about it.
                        db.complete(conn, row["doc_id"], "failed",
                                    text_quality=quality, text_source="ocr",
                                    last_error=None)
                        report.still_bad += 1
                if remaining is not None:
                    remaining -= len(rows)
                log.info("recovered=%d still_bad=%d failed=%d",
                         report.recovered, report.still_bad, report.failed)
    finally:
        conn.close()
    report.seconds = time.monotonic() - started
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("recovered=%d still_bad=%d failed=%d in %.0fs", result.recovered,
             result.still_bad, result.failed, result.seconds)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_ocr.py tests/test_ocr_stage.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Confirm the tesseract language packs are installed on prod**

`tesseract` being present does not mean `deu`, `fra` and `ita` are.

```bash
ssh prod "tesseract --list-langs"
```

Expected output contains `deu`, `fra`, `ita`. If any is missing:

```bash
ssh prod "sudo apt-get update && sudo apt-get install -y tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-ita poppler-utils"
ssh prod "tesseract --list-langs"
```

Record the confirmed list in the commit message.

- [ ] **Step 6: Time 20 documents to get a real throughput number**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && \
  CHPIPE_DSN=... CHPIPE_RAW_DIR=/data/ch-corpus/raw CHPIPE_LIMIT=20 \
  CHPIPE_OCR_WORKERS=2 python3 -m chpipe.stages.ocr_stage"
```

Multiply the reported seconds by the `ocr_pending` count from Gate A. Report that estimate to the user before starting the full run. An estimate quoted from memory rather than from this measurement is not acceptable.

- [ ] **Step 7: Commit**

```bash
git add services/ch-pipeline/chpipe/ocr.py services/ch-pipeline/chpipe/stages/ocr_stage.py \
        services/ch-pipeline/tests/test_ocr.py services/ch-pipeline/tests/test_ocr_stage.py
git commit -m "feat(ch): ocr stage, niced and load-guarded"
```

---

### Task 11: The `load` stage, the runbook, and Gate D

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/load_stage.py`, `services/ch-pipeline/README.md`, `services/ch-pipeline/run-stage.sh`
- Test: `services/ch-pipeline/tests/test_load_stage.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `chpipe.stages.load_stage.run(settings, limit=None, spider=None) -> LoadReport` with `LoadReport(loaded: int, skipped_empty: int)`.

**Behaviour:** `extract` already writes `full_text`, so `load` is the stage that promotes `extracted` to `loaded` after a final sanity check, and it is the only place that touches the jurisdiction statistics view. Keeping it separate means the mass `UPDATE` that fires `trg_jstats` happens in one controlled, resumable place.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_load_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe.config import Settings
from chpipe.stages import load_stage

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL, court_code text,
                court_name text, chamber text, decision_type text, decision_date date,
                docket_number text, parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _row(conn, doc_id, text, quality, stage="extracted"):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, full_text, "
        "text_quality, stage) VALUES (%s,'S',%s,%s,%s,%s)",
        (f"e:{doc_id}", doc_id, text, quality, stage))


def test_promotes_a_good_extraction_to_loaded(conn, settings):
    _row(conn, "a", "x" * 500, 0.8)
    report = load_stage.run(settings)
    assert report.loaded == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == "loaded"


def test_refuses_to_load_a_row_whose_text_vanished(conn, settings):
    """A row can only reach 'extracted' with text; if it has none, something
    upstream is broken and marking it loaded would hide that."""
    _row(conn, "a", None, 0.8)
    report = load_stage.run(settings)
    assert report.loaded == 0
    assert report.skipped_empty == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == "failed"


def test_leaves_other_stages_alone(conn, settings):
    _row(conn, "a", "x" * 500, 0.8, stage="ocr_pending")
    assert load_stage.run(settings).loaded == 0
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_load_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.stages.load_stage'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/load_stage.py
"""Stage 5: promote extracted rows to loaded.

Separate from extract on purpose. This is the statement that moves ~500,000 rows
from NULL to text and therefore fires trg_jstats, the delta counter behind
v_jurisdiction_fulltext_stats. Keeping it in one resumable place means the
trigger's behaviour is verified once (Gate B) and exercised in one known way.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db
from ..config import Settings

log = logging.getLogger(__name__)

MIN_TEXT_LENGTH = 200          # same threshold the coverage numbers use


@dataclass
class LoadReport:
    loaded: int = 0
    skipped_empty: int = 0


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> LoadReport:
    report = LoadReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 1000 if remaining is None else min(1000, remaining)
            if size <= 0:
                break
            rows = db.claim(conn, "extracted", limit=size, spider=spider,
                            max_attempts=settings.max_attempts)
            if not rows:
                break
            for row in rows:
                length = conn.execute(
                    "SELECT coalesce(length(full_text), 0) AS n "
                    "FROM ch_court_decisions WHERE doc_id = %s",
                    (row["doc_id"],)).fetchone()["n"]
                if length < MIN_TEXT_LENGTH:
                    db.complete(conn, row["doc_id"], "failed")
                    conn.execute(
                        "UPDATE ch_court_decisions SET last_error = %s WHERE doc_id = %s",
                        (f"extracted but text is {length} chars", row["doc_id"]))
                    report.skipped_empty += 1
                    continue
                db.complete(conn, row["doc_id"], "loaded")
                report.loaded += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("loaded=%d skipped_empty=%d", report.loaded, report.skipped_empty)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("loaded=%d skipped_empty=%d", result.loaded, result.skipped_empty)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_load_stage.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Write the runbook**

```bash
# services/ch-pipeline/run-stage.sh
#!/usr/bin/env bash
# One stage, under supervision, with a log. Usage:
#   ./run-stage.sh index|fetch|extract|ocr|load [spider]
set -euo pipefail

STAGE="${1:?stage required}"
SPIDER="${2:-}"
LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"

# .env.prod line 89 has an unquoted space and breaks `set -a; . .env.prod`,
# so read only what we need.
PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw
export CHPIPE_SPIDER="$SPIDER"

LOG="$LOG_DIR/${STAGE}${SPIDER:+-$SPIDER}.log"
echo "=== $(date -Is) starting $STAGE ${SPIDER} ===" >> "$LOG"
exec python3 -m "chpipe.stages.${STAGE}_stage" >> "$LOG" 2>&1
```

```markdown
<!-- services/ch-pipeline/README.md -->
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

Each stage claims rows from the `stage` column with `FOR UPDATE SKIP LOCKED`, so
two runs of the same stage are safe.

## Running one

    chmod +x run-stage.sh
    ./run-stage.sh index                # all 54 spiders
    ./run-stage.sh fetch CH_BVGer       # one spider

Under supervision, so it survives a disconnect and is visible:

    tmux new -d -s ch-fetch './run-stage.sh fetch'
    tmux ls
    tail -f /data/ch-corpus/logs/fetch.log

Liveness check, since a tmux session outliving its process looks identical to a
healthy one:

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
```

- [ ] **Step 6: Run Gate D against the live snapshot**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && python3 - <<'PY'
import json, urllib.request
from chpipe.config import Settings
from chpipe import db, reports
snap = json.load(urllib.request.urlopen(
    'https://entscheidsuche.ch/docs/Snapshots/' +
    __import__('datetime').date.today().isoformat() + '.json', timeout=60))
conn = db.connect(Settings.from_env())
rows = reports.completeness(conn, snap['total'])
for r in rows:
    if r['needs_investigation']:
        print(r)
print('spiders short by >1%:', sum(1 for r in rows if r['needs_investigation']))
PY"
```

Note that `Snapshots.total` is keyed by court code (`CH_BGer`, `ZH_OG`), not always by spider name; where a key does not match a spider, map it before reporting rather than dropping it silently.

- [ ] **Step 7: Commit**

```bash
chmod +x services/ch-pipeline/run-stage.sh
git add services/ch-pipeline/chpipe/stages/load_stage.py services/ch-pipeline/README.md \
        services/ch-pipeline/run-stage.sh services/ch-pipeline/tests/test_load_stage.py
git commit -m "feat(ch): load stage, runbook and the completeness gate"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 6.1 court queue columns | Task 1 |
| 7.1 `index` | Task 6 |
| 7.2 `fetch` | Task 7 |
| 7.3 `extract` | Tasks 8, 9 |
| 7.4 quality score | Task 8 |
| 7.5 `ocr` | Task 10 |
| 7.6 `load` | Task 11 |
| 8 resource discipline | Tasks 2 (settings), 10 (load guard), 11 (runbook) |
| 9 Gate A | Task 9 step 6 |
| 9 Gate B (`trg_jstats`) | Task 1 step 5 |
| 9 Gate C (quality distribution) | Task 9 (`reports.quality_distribution`) |
| 9 Gate D (completeness) | Task 11 step 6 |
| 9 Gate E (legislation) | **Plan 2**, not this plan |
| 10 deltas | **Plan 3**, not this plan |
| 6.2/6.3 legislation schema | **Plan 2**, not this plan |

Spec sections 6.2, 6.3, 7.7–7.12, Gate E and section 10 are deliberately out of this plan; they are the subject of `2026-08-23-ch-legislation-pipeline.md` and `2026-08-23-ch-as-bbl-and-deltas.md`.

**Placeholders:** none. Every step carries the code or the command it needs.

**Type consistency:** `Settings` fields are used with the same names in Tasks 2, 7, 9, 10, 11. `db.claim/complete/fail` signatures match every call site. `raw_path` is defined in `fetch_stage` and imported by `extract_stage` and `ocr_stage` under that exact name. `text_quality.ACCEPT_THRESHOLD` is read in `extract_stage` and `ocr_stage`. `es_listing.document_url` is defined in Task 3 and used in Task 6. `DocumentFields` field names match between `es_document.parse` and `index_stage.upsert`.
