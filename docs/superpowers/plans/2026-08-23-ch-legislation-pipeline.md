# CH Legislation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace a flat table holding one edition each of 1,901 Swiss federal acts with a corpus that holds all 17,293 acts, all 56,328 consolidated editions, their articles, and a computed per-article change log — so "which article changed, when, and how" is answerable.

**Architecture:** SPARQL discovery against `fedlex.data.admin.ch` fills two skeleton tables (`ch_act`, `ch_act_version`); a fetch stage downloads the Akoma Ntoso XML named by each version; a parser explodes it into `ch_act_article`; a diff stage walks each act's editions in date order and writes `ch_act_change`. Same package as the decisions pipeline, same queue-in-a-column pattern, different stage modules.

**Tech Stack:** Python 3.12, `httpx`, `psycopg[binary]` 3, `lxml` (Akoma Ntoso), `pytest`. All already introduced by the decisions plan.

**Spec:** `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-23-ch-decisions-pipeline.md`, Tasks 2 and 5 (`chpipe.config`, `chpipe.db`, `chpipe.http`). Do not start this plan before those two tasks are merged.

## Global Constraints

- **Migration number 197** is reserved for this plan. See the decisions plan for why 193–195 are unavailable.
- **Migrations must be idempotent.**
- **Everything runs on prod.**
- **Every SPARQL query must use `DISTINCT`.** Fedlex serves the same triples from several named graphs, so a query without `DISTINCT` returns each row two to six times. This was verified on 2026-08-23: a versions query for SR 220 returned six identical rows for one edition.
- **Verified vocabulary — do not guess these.** `jolux:inForceStatus` is a URI, not a boolean:
  - `https://fedlex.data.admin.ch/vocabulary/enforcement-status/0` = **In force** — 7,863 works carry status 3, 5,087 carry status 0, 47 carry status 1, and 4,296 of the 17,293 works carry no status at all.
  - `…/enforcement-status/1` = No longer published in the SR
  - `…/enforcement-status/3` = No longer in force
- **Five languages exist, not three.** `jolux:isRealizedBy` yields DEU, FRA, ITA and, for many acts, ENG and ROH. `jolux:titleShort` carries the abbreviation (`OR`, `CO`). The pipeline stores de/fr/it as first-class and keeps en/rm when present.
- **The real SR number comes from `jolux:classifiedByTaxonomyEntry/skos:notation`** filtered to `datatype(?notation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>`. Never derive it from the ELI path — that is the bug that made `SR 220` unfindable in the current table.
- **Not every work has an SR notation.** Verified: `eli/cc/1/116_97_116` has none. `sr_number` must be nullable and the pipeline must not skip such works.
- **`count(*)`, never `n_live_tup`.**

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp_backend/src/migrations/197_ch_legislation_corpus.sql` | `ch_act`, `ch_act_version`, `ch_act_article`, `ch_act_change`, and the `ch_legislation` compatibility projection |
| `services/ch-pipeline/chpipe/sparql.py` | Fedlex SPARQL client: POST, paging, `DISTINCT` enforcement, binding flattening |
| `services/ch-pipeline/chpipe/fedlex_queries.py` | The four queries, as named constants with their result contracts |
| `services/ch-pipeline/chpipe/akn.py` | Akoma Ntoso XML → articles and plain text (pure) |
| `services/ch-pipeline/chpipe/diff_articles.py` | Two article lists → change rows (pure) |
| `services/ch-pipeline/chpipe/stages/acts_stage.py` | Discovery of works → `ch_act` |
| `services/ch-pipeline/chpipe/stages/versions_stage.py` | Discovery of consolidations → `ch_act_version` |
| `services/ch-pipeline/chpipe/stages/fetch_xml_stage.py` | Download AKN XML per (version, language) |
| `services/ch-pipeline/chpipe/stages/parse_akn_stage.py` | XML → `ch_act_article` + `full_text` |
| `services/ch-pipeline/chpipe/stages/diff_stage.py` | Editions in date order → `ch_act_change` |
| `services/ch-pipeline/chpipe/stages/project_legacy_stage.py` | Rebuild `ch_legislation` from the new tables |
| `services/ch-pipeline/chpipe/reports_leg.py` | Gate E |

---

### Task 1: Migration — the legislation corpus schema

**Files:**
- Create: `mcp_backend/src/migrations/197_ch_legislation_corpus.sql`
- Test: `services/ch-pipeline/tests/test_migration_197.py`

**Interfaces:**
- Produces: tables `ch_act`, `ch_act_version`, `ch_act_article`, `ch_act_change` with the columns asserted below.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_migration_197.py
"""Applies migration 197 to a scratch database. A mocked DB cannot validate SQL."""
import os
import pathlib
import psycopg
import pytest

MIGRATION = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version",
                  "ch_act", "ch_legislation"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        # migration 135's shape, which 197 must keep working
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
        c.execute(MIGRATION.read_text())
        yield c


def _cols(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,)).fetchall()}


def test_creates_the_four_tables(conn):
    for t in ("ch_act", "ch_act_version", "ch_act_article", "ch_act_change"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]


def test_act_carries_a_nullable_sr_number_and_five_title_languages(conn):
    cols = _cols(conn, "ch_act")
    assert {"act_id", "eli_work_uri", "sr_number", "in_force",
            "title_de", "title_fr", "title_it", "title_en", "title_rm",
            "abbreviation", "date_document", "date_entry_force",
            "date_no_longer_in_force", "enforcement_status"} <= cols
    nullable = conn.execute(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name='ch_act' AND column_name='sr_number'").fetchone()[0]
    assert nullable == "YES", "eli/cc/1/116_97_116 has no SR notation"


def test_act_is_unique_by_eli_work_uri(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('https://x/1')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('https://x/1')")


def test_several_acts_may_share_an_sr_number(conn):
    """SR numbers are reused across superseded works; uniqueness lives on the ELI."""
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('https://x/1','220')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('https://x/2','220')")
    assert conn.execute("SELECT count(*) FROM ch_act WHERE sr_number='220'").fetchone()[0] == 2


def test_version_is_unique_by_consolidation_and_language(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                 "date_applicability) VALUES (1,'https://x/1/2020','de','2020-01-01')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability) VALUES (1,'https://x/1/2020','de','2020-01-01')")


def test_deleting_an_act_cascades_to_versions_articles_and_changes(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'art_1','1','t',1)")
    conn.execute("DELETE FROM ch_act WHERE act_id = 1")
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == 0


def test_change_type_is_constrained(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_change (act_id, e_id, change_type, "
                     "date_applicability) VALUES (1,'art_1','rewritten','2020-01-01')")


def test_article_e_id_may_be_a_path(conn):
    """Verified in the real OR XML: transitional articles carry eIds like
    'disp_u17/art_7', so article numbers repeat within one document and only the
    eId is unique."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'art_7','7','a',1)")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'disp_u17/art_7','7','b',2)")
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == 2
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, "
                     "text, ordinal) VALUES (1,'art_7','7','c',3)")


def test_ch_legislation_survives_untouched(conn):
    assert conn.execute("SELECT to_regclass('ch_legislation') IS NOT NULL").fetchone()[0]


def test_is_idempotent(conn):
    conn.execute(MIGRATION.read_text())      # must not raise
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_migration_197.py -v
```

Expected: FAIL — the migration file does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- mcp_backend/src/migrations/197_ch_legislation_corpus.sql
-- Swiss federal legislation with its edition history.
--
-- Replaces the shape of migration 135, which could hold exactly one edition per
-- (eli_uri, lang) and therefore no amendment history at all. As of 2026-08-23
-- ch_legislation holds 1,901 acts of the 17,293 Fedlex publishes and 0 of its
-- 56,328 consolidated editions. ch_legislation itself is kept and becomes a
-- projection of these tables — see 197's companion stage project_legacy_stage.

