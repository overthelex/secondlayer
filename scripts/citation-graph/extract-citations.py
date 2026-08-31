#!/usr/bin/env python3
"""
Citation Graph Paper — extract legislation citations from EDRSR court decisions.

Processes edrsr_fulltext partitions in parallel, extracting references to
Ukrainian legislation (law numbers, article references, codex citations).
Results are written to law_court_citations table.

Usage:
  python3 extract-citations.py --year 2024            # single year
  python3 extract-citations.py --all                  # all years
  python3 extract-citations.py --year 2024 --dry-run  # preview only
  python3 extract-citations.py --year 2024 --workers 4

Designed to run on prod (direct DB access, no network overhead).
Run in screen/tmux with low priority: nice -n 10 python3 extract-citations.py --all
"""

import argparse
import os
import re
import sys
import time
import json
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional

import psycopg2
from psycopg2.extras import execute_values

# ── Database connection ──────────────────────────────────────

DB_DSN = os.environ.get("DATABASE_URL", "postgresql://secondlayer:local_dev_password@localhost:5432/secondlayer_local")

def get_conn():
    conn = psycopg2.connect(DB_DSN)
    # Batch workload on a busy shared box: a worker's server-side cursor can sit
    # idle-in-transaction (CPU-bound extraction between fetches) long enough to
    # trip the server's idle_in_transaction_session_timeout, and a huge OFFSET
    # scan can trip statement_timeout. Either kills the worker connection mid-run
    # and (without retry) takes the whole multi-hour run down. This data is fully
    # reproducible from edrsr_fulltext, so disabling both for our sessions is safe.
    with conn.cursor() as c:
        c.execute("SET idle_in_transaction_session_timeout = 0")
        c.execute("SET statement_timeout = 0")
    conn.commit()
    return conn

# ── Citation patterns ────────────────────────────────────────

# Act number as it appears after «№», e.g. 2262-XII / 2262-ХІІ / 254к/96-ВР /
# 1199-2022-п / 1030а-12.
#
# The previous class was `[\d\-]{1,20}(?:\-[IVX]{1,5})?` and it captured NONE of
# these suffixes. `[\d\-]` is greedy and swallows the separating hyphen, after
# which the optional group needs a SECOND one and matches empty without
# backtracking — so Latin «2262-XII» was truncated to «2262-» exactly as
# reliably as Cyrillic «2262-ХІІ». The Latin-only [IVX] was a second, smaller
# defect on top. Measured on prod: of 168K sampled citation rows, not one
# carried a Roman suffix in either alphabet.
#
# Built piece by piece instead: numeric core, optional index letter, optional
# /YY, optional -YYYY, then ONE optional tail that is either a two-digit
# convocation code or a letter suffix. Letters are Latin and Cyrillic together
# because court texts mix them inside a single numeral («2755-VІ» is Latin V
# plus Cyrillic І); normalisation decides what they mean, extraction only has
# to keep them.
# Bounds are measured, not guessed: across all 293 049 acts the longest numeric
# core is 5 digits and the longest letter suffix is 2. The trailing lookahead
# then makes an out-of-range token match NOTHING rather than match a prefix --
# storing «12345» for a six-digit number would be the same silent-truncation
# bug this commit exists to remove, just with a different cause.
_ACT_NUM = (
    r'(\d{1,5}[а-яіїєґa-z]?'
    r'(?:/\d{2,4})?'
    r'(?:-\d{4})?'
    r'(?:-(?:\d{2}(?!\d)|[A-Za-zА-Яа-яІіЇїЄєҐґ]{1,6}))?)'
    r'(?![\dA-Za-zА-Яа-яІіЇїЄєҐґ/-])'
)


