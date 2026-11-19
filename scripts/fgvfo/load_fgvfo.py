#!/usr/bin/env python3
"""
Load the debtor lists that the Deposit Guarantee Fund (ФГВФО, fg.gov.ua) publishes for the banks it
liquidates (LEXAI-2297).

  dataset   page                                                          table
  debtors   https://www.fg.gov.ua/borzhniki                                fgvfo_debtors
            one XLSX per bank and list: borrowers that are not bank managers or former shareholders,
            and borrowers that are (the second list is «Відсутні» for every bank as of 01.10.2026).
            Persons and companies that have not repaid a debt set by a court decision, with the
            unique case number, the debt as the court stated it and its UAH amount. Quarterly.
  related   https://www.fg.gov.ua/styagnennya-zbitkiv-z-eksvlasnikiv-bankiv/
            informatsiya-pro-kolishnikh-vlasnikiv-neplatospromozhnikh-bankiv-ta-povyazankh-iz-nimi-osib
                                                                           fgvfo_related_claims,
                                                                           fgvfo_related_defendants
            one XLSX per quarter (archive since 01.01.2022): the Fund's damage claims against former
            owners and persons related to failed banks — bank, case number, proceeding type, amount
            claimed, number of defendants and, once a court has awarded damages, the defendants'
            names and the amount awarded.

The files hold names only (no ЄДРПОУ, no РНОКПП). The loader keeps the name and a match key
(uaMatchKey of mcp_openreyestr/src/services/edr-history/norm.ts); an 8-digit code is stored only
when it appears in a company's name. Digits are removed from the names of persons, so a birth date or
an ID number written into a cell is never stored. Matching to ЄДР is left to later work and is only
ever a candidate.

Each file is one snapshot. A load inserts its rows under a new fgvfo_snapshots row (dataset, file
sha256, snapshot date, source URL) in one transaction, so earlier quarters stay queryable and the
fgvfo_*_current views show the latest snapshot of each list. A file whose sha256 is already journalled
is skipped, which also makes an interrupted run resume where it stopped. A snapshot with fewer than
FGVFO_MIN_RATIO (default 0.5) of the rows of the previous snapshot of the same list aborts, when that
previous snapshot had at least FGVFO_GUARD_MIN_ROWS (default 20) rows. Downloads are paced
(FGVFO_PAUSE seconds, default 3).

Usage:
  load_fgvfo.py --dataset all                    # current debtor lists + latest related-persons file
                                                 # (the whole archive when no related file is loaded yet)
  load_fgvfo.py --dataset related --history      # every archived quarter of the related-persons file
  load_fgvfo.py --dataset debtors --file x.xlsx --bank 'АТ «ТЕСТ БАНК»' [--source-url URL]
  load_fgvfo.py --dataset all --dry-run          # download and parse only, print counts

Database access goes through the psql client, so the script needs only the Python standard library:
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from io import BytesIO

USER_AGENT = "SecondLayer-opendata-sync/1.0 (fgvfo loader)"
HTTP_TIMEOUT = int(os.environ.get("FGVFO_HTTP_TIMEOUT", "120"))
PAUSE = float(os.environ.get("FGVFO_PAUSE", "3"))
MIN_RATIO = float(os.environ.get("FGVFO_MIN_RATIO", "0.5"))
GUARD_MIN_ROWS = int(os.environ.get("FGVFO_GUARD_MIN_ROWS", "20"))
# The debtors page lists 12 banks (11.2026); fewer links than this means the page layout changed.
MIN_DEBTOR_FILES = int(os.environ.get("FGVFO_MIN_DEBTOR_FILES", "5"))

BASE = "https://www.fg.gov.ua"
DEBTORS_PAGE = BASE + "/borzhniki"
RELATED_PAGE = (BASE + "/styagnennya-zbitkiv-z-eksvlasnikiv-bankiv/"
                "informatsiya-pro-kolishnikh-vlasnikiv-neplatospromozhnikh-bankiv-ta-povyazankh-iz-nimi-osib")


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── Name normalisation (port of mcp_openreyestr/src/services/edr-history/norm.ts) ──
# Golden cases in test_load_fgvfo.py are the ones of norm.test.ts; keep the ports in step.

UA_KEEP = set("йїёЙЇЁ")
UA_DROP = set("'’ʼ`´‘\"«»“”„")
UA_NON = re.compile(r"[^0-9a-zа-яіїєґё]+")
UA_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "h", "ґ": "g", "д": "d", "е": "e", "є": "ie", "ж": "zh", "з": "z",
    "и": "y", "і": "i", "ї": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
    "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "shch", "ь": "", "ю": "iu", "я": "ia", "ё": "e", "ы": "y", "э": "e", "ъ": "",
}
SKEL = [("sch", "sh"), ("ch", "k"), ("ph", "f"), ("th", "t"), ("ck", "k"), ("kh", "h"), ("x", "ks"),
        ("q", "k"), ("w", "v"), ("c", "k"), ("g", "h"), ("j", "dzh"), ("y", "i")]
UA_LEGAL_WORDS = """товариство обмеженою відповідальністю приватне підприємство акціонерне публічне закрите
    відкрите дочірнє компанія корпорація фірма тов тзов пп ат пат прат зат ват дп лімітед лтд ллс ллк гмбх інк
    корп limited ltd llc lls inc gmbh corp company co plc sa sarl srl spa bv nv ag oy ab as kg sp zoo""".split()


def norm_ua(s: str | None) -> str:
    if not s:
        return ""
    out = []
    for ch in s:
        if ch in UA_DROP:
            continue
        if ch in UA_KEEP:
            out.append(ch)
            continue
        out.extend(c for c in unicodedata.normalize("NFKD", ch) if unicodedata.category(c) != "Mn")
    return UA_NON.sub(" ", "".join(out).lower().replace("ё", "е")).strip()


def skeleton(word: str) -> str:
    w = "".join(UA_LAT.get(ch, ch) for ch in word)
    for a, b in SKEL:
        w = w.replace(a, b)
    w = re.sub(r"([aeiou])h(?![aeiou])", r"\1", w)
    return re.sub(r"(.)\1+", r"\1", w)


UA_LEGAL = {skeleton(w) for w in UA_LEGAL_WORDS}


def ua_match_key(s: str | None) -> str:
    out, seen = [], set()
    for w in (skeleton(x) for x in norm_ua(s).split(" ") if x):
        if len(w) > 1 and w not in UA_LEGAL and w not in seen:
            seen.add(w)
            out.append(w)
    return " ".join(out)


# ─── Names, amounts, dates ────────────────────────────────────────────────

# Words that mark an organisation rather than a natural person.
_L = "А-ЯІЇЄҐа-яіїєґA-Za-z'’"
# Abbreviations are matched case-sensitively ('АТ' but not a syllable), words with at most a
# three-letter case ending ('банку', 'фірми'), so a surname such as 'Банкович' stays a person.
ORG_ABBR_RE = re.compile(
    rf"(?<![{_L}])(ТОВ|ТзОВ|ПАТ|ПрАТ|ПРАТ|ВАТ|ЗАТ|АТ|ДП|ПП|КП|СП|ФГ|СФГ|ТДВ|КТ|ОСББ|ЖБК|ГО|"
    rf"LLC|LTD|Ltd|LIMITED|Limited|INC|Inc|GMBH|GmbH|CORP|Corp|PLC|S\.A\.|B\.V\.)(?![{_L}])")
ORG_WORD_RE = re.compile(
    rf"(?<![{_L}])(?:лімітед|лтд|інк|корп|ллс|ллк|гмбх|холдингз|"
    r"товариств|підприємств|компані|корпораці|фірм|концерн|об['’]?єднанн|господарств|кооператив|"
    r"асоціаці|спілк|банк|установ|організаці|фонд|завод|комбінат|холдинг|холдінг|агрофірм|трест|"
    rf"державн|комунальн|національн|міністерств|управлінн)\w{{0,3}}(?![{_L}])", re.IGNORECASE)
FOP_RE = re.compile(r"(?<![А-ЯІЇЄҐа-яіїєґ])(ФОП|СПД|ФО-П|фізична особа[ -]+підприємець|"
                    r"суб['’]?єкт підприємницької діяльності)(?![А-ЯІЇЄҐа-яіїєґ])", re.IGNORECASE)
EDRPOU_RE = re.compile(r"(?:ЄДРПОУ|код)\D{0,12}(\d{5,8})(?!\d)|(?<!\d)(\d{8})(?!\d)", re.IGNORECASE)


def clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("\xa0", " ")).strip()


def debtor_kind(name: str) -> str:
    """'company' | 'fop' | 'person' (an individual entrepreneur is a person: the name is stored the same way)."""
    if FOP_RE.search(name):
        return "fop"
    if ORG_ABBR_RE.search(name) or ORG_WORD_RE.search(name) or re.search(r"[\"«»“”„]", name):
        return "company"
    return "person"


def person_name(name: str) -> str:
    """A person's name without digits, ID-number labels, birth-date phrases or an entrepreneur prefix."""
    s = re.sub(r"\((?:[^()]*\d[^()]*)\)", " ", name)              # (1234567890), (01.01.1970 р.н.)
    s = re.sub(r"(?i)(?<!\w)(?:РНОКПП|ІПН|ідентифікаційн\w*\s+(?:код|номер)\w*|код|паспорт\w*|"
               r"дата\s+народження|року\s+народження|р\.\s*н\.?)(?!\w)", " ", s)
    s = re.sub(r"(?i)^\s*(?:ФОП|СПД(?:\s+ФО)?|ФО-П|фізична\s+особа\s*-?\s*підприємець|"
               r"суб['’]?єкт\s+підприємницької\s+діяльності(?:\s*-?\s*фізична\s+особа)?)(?!\w)\s*", "", s)
    s = re.sub(r"\d", " ", s)
    # tokens left without a letter ('.', '/', ',') were part of a date or a number
    s = " ".join(t for t in clean(s).split(" ") if re.search(r"[А-ЯІЇЄҐа-яіїєґA-Za-z]", t))
    return clean(s).strip(" ,;:-–№")


