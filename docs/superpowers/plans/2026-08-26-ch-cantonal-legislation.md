# CH Cantonal Legislation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load every act of the 19 Lexwork cantons with all consolidated editions and all amendments into the existing `ch_act*` tables, plus a LexFind registry of all 26 cantons for reconciliation, served by the existing CH MCP tools with a `canton` parameter.

**Architecture:** New stages in `services/ch-pipeline/chpipe/stages/` follow the existing contract (`run(settings, ...) -> Report`, `main()`), write through the existing `ch_act_version.stage` queue (`db.claim_versions`, now filtered by a new `source` column), and reuse `diff` and `project-legacy` unchanged. A pure parser module `chpipe/lexwork.py` turns a Lexwork `show_as_json` payload into `akn.Article` rows, plain text and `amendment_notes.Provenance` rows, so `ch_act_article`, `ch_act_change` and `ch_article_provenance` have one shape for federal and cantonal law.

**Tech Stack:** Python 3.12, httpx (async, `chpipe.http.Fetcher`), psycopg 3, lxml (`lxml.html` for Lexwork HTML fragments), pytest with `CHPIPE_TEST_DSN` scratch Postgres; TypeScript for `mcp_backend` tools.

**Spec:** `docs/superpowers/specs/2026-08-26-ch-cantonal-legislation-design.md`

## Global Constraints

- Work in worktree `~/SecondLayer-worktrees/ch-cantonal`, branch `feat/ch-cantonal-legislation` (from `origin/main`).
- Python venv: `services/ch-pipeline/.venv`; run tests as `cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/postgres .venv/bin/python -m pytest -q` (scratch Postgres container `chpipe-test-pg`, trust auth). Baseline before this plan: 575 passed, 412 skipped without DSN.
- Migration number is **201** (200 is reserved for `ch_citation_state`). Idempotent SQL only (`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`).
- `sr_number` is NOT unique in `ch_act` (measured on prod: 17,293 acts, 9,054 distinct, 3,924 NULL). Never add a unique constraint on it. Act identity is `eli_work_uri`.
- `date_end_applicability` is the INCLUSIVE last day in force.
- Every stage module: `@dataclass Report`, `run(settings, ...)`, `main()` as a function (tests/test_entry_points.py enforces), no `os.nice()` inside `run()`.
- Stage names on the CLI use dashes (`cantonal-acts`), modules use underscores (`cantonal_acts_stage`).
- Every count printed by a report names its method (spec §3 lesson: "Fedlex figures in the plans were wrong").
- No em dashes in prose or commit messages; commit messages end with the Co-Authored-By trailer used in this repo.
- HTTP User-Agent is `chpipe.http.USER_AGENT`; per-host concurrency `CHPIPE_CANTONAL_PER_HOST` default 2.

---

### Task 1: Migration 201 (jurisdiction, source, change documents, LexFind registry)

**Files:**
- Create: `mcp_backend/src/migrations/201_ch_cantonal_legislation.sql`
- Create: `services/ch-pipeline/tests/test_migration_201.py`
- Modify: `services/ch-pipeline/tests/conftest.py` (export `MIGRATION_197`, `MIGRATION_201`, `apply_migrations_197_201(conn)` helper)

**Interfaces:**
- Produces: columns `ch_act.jurisdiction text NOT NULL DEFAULT 'CH'` (CHECK in `CANTONS ∪ {'CH'}`), `ch_act_version.source text NOT NULL DEFAULT 'fedlex'` (CHECK `IN ('fedlex','lexwork')`), table `ch_act_change_document(change_document_id bigserial PK, act_id bigint FK ch_act CASCADE, jurisdiction text NOT NULL, source_id bigint NOT NULL, number text, title text, date_publication date, date_decision date, pdf_url text, metadata_json jsonb, imported_at, updated_at, UNIQUE (jurisdiction, source_id, act_id))`, column `ch_article_provenance.change_document_id bigint NULL FK ch_act_change_document ON DELETE SET NULL`, table `ch_cantonal_registry(lexfind_tol_id bigint PK, canton text NOT NULL, systematic_number text, title text, is_active boolean, category text, original_url text, versions_json jsonb NOT NULL, version_count int NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now())`, indexes `idx_ch_act_jur_sr (jurisdiction, sr_number) WHERE sr_number IS NOT NULL`, `idx_ch_act_version_source_stage (source, stage) WHERE stage <> 'parsed'`, `idx_ch_cantonal_registry_canton (canton, systematic_number)`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_migration_201.py
"""Applies migrations 197, 198 and 201 to a scratch database. A mocked DB cannot validate SQL."""
import os
import pathlib
import psycopg
import pytest

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
M198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"
M201 = _REPO_ROOT / "mcp_backend/src/migrations/201_ch_cantonal_legislation.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_cantonal_registry", "ch_article_provenance", "ch_act_change_document",
                  "ch_act_as_link", "ch_as_act", "ch_act_change", "ch_act_article",
                  "ch_act_version", "ch_act", "ch_legislation"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_legislation (
                eli_uri text NOT NULL, lang text NOT NULL, sr_number text,
                title text, short_title text, version_date date, in_force boolean,
                date_entry_force date, date_end_validity date, akn_xml text,
                full_text text, html_url text, pdf_url text, xml_url text,
                source text DEFAULT 'fedlex', metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (eli_uri, lang))
        """)
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        c.execute(M201.read_text())
        yield c


def test_is_idempotent(conn):
    conn.execute(M201.read_text())
    conn.execute(M201.read_text())


def test_existing_acts_default_to_federal(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('eli/cc/27/317_321_377', '220')")
    assert conn.execute("SELECT jurisdiction FROM ch_act").fetchone()[0] == "CH"


def test_jurisdiction_is_checked_against_the_canton_list(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('x', 'XX')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('y', 'BE')")


def test_same_sr_number_may_exist_in_two_jurisdictions(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('a', '131.1', 'CH')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('b', '131.1', 'ZH')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('c', '131.1', 'CH')")
    assert conn.execute("SELECT count(*) FROM ch_act WHERE sr_number='131.1'").fetchone()[0] == 3


def test_versions_default_to_fedlex_and_reject_unknown_sources(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('a')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability) "
                 "SELECT act_id, 'c', 'de', '2020-01-01' FROM ch_act")
    assert conn.execute("SELECT source FROM ch_act_version").fetchone()[0] == "fedlex"
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source) "
                     "SELECT act_id, 'd', 'de', '2020-01-01', 'pdf' FROM ch_act")


def test_change_document_is_unique_per_act_and_source_id(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('a', 'BE')")
    for _ in range(2):
        conn.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number) "
                     "SELECT act_id, 'BE', 2374, '25-022' FROM ch_act ON CONFLICT DO NOTHING")
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 1


def test_provenance_can_point_at_a_change_document(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('a', 'BE')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source) "
                 "SELECT act_id, 'c', 'de', '2020-01-01', 'lexwork' FROM ch_act")
    conn.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id) "
                 "SELECT act_id, 'BE', 1 FROM ch_act")
    conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, raw_note, change_document_id) "
                 "SELECT version_id, 't-0--a-1', 'x', change_document_id FROM ch_act_version, ch_act_change_document")
    conn.execute("DELETE FROM ch_act_change_document")
    assert conn.execute("SELECT change_document_id FROM ch_article_provenance").fetchone()[0] is None


def test_registry_table_exists_with_its_index(conn):
    assert conn.execute("SELECT to_regclass('ch_cantonal_registry') IS NOT NULL").fetchone()[0]
    assert conn.execute("SELECT to_regclass('idx_ch_cantonal_registry_canton') IS NOT NULL").fetchone()[0]
    assert conn.execute("SELECT to_regclass('idx_ch_act_jur_sr') IS NOT NULL").fetchone()[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/postgres .venv/bin/python -m pytest tests/test_migration_201.py -q`
Expected: FAIL (FileNotFoundError on the migration file).

- [ ] **Step 3: Write the migration**

```sql
-- mcp_backend/src/migrations/201_ch_cantonal_legislation.sql
-- Cantonal legislation in the same tables as federal law.
--
-- ch_act.jurisdiction: 'CH' for Fedlex, a two-letter canton code for the
-- cantonal collections (Lexwork platform, 19 cantons in phase 1). The act's
-- identity stays eli_work_uri; sr_number is NOT unique even federally
-- (measured on lawrider_prod 2026-08-26: 17,293 acts, 9,054 distinct
-- sr_number, 3,924 NULL, "916.361.1" appears 36 times), so no unique index
-- is added here and the tools keep their ORDER BY in_force ... LIMIT 1.

ALTER TABLE public.ch_act ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'CH';

DO $$ BEGIN
    ALTER TABLE public.ch_act
        ADD CONSTRAINT ch_act_jurisdiction_chk
        CHECK (jurisdiction IN ('CH',
            'AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE',
            'NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ch_act_jur_sr ON public.ch_act (jurisdiction, sr_number)
    WHERE sr_number IS NOT NULL;

-- ch_act_version.source: which pipeline wrote the row and what akn_xml holds.
-- 'fedlex' = Akoma Ntoso XML from Fedlex; 'lexwork' = the raw show_as_json
-- payload of one Lexwork version (all languages in one document). Every
-- claim over this queue filters on it so the two parsers never see each
-- other's payloads.
ALTER TABLE public.ch_act_version ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fedlex';

DO $$ BEGIN
    ALTER TABLE public.ch_act_version
        ADD CONSTRAINT ch_act_version_source_chk
        CHECK (source IN ('fedlex', 'lexwork'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ch_act_version_source_stage
    ON public.ch_act_version (source, stage) WHERE stage <> 'parsed';

-- The amending act as the canton publishes it ("Änderung vom 27.11.2023",
-- number 25-022 in the official collection). Fedlex has no equivalent
-- entity (jolux has no "amends" predicate); Lexwork does, per act.
CREATE TABLE IF NOT EXISTS public.ch_act_change_document (
    change_document_id bigserial PRIMARY KEY,
    act_id            bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    jurisdiction      text NOT NULL,
    source_id         bigint NOT NULL,
    number            text,
    title             text,
    date_publication  date,
    date_decision     date,
    pdf_url           text,
    metadata_json     jsonb,
    imported_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (jurisdiction, source_id, act_id)
);

ALTER TABLE public.ch_article_provenance
    ADD COLUMN IF NOT EXISTS change_document_id bigint
        REFERENCES public.ch_act_change_document(change_document_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ch_article_provenance_change_document
    ON public.ch_article_provenance (change_document_id) WHERE change_document_id IS NOT NULL;

-- LexFind's view of every canton (26), kept as the independent side of the
-- reconciliation gate. versions_json is the with-version-groups response as
-- received; version_count is derived from it at write time.
CREATE TABLE IF NOT EXISTS public.ch_cantonal_registry (
    lexfind_tol_id    bigint PRIMARY KEY,
    canton            text NOT NULL,
    systematic_number text,
    title             text,
    is_active         boolean,
    category          text,
    original_url      text,
    versions_json     jsonb NOT NULL,
    version_count     integer NOT NULL,
    fetched_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ch_cantonal_registry_canton
    ON public.ch_cantonal_registry (canton, systematic_number);

COMMENT ON COLUMN public.ch_act.jurisdiction IS
    'CH for federal (Fedlex) acts, two-letter canton code for cantonal collections. Act identity remains eli_work_uri; (jurisdiction, sr_number) is not unique.';
COMMENT ON COLUMN public.ch_act_version.source IS
    'fedlex: akn_xml holds Akoma Ntoso XML. lexwork: akn_xml holds the raw show_as_json payload of one version.';
```

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Add a shared helper to conftest.py**

Append to `services/ch-pipeline/tests/conftest.py`:

```python
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
MIGRATION_198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"
MIGRATION_201 = _REPO_ROOT / "mcp_backend/src/migrations/201_ch_cantonal_legislation.sql"

_LEGISLATION_TABLES = (
    "ch_cantonal_registry", "ch_article_provenance", "ch_act_change_document",
    "ch_act_as_link", "ch_as_act", "ch_act_change", "ch_act_article",
    "ch_act_version", "ch_act", "ch_legislation",
)

_CH_LEGISLATION_135 = """
CREATE TABLE IF NOT EXISTS ch_legislation (
    eli_uri text NOT NULL, lang text NOT NULL, sr_number text,
    title text, short_title text, version_date date, in_force boolean,
    date_entry_force date, date_end_validity date, akn_xml text,
    full_text text, html_url text, pdf_url text, xml_url text,
    source text DEFAULT 'fedlex', metadata_json jsonb,
    imported_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    PRIMARY KEY (eli_uri, lang))