# Ukrainian law reference patterns
PATTERNS = {
    # "статті 3, 5 Закону України «Про ...»" or "ст. 3 ЗУ «Про ...»"
    "law_article": re.compile(
        r'(?:стат(?:т[іея]|ей)|ст\.)\s*'
        r'([\d,\s\-]{1,50})'
        r'\s+(?:Закону\s+України|ЗУ|Закону)\s+'
        # The number branch now REQUIRES «№», with the date optional in front of
        # it. It used to be (?:від|№), and «від» wins the alternation, so
        # «від 09.04.1992 № 2262-ХІІ» stored the DATE as the law number —
        # «20.12.1991» and «09.04.1992» are really sitting in law_number_raw
        # on prod today. A citation that gives only a date identifies nothing.
        r'(?:[«"]([^»"]{1,200})[»"]'
        r'|(?:від\s+\d{1,2}\.\d{1,2}\.\d{4}\s*(?:р\.|року)?\s*)?№\s*' + _ACT_NUM + r')',
        re.IGNORECASE | re.UNICODE
    ),
    # Codex references: "ст. 625 ЦК України", "ч. 1 ст. 3 КАС України"
    "codex_article": re.compile(
        r'(?:(?:ч(?:астин[аи]|\.)\s*\d+\s+)?'
        r'(?:стат(?:т[іея]|ей)|ст\.)\s*'
        r'([\d,\s\-]{1,50}))\s+'
        r'(ЦК|КК|ГК|ГПК|КПК|КАС|ЦПК|КЗпП|СК|ЗК|ПК|МК|БК|ВК|ЛК|ЖК|КУпАП|КАСУ)'
        r'(?:\s+України)?',
        re.IGNORECASE | re.UNICODE
    ),
    # Transitional provisions of the Tax Code (LEXAI-1817): «підпункту 38.6 пункту 38
    # підрозділу 10 розділу ХХ «Перехідні положення» ПК України», «п.п. 69.22 п. 69
    # підрозд. 10 розд. XX ПКУ», «пункту 38.6. Підрозділу «Інших Перехідних положень»
    # Податкового Кодексу України». Anchored on «підрозділ» + (розділ XX | «Перехідн…»)
    # so ordinary article sub-points (пп. 14.1.235 … статті 14) never match. NB розділ
    # number appears both as Latin XX and Cyrillic ХХ in EDRSR texts.
    "transitional_provision": re.compile(
        r'(?:підпункт[а-яїіє]{0,3}|пункт[а-яїіє]{0,3}|п\.\s?п\.|пп\.|п\.)\s*'
        r'(\d{1,3}(?:[.\-]\d{1,3}){1,2})\.?'                       # dotted point: 38.6 / 69.22 / 38.6.1
        r'(?:\s+(?:пункт[а-яїіє]{0,3}|п\.)\s*\d{1,3})?'            # optional parent «пункту 38»
        r'\s+підрозд(?:іл[а-яїіє]{0,3}|\.)'
        r'(?:\s*(\d{1,2}))?'                                        # optional підрозділ number
        r'(?:\s+розд(?:іл[а-яїіє]{0,3}|\.)\s*[XХxх]{2}(?![XХxх])'  # anchor A: розділ XX (Latin/Cyrillic)
        r'|[^.\n]{0,40}?Перехідн)',                                 # anchor B: named «…Перехідн…» subdivision
        re.IGNORECASE | re.UNICODE
    ),
    # Constitution: "стаття 124 Конституції України"
    "constitution": re.compile(
        r'(?:стат(?:т[іея]|ей)|ст\.)\s*'
        r'([\d,\s\-]{1,50})\s+'
        r'Конституці[їі]\s+України',
        re.IGNORECASE | re.UNICODE
    ),
    # Case number references: "справа № 200/1234/24"
    "case_reference": re.compile(
        r'(?:справ[аи]\s*)?№\s*(\d{1,4}/\d{1,10}/\d{2,4})',
        re.IGNORECASE
    ),
    # Law by number: "Закон України від 01.01.2020 № 123-IX"
    "law_by_number": re.compile(
        r'Закон(?:у|ом)?\s+України\s+'
        r'(?:від\s+(\d{2}\.\d{2}\.\d{4})\s*(?:р\.|року)?\s*)?'
        r'№\s*' + _ACT_NUM,
        re.IGNORECASE | re.UNICODE
    ),
    # Постанова Пленуму Верховного Суду
    "supreme_court_ruling": re.compile(
        r'(?:постанов[аиі]|ухвал[аиі])\s+'
        r'(?:Пленуму\s+)?'
        r'(?:Верховного\s+Суду|ВС|Великої\s+Палати\s+ВС)',
        re.IGNORECASE | re.UNICODE
    ),
}

