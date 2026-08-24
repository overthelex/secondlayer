# CH AS/BBl Corpus and Delta Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Official Compilation and Federal Gazette (211,637 acts) to the Swiss corpus, attach amendment provenance to individual articles, and put both the decisions and the legislation corpora on a daily delta so they stop rotting the day the backfill ends.

**Architecture:** Two more discovery stages over the same SPARQL client, one parser over the Akoma Ntoso footnotes already downloaded by Plan 2, and a delta runner that reuses every stage from Plans 1 and 2 with a narrower claim.

**Tech Stack:** As Plans 1 and 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-ch-corpus-pipeline-design.md`

**Depends on:** `2026-08-23-ch-decisions-pipeline.md` (all tasks) and `2026-08-23-ch-legislation-pipeline.md` (all tasks). Task 4 in particular reads `ch_act_version.akn_xml`, which Plan 2 Task 6 populates.

## Global Constraints

Everything from the two earlier plans applies. Additionally:

- **Migration number 198** is reserved for this plan.
- **⚠ Fedlex publishes no "amends" relation.** Verified 2026-08-23 by enumerating every predicate on `jolux:Act` and on `jolux:ConsolidationAbstract`. There is no `changes`, no `amends`, no `modifies`. What exists is:
  - `jolux:basicAct` on `ConsolidationAbstract` — **17,055** links (re-measured 2026-08-24; the 69,190 recorded here on 2026-08-23 does not reproduce and is almost certainly a count of `jolux:ConsolidationAbstract` instances, which measures 69,495), pointing from a Classified Compilation entry to the Official Compilation act that established it. Verified for SR 220: `eli/cc/27/317_321_377 → eli/oc/27/317_321_377`.
  - `jolux:rectifies` — 343 occurrences.
  - `jolux:isFollowingAct` — 414 occurrences.
  So the amendment chain cannot be read out of the graph. It comes from two places instead: the computed change log from Plan 2 Task 7, and the Akoma Ntoso footnotes parsed in Task 4 here. Any claim that the graph gives us amendments is false; do not build one.
- **Do not re-download the AKN XML.** Task 4 parses `ch_act_version.akn_xml`, already on disk and in the database from Plan 2. Re-fetching 170,000 files to read their footnotes would be pointless load on Fedlex.
- **211,637 acts is the largest single stage in the whole corpus.** (The 369,181 recorded on 2026-08-23 is `COUNT(*)` over `?a a jolux:Act`, a raw triple count; `COUNT(DISTINCT ?a)` over the same pattern is 211,637. Both re-measured 2026-08-24.) It runs last so nothing more useful waits behind it.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp_backend/src/migrations/198_ch_as_bbl.sql` | `ch_as_act`, `ch_act_amendment_link`, `ch_article_provenance` |
| `services/ch-pipeline/chpipe/amendment_notes.py` | Akoma Ntoso footnote prose → structured provenance (pure) |
| `services/ch-pipeline/chpipe/stages/as_bbl_stage.py` | Discovery of `jolux:Act` into `ch_as_act` |
| `services/ch-pipeline/chpipe/stages/basic_act_stage.py` | `jolux:basicAct` links into `ch_act_amendment_link` |
| `services/ch-pipeline/chpipe/stages/provenance_stage.py` | Footnotes → `ch_article_provenance` |
| `services/ch-pipeline/chpipe/delta.py` | Daily delta for both corpora |
| `services/ch-pipeline/run-delta.sh` | Cron entry point |

---

### Task 1: Migration — AS/BBl and provenance tables

**Files:**
- Create: `mcp_backend/src/migrations/198_ch_as_bbl.sql`
- Test: `services/ch-pipeline/tests/test_migration_198.py`

**Interfaces:**
- Produces: tables `ch_as_act`, `ch_act_amendment_link`, `ch_article_provenance`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_migration_198.py
import os
import pathlib
import psycopg
import pytest

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
M198 = pathlib.Path("mcp_backend/src/migrations/198_ch_as_bbl.sql")

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_article_provenance", "ch_act_amendment_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        yield c


def test_creates_the_three_tables(conn):
    for t in ("ch_as_act", "ch_act_amendment_link", "ch_article_provenance"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]


def test_as_act_is_unique_by_eli(conn):
    conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/1','AS')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/1','AS')")


