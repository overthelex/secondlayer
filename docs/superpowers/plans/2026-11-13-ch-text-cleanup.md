# CH Text Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw `pdftotext -layout` residue in CH `full_text` columns (federal PDF editions, PDF court decisions, cantonal PDF editions) with readable text, keep the raw text recoverable, and make the nightly pipeline produce clean text from now on.

**Architecture:** One pure module `chpipe/text_clean.py` (unwrap, dehyphenate, strip page furniture) is reused by three writers: `fedlex_split` (phase A, raw moves to `akn_xml`), a new `clean-text` decision stage driven by a narrow side table `ch_text_clean_state` with raw text archived to gzip files (phase B), and the cantonal `pdf_text` path (phase C). A damage-marker module gives the before/after numbers for every phase and the nightly report.

**Tech Stack:** Python 3 (`services/ch-pipeline`, psycopg 3, pytest), PostgreSQL migrations in `mcp_backend/src/migrations` (applied on cthulhu by the `lawrider-migrate` container at deploy), operator runs via `services/ch-pipeline/run-stage.sh` on cthulhu (`~/lawrider/repo`, venv `~/lawrider/ch-pipeline-venv`, DSN port 5448).

**Spec:** `docs/superpowers/specs/2026-11-13-ch-text-cleanup-design.md`

## Global Constraints