ROLE_RE = re.compile(r"\(\s*([a-zа-яіїєґ][^()]*)\)")   # '(солідарний боржник)', '(майновий поручитель)'


def split_person_cell(raw: str) -> list[tuple[str, str | None]]:
    """A person cell may name joint debtors: 'А, Б (солідарний боржник)', 'А та Б'.
    Returns [(name, role note)]; a lower-case parenthetical is a role note, '(Дівоче)' stays in the name."""
    out = []
    for part in re.split(r"\n|;|,(?=\s*[А-ЯІЇЄҐA-Z])|\s+та\s+(?=[А-ЯІЇЄҐA-Z])", raw):
        notes = [clean(m) for m in ROLE_RE.findall(part)]
        name = person_name(ROLE_RE.sub(" ", part))
        if name:
            out.append((name, "; ".join(notes) or None))
        elif notes and out:
            prev, note = out[-1]
            out[-1] = (prev, "; ".join(filter(None, [note, *notes])))
    return out


def company_edrpou(name: str) -> str | None:
    m = EDRPOU_RE.search(name)
    if not m:
        return None
    return (m[1] or m[2]).zfill(8)


def parse_amount(s) -> float | None:
    """'1 234 567,89 грн.' / '1234567.89' / '439 997, 12' -> 1234567.89. None when there is no number."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return round(float(s), 2)
    t = str(s).replace("\xa0", " ").strip()
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", t):
        return round(float(t), 2)
    m = re.search(r"\d[\d \u202f]*(?:[.,]\s?\d{1,2}(?!\d))?", t)
    if not m:
        return None
    num = re.sub(r"[ \u202f]", "", m.group(0)).replace(",", ".")
    try:
        return round(float(num), 2)
    except ValueError:
        return None


def parse_stanom(text: str) -> str | None:
    """'... станом на 01.10.2026 року' -> '2026-10-01'."""
    m = re.search(r"станом\s+на\s+(\d{1,2})\.(\d{1,2})\.(\d{4})", text or "")
    if not m:
        return None
    try:
        return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        return None


def date_from_url(url: str) -> str | None:
    m = re.search(r"(\d{2})-(\d{2})-(\d{4})\.xlsx$", url or "")
    if not m:
        return None
    try:
        return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        return None


# ─── XLSX (stdlib) ────────────────────────────────────────────────────────

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def xlsx_rows(data: bytes) -> list[tuple[int, dict[str, str]]]:
    """Rows of the first worksheet as (row number, {column letter: text}); empty cells are left out."""
    z = zipfile.ZipFile(BytesIO(data))
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    sheets = sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
                    key=lambda n: int(re.search(r"(\d+)\.xml$", n)[1]))
    if not sheets:
        raise ValueError("xlsx has no worksheet")
    out = []
    for r in ET.fromstring(z.read(sheets[0])).iter(NS + "row"):
        cells = {}
        for c in r.iter(NS + "c"):
            col = re.match(r"[A-Z]+", c.get("r") or "")
            if not col:
                continue
            v, t = c.find(NS + "v"), c.get("t")
            if t == "s" and v is not None and v.text is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(NS + "t"))
            else:
                val = v.text if v is not None else None
            if val is not None and val.strip() != "":
                cells[col[0]] = val
        if cells:
            out.append((int(r.get("r") or 0), cells))
    return out


# ─── Parsed snapshot ──────────────────────────────────────────────────────


@dataclass
class Snapshot:
    dataset: str                 # debtors | related
    list_key: str                # debtors: '<bank slug>:<borrowers|insiders>'; related: 'related'
    bank_name: str | None
    snapshot_date: str | None
    rows: list[dict] = field(default_factory=list)
    defendants: list[dict] = field(default_factory=list)   # related only (claim_row_no -> defendant)
    skipped: int = 0


def bank_slug(url: str) -> str:
    base = os.path.basename(urllib.parse.urlsplit(url).path)
    return re.sub(r"-dodatok.*$", "", base.rsplit(".", 1)[0]) or base


def list_kind_from_title(title: str) -> str | None:
    t = title.lower()
    if re.search(r"які\s+не\s+є\s+керівник", t):
        return "borrowers"
    if re.search(r"які\s+є\s+керівник", t):
        return "insiders"
    return None


def bank_from_title(title: str) -> str | None:
    m = re.search(r"акціонерами\s+(.+?),\s+які\s+ще", clean(title))
    return m[1].strip() if m else None


def parse_debtors(data: bytes, url: str, bank_name: str | None = None, list_kind: str | None = None) -> Snapshot:
    rows = xlsx_rows(data)
    title = next((c.get("A", "") for _, c in rows if "СПИСОК" in c.get("A", "").upper()), "")
    header = next((n for n, c in rows if clean(c.get("A")) == "№" and "судов" in (c.get("B") or "")), None)
    if header is None:
        raise ValueError("debtors: header row (№ / номер судової справи) not found")
    kind = list_kind or list_kind_from_title(title) or "borrowers"
    bank = clean(bank_name) or bank_from_title(title)
    snap = Snapshot("debtors", f"{bank_slug(url)}:{kind}", bank,
                    parse_stanom(title) or date_from_url(url))
    for n, c in rows:
        if n <= header:
            continue
        no = clean(c.get("A"))
        if not re.fullmatch(r"\d+\.?", no):
            continue                         # signatures and notes under the table
        raw = clean(c.get("C"))
        if not raw:
            snap.skipped += 1
            continue
        k = debtor_kind(raw)
        names = [(raw.strip(" ,;"), None)] if k == "company" else split_person_cell(c.get("C") or "")
        if not names:
            snap.skipped += 1
            continue
        for ord_, (name, note) in enumerate(names, 1):
            snap.rows.append({
                "list_kind": kind,
                "row_no": int(no.rstrip(".")),
                "debtor_ord": ord_,
                "case_number": clean(c.get("B")) or None,
                "debtor_name": name,
                "debtor_kind": k,
                "debtor_note": note,
                "debtor_edrpou": company_edrpou(raw) if k == "company" else None,
                "name_match_key": ua_match_key(name) or None,
                "debt_text": clean(c.get("D")) or None,
                "debt_uah": parse_amount(c.get("E")),
            })
    return snap


def split_defendants(cell: str | None) -> list[str]:
    parts = re.split(r"\n|;", (cell or "").replace("\xa0", " "))
    out = []
    for p in parts:
        p = clean(re.sub(r"^\s*\d+[.)]\s*", "", p)).strip(" ,")
        if p:
            out.append(p)
    return out


def parse_related(data: bytes, url: str) -> Snapshot:
    rows = xlsx_rows(data)
    title = next((c.get("A", "") for _, c in rows if "станом на" in c.get("A", "")), "")
    header = next((n for n, c in rows if "судової справи" in (c.get("B") or "")), None)
    if header is None:
        raise ValueError("related: header row (№ судової справи) not found")
    snap = Snapshot("related", "related", None, parse_stanom(title) or date_from_url(url))
    row_no = 0
    for n, c in rows:
        if n <= header:
            continue
        bank, case = clean(c.get("A")), clean(c.get("B"))
        if not bank or not case:
            continue                         # sub-header (ПІБ відповідачів / Сума) and notes
        row_no += 1
        defendants = split_defendants(c.get("F"))
        cnt = c.get("E")
        snap.rows.append({
            "row_no": row_no,
            "bank_name": bank,
            "case_number": case,
            "proceeding_type": clean(c.get("C")) or None,
            "claim_uah": parse_amount(c.get("D")),
            "defendants_count": int(float(cnt)) if cnt and re.fullmatch(r"\d+(\.0+)?", cnt.strip()) else None,
            "awarded_text": clean(c.get("G")) or None,
            "awarded_uah": parse_amount(c.get("G")),
        })
        for i, d in enumerate(defendants, 1):
            k = debtor_kind(d)
            name = d.strip(" ,;") if k == "company" else person_name(d)
            if not name:
                continue
            snap.defendants.append({
                "claim_row_no": row_no, "ord": i, "defendant_name": name, "defendant_kind": k,
                "defendant_edrpou": company_edrpou(d) if k == "company" else None,
                "name_match_key": ua_match_key(name) or None,
            })
    return snap


def check_snapshot(snap: Snapshot) -> None:
    if not snap.rows:
        raise RuntimeError(f"{snap.list_key}: no rows parsed")
    if not snap.snapshot_date:
        raise RuntimeError(f"{snap.list_key}: snapshot date (станом на …) not found")
    nos = [(r["row_no"], r.get("debtor_ord", 1)) for r in snap.rows]
    if len(set(nos)) != len(nos):
        raise RuntimeError(f"{snap.list_key}: duplicate row numbers")


# ─── Page discovery ───────────────────────────────────────────────────────


@dataclass
class FileRef:
    url: str
    bank_name: str | None = None
    list_kind: str | None = None


def strip_tags(s: str) -> str:
    return clean(html.unescape(re.sub(r"<[^>]+>", " ", s)))


def debtor_files(page: str) -> list[FileRef]:
    """XLSX links of the debtors table: column 2 = borrowers, column 3 = managers / former shareholders."""
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)
        if len(tds) < 2:
            continue
        bank = strip_tags(tds[0])
        for i, kind in ((1, "borrowers"), (2, "insiders")):
            if i < len(tds):
                for href in re.findall(r'href="([^"]+\.xlsx)"', tds[i], flags=re.I):
                    out.append(FileRef(urllib.parse.urljoin(BASE + "/", html.unescape(href)), bank, kind))
    return out


def related_files(page: str) -> list[FileRef]:
    """XLSX links of the related-persons page, newest first (the order the page lists them in)."""
    seen, out = set(), []
    for href in re.findall(r'href="([^"]*inform-kolishn[^"]*\.xlsx)"', page, flags=re.I):
        url = urllib.parse.urljoin(BASE + "/", html.unescape(href))
        if url not in seen:
            seen.add(url)
            out.append(FileRef(url))
    return out


# ─── Downloads ────────────────────────────────────────────────────────────

_last_request = 0.0


def http_get(url: str) -> bytes:
    global _last_request
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    last: Exception | None = None
    for attempt in range(3):
        wait = PAUSE - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.time()
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


# ─── Database (psql) ──────────────────────────────────────────────────────


def psql_cmd() -> list[str]:
    base = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    url = os.environ.get("DATABASE_URL")
    if url:
        return ["psql", url, *base]
    return ["docker", "exec", "-i", os.environ.get("PG_CONTAINER", "secondlayer-postgres-local"),
            "psql", "-U", os.environ.get("PGUSER", "secondlayer"),
            "-d", os.environ.get("PGDATABASE", "secondlayer_local"), *base]


def psql(sql: str) -> str:
    r = subprocess.run(psql_cmd(), input=sql, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[-2000:]}")
    return r.stdout


def lit(s) -> str:
    if s is None:
        return "NULL"
    if isinstance(s, (int, float)):
        return repr(s)
    return "'" + str(s).replace("'", "''") + "'"


def copy_value(v) -> str:
    if v is None:
        return r"\N"
    return str(v).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def copy_block(columns: list[str], rows: list[dict]) -> str:
    return "\n".join("\t".join(copy_value(r.get(c)) for c in columns) for r in rows)


DEBTOR_COLS = ["list_kind", "row_no", "debtor_ord", "case_number", "debtor_name", "debtor_kind", "debtor_note",
               "debtor_edrpou", "name_match_key", "debt_text", "debt_uah"]
CLAIM_COLS = ["row_no", "bank_name", "case_number", "proceeding_type", "claim_uah", "defendants_count",
              "awarded_text", "awarded_uah"]
DEF_COLS = ["claim_row_no", "ord", "defendant_name", "defendant_kind", "defendant_edrpou", "name_match_key"]


def load_sql(snap: Snapshot, source_url: str, sha256: str, size: int) -> str:
    key_msg = snap.list_key.replace("'", "''").replace("%", "")
    guard = f"""