"""


def reset_legislation_schema(conn) -> None:
    """Drop and re-create the whole CH legislation schema (135 stand-in, 197,
    198, 201) so a cantonal stage test starts from the real shape."""
    for t in _LEGISLATION_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
    conn.execute(_CH_LEGISLATION_135)
    for m in (MIGRATION_197, MIGRATION_198, MIGRATION_201):
        conn.execute(m.read_text())
```

- [ ] **Step 6: Run the whole suite with the DSN, expect no regressions, commit**

```bash
git add mcp_backend/src/migrations/201_ch_cantonal_legislation.sql services/ch-pipeline/tests/test_migration_201.py services/ch-pipeline/tests/conftest.py
git commit -m "feat(ch): migration 201: jurisdiction on acts, source on versions, change documents, LexFind registry"
```

---

### Task 2: Canton registry module

**Files:**
- Create: `services/ch-pipeline/chpipe/cantons.py`
- Create: `services/ch-pipeline/tests/test_cantons.py`

**Interfaces:**
- Produces: `@dataclass(frozen=True) Canton(code: str, host: str, langs: tuple[str, ...], platform: str, lexfind_id: int)`; `LEXWORK: dict[str, Canton]` (19 entries); `ALL: dict[str, Canton]` (26 entries, the 7 bespoke ones with `platform='lexfind'` and `host=''`); `def api(canton: Canton, lang: str = 'de') -> str` returning `https://{host}/api/{lang}`; `def deep_link(canton, sysnr, version_id) -> str` returning `https://{host}/app/de/texts_of_law/{sysnr}/versions/{version_id}`; `def canonical_link(canton, sysnr) -> str`; `LEXFIND_API = "https://www.lexfind.ch/api/fe/de"`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cantons.py
from chpipe import cantons


def test_nineteen_lexwork_cantons_and_twenty_six_in_total():
    assert len(cantons.LEXWORK) == 19
    assert len(cantons.ALL) == 26
    assert set(cantons.LEXWORK) < set(cantons.ALL)


def test_every_canton_has_a_lexfind_entity_id():
    ids = [c.lexfind_id for c in cantons.ALL.values()]
    assert sorted(ids) == list(range(1, 27))


def test_lexwork_urls_are_built_from_the_host():
    be = cantons.LEXWORK["BE"]
    assert cantons.api(be) == "https://www.belex.sites.be.ch/api/de"
    assert cantons.api(be, "fr") == "https://www.belex.sites.be.ch/api/fr"
    assert cantons.deep_link(be, "101.1", 3020) == \
        "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1/versions/3020"
    assert cantons.canonical_link(be, "101.1") == \
        "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1"


def test_bilingual_cantons_list_their_languages():
    assert cantons.LEXWORK["BE"].langs == ("de", "fr")
    assert cantons.LEXWORK["GR"].langs == ("de", "it", "rm")
    assert cantons.LEXWORK["ZG"].langs == ("de",)


def test_bespoke_cantons_have_no_lexwork_host():
    for code in ("ZH", "VD", "TI", "NE", "GE", "JU", "SZ"):
        assert cantons.ALL[code].platform == "lexfind"
        assert cantons.ALL[code].host == ""
```

- [ ] **Step 2: Run, expect ImportError. Step 3: implement**

```python
# chpipe/cantons.py
"""The 26 cantons, their legislation platform and their LexFind entity id.