def test_collection_is_constrained_to_as_and_bbl(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/2','SR')")


def test_amendment_link_records_the_relation_type(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    conn.execute("INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type) "
                 "VALUES (1,1,'basic_act')")
    assert conn.execute(
        "SELECT relation_type FROM ch_act_amendment_link").fetchone()[0] == "basic_act"


def test_amendment_link_rejects_an_unknown_relation_type(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type) "
                     "VALUES (1,1,'amends_probably')")


def test_amendment_link_is_unique_per_triple(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    conn.execute("INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type) "
                 "VALUES (1,1,'basic_act')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type) "
                     "VALUES (1,1,'basic_act')")


def test_provenance_keeps_the_raw_note_alongside_the_parse(conn):
    """The parse is a best effort over prose; keeping the source text is what
    makes a wrong parse detectable later."""
    cols = {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='ch_article_provenance'").fetchall()}
    assert {"version_id", "e_id", "action", "as_reference", "bbl_reference",
            "effective_date", "source_act_date", "raw_note"} <= cols


def test_provenance_action_is_constrained(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, "
                 "eli_consolidation_uri, lang, date_applicability) "
                 "VALUES (1,1,'https://cc/1/2020','de','2020-01-01')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, action, "
                     "raw_note) VALUES (1,'art_1','tweaked','x')")


def test_is_idempotent(conn):
    conn.execute(M198.read_text())
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_migration_198.py -v
```

Expected: FAIL — the migration does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- mcp_backend/src/migrations/198_ch_as_bbl.sql
-- Official Compilation (AS/RO) and Federal Gazette (BBl/FF), plus the amendment
-- provenance that Fedlex does NOT publish as a relation.
--
-- Verified 2026-08-23: neither jolux:Act nor jolux:ConsolidationAbstract carries
-- an "amends" predicate. jolux:basicAct (17,055 links) points from a Classified
-- Compilation entry to the Official Compilation act that established it, and
-- that is the only structured link there is. The per-article amendment history
-- is recovered from the Akoma Ntoso footnotes instead — see ch_article_provenance.

CREATE TABLE IF NOT EXISTS public.ch_as_act (
    as_id            bigserial PRIMARY KEY,
    eli_uri          text NOT NULL,
    collection       text NOT NULL,
    publication_date date,
    date_document    date,
    date_entry_force date,
    title_de         text,
    title_fr         text,
    title_it         text,
    document_type    text,
    xml_url          text,
    pdf_url          text,
    metadata_json    jsonb,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ch_as_act_collection_chk CHECK (collection IN ('AS', 'BBl'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_as_act_eli ON public.ch_as_act (eli_uri);
CREATE INDEX IF NOT EXISTS idx_ch_as_act_published
    ON public.ch_as_act (collection, publication_date);

CREATE TABLE IF NOT EXISTS public.ch_act_amendment_link (
    link_id       bigserial PRIMARY KEY,
    act_id        bigint NOT NULL REFERENCES public.ch_act(act_id) ON DELETE CASCADE,
    as_id         bigint NOT NULL REFERENCES public.ch_as_act(as_id) ON DELETE CASCADE,
    -- 'basic_act'  : jolux:basicAct, the act that established this CC entry
    -- 'rectifies'  : jolux:rectifies
    -- 'follows'    : jolux:isFollowingAct
    relation_type text NOT NULL,
    CONSTRAINT ch_amendment_relation_chk
        CHECK (relation_type IN ('basic_act', 'rectifies', 'follows'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ch_act_amendment_link
    ON public.ch_act_amendment_link (act_id, as_id, relation_type);

CREATE TABLE IF NOT EXISTS public.ch_article_provenance (
    provenance_id   bigserial PRIMARY KEY,
    version_id      bigint NOT NULL REFERENCES public.ch_act_version(version_id)
                        ON DELETE CASCADE,
    e_id            text NOT NULL,
    -- Parsed from prose, so it is a best effort. raw_note is kept so a wrong
    -- parse stays detectable instead of becoming invisible fact.
    action          text,
    as_reference    text,
    bbl_reference   text,
    effective_date  date,
    source_act_date date,
    raw_note        text NOT NULL,
    CONSTRAINT ch_provenance_action_chk
        CHECK (action IS NULL OR action IN ('inserted', 'amended', 'repealed'))
);

CREATE INDEX IF NOT EXISTS idx_ch_provenance_version
    ON public.ch_article_provenance (version_id, e_id);
CREATE INDEX IF NOT EXISTS idx_ch_provenance_as
    ON public.ch_article_provenance (as_reference)
    WHERE as_reference IS NOT NULL;

COMMENT ON TABLE public.ch_article_provenance IS
    'Amendment provenance recovered from Akoma Ntoso authorialNote prose, e.g. '
    '"Eingefuegt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit 1. Juli 1991 '
    '(AS 1991 846; BBl 1986 II 354)". Fedlex publishes no amends relation.';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_migration_198.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add mcp_backend/src/migrations/198_ch_as_bbl.sql \
        services/ch-pipeline/tests/test_migration_198.py
git commit -m "feat(ch): AS/BBl and article provenance schema"
```

---

### Task 2: The amendment-note parser

**Files:**
- Create: `services/ch-pipeline/chpipe/amendment_notes.py`
- Test: `services/ch-pipeline/tests/test_amendment_notes.py`

**Interfaces:**
- Produces: `chpipe.amendment_notes.Provenance` frozen dataclass with `e_id: str`, `action: str | None`, `as_reference: str | None`, `bbl_reference: str | None`, `effective_date: datetime.date | None`, `source_act_date: datetime.date | None`, `raw_note: str`.
- Produces: `chpipe.amendment_notes.extract(xml: bytes, lang: str = "de") -> list[Provenance]`; `chpipe.amendment_notes.parse_note(text: str, lang: str = "de") -> dict`.

**Verified source material** (captured 2026-08-23 from the OR, German, edition 2026-01-01): 944 `<authorialNote>` elements, of which 836 sit inside an `<article>`, 889 contain an `AS YYYY N` reference and 689 contain "in Kraft seit". The notes carry no `eId`, so the owning article is found by walking up the tree. Not every note is an amendment note — `SR 943.03` is a plain cross-reference and must not be recorded as provenance.

Real examples to parse:

```
Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit 1. Juli 1991 (AS 1991 846; BBl 1986 II 354).
Aufgehoben durch Anhang Ziff. 2 des BG vom 19. Dez. 2003 über die elektronische Signatur, mit Wirkung seit 1. Jan. 2005 (AS 2004 5085; BBl 2001 5679).
BBl 1905 II 1, 1909 III 725, 1911 I 845
SR 943.03
```

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_amendment_notes.py
import datetime
import pathlib
from chpipe import amendment_notes as an

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"

INSERTED = ("Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit "
            "1. Juli 1991 (AS 1991 846; BBl 1986 II 354).")
REPEALED = ("Aufgehoben durch Anhang Ziff. 2 des BG vom 19. Dez. 2003 über die "
            "elektronische Signatur, mit Wirkung seit 1. Jan. 2005 "
            "(AS 2004 5085; BBl 2001 5679).")
AMENDED = ("Fassung gemäss Ziff. I des BG vom 18. Juni 1993, in Kraft seit "
           "1. Juli 1994 (AS 1994 1359; BBl 1992 II 1).")


def test_eingefuegt_is_inserted():
    assert an.parse_note(INSERTED)["action"] == "inserted"


def test_aufgehoben_is_repealed():
    assert an.parse_note(REPEALED)["action"] == "repealed"


def test_fassung_gemaess_is_amended():
    assert an.parse_note(AMENDED)["action"] == "amended"


def test_extracts_the_as_reference():
    assert an.parse_note(INSERTED)["as_reference"] == "AS 1991 846"


def test_extracts_the_bbl_reference():
    assert an.parse_note(INSERTED)["bbl_reference"] == "BBl 1986 II 354"


def test_reads_in_kraft_seit_as_the_effective_date():
    assert an.parse_note(INSERTED)["effective_date"] == datetime.date(1991, 7, 1)


def test_reads_mit_wirkung_seit_as_the_effective_date():
    assert an.parse_note(REPEALED)["effective_date"] == datetime.date(2005, 1, 1)


def test_reads_the_date_of_the_amending_act():
    assert an.parse_note(INSERTED)["source_act_date"] == datetime.date(1990, 10, 5)


def test_abbreviated_months_are_understood():
    """Swiss notes abbreviate: Okt., Dez., Jan. — and spell out Juli, März."""
    for text, expected in (
        ("in Kraft seit 1. Okt. 2001", datetime.date(2001, 10, 1)),
        ("in Kraft seit 1. Dez. 2001", datetime.date(2001, 12, 1)),
        ("in Kraft seit 1. März 2001", datetime.date(2001, 3, 1)),
        ("in Kraft seit 15. Febr. 2001", datetime.date(2001, 2, 15)),
    ):
        assert an.parse_note(text)["effective_date"] == expected


def test_a_plain_cross_reference_is_not_provenance():
    """'SR 943.03' is a pointer to another act, not an amendment."""
    parsed = an.parse_note("SR 943.03")
    assert parsed["action"] is None
    assert parsed["as_reference"] is None


def test_a_publication_footnote_is_not_provenance():
    parsed = an.parse_note("BBl 1905 II 1, 1909 III 725, 1911 I 845")
    assert parsed["action"] is None


def test_extract_attaches_notes_to_their_owning_article():
    rows = an.extract(FIXTURE.read_bytes())
    assert rows, "the fixture must contain at least one amendment note"
    assert all(r.e_id for r in rows)
    assert all(r.raw_note for r in rows)


def test_extract_drops_notes_that_are_not_amendments():
    rows = an.extract(FIXTURE.read_bytes())
    assert all(r.action or r.as_reference for r in rows), \
        "a row with neither an action nor an AS reference is not provenance"


def test_french_notes_are_understood():
    fr = ("Introduit par le ch. I de la LF du 5 oct. 1990, en vigueur depuis le "
          "1er juil. 1991 (RO 1991 846; FF 1986 II 354).")
    parsed = an.parse_note(fr, lang="fr")
    assert parsed["action"] == "inserted"
    assert parsed["as_reference"] == "RO 1991 846"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_amendment_notes.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.amendment_notes'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/amendment_notes.py
"""Amendment provenance from Akoma Ntoso footnotes.

Fedlex publishes no "amends" relation — verified by enumerating every predicate
on jolux:Act and jolux:ConsolidationAbstract on 2026-08-23. What it does publish
is the traditional Swiss footnote, in prose, attached to the amended article:

    Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit 1. Juli 1991
    (AS 1991 846; BBl 1986 II 354).

This module turns that prose into rows. It is a best effort over natural
language, so every row keeps its raw_note; a parse that silently drops the
source text is a parse nobody can audit.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

from lxml import etree

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
_AKN = "{%s}" % AKN_NS

# German (AS/BBl) and the French and Italian equivalents (RO/FF, RU/FF).
_AS_REFERENCE = re.compile(r"\b(AS|RO|RU)\s+(\d{4}\s+\d+)")
_BBL_REFERENCE = re.compile(r"\b(BBl|FF|FF)\s+(\d{4}\s+[IVX]+\s+\d+|\d{4}\s+\d+)")

_ACTIONS = {
    "de": [("inserted", re.compile(r"\bEingefügt\b", re.I)),
           ("repealed", re.compile(r"\bAufgehoben\b", re.I)),
           ("amended", re.compile(r"\bFassung gemäss\b", re.I))],
    "fr": [("inserted", re.compile(r"\bIntroduit\b", re.I)),
           ("repealed", re.compile(r"\bAbrogé", re.I)),
           ("amended", re.compile(r"\bNouvelle teneur selon\b", re.I))],
    "it": [("inserted", re.compile(r"\bIntrodotto\b", re.I)),
           ("repealed", re.compile(r"\bAbrogato\b", re.I)),
           ("amended", re.compile(r"\bNuovo testo giusta\b", re.I))],
}

_MONTHS = {
    "jan": 1, "januar": 1, "janv": 1, "janvier": 1, "gennaio": 1, "genn": 1,
    "feb": 2, "febr": 2, "februar": 2, "février": 2, "fév": 2, "febbraio": 2,
    "mär": 3, "märz": 3, "mars": 3, "marzo": 3, "mar": 3,
    "apr": 4, "april": 4, "avril": 4, "aprile": 4, "avr": 4,
    "mai": 5, "maggio": 5, "magg": 5,
    "jun": 6, "juni": 6, "juin": 6, "giugno": 6, "giu": 6,
    "jul": 7, "juli": 7, "juil": 7, "juillet": 7, "luglio": 7, "lug": 7,
    "aug": 8, "august": 8, "août": 8, "agosto": 8, "ago": 8,
    "sep": 9, "sept": 9, "september": 9, "septembre": 9, "settembre": 9, "set": 9,
    "okt": 10, "oktober": 10, "oct": 10, "octobre": 10, "ottobre": 10, "ott": 10,
    "nov": 11, "november": 11, "novembre": 11,
    "dez": 12, "dezember": 12, "déc": 12, "décembre": 12, "dicembre": 12, "dic": 12,
}

_DATE = re.compile(
    r"(\d{1,2})(?:er)?\.?\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})", re.UNICODE)

_EFFECTIVE = re.compile(
    r"(?:in\s+Kraft\s+seit|mit\s+Wirkung\s+seit|en\s+vigueur\s+depuis(?:\s+le)?|"
    r"con\s+effetto\s+dal?|in\s+vigore\s+dal)\s*(.{0,40})", re.I | re.S)

_SOURCE_ACT = re.compile(
    r"(?:vom|du|del)\s+(\d{1,2}(?:er)?\.?\s+[A-Za-zÀ-ÿ]+\.?\s+\d{4})", re.I)


@dataclass(frozen=True)
class Provenance:
    e_id: str
    action: str | None
    as_reference: str | None
    bbl_reference: str | None
    effective_date: datetime.date | None
    source_act_date: datetime.date | None
    raw_note: str


def _parse_date(fragment: str | None) -> datetime.date | None:
    if not fragment:
        return None
    match = _DATE.search(fragment)
    if not match:
        return None
    day, month_word, year = match.groups()
    month = _MONTHS.get(month_word.strip(".").lower())
    if not month:
        return None
    try:
        return datetime.date(int(year), month, int(day))
    except ValueError:
        return None


def parse_note(text: str, lang: str = "de") -> dict:
    note = " ".join((text or "").split())

    action = None
    for name, pattern in _ACTIONS.get(lang, _ACTIONS["de"]):
        if pattern.search(note):
            action = name
            break

    as_match = _AS_REFERENCE.search(note)
    bbl_match = _BBL_REFERENCE.search(note)

    effective = _EFFECTIVE.search(note)
    source = _SOURCE_ACT.search(note)

    return {
        "action": action,
        "as_reference": (f"{as_match.group(1)} {' '.join(as_match.group(2).split())}"
                         if as_match else None),
        "bbl_reference": (f"{bbl_match.group(1)} {' '.join(bbl_match.group(2).split())}"
                          if bbl_match else None),
        "effective_date": _parse_date(effective.group(1)) if effective else None,
        "source_act_date": _parse_date(source.group(1)) if source else None,
        "raw_note": note,
    }


def _owning_article(element) -> str | None:
    parent = element.getparent()
    while parent is not None:
        if parent.tag == _AKN + "article":
            return parent.get("eId")
        parent = parent.getparent()
    return None


def extract(xml: bytes, lang: str = "de") -> list[Provenance]:
    """Amendment notes attached to articles. Notes that are plain
    cross-references ('SR 943.03') or publication footnotes are dropped."""
    root = etree.fromstring(xml)
    rows: list[Provenance] = []
    for note in root.iter(_AKN + "authorialNote"):
        e_id = _owning_article(note)
        if not e_id:
            continue                        # a note on the act as a whole
        parsed = parse_note("".join(note.itertext()), lang=lang)
        if not parsed["action"] and not parsed["as_reference"]:
            continue                        # not provenance
        rows.append(Provenance(e_id=e_id, **parsed))
    return rows
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_amendment_notes.py -v
```

Expected: 14 passed. If `test_extract_attaches_notes_to_their_owning_article` fails because the trimmed fixture kept no note-bearing article, re-cut the fixture (Plan 2, Task 5, Step 1) choosing an article that has one — do not weaken the assertion.

- [ ] **Step 5: Measure the parser's real coverage on the full OR**

```bash
cd services/ch-pipeline && python3 - <<'PY'
from chpipe import amendment_notes as an
from lxml import etree
AKN = "{http://docs.oasis-open.org/legaldocml/ns/akn/3.0}"
xml = open("/tmp/or_full.xml", "rb").read()
total = len(etree.fromstring(xml).findall(".//" + AKN + "authorialNote"))
rows = an.extract(xml)
print("notes in document        :", total)
print("recognised as provenance :", len(rows))
print("with an action           :", sum(1 for r in rows if r.action))
print("with an AS reference     :", sum(1 for r in rows if r.as_reference))
print("with an effective date   :", sum(1 for r in rows if r.effective_date))
print("with a source act date   :", sum(1 for r in rows if r.source_act_date))
for r in rows[:5]:
    print(" ", r.e_id, r.action, r.as_reference, r.effective_date, "|", r.raw_note[:90])
PY
```

Reference numbers from 2026-08-23: the document has 944 notes, 836 of them inside an article, 889 containing an `AS` reference and 689 containing "in Kraft seit". A recognised count far below ~830 means the patterns miss a common phrasing. Report all six numbers in the commit message; they are the parser's measured accuracy, and no claim of correctness stands without them.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/amendment_notes.py \
        services/ch-pipeline/tests/test_amendment_notes.py
git commit -m "feat(ch): recover amendment provenance from akoma ntoso footnotes"
```

---

### Task 3: The `provenance` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/provenance_stage.py`
- Test: `services/ch-pipeline/tests/test_provenance_stage.py`

**Interfaces:**
- Produces: `chpipe.stages.provenance_stage.store(conn, version_id: int, rows: list[amendment_notes.Provenance]) -> int`; `chpipe.stages.provenance_stage.run(settings, lang: str = "de", limit: int | None = None) -> ProvenanceReport` with `ProvenanceReport(versions: int, rows: int, versions_without_notes: int)`.

**Behaviour:** reads `ch_act_version.akn_xml` for parsed versions in one language and writes `ch_article_provenance`. It never downloads anything.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_provenance_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe import amendment_notes
from chpipe.config import Settings
from chpipe.stages import acts_stage, provenance_stage, versions_stage

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
M198 = pathlib.Path("mcp_backend/src/migrations/198_ch_as_bbl.sql")
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
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
        for t in ("ch_article_provenance", "ch_act_amendment_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _version(conn, with_xml=True):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026", "dateApplicability": "2026-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s",
                 (FIXTURE.read_text() if with_xml else None, vid))
    return vid


def test_stores_provenance_rows_for_a_version(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    assert provenance_stage.store(conn, vid, rows) == len(rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(rows)


def test_rerunning_replaces_rather_than_duplicating(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    provenance_stage.store(conn, vid, rows)
    provenance_stage.store(conn, vid, rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance").fetchone()[0] == len(rows)


def test_the_raw_note_is_always_persisted(conn, settings):
    vid = _version(conn)
    provenance_stage.store(conn, vid, amendment_notes.extract(FIXTURE.read_bytes()))
    missing = conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE raw_note IS NULL "
        "OR raw_note = ''").fetchone()[0]
    assert missing == 0


def test_run_skips_a_version_with_no_xml(conn, settings):
    _version(conn, with_xml=False)
    report = provenance_stage.run(settings)
    assert report.rows == 0
    assert report.versions_without_notes == 1


def test_run_only_touches_the_requested_language(conn, settings):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026fr",
        "dateApplicability": "2026-01-01", "lang": L + "FRA",
        "fileUrl": "https://x/fr.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s", (FIXTURE.read_text(), vid))
    assert provenance_stage.run(settings, lang="de").versions == 0
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_provenance_stage.py -v
```

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/stages/provenance_stage.py
"""Turn the AKN footnotes already in ch_act_version.akn_xml into provenance rows.

Downloads nothing: Plan 2 fetched these files once, and re-fetching 170,000 of
them to read their footnotes would be load on Fedlex for no new bytes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import amendment_notes, db
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ProvenanceReport:
    versions: int = 0
    rows: int = 0
    versions_without_notes: int = 0
    failed: int = 0


def store(conn, version_id: int, rows: list[amendment_notes.Provenance]) -> int:
    conn.execute("DELETE FROM ch_article_provenance WHERE version_id = %s",
                 (version_id,))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO ch_article_provenance (version_id, e_id, action, "
            "as_reference, bbl_reference, effective_date, source_act_date, raw_note) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            [(version_id, r.e_id, r.action, r.as_reference, r.bbl_reference,
              r.effective_date, r.source_act_date, r.raw_note) for r in rows])
    return len(rows)


def run(settings: Settings, lang: str = "de",
        limit: int | None = None) -> ProvenanceReport:
    report = ProvenanceReport()
    conn = db.connect(settings)
    try:
        sql = ("SELECT version_id FROM ch_act_version "
               "WHERE lang = %s AND stage = 'parsed' ORDER BY version_id")
        params: list = [lang]
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        version_ids = [r["version_id"] for r in conn.execute(sql, params).fetchall()]

        for version_id in version_ids:
            stored = conn.execute(
                "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                (version_id,)).fetchone()["akn_xml"]
            if not stored:
                report.versions_without_notes += 1
                continue
            try:
                rows = amendment_notes.extract(stored.encode("utf-8"), lang=lang)
            except Exception as exc:                       # noqa: BLE001
                log.warning("version %s: %s", version_id, exc)
                report.failed += 1
                continue
            if not rows:
                report.versions_without_notes += 1
                continue
            report.rows += store(conn, version_id, rows)
            report.versions += 1
            if report.versions % 500 == 0:
                log.info("versions=%d rows=%d", report.versions, report.rows)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(), lang=os.environ.get("CHPIPE_LANG", "de"))
    log.info("versions=%d rows=%d without_notes=%d failed=%d", result.versions,
             result.rows, result.versions_without_notes, result.failed)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_provenance_stage.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Cross-check provenance against the computed change log**

The two sources are independent: `ch_act_change` is computed by diffing editions, `ch_article_provenance` is read out of the footnotes. Where they disagree, one of them is wrong, and that is worth knowing.

```bash
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"WITH ours AS (
       SELECT c.e_id, c.date_applicability
         FROM ch_act_change c JOIN ch_act a USING (act_id)
        WHERE a.sr_number = '220' AND c.lang = 'de'),
    theirs AS (
       SELECT p.e_id, p.effective_date
         FROM ch_article_provenance p
         JOIN ch_act_version v USING (version_id)
         JOIN ch_act a USING (act_id)
        WHERE a.sr_number = '220' AND p.effective_date IS NOT NULL)
    SELECT (SELECT count(*) FROM ours)                       AS computed_changes,
           (SELECT count(*) FROM theirs)                     AS footnote_changes,
           (SELECT count(*) FROM ours o JOIN theirs t
              ON o.e_id = t.e_id AND o.date_applicability = t.effective_date)
                                                             AS agreeing\""
```

Report the three numbers. Perfect agreement is not expected — a consolidation date is not always an amendment's effective date — but a near-zero overlap means one of the two is systematically wrong and must be investigated before either is trusted.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/provenance_stage.py \
        services/ch-pipeline/tests/test_provenance_stage.py
git commit -m "feat(ch): article-level amendment provenance stage"
```

---

### Task 4: AS/BBl discovery and the `basicAct` links

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/as_bbl_stage.py`, `services/ch-pipeline/chpipe/stages/basic_act_stage.py`
- Modify: `services/ch-pipeline/chpipe/fedlex_queries.py` — add `AS_ACTS` and `BASIC_ACTS`
- Test: `services/ch-pipeline/tests/test_as_bbl_stage.py`

**Interfaces:**
- Produces in `fedlex_queries`: `AS_ACTS`, `BASIC_ACTS` (both pageable, both `SELECT DISTINCT`), `collection_of(eli_uri: str) -> str | None`.
- Produces: `chpipe.stages.as_bbl_stage.upsert_as_act(conn, row: dict) -> int | None`; `chpipe.stages.as_bbl_stage.run(settings) -> AsReport` with `AsReport(discovered: int, skipped: int, by_collection: dict[str, int])`.
- Produces: `chpipe.stages.basic_act_stage.run(settings) -> LinkReport` with `LinkReport(linked: int, missing_act: int, missing_as: int)`.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_as_bbl_stage.py
import os
import pathlib
import psycopg
import pytest
from chpipe import fedlex_queries as fq
from chpipe.stages import acts_stage, as_bbl_stage, basic_act_stage
from chpipe.config import Settings

M197 = pathlib.Path("mcp_backend/src/migrations/197_ch_legislation_corpus.sql")
M198 = pathlib.Path("mcp_backend/src/migrations/198_ch_as_bbl.sql")
CC = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
OC = "https://fedlex.data.admin.ch/eli/oc/27/317_321_377"
FGA = "https://fedlex.data.admin.ch/eli/fga/1986/2_354_354_354"

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
        for t in ("ch_article_provenance", "ch_act_amendment_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        yield c


def test_collection_of_reads_the_eli_segment():
    """Verified on the real graph: cc = Classified Compilation,
    oc = Official Compilation (AS), fga = Federal Gazette (BBl)."""
    assert fq.collection_of(OC) == "AS"
    assert fq.collection_of(FGA) == "BBl"
    assert fq.collection_of(CC) is None


def test_stores_an_official_compilation_act(conn):
    as_id = as_bbl_stage.upsert_as_act(conn, {"act": OC, "dateDocument": "1911-03-30"})
    row = conn.execute("SELECT eli_uri, collection, date_document FROM ch_as_act "
                       "WHERE as_id=%s", (as_id,)).fetchone()
    assert row[0] == OC
    assert row[1] == "AS"
    assert str(row[2]) == "1911-03-30"


def test_stores_a_federal_gazette_act(conn):
    as_id = as_bbl_stage.upsert_as_act(conn, {"act": FGA})
    assert conn.execute("SELECT collection FROM ch_as_act WHERE as_id=%s",
                        (as_id,)).fetchone()[0] == "BBl"


def test_an_eli_from_neither_collection_is_skipped(conn):
    assert as_bbl_stage.upsert_as_act(conn, {"act": CC}) is None
    assert conn.execute("SELECT count(*) FROM ch_as_act").fetchone()[0] == 0


def test_upsert_is_idempotent(conn):
    first = as_bbl_stage.upsert_as_act(conn, {"act": OC})
    second = as_bbl_stage.upsert_as_act(conn, {"act": OC})
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_as_act").fetchone()[0] == 1


def test_links_a_cc_act_to_its_basic_act(conn, settings):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    written = basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    assert written == 1
    row = conn.execute(
        "SELECT relation_type FROM ch_act_amendment_link").fetchone()
    assert row[0] == "basic_act"


def test_linking_twice_does_not_duplicate(conn, settings):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    assert conn.execute(
        "SELECT count(*) FROM ch_act_amendment_link").fetchone()[0] == 1


def test_a_link_whose_cc_act_is_unknown_writes_nothing(conn, settings):
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    assert basic_act_stage.link(conn, {"work": "https://cc/never", "basicAct": OC}) == 0


def test_a_link_whose_as_act_is_unknown_writes_nothing(conn, settings):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    assert basic_act_stage.link(conn, {"work": CC, "basicAct": "https://oc/never"}) == 0
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_as_bbl_stage.py -v
```

Expected: FAIL — `fedlex_queries.collection_of` and both stage modules are missing.

- [ ] **Step 3: Extend `fedlex_queries` and write the two stages**

Append to `services/ch-pipeline/chpipe/fedlex_queries.py`:

```python
# ELI collection segments, verified on the live graph:
#   /eli/cc/…  Classified Compilation (SR)  — handled by ACTS
#   /eli/oc/…  Official Compilation (AS/RO)
#   /eli/fga/… Federal Gazette (BBl/FF)
_COLLECTION_SEGMENT = re.compile(r"/eli/(cc|oc|fga)/")
_COLLECTION_NAME = {"oc": "AS", "fga": "BBl"}


def collection_of(eli_uri: str | None) -> str | None:
    """'AS' or 'BBl' for an Official Compilation or Federal Gazette ELI, else None."""
    match = _COLLECTION_SEGMENT.search(eli_uri or "")
    return _COLLECTION_NAME.get(match.group(1)) if match else None


# 211,637 distinct jolux:Act as of 2026-08-24 — the largest stage in the corpus.
AS_ACTS = _PREFIXES + """
SELECT DISTINCT ?act ?dateDocument ?publicationDate ?dateEntryForce ?typeDocument WHERE {
  ?act a jolux:Act .
  OPTIONAL { ?act jolux:dateDocument ?dateDocument }
  OPTIONAL { ?act jolux:publicationDate ?publicationDate }
  OPTIONAL { ?act jolux:dateEntryInForce ?dateEntryForce }
  OPTIONAL { ?act jolux:typeDocument ?typeDocument }
}
ORDER BY ?act
LIMIT %(limit)d OFFSET %(offset)d
"""

# The only structured CC -> AS relation Fedlex publishes: 17,055 basicAct links.
# There is no "amends" predicate anywhere in this graph.
BASIC_ACTS = _PREFIXES + """
SELECT DISTINCT ?work ?basicAct WHERE {
  ?work a jolux:ConsolidationAbstract ; jolux:basicAct ?basicAct .
}
ORDER BY ?work
LIMIT %(limit)d OFFSET %(offset)d
"""
```

```python
# services/ch-pipeline/chpipe/stages/as_bbl_stage.py
"""Discovery of Official Compilation and Federal Gazette acts.

211,637 distinct jolux:Act as of 2026-08-24. This is the largest stage in the corpus and
runs last, so nothing more useful queues behind it. Titles are not fetched here:
that would be a second query of comparable size, and the titles are only worth
having for the acts that turn out to be referenced. Fetch them later, for the
subset that ch_act_amendment_link and ch_article_provenance actually point at.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)


@dataclass
class AsReport:
    discovered: int = 0
    skipped: int = 0
    by_collection: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO ch_as_act (eli_uri, collection, date_document, publication_date,
                       date_entry_force, document_type, metadata_json, updated_at)
VALUES (%(eli)s, %(collection)s, %(date_document)s, %(publication_date)s,
        %(date_entry_force)s, %(document_type)s, %(metadata)s, now())
ON CONFLICT (eli_uri) DO UPDATE SET
    date_document    = COALESCE(EXCLUDED.date_document, ch_as_act.date_document),
    publication_date = COALESCE(EXCLUDED.publication_date, ch_as_act.publication_date),
    date_entry_force = COALESCE(EXCLUDED.date_entry_force, ch_as_act.date_entry_force),
    document_type    = COALESCE(EXCLUDED.document_type, ch_as_act.document_type),
    metadata_json    = EXCLUDED.metadata_json,
    updated_at       = now()
RETURNING as_id
"""


def upsert_as_act(conn, row: dict) -> int | None:
    eli = row.get("act")
    collection = fq.collection_of(eli)
    if not collection:
        return None                 # a /eli/cc/ URI belongs in ch_act, not here
    params = {
        "eli": eli,
        "collection": collection,
        "date_document": (row.get("dateDocument") or "")[:10] or None,
        "publication_date": (row.get("publicationDate") or "")[:10] or None,
        "date_entry_force": (row.get("dateEntryForce") or "")[:10] or None,
        "document_type": row.get("typeDocument"),
        "metadata": json.dumps({k: v for k, v in row.items() if k != "act"},
                               ensure_ascii=False),
    }
    result = conn.execute(_UPSERT, params).fetchone()
    return result["as_id"] if isinstance(result, dict) else result[0]


def run(settings: Settings) -> AsReport:
    report = AsReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.AS_ACTS, page_size=5000):
            as_id = upsert_as_act(conn, row)
            if as_id is None:
                report.skipped += 1
                continue
            collection = fq.collection_of(row.get("act")) or "?"
            report.by_collection[collection] = \
                report.by_collection.get(collection, 0) + 1
            report.discovered += 1
            if report.discovered % 10000 == 0:
                log.info("as/bbl discovered=%d skipped=%d", report.discovered,
                         report.skipped)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("discovered=%d skipped=%d by_collection=%s", result.discovered,
             result.skipped, result.by_collection)
```

```python
# services/ch-pipeline/chpipe/stages/basic_act_stage.py
"""jolux:basicAct links between a Classified Compilation entry and the Official
Compilation act that established it.

17,055 links as of 2026-08-24. This is NOT an amendment relation — Fedlex
publishes none. It answers "which AS act created this SR entry", nothing more.
The amendment history lives in ch_act_change (computed) and
ch_article_provenance (from footnotes).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import SparqlClient

log = logging.getLogger(__name__)


@dataclass
class LinkReport:
    linked: int = 0
    unresolved: int = 0


_LINK = """
INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type)
SELECT a.act_id, s.as_id, 'basic_act'
  FROM ch_act a, ch_as_act s
 WHERE a.eli_work_uri = %(work)s AND s.eli_uri = %(basic)s