- Work on a branch from `main` in a fresh worktree (the current checkout `feat/legislation-stage2-supervised-fetch` does not contain `services/ch-pipeline`). Branch name: `feat/ch-text-cleanup`.
- Raw text is never lost: fedlex_pdf raw goes to `ch_act_version.akn_xml`; decision raw goes to `/data/ch-corpus/raw-text/{spider}/{doc_id}.txt.gz` BEFORE the row is updated.
- No bulk UPDATE of stamp columns on `ch_court_decisions`; all bookkeeping lives in `ch_text_clean_state`.
- `ch_act_article` rows and `article_count` of fedlex_pdf editions must be unchanged by phase A; the 524,541 fedlex_pdf pairs in `ch_act_change` must be byte-identical before and after.
- Excluded spiders for decisions: `CH_WEKO_RPW`, `CH_WEKO` (own column reflow in `rpw.py`).
- Acceptance on the fixed 300-document sample: glued footnote refs < 0.5 %, hyphen breaks < 1 %, bare page-number lines 0, mean line length of PDF decisions > 300 chars, `text_quality` mean not lower than before by more than 0.01, citations per document not fewer than before.
- Every run on cthulhu under `nice -n 10 ionice -c3`, outside 10:15 Kyiv (run-delta) and Sunday 06:00–13:00 (weekly crons).
- Tests: `cd services/ch-pipeline && pytest tests/<file> -v`; DB tests need `CHPIPE_TEST_DSN` (skip otherwise, like `test_fedlex_pdf_text_stage.py`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A real compound hyphen at a line end ("Kantons-\nund Gemeindesteuern", "Rechts-\noder") must stay "Kantons- und", never "Kantonsund". Pinned in Task 1 tests.
2. A document that is already reflowed (portal spiders, long lines) must come out unchanged except for U+00A0 and page numbers: the unwrap pass must be a no-op. Pinned in Task 1 (`is_hard_wrapped`) and Task 4 tests.
3. A numbered paragraph start on its own line ("4. Nachdem …", "B.1 Allgemeines", "Art. 5", "E. 2.3") must begin a new paragraph, never be glued to the previous sentence. Pinned in Task 1 tests.
4. Re-running phase A over an edition already converted (raw in `akn_xml`) must read the raw from `akn_xml`, not re-clean the clean `full_text`. Pinned in Task 3 DB test.
5. A crash between the gzip write and the UPDATE in phase B must leave the row unclean and re-claimable; a crash after the UPDATE but before the state stamp must be idempotent on re-run (sha256 match → stamp only). Pinned in Task 5 DB tests.

---

### Task 0: Damage markers and the fixed sample

**Files:**
- Create: `services/ch-pipeline/chpipe/text_damage.py`
- Create: `services/ch-pipeline/scripts/text_damage_probe.py`
- Test: `services/ch-pipeline/tests/test_text_damage.py`

**Interfaces:**
- Produces: `text_damage.markers(text: str) -> dict[str, float]` with keys `glued_refs` (count of `[a-zäöüéèàç]\.?\d{2,3}\s`), `hyphen_breaks` (count of `\w-\n\s*\w`), `page_number_lines` (lines matching `^\s*\d{1,3}\s*$`), `repeated_lines` (distinct non-empty stripped lines occurring ≥ 3 times, length ≤ 120), `ligatures` (count of `ﬁﬂﬀﬃﬄ`), `replacement_chars` (U+FFFD), `nbsp` (U+00A0), `mean_line_len` (over non-empty lines), `short_line_share` (share of non-empty lines < 60 chars).
- Produces: `scripts/text_damage_probe.py` CLI: `--dsn`, `--sample FILE` (JSON `{"decisions": [doc_id…], "editions": [version_id…]}`), `--make-sample N_PER_CLASS` (writes the file: 100 PDF decisions, 100 fedlex_pdf editions, 100 cantonal editions split evenly over lexfind/lexwork_pdf/zhlex, chosen by `TABLESAMPLE SYSTEM (1)` then `ORDER BY random()`), `--out FILE` (JSON of per-document markers plus per-class aggregates: mean of each marker and share of documents with marker > 0).

- [ ] **Step 1: Write the failing tests**

```python
def test_markers_counts_glued_refs_and_hyphens():
    m = markers("werden.322 Zusammenschluss-\nvorhaben bestehen\n8\nfoo\nfoo\nfoo\n")
    assert m["glued_refs"] == 1
    assert m["hyphen_breaks"] == 1
    assert m["page_number_lines"] == 1
    assert m["repeated_lines"] == 1

def test_markers_ligatures_nbsp_replacement():
    m = markers("ﬁnanziaria x �")
    assert (m["ligatures"], m["nbsp"], m["replacement_chars"]) == (1, 1, 1)

def test_markers_line_stats():
    m = markers("a" * 68 + "\n" + "b" * 300)
    assert m["mean_line_len"] == 184
    assert m["short_line_share"] == 0.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_text_damage.py -v` — Expected: FAIL, `No module named 'chpipe.text_damage'`.

- [ ] **Step 3: Implement `markers()` in `chpipe/text_damage.py`** (regexes module-level, compiled once; `repeated_lines` via `collections.Counter`).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Write `scripts/text_damage_probe.py`** (argparse; psycopg `dict_row`; for decisions read `doc_id, spider, text_source, full_text, text_quality`; for editions `version_id, source, lang, full_text`; aggregate per `spider`/`source`; print a table to stdout and write `--out`).

- [ ] **Step 6: Baseline on cthulhu** (operator step, record the numbers in the PR description)

```bash
ssh local
cd ~/lawrider/repo/services/ch-pipeline && source ~/lawrider/ch-pipeline-venv/bin/activate
export CHPIPE_DSN="postgresql://secondlayer:$(grep ^POSTGRES_PASSWORD ~/lawrider/.env.lawrider | cut -d= -f2)@127.0.0.1:5448/secondlayer_prod"
python scripts/text_damage_probe.py --dsn "$CHPIPE_DSN" --make-sample 100 --sample /data/ch-corpus/bench/text-damage-sample.json
python scripts/text_damage_probe.py --dsn "$CHPIPE_DSN" --sample /data/ch-corpus/bench/text-damage-sample.json --out /data/ch-corpus/logs/text-damage-baseline.json
```

Expected: the aggregates agree with the spec §1 within sampling noise (fedlex_pdf glued_refs share ≈ 0.5, PDF decisions hyphen share ≈ 0.75, mean_line_len ≈ 68). Read 10 documents per class by eye from the sample and note in the PR what counts as damage.

- [ ] **Step 7: Commit** `feat(ch): text damage markers and fixed sample probe`

---

### Task 1: `chpipe/text_clean.py` (pure cleaner)

**Files:**
- Create: `services/ch-pipeline/chpipe/text_clean.py`
- Test: `services/ch-pipeline/tests/test_text_clean.py`
- Fixtures (already extracted from prod by the controller; copy from the SDD workspace `fixtures/` dir into `tests/fixtures/`): `pdftext_decision_gr_hardwrap.txt` (GR_FIXTURE), `pdftext_decision_vb_twocolumn.txt` (VB_TWOCOL, CH_VB_001_88-062_1989-06-19), `pdftext_decision_unibe_twocolumn.txt` (UNIBE_TWOCOL), `decision_bger_html_reflowed.txt` (HTML_FIXTURE: an HTML-source decision, the canonical already-reflowed shape; portal PDFs turned out NOT to be reflowed).

**Interfaces:**
- Produces: `CLEANER_VERSION: int = 1`; `OWN_REFLOW_SPIDERS: frozenset[str] = {"CH_WEKO_RPW", "CH_WEKO"}`.
- Produces: `normalise_chars(text: str) -> str` (ligatures ﬁ→fi, ﬂ→fl, ﬀ→ff, ﬃ→ffi, ﬄ→ffl; U+00A0 and U+202F → space; U+00AD soft hyphen removed; U+FFFD left as is).
- Produces: `strip_page_furniture(lines: list[str]) -> list[str]` (drop lines matching `^\s*\d{1,3}\s*$`, `^\s*(Seite|Page|Pagina)\s+\d+`, `^\s*-\s*\d{1,3}\s*-\s*$`, and any stripped line of length ≤ 120 that occurs ≥ 3 times in the document).
- Produces: `is_hard_wrapped(text: str) -> bool` (True when the median length of non-empty lines ≥ 20 chars is < 100).
- Produces: `join_hyphen(head: str, tail: str, vocabulary: frozenset[str]) -> str` where `head` ends with `-`: conjunction start of `tail` (`und|oder|bzw.|sowie|et|ou|e|ed|o|od|u|ni`) → `head + " " + tail` keeping the hyphen; `tail[0].isupper()` → keep hyphen, no space; else join without hyphen unless the joined lowercase word is absent from `vocabulary` while both parts (lowercase, letters only) are present → keep the hyphen.
- Produces: `unwrap(lines: list[str], vocabulary: frozenset[str]) -> list[str]` (paragraphs; a line ends a paragraph when the next line is blank, or the next line starts with a paragraph marker `^(\d{1,3}\.\s|[A-Z]\.\d*(\.\d+)*\s|[a-z]\)\s|[IVX]{1,5}\.\s|Art\.\s|§\s?\d|E\.\s?\d|Erwägung|Considérant|Considerando|Sachverhalt|Faits|Fatti|Dispositiv)`, or the line is shorter than 0.6 × the document's column width (90th percentile of non-empty line lengths) and the next line starts with an uppercase letter or digit).
- Produces: `split_columns(lines: list[str]) -> list[str]`: find maximal runs of ≥ 4 consecutive non-empty-or-blank lines in which ≥ 60 % of the non-empty lines have a gutter (a run of ≥ 3 spaces) starting within ±3 chars of one common column `g` with ≥ 20 chars of text on each side; inside a run emit every line's left part `line[:g].rstrip()` first, then every line's right part `line[g:].strip()` (blank parts kept as blank lines); lines outside runs pass through. Two-column text measured 13.11: ~23K PDF decisions (CH_UNIBE book spreads ≈ 94 %, CH_VB newspaper columns ≈ 29 %).
- Produces: `hyphen_vocabulary(languages: list[str]) -> frozenset[str]` (ledger ruling R2: fr/it/rm wordlists only, German excluded).
- Produces: `clean_pdf_text(raw: str, languages: list[str]) -> str`: `normalise_chars` → split lines → `strip_page_furniture` → `split_columns` → (`unwrap` only if `is_hard_wrapped`) → collapse runs of blank lines to one → `strip()`. Vocabulary via `hyphen_vocabulary(languages)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_join_hyphen_wrap():       assert join_hyphen("Zusammenschluss-", "vorhaben", V) == "Zusammenschlussvorhaben"
def test_join_hyphen_conjunction(): assert join_hyphen("Kantons-", "und Gemeindesteuern", V) == "Kantons- und Gemeindesteuern"
def test_join_hyphen_uppercase():   assert join_hyphen("Schweizer-", "Franken", V) == "Schweizer-Franken"
def test_join_hyphen_vocab_keeps_real_hyphen():
    V2 = frozenset({"rechts", "staat", "rechtsstaat", "nord", "süd"})
    assert join_hyphen("Nord-", "süd", V2) == "Nord-süd"       # both parts known, join unknown
    assert join_hyphen("Rechts-", "staat", V2) == "Rechtsstaat"
def test_unwrap_paragraph_marker_starts_new_paragraph():
    out = unwrap(["schriftlicher Form zukommen liess.", "4. Nachdem das Sekretariat", "darüber informiert hatte."], V)
    assert out == ["schriftlicher Form zukommen liess.", "4. Nachdem das Sekretariat darüber informiert hatte."]
def test_strip_page_furniture_drops_folios_and_running_headers():
    lines = ["Urteil vom 3. Mai", "8", "Bundesgericht 4A_1/2020", "x", "Bundesgericht 4A_1/2020", "y", "Bundesgericht 4A_1/2020"]
    assert strip_page_furniture(lines) == ["Urteil vom 3. Mai", "x", "y"]
def test_is_hard_wrapped(): assert is_hard_wrapped(GR_FIXTURE) and not is_hard_wrapped(PORTAL_FIXTURE)
def test_clean_pdf_text_hardwrapped_fixture():
    out = clean_pdf_text(GR_FIXTURE, ["de"])
    assert "iden-\n" not in out and "identisch sein" in out
    assert markers(out)["hyphen_breaks"] == 0 and markers(out)["page_number_lines"] == 0
    assert markers(out)["mean_line_len"] > 300
def test_clean_pdf_text_reflowed_is_noop_except_chars():
    assert clean_pdf_text(HTML_FIXTURE, ["de"]) == normalise_chars(HTML_FIXTURE).strip()
def test_split_columns_deinterleaves_two_column_run():
    out = "\n".join(split_columns(VB_TWOCOL.splitlines()))
    # left column sentence is contiguous after the split, not interleaved with "Proposition de la commission"
    assert "sich von diesen Aeusserun-\ngen des Chefbeamten" in out
    assert "Aeusserun-       Proposition" not in out
def test_split_columns_passes_single_column_through():
    assert split_columns(GR_FIXTURE.splitlines()) == GR_FIXTURE.splitlines()
def test_clean_pdf_text_twocolumn_unibe():
    out = clean_pdf_text(UNIBE_TWOCOL, ["fr"])
    assert "nn decret     mune" not in out and "convoquer" in out or "eonvoquer" in out
def test_normalise_chars(): assert normalise_chars("ﬁnanz x­y") == "finanz xy"
```

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement the functions in `chpipe/text_clean.py`** (`unwrap` builds paragraphs with `join_hyphen` on hyphen-ended lines; column width = 90th percentile via `statistics.quantiles` or sorted index).
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit** `feat(ch): text_clean module for pdftotext layout residue`

---

### Task 2: Phase A — fedlex_split returns the whole clean document

**Files:**
- Modify: `services/ch-pipeline/chpipe/fedlex_split.py` (`split_fedlex_text`, lines 454–573 on main)
- Test: `services/ch-pipeline/tests/test_fedlex_split.py`

**Interfaces:**
- Changes: `split_fedlex_text(raw: str) -> tuple[list[akn.Article], str]`: the second value becomes the whole document in reading order (title/preamble lines before the first article, article headings as `"Art. N <marginal>"`, article bodies, section lines, everything after `_TAIL_BREAK`), each line passed through `_tidy`, hyphen-wrapped lines joined with `text_clean.join_hyphen` (vocabulary from `text_quality._vocabulary(["de","fr","it"])`), marginal-column fragments dropped (they are the article titles already emitted), paragraphs separated by one blank line. Articles unchanged.
- Produces: `clean_fedlex_text(raw: str) -> str` = `split_fedlex_text(raw)[1]` (convenience for the stage and the gate).

- [ ] **Step 1: Write the failing tests** (extend `test_fedlex_split.py` using the existing `COL0` fixture and a new marginal-layout fixture copied from the SR 220 de 2020-04-01 edition, version_id 610366, chars 19,000–22,000)

```python
def test_text_keeps_preamble_and_tail():
    _, text = split_fedlex_text(COL0)
    assert text.startswith("Bundesverfassung\nder Schweizerischen Eidgenossenschaft")  # title lines survive
    assert "Angenommen in der Volksabstimmung vom 19. April 1874" in text
    assert "AS 1 1; BS 1 3" not in text                 # footnote block gone
    assert "Übersetzung1" not in text and "\n1\n" not in text

def test_text_marginal_layout_drops_margin_and_joins_hyphens():
    _, text = split_fedlex_text(SR220_MARGINAL)
    assert "2. Auf Grund" not in text.split("Art. 34")[1][:40]   # marginal column not spliced into the body
    assert "Ergänzung des Schweizerischen Zivilgesetzbuches. BG" not in text
    assert "mitgeteilt, so beurteilt" in text               # "mit-\ngeteilt" joined
    assert "Art. 34 2. Auf Grund" in text or "Art. 34" in text

def test_articles_unchanged_by_text_product():
    a_before = [(a.e_id, a.text) for a in split_fedlex_text(COL0)[0]]
    assert a_before == EXPECTED_COL0_ARTICLES   # copy from the existing test's expectations
```

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — in the loop, the `current is None` branch appends tidied non-section lines (body part only under `marginal_layout`) to `text_lines`; `close()` appends the body; headings keep the existing `"Art. N title"` line; join `text_lines` into paragraphs with `text_clean.unwrap` is NOT used here (the splitter already knows the structure): instead collect lines per article/paragraph and join hyphens with `text_clean.join_hyphen`. Fix any existing test that asserted the old article-only `text`.
- [ ] **Step 4: Run `pytest tests/test_fedlex_split.py -v`** — Expected: PASS, article expectations untouched.
- [ ] **Step 5: Commit** `feat(ch): fedlex_split emits the whole clean document as its text product`

---

### Task 3: Phase A — stage writes raw to `akn_xml`, clean to `full_text`

**Files:**
- Modify: `services/ch-pipeline/chpipe/stages/fedlex_pdf_text_stage.py` (`_process_one` 117–180, `_RESPLIT_ROWS`/`_RESPLIT_ROWS_ALL` 231–246, `resplit` 248–293)
- Test: `services/ch-pipeline/tests/test_fedlex_pdf_text_stage.py` (DB, `CHPIPE_TEST_DSN`)

**Interfaces:**
- Consumes: `fedlex_split.split_fedlex_text`, `parse_akn_stage.store_articles(conn, version_id, articles) -> int`, `db.complete_version(conn, version_id, "parsed", akn_xml=…, full_text=…, fetched_at=…)` (both columns already allowed).
- Changes: resplit selects `COALESCE(akn_xml, full_text) AS raw_text`; for each row: `articles, clean = split_fedlex_text(raw_text)`; in ONE transaction: `store_articles` (only when `articles` non-empty, as today) and `UPDATE ch_act_version SET akn_xml = COALESCE(akn_xml, full_text), full_text = %s, updated_at = now() WHERE version_id = %s`. Rows with no articles still get the clean text. `_process_one` (new editions): after the quality gate, run the split and write `akn_xml=text, full_text=clean` plus articles.
- Produces: `FedlexPdfTextReport` gains `cleaned: int`.

- [ ] **Step 1: Write the failing DB tests**

```python
def test_resplit_moves_raw_to_akn_xml_and_cleans_full_text(conn, settings):
    vid = _insert_pdf_edition(conn, full_text=COL0, akn_xml=None, stage="parsed")
    fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _row(conn, vid)
    assert row["akn_xml"] == COL0
    assert "AS 1 1; BS 1 3" not in row["full_text"] and row["article_count"] == 2

def test_resplit_is_idempotent_reads_akn_xml(conn, settings):
    vid = _insert_pdf_edition(conn, full_text="already clean", akn_xml=COL0, stage="parsed")
    fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _row(conn, vid)
    assert row["akn_xml"] == COL0 and "Art. 2" in row["full_text"] and row["full_text"] != "already clean"

def test_resplit_articleless_edition_still_cleaned(conn, settings):
    vid = _insert_pdf_edition(conn, full_text="Titel\n8\nText ohne Artikel\n", akn_xml=None, stage="parsed")
    fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _row(conn, vid)
    assert row["akn_xml"].startswith("Titel") and "\n8\n" not in row["full_text"] and (row["article_count"] or 0) == 0
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** per the Interfaces block; keep `RESPLIT_BATCH = 200` and keyset pagination.
- [ ] **Step 4: Run `pytest tests/test_fedlex_pdf_text_stage.py -v`** — PASS.
- [ ] **Step 5: Commit** `feat(ch): fedlex-pdf-text resplit keeps raw in akn_xml and stores clean full_text`

- [ ] **Step 6: Pilot + gate on cthulhu** (operator; after deploy of the branch to `~/lawrider/repo` or via a checkout of the branch there)

```bash
# before: fingerprint of the change log for pdf pairs
docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod -Atc "
SELECT count(*), md5(string_agg(c::text, '|' ORDER BY c::text))
FROM ch_act_change c JOIN ch_act_version v ON v.version_id = c.from_version_id WHERE v.source='fedlex_pdf'" > /data/ch-corpus/logs/phaseA-change-before.txt
docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod -Atc "
SELECT count(*), sum(article_count) FROM ch_act_version WHERE source='fedlex_pdf' AND stage='parsed'" > /data/ch-corpus/logs/phaseA-articles-before.txt
cd ~/lawrider/repo/services/ch-pipeline
CHPIPE_RESPLIT=all CHPIPE_LIMIT=200 nice -n 10 ionice -c3 ./run-stage.sh fedlex-pdf-text
python scripts/text_damage_probe.py --dsn "$CHPIPE_DSN" --sample /data/ch-corpus/bench/text-damage-sample.json --out /data/ch-corpus/logs/text-damage-phaseA-pilot.json
```

Expected on the editions touched by the pilot: `glued_refs` share < 0.5 %, `hyphen_breaks` share < 1 %, `article_count` sum unchanged. Then the full run in tmux `chclean-a` (≈2 h), re-run both fingerprints and the probe; both fingerprints identical, probe within acceptance. If the article fingerprint differs: stop, do not run `rediff.py`; investigate the splitter diff.

- [ ] **Step 7: Verify serving**: `ch_get_act_text` for SR 220 de as_of 2009-06-01 returns paragraphs without `werden.322`-style refs (direct tool test recipe: scratchpad `ch-tools-e2e.sh` pattern, node fetch inside `lawrider-app`). Record in the PR.

- [ ] **Step 8: The 2,570 article-less editions**: `SELECT version_id, act_id, lang, date_applicability, length(akn_xml) FROM ch_act_version WHERE source='fedlex_pdf' AND stage='parsed' AND COALESCE(article_count,0)=0 ORDER BY random() LIMIT 10`; read their raw text and classify (scan without text layer / table-only act / splitter miss). A splitter miss on ≥ 3 of 10 → open a follow-up Plane item with the examples, do not widen this plan. Then re-run the LEXAI-2046 400-pair probe (`~/lawrider/gcp-home-archive/ch-split-fix/`, see memory `project_ch_pit_pdf_era_noise`) and record whether the ≥ 0.98 bucket collapsed; this is the input for CH-PiT v4, not a gate here.

---

### Task 4: Migration 227 + raw-text archive

**Files:**
- Create: `mcp_backend/src/migrations/227_ch_text_clean_state.sql` (227 = next after 226 on main at 2026-11-13; renumber at PR time if main moved)
- Create: `services/ch-pipeline/chpipe/raw_text_archive.py`
- Test: `services/ch-pipeline/tests/test_raw_text_archive.py`, `services/ch-pipeline/tests/test_migration_227.py` (DB)
- Modify: `services/ch-pipeline/tests/conftest.py` (add `apply_migration_227(conn)` next to `apply_migration_200`)

**Interfaces:**
- Produces (SQL): `ch_text_clean_state(doc_id text PRIMARY KEY, spider text NOT NULL, cleaner_version smallint, raw_sha256 text, cleaned_at timestamptz, attempts smallint NOT NULL DEFAULT 0, last_error text)`, index `idx_ch_text_clean_pending ON ch_text_clean_state (spider, doc_id) WHERE cleaned_at IS NULL`. First statement `SET lock_timeout = '3s'`. No seed (the stage seeds, Task 5). Idempotent (`IF NOT EXISTS`).
- Produces: `raw_text_archive.path_for(raw_dir: pathlib.Path, spider: str, doc_id: str) -> pathlib.Path` = `raw_dir.parent / "raw-text" / spider / f"{doc_id}.txt.gz"`; `save(raw_dir, spider, doc_id, text: str) -> str` (writes gzip atomically via temp file + `os.replace`, returns sha256 hex of the UTF-8 text; if the file exists and its sha matches, no rewrite); `load(raw_dir, spider, doc_id) -> str`; `sha256_of(text: str) -> str`.

- [ ] **Step 1: Write the failing tests**

```python
def test_save_then_load_roundtrip(tmp_path):
    sha = save(tmp_path / "raw", "CH_BVGer", "A-1_2020", "raw text ä")
    assert load(tmp_path / "raw", "CH_BVGer", "A-1_2020") == "raw text ä"
    assert path_for(tmp_path / "raw", "CH_BVGer", "A-1_2020") == tmp_path / "raw-text" / "CH_BVGer" / "A-1_2020.txt.gz"
    assert sha == sha256_of("raw text ä")

def test_save_does_not_overwrite_different_existing(tmp_path):
    save(tmp_path / "raw", "S", "d", "first")
    with pytest.raises(FileExistsError): save(tmp_path / "raw", "S", "d", "second")

def test_migration_227_creates_state_table(conn):
    apply_migration_227(conn); apply_migration_227(conn)   # twice: idempotent
    cols = {r[0] for r in conn.execute("select column_name from information_schema.columns where table_name='ch_text_clean_state'")}
    assert {"doc_id","spider","cleaner_version","raw_sha256","cleaned_at","attempts","last_error"} <= cols
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** the SQL file (header comment: why a side table, pointing at migration 200's reasoning) and the module.
- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** `feat(ch): ch_text_clean_state side table and raw-text archive`

---

### Task 5: Phase B — `clean-text` stage

**Files:**
- Create: `services/ch-pipeline/chpipe/stages/clean_text_stage.py`
- Modify: `services/ch-pipeline/chpipe/db.py` (add `claim_for_clean`, `stamp_clean`, `fail_clean`, `seed_clean_state`)
- Modify: `services/ch-pipeline/run-stage.sh:67` (add `clean-text` to the spider family `index|fetch|extract|ocr|load|citations|portals-discover`)
- Test: `services/ch-pipeline/tests/test_clean_text_stage.py` (DB), `tests/test_db_queue.py` (claim), `tests/test_entry_points.py` (module has `main()`)

**Interfaces:**
- Produces: `db.seed_clean_state(conn) -> int`: `INSERT INTO ch_text_clean_state (doc_id, spider) SELECT doc_id, spider FROM ch_court_decisions WHERE stage='loaded' AND text_source IN ('pdf','ocr') AND spider <> ALL(%s) AND doc_id IS NOT NULL ON CONFLICT DO NOTHING` with `OWN_REFLOW_SPIDERS`; returns rowcount.
- Produces: `db.claim_for_clean(conn, limit: int, spider: str | None = None, max_attempts: int = 3) -> list[dict]` (rows `doc_id, spider, languages, full_text, text_quality`; `FROM ch_text_clean_state s JOIN ch_court_decisions d USING (doc_id) WHERE s.cleaned_at IS NULL AND s.attempts < %s AND d.stage='loaded' ORDER BY s.doc_id LIMIT %s FOR UPDATE OF s SKIP LOCKED`).
- Produces: `db.stamp_clean(conn, doc_id: str, raw_sha256: str, cleaner_version: int) -> None`, `db.fail_clean(conn, doc_id: str, error: str) -> None` (attempts + 1, last_error), `db.ensure_clean_state_stamped(conn, doc_id: str, spider: str, raw_sha256: str, cleaner_version: int) -> None` (`INSERT … ON CONFLICT (doc_id) DO UPDATE SET cleaned_at=now(), raw_sha256=EXCLUDED.raw_sha256, cleaner_version=EXCLUDED.cleaner_version`; used by Task 7).
- Produces: `clean_text_stage.run(settings: Settings, limit: int | None = None, spider: str | None = None, batch: int = 200) -> CleanTextReport` with fields `cleaned, unchanged, failed, archived_bytes, with_replacement_chars` (rows whose raw contains U+FFFD are cleaned like the rest and counted; their PDFs are gone, so a re-fetch from entscheidsuche is a separate follow-up, listed in the README section of Task 9). Per row: `languages = metadata-free list(row["languages"] or [])`; `sha = raw_text_archive.save(...)`; on `FileExistsError` (archive from an earlier run, stored text already clean) `raw = raw_text_archive.load(...)` and `sha = sha256_of(raw)`, which guarantees idempotency; `clean = text_clean.clean_pdf_text(raw, languages)`; if `clean == raw`: `stamp_clean` only (`unchanged`); else one transaction: `UPDATE ch_court_decisions SET full_text=%s, updated_at=now() WHERE doc_id=%s` then `stamp_clean`. `CHPIPE_SEED=1` runs `seed_clean_state` and exits. `main()` reads `CHPIPE_LIMIT`, `CHPIPE_SPIDER`, `CHPIPE_BATCH`.

- [ ] **Step 1: Write the failing DB tests**

```python
def test_seed_selects_pdf_and_ocr_not_rpw(conn):
    _insert_decision(conn, doc_id="a", spider="CH_BVGer", text_source="pdf", full_text=GR_FIXTURE)
    _insert_decision(conn, doc_id="b", spider="CH_WEKO_RPW", text_source="pdf", full_text="x")
    _insert_decision(conn, doc_id="c", spider="GE_Gerichte", text_source="html", full_text="x")
    assert db.seed_clean_state(conn) == 1

def test_run_archives_then_updates_then_stamps(conn, settings, tmp_path):
    ...; report = clean_text_stage.run(settings)
    assert report.cleaned == 1
    assert raw_text_archive.load(settings.raw_dir, "CH_BVGer", "a") == GR_FIXTURE
    assert "iden-\n" not in _full_text(conn, "a")
    assert _state(conn, "a")["cleaner_version"] == text_clean.CLEANER_VERSION

def test_run_rerun_after_update_without_stamp_is_idempotent(conn, settings):
    # simulate crash after UPDATE: archive exists, full_text already clean, state unstamped
    ...; report = clean_text_stage.run(settings)
    assert report.unchanged == 1 and _full_text(conn, "a") == clean_before

def test_run_reflowed_text_is_unchanged(conn, settings):
    _insert_decision(conn, doc_id="p", spider="CH_VB", text_source="pdf", full_text=PORTAL_FIXTURE.replace(" ", " "))
    report = clean_text_stage.run(settings); assert report.unchanged == 1

def test_claim_skips_failed_rows_after_three_attempts(conn): ...
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** stage + db functions + `run-stage.sh` entry (`clean-text` joins the spider family so `./run-stage.sh clean-text CH_BVGer` works).
- [ ] **Step 4: Run `pytest tests/test_clean_text_stage.py tests/test_db_queue.py tests/test_entry_points.py -v`** — PASS.
- [ ] **Step 5: Commit** `feat(ch): clean-text stage for PDF decisions with raw-text archive`

---

### Task 6: Phase B — consumer check before the backfill (tuned-parser guard)

**Files:**
- Create: `services/ch-pipeline/scripts/clean_text_ab.py`
- Test: none (operator script); `pytest tests/test_entry_points.py` must still pass.

**Interfaces:**
- Produces CLI: `--dsn`, `--sample FILE` (Task 0 file, decisions part), prints per-document and aggregate: `citations.extract_cases` and `extract_statutes` counts on raw vs `clean_pdf_text(raw, languages)` (sets compared by `(abbr, article)` / `(court, docket)` as the dataclasses expose them), `text_quality.score` before/after, and markers before/after. Exit code 1 when aggregate citations after < 0.99 × before or mean quality drops by > 0.01.

- [ ] **Step 1: Write the script.**
- [ ] **Step 2: Run on cthulhu** against the fixed sample: `python scripts/clean_text_ab.py --dsn "$CHPIPE_DSN" --sample /data/ch-corpus/bench/text-damage-sample.json`. Expected: exit 0; statutes count after ≥ before (hyphen-split act names now match). If exit 1: fix `text_clean` (not the extractor) and repeat; record both numbers in the PR.
- [ ] **Step 3: Commit** `chore(ch): raw-vs-clean A/B for citations and quality`

- [ ] **Step 4: Measure trigger and GIN cost on 1,000 rows (operator)**

```bash
CHPIPE_SEED=1 ./run-stage.sh clean-text            # seeds ≈499K state rows
time CHPIPE_LIMIT=1000 nice -n 10 ionice -c3 ./run-stage.sh clean-text CH_BVGer
docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod -Atc "select pg_size_pretty(pg_relation_size('idx_ch_court_fts'))"
```

Decide batch size and windows from the measured seconds/row; write them into the README section (Task 9). If > 50 ms/row, run the backfill with `ALTER INDEX idx_ch_court_fts SET (fastupdate = on)` (default) and plan the REINDEX; if the GIN grows > 1 GB during the full run, REINDEX is mandatory.

- [ ] **Step 5: Full backfill (operator, tmux `chclean-b`, nights)**: `nice -n 10 ionice -c3 ./run-stage.sh clean-text` until `SELECT count(*) FROM ch_text_clean_state WHERE cleaned_at IS NULL AND attempts < 3` is 0. Then:

```bash
docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod -c "SET statement_timeout=0; REINDEX INDEX CONCURRENTLY idx_ch_court_fts;"   # ≈3.5 h, outside 10:15 Kyiv
docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod -c "
UPDATE ch_citation_state s SET extracted_at = NULL, attempts = 0 FROM ch_court_decisions d JOIN ch_text_clean_state c USING (doc_id)
WHERE d.ecli = s.ecli AND c.cleaned_at IS NOT NULL"
~/ch-citations-reextract.sh      # ≈3.5 h at 6 workers; then citations-resolve + reports_cit
python scripts/text_damage_probe.py --dsn "$CHPIPE_DSN" --sample /data/ch-corpus/bench/text-damage-sample.json --out /data/ch-corpus/logs/text-damage-phaseB.json
```

Expected: probe within acceptance; `citations-report` totals ≥ `citations-report-3.json` (cases 8,954,474; legislation article-resolved 6,390,217); 20 PDF decisions read by eye; `ch_get_court_decision` for `ECLI:CH:GR_Gerichte:GR_KG_001_PKG-2001-13_0000-00-00` returns paragraphs.

---

### Task 7: Phase B — nightly path cleans new PDF/OCR decisions

**Files:**
- Modify: `services/ch-pipeline/chpipe/stages/extract_stage.py:48-69` (`extract_one`)
- Modify: `services/ch-pipeline/chpipe/stages/ocr_stage.py:46-56` (`_ocr_one`)
- Test: `services/ch-pipeline/tests/test_extract_stage.py`, `tests/test_ocr_stage.py`

**Interfaces:**
- Changes: `extract_one` for `source != "html"` and `row["spider"] not in text_clean.OWN_REFLOW_SPIDERS`: `raw = text_extract.from_pdf(path)`; `raw_text_archive.save(settings.raw_dir, row["spider"], row["doc_id"], raw)`; `text = text_clean.clean_pdf_text(raw, languages)`; quality scored on `text`. Same in `_ocr_one` for the OCR text. Rows written this way also get a stamped `ch_text_clean_state` row (`db.ensure_clean_state_stamped(conn, doc_id, spider, sha, version)`), so a later backfill never re-claims them.

- [ ] **Step 1: Write the failing tests** (`test_extract_stage.py` uses fixture `decision_zg.pdf`; assert the stored `full_text` has `markers()["hyphen_breaks"] == 0` and the archive file exists; a `CH_WEKO_RPW` row is left untouched).
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pytest tests/test_extract_stage.py tests/test_ocr_stage.py tests/test_delta.py -v`** — PASS.
- [ ] **Step 5: Commit** `feat(ch): extract and ocr stages store cleaned PDF text`

---

### Task 8: Phase C — cantonal PDF editions

**Files:**
- Modify: `services/ch-pipeline/chpipe/pdf_text.py` (`raw_text`, `raw_text_of_bytes`, `clean_pages`, `_join`)
- Modify: `services/ch-pipeline/chpipe/stages/pdf_text_stage.py` (resplit mode `CHPIPE_RESPLIT=all`, like Task 3's `_RESPLIT_ROWS_ALL`)
- Test: `services/ch-pipeline/tests/test_pdf_text.py`, `tests/test_pdf_text_stage.py`
- Fixtures: `tests/fixtures/pdftext_zh_marginal_splice.txt` (the `akn_xml` of the version owning `ch_act_article.article_id = 7584084`, first 4,000 chars), `tests/fixtures/pdftext_ti_ligatures.txt` (2,000 chars around the `ﬁ` in version 342144).

**Interfaces:**
- Changes: `raw_text`/`raw_text_of_bytes` apply `text_clean.normalise_chars`; `_join` delegates the hyphen decision to `text_clean.join_hyphen` with the vocabulary of the edition's language (`pdf_text.extract(..., lang)` already knows it; add a `vocabulary` parameter threaded to `_join`); the full_text product of `extract` is built from `_paragraphs` (joined lines), not from the raw page lines; `clean_pages`/`_dedent` detect a left marginal column (two-column lines where the left part is ≤ 25 chars and ends before a run of ≥ 3 spaces) and drop it from the body line instead of splicing.
- Changes: `pdf_text_stage.resplit(settings, limit, everything: bool)`; `CHPIPE_RESPLIT=all` re-splits every parsed `lexwork_pdf`/`lexfind`/`zhlex` row from `akn_xml` and rewrites `full_text` and articles.

- [ ] **Step 1: Write the failing tests**

```python
# pdf_text.split_text(raw: str, lang: str) -> Extraction is the entry the stage's resplit uses (the fixtures are text, not PDFs)
def test_marginal_column_not_spliced_into_article():
    ex = pdf_text.split_text(ZH_FIXTURE, "de")
    art = next(a for a in ex.articles if a.article_number == "24")
    assert "Betreibungsist" not in art.text and "gemeldet ist oder" in art.text
def test_ligatures_normalised():
    ex = pdf_text.split_text(TI_FIXTURE, "it")
    assert "ﬁ" not in ex.full_text and "finanziaria" in ex.full_text
def test_full_text_has_no_hyphen_breaks(): assert markers(pdf_text.split_text(ZH_FIXTURE, "de").full_text)["hyphen_breaks"] == 0
def test_resplit_all_rewrites_full_text(conn, settings): ...
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement** (keep `pdf_text`'s measured gate numbers: run `scripts/pdf_gate.py` if present and record its median before/after; must not drop).
- [ ] **Step 4: Run `pytest tests/test_pdf_text.py tests/test_pdf_text_stage.py tests/test_zhlex.py tests/test_zh_fetch_parse_stages.py -v`** — PASS.
- [ ] **Step 5: Commit** `fix(ch): cantonal pdf text: ligatures, hyphens, marginal column`
- [ ] **Step 6: Operator run**: `CHPIPE_RESPLIT=all nice -n 10 ionice -c3 ./run-stage.sh pdf-text` per `CHPIPE_SOURCE` (lexwork_pdf, lexfind) and the zhlex equivalent (`zh-parse` with `CHPIPE_REPROVENANCE`-style reparse flag, or the same `CHPIPE_RESPLIT=all` if zhlex rows go through `pdf_text_stage`; confirm from the fixture's source row). Probe afterwards; fingerprint `ch_act_change` for these sources before/after as in Task 3 and expect changes ONLY where article text changed (count them, read 10).

---

### Task 9: Nightly damage metrics, README runbook, Plane

**Files:**
- Modify: `services/ch-pipeline/chpipe/reports.py` (add `text_damage(conn, sample_pct: float = 0.2) -> list[dict]`)
- Modify: `services/ch-pipeline/chpipe/delta.py` (after `extract_stage.run`: log one line per source/spider from `reports.text_damage`, `WARNING` when `hyphen_share > CHPIPE_DAMAGE_MAX_HYPH` (default 0.02) or `glued_share > 0.01`)
- Modify: `services/ch-pipeline/README.md` (section "Text cleanup (2026-11)": the operator commands of Tasks 3, 6, 8 with the measured batch size and windows)
- Test: `services/ch-pipeline/tests/test_reports.py`, `tests/test_delta.py`

**Interfaces:**
- Produces: `reports.text_damage(conn, sample_pct) -> list[dict]` rows `{"table": "ch_court_decisions"|"ch_act_version", "group": spider|source, "n": int, "hyphen_share": float, "glued_share": float, "page_number_share": float, "mean_line_len": float}` using `TABLESAMPLE SYSTEM (sample_pct)` and `text_damage.markers`.

- [ ] **Step 1: Write the failing tests** (`test_reports.py` fixture table with 3 rows: one hard-wrapped, two clean → `hyphen_share == 1/3`; `test_delta.py`: a monkeypatched `reports.text_damage` returning a row above threshold logs a WARNING containing `text damage`).
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**; write the README section; create the Plane item: `plane create LEXAI "CH: очищення PDF-текстів (fedlex_pdf, рішення, кантони)" "<p>Дизайн: docs/superpowers/specs/2026-11-13-ch-text-cleanup-design.md</p>"` and set its parent to LEXAI-2000 via `plane patch`.
- [ ] **Step 4: Run the full suite** `pytest -q` (expect the previous count + new tests, 0 failures) and `cd mcp_backend && npx tsc --noEmit` (no TS change expected, but migrations folder is in the repo the CI builds).
- [ ] **Step 5: Commit** `feat(ch): nightly text-damage metrics and cleanup runbook`

---

### Task 10: PR, deploy, verification

- [ ] **Step 1:** `git push -u origin feat/ch-text-cleanup && gh pr create --title "CH: clean pdftotext residue from full_text (fedlex_pdf, PDF decisions, cantonal)" --body-file <PR body with the baseline/after tables from Tasks 0, 3, 6, 8; end with the attribution line>`.
- [ ] **Step 2:** After merge, `deploy-lawrider-cthulhu.yml` applies migration 227 via `lawrider-migrate` and refreshes `~/lawrider/repo`; check `docker logs lawrider-migrate | tail` for `227`.
- [ ] **Step 3:** Run the operator phases in order A (Task 3 step 6) → B (Task 6 steps 4–5) → C (Task 8 step 6); each gated by the probe and the fingerprints. Record every number in the Plane item.
- [ ] **Step 4:** Next morning check `/data/ch-corpus/logs/delta-*.log` for the `text damage` lines: no WARNING.
- [ ] **Step 5:** Update memory `project_ch_text_cleanup.md` with the final numbers; move the Plane item to Done.