# Codex full names for normalization
CODEX_NAMES = {
    "ЦК": "Цивільний кодекс України",
    "КК": "Кримінальний кодекс України",
    "ГК": "Господарський кодекс України",
    "ГПК": "Господарський процесуальний кодекс України",
    "КПК": "Кримінальний процесуальний кодекс України",
    "КАС": "Кодекс адміністративного судочинства України",
    "КАСУ": "Кодекс адміністративного судочинства України",
    "ЦПК": "Цивільний процесуальний кодекс України",
    "КЗпП": "Кодекс законів про працю України",
    "СК": "Сімейний кодекс України",
    "ЗК": "Земельний кодекс України",
    "ПК": "Податковий кодекс України",
    "МК": "Митний кодекс України",
    "БК": "Бюджетний кодекс України",
    "ВК": "Водний кодекс України",
    "ЛК": "Лісовий кодекс України",
    "ЖК": "Житловий кодекс України",
    "КУпАП": "Кодекс України про адміністративні правопорушення",
}

@dataclass
class Citation:
    doc_id: int
    citation_type: str  # law_article, codex_article, constitution, case_reference, law_by_number, supreme_court_ruling
    law_ref: str        # normalized law/codex identifier
    article_ref: str    # article number(s) or empty
    raw_match: str      # original matched text

@dataclass
class PartitionStats:
    year: int
    rows_processed: int = 0
    citations_found: int = 0
    by_type: dict = field(default_factory=Counter)
    top_laws: dict = field(default_factory=Counter)
    elapsed_sec: float = 0

# ── Extraction ───────────────────────────────────────────────

# Max width of a "real" article-range expansion. Ukrainian codes have at most
# a few hundred base articles, so a legitimate "ст. 5-9" spans a handful of numbers.
# Anything wider is almost certainly a flattened-superscript list misread as a range
# (e.g. "ст. 1115, 1117, 1119 - 11111" where 1115 == article 111⁵ == "111-5").
MAX_RANGE_SPAN = 20


def parse_article_numbers(raw: str, act: str | None = None) -> list[str]:
    """Parse an article enumeration into a list of canonical article numbers.

    Handles three shapes:
      - plain lists: '3, 5 та 12'            -> ['3', '5', '12']
      - true ranges: '7-9'                   -> ['7', '8', '9']
      - dashed/superscript articles: '129-1' -> ['129-1']   (NOT a range)
        and their OCR-flattened form '1291'  -> ['129-1']

    Procedural codes (ГПК/ЦПК/КАС) heavily use superscript article numbers
    (стаття 111⁵). In source text the superscript is flattened to a trailing
    digit ('1115'). The previous implementation (a) treated every '-' as a
    numeric range — so '1119 - 11111' exploded into ~10k phantom articles, and
    (b) lost genuine dashed articles like '129-1' (range(129,2) is empty).
    """
    articles = []
    # Normalise list separators ("та"/"і"/"й" = "and"). Use word boundaries so we
    # don't strip the Cyrillic letters out of unrelated tokens.
    raw = re.sub(r"\s+(?:та|і|й)\s+", ",", raw)
    for part in raw.split(","):
        part = part.strip().strip(".")
        if not part:
            continue
        if "-" in part:
            a, b = (s.strip() for s in part.split("-", 1))
            if a.isdigit() and b.isdigit():
                ai, bi = int(a), int(b)
                span = bi - ai
                # Genuine narrow ascending range -> expand.
                if 0 < span <= MAX_RANGE_SPAN:
                    articles.extend(str(n) for n in range(ai, bi + 1))
                # Dashed article number written with an explicit hyphen
                # (e.g. "129-1"): keep canonical form, do NOT expand.
                elif span <= 0 or len(b) <= 2:
                    articles.append(f"{a}-{b}")
                # Anything else (wide "range" like 1119-11111) is a flattened
                # superscript list mis-joined by a stray hyphen: keep only the
                # endpoints in canonical dashed form, drop the phantom middle.
                else:
                    articles.append(normalize_flattened(a, act))
                    articles.append(normalize_flattened(b, act))
            else:
                articles.append(part)
        elif part.isdigit():
            articles.append(normalize_flattened(part, act))
    return articles


_ART_INDEX: dict[str, set[str]] = {}
_ART_INDEX_READY = False