Hosts were identified 2026-08-26 from LexFind's dta_urls[].original_url and
verified by GET /api/de/status on BE, BL, GR, AI, FR, LU (same Angular
bundle everywhere, clex.ch included). The language tuple is an expectation
used when versions are discovered; the truth per version is the payload's
available_languages[] and cantonal_parse_stage fails a row whose language
is not in it, visibly, rather than inventing a translation.
"""
from __future__ import annotations

from dataclasses import dataclass

LEXFIND_API = "https://www.lexfind.ch/api/fe/de"


@dataclass(frozen=True)
class Canton:
    code: str
    host: str
    langs: tuple[str, ...]
    platform: str          # 'lexwork' | 'lexfind' (registry only, phase 2 for text)
    lexfind_id: int


def _lw(code, host, langs, lexfind_id):
    return Canton(code, host, tuple(langs), "lexwork", lexfind_id)


def _lf(code, lexfind_id):
    return Canton(code, "", (), "lexfind", lexfind_id)


ALL: dict[str, Canton] = {c.code: c for c in (
    _lw("AG", "gesetzessammlungen.ag.ch", ("de",), 1),
    _lw("AI", "ai.clex.ch", ("de",), 2),
    _lw("AR", "ar.clex.ch", ("de",), 3),
    _lw("BE", "www.belex.sites.be.ch", ("de", "fr"), 4),
    _lw("BL", "bl.clex.ch", ("de",), 5),
    _lw("BS", "www.gesetzessammlung.bs.ch", ("de",), 6),
    _lw("FR", "bdlf.fr.ch", ("de", "fr"), 7),
    _lf("GE", 8),
    _lw("GL", "gesetze.gl.ch", ("de",), 9),
    _lw("GR", "www.gr-lex.gr.ch", ("de", "it", "rm"), 10),
    _lf("JU", 11),
    _lw("LU", "srl.lu.ch", ("de",), 12),
    _lf("NE", 13),
    _lw("NW", "gesetze.nw.ch", ("de",), 14),
    _lw("OW", "gdb.ow.ch", ("de",), 15),
    _lw("SG", "www.gesetzessammlung.sg.ch", ("de",), 16),
    _lw("SH", "rechtsbuch.sh.ch", ("de",), 17),
    _lw("SO", "bgs.so.ch", ("de",), 18),
    _lf("SZ", 19),
    _lw("TG", "rechtsbuch.tg.ch", ("de",), 20),
    _lf("TI", 21),
    _lw("UR", "rechtsbuch.ur.ch", ("de",), 22),
    _lf("VD", 23),
    _lw("VS", "lex.vs.ch", ("de", "fr"), 24),
    _lw("ZG", "bgs.zg.ch", ("de",), 25),
    _lf("ZH", 26),
)}

LEXWORK: dict[str, Canton] = {k: v for k, v in ALL.items() if v.platform == "lexwork"}


def api(canton: Canton, lang: str = "de") -> str:
    return f"https://{canton.host}/api/{lang}"


def canonical_link(canton: Canton, sysnr: str) -> str:
    return f"https://{canton.host}/app/de/texts_of_law/{sysnr}"


def deep_link(canton: Canton, sysnr: str, version_id: int) -> str:
    return f"{canonical_link(canton, sysnr)}/versions/{version_id}"
```

- [ ] **Step 4: Run, expect PASS. Step 5: Commit** `feat(ch): canton registry (19 Lexwork hosts, LexFind ids)`

---

### Task 3: Lexwork parser (`chpipe/lexwork.py`)

**Files:**
- Create: `services/ch-pipeline/chpipe/lexwork.py`
- Create: `services/ch-pipeline/tests/fixtures/lexwork_be_101_1_v3020.json` (built from the saved scratchpad sample `be_sj.json`: keep `text_of_law` keys, but trim `json_content.document.content` to the first title with its first 8 articles plus the whole `modification_table`, `history_information_map`, `available_languages`; keep `old_versions`, `current_version`, `change_documents`)
- Create: `services/ch-pipeline/tests/test_lexwork.py`

**Interfaces:**
- Produces:
  - `class LexworkParseError(ValueError)`
  - `parse_version_dates(s: str) -> VersionDates` where `@dataclass(frozen=True) VersionDates(date_applicability: date, date_end_applicability: date | None, date_decision: date | None)`; raises `LexworkParseError` on an unrecognised string.
  - `available_languages(payload: dict) -> list[str]` (iso639_1 codes).
  - `parse_edition(payload: dict, lang: str) -> tuple[list[akn.Article], str]` (articles, plain text); raises `LexworkParseError` if `lang` not available.
  - `provenance(payload: dict, lang: str, articles: list[akn.Article]) -> list[Provenance]` where `@dataclass(frozen=True) Provenance(e_id, action, as_reference, effective_date, source_act_date, raw_note, anchor_level, container_articles, change_document_source_id: int | None)`.
  - `strip_html(fragment: str) -> str` (lxml.html text with `<strong>*</strong>` markers removed, `&nbsp;` to space, whitespace collapsed).
  - `article_number_of(number_html: str) -> str | None` ("Art.&nbsp;6" → "6", "§ 12a" → "12a").

- [ ] **Step 1: Build the fixture**

```bash
cd services/ch-pipeline && python3 - <<'EOF'
import json
S="/private/tmp/claude-501/-Users-vovkes-SecondLayer/e2d85ddd-1161-4786-bc03-10d4c2433b5f/scratchpad"
d=json.load(open(f"{S}/be_sj.json"))
tol=d["text_of_law"]; sv=tol["selected_version"]; c=sv["json_content"]["document"]["content"]
first_title=c["children"][0]
first_title["children"]=first_title["children"][:8]
c["children"]=[first_title]
sv.pop("xhtml_cac_tol",None); sv.pop("xhtml_cac_unified_tol",None); sv.pop("xhtml_tol",None)
json.dump(d, open("tests/fixtures/lexwork_be_101_1_v3020.json","w"), ensure_ascii=False, indent=1)
EOF
```
Confirm the file is under 300 KB and that `modification_table[0].html_content.de` still contains `history_info_3332706` (Art. 61 Abs. 2 geändert).

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_lexwork.py
import datetime
import json
import pathlib
import pytest
from chpipe import lexwork

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "lexwork_be_101_1_v3020.json"


@pytest.fixture
def payload():
    return json.loads(FIXTURE.read_text())


def test_current_version_dates():
    d = lexwork.parse_version_dates(
        "Aktuelle Version in Kraft seit: 01.01.2026 (Beschlussdatum: 27.11.2023)")
    assert d == lexwork.VersionDates(datetime.date(2026, 1, 1), None, datetime.date(2023, 11, 27))


def test_old_version_dates_end_is_inclusive_last_day():
    d = lexwork.parse_version_dates(
        "Version in Kraft von: 03.03.2024 bis: 31.12.2025 (Beschlussdatum: 03.03.2024)")
    assert d.date_applicability == datetime.date(2024, 3, 3)
    assert d.date_end_applicability == datetime.date(2025, 12, 31)


def test_future_version_dates():
    d = lexwork.parse_version_dates("Zukünftige Version in Kraft ab: 01.01.2027 (Beschlussdatum: 12.05.2026)")
    assert d.date_applicability == datetime.date(2027, 1, 1)


def test_unrecognised_date_string_raises_rather_than_defaulting():
    with pytest.raises(lexwork.LexworkParseError):
        lexwork.parse_version_dates("Version en vigueur du 03.03.2024")


def test_available_languages(payload):
    assert lexwork.available_languages(payload) == ["de", "fr"]


def test_articles_carry_uid_number_marginal_and_paragraph_text(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    art6 = next(a for a in articles if a.article_number == "6")
    assert art6.e_id == "t-0--t-1--a-6"
    assert art6.marginal_note == "Sprachen"
    assert art6.parent_e_id == "t-0--t-1"
    assert art6.text.startswith("1 ")
    assert "2 Die Amtssprachen sind" in art6.text
    assert "a das Französische in der Verwaltungsregion Berner Jura" in art6.text
    assert "*" not in art6.text


def test_french_articles_come_from_the_same_payload(payload):
    articles, _ = lexwork.parse_edition(payload, "fr")
    art6 = next(a for a in articles if a.article_number == "6")
    assert art6.marginal_note == "Langues"
    assert "Les langues officielles sont" in art6.text


def test_ordinals_follow_document_order(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    assert [a.ordinal for a in articles] == list(range(len(articles)))
    assert [a.article_number for a in articles[:3]] == ["1", "2", "3"]


def test_plain_text_has_one_block_per_line_and_includes_the_preamble(payload):
    _, text = lexwork.parse_edition(payload, "de")
    lines = text.split("\n")
    assert "In der Absicht, Freiheit und Recht zu schützen" in text
    assert any(line.startswith("Art. 1") for line in lines)
    assert "" not in lines


def test_a_missing_language_raises(payload):
    with pytest.raises(lexwork.LexworkParseError):
        lexwork.parse_edition(payload, "it")


def test_strip_html_removes_amendment_markers_and_entities():
    assert lexwork.strip_html("<p><span class='text_content'>Die Amtssprachen sind&nbsp;<strong>*</strong></span></p>") \
        == "Die Amtssprachen sind"


def test_article_number_of():
    assert lexwork.article_number_of("Art.&nbsp;6") == "6"
    assert lexwork.article_number_of("Art. 12a") == "12a"
    assert lexwork.article_number_of("§ 7") == "7"
    assert lexwork.article_number_of("") is None


def test_provenance_rows_are_anchored_to_articles_and_link_change_documents(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    rows = lexwork.provenance(payload, "de", articles)
    first = next(r for r in rows if r.raw_note.startswith("06.06.1993"))
    assert first.anchor_level == "container" and first.container_articles == len(articles)
    assert first.action is None
    assert first.as_reference == "94-1"
    assert first.effective_date == datetime.date(1995, 1, 1)
    art61 = next(r for r in rows if "Art. 61 Abs. 2" in r.raw_note)
    assert art61.action == "amended"
    assert art61.source_act_date == datetime.date(2002, 9, 22)
    assert art61.effective_date == datetime.date(2006, 6, 1)
    assert art61.as_reference == "04-9"
    assert art61.anchor_level == "container"   # Art. 61 is outside the trimmed fixture
    linked = [r for r in rows if r.change_document_source_id is not None]
    assert linked, "history_information_map must resolve history ids to change documents"
    art101a = next(r for r in rows if "Art. 101a" in r.raw_note)
    assert art101a.action == "inserted"


def test_provenance_anchors_to_the_article_when_it_is_in_the_edition(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    payload["text_of_law"]["selected_version"]["json_content"]["modification_table"][0]["html_content"]["de"] = (
        "<table><tr class='history_info_1'><td>01.01.2000</td><td>01.02.2000</td>"
        "<td>Art. 6 Abs. 2</td><td>geändert</td><td class='ags_source_publication'>00-1</td></tr></table>")
    rows = lexwork.provenance(payload, "de", articles)
    assert rows[0].e_id == "t-0--t-1--a-6" and rows[0].anchor_level == "article"
    assert rows[0].container_articles is None
```

- [ ] **Step 3: Run, expect ImportError. Step 4: Implement**

```python
# chpipe/lexwork.py
"""Lexwork show_as_json -> akn.Article rows, plain text, provenance.