ON CONFLICT (act_id, as_id, relation_type) DO NOTHING
"""


def link(conn, row: dict) -> int:
    """Returns rows written: 1 when both ends exist and the link is new, else 0."""
    return conn.execute(_LINK, {"work": row["work"],
                                "basic": row["basicAct"]}).rowcount


def run(settings: Settings) -> LinkReport:
    report = LinkReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        for row in client.paged(fq.BASIC_ACTS, page_size=5000):
            if link(conn, row):
                report.linked += 1
            else:
                report.unresolved += 1
            if (report.linked + report.unresolved) % 10000 == 0:
                log.info("linked=%d unresolved=%d", report.linked, report.unresolved)
    finally:
        conn.close()
        client.close()
    return report


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env())
    log.info("linked=%d unresolved=%d", result.linked, result.unresolved)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
    python3 -m pytest tests/test_as_bbl_stage.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Run both stages and check the totals**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && ./run-stage.sh as_bbl"
ssh prod "cd ~/SecondLayer/services/ch-pipeline && ./run-stage.sh basic_act"
ssh prod "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -c \
  \"SELECT collection, count(*) FROM ch_as_act GROUP BY 1;
    SELECT relation_type, count(*) FROM ch_act_amendment_link GROUP BY 1\""
```

Reference re-measured 2026-08-24: `jolux:Act` totals **211,637 distinct** acts across both collections (369,181 is the raw `COUNT(*)` and is not a row count), and `basicAct` yields **17,055** links, not the 69,190 recorded on 2026-08-23. Compare the run against these figures, not the old ones: a gate calibrated to 69,190 would report a 75% shortfall on a healthy run and send an operator hunting a bug that is not there. A materially lower link count than 17,055 means acts the links point at were skipped during AS/BBl discovery — report the `unresolved` figure from the run log rather than passing over it.

- [ ] **Step 6: Commit**

```bash
git add services/ch-pipeline/chpipe/stages/as_bbl_stage.py \
        services/ch-pipeline/chpipe/stages/basic_act_stage.py \
        services/ch-pipeline/chpipe/fedlex_queries.py \
        services/ch-pipeline/tests/test_as_bbl_stage.py
git commit -m "feat(ch): AS/BBl corpus and the basicAct links"
```

---

### Task 5: Daily deltas

**Files:**
- Create: `services/ch-pipeline/chpipe/delta.py`, `services/ch-pipeline/run-delta.sh`
- Modify: `services/ch-pipeline/README.md` — add the delta section
- Test: `services/ch-pipeline/tests/test_delta.py`

**Interfaces:**
- Produces: `chpipe.delta.snapshot_url(day: datetime.date) -> str`; `chpipe.delta.spiders_that_grew(previous: dict, current: dict) -> list[str]`; `chpipe.delta.run_decisions(settings, fetcher_factory=None) -> DeltaReport`; `chpipe.delta.run_legislation(settings) -> DeltaReport`; `DeltaReport(spiders: list[str], new_documents: int, new_versions: int)`.

**Behaviour:** decisions — compare today's `Snapshots/{date}.json` with the last one we stored, re-index only the spiders whose counter grew, then run the ordinary stages against those spiders. Legislation — re-run `acts` and `versions` (both are cheap upserts) and let the version queue pick up whatever is new.

- [ ] **Step 1: Write the failing test**

```python
# services/ch-pipeline/tests/test_delta.py
import datetime
from chpipe import delta


def test_snapshot_url_uses_the_iso_date():
    assert delta.snapshot_url(datetime.date(2026, 8, 20)) == \
        "https://entscheidsuche.ch/docs/Snapshots/2026-08-20.json"


def test_a_spider_whose_counter_grew_is_returned():
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 103}) == ["ZG_OG"]


def test_a_spider_with_an_unchanged_counter_is_not_returned():
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 100}) == []


def test_a_brand_new_spider_is_returned():
    assert delta.spiders_that_grew({}, {"XX_New": 5}) == ["XX_New"]


def test_a_shrinking_counter_is_returned_too():
    """A drop means the source withdrew documents. That is a change worth
    re-indexing and reporting, not something to ignore because it is not growth."""
    assert delta.spiders_that_grew({"ZG_OG": 100}, {"ZG_OG": 97}) == ["ZG_OG"]


def test_results_are_sorted_for_a_stable_run_order():
    grown = delta.spiders_that_grew({}, {"ZH_OG": 1, "AG_Gerichte": 1, "BE_VG": 1})
    assert grown == ["AG_Gerichte", "BE_VG", "ZH_OG"]


def test_non_spider_keys_from_the_snapshot_are_dropped():
    """Snapshots.total is keyed by court code as well as spider name; a court
    code that matches no spider must not become a phantom re-index target."""
    grown = delta.spiders_that_grew({}, {"ZG_Obergericht": 1, "ZG_OG_001": 1})
    assert grown == ["ZG_Obergericht"]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_delta.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'chpipe.delta'`.

- [ ] **Step 3: Write the implementation**

```python
# services/ch-pipeline/chpipe/delta.py
"""Daily delta for both Swiss corpora.