def _load_article_index() -> None:
    """Current article numbers per act, keyed on the act title the builder matches.

    One query per worker process. Failure is not fatal: an empty index makes
    normalize_flattened keep what the document actually says, which is the safe
    direction — see the note there.
    """
    global _ART_INDEX_READY
    if _ART_INDEX_READY:
        return
    _ART_INDEX_READY = True
    titles = sorted(set(CODEX_NAMES.values()) | {"Конституція України"})
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT l.title, a.article_number "
                "FROM legislation l JOIN legislation_articles a ON a.legislation_id = l.id "
                "WHERE a.is_current AND l.title = ANY(%s)",
                (titles,),
            )
            for title, art in cur.fetchall():
                _ART_INDEX.setdefault(title, set()).add(str(art).strip())
    except Exception as e:                                    # noqa: BLE001
        print(f"[warn] article index unavailable ({type(e).__name__}); "
              f"flattened-superscript splitting disabled", flush=True)


def normalize_flattened(num: str, act: str | None = None) -> str:
    """Map an OCR-flattened superscript article number to canonical 'base-index'.

    Ukrainian procedural codes number inserted articles with a superscript:
    стаття 111⁵ (article 111, insert 5). When the superscript collapses into the
    base it becomes '1115', which has to be read as 111-5.

    This USED to split every 4-5 digit token unconditionally, and that was wrong
    for any act with genuine four-digit articles. The Civil Code has 301 of them
    (up to 1308), so «ст. 1054 ЦК» was stored as '105-4', «ст. 1268» as '126-8',
    «ст. 1166» as '116-6' — the whole law of obligations, delict and inheritance.
    Measured on prod 2026-08-18: 9 536 839 rows carried the split signature across
    65 acts, of which 5 320 562 resolved to nothing; on the Civil Code alone
    4 624 318 citations pointed at articles that cannot exist. The docstring
    promised the registry would disambiguate downstream. Nothing did.

    So the registry decides here, where the act is still known: keep the literal
    reading when the act really has that article, split only when it does not and
    the split form does exist. With no index (act unknown, or the DB unreachable)
    keep the literal — it is what the document says, and a wrong split loses the
    citation silently.
    """
    if len(num) <= 3 or not num.isdigit():
        return num
    split = f"{num[:3]}-{num[3:]}"
    if not act:
        return num
    _load_article_index()
    known = _ART_INDEX.get(act)
    if not known:
        return num
    if num in known:
        return num
    if split in known:
        return split
    return num


MAX_TEXT_LEN = 10_000

def extract_citations_from_text(doc_id: int, text: str) -> list[Citation]:
    citations = []
    if len(text) > _MAX_TEXT_LEN:
        text = text[:_MAX_TEXT_LEN]

    for m in PATTERNS["law_article"].finditer(text):
        articles_raw = m.group(1)
        law_name = m.group(2) or m.group(3) or ""
        for art in parse_article_numbers(articles_raw, law_name.strip()):
            citations.append(Citation(doc_id, "law_article", law_name.strip(), art, m.group(0)[:200]))

    for m in PATTERNS["codex_article"].finditer(text):
        articles_raw = m.group(1)
        codex_abbr = m.group(2).upper()
        codex_name = CODEX_NAMES.get(codex_abbr, codex_abbr)
        for art in parse_article_numbers(articles_raw, codex_name):
            citations.append(Citation(doc_id, "codex_article", codex_name, art, m.group(0)[:200]))

    for m in PATTERNS["constitution"].finditer(text):
        articles_raw = m.group(1)
        for art in parse_article_numbers(articles_raw, "Конституція України"):
            citations.append(Citation(doc_id, "constitution", "Конституція України", art, m.group(0)[:200]))

    # Transitional provisions (LEXAI-1817): dotted point numbers must NOT go through
    # parse_article_numbers (it drops non-integer tokens and range-expands dashes).
    # LEXAI-1818: keep the point EXACTLY as written — dash-numbered пункти (16-1
    # військовий збір, 52-1 covid) are a DIFFERENT numbering space from dotted
    # subpoints (38.6); normalising '-' to '.' collided with main-body point numbering
    # (16.1 = ст.16 п.16.1) and bound the wrong article. Disambiguation of sloppy court
    # renderings is the RESOLVER's job (dash→dotted fallback when no dash target exists).
    for m in PATTERNS["transitional_provision"].finditer(text):
        point = m.group(1).rstrip(".")
        citations.append(Citation(
            doc_id, "transitional_provision", "Податковий кодекс України", point, m.group(0)[:200]))

    for m in PATTERNS["case_reference"].finditer(text):
        citations.append(Citation(doc_id, "case_reference", m.group(1), "", m.group(0)[:200]))

    for m in PATTERNS["law_by_number"].finditer(text):
        law_num = m.group(2) or ""
        law_date = m.group(1) or ""
        ref = f"№{law_num}" + (f" від {law_date}" if law_date else "")
        citations.append(Citation(doc_id, "law_by_number", ref, "", m.group(0)[:200]))

    for m in PATTERNS["supreme_court_ruling"].finditer(text):
        citations.append(Citation(doc_id, "supreme_court_ruling", "ВС", "", m.group(0)[:200]))

    return citations