Lexwork (Sitrox) is the platform behind 19 cantonal collections. One
`texts_of_law/{nr}/versions/{id}/show_as_json` payload holds EVERY language
of one consolidated version as a tree of nodes {uid, type, number{lang},
text{lang}, html_content{lang}, html_content_post{lang}, children[]}. The
uid ("t-0--t-1--a-6--p-2") is structural and plays the role AKN's eId plays
on the federal side: the identity diff_articles keys on across editions.

Three things this module refuses to guess:
  * version dates come as localised UI strings; an unrecognised string
    raises LexworkParseError (the stage counts it) instead of a default;
  * a language absent from available_languages raises, so a row created
    from cantons.py's expectation fails visibly in the parse stage;
  * `<strong>*</strong>` (the platform's "amended in this version" marker)
    is stripped from text, because otherwise every marker flip is a diff.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

from lxml import html as lxml_html

from . import akn

_WS = re.compile(r"\s+")
_DATE = r"(\d{2})\.(\d{2})\.(\d{4})"
_DECISION = r"(?:\s*\((?:Beschlussdatum|Date de la décision|Data della decisione)[^:]*:\s*" + _DATE + r"\))?"
_CURRENT = re.compile(r"^\s*(?:Aktuelle Version|Version actuelle|Versione attuale)[^\d]*?(?:seit|depuis|dal)\s*:?\s*" + _DATE + _DECISION)
_RANGE = re.compile(r"^\s*(?:Version|Versione)[^\d]*?(?:von|du|dal)\s*:?\s*" + _DATE + r"\s*(?:bis|au|al)\s*:?\s*" + _DATE + _DECISION)
_FUTURE = re.compile(r"^\s*(?:Zukünftige Version|Version future|Versione futura)[^\d]*?(?:ab|dès|dal)\s*:?\s*" + _DATE + _DECISION)

_ARTICLE_NUMBER = re.compile(r"(\d+[a-zA-Z]*(?:\s*(?:bis|ter|quater|quinquies))?)")
_ELEMENT_ARTICLE = re.compile(r"\b(?:Art\.?|Article|Articolo|§)\s*(\d+[a-zA-Z]*)")

_ACTIONS = (
    ("inserted", re.compile(r"\b(?:eingefügt|introduit[es]?|introdott[oaie]|inserì|integrà)\b", re.IGNORECASE)),
    ("repealed", re.compile(r"\b(?:aufgehoben|abrogé[es]?|abrogat[oaie]|abolì)\b", re.IGNORECASE)),
    ("amended", re.compile(r"\b(?:geändert|modifié[es]?|modificat[oaie]|midà)\b", re.IGNORECASE)),
)

_HISTORY_ROW = re.compile(r"history_info_(\d+)")


class LexworkParseError(ValueError):
    pass


@dataclass(frozen=True)
class VersionDates:
    date_applicability: datetime.date
    date_end_applicability: datetime.date | None
    date_decision: datetime.date | None


@dataclass(frozen=True)
class Provenance:
    e_id: str
    action: str | None
    as_reference: str | None
    effective_date: datetime.date | None
    source_act_date: datetime.date | None
    raw_note: str
    anchor_level: str
    container_articles: int | None
    change_document_source_id: int | None


def _d(day: str, month: str, year: str) -> datetime.date:
    return datetime.date(int(year), int(month), int(day))


def _opt(groups: tuple, start: int) -> datetime.date | None:
    if groups[start] is None:
        return None
    return _d(*groups[start:start + 3])


def parse_version_dates(text: str) -> VersionDates:
    m = _RANGE.match(text)
    if m:
        g = m.groups()
        return VersionDates(_d(*g[0:3]), _d(*g[3:6]), _opt(g, 6))
    m = _CURRENT.match(text) or _FUTURE.match(text)
    if m:
        g = m.groups()
        return VersionDates(_d(*g[0:3]), None, _opt(g, 3))
    raise LexworkParseError(f"unrecognised version date string: {text!r}")


def available_languages(payload: dict) -> list[str]:
    sv = payload["text_of_law"]["selected_version"]
    return [entry["language"]["iso639_1_code"] for entry in sv.get("available_languages", [])]


def strip_html(fragment: str | None) -> str:
    if not fragment or not fragment.strip():
        return ""
    root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    for strong in root.iter("strong"):
        if (strong.text or "").strip() == "*" and len(strong) == 0:
            strong.drop_tree()
    for sup in root.iter("sup"):
        # footnote reference numbers are not operative text
        if sup.get("class") and "footnote" in sup.get("class"):
            sup.drop_tree()
    text = root.text_content().replace("\xa0", " ")
    return _WS.sub(" ", text).strip()


def article_number_of(number_html: str | None) -> str | None:
    text = strip_html(number_html)
    m = _ARTICLE_NUMBER.search(text)
    return akn.normalise_number(m.group(1)) if m else None


def _lang(d: dict | None, lang: str) -> str | None:
    if not d:
        return None
    return d.get(lang)


def _node_lines(node: dict, lang: str) -> list[str]:
    """Text of a paragraph/enumeration subtree, one block per line."""
    lines = []
    own = strip_html(_lang(node.get("html_content"), lang))
    if own:
        lines.append(own)
    for child in node.get("children") or []:
        lines.extend(_node_lines(child, lang))
    post = strip_html(_lang(node.get("html_content_post"), lang))
    if post:
        lines.append(post)
    return lines


def _content_root(payload: dict) -> dict:
    return payload["text_of_law"]["selected_version"]["json_content"]["document"]["content"]


def _require_lang(payload: dict, lang: str) -> None:
    langs = available_languages(payload)
    if lang not in langs:
        raise LexworkParseError(f"language {lang!r} not in payload ({', '.join(langs) or 'none'})")


def parse_edition(payload: dict, lang: str) -> tuple[list[akn.Article], str]:
    _require_lang(payload, lang)
    doc = payload["text_of_law"]["selected_version"]["json_content"]["document"]
    articles: list[akn.Article] = []
    lines: list[str] = []
    header = strip_html(_lang(doc.get("header"), lang))
    if header:
        lines.append(header)

    def walk(node: dict, parent_uid: str | None) -> None:
        kind = node.get("type")
        uid = node.get("uid")
        if kind == "article":
            number = article_number_of(_lang(node.get("number"), lang))
            marginal = strip_html(_lang(node.get("text"), lang)) or None
            body: list[str] = []
            for child in node.get("children") or []:
                body.extend(_node_lines(child, lang))
            text = " ".join(body).strip()
            articles.append(akn.Article(
                e_id=uid, article_number=number, marginal_note=marginal,
                text=text, ordinal=len(articles), parent_e_id=parent_uid))
            heading = strip_html(_lang(node.get("number"), lang))
            lines.append(" ".join(p for p in (heading, marginal) if p))
            lines.extend(body)
            return
        heading = strip_html(_lang(node.get("html_content"), lang)) or strip_html(_lang(node.get("text"), lang))
        if heading and kind == "title":
            lines.append(heading)
        elif heading:
            lines.append(heading)
        for child in node.get("children") or []:
            walk(child, uid if kind == "title" else parent_uid)

    walk(_content_root(payload), None)
    footer = strip_html(_lang(doc.get("footer"), lang))
    if footer:
        lines.append(footer)
    text = "\n".join(line for line in lines if line)
    return articles, text


def _action(text: str) -> str | None:
    for name, pattern in _ACTIONS:
        if pattern.search(text):
            return name
    return None


def _cells(tr) -> list[str]:
    return [_WS.sub(" ", td.text_content().replace("\xa0", " ")).strip() for td in tr.iter("td")]


def _date_or_none(text: str) -> datetime.date | None:
    m = re.search(_DATE, text)
    return _d(*m.groups()) if m else None


def provenance(payload: dict, lang: str, articles: list[akn.Article]) -> list[Provenance]:
    """Rows of the version's modification table, anchored to this edition's
    articles. `Art. 61 Abs. 2` anchors to article 61 when the edition has
    it; `Erlass`, a title, or an article this edition does not contain
    anchor to the document root as a container statement (the CHECK in
    migration 198 requires container_articles for those)."""
    sv = payload["text_of_law"]["selected_version"]
    history = sv.get("history_information_map") or {}
    by_number = {a.article_number: a.e_id for a in articles if a.article_number}
    root_uid = _content_root(payload).get("uid") or "t-0"
    rows: list[Provenance] = []
    for table in sv["json_content"].get("modification_table") or []:
        fragment = _lang(table.get("html_content"), lang) or _lang(table.get("html_content"), "de")
        if not fragment:
            continue
        root = lxml_html.fragment_fromstring(fragment, create_parent="div")
        for tr in root.iter("tr"):
            cells = _cells(tr)
            if len(cells) < 4:
                continue
            decision, effective, element, change = cells[0], cells[1], cells[2], cells[3]
            source = cells[4] if len(cells) > 4 else None
            m = _HISTORY_ROW.search(tr.get("class") or "")
            history_id = m.group(1) if m else None
            change_doc = None
            if history_id and history_id in history:
                change_doc = history[history_id].get("change_document_id")
            art = _ELEMENT_ARTICLE.search(element)
            e_id = by_number.get(akn.normalise_number(art.group(1))) if art else None
            raw = " | ".join(c for c in cells if c)
            if e_id:
                rows.append(Provenance(e_id, _action(change), source or None,
                                       _date_or_none(effective), _date_or_none(decision),
                                       raw, "article", None, change_doc))
            else:
                rows.append(Provenance(root_uid, _action(change), source or None,
                                       _date_or_none(effective), _date_or_none(decision),
                                       raw, "container", len(articles), change_doc))
    return rows
```

- [ ] **Step 5: Run tests; iterate until PASS (the fixture's exact strings decide the assertions; if `Art. 1` heading line differs, adjust the plain-text assertion to what the fixture really contains, never the other way round).**

- [ ] **Step 6: Commit** `feat(ch): Lexwork show_as_json parser: articles, plain text, modification-table provenance`

---

### Task 4: `source` on the version queue and the federal stages

**Files:**
- Modify: `services/ch-pipeline/chpipe/db.py` (`_CLAIM_VERSION_COLUMNS`, `claim_versions(conn, stage, limit, max_attempts, backoff_minutes, source="fedlex")`, `retry_failed_versions` gains `source` too)
- Modify: `chpipe/stages/fetch_xml_stage.py`, `parse_akn_stage.py` (pass `source="fedlex"` explicitly), `provenance_stage.py` (`AND source = 'fedlex'` in its SELECT), `project_legacy_stage.py` (`source` CASE and `jurisdiction` in metadata_json), `citations_resolve_stage.py:124` (`AND a.jurisdiction = 'CH'`)
- Modify tests: `tests/test_db_version_queue.py` (fixture applies 201 via `conftest.reset_legislation_schema`; add `test_claim_is_filtered_by_source`), `tests/test_project_legacy_stage.py` (add `test_a_cantonal_act_projects_with_source_lexwork`), `tests/test_citations_resolve_stage.py` (add `test_a_cantonal_act_with_a_federal_sr_number_is_not_a_resolution_target`)

**Interfaces:**
- Produces: `db.claim_versions(..., source: str = "fedlex")` adds `AND source = %s`; `_CLAIM_VERSION_COLUMNS` gains `source, eli_consolidation_uri`.

- [ ] **Step 1: Write the failing tests**

```python
# in tests/test_db_version_queue.py (fixture must apply 197+201: use conftest.reset_legislation_schema)
def test_claim_is_filtered_by_source(conn):
    act = conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('be/101.1', 'BE') RETURNING act_id").fetchone()[0]
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source) "
                 "VALUES (%s, 'be/101.1/v1', 'de', '2020-01-01', 'lexwork')", (act,))
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability) "
                 "VALUES (%s, 'fedlex/x', 'de', '2020-01-01')", (act,))
    assert [r["source"] for r in db.claim_versions(conn, "discovered", 10, backoff_minutes=())] == ["fedlex"]
    assert [r["eli_consolidation_uri"] for r in
            db.claim_versions(conn, "discovered", 10, backoff_minutes=(), source="lexwork")] == ["be/101.1/v1"]