DO $$
DECLARE prev integer;
BEGIN
  SELECT rows_parsed INTO prev FROM fgvfo_snapshots
   WHERE dataset = {lit(snap.dataset)} AND list_key = {lit(snap.list_key)}
     AND snapshot_date <= {lit(snap.snapshot_date)}::date
   ORDER BY snapshot_date DESC, loaded_at DESC LIMIT 1;
  IF prev >= {GUARD_MIN_ROWS} AND {len(snap.rows)} < prev * {MIN_RATIO} THEN
    RAISE EXCEPTION '{key_msg}: snapshot has {len(snap.rows)} rows, previous had % (min ratio {MIN_RATIO}), not loaded', prev;
  END IF;
END $$;"""
    head = f"""
BEGIN;
{guard}
CREATE TEMP TABLE fg_snap (id bigint) ON COMMIT DROP;
WITH s AS (
  INSERT INTO fgvfo_snapshots (dataset, list_key, bank_name, file_sha256, snapshot_date, source_url,
                               file_size, rows_parsed, rows_skipped)
  VALUES ({lit(snap.dataset)}, {lit(snap.list_key)}, {lit(snap.bank_name)}, {lit(sha256)},
          {lit(snap.snapshot_date)}::date, {lit(source_url)}, {size}, {len(snap.rows)}, {snap.skipped})
  RETURNING id
) INSERT INTO fg_snap SELECT id FROM s;
"""
    if snap.dataset == "debtors":
        cols = ", ".join(DEBTOR_COLS)
        body = f"""