Decisions: entscheidsuche publishes /docs/Snapshots/{date}.json with a per-court
counter map and total_alle. Comparing today's map against the last one we stored
tells us which spiders to re-walk — far cheaper than re-listing all 54.

Legislation: the acts and versions stages are idempotent upserts over the whole
graph, and the whole graph is a few minutes of SPARQL. Re-running them is
simpler and more reliable than trying to filter by date, and new versions fall
into the existing queue at stage 'discovered'.
"""
from __future__ import annotations

import datetime
import json
import logging
import pathlib
from dataclasses import dataclass, field

from . import db
from .config import Settings
from .stages import (acts_stage, extract_stage, fetch_stage, fetch_xml_stage,
                     index_stage, load_stage, parse_akn_stage, versions_stage)

log = logging.getLogger(__name__)

SNAPSHOT_BASE = "https://entscheidsuche.ch/docs/Snapshots"
STATE_FILE = "snapshot-state.json"


@dataclass
class DeltaReport:
    spiders: list[str] = field(default_factory=list)
    new_documents: int = 0
    new_versions: int = 0


def snapshot_url(day: datetime.date) -> str:
    return f"{SNAPSHOT_BASE}/{day.isoformat()}.json"


def spiders_that_grew(previous: dict, current: dict) -> list[str]:
    """Spiders whose counter moved in either direction, plus new ones.

    A shrinking counter means the source withdrew documents — a real change, and
    ignoring it would leave us serving decisions the court has taken down.

    Snapshot keys mix spider names with court codes ('ZG_Obergericht' and
    'ZG_OG_001'); only keys that name a spider we run are returned.
    """
    known = set(index_stage.ALL_SPIDERS)
    changed = {name for name, count in current.items()
               if name in known and previous.get(name) != count}
    return sorted(changed)


def _state_path(settings: Settings) -> pathlib.Path:
    return settings.raw_dir / STATE_FILE


def _load_state(settings: Settings) -> dict:
    path = _state_path(settings)
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_state(settings: Settings, snapshot: dict) -> None:
    path = _state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False))


def run_decisions(settings: Settings, today: datetime.date | None = None,
                  fetch_snapshot=None) -> DeltaReport:
    import urllib.request

    day = today or datetime.date.today()

    def _default_fetch(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=120) as response:
            return json.loads(response.read())

    fetcher = fetch_snapshot or _default_fetch

    snapshot = None
    for offset in range(0, 4):          # a snapshot may lag by a day or two
        try:
            snapshot = fetcher(snapshot_url(day - datetime.timedelta(days=offset)))
            break
        except Exception as exc:        # noqa: BLE001
            log.info("no snapshot for %s (%s)", day - datetime.timedelta(days=offset),
                     exc)
    if snapshot is None:
        log.warning("no snapshot in the last four days; skipping the decisions delta")
        return DeltaReport()

    current = snapshot.get("total", {})
    grown = spiders_that_grew(_load_state(settings), current)
    log.info("total_alle=%s, %d spiders changed", snapshot.get("total_alle"),
             len(grown))
    if not grown:
        _save_state(settings, current)
        return DeltaReport()

    index_report = index_stage.run(settings, grown)
    for spider in grown:
        fetch_stage.run(settings, spider=spider)
        extract_stage.run(settings, spider=spider)
        load_stage.run(settings, spider=spider)

    _save_state(settings, current)
    return DeltaReport(spiders=grown, new_documents=index_report.inserted)


def run_legislation(settings: Settings) -> DeltaReport:
    acts_stage.run(settings)
    versions = versions_stage.run(settings)
    fetch_xml_stage.run(settings)
    parse_akn_stage.run(settings)
    return DeltaReport(new_versions=versions.discovered)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    decisions = run_decisions(settings)
    legislation = run_legislation(settings)
    log.info("delta: spiders=%s new_documents=%d new_versions=%d",
             decisions.spiders, decisions.new_documents, legislation.new_versions)
```

```bash
# services/ch-pipeline/run-delta.sh
#!/usr/bin/env bash
# Daily delta for both Swiss corpora. Installed as a cron entry; see README.
set -euo pipefail

LOG_DIR=/data/ch-corpus/logs
mkdir -p "$LOG_DIR"

PGPASS="$(grep -E '^POSTGRES_PASSWORD=' ~/SecondLayer/deployment/.env.prod | cut -d= -f2-)"
export CHPIPE_DSN="postgresql://secondlayer:${PGPASS}@127.0.0.1:5438/secondlayer_prod"
export CHPIPE_RAW_DIR=/data/ch-corpus/raw
# The delta runs unattended alongside live traffic, so it is quieter than a
# backfill: fewer connections, and OCR is left for the supervised stage.
export CHPIPE_HTTP_CONCURRENCY=6
export CHPIPE_CPU_WORKERS=2

cd ~/SecondLayer/services/ch-pipeline
exec python3 -m chpipe.delta >> "$LOG_DIR/delta.log" 2>&1
```

Note that `run-delta.sh` deliberately does not run the OCR stage. Documents whose text layer fails the gate accumulate at `ocr_pending` and are cleared by a supervised run, so an unattended cron job can never quietly saturate the box.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/ch-pipeline && python3 -m pytest tests/test_delta.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Dry-run the delta before installing the cron entry**

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && chmod +x run-delta.sh && \
  ./run-delta.sh && tail -30 /data/ch-corpus/logs/delta.log"
```

The first run has no stored snapshot state, so it will treat every spider as changed and re-index all 54. That is intentional — it establishes the baseline. Confirm the second run touches few or no spiders:

```bash
ssh prod "cd ~/SecondLayer/services/ch-pipeline && ./run-delta.sh && \
  grep 'spiders changed' /data/ch-corpus/logs/delta.log | tail -2"
```

- [ ] **Step 6: Install the cron entry**

```bash
ssh prod "( crontab -l 2>/dev/null | grep -v 'ch-pipeline/run-delta.sh'; \
  echo '17 4 * * * cd \$HOME/SecondLayer/services/ch-pipeline && ./run-delta.sh' ) | crontab -"
ssh prod "crontab -l | grep ch-pipeline"
```

04:17 is chosen to sit after entscheidsuche's own nightly scrapes (their `Snapshots` file for 2026-08-20 was generated at 06:00 UTC, and the `Status` files show spider runs finishing around 23:57) and away from the backup window.

- [ ] **Step 7: Add the delta section to the README**

```markdown
## Deltas

`run-delta.sh` runs daily at 04:17 from cron on prod.

Decisions: reads `/docs/Snapshots/{date}.json`, compares the per-court counter
map against `$CHPIPE_RAW_DIR/snapshot-state.json`, and re-walks only the spiders
whose count moved — in either direction, because a drop means the court withdrew
documents. Falls back up to three days if today's snapshot is not published yet.

Legislation: re-runs the acts and versions discovery (idempotent upserts over the
whole graph, a few minutes of SPARQL), then drains the version queue.

OCR is NOT part of the delta. Documents that fail the text-layer gate wait at
`ocr_pending` for a supervised run, so an unattended job can never saturate the
eight cores prod shares with live traffic.

Check it is alive:

    tail -50 /data/ch-corpus/logs/delta.log
    psql -c "SELECT stage, count(*) FROM ch_court_decisions GROUP BY 1"
    psql -c "SELECT stage, count(*) FROM ch_act_version GROUP BY 1"
```

- [ ] **Step 8: Commit**

```bash
chmod +x services/ch-pipeline/run-delta.sh
git add services/ch-pipeline/chpipe/delta.py services/ch-pipeline/run-delta.sh \
        services/ch-pipeline/README.md services/ch-pipeline/tests/test_delta.py
git commit -m "feat(ch): daily delta for both swiss corpora"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 6.2 `ch_as_act` | Task 1 |
| 6.2 `ch_act_amendment_link` | Task 1, Task 4 |
| 7.12 `as-bbl` | Task 4 |
| 10 deltas, decisions | Task 5 |
| 10 deltas, legislation | Task 5 |

Two additions beyond the spec, both recorded deliberately:

1. **`ch_article_provenance` (Tasks 1–3) is not in the spec.** It became necessary once the graph was actually enumerated: the spec assumed section 7.12 could link amendment acts to the articles they change, and Fedlex publishes no such relation. The footnotes do carry it, so the provenance table is how the spec's intent is met. The spec should be amended to match.
2. **`jolux:basicAct` is not an amendment relation** and the schema comment says so. Calling it one would be the single most misleading thing this corpus could assert.

**Placeholders:** none.

**Type consistency:** `fedlex_queries.collection_of` is added in Task 4 and used in `as_bbl_stage` under that name. `amendment_notes.Provenance` field names match the insert in `provenance_stage.store` one for one. `index_stage.ALL_SPIDERS` is defined in Plan 1 Task 6 and read by `delta.spiders_that_grew`. Every stage `run(settings, …)` called from `delta` matches the signature that plan defines: `index_stage.run(settings, spiders)`, `fetch_stage.run(settings, limit, spider)`, `extract_stage.run(settings, limit, spider)`, `load_stage.run(settings, limit, spider)`, `acts_stage.run(settings)`, `versions_stage.run(settings)`, `fetch_xml_stage.run(settings, limit)`, `parse_akn_stage.run(settings, limit)`.

**One gap left open on purpose:** `run-stage.sh` from Plan 1 maps a stage name to `chpipe.stages.{name}_stage`. The stages added here (`as_bbl`, `basic_act`, `acts`, `versions`, `fetch_xml`, `parse_akn`, `diff`, `project_legacy`, `provenance`) all follow that naming, so the script needs no change — but confirm it before relying on it, since `run-stage.sh` also exports `CHPIPE_SPIDER`, which the legislation stages ignore.