```

```python
# in tests/test_project_legacy_stage.py
def test_a_cantonal_act_projects_with_source_lexwork(conn, settings):
    act = conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction, title_de, enforcement_status) "
                       "VALUES ('https://bgs.zg.ch/app/de/texts_of_law/111.1', '111.1', 'ZG', 'Kantonsverfassung', 0) "
                       "RETURNING act_id").fetchone()[0]
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source, stage, "
                 "akn_xml, full_text, article_count) VALUES (%s, 'zg/111.1/v1', 'de', '2020-01-01', 'lexwork', 'parsed', "
                 "'{}', 'text', 3)", (act,))
    project_legacy_stage.run(settings)
    row = conn.execute("SELECT source, metadata_json->>'jurisdiction' FROM ch_legislation").fetchone()
    assert row == ("lexwork", "ZG")
```

```python
# in tests/test_citations_resolve_stage.py (alongside the existing alias-resolution test; same fixture)
def test_a_cantonal_act_with_a_federal_sr_number_is_not_a_resolution_target(conn, settings):
    # 'OR' -> SR 220 federally; a cantonal act numbered 220 must not win
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('be/220', '220', 'BE')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('eli/cc/27/317_321_377', '220', 'CH')")
    conn.execute("INSERT INTO ch_act_alias (abbr, lang, sr_number, source) VALUES ('OR', 'de', '220', 'test')")
    conn.execute("INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article) VALUES ('ECLI:CH:BGER:2020:1', 'OR', '1')")
    citations_resolve_stage.run(settings)
    assert conn.execute("SELECT a.jurisdiction FROM ch_legislation_citations c JOIN ch_act a USING (act_id)").fetchone()[0] == "CH"