# ── Worker ───────────────────────────────────────────────────

_JUSTICE_KIND_FILTER = None
_USE_PARTITIONS = None
_TARGET_TABLE = "law_court_citations"
_CASE_TABLE = "case_citation_edges"
# Bulk-load mode: plain INSERT, no ON CONFLICT (target table must have NO unique
# index during load). Dedup + unique index are built once afterwards (deferred index).
_BULK_LOAD = False
# Skip the per-year justice_kind enrich UPDATE (defer it to a single end-of-run pass).
_NO_ENRICH = False
# Targeted mode (LEXAI-1817): restrict scanned rows to tsv @@ to_tsquery('simple', _TSQUERY).
# Lets a backfill touch only candidate docs (e.g. '38.6 | 69.22') instead of the whole corpus.
_TSQUERY = None
# Targeted mode by DOC ID (LEXAI-1947). --tsquery restricts by text, which cannot
# express "the documents whose stored citations are damaged". This takes a table
# of doc_ids instead, so a backfill can re-read exactly the affected decisions
# rather than the whole corpus.
_DOC_IDS_TABLE = None


def _doc_ids_cond() -> str | None:
    """The doc-id restriction, in one place.

    It is needed at four sites — both branches of process_chunk and both
    COUNT(*) queries in process_year — and the count MUST match the select or
    the chunk plan is sized for rows the query never returns.
    """
    if _DOC_IDS_TABLE is None:
        return None
    return f"doc_id IN (SELECT doc_id FROM {_DOC_IDS_TABLE})"

# Effective per-doc scan window; --max-text-len can raise it for targeted backfills
# where the citation may sit deep in a long decision.
_MAX_TEXT_LEN = MAX_TEXT_LEN

# case_reference is routed to the separate decision->case edge table, not the statute table
_STATUTE_TYPES = {"law_article", "codex_article", "constitution", "law_by_number", "supreme_court_ruling", "transitional_provision"}

def _check_partitions():
    global _USE_PARTITIONS
    if _USE_PARTITIONS is not None:
        return _USE_PARTITIONS
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_class WHERE relname = 'edrsr_fulltext_p_2020' AND relkind = 'r'")
        _USE_PARTITIONS = cur.fetchone() is not None
        cur.close()
        conn.close()
    except Exception:
        _USE_PARTITIONS = False
    return _USE_PARTITIONS

def process_chunk(args: tuple) -> dict:
    """Process a chunk of rows from a partition. Runs in a separate process.
    Each worker writes its own results on its own connection (parallel writes,
    no IPC of citation tuples back to the main process)."""
    year, offset, chunk_size, dry_run = args
    conn = get_conn()
    cur = conn.cursor(name=f"cite_{year}_{offset}")

    # Partitions carry justice_kind per row, so filter/select directly off the partition (no join needed).
    if _check_partitions():
        table = f"edrsr_fulltext_p_{year}"
        conds, params = [], []
        if _JUSTICE_KIND_FILTER is not None:
            conds.append("justice_kind = %s"); params.append(_JUSTICE_KIND_FILTER)
        if _TSQUERY is not None:
            conds.append("tsv @@ to_tsquery('simple', %s)"); params.append(_TSQUERY)
        if (_c := _doc_ids_cond()) is not None:
            conds.append(_c)
        where = f"WHERE {' AND '.join(conds)} " if conds else ""
        cur.execute(
            f"SELECT doc_id, full_text, justice_kind FROM {table} {where}OFFSET %s LIMIT %s",
            tuple(params + [offset, chunk_size]),
        )
    else:
        conds, params = ["adj_year = %s"], [year]
        if _JUSTICE_KIND_FILTER is not None:
            conds.append("justice_kind = %s"); params.append(_JUSTICE_KIND_FILTER)
        if _TSQUERY is not None:
            conds.append("tsv @@ to_tsquery('simple', %s)"); params.append(_TSQUERY)
        if (_c := _doc_ids_cond()) is not None:
            conds.append(_c)
        cur.execute(
            f"SELECT doc_id, full_text, justice_kind FROM edrsr_fulltext WHERE {' AND '.join(conds)} OFFSET %s LIMIT %s",
            tuple(params + [offset, chunk_size]),
        )

    statute_data = []   # (doc_id, citation_type, law_ref, article_ref, raw_match, justice_kind)
    case_data = []      # (doc_id, to_case_number, raw_match, justice_kind)
    rows = 0
    type_counts = Counter()

    for doc_id, text, jk in cur:
        rows += 1
        if not text:
            continue
        try:
            for c in extract_citations_from_text(doc_id, text):
                type_counts[c.citation_type] += 1
                if c.citation_type == "case_reference":
                    case_data.append((c.doc_id, c.law_ref, c.raw_match, jk))
                else:
                    statute_data.append((c.doc_id, c.citation_type, c.law_ref, c.article_ref, c.raw_match, jk))
        except Exception:
            pass

    cur.close()
    conn.close()

    # Write directly from this worker (parallel writes across workers, disjoint doc_ids per chunk)
    if not dry_run:
        write_statute(statute_data, adj_year=year)
        write_cases(case_data, adj_year=year)

    return {
        "year": year,
        "offset": offset,
        "rows": rows,
        "citations": len(statute_data) + len(case_data),
        "type_counts": dict(type_counts),
    }