CREATE TABLE IF NOT EXISTS public.ch_act (
    act_id                  bigserial PRIMARY KEY,
    eli_work_uri            text NOT NULL,
    -- Nullable on purpose: eli/cc/1/116_97_116 and ~4,300 others carry no
    -- id-systematique notation. Deriving one from the ELI path is what made
    -- "SR 220" unfindable in the old table.
    sr_number               text,
    act_type                text,
    abbreviation            text,
    title_de                text,
    title_fr                text,
    title_it                text,
    title_en                text,
    title_rm                text,
    date_document           date,
    date_entry_force        date,
    date_no_longer_in_force date,
    -- Verified vocabulary: 0 = In force, 1 = No longer published in the SR,
    -- 3 = No longer in force. NULL for the ~4,296 works with no status.
    enforcement_status      smallint,
    in_force                boolean GENERATED ALWAYS AS (enforcement_status = 0) STORED,
    taxonomy_path           text,
    metadata_json           jsonb,
    stage                   text NOT NULL DEFAULT 'discovered',
    imported_at             timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_eli ON public.ch_act (eli_work_uri);
CREATE INDEX IF NOT EXISTS idx_ch_act_sr ON public.ch_act (sr_number)
    WHERE sr_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_act_in_force ON public.ch_act (in_force);

CREATE TABLE IF NOT EXISTS public.ch_act_version (
    version_id              bigserial PRIMARY KEY,
    act_id                  bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    eli_consolidation_uri   text NOT NULL,
    lang                    text NOT NULL,
    date_applicability      date NOT NULL,
    date_end_applicability  date,
    xml_url                 text,
    html_url                text,
    pdf_url                 text,
    akn_xml                 text,
    full_text               text,
    article_count           integer,
    stage                   text NOT NULL DEFAULT 'discovered',
    attempts                smallint NOT NULL DEFAULT 0,
    last_error              text,
    fetched_at              timestamptz,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_version
    ON public.ch_act_version (eli_consolidation_uri, lang);
CREATE INDEX IF NOT EXISTS idx_ch_act_version_act
    ON public.ch_act_version (act_id, lang, date_applicability);
CREATE INDEX IF NOT EXISTS idx_ch_act_version_stage
    ON public.ch_act_version (stage) WHERE stage <> 'parsed';

CREATE TABLE IF NOT EXISTS public.ch_act_article (
    article_id      bigserial PRIMARY KEY,
    version_id      bigint NOT NULL REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    -- Akoma Ntoso eId. Verified in the real OR XML that these can be paths
    -- ('disp_u17/art_7'), so article_number is NOT unique within a version but
    -- e_id is.
    e_id            text NOT NULL,
    article_number  text,
    marginal_note   text,
    text            text NOT NULL,
    ordinal         integer NOT NULL,
    parent_e_id     text
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_article
    ON public.ch_act_article (version_id, e_id);
CREATE INDEX IF NOT EXISTS idx_ch_act_article_number
    ON public.ch_act_article (article_number);
CREATE INDEX IF NOT EXISTS idx_ch_act_article_order
    ON public.ch_act_article (version_id, ordinal);

CREATE TABLE IF NOT EXISTS public.ch_act_change (
    change_id           bigserial PRIMARY KEY,
    act_id              bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    lang                text NOT NULL DEFAULT 'de',
    from_version_id     bigint REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    to_version_id       bigint REFERENCES public.ch_act_version(version_id) ON DELETE CASCADE,
    e_id                text NOT NULL,
    article_number      text,
    change_type         text NOT NULL,
    date_applicability  date NOT NULL,
    CONSTRAINT ch_act_change_type_chk
        CHECK (change_type IN ('added', 'modified', 'repealed'))
);

CREATE INDEX IF NOT EXISTS idx_ch_act_change_act
    ON public.ch_act_change (act_id, date_applicability);
CREATE INDEX IF NOT EXISTS idx_ch_act_change_article
    ON public.ch_act_change (act_id, e_id, date_applicability);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_change
    ON public.ch_act_change (to_version_id, e_id, change_type);

COMMENT ON TABLE public.ch_act_change IS
    'Computed per-article difference between consecutive consolidated editions. '
    'This is the amendment history; Fedlex does not publish it directly.';
COMMENT ON COLUMN public.ch_act.enforcement_status IS
    '0 = in force, 1 = no longer published in the SR, 3 = no longer in force, '
    'NULL = Fedlex publishes no status for this work';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_migration_197.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/migrations/197_ch_legislation_corpus.sql \
        services/ch-pipeline/tests/test_migration_197.py
git commit -m "feat(ch): legislation schema that can hold editions and changes"
```

---

### Task 2: SPARQL client and the query set

**Files:**
- Create: `services/ch-pipeline/chpipe/sparql.py`, `services/ch-pipeline/chpipe/fedlex_queries.py`
- Test: `services/ch-pipeline/tests/test_sparql.py`, `services/ch-pipeline/tests/test_fedlex_queries.py`

**Interfaces:**
- Produces: `chpipe.sparql.SparqlClient(endpoint: str, timeout: float = 180.0, transport=None)` with `def select(query: str) -> list[dict[str, str]]` and `def paged(query_template: str, page_size: int = 5000) -> Iterator[dict[str, str]]`; `chpipe.sparql.SparqlError`.
- Produces in `chpipe.fedlex_queries`: `ENDPOINT`, `ACTS`, `VERSIONS`, `TITLES`, `ENFORCEMENT_STATUS_IN_FORCE = 0`, and `status_code(uri: str) -> int | None`.

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_sparql.py
import httpx
import pytest
from chpipe.sparql import SparqlClient, SparqlError

RESULT = {
    "head": {"vars": ["work", "sr"]},
    "results": {"bindings": [
        {"work": {"type": "uri", "value": "https://x/1"},
         "sr": {"type": "typed-literal", "value": "220"}},
        {"work": {"type": "uri", "value": "https://x/2"}},
    ]},
}


def _client(handler, **kw):
    return SparqlClient("https://fake/sparql", transport=httpx.MockTransport(handler), **kw)


def test_select_flattens_bindings_to_plain_values():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    assert c.select("SELECT * WHERE {}") == [
        {"work": "https://x/1", "sr": "220"},
        {"work": "https://x/2"},
    ]


def test_select_posts_the_query_as_form_data():
    seen = {}

    def handler(request):
        seen["body"] = request.content.decode()
        seen["accept"] = request.headers["accept"]
        return httpx.Response(200, json=RESULT)

    _client(handler).select("SELECT ?x WHERE {}")
    assert "query=" in seen["body"]
    assert seen["accept"] == "application/sparql-results+json"


def test_a_non_200_raises():
    c = _client(lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(SparqlError, match="500"):
        c.select("SELECT * WHERE {}")


def test_paged_walks_until_a_short_page():
    pages = [
        {"head": {"vars": ["w"]},
         "results": {"bindings": [{"w": {"value": str(i)}} for i in range(3)]}},
        {"head": {"vars": ["w"]},
         "results": {"bindings": [{"w": {"value": "3"}}]}},
    ]
    calls = {"n": 0}

    def handler(request):
        body = pages[min(calls["n"], len(pages) - 1)]
        calls["n"] += 1
        return httpx.Response(200, json=body)

    c = _client(handler)
    rows = list(c.paged("SELECT ?w WHERE {} LIMIT %(limit)d OFFSET %(offset)d",
                        page_size=3))
    assert [r["w"] for r in rows] == ["0", "1", "2", "3"]
    assert calls["n"] == 2


def test_paged_requires_the_limit_and_offset_placeholders():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="LIMIT"):
        list(c.paged("SELECT ?w WHERE {}"))
```

```python
# services/ch-pipeline/tests/test_fedlex_queries.py
from chpipe import fedlex_queries as q


def test_every_select_query_is_distinct():
    """Fedlex serves the same triples from several named graphs. A versions
    query for SR 220 without DISTINCT returned the same edition six times."""
    for name in ("ACTS", "VERSIONS", "TITLES"):
        assert "SELECT DISTINCT" in getattr(q, name), f"{name} is missing DISTINCT"


def test_acts_filters_the_sr_notation_by_its_datatype():
    assert "id-systematique" in q.ACTS


def test_acts_and_versions_are_pageable():
    for name in ("ACTS", "VERSIONS"):
        text = getattr(q, name)
        assert "%(limit)d" in text and "%(offset)d" in text
        assert "ORDER BY" in text, "paging without ORDER BY can drop or repeat rows"


def test_status_code_extracts_the_trailing_integer():
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0") == 0
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3") == 3


def test_status_code_of_none_or_junk_is_none():
    assert q.status_code(None) is None
    assert q.status_code("not a uri") is None


def test_in_force_is_zero_not_one():
    """Verified against the vocabulary on 2026-08-23: 0 = 'In force',
    3 = 'Nicht mehr in Kraft'. Guessing 1 here would mark 5,087 acts repealed."""
    assert q.ENFORCEMENT_STATUS_IN_FORCE == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_sparql.py tests/test_fedlex_queries.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementations**

```python
# services/ch-pipeline/chpipe/sparql.py
"""Minimal SPARQL SELECT client.

Synchronous on purpose: discovery is a handful of long queries, not hundreds of
small ones, and the endpoint is happier with one connection than with twelve.
"""
from __future__ import annotations

from typing import Iterator

import httpx


class SparqlError(RuntimeError):
    pass


class SparqlClient:
    def __init__(self, endpoint: str, timeout: float = 180.0,
                 transport: httpx.BaseTransport | None = None):
        self._endpoint = endpoint
        self._client = httpx.Client(
            timeout=timeout, transport=transport,
            headers={"Accept": "application/sparql-results+json",
                     "User-Agent": "SecondLayer-CH-Pipeline/1.0 (+https://legal.org.ua)"},
        )

    def close(self) -> None:
        self._client.close()

    def select(self, query: str) -> list[dict[str, str]]:
        response = self._client.post(self._endpoint, data={"query": query})
        if response.status_code != 200:
            raise SparqlError(f"{response.status_code}: {response.text[:300]}")
        bindings = response.json().get("results", {}).get("bindings", [])
        return [{k: v["value"] for k, v in row.items()} for row in bindings]

    def paged(self, query_template: str, page_size: int = 5000
              ) -> Iterator[dict[str, str]]:
        """Walk a query that ends in LIMIT %(limit)d OFFSET %(offset)d.

        Stops on the first short page. The template must ORDER BY something
        stable, or paging silently drops and repeats rows.
        """
        if "%(limit)d" not in query_template or "%(offset)d" not in query_template:
            raise ValueError("paged() needs LIMIT %(limit)d OFFSET %(offset)d")
        offset = 0
        while True:
            rows = self.select(query_template % {"limit": page_size, "offset": offset})
            yield from rows
            if len(rows) < page_size:
                return
            offset += page_size
```

```python
# services/ch-pipeline/chpipe/fedlex_queries.py
"""The Fedlex SPARQL queries, verified against the live endpoint on 2026-08-23.

Counts observed that day, for reference when a run's numbers look wrong:
  jolux:ConsolidationAbstract   17,293 distinct works
  jolux:Consolidation           56,326 (56,328 was wrong; re-measured
                                2026-08-24 by keyset walk, see
                                chpipe/fedlex_queries.py's header)
  jolux:Act (AS + BBl)         211,637 distinct (369,181 is COUNT(*), a raw triple count)
  enforcement-status 0 (in force)  5,087 works
  enforcement-status 3 (repealed)  7,863 works
  enforcement-status 1                47 works
  no status at all                 4,296 works
"""
from __future__ import annotations

import re

ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint"

# 0 = "In force" / "In Kraft". Confirmed from the vocabulary's own skos:prefLabel.
ENFORCEMENT_STATUS_IN_FORCE = 0

_STATUS_TAIL = re.compile(r"/enforcement-status/(\d+)$")

_PREFIXES = """
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
"""

# One row per work. srNotation, dateDocument and inForce are all OPTIONAL because
# roughly 4,300 works carry no status and some carry no SR notation at all.
ACTS = _PREFIXES + """
SELECT DISTINCT ?work ?srNotation ?dateDocument ?dateEntryForce
                ?dateNoLongerInForce ?inForce WHERE {
  ?work a jolux:ConsolidationAbstract .
  OPTIONAL {
    ?work jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
    FILTER(datatype(?srNotation) =
           <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  }
  OPTIONAL { ?work jolux:dateDocument ?dateDocument }
  OPTIONAL { ?work jolux:dateEntryInForce ?dateEntryForce }
  OPTIONAL { ?work jolux:dateNoLongerInForce ?dateNoLongerInForce }
  OPTIONAL { ?work jolux:inForceStatus ?inForce }
}
ORDER BY ?work
LIMIT %(limit)d OFFSET %(offset)d
"""

# Titles, one row per (work, language). Five languages occur: DEU, FRA, ITA and,
# for many acts, ENG and ROH. titleShort carries the abbreviation ("OR", "CO").
TITLES = _PREFIXES + """
SELECT DISTINCT ?work ?lang ?title ?titleShort WHERE {
  ?work a jolux:ConsolidationAbstract ;
        jolux:isRealizedBy ?expr .
  ?expr jolux:language ?lang ; jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?titleShort }
}
ORDER BY ?work ?lang
LIMIT %(limit)d OFFSET %(offset)d
"""

# One row per (consolidation, language) with the direct file URL. The file URL
# is read from the graph rather than assembled from a string pattern — the old
# importer assembled it and could not express versions at all.
VERSIONS = _PREFIXES + """
SELECT DISTINCT ?work ?consolidation ?dateApplicability ?dateEndApplicability
                ?lang ?fileUrl WHERE {
  ?consolidation a jolux:Consolidation ;
                 jolux:isMemberOf ?work ;
                 jolux:dateApplicability ?dateApplicability .
  OPTIONAL { ?consolidation jolux:dateEndApplicability ?dateEndApplicability }
  ?consolidation jolux:isRealizedBy ?expr .
  ?expr jolux:language ?lang ;
        jolux:isEmbodiedBy ?manifestation .
  ?manifestation jolux:isExemplifiedBy ?fileUrl ;
                 jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/xml> .
}
ORDER BY ?work ?dateApplicability ?lang
LIMIT %(limit)d OFFSET %(offset)d
"""

LANGUAGE_MAP = {
    "http://publications.europa.eu/resource/authority/language/DEU": "de",
    "http://publications.europa.eu/resource/authority/language/FRA": "fr",
    "http://publications.europa.eu/resource/authority/language/ITA": "it",
    "http://publications.europa.eu/resource/authority/language/ENG": "en",
    "http://publications.europa.eu/resource/authority/language/ROH": "rm",
}


def status_code(uri: str | None) -> int | None:
    if not uri:
        return None
    match = _STATUS_TAIL.search(uri)
    return int(match.group(1)) if match else None


def language_code(uri: str | None) -> str | None:
    return LANGUAGE_MAP.get(uri or "")
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_sparql.py tests/test_fedlex_queries.py -v
```

Expected: 11 passed.

- [ ] **Step 5: Verify the queries against the live endpoint**

A query that passes a unit test but returns nothing from Fedlex is worthless.

```bash
cd services/ch-pipeline
python3 - <<'PY'
from chpipe.sparql import SparqlClient
from chpipe import fedlex_queries as q
c = SparqlClient(q.ENDPOINT)
acts = c.select(q.ACTS % {"limit": 5, "offset": 0})
print("ACTS   ", len(acts), acts[0] if acts else "EMPTY")
vers = c.select(q.VERSIONS % {"limit": 5, "offset": 0})
print("VERSION", len(vers), vers[0] if vers else "EMPTY")
tit = c.select(q.TITLES % {"limit": 5, "offset": 0})
print("TITLES ", len(tit), tit[0] if tit else "EMPTY")
PY
```

Expected: each prints 5 rows and a sample binding. `VERSIONS` rows must carry a `fileUrl` under `https://fedlex.data.admin.ch/filestore/`. If any query returns EMPTY, fix the query before continuing — do not work around it downstream.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/sparql.py services/ch-pipeline/chpipe/fedlex_queries.py \
        services/ch-pipeline/tests/test_sparql.py services/ch-pipeline/tests/test_fedlex_queries.py
git commit -m "feat(ch): fedlex sparql client and the verified query set"
```

---

### Task 3: The `acts` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/acts_stage.py`
- Test: `services/ch-pipeline/tests/test_acts_stage.py`

**Interfaces:**
- Consumes: `sparql.SparqlClient`, `fedlex_queries.ACTS`, `fedlex_queries.TITLES`, `fedlex_queries.status_code`, `fedlex_queries.language_code`, `db.connect`.
- Produces: `chpipe.stages.acts_stage.upsert_act(conn, row: dict) -> int` returning `act_id`; `chpipe.stages.acts_stage.apply_titles(conn, rows: list[dict]) -> int`; `chpipe.stages.acts_stage.run(settings) -> ActsReport` with `ActsReport(discovered: int, with_sr: int, in_force: int)`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_acts_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe.stages import acts_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "sr_number text, title text, PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        yield c


OR_ROW = {
    "work": "https://fedlex.data.admin.ch/eli/cc/27/317_321_377",
    "srNotation": "220",
    "dateDocument": "1911-03-30",
    "dateEntryForce": "1912-01-01",
    "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0",
}


def test_stores_the_real_sr_number(conn):
    """The whole point: the old table stored '1971/1069_1068_1068' here."""
    acts_stage.upsert_act(conn, OR_ROW)
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] == "220"


def test_status_zero_means_in_force(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (0, True)


def test_status_three_means_repealed(conn):
    acts_stage.upsert_act(conn, {**OR_ROW, "inForce":
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"})
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (3, False)


def test_a_work_with_no_status_is_stored_with_null_not_false(conn):
    """~4,296 works publish no status; recording them as 'not in force' would be
    an assertion Fedlex never made."""
    row = dict(OR_ROW)
    row.pop("inForce")
    acts_stage.upsert_act(conn, row)
    assert conn.execute(
        "SELECT enforcement_status, in_force FROM ch_act").fetchone() == (None, None)


def test_a_work_with_no_sr_notation_is_still_stored(conn):
    row = dict(OR_ROW)
    row.pop("srNotation")
    row["work"] = "https://fedlex.data.admin.ch/eli/cc/1/116_97_116"
    act_id = acts_stage.upsert_act(conn, row)
    assert act_id is not None
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] is None


def test_upsert_is_idempotent_and_returns_the_same_id(conn):
    first = acts_stage.upsert_act(conn, OR_ROW)
    second = acts_stage.upsert_act(conn, OR_ROW)
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 1


def test_apply_titles_writes_all_five_languages_and_the_abbreviation(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    L = "http://publications.europa.eu/resource/authority/language/"
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": L + "DEU", "title": "Bundesgesetz …",
         "titleShort": "OR"},
        {"work": OR_ROW["work"], "lang": L + "FRA", "title": "Loi fédérale …",
         "titleShort": "CO"},
        {"work": OR_ROW["work"], "lang": L + "ITA", "title": "Legge federale …"},
        {"work": OR_ROW["work"], "lang": L + "ENG", "title": "Federal Act …"},
        {"work": OR_ROW["work"], "lang": L + "ROH", "title": "Lescha federala …"},
    ])
    row = conn.execute(
        "SELECT title_de, title_fr, title_it, title_en, title_rm, abbreviation "
        "FROM ch_act").fetchone()
    assert row[0].startswith("Bundesgesetz")
    assert row[3].startswith("Federal Act")
    assert row[4].startswith("Lescha")
    assert row[5] == "OR"


def test_apply_titles_ignores_a_language_we_do_not_store(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": "http://example/unknown", "title": "x"}])
    assert conn.execute("SELECT title_de FROM ch_act").fetchone()[0] is None


def test_apply_titles_for_an_unknown_work_is_a_no_op(conn):
    assert acts_stage.apply_titles(conn, [
        {"work": "https://x/never-seen", "lang":
         "http://publications.europa.eu/resource/authority/language/DEU",
         "title": "x"}]) == 0
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_acts_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.stages.acts_stage'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/acts_stage.py
"""Discovery of Systematic Compilation works into ch_act.

17,293 works as of 2026-08-23, of which 5,087 are in force. The old importer
found 1,901 because it ran with MAX_ACTS=200 and no paging.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)

_TITLE_COLUMN = {"de": "title_de", "fr": "title_fr", "it": "title_it",
                 "en": "title_en", "rm": "title_rm"}


@dataclass
class ActsReport:
    discovered: int = 0
    with_sr: int = 0
    in_force: int = 0
    titled: int = 0


_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, sr_number, date_document, date_entry_force,
                    date_no_longer_in_force, enforcement_status, metadata_json,
                    stage, updated_at)
VALUES (%(work)s, %(sr)s, %(date_document)s, %(date_entry_force)s,
        %(date_no_longer)s, %(status)s, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    sr_number               = COALESCE(EXCLUDED.sr_number, ch_act.sr_number),
    date_document           = COALESCE(EXCLUDED.date_document, ch_act.date_document),
    date_entry_force        = COALESCE(EXCLUDED.date_entry_force, ch_act.date_entry_force),
    date_no_longer_in_force = COALESCE(EXCLUDED.date_no_longer_in_force,
                                       ch_act.date_no_longer_in_force),
    enforcement_status      = EXCLUDED.enforcement_status,
    metadata_json           = EXCLUDED.metadata_json,
    updated_at              = now()
RETURNING act_id
"""


def _date(value: str | None) -> str | None:
    return value[:10] if value else None


def upsert_act(conn, row: dict) -> int:
    params = {
        "work": row["work"],
        "sr": row.get("srNotation"),
        "date_document": _date(row.get("dateDocument")),
        "date_entry_force": _date(row.get("dateEntryForce")),
        "date_no_longer": _date(row.get("dateNoLongerInForce")),
        # NULL, not False: a work with no published status is unknown, not repealed.
        "status": fq.status_code(row.get("inForce")),
        "metadata": json.dumps({k: v for k, v in row.items() if k != "work"},
                               ensure_ascii=False),
    }
    result = conn.execute(_UPSERT_ACT, params).fetchone()
    return result["act_id"] if isinstance(result, dict) else result[0]


def apply_titles(conn, rows: list[dict]) -> int:
    """Write titles onto already-discovered acts. Returns rows affected."""
    affected = 0
    for row in rows:
        lang = fq.language_code(row.get("lang"))
        column = _TITLE_COLUMN.get(lang or "")
        if not column:
            continue
        assignments = [f"{column} = %s"]
        params: list = [row.get("title")]
        # The German abbreviation is the canonical one ("OR" for SR 220).
        if lang == "de" and row.get("titleShort"):
            assignments.append("abbreviation = %s")
            params.append(row["titleShort"])
        params.append(row["work"])
        affected += conn.execute(
            f"UPDATE ch_act SET {', '.join(assignments)}, updated_at = now() "
            f"WHERE eli_work_uri = %s", params).rowcount
    return affected


def run(settings: Settings) -> ActsReport:
    report = ActsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.ACTS, page_size=5000):
            upsert_act(conn, row)
            report.discovered += 1
            if row.get("srNotation"):
                report.with_sr += 1
            if fq.status_code(row.get("inForce")) == fq.ENFORCEMENT_STATUS_IN_FORCE:
                report.in_force += 1
            if report.discovered % 2000 == 0:
                log.info("acts discovered=%d", report.discovered)

        batch: list[dict] = []
        for row in client.paged(fq.TITLES, page_size=5000):
            batch.append(row)
            if len(batch) >= 1000:
                report.titled += apply_titles(conn, batch)
                batch = []
                log.info("titles applied=%d", report.titled)
        report.titled += apply_titles(conn, batch)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("discovered=%d with_sr=%d in_force=%d titled=%d", result.discovered,
             result.with_sr, result.in_force, result.titled)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_acts_stage.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Run it on prod and check the totals against the known counts**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && ./run-stage.sh acts"
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"SELECT count(*) AS acts, count(sr_number) AS with_sr,
           count(*) FILTER (WHERE in_force) AS in_force,
           count(*) FILTER (WHERE enforcement_status IS NULL) AS no_status,
           count(title_de) AS de, count(title_en) AS en FROM ch_act\""
```

Expected, within a small drift from 2026-08-23: `acts` ≈ 17,293, `in_force` ≈ 5,087, `no_status` ≈ 4,296. A materially different number means the paging dropped rows — investigate before continuing. Record the actual numbers in the commit message.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/acts_stage.py \
        services/ch-pipeline/tests/test_acts_stage.py
git commit -m "feat(ch): discover all 17k SR acts with their real SR numbers"
```

---

### Task 4: The `versions` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/versions_stage.py`
- Test: `services/ch-pipeline/tests/test_versions_stage.py`

**Interfaces:**
- Produces: `chpipe.stages.versions_stage.upsert_version(conn, row: dict) -> int | None` returning `version_id`, or `None` when the parent work is unknown; `chpipe.stages.versions_stage.run(settings) -> VersionsReport` with `VersionsReport(discovered: int, orphaned: int, by_lang: dict[str, int])`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_versions_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe.stages import acts_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
L = "http://publications.europa.eu/resource/authority/language/"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _row(date="2026-01-01", lang="DEU", end=None):
    return {
        "work": WORK,
        "consolidation": f"{WORK}/{date.replace('-', '')}",
        "dateApplicability": date,
        "dateEndApplicability": end,
        "lang": L + lang,
        "fileUrl": ("https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/"
                    f"eli/cc/27/317_321_377/{date.replace('-', '')}/de/xml/x.xml"),
    }


def test_stores_a_version_against_its_act(conn):
    vid = versions_stage.upsert_version(conn, _row())
    row = conn.execute(
        "SELECT v.date_applicability, v.lang, v.xml_url, a.sr_number "
        "FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE v.version_id = %s", (vid,)).fetchone()
    assert str(row[0]) == "2026-01-01"
    assert row[1] == "de"
    assert row[2].endswith(".xml")
    assert row[3] == "220"


def test_an_act_can_hold_many_versions(conn):
    for d in ("2020-01-01", "2022-01-01", "2026-01-01"):
        versions_stage.upsert_version(conn, _row(date=d))
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 3


def test_the_same_consolidation_in_three_languages_is_three_rows(conn):
    for lang in ("DEU", "FRA", "ITA"):
        versions_stage.upsert_version(conn, _row(lang=lang))
    langs = {r[0] for r in conn.execute("SELECT lang FROM ch_act_version").fetchall()}
    assert langs == {"de", "fr", "it"}


def test_duplicate_rows_from_named_graphs_collapse(conn):
    """Fedlex returns the same consolidation from several graphs; the second
    write must update, not duplicate."""
    first = versions_stage.upsert_version(conn, _row())
    second = versions_stage.upsert_version(conn, _row())
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 1


def test_end_of_applicability_is_kept_when_present(conn):
    vid = versions_stage.upsert_version(conn, _row(date="2020-01-01", end="2021-12-31"))
    assert str(conn.execute(
        "SELECT date_end_applicability FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0]) == "2021-12-31"


def test_a_version_whose_work_was_never_discovered_is_reported_not_inserted(conn):
    row = _row()
    row["work"] = "https://fedlex.data.admin.ch/eli/cc/never/seen"
    assert versions_stage.upsert_version(conn, row) is None
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0


def test_a_language_we_do_not_map_is_skipped(conn):
    row = _row()
    row["lang"] = "http://example/klingon"
    assert versions_stage.upsert_version(conn, row) is None


def test_new_versions_start_at_stage_discovered(conn):
    vid = versions_stage.upsert_version(conn, _row())
    assert conn.execute(
        "SELECT stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()[0] \
        == "discovered"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_versions_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/versions_stage.py
"""Discovery of consolidated editions into ch_act_version.

56,328 consolidations as of 2026-08-23, each realised in three to five
languages. This is the table the old flat ch_legislation could not express:
its primary key was (eli_uri, lang), which allows exactly one edition per act.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)


@dataclass
class VersionsReport:
    discovered: int = 0
    orphaned: int = 0
    skipped_language: int = 0
    by_lang: dict[str, int] = field(default_factory=dict)


_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, stage, updated_at)
SELECT a.act_id, %(consolidation)s, %(lang)s, %(date_app)s, %(date_end)s,
       %(xml_url)s, 'discovered', now()
  FROM ch_act a WHERE a.eli_work_uri = %(work)s
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = COALESCE(EXCLUDED.date_end_applicability,
                                      ch_act_version.date_end_applicability),
    xml_url                = COALESCE(EXCLUDED.xml_url, ch_act_version.xml_url),
    updated_at             = now()
RETURNING version_id
"""


def upsert_version(conn, row: dict) -> int | None:
    """Returns the version_id, or None if the language is unmapped or the parent
    work has not been discovered yet (run the acts stage first)."""
    lang = fq.language_code(row.get("lang"))
    if not lang:
        return None
    params = {
        "work": row["work"],
        "consolidation": row["consolidation"],
        "lang": lang,
        "date_app": row["dateApplicability"][:10],
        "date_end": (row.get("dateEndApplicability") or "")[:10] or None,
        "xml_url": row.get("fileUrl"),
    }
    result = conn.execute(_UPSERT_VERSION, params).fetchone()
    if result is None:
        return None                     # the SELECT matched no act
    return result["version_id"] if isinstance(result, dict) else result[0]


def run(settings: Settings) -> VersionsReport:
    report = VersionsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.VERSIONS, page_size=5000):
            lang = fq.language_code(row.get("lang"))
            if not lang:
                report.skipped_language += 1
                continue
            if upsert_version(conn, row) is None:
                report.orphaned += 1
                continue
            report.discovered += 1
            report.by_lang[lang] = report.by_lang.get(lang, 0) + 1
            if report.discovered % 5000 == 0:
                log.info("versions=%d orphaned=%d", report.discovered, report.orphaned)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("discovered=%d orphaned=%d skipped_language=%d by_lang=%s",
             result.discovered, result.orphaned, result.skipped_language,
             result.by_lang)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_versions_stage.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Run it on prod and check the shape**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && ./run-stage.sh versions"
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"SELECT lang, count(*) FROM ch_act_version GROUP BY 1 ORDER BY 2 DESC;
    SELECT count(DISTINCT eli_consolidation_uri) AS consolidations FROM ch_act_version;
    SELECT count(*) FROM ch_act_version WHERE xml_url IS NULL\""
```

Expected: `consolidations` ≈ 56,328; `xml_url IS NULL` should be 0 or very small. `orphaned` in the run log must be 0 — a non-zero value means the acts stage missed works the versions query knows about, which is a paging bug, not something to shrug at.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/versions_stage.py \
        services/ch-pipeline/tests/test_versions_stage.py
git commit -m "feat(ch): discover all 56k consolidated editions"
```

---

### Task 5: The Akoma Ntoso parser

**Files:**
- Create: `services/ch-pipeline/chpipe/akn.py`
- Test: `services/ch-pipeline/tests/test_akn.py`, `services/ch-pipeline/tests/fixtures/or_de_20260101.xml`

**Interfaces:**
- Produces: `chpipe.akn.Article` frozen dataclass with `e_id: str`, `article_number: str | None`, `marginal_note: str | None`, `text: str`, `ordinal: int`, `parent_e_id: str | None`.
- Produces: `chpipe.akn.parse_articles(xml: bytes) -> list[Article]`; `chpipe.akn.plain_text(xml: bytes) -> str`; `chpipe.akn.frbr_dates(xml: bytes) -> dict[str, str]`.

**Verified structure** (captured 2026-08-23 from the OR, German, edition 2026-01-01, 2.4 MB): root `{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}akomaNtoso`; 1,686 `<article>` elements; each has `eId` and a `<num>` containing `<b>Art. 1</b>`; body text lives in `<paragraph><content><p>`; **no `<heading>` elements at all** in this act; eIds can be paths such as `disp_u17/art_7`, so article numbers repeat within one document; `<FRBRdate name="jolux:dateApplicability" date="2026-01-01"/>` is present in the metadata block.

- [ ] **Step 1: Capture the real fixture**

The full OR is 2.4 MB, which is too large for the test suite. Capture it, then cut a representative slice that keeps one plain article, one nested-eId article and the FRBR metadata block.

```bash
cd services/ch-pipeline
curl -s --max-time 300 -o /tmp/or_full.xml \
  "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377/20260101/de/xml/fedlex-data-admin-ch-eli-cc-27-317_321_377-20260101-de-xml.xml"
python3 - <<'PY'
from lxml import etree
AKN = "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}"
tree = etree.parse("/tmp/or_full.xml")
root = tree.getroot()
arts = tree.findall(".//" + AKN + "article")
keep = [arts[0], arts[1]] + [a for a in arts if "/" in (a.get("eId") or "")][:1]
body = root.find(".//" + AKN + "body")
for a in list(body.iter(AKN + "article")):
    if a not in keep:
        a.getparent().remove(a)
etree.ElementTree(root).write("tests/fixtures/or_de_20260101.xml",
                              encoding="utf-8", xml_declaration=True)
print("kept eIds:", [a.get("eId") for a in keep])
PY
ls -la tests/fixtures/or_de_20260101.xml
```

- [ ] **Step 2: Write the failing test**

```python
# services/ch-pipeline/tests/test_akn.py
import pathlib
import pytest
from chpipe import akn

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
XML = FIXTURE.read_bytes()


def test_finds_the_articles():
    arts = akn.parse_articles(XML)
    assert len(arts) >= 3
    assert arts[0].e_id == "art_1"


def test_article_number_is_the_digits_not_the_label():
    art = akn.parse_articles(XML)[0]
    assert art.article_number == "1", "'Art. 1' must normalise to '1'"


def test_article_text_is_the_paragraph_content():
    art = akn.parse_articles(XML)[0]
    assert "Willensäusserung" in art.text
    assert "<p>" not in art.text


def test_ordinal_follows_document_order():
    arts = akn.parse_articles(XML)
    assert [a.ordinal for a in arts] == list(range(1, len(arts) + 1))


def test_a_nested_e_id_keeps_its_path_and_its_parent():
    arts = akn.parse_articles(XML)
    nested = [a for a in arts if "/" in a.e_id]
    assert nested, "fixture must contain one nested-eId article"
    assert nested[0].parent_e_id == nested[0].e_id.rsplit("/", 1)[0]


def test_two_articles_may_share_a_number_but_not_an_e_id():
    arts = akn.parse_articles(XML)
    assert len({a.e_id for a in arts}) == len(arts)


def test_marginal_note_is_none_when_the_act_has_no_headings():
    """Verified: the OR carries zero <heading> elements."""
    assert akn.parse_articles(XML)[0].marginal_note is None


def test_plain_text_contains_article_bodies_and_no_tags():
    text = akn.plain_text(XML)
    assert "Willensäusserung" in text
    assert "<" not in text


def test_frbr_dates_are_read_from_the_document_itself():
    dates = akn.frbr_dates(XML)
    assert dates["jolux:dateApplicability"] == "2026-01-01"
    assert dates["jolux:dateDocument"] == "1911-03-30"


def test_malformed_xml_raises_rather_than_returning_nothing():
    """Silently returning [] would let a broken download look like an empty act."""
    with pytest.raises(akn.AknParseError):
        akn.parse_articles(b"<akomaNtoso><unclosed>")


def test_an_empty_document_yields_no_articles():
    empty = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
             b'<act><body/></act></akomaNtoso>')
    assert akn.parse_articles(empty) == []
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_akn.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.akn'`.

- [ ] **Step 4: Write the implementation**

```python
# services/ch-pipeline/chpipe/akn.py
"""Akoma Ntoso (Fedlex flavour) -> articles and plain text.

Structure verified 2026-08-23 against the OR, German, edition 2026-01-01:

  <akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">
    <act>
      <meta>... <FRBRdate name="jolux:dateApplicability" date="2026-01-01"/> ...</meta>
      <body>
        <article eId="art_1">
          <num><b>Art. 1</b></num>
          <paragraph eId="art_1/para_1"><num>1</num><content><p>…</p></content></paragraph>
        </article>

Two facts that shape this module:
  * eIds can be paths ("disp_u17/art_7"), so article NUMBERS repeat inside one
    act and only the eId identifies an article.
  * That act contains zero <heading> elements, so marginal_note is usually None
    and must not be treated as required.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import etree

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
_AKN = "{%s}" % AKN_NS

# "Art. 12a" -> "12a"; "Art. 111-14" -> "111-14"
_NUMBER = re.compile(r"(\d+[a-zA-Z]*(?:[-–—]\d+[a-zA-Z]*)?)")
_DASHES = str.maketrans({"–": "-", "—": "-", " ": " "})


class AknParseError(ValueError):
    pass


@dataclass(frozen=True)
class Article:
    e_id: str
    article_number: str | None
    marginal_note: str | None
    text: str
    ordinal: int
    parent_e_id: str | None


def _root(xml: bytes):
    try:
        return etree.fromstring(xml)
    except etree.XMLSyntaxError as exc:
        raise AknParseError(str(exc)) from exc


def _text_of(element) -> str:
    parts = [t.strip() for t in element.itertext() if t and t.strip()]
    return " ".join(parts)


def normalise_number(raw: str | None) -> str | None:
    """'Art. 1' -> '1'. Folds en and em dashes, which occur inside a single act."""
    if not raw:
        return None
    match = _NUMBER.search(raw.translate(_DASHES))
    return match.group(1) if match else None


def parse_articles(xml: bytes) -> list[Article]:
    root = _root(xml)
    articles: list[Article] = []
    for ordinal, element in enumerate(root.iter(_AKN + "article"), start=1):
        e_id = element.get("eId")
        if not e_id:
            continue
        num_element = element.find(_AKN + "num")
        heading_element = element.find(_AKN + "heading")

        body_parts: list[str] = []
        for child in element:
            if child.tag in (_AKN + "num", _AKN + "heading"):
                continue
            body_parts.append(_text_of(child))
        text = " ".join(p for p in body_parts if p)

        articles.append(Article(
            e_id=e_id,
            article_number=normalise_number(
                _text_of(num_element) if num_element is not None else None),
            marginal_note=(_text_of(heading_element)
                           if heading_element is not None else None),
            text=text,
            ordinal=ordinal,
            parent_e_id=e_id.rsplit("/", 1)[0] if "/" in e_id else None,
        ))
    return articles


def plain_text(xml: bytes) -> str:
    root = _root(xml)
    body = root.find(".//" + _AKN + "body")
    target = body if body is not None else root
    lines = [t.strip() for t in target.itertext() if t and t.strip()]
    return "\n".join(lines)


def frbr_dates(xml: bytes) -> dict[str, str]:
    """The dates the document asserts about itself, for cross-checking SPARQL."""
    root = _root(xml)
    dates: dict[str, str] = {}
    for element in root.iter(_AKN + "FRBRdate"):
        name, value = element.get("name"), element.get("date")
        if name and value and name not in dates:
            dates[name] = value
    return dates
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_akn.py -v
```

Expected: 11 passed.

- [ ] **Step 6: Check the parser against the full OR, not just the slice**

```bash
cd services/ch-pipeline && python3 - <<'PY'
from chpipe import akn
xml = open("/tmp/or_full.xml", "rb").read()
arts = akn.parse_articles(xml)
print("articles:", len(arts))
print("with a number:", sum(1 for a in arts if a.article_number))
print("with empty text:", sum(1 for a in arts if not a.text.strip()))
print("nested eIds:", sum(1 for a in arts if a.parent_e_id))
print("duplicate numbers:", len(arts) - len({a.article_number for a in arts}))
PY
```

Expected: `articles` = 1686. `with a number` should be nearly all of them; `with empty text` should be small and correspond to repealed articles ("Aufgehoben"). Report these four numbers in the commit message — they are the parser's real accuracy, and a claim of correctness without them is not evidence.

- [ ] **Step 7: Commit**

```bash
git add services/ch-pipeline/chpipe/akn.py services/ch-pipeline/tests/test_akn.py \
        services/ch-pipeline/tests/fixtures/or_de_20260101.xml
git commit -m "feat(ch): akoma ntoso parser for fedlex acts"
```

---

### Task 6: The `fetch-xml` and `parse-akn` stages

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/fetch_xml_stage.py`, `services/ch-pipeline/chpipe/stages/parse_akn_stage.py`
- Test: `services/ch-pipeline/tests/test_parse_akn_stage.py`

**Interfaces:**
- Produces: `chpipe.stages.fetch_xml_stage.run(settings, limit=None) -> FetchXmlReport` with `FetchXmlReport(fetched: int, failed: int, bytes_written: int)`.
- Produces: `chpipe.stages.parse_akn_stage.store_articles(conn, version_id: int, articles: list[akn.Article]) -> int`; `chpipe.stages.parse_akn_stage.run(settings, limit=None) -> ParseReport` with `ParseReport(parsed: int, articles: int, empty: int, failed: int)`.

**Queue:** `ch_act_version.stage` moves `discovered` → `fetched` → `parsed`. Same `claim`/`complete`/`fail` shape as the decisions pipeline, but against `ch_act_version`, so `db.py` gains a table-parameterised variant.

- [ ] **Step 1: Extend the queue helpers for a second table**

Add to `services/ch-pipeline/chpipe/db.py`:

```python
def claim_versions(conn, stage: str, limit: int, max_attempts: int = 3) -> list[dict]:
    """The same queue discipline as claim(), against ch_act_version."""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT version_id, act_id, lang, date_applicability, xml_url, attempts "
            "FROM ch_act_version WHERE stage = %s AND attempts < %s "
            "ORDER BY act_id, date_applicability, lang LIMIT %s FOR UPDATE SKIP LOCKED",
            (stage, max_attempts, limit))
        return cur.fetchall()


def complete_version(conn, version_id: int, next_stage: str, **fields) -> None:
    assignments = ["stage = %s", "last_error = NULL", "updated_at = now()"]
    params: list = [next_stage]
    for column, value in fields.items():
        assignments.append(f"{column} = %s")
        params.append(value)
    params.append(version_id)
    conn.execute(
        f"UPDATE ch_act_version SET {', '.join(assignments)} WHERE version_id = %s",
        params)


def fail_version(conn, version_id: int, error: str, max_attempts: int) -> None:
    conn.execute(
        "UPDATE ch_act_version SET attempts = attempts + 1, last_error = %s, "
        "stage = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE stage END, "
        "updated_at = now() WHERE version_id = %s",
        (error[:2000], max_attempts, version_id))
```

- [ ] **Step 2: Write the failing test**

```python
# services/ch-pipeline/tests/test_parse_akn_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe import akn
from chpipe.stages import acts_stage, parse_akn_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _version(conn, date="2026-01-01"):
    return versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})


def test_stores_every_article_of_the_fixture(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    stored = parse_akn_stage.store_articles(conn, vid, articles)
    assert stored == len(articles)
    assert conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_reparsing_replaces_rather_than_duplicating(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    parse_akn_stage.store_articles(conn, vid, articles)
    assert conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_article_count_is_written_back_onto_the_version(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    assert conn.execute(
        "SELECT article_count FROM ch_act_version WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_two_versions_of_one_act_keep_separate_article_sets(conn):
    v1, v2 = _version(conn, "2020-01-01"), _version(conn, "2026-01-01")
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, v1, articles)
    parse_akn_stage.store_articles(conn, v2, articles)
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == \
        2 * len(articles)


def test_nested_e_ids_survive_the_round_trip(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    nested = conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s AND e_id LIKE %s",
        (vid, "%/%")).fetchone()[0]
    assert nested >= 1
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_parse_akn_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 4: Write the implementations**

```python
# services/ch-pipeline/chpipe/stages/fetch_xml_stage.py
"""Download the Akoma Ntoso XML named by each discovered version.

~170,000 files (56,328 consolidations across three to five languages). The XML
is written to disk AND kept in ch_act_version.akn_xml: the column is what the
diff stage and any future re-parse read, the file is the audit copy.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from .. import db
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

MAX_XML_BYTES = 20_000_000          # the OR at 2.4 MB is a large act, not the limit


@dataclass
class FetchXmlReport:
    fetched: int = 0
    failed: int = 0
    bytes_written: int = 0


def xml_path(settings: Settings, version_id: int) -> "object":
    directory = settings.raw_dir / "legislation" / f"{version_id // 1000:04d}"
    return directory / f"{version_id}.xml"


async def _run_async(settings: Settings, limit: int | None) -> FetchXmlReport:
    report = FetchXmlReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            while True:
                size = 200 if remaining is None else min(200, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(conn, "discovered", limit=size,
                                         max_attempts=settings.max_attempts)
                if not rows:
                    break

                async def one(row) -> None:
                    if not row["xml_url"]:
                        db.fail_version(conn, row["version_id"], "no xml_url",
                                        settings.max_attempts)
                        report.failed += 1
                        return
                    try:
                        payload = await fetcher.bytes(row["xml_url"])
                    except FetchError as exc:
                        db.fail_version(conn, row["version_id"], str(exc),
                                        settings.max_attempts)
                        report.failed += 1
                        return
                    if len(payload) > MAX_XML_BYTES:
                        db.fail_version(conn, row["version_id"],
                                        f"xml is {len(payload)} bytes",
                                        settings.max_attempts)
                        report.failed += 1
                        return
                    path = xml_path(settings, row["version_id"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(payload)
                    db.complete_version(
                        conn, row["version_id"], "fetched",
                        akn_xml=payload.decode("utf-8", errors="replace"),
                        fetched_at=None)
                    conn.execute(
                        "UPDATE ch_act_version SET fetched_at = now() "
                        "WHERE version_id = %s", (row["version_id"],))
                    report.fetched += 1
                    report.bytes_written += len(payload)

                await asyncio.gather(*(one(r) for r in rows))
                if remaining is not None:
                    remaining -= len(rows)
                log.info("xml fetched=%d failed=%d", report.fetched, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None) -> FetchXmlReport:
    return asyncio.run(_run_async(settings, limit))


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d bytes=%d", result.fetched, result.failed,
             result.bytes_written)
```

```python
# services/ch-pipeline/chpipe/stages/parse_akn_stage.py
"""AKN XML -> ch_act_article rows plus a plain-text rendering of the edition."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import akn, db
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ParseReport:
    parsed: int = 0
    articles: int = 0
    empty: int = 0
    failed: int = 0


def store_articles(conn, version_id: int, articles: list[akn.Article]) -> int:
    """Replace this version's articles. Replace rather than upsert: an edition is
    immutable, so a re-parse means the parser changed and the old rows are stale."""
    conn.execute("DELETE FROM ch_act_article WHERE version_id = %s", (version_id,))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO ch_act_article (version_id, e_id, article_number, "
            "marginal_note, text, ordinal, parent_e_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            [(version_id, a.e_id, a.article_number, a.marginal_note, a.text,
              a.ordinal, a.parent_e_id) for a in articles])
    conn.execute("UPDATE ch_act_version SET article_count = %s WHERE version_id = %s",
                 (len(articles), version_id))
    return len(articles)


def run(settings: Settings, limit: int | None = None) -> ParseReport:
    report = ParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            rows = db.claim_versions(conn, "fetched", limit=size,
                                     max_attempts=settings.max_attempts)
            if not rows:
                break
            for row in rows:
                stored = conn.execute(
                    "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                    (row["version_id"],)).fetchone()["akn_xml"]
                if not stored:
                    db.fail_version(conn, row["version_id"], "no akn_xml",
                                    settings.max_attempts)
                    report.failed += 1
                    continue
                payload = stored.encode("utf-8")
                try:
                    articles = akn.parse_articles(payload)
                    text = akn.plain_text(payload)
                except akn.AknParseError as exc:
                    db.fail_version(conn, row["version_id"], f"akn: {exc}",
                                    settings.max_attempts)
                    report.failed += 1
                    continue
                store_articles(conn, row["version_id"], articles)
                db.complete_version(conn, row["version_id"], "parsed", full_text=text)
                report.parsed += 1
                report.articles += len(articles)
                if not articles:
                    report.empty += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("parsed=%d articles=%d empty=%d failed=%d", report.parsed,
                     report.articles, report.empty, report.failed)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d empty=%d failed=%d", result.parsed,
             result.articles, result.empty, result.failed)
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_parse_akn_stage.py -v
```

Expected: 5 passed.

- [ ] **Step 6: Report the empty-article rate after the real run**

```bash
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"SELECT count(*) AS versions,
           count(*) FILTER (WHERE article_count = 0) AS zero_articles,
           round(avg(article_count)) AS mean_articles
      FROM ch_act_version WHERE stage = 'parsed'\""
```

A non-trivial `zero_articles` count is a finding to report, not a rounding error: it means either those editions genuinely repeal everything, or the parser misses a structure the OR does not use. Sample five of them and say which it is.

- [ ] **Step 7: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/fetch_xml_stage.py \
        services/ch-pipeline/chpipe/stages/parse_akn_stage.py \
        services/ch-pipeline/chpipe/db.py \
        services/ch-pipeline/tests/test_parse_akn_stage.py
git commit -m "feat(ch): fetch and parse the akoma ntoso editions"
```

---

### Task 7: The `diff` stage — the change log

**Files:**
- Create: `services/ch-pipeline/chpipe/diff_articles.py`, `services/ch-pipeline/chpipe/stages/diff_stage.py`
- Test: `services/ch-pipeline/tests/test_diff_articles.py`, `services/ch-pipeline/tests/test_diff_stage.py`

**Interfaces:**
- Produces: `chpipe.diff_articles.normalise(text: str) -> str`; `chpipe.diff_articles.fingerprint(text: str) -> str`; `chpipe.diff_articles.Change` frozen dataclass with `e_id: str`, `article_number: str | None`, `change_type: str`; `chpipe.diff_articles.diff(before: list[dict], after: list[dict]) -> list[Change]` where each dict has `e_id`, `article_number`, `text`.
- Produces: `chpipe.stages.diff_stage.run(settings, lang: str = "de", act_id: int | None = None) -> DiffReport` with `DiffReport(acts: int, changes: int, added: int, modified: int, repealed: int)`.

**This is the deliverable of the whole legislation plan.** Fedlex publishes editions, not a change log; the change log is computed here.

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_diff_articles.py
from chpipe import diff_articles as d


def _a(e_id, text, number=None):
    return {"e_id": e_id, "article_number": number or e_id.split("_")[-1], "text": text}


def test_an_unchanged_article_produces_no_change():
    before = [_a("art_1", "Der Vertrag ist gültig.")]
    assert d.diff(before, list(before)) == []


def test_whitespace_only_differences_are_not_changes():
    before = [_a("art_1", "Der  Vertrag\nist gültig.")]
    after = [_a("art_1", "Der Vertrag ist gültig.")]
    assert d.diff(before, after) == []


def test_dash_variants_are_not_changes():
    """En and em dashes both occur inside a single Swiss act; treating a dash
    swap as an amendment would fabricate thousands of them."""
    assert d.diff([_a("art_1", "Art. 111–14 gilt.")],
                  [_a("art_1", "Art. 111—14 gilt.")]) == []


def test_a_real_wording_change_is_modified():
    changes = d.diff([_a("art_1", "Der Vertrag ist gültig.")],
                     [_a("art_1", "Der Vertrag ist nichtig.")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_1", "modified")]


def test_a_new_article_is_added():
    changes = d.diff([_a("art_1", "x")], [_a("art_1", "x"), _a("art_2", "y")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "added")]


def test_a_disappearing_article_is_repealed():
    changes = d.diff([_a("art_1", "x"), _a("art_2", "y")], [_a("art_1", "x")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_an_article_emptied_to_aufgehoben_is_repealed_not_modified():
    changes = d.diff([_a("art_2", "Der Text.")], [_a("art_2", "Aufgehoben")])
    assert [(c.e_id, c.change_type) for c in changes] == [("art_2", "repealed")]


def test_the_french_and_italian_repeal_markers_count_too():
    assert d.diff([_a("art_2", "Le texte.")], [_a("art_2", "Abrogé")])[0].change_type \
        == "repealed"
    assert d.diff([_a("art_2", "Il testo.")], [_a("art_2", "Abrogato")])[0].change_type \
        == "repealed"


def test_articles_sharing_a_number_are_distinguished_by_e_id():
    """'disp_u17/art_7' and 'art_7' are different articles with the same number."""
    before = [_a("art_7", "A", number="7"), _a("disp_u17/art_7", "B", number="7")]
    after = [_a("art_7", "A", number="7"), _a("disp_u17/art_7", "C", number="7")]
    changes = d.diff(before, after)
    assert [(c.e_id, c.change_type) for c in changes] == [("disp_u17/art_7", "modified")]


def test_changes_come_back_in_a_stable_order():
    before = [_a("art_1", "x")]
    after = [_a("art_3", "z"), _a("art_2", "y"), _a("art_1", "x")]
    assert [c.e_id for c in d.diff(before, after)] == ["art_2", "art_3"]


def test_an_empty_before_makes_everything_added():
    changes = d.diff([], [_a("art_1", "x"), _a("art_2", "y")])
    assert {c.change_type for c in changes} == {"added"}
```

```python
# services/ch-pipeline/tests/test_diff_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe.config import Settings
from chpipe.stages import acts_stage, diff_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

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
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _edition(conn, date, articles):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    for ordinal, (e_id, text) in enumerate(articles, start=1):
        conn.execute(
            "INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
            "ordinal) VALUES (%s,%s,%s,%s,%s)",
            (vid, e_id, e_id.split("_")[-1], text, ordinal))
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=%s "
                 "WHERE version_id=%s", (len(articles), vid))
    return vid


def test_the_first_edition_produces_no_changes(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "x")])
    report = diff_stage.run(settings)
    assert report.changes == 0, "there is nothing before the first edition"


def test_a_modified_article_is_recorded_against_the_later_edition(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "Der Vertrag ist gültig.")])
    v2 = _edition(conn, "2022-01-01", [("art_1", "Der Vertrag ist nichtig.")])
    diff_stage.run(settings)
    row = conn.execute(
        "SELECT e_id, change_type, to_version_id, date_applicability "
        "FROM ch_act_change").fetchone()
    assert row[0] == "art_1"
    assert row[1] == "modified"
    assert row[2] == v2
    assert str(row[3]) == "2022-01-01"


def test_three_editions_produce_two_comparisons(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "a")])
    _edition(conn, "2022-01-01", [("art_1", "b")])
    _edition(conn, "2024-01-01", [("art_1", "c")])
    assert diff_stage.run(settings).changes == 2


def test_editions_are_compared_in_date_order_not_insertion_order(conn, settings):
    _edition(conn, "2024-01-01", [("art_1", "late")])
    _edition(conn, "2020-01-01", [("art_1", "early")])
    diff_stage.run(settings)
    row = conn.execute(
        "SELECT date_applicability FROM ch_act_change").fetchone()
    assert str(row[0]) == "2024-01-01", "the change belongs to the later edition"


def test_rerunning_does_not_duplicate_changes(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "a")])
    _edition(conn, "2022-01-01", [("art_1", "b")])
    diff_stage.run(settings)
    diff_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_act_change").fetchone()[0] == 1


def test_languages_are_diffed_separately(conn, settings):
    """A German wording change must not be reported against the French edition."""
    v_de = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2020", "dateApplicability": "2020-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/de.xml"})
    v_fr = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2020", "dateApplicability": "2020-01-01",
        "lang": L + "FRA", "fileUrl": "https://x/fr.xml"})
    for vid, text in ((v_de, "deutsch"), (v_fr, "francais")):
        conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, "
                     "text, ordinal) VALUES (%s,'art_1','1',%s,1)", (vid, text))
        conn.execute("UPDATE ch_act_version SET stage='parsed' WHERE version_id=%s",
                     (vid,))
    assert diff_stage.run(settings, lang="de").changes == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_diff_articles.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.diff_articles'`.

- [ ] **Step 3: Write the implementations**

```python
# services/ch-pipeline/chpipe/diff_articles.py
"""Per-article difference between two consecutive editions of one act.

Comparison is on a normalised fingerprint, not raw text: Fedlex re-typesets
editions, so whitespace and dash variants differ between editions of the same
unchanged article. Both an en dash and an em dash occur inside a single act, and
treating either as an amendment would fabricate changes by the thousand.

Articles are matched on eId, never on article number: verified in the real OR
XML that 'art_7' and 'disp_u17/art_7' coexist with the number 7.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

_WHITESPACE = re.compile(r"\s+")
_DASHES = str.maketrans({"–": "-", "—": "-", "‐": "-", " ": " "})
_QUOTES = str.maketrans({"«": '"', "»": '"', "„": '"', "“": '"', "”": '"',
                         "’": "'", "‘": "'"})

# An edition keeps the article and replaces its body with a repeal marker. That
# is a repeal, not a rewording, and the distinction is the point of the log.
_REPEAL_MARKERS = frozenset({
    "aufgehoben", "abrogé", "abrogée", "abrogato", "abrogata", "abroge",
})


@dataclass(frozen=True)
class Change:
    e_id: str
    article_number: str | None
    change_type: str


def normalise(text: str) -> str:
    folded = unicodedata.normalize("NFC", text or "")
    folded = folded.translate(_DASHES).translate(_QUOTES)
    return _WHITESPACE.sub(" ", folded).strip().lower()


def fingerprint(text: str) -> str:
    return hashlib.sha256(normalise(text).encode("utf-8")).hexdigest()


def _is_repealed(text: str) -> bool:
    stripped = normalise(text).strip(" .")
    return stripped in _REPEAL_MARKERS


def diff(before: list[dict], after: list[dict]) -> list[Change]:
    """Changes that turn `before` into `after`, ordered by eId for stability."""
    old = {a["e_id"]: a for a in before}
    new = {a["e_id"]: a for a in after}
    changes: list[Change] = []

    for e_id in sorted(new.keys() - old.keys()):
        article = new[e_id]
        changes.append(Change(e_id, article.get("article_number"), "added"))

    for e_id in sorted(old.keys() - new.keys()):
        article = old[e_id]
        changes.append(Change(e_id, article.get("article_number"), "repealed"))

    for e_id in sorted(old.keys() & new.keys()):
        old_text, new_text = old[e_id].get("text", ""), new[e_id].get("text", "")
        if fingerprint(old_text) == fingerprint(new_text):
            continue
        kind = "repealed" if (_is_repealed(new_text) and not _is_repealed(old_text)) \
            else "modified"
        changes.append(Change(e_id, new[e_id].get("article_number"), kind))

    return sorted(changes, key=lambda c: (c.e_id,))
```

```python
# services/ch-pipeline/chpipe/stages/diff_stage.py
"""Walk each act's editions in date order and write the change log.

Fedlex publishes editions, not amendments. ch_act_change is computed here, and
it is the answer to "which article changed, when" — the question the flat table
could not express at all.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, diff_articles
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class DiffReport:
    acts: int = 0
    comparisons: int = 0
    changes: int = 0
    added: int = 0
    modified: int = 0
    repealed: int = 0


def _articles(conn, version_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT e_id, article_number, text FROM ch_act_article "
        "WHERE version_id = %s ORDER BY ordinal", (version_id,)).fetchall()]


def run(settings: Settings, lang: str = "de", act_id: int | None = None) -> DiffReport:
    report = DiffReport()
    conn = db.connect(settings)
    try:
        sql = ("SELECT DISTINCT act_id FROM ch_act_version "
               "WHERE lang = %s AND stage = 'parsed'")
        params: list = [lang]
        if act_id is not None:
            sql += " AND act_id = %s"
            params.append(act_id)
        sql += " ORDER BY act_id"
        acts = [r["act_id"] for r in conn.execute(sql, params).fetchall()]

        for current_act in acts:
            versions = conn.execute(
                "SELECT version_id, date_applicability FROM ch_act_version "
                "WHERE act_id = %s AND lang = %s AND stage = 'parsed' "
                "ORDER BY date_applicability, version_id",
                (current_act, lang)).fetchall()
            report.acts += 1
            previous = None
            for version in versions:
                if previous is None:
                    previous = version
                    continue
                changes = diff_articles.diff(_articles(conn, previous["version_id"]),
                                             _articles(conn, version["version_id"]))
                report.comparisons += 1
                for change in changes:
                    conn.execute(
                        """
                        INSERT INTO ch_act_change
                            (act_id, lang, from_version_id, to_version_id, e_id,
                             article_number, change_type, date_applicability)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (to_version_id, e_id, change_type) DO NOTHING
                        """,
                        (current_act, lang, previous["version_id"],
                         version["version_id"], change.e_id, change.article_number,
                         change.change_type, version["date_applicability"]))
                    report.changes += 1
                    setattr(report, change.change_type,
                            getattr(report, change.change_type) + 1)
                previous = version
            if report.acts % 200 == 0:
                log.info("acts=%d changes=%d", report.acts, report.changes)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(), lang=os.environ.get("CHPIPE_LANG", "de"))
    log.info("acts=%d comparisons=%d changes=%d (added=%d modified=%d repealed=%d)",
             result.acts, result.comparisons, result.changes, result.added,
             result.modified, result.repealed)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_diff_articles.py -v
CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_diff_stage.py -v
```

Expected: 11 passed, then 6 passed.

- [ ] **Step 5: Sanity-check the diff against a known amendment**

A change log that is technically consistent but wrong is the worst outcome here. Check it against an amendment whose date is independently known.

```bash
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"SELECT c.date_applicability, c.article_number, c.change_type
      FROM ch_act_change c JOIN ch_act a USING (act_id)
     WHERE a.sr_number = '220' AND c.lang = 'de'
     ORDER BY c.date_applicability DESC, c.article_number LIMIT 20;
    SELECT change_type, count(*) FROM ch_act_change c JOIN ch_act a USING (act_id)
     WHERE a.sr_number = '220' GROUP BY 1\""
```

Then open the corresponding edition on fedlex.admin.ch and confirm that at least three of the listed articles really changed on that date. If the log shows an implausible volume — say every article of the OR "modified" on one date — that is re-typesetting leaking through the fingerprint, and `normalise()` needs another fold before this stage is run at scale. Report which it is.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/diff_articles.py \
        services/ch-pipeline/chpipe/stages/diff_stage.py \
        services/ch-pipeline/tests/test_diff_articles.py \
        services/ch-pipeline/tests/test_diff_stage.py
git commit -m "feat(ch): compute the per-article amendment log"
```

---

### Task 8: The `ch_legislation` projection and Gate E

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/project_legacy_stage.py`, `services/ch-pipeline/chpipe/reports_leg.py`
- Test: `services/ch-pipeline/tests/test_project_legacy_stage.py`, `services/ch-pipeline/tests/test_reports_leg.py`

**Interfaces:**
- Produces: `chpipe.stages.project_legacy_stage.run(settings) -> int` returning rows written.
- Produces: `chpipe.reports_leg.gate_e(conn, sr_numbers: list[str]) -> list[dict]`; `chpipe.reports_leg.corpus_summary(conn) -> dict`.

**Behaviour:** `ch_legislation` keeps working, now as a projection of the new tables holding the latest in-force edition per act in de/fr/it — with the **correct** `sr_number`, which is a deliberate change of meaning for that column.

- [ ] **Step 1: Write the failing tests**

```python
# services/ch-pipeline/tests/test_project_legacy_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe.config import Settings
from chpipe.stages import acts_stage, project_legacy_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

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
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
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
        acts_stage.upsert_act(c, {
            "work": WORK, "srNotation": "220",
            "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"})
        acts_stage.apply_titles(c, [
            {"work": WORK, "lang": L + "DEU", "title": "Obligationenrecht",
             "titleShort": "OR"}])
        yield c


def _edition(conn, date, text, lang="DEU"):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + lang, "fileUrl": f"https://x/{date}.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', full_text=%s "
                 "WHERE version_id=%s", (text, vid))
    return vid


def test_projects_the_latest_edition(conn, settings):
    _edition(conn, "2020-01-01", "alte Fassung")
    _edition(conn, "2026-01-01", "neue Fassung")
    assert project_legacy_stage.run(settings) == 1
    row = conn.execute(
        "SELECT version_date, full_text FROM ch_legislation WHERE lang='de'").fetchone()
    assert str(row[0]) == "2026-01-01"
    assert row[1] == "neue Fassung"


def test_the_sr_number_column_now_holds_the_real_sr_number(conn, settings):
    """Deliberate change of meaning: this column used to hold an ELI fragment."""
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert conn.execute(
        "SELECT sr_number FROM ch_legislation").fetchone()[0] == "220"


def test_in_force_is_populated_rather_than_null(conn, settings):
    """Every one of the 5,594 rows in the old table had in_force NULL."""
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert conn.execute("SELECT in_force FROM ch_legislation").fetchone()[0] is True


def test_the_title_and_short_title_come_from_the_act(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    row = conn.execute("SELECT title, short_title FROM ch_legislation").fetchone()
    assert row == ("Obligationenrecht", "OR")


def test_each_language_gets_its_own_row(conn, settings):
    _edition(conn, "2026-01-01", "de text", lang="DEU")
    _edition(conn, "2026-01-01", "fr text", lang="FRA")
    assert project_legacy_stage.run(settings) == 2
    langs = {r[0] for r in conn.execute("SELECT lang FROM ch_legislation").fetchall()}
    assert langs == {"de", "fr"}


def test_rerunning_replaces_rather_than_duplicating(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    project_legacy_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_legislation").fetchone()[0] == 1
```

```python
# services/ch-pipeline/tests/test_reports_leg.py
import os
import pathlib
import psycopg
import pytest
from chpipe import reports_leg
from chpipe.stages import acts_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        yield c


def test_gate_e_reports_a_control_act_that_is_missing(conn):
    rows = reports_leg.gate_e(conn, ["220"])
    assert rows[0]["sr_number"] == "220"
    assert rows[0]["found"] is False


def test_gate_e_counts_editions_articles_and_changes(conn):
    act_id = acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    for date in ("2020-01-01", "2026-01-01"):
        vid = versions_stage.upsert_version(conn, {
            "work": WORK, "consolidation": f"{WORK}/{date}",
            "dateApplicability": date, "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
        conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=3 "
                     "WHERE version_id=%s", (vid,))
        for i in range(3):
            conn.execute("INSERT INTO ch_act_article (version_id, e_id, "
                         "article_number, text, ordinal) VALUES (%s,%s,%s,'t',%s)",
                         (vid, f"art_{i}", str(i), i))
        conn.execute("INSERT INTO ch_act_change (act_id, to_version_id, e_id, "
                     "change_type, date_applicability) VALUES (%s,%s,'art_1',"
                     "'modified',%s)", (act_id, vid, date))
    row = reports_leg.gate_e(conn, ["220"])[0]
    assert row["found"] is True
    assert row["editions_de"] == 2
    assert row["articles_latest"] == 3
    assert row["changes"] == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_project_legacy_stage.py tests/test_reports_leg.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementations**

```python
# services/ch-pipeline/chpipe/stages/project_legacy_stage.py
"""Rebuild ch_legislation as a projection of the new tables.

Nothing in mcp_backend, lexwebapp or platform references this table (verified by
a word-boundary grep on 2026-08-23; the earlier "47 references" figure was a
substring artefact of `search_legislation`). It is kept so external notebooks
and audits keep working — but its sr_number column now holds the real SR number
instead of an ELI fragment, which is a deliberate change of meaning.
"""
from __future__ import annotations

import logging

from .. import db
from ..config import Settings

log = logging.getLogger(__name__)

_PROJECT = """
INSERT INTO ch_legislation
    (eli_uri, lang, sr_number, title, short_title, version_date, in_force,
     date_entry_force, date_end_validity, akn_xml, full_text, xml_url,
     source, metadata_json, updated_at)
SELECT a.eli_work_uri,
       v.lang,
       a.sr_number,
       CASE v.lang WHEN 'de' THEN a.title_de WHEN 'fr' THEN a.title_fr
                   WHEN 'it' THEN a.title_it WHEN 'en' THEN a.title_en
                   ELSE a.title_rm END,
       a.abbreviation,
       v.date_applicability,
       a.in_force,
       a.date_entry_force,
       a.date_no_longer_in_force,
       v.akn_xml,
       v.full_text,
       v.xml_url,
       'fedlex',
       jsonb_build_object('act_id', a.act_id, 'version_id', v.version_id,
                          'projected_from', 'ch_act_version'),
       now()
  FROM ch_act a
  JOIN LATERAL (
        SELECT * FROM ch_act_version vv
         WHERE vv.act_id = a.act_id AND vv.stage = 'parsed'
         ORDER BY vv.lang, vv.date_applicability DESC
      ) v ON TRUE
 WHERE v.version_id IN (
        SELECT DISTINCT ON (act_id, lang) version_id FROM ch_act_version
         WHERE stage = 'parsed' ORDER BY act_id, lang, date_applicability DESC)
ON CONFLICT (eli_uri, lang) DO UPDATE SET
    sr_number       = EXCLUDED.sr_number,
    title           = EXCLUDED.title,
    short_title     = EXCLUDED.short_title,
    version_date    = EXCLUDED.version_date,
    in_force        = EXCLUDED.in_force,
    date_entry_force = EXCLUDED.date_entry_force,
    date_end_validity = EXCLUDED.date_end_validity,
    akn_xml         = EXCLUDED.akn_xml,
    full_text       = EXCLUDED.full_text,
    xml_url         = EXCLUDED.xml_url,
    metadata_json   = EXCLUDED.metadata_json,
    updated_at      = now()
"""


def run(settings: Settings) -> int:
    conn = db.connect(settings)
    try:
        written = conn.execute(_PROJECT).rowcount
        log.info("projected %d rows into ch_legislation", written)
        return written
    finally:
        conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    print(run(Settings.from_env()))
```

```python
# services/ch-pipeline/chpipe/reports_leg.py
"""Gate E: control acts whose expected shape is independently known."""
from __future__ import annotations

# SR 220 Code of Obligations, SR 210 Civil Code, SR 311.0 Criminal Code.
CONTROL_ACTS = ["220", "210", "311.0"]


def gate_e(conn, sr_numbers: list[str] | None = None) -> list[dict]:
    out: list[dict] = []
    for sr in (sr_numbers or CONTROL_ACTS):
        act = conn.execute(
            "SELECT act_id, title_de, in_force FROM ch_act WHERE sr_number = %s "
            "ORDER BY act_id LIMIT 1", (sr,)).fetchone()
        if not act:
            out.append({"sr_number": sr, "found": False})
            continue
        editions = conn.execute(
            "SELECT count(*) AS n FROM ch_act_version "
            "WHERE act_id = %s AND lang = 'de' AND stage = 'parsed'",
            (act["act_id"],)).fetchone()["n"]
        latest = conn.execute(
            "SELECT article_count FROM ch_act_version WHERE act_id = %s AND lang='de' "
            "AND stage = 'parsed' ORDER BY date_applicability DESC LIMIT 1",
            (act["act_id"],)).fetchone()
        changes = conn.execute(
            "SELECT count(*) AS n FROM ch_act_change WHERE act_id = %s",
            (act["act_id"],)).fetchone()["n"]
        out.append({
            "sr_number": sr, "found": True, "title": act["title_de"],
            "in_force": act["in_force"], "editions_de": editions,
            "articles_latest": latest["article_count"] if latest else None,
            "changes": changes,
        })
    return out


def corpus_summary(conn) -> dict:
    row = conn.execute("""
        SELECT (SELECT count(*) FROM ch_act)                                AS acts,
               (SELECT count(*) FROM ch_act WHERE in_force)                 AS in_force,
               (SELECT count(*) FROM ch_act WHERE sr_number IS NOT NULL)    AS with_sr,
               (SELECT count(*) FROM ch_act_version)                        AS versions,
               (SELECT count(*) FROM ch_act_version WHERE stage='parsed')   AS parsed,
               (SELECT count(*) FROM ch_act_article)                        AS articles,
               (SELECT count(*) FROM ch_act_change)                         AS changes
    """).fetchone()
    return dict(row)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_project_legacy_stage.py tests/test_reports_leg.py -v
```

Expected: 6 passed, then 2 passed.

- [ ] **Step 5: Run Gate E on prod against the live Fedlex counts**

The gate is only meaningful if our edition count is checked against Fedlex's own.

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && python3 - <<'PY'
import json
from chpipe.config import Settings
from chpipe import db, reports_leg
from chpipe.sparql import SparqlClient
from chpipe import fedlex_queries as fq

conn = db.connect(Settings.from_env())
print(json.dumps(reports_leg.corpus_summary(conn), indent=2, default=str))

client = SparqlClient(fq.ENDPOINT)
for row in reports_leg.gate_e(conn):
    if not row['found']:
        print('MISSING', row['sr_number']); continue
    theirs = client.select('''
      PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
        ?ca a jolux:ConsolidationAbstract ;
            jolux:classifiedByTaxonomyEntry/skos:notation \"%s\"^^<https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique> .
        ?c a jolux:Consolidation ; jolux:isMemberOf ?ca .
      }''' % row['sr_number'])[0]['n']
    print(f\"SR {row['sr_number']}: ours={row['editions_de']} fedlex={theirs} \"
          f\"articles={row['articles_latest']} changes={row['changes']}\")
PY"
```

Expected: for each control act, `ours` equals `fedlex`, `articles` is plausible (the OR has 1,686 in the German 2026-01-01 edition) and `changes` is greater than zero. Report the three lines verbatim. A mismatch is a finding, not a rounding difference.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/project_legacy_stage.py \
        services/ch-pipeline/chpipe/reports_leg.py \
        services/ch-pipeline/tests/test_project_legacy_stage.py \
        services/ch-pipeline/tests/test_reports_leg.py
git commit -m "feat(ch): project the new corpus back into ch_legislation, plus gate E"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 6.2 `ch_act` | Task 1 |
| 6.2 `ch_act_version` | Task 1 |
| 6.2 `ch_act_article` | Task 1 |
| 6.2 `ch_act_change` | Task 1 |
| 6.3 `ch_legislation` compatibility | Task 8 |
| 7.7 `sparql-acts` | Task 3 |
| 7.8 `sparql-versions` | Task 4 |
| 7.9 `fetch-xml` | Task 6 |
| 7.10 `parse-akn` | Tasks 5, 6 |
| 7.11 `diff` | Task 7 |
| 9 Gate E | Task 8 step 5 |
| 6.2 `ch_as_act`, `ch_act_as_link` | **Plan 3** |
| 7.12 `as-bbl` | **Plan 3** |
| 10 deltas | **Plan 3** |

**Placeholders:** none.

**Type consistency:** `fedlex_queries.status_code` and `.language_code` are defined in Task 2 and used in Tasks 3 and 4 under those names. `db.claim_versions` / `db.complete_version` / `db.fail_version` are added in Task 6 step 1 and used in Task 6's two stages under those exact names. `akn.Article` field names (`e_id`, `article_number`, `marginal_note`, `text`, `ordinal`, `parent_e_id`) match the columns written by `parse_akn_stage.store_articles` and the dict keys read by `diff_articles.diff`. `diff_articles.Change` fields (`e_id`, `article_number`, `change_type`) match the insert in `diff_stage`. `ENFORCEMENT_STATUS_IN_FORCE` is defined once and asserted in a test.

**One divergence from the spec, recorded deliberately:** the spec's section 6.2 assumed three languages. Fedlex serves five (DEU, FRA, ITA, ENG, ROH), so `ch_act` carries `title_en` and `title_rm` as well. The spec's migration number 196 for legislation is split into 196 (decisions) and 197 (legislation) so the two plans can land independently.