```
(Adapt column names for `ch_legislation_citations` to the real 199 shape when writing; read the existing test file's fixture first.)

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement**

In `db.py`:
```python
_CLAIM_VERSION_COLUMNS = (
    "version_id, act_id, lang, date_applicability, xml_url, attempts, source, eli_consolidation_uri"
)

def claim_versions(conn, stage: str, limit: int, max_attempts: int = 3,
                   backoff_minutes: tuple[int, ...] | None = RETRY_BACKOFF_MINUTES,
                   source: str = "fedlex") -> list[dict]:
    sql = (f"SELECT {_CLAIM_VERSION_COLUMNS} FROM ch_act_version "
           "WHERE stage = %s AND attempts < %s AND source = %s")
    params: list = [stage, max_attempts, source]
    ...  # rest unchanged
```
Docstring addition: "`source` is what keeps the Akoma Ntoso parser and the Lexwork parser from claiming each other's payloads; the default is the federal pipeline's so existing callers are unchanged in behaviour."

`fetch_xml_stage.py` / `parse_akn_stage.py`: add `source="fedlex"` to the `db.claim_versions(...)` calls.
`provenance_stage.run`: `"SELECT version_id FROM ch_act_version WHERE lang = %s AND stage = 'parsed' AND source = 'fedlex'"`.
`project_legacy_stage._PROJECT`: replace `'fedlex',` with `CASE WHEN a.jurisdiction = 'CH' THEN 'fedlex' ELSE 'lexwork' END,` and add `'jurisdiction', a.jurisdiction,` to `jsonb_build_object`; add `source = EXCLUDED.source` to the `ON CONFLICT` set list.
`citations_resolve_stage.py:124`: `JOIN ch_act a ON a.sr_number = al.sr_number AND a.jurisdiction = 'CH'`.

- [ ] **Step 4: Run the full DSN suite; fix any fixture that creates `ch_act_version` without 201 (tests that build their own tables must now also apply 201 or use `reset_legislation_schema`).**

- [ ] **Step 5: Commit** `feat(ch): version queue filtered by source; federal stages stay federal`

---

### Task 5: `cantonal-acts` stage

**Files:**
- Create: `chpipe/lexwork_api.py` (thin async client over `http.Fetcher` with per-host semaphores)
- Create: `chpipe/stages/cantonal_acts_stage.py`
- Create: `tests/test_lexwork_api.py`, `tests/test_cantonal_acts_stage.py`
- Fixture: `tests/fixtures/lexwork_be_tol_101_1.json` (the `texts_of_law/101.1` response trimmed: keep `text_of_law` with `current_version`, 2 `old_versions`, `future_versions: []`, 2 `change_documents`; drop `selected_version.xhtml_*`), `tests/fixtures/lexwork_be_lightweight_index.json` (two categories, three acts)

**Interfaces:**
- `lexwork_api.LexworkClient(fetcher: http.Fetcher, per_host: int)` with `async status(canton) -> dict`, `async lightweight_index(canton) -> list[dict]` (flattened acts), `async change_documents_index(canton) -> list[dict]`, `async text_of_law(canton, sysnr) -> dict | None` (None on 404), `async show_as_json_url(canton, sysnr, version_id) -> str` (pure), `async recent_changes(canton, offset) -> dict`.
- `cantonal_acts_stage.run(settings, canton_code: str | None = None, only: set[str] | None = None) -> ActsReport` with `ActsReport(cantons: list[str], acts: int, versions: int, change_documents: int, not_on_host: int, dates_unparsed: int, hosts_failed: list[str], errors: int)`.
- SQL produced: `_UPSERT_ACT` (on `eli_work_uri`, sets `jurisdiction`, `sr_number`, `abbreviation`, `title_<lang>` for each lang in `cantons.LEXWORK[code].langs` from the `/api/{lang}/texts_of_law/{sysnr}` title when `lang != 'de'` is available, `date_document = date_of_decision`, `date_entry_force = enactment`, `enforcement_status = 3 if abrogated else 0`, `metadata_json`), `_UPSERT_VERSION` (on `(eli_consolidation_uri, lang)`, `source='lexwork'`, `xml_url` = show_as_json URL, dates from `parse_version_dates`), `_UPSERT_CHANGE_DOCUMENT` (on `(jurisdiction, source_id, act_id)`).

- [ ] **Step 1: Write the failing tests** (httpx `MockTransport` routing by URL path: `/api/de/status`, `/api/de/texts_of_law/lightweight_index`, `/api/de/change_documents/lightweight_index`, `/api/de/texts_of_law/101.1`, `/api/fr/texts_of_law/101.1`, `/api/de/texts_of_law/999.9` → 404)

```python
# tests/test_cantonal_acts_stage.py
def test_discovers_acts_versions_and_change_documents_for_one_canton(conn, settings, transport):
    report = cantonal_acts_stage.run(settings, canton_code="BE", transport=transport)
    assert report.acts == 3 and report.hosts_failed == []
    act = conn.execute("SELECT jurisdiction, sr_number, abbreviation, title_de, title_fr, enforcement_status, in_force "
                       "FROM ch_act WHERE sr_number='101.1'").fetchone()
    assert act == ("BE", "101.1", "KV", "Verfassung des Kantons Bern", "Constitution du canton de Berne", 0, True)
    versions = conn.execute("SELECT lang, date_applicability, date_end_applicability, source, stage, xml_url "
                            "FROM ch_act_version v JOIN ch_act a USING (act_id) WHERE a.sr_number='101.1' "
                            "ORDER BY date_applicability, lang").fetchall()
    assert len(versions) == 6            # current + 2 old, x de/fr
    assert versions[0][3:5] == ("lexwork", "discovered")
    assert versions[-1][2] is None       # the current version has no end
    assert versions[0][5].endswith("/api/de/texts_of_law/101.1/versions/2876/show_as_json")
    docs = conn.execute("SELECT number, date_publication FROM ch_act_change_document ORDER BY number").fetchall()
    assert docs[0] == ("24-018", datetime.date(2024, 4, 17))


def test_registry_sysnrs_not_on_the_host_are_counted_not_fatal(conn, settings, transport):
    conn.execute("INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, versions_json, version_count) "
                 "VALUES (1, 'BE', '999.9', '[]', 0)")
    report = cantonal_acts_stage.run(settings, canton_code="BE", transport=transport)
    assert report.not_on_host == 1


def test_rerun_is_idempotent(conn, settings, transport):
    cantonal_acts_stage.run(settings, canton_code="BE", transport=transport)
    cantonal_acts_stage.run(settings, canton_code="BE", transport=transport)
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 3
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 2


def test_an_unreachable_host_is_reported_and_skipped(conn, settings, failing_transport):
    report = cantonal_acts_stage.run(settings, canton_code="BE", transport=failing_transport)
    assert report.hosts_failed == ["BE"] and report.acts == 0


def test_only_restricts_the_walk(conn, settings, transport):
    report = cantonal_acts_stage.run(settings, canton_code="BE", only={"101.1"}, transport=transport)
    assert report.acts == 1


def test_an_unparseable_version_date_is_counted_and_the_version_skipped(conn, settings, transport_with_bad_date):
    report = cantonal_acts_stage.run(settings, canton_code="BE", transport=transport_with_bad_date)
    assert report.dates_unparsed == 1