def write_statute(rows: list[tuple], adj_year: int):
    """Bulk-insert statute citations. Idempotent via ON CONFLICT DO NOTHING (dedup)."""
    if not rows:
        return
    conn = get_conn()
    cur = conn.cursor()
    execute_values(
        cur,
        f"""INSERT INTO {_TARGET_TABLE}
           (court_case_id, citation_type, law_number, law_article, citation_context, justice_kind, adj_year)
           VALUES %s {'' if _BULK_LOAD else 'ON CONFLICT DO NOTHING'}""",
        # r = (doc_id, citation_type, law_ref, article_ref, raw_match, justice_kind)
        [(r[0], r[1], r[2], r[3], r[4][:500], r[5], adj_year) for r in rows],
        page_size=5000,
    )
    conn.commit()
    cur.close()
    conn.close()

def write_cases(rows: list[tuple], adj_year: int):
    """Bulk-insert decision->case reference edges. Idempotent via ON CONFLICT DO NOTHING (dedup)."""
    if not rows:
        return
    conn = get_conn()
    cur = conn.cursor()
    execute_values(
        cur,
        f"""INSERT INTO {_CASE_TABLE}
           (from_case_id, to_case_number, citation_context, justice_kind, adj_year)
           VALUES %s {'' if _BULK_LOAD else 'ON CONFLICT DO NOTHING'}""",
        # r = (doc_id, to_case_number, raw_match, justice_kind)
        [(r[0], r[1], r[2][:500], r[3], adj_year) for r in rows],
        page_size=5000,
    )
    conn.commit()
    cur.close()
    conn.close()

def enrich_justice_kind(year: int):
    """Backfill justice_kind from edrsr_documents (the source of truth; edrsr_fulltext.justice_kind
    is only ~2% populated). Set-based UPDATE per year, decoupled from chunked pagination."""
    conn = get_conn()
    cur = conn.cursor()
    for tbl, col in ((_TARGET_TABLE, "court_case_id"), (_CASE_TABLE, "from_case_id")):
        cur.execute(
            f"UPDATE {tbl} t SET justice_kind = d.justice_kind "
            f"FROM edrsr_documents d "
            f"WHERE t.{col} = d.doc_id AND t.adj_year = %s "
            f"AND t.justice_kind IS NULL AND d.justice_kind IS NOT NULL",
            (year,),
        )
        print(f"    enriched justice_kind on {tbl}: {cur.rowcount:,} rows")
    conn.commit()
    cur.close()
    conn.close()

# ── Main ─────────────────────────────────────────────────────