CREATE TEMP TABLE fg_stage ON COMMIT DROP AS SELECT {cols} FROM fgvfo_debtors WITH NO DATA;
COPY fg_stage ({cols}) FROM STDIN WITH (FORMAT text, NULL '\\N');
{copy_block(DEBTOR_COLS, snap.rows)}
\\.
INSERT INTO fgvfo_debtors (snapshot_id, bank_name, {cols})
SELECT (SELECT id FROM fg_snap), {lit(snap.bank_name)}, {cols} FROM fg_stage;
SELECT 'RESULT|' || (SELECT count(*) FROM fgvfo_debtors WHERE snapshot_id = (SELECT id FROM fg_snap)) || '|0';
"""
    else:
        ccols, dcols = ", ".join(CLAIM_COLS), ", ".join(DEF_COLS)
        body = f"""
CREATE TEMP TABLE fg_claims ON COMMIT DROP AS SELECT {ccols} FROM fgvfo_related_claims WITH NO DATA;
COPY fg_claims ({ccols}) FROM STDIN WITH (FORMAT text, NULL '\\N');
{copy_block(CLAIM_COLS, snap.rows)}
\\.
CREATE TEMP TABLE fg_defs (claim_row_no integer, ord integer, defendant_name text, defendant_kind text,
                           defendant_edrpou char(8), name_match_key text) ON COMMIT DROP;