```

- [ ] **Step 2: Implement `lexwork_api.py`**

```python
"""Async client for the Lexwork REST API, one semaphore per host on top of
http.Fetcher's global cap: 19 cantonal hosts are 19 small government
servers, and CHPIPE_HTTP_CONCURRENCY=12 aimed at one of them is a burst
none of them was sized for."""
from __future__ import annotations

import asyncio

from . import cantons
from .http import FetchError, Fetcher


class LexworkClient:
    def __init__(self, fetcher: Fetcher, per_host: int = 2):
        self._fetcher = fetcher
        self._per_host = per_host
        self._locks: dict[str, asyncio.Semaphore] = {}

    def _lock(self, host: str) -> asyncio.Semaphore:
        if host not in self._locks:
            self._locks[host] = asyncio.Semaphore(self._per_host)
        return self._locks[host]

    async def get_json(self, canton: cantons.Canton, url: str) -> dict | list:
        async with self._lock(canton.host):
            return await self._fetcher.json(url)

    async def status(self, canton) -> dict:
        return (await self.get_json(canton, f"{cantons.api(canton)}/status"))["status"]

    async def lightweight_index(self, canton) -> list[dict]:
        data = await self.get_json(canton, f"{cantons.api(canton)}/texts_of_law/lightweight_index")
        return [tol for group in data.values() for tol in group]

    async def change_documents_index(self, canton) -> list[dict]:
        data = await self.get_json(canton, f"{cantons.api(canton)}/change_documents/lightweight_index")
        return [doc for group in data.values() for doc in group]

    async def text_of_law(self, canton, sysnr: str, lang: str = "de") -> dict | None:
        try:
            data = await self.get_json(canton, f"{cantons.api(canton, lang)}/texts_of_law/{sysnr}")
        except FetchError as exc:
            if "404" in str(exc):
                return None
            raise
        return data["text_of_law"]

    async def recent_changes(self, canton, offset: int = 0) -> dict:
        return await self.get_json(canton, f"{cantons.api(canton)}/status/recent_changes?offset={offset}")


def show_as_json_url(canton, sysnr: str, version_id: int) -> str:
    return f"{cantons.api(canton)}/texts_of_law/{sysnr}/versions/{version_id}/show_as_json"
```

- [ ] **Step 3: Implement the stage** (structure mirrors `versions_stage.py`: `run()` opens `db.connect`, runs `asyncio.run(_run_async(...))`; per canton: `status` (on FetchError → `hosts_failed`, continue), index + change-doc index + registry sysnrs → sorted set (∩ `only` if given); per sysnr `text_of_law` de (None → `not_on_host`), then for each extra lang in `canton.langs[1:]` `text_of_law(lang)` for the title only (FetchError → title stays NULL); upsert act; upsert change documents; for `current_version` + `old_versions` + `future_versions`: `parse_version_dates(version_dates_str)` (LexworkParseError → `dates_unparsed`, continue), upsert one `ch_act_version` per lang with `eli_consolidation_uri = cantons.deep_link(...)`, `xml_url = show_as_json_url(...)`, `source='lexwork'`. `run()` accepts `transport=None` and passes it to `Fetcher(concurrency=settings.http_concurrency, transport=transport)`. Per-act try/except counts `errors`. Log every 100 acts.)

`_UPSERT_VERSION` must set `date_end_applicability = EXCLUDED.date_end_applicability` (NOT COALESCE): on Lexwork, the current version's end is genuinely absent and a former current version GAINS an end when superseded, so the newest observation always wins.

`_UPSERT_ACT`'s `ON CONFLICT (eli_work_uri)` sets `jurisdiction`, `sr_number`, `abbreviation`, titles (COALESCE(EXCLUDED, existing) for titles so a failed fr fetch does not erase a title fetched earlier), `enforcement_status = EXCLUDED.enforcement_status`, `date_no_longer_in_force` (parse `abrogated_dates_str` if present with `_date_or_none`, else NULL), `metadata_json = EXCLUDED.metadata_json`.

- [ ] **Step 4: Add `cantonal-acts` to `run-stage.sh`** in a new case arm:
```bash
  cantonal-acts|cantonal-fetch|cantonal-parse|lexfind-registry)
    ARG="${POS:-${CHPIPE_CANTON:-}}"
    export CHPIPE_CANTON="$ARG"
    ;;