def process_year(year: int, workers: int, dry_run: bool, chunk_size: int = 50000, limit: int = None) -> PartitionStats:
    stats = PartitionStats(year=year)
    t0 = time.time()

    conn = get_conn()
    cur = conn.cursor()
    if _check_partitions():
        table = f"edrsr_fulltext_p_{year}"
        conds, params = [], []
        if _JUSTICE_KIND_FILTER is not None:
            conds.append("justice_kind = %s"); params.append(_JUSTICE_KIND_FILTER)
        if _TSQUERY is not None:
            conds.append("tsv @@ to_tsquery('simple', %s)"); params.append(_TSQUERY)
        # Mirrors process_chunk via the shared _doc_ids_cond().
        if (_c := _doc_ids_cond()) is not None:
            conds.append(_c)
        where = f" WHERE {' AND '.join(conds)}" if conds else ""
        cur.execute(f"SELECT COUNT(*) FROM {table}{where}", tuple(params))
    else:
        conds, params = ["adj_year = %s"], [year]
        if _JUSTICE_KIND_FILTER is not None:
            conds.append("justice_kind = %s"); params.append(_JUSTICE_KIND_FILTER)
        if _TSQUERY is not None:
            conds.append("tsv @@ to_tsquery('simple', %s)"); params.append(_TSQUERY)
        if (_c := _doc_ids_cond()) is not None:
            conds.append(_c)
        cur.execute(f"SELECT COUNT(*) FROM edrsr_fulltext WHERE {' AND '.join(conds)}", tuple(params))
    total = cur.fetchone()[0]
    cur.close()
    conn.close()

    if total == 0:
        print(f"  Year {year}: 0 rows, skipping")
        return stats

    if limit is not None and total > limit:
        print(f"  Year {year}: capping {total:,} -> {limit:,} rows (--limit)")
        total = limit

    chunks = [(year, offset, chunk_size, dry_run) for offset in range(0, total, chunk_size)]
    print(f"  Year {year}: {total:,} rows, {len(chunks)} chunks, {workers} workers")

    def _accumulate(result):
        stats.rows_processed += result["rows"]
        stats.citations_found += result["citations"]
        for k, v in result["type_counts"].items():
            stats.by_type[k] += v

    failed = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_chunk, c): c for c in chunks}

        for i, future in enumerate(as_completed(futures)):
            # A single chunk losing its DB connection must NOT kill the whole
            # multi-hour run. Queue it for a serial retry pass instead.
            try:
                result = future.result()
            except Exception as e:
                ch = futures[future]
                print(f"    ! chunk offset={ch[1]} failed ({type(e).__name__}: {e}); queued for retry")
                failed.append(ch)
                continue
            _accumulate(result)

            if (i + 1) % 10 == 0 or i == len(futures) - 1:
                elapsed = time.time() - t0
                rate = stats.rows_processed / elapsed if elapsed > 0 else 0
                print(f"    [{i+1}/{len(chunks)}] {stats.rows_processed:,} rows, {stats.citations_found:,} citations, {rate:,.0f} rows/sec")

    # Serial retry pass for any chunks whose worker connection dropped. Re-running
    # a chunk under --bulk-load may re-insert rows it partially wrote; that is
    # harmless because finalize dedups via DISTINCT ON the unique key.
    for ch in failed:
        try:
            _accumulate(process_chunk(ch))
            print(f"    ✓ retry ok offset={ch[1]}")
        except Exception as e:
            print(f"    ✗ chunk offset={ch[1]} PERMANENTLY failed ({type(e).__name__}: {e})")

    if not dry_run and not _NO_ENRICH:
        enrich_justice_kind(year)

    stats.elapsed_sec = time.time() - t0
    return stats