COPY fg_defs ({dcols}) FROM STDIN WITH (FORMAT text, NULL '\\N');
{copy_block(DEF_COLS, snap.defendants)}
\\.
INSERT INTO fgvfo_related_claims (snapshot_id, {ccols})
SELECT (SELECT id FROM fg_snap), {ccols} FROM fg_claims;
INSERT INTO fgvfo_related_defendants (claim_id, ord, defendant_name, defendant_kind, defendant_edrpou,
                                      name_match_key)
SELECT c.id, d.ord, d.defendant_name, d.defendant_kind, d.defendant_edrpou, d.name_match_key
  FROM fg_defs d
  JOIN fgvfo_related_claims c ON c.snapshot_id = (SELECT id FROM fg_snap) AND c.row_no = d.claim_row_no;
SELECT 'RESULT|' || (SELECT count(*) FROM fgvfo_related_claims WHERE snapshot_id = (SELECT id FROM fg_snap))
    || '|' || (SELECT count(*) FROM fgvfo_related_defendants d JOIN fgvfo_related_claims c ON c.id = d.claim_id
                WHERE c.snapshot_id = (SELECT id FROM fg_snap));
"""
    return head + body + "COMMIT;\n"


def already_loaded(dataset: str, sha256: str) -> bool:
    out = psql(f"SELECT 1 FROM fgvfo_snapshots WHERE dataset = {lit(dataset)} AND file_sha256 = {lit(sha256)};")
    return out.strip() == "1"


# ─── Main ─────────────────────────────────────────────────────────────────


def run_file(dataset: str, ref: FileRef, data: bytes, dry_run: bool, force: bool) -> Snapshot:
    sha = hashlib.sha256(data).hexdigest()
    if dataset == "debtors":
        snap = parse_debtors(data, ref.url, ref.bank_name, ref.list_kind)
    else:
        snap = parse_related(data, ref.url)
    check_snapshot(snap)
    extra = f", {len(snap.defendants)} named defendants" if dataset == "related" else ""
    log(f"{snap.list_key}: {len(snap.rows)} rows{extra} ({snap.skipped} skipped), "
        f"станом на {snap.snapshot_date}, {len(data) // 1024} KB, sha256 {sha[:12]}")
    if dry_run:
        return snap
    if not force and already_loaded(dataset, sha):
        log(f"{snap.list_key}: this file is already loaded, skipping")
        return snap
    if force:
        psql(f"DELETE FROM fgvfo_snapshots WHERE dataset = {lit(dataset)} AND file_sha256 = {lit(sha)};")
    out = psql(load_sql(snap, ref.url, sha, len(data)))
    m = re.search(r"RESULT\|(\d+)\|(\d+)", out)
    log(f"{snap.list_key}: loaded {m[1] if m else '?'} rows"
        + (f", {m[2]} defendants" if m and dataset == "related" else ""))
    return snap


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, choices=["debtors", "related", "all"])
    ap.add_argument("--history", action="store_true", help="related: load every archived quarter, not only the latest")
    ap.add_argument("--file", help="load a local XLSX instead of downloading (debtors or related)")
    ap.add_argument("--bank", help="--file with --dataset debtors: bank name as the debtors page shows it")
    ap.add_argument("--list-kind", choices=["borrowers", "insiders"], help="--file with --dataset debtors")
    ap.add_argument("--source-url", help="--file: URL the file was downloaded from (stored as source_url)")
    ap.add_argument("--dry-run", action="store_true", help="download and parse only")
    ap.add_argument("--force", action="store_true", help="replace a file already journalled")
    a = ap.parse_args(argv)

    if a.file:
        if a.dataset == "all":
            ap.error("--file needs --dataset debtors or related")
        with open(a.file, "rb") as f:
            data = f.read()
        ref = FileRef(a.source_url or f"file:{os.path.basename(a.file)}", a.bank, a.list_kind)
        run_file(a.dataset, ref, data, a.dry_run, a.force)
        return 0

    jobs: list[tuple[str, FileRef]] = []
    failed: list[str] = []
    if a.dataset in ("debtors", "all"):
        try:
            refs = debtor_files(http_get(DEBTORS_PAGE).decode("utf-8", "replace"))
            if len(refs) < MIN_DEBTOR_FILES:
                raise RuntimeError(f"debtors page lists {len(refs)} files (< {MIN_DEBTOR_FILES}): layout changed?")
            jobs += [("debtors", r) for r in refs]
        except Exception as e:  # noqa: BLE001
            log(f"ERROR debtors page: {e}")
            failed.append("debtors page")
    if a.dataset in ("related", "all"):
        try:
            refs = related_files(http_get(RELATED_PAGE).decode("utf-8", "replace"))
            if not refs:
                raise RuntimeError("related-persons page lists no XLSX file: layout changed?")
            # The first load into an empty table takes the whole archive; later runs only the newest file.
            history = a.history or (not a.dry_run and psql(
                "SELECT count(*) FROM fgvfo_snapshots WHERE dataset = 'related';").strip() == "0")
            # oldest first, so the ratio guard compares each quarter with the one before it
            jobs += [("related", r) for r in (list(reversed(refs)) if history else refs[:1])]
        except Exception as e:  # noqa: BLE001
            log(f"ERROR related page: {e}")
            failed.append("related page")

    for dataset, ref in jobs:
        try:
            run_file(dataset, ref, http_get(ref.url), a.dry_run, a.force)
        except Exception as e:  # noqa: BLE001 - one broken file must not block the others
            log(f"ERROR {os.path.basename(ref.url)}: {e}")
            failed.append(os.path.basename(ref.url))
    if failed:
        log(f"failed: {', '.join(failed)}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