```
and `main()` reads `CHPIPE_CANTON` (empty = all Lexwork cantons).

- [ ] **Step 5: Run tests, commit** `feat(ch): cantonal-acts stage: Lexwork acts, versions and change documents`

---

### Task 6: `cantonal-fetch` stage

**Files:**
- Create: `chpipe/stages/cantonal_fetch_stage.py`, `tests/test_cantonal_fetch_stage.py`

**Interfaces:**
- `run(settings, canton_code=None, limit=None, transport=None) -> FetchReport(fetched, failed, bytes_written, cache_hits)`.
- Claims `db.claim_versions(conn, "discovered", size, max_attempts, backoff, source="lexwork")` (canton filter via a join is not needed: `CHPIPE_CANTON` narrows through `xml_url LIKE 'https://{host}/%'` when set; implement by adding an optional `url_prefix` argument to `claim_versions` that appends `AND xml_url LIKE %s`).
- Validation: `json.loads`; must contain `text_of_law.selected_version.json_content.document.content.uid`; else `fail_version("response is not a Lexwork show_as_json payload")`. `MAX_JSON_BYTES = 30_000_000`.
- Audit copy: `settings.raw_dir / "cantonal" / f"{version_id}.json"` (raw bytes).
- Batch cache: `dict[url, str]` per batch; sibling rows of the same `xml_url` reuse the payload (`cache_hits += 1`).
- Writes `akn_xml=payload_text, fetched_at=now()` via `db.complete_version(..., "fetched", ...)`.

- [ ] **Step 1: Tests**: `test_fetches_and_stores_the_payload`, `test_sibling_languages_share_one_download` (two rows, same URL, transport counter == 1, `cache_hits == 1`), `test_a_non_json_body_fails_the_row_with_a_reason`, `test_a_404_fails_the_row`, `test_only_lexwork_rows_are_claimed` (a `fedlex` discovered row stays untouched).
- [ ] **Step 2: Implement** (copy `fetch_xml_stage._run_async` shape; `Fetcher.bytes(url)`).
- [ ] **Step 3: Commit** `feat(ch): cantonal-fetch stage`

---

### Task 7: `cantonal-parse` stage

**Files:**
- Create: `chpipe/stages/cantonal_parse_stage.py`, `tests/test_cantonal_parse_stage.py`

**Interfaces:**
- `run(settings, canton_code=None, limit=None) -> ParseReport(parsed, articles, empty, failed, lang_not_in_payload, provenance_rows, provenance_linked, acts: set[(act_id, lang)])`.
- Per claimed row (`source="lexwork"`, stage `fetched`): `payload = json.loads(akn_xml)`; `lexwork.parse_edition(payload, lang)` (LexworkParseError "not in payload" → `fail_version` + `lang_not_in_payload`); `parse_akn_stage.store_articles(conn, version_id, articles)` (reused, unchanged); provenance: `lexwork.provenance(payload, lang, articles)` → resolve `change_document_source_id` to `change_document_id` via `SELECT change_document_id FROM ch_act_change_document WHERE act_id=%s AND source_id=%s`; write with `_INSERT_PROVENANCE` (same columns as `provenance_stage._INSERT` plus `change_document_id`) inside ONE transaction with a `DELETE FROM ch_article_provenance WHERE version_id=%s` first; then `db.complete_version(conn, version_id, "parsed", full_text=text)`.
- `throttle.wait_for_capacity(settings.load_ceiling, "cantonal-parse")` before each claim.

- [ ] **Step 1: Tests**: `test_parses_articles_full_text_and_provenance` (seed act BE + change document source_id 2001 + version with the fixture payload as akn_xml; expect `stage='parsed'`, article rows > 0, `ch_article_provenance` rows > 0 with at least one `change_document_id` NOT NULL, `full_text` non-empty), `test_a_language_missing_from_the_payload_fails_visibly` (row lang 'it' → `failed`, `last_error` contains "not in payload"), `test_reparse_replaces_articles_and_provenance`, `test_report_names_the_acts_that_moved`.
- [ ] **Step 2: Implement. Step 3: Commit** `feat(ch): cantonal-parse stage: articles, text and source provenance from Lexwork`

---

### Task 8: `lexfind-registry` stage

**Files:**
- Create: `chpipe/lexfind_api.py`, `chpipe/stages/lexfind_registry_stage.py`, `tests/test_lexfind_registry_stage.py`, fixtures `lexfind_systematics_be.json` (two leaves with `tols`), `lexfind_tol_21736_groups.json`

**Interfaces:**
- `lexfind_api.LexfindClient(fetcher)`: `async systematics(entity_id) -> dict` (fetches `entities/{id}/systematics?active_only=false` once to learn leaf ids, then again with every leaf id in `tols_for_systematics[]`, in chunks of 50 ids per request), `async with_version_groups(tol_id) -> dict`, `flatten_versions(groups: dict) -> list[dict]` (`families[][][]` → flat list).
- `run(settings, canton_code=None, transport=None) -> RegistryReport(cantons, acts, versions, errors)`; upsert `ch_cantonal_registry` on `lexfind_tol_id` with `versions_json = flat versions`, `version_count = len(...)`, `original_url` from `dta_urls[0].original_url`.

- [ ] Tests: `test_registers_every_act_under_every_leaf`, `test_version_count_is_derived_from_the_families`, `test_rerun_updates_in_place`.
- [ ] Commit `feat(ch): lexfind-registry stage (26 cantons)`

---

### Task 9: Reconciliation report (`reports-cantonal`)

**Files:**
- Create: `chpipe/reports_cantonal.py`, `chpipe/stages/reports_cantonal_stage.py`, `tests/test_reports_cantonal.py`
- Modify: `run-stage.sh` (add `reports-cantonal` to the no-arg arm)

**Interfaces:**
- `gate_f(conn, canton: str | None = None) -> list[dict]` one dict per canton: `{canton, acts_lexwork, acts_lexfind, only_in_lexfind: [sysnr...≤12], only_in_lexwork: [...], versions_lexwork, versions_lexfind, date_matches, date_mismatches, parsed, failed_by_reason: {reason: n}, empty_articles, short_text, changes, provenance_rows, provenance_linked, change_documents_unlinked}`; `format_gate_f(rows) -> str`.
- `date_matches`: for acts present on both sides (join on `(canton, systematic_number)`), count `ch_act_version` (lang = first canton lang) whose `date_applicability` equals some `version_active_since::date` in `versions_json`; mismatches = the rest. Both sides are independent sources, which is what makes it a gate.

- [ ] Tests on a seeded scratch DB: `test_only_in_lists_are_symmetric_differences`, `test_date_match_counts_versions_present_in_lexfind`, `test_failed_by_reason_groups_last_error_prefixes`.
- [ ] Commit `feat(ch): Gate F reconciliation report for cantonal legislation`

---

### Task 10: Nightly delta (`run_cantonal`)

**Files:**
- Modify: `chpipe/delta.py` (`DeltaReport` gains `cantonal_acts: int`, `cantonal_versions: int`; `run_cantonal(settings)`; fourth tuple entry `("cantonal", run_cantonal)` in `main()`; state key `"cantonal": {code: last_change_date}` saved in the existing state file via `_load_state`/`_save_state`, which must tolerate the extra key)
- Modify: `tests/test_delta.py` (`test_run_cantonal_only_rewalks_acts_named_by_recent_changes`, `test_run_cantonal_first_run_with_no_state_walks_everything`, `test_a_failing_canton_does_not_stop_the_others`)

**Behaviour:** per Lexwork canton: page `recent_changes` (`entries[].change_date`, `text_of_law.systematic_number`; follow `next_batch` while the oldest `change_date` on the page ≥ stored `last_seen`); collect sysnrs; if no state for the canton, `only=None` (full walk). Then `cantonal_acts_stage.run(settings, code, only=sysnrs)`, `cantonal_fetch_stage.run(settings, code)`, `parsed = cantonal_parse_stage.run(settings, code)`, `diff_stage.run(settings, lang, act_id)` for `parsed.acts`, then `project_legacy_stage.run(settings)` once at the end. Save `last_seen = today` per canton only after that canton succeeded.

- [ ] Tests → implement → commit `feat(ch): nightly cantonal delta driven by Lexwork recent_changes`

---

### Task 11: MCP tools: `canton` parameter (TypeScript)

**Files:**
- Modify: `mcp_backend/src/api/tools/ch-legislation-tools.ts` (all three tool schemas gain `canton: { type: 'string', description: "Юрисдикція: 'CH' (федеральне, за замовчуванням), код кантону (ZH, BE, ...) або 'all' лише для пошуку" }`; `searchLegislation`: `WHERE ... AND ($jur = 'all' OR a.jurisdiction = $jur)`, alias lateral gains `AND a.jurisdiction = 'CH'`, SELECT and output rows gain `jurisdiction`; `getActArticle`/`getActHistory`: `WHERE jurisdiction = $2 AND sr_number = $1`, output gains `jurisdiction`; validation: `canton` must be `'all'` (search only) or match `/^[A-Z]{2}$/`; descriptions say "федерального (Fedlex) та кантонального (19 кантонів)")
- Modify: `lexwebapp/src/hooks/chat/evidence/ch.ts` (label `(SR ${sr})` becomes `(${jurisdiction === 'CH' || !jurisdiction ? 'SR' : jurisdiction} ${sr})`)
- Test: `mcp_backend/src/api/tools/__tests__/ch-legislation-tools.test.ts` (create if absent; mock `db.query`, assert the SQL text includes `jurisdiction` and the default is `'CH'`; assert `canton: 'xx'` is rejected with a Ukrainian message)

- [ ] Write the failing Jest test, implement, `cd mcp_backend && npx tsc --noEmit -p .` and `npx jest src/api/tools/__tests__/ch-legislation-tools.test.ts`, then `cd lexwebapp && npx tsc --noEmit`.
- [ ] Commit `feat(ch): canton parameter on the CH legislation tools`

---

### Task 12: Operator docs and entry points

**Files:**
- Modify: `services/ch-pipeline/README.md` (new section "Cantonal legislation (Lexwork)": stages, order for the backfill, Gate F, delta and the weekly cron line `0 4 * * 0 ... run-stage.sh cantonal-acts` + `lexfind-registry`; env `CHPIPE_CANTON`, `CHPIPE_CANTONAL_PER_HOST`)
- Modify: `chpipe/config.py` (`cantonal_per_host: int = 2` from `CHPIPE_CANTONAL_PER_HOST`), `tests/test_config.py`
- Verify: `tests/test_entry_points.py` picks up the five new stage modules (it globs `chpipe/stages/*_stage.py`; if it lists names explicitly, add them).
- `tests/test_run_delta_sh.py` unchanged (run-delta.sh does not change).

- [ ] Run the whole suite with DSN; run `bash -n run-stage.sh`; commit `docs(ch): cantonal legislation operator runbook`

---

## Self-review

- Spec §4 migration → Task 1. §3.3 registry → Task 2. §5.1 parser → Task 3. §4.1 consequences → Task 4. §5 stages → Tasks 5-9. §5.3 delta → Task 10. §6 tools → Task 11. §7 Gate F → Task 9 (automated part) + README manual step (Task 12). §8 tests are inside each task. §9 prod ops are not code: README (Task 12) carries the checklist.
- Type consistency: `lexwork.Provenance.change_document_source_id` (Task 3) is what Task 7 resolves to `change_document_id`; `db.claim_versions(source=...)` (Task 4) is what Tasks 6-7 call; `cantons.LEXWORK[code].langs` (Task 2) drives Task 5's version rows; `ParseReport.acts` (Task 7) feeds Task 10's diff loop exactly like `parse_akn_stage.ParseReport.acts` feeds `run_legislation`.
- No placeholders: every stage lists its report fields, SQL keys and failure counters; the Task 6/8/9 bodies are described by the same structure as the existing sibling stages named in each task.