def main():
    parser = argparse.ArgumentParser(description="Extract citations from EDRSR court decisions")
    parser.add_argument("--year", type=int, help="Process single year")
    parser.add_argument("--all", action="store_true", help="Process all years")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to DB")
    parser.add_argument("--workers", type=int, default=2, help="Number of parallel workers")
    parser.add_argument("--chunk-size", type=int, default=50000, help="Rows per chunk")
    parser.add_argument("--years-from", type=int, default=2007, help="Start year for --all")
    parser.add_argument("--years-to", type=int, default=2026, help="End year for --all")
    parser.add_argument("--justice-kind", type=int, default=None, help="Filter by justice_kind (e.g. 5 for КУпАП)")
    parser.add_argument("--target-table", type=str, default="law_court_citations", help="Statute-citation destination table (use a staging table for pilots)")
    parser.add_argument("--case-table", type=str, default="case_citation_edges", help="decision->case edge destination table")
    parser.add_argument("--limit", type=int, default=None, help="Cap rows processed per year (for piloting)")
    parser.add_argument("--bulk-load", action="store_true", help="Plain INSERT, no ON CONFLICT (deferred index: target tables must have NO unique index; dedup+index built afterwards)")
    parser.add_argument("--no-enrich", action="store_true", help="Skip per-year justice_kind enrich UPDATE (defer to a single end-of-run pass)")
    parser.add_argument("--tsquery", type=str, default=None, help="Targeted mode: only rows matching to_tsquery('simple', TSQUERY), e.g. '38.6 | 69.22' (LEXAI-1817)")
    parser.add_argument("--doc-ids-table", type=str, default=None,
                        help="Targeted mode: only doc_ids present in this table (must have a doc_id column). "
                             "Use for backfills that must re-read specific decisions (LEXAI-1947).")
    parser.add_argument("--max-text-len", type=int, default=MAX_TEXT_LEN, help=f"Per-doc scan window in chars (default {MAX_TEXT_LEN}); raise for targeted backfills")
    args = parser.parse_args()

    if not args.year and not args.all:
        parser.error("Specify --year YYYY or --all")

    global _JUSTICE_KIND_FILTER, _TARGET_TABLE, _CASE_TABLE, _BULK_LOAD, _NO_ENRICH, _TSQUERY, _MAX_TEXT_LEN, _DOC_IDS_TABLE
    _JUSTICE_KIND_FILTER = args.justice_kind
    _TARGET_TABLE = args.target_table
    _CASE_TABLE = args.case_table
    _BULK_LOAD = args.bulk_load
    _NO_ENRICH = args.no_enrich
    _TSQUERY = args.tsquery
    _MAX_TEXT_LEN = args.max_text_len
    if args.doc_ids_table:
        # Interpolated into SQL as an identifier, so it is validated rather than
        # trusted: operator-supplied is not the same as safe.
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?', args.doc_ids_table):
            parser.error(f"--doc-ids-table must be a plain identifier, got {args.doc_ids_table!r}")
    _DOC_IDS_TABLE = args.doc_ids_table

    years = list(range(args.years_from, args.years_to + 1)) if args.all else [args.year]

    jk_label = f", justice_kind={args.justice_kind}" if args.justice_kind else ""
    print(f"=== Citation Extraction Pipeline ===")
    print(f"Years: {years[0]}–{years[-1]} ({len(years)} years){jk_label}")
    print(f"Workers: {args.workers}, Chunk: {args.chunk_size:,}")
    print(f"Statute table: {_TARGET_TABLE} | case-edge table: {_CASE_TABLE}" + (f" | limit/year: {args.limit:,}" if args.limit else ""))
    print(f"Dry run: {args.dry_run}\n")

    all_stats = []
    t_total = time.time()

    for year in years:
        stats = process_year(year, args.workers, args.dry_run, args.chunk_size, args.limit)
        all_stats.append(stats)
        print(f"  → Year {year}: {stats.citations_found:,} citations in {stats.elapsed_sec:.1f}s")
        print(f"    Types: {dict(stats.by_type)}\n")

    total_rows = sum(s.rows_processed for s in all_stats)
    total_cites = sum(s.citations_found for s in all_stats)
    total_time = time.time() - t_total

    print(f"\n=== Summary ===")
    print(f"Total rows: {total_rows:,}")
    print(f"Total citations: {total_cites:,}")
    print(f"Citations per decision: {total_cites/total_rows:.2f}" if total_rows else "N/A")
    print(f"Total time: {total_time:.1f}s ({total_time/3600:.1f}h)")

    type_totals = Counter()
    for s in all_stats:
        type_totals.update(s.by_type)
    print(f"\nBy type:")
    for t, c in type_totals.most_common():
        print(f"  {t}: {c:,}")

    # Save stats to JSON
    stats_file = f"citation-extraction-stats-{int(time.time())}.json"
    with open(stats_file, "w") as f:
        json.dump({
            "total_rows": total_rows,
            "total_citations": total_cites,
            "total_time_sec": total_time,
            "by_type": dict(type_totals),
            "by_year": [{
                "year": s.year,
                "rows": s.rows_processed,
                "citations": s.citations_found,
                "elapsed_sec": s.elapsed_sec,
                "types": dict(s.by_type),
            } for s in all_stats],
        }, f, indent=2)
    print(f"\nStats saved to {stats_file}")

if __name__ == "__main__":
    main()
