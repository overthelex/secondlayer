#!/usr/bin/env python3
"""
Load the NBU register of non-bank financial institutions and the published ownership data of banks
and non-bank institutions (LEXAI-2296), for the company-relationship graph.

  list                 source (https://bank.gov.ua)                                  table
  ree_fu               /files/N_bank/r_drfu/ree_fu.xlsx                              nbu_fin_institutions,
                         sheet ree_fu: Державний реєстр фінансових установ +         nbu_fin_licenses
                         реєстр осіб, які не є ФУ, але надають окремі фінпослуги;
                         sheet lic: licences / services / insurance classes
  nonbank_approved     /files/N_bank/p_vlasnykiv_pohodzheni/pv_pohodjen.xlsx         nbu_fin_ownership
                         persons approved to acquire a qualifying holding in a non-bank institution
  nonbank_no_voting    /files/N_bank/p_vlasnykiv_bez_prava_holosu/pv_bpg.xlsx        nbu_fin_ownership
                         qualifying-holding owners barred from voting, with their trustees
  bank_decisions       /files/SP/subpar.xlsx                                         nbu_fin_ownership
                         decisions on qualifying holdings in banks (art. 34-1 Law on Banks)
  bank_ownership_docs  /ua/supervision/registration/shareholders[/<МФО>]             nbu_bank_ownership_documents
                         index of the yearly bank ownership-structure PDFs (contents not parsed)

The xlsx files are read with the standard library (zipfile + ElementTree); columns are found by
their header text, so a reordered file still loads. Bank names in subpar.xlsx are matched to ЄДРПОУ
through the NBU_BankInfo API (get_data_branch_glbank), which also gives МФО -> ЄДРПОУ for the PDF
index.

Each list is one snapshot, loaded in one transaction and journalled in nbu_fin_snapshots
(sha256, snapshot date, source URL). A file whose sha256 is already journalled is skipped. A snapshot
with fewer than NBU_FIN_MIN_RATIO (default 0.5) of the rows the table holds for that list aborts the
transaction. Institutions that leave the register are kept with in_register = false; licences and
ownership edges of a list are replaced; PDF index rows are upserted and never deleted.

The PDF index crawl (one page per bank, ~180) is paced by NBU_FIN_PAGE_DELAY seconds (default 1.5)
and checkpointed in --state-dir, so an interrupted crawl resumes where it stopped.

Usage:
  load_nbu_fin.py --list all
  load_nbu_fin.py --list ree_fu --file ree_fu.xlsx [--source-url URL] [--force]
  load_nbu_fin.py --list all --dry-run          # download and parse only, print counts

Database access goes through the psql client (stdlib only):
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from io import BytesIO

USER_AGENT = "SecondLayer-opendata-sync/1.0 (nbu financial institutions loader)"
HTTP_TIMEOUT = int(os.environ.get("NBU_FIN_HTTP_TIMEOUT", "120"))
MIN_RATIO = float(os.environ.get("NBU_FIN_MIN_RATIO", "0.5"))
PAGE_DELAY = float(os.environ.get("NBU_FIN_PAGE_DELAY", "1.5"))
CKPT_MAX_AGE = float(os.environ.get("NBU_FIN_CKPT_MAX_AGE", str(36 * 3600)))

BASE = "https://bank.gov.ua"
URLS = {
    "ree_fu": f"{BASE}/files/N_bank/r_drfu/ree_fu.xlsx",
    "nonbank_approved": f"{BASE}/files/N_bank/p_vlasnykiv_pohodzheni/pv_pohodjen.xlsx",
    "nonbank_no_voting": f"{BASE}/files/N_bank/p_vlasnykiv_bez_prava_holosu/pv_bpg.xlsx",
    "bank_decisions": f"{BASE}/files/SP/subpar.xlsx",
    "bank_ownership_docs": f"{BASE}/ua/supervision/registration/shareholders",
}
BANKS_API = f"{BASE}/NBU_BankInfo/get_data_branch_glbank?json"
LISTS = list(URLS)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── xlsx (stdlib) ────────────────────────────────────────────────────────

XNS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def col_index(ref: str) -> int:
    """'C12' -> 2."""
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(data: bytes) -> dict[str, list[list[str]]]:
    """Sheets of a workbook as {name: rows}; each row is a list of stripped strings ('' for empty)."""
    z = zipfile.ZipFile(BytesIO(data))
    names = set(z.namelist())
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{XNS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{XNS}t")))
    rels = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")):
            rels[r.get("Id")] = r.get("Target")
    out: dict[str, list[list[str]]] = {}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    for i, sh in enumerate(wb.iter(f"{XNS}sheet"), start=1):
        target = rels.get(sh.get(f"{RNS}id")) or f"worksheets/sheet{i}.xml"
        path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        if path not in names:
            continue
        rows: list[list[str]] = []
        for r in ET.fromstring(z.read(path)).iter(f"{XNS}row"):
            cells: dict[int, str] = {}
            for c in r.iter(f"{XNS}c"):
                t = c.get("t")
                v = c.find(f"{XNS}v")
                if t == "s" and v is not None and v.text is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{XNS}t"))
                else:
                    val = v.text if v is not None and v.text is not None else ""
                cells[col_index(c.get("r"))] = val.replace("\xa0", " ").strip()
            if cells:
                row = [""] * (max(cells) + 1)
                for k, val in cells.items():
                    row[k] = val
            else:
                row = []
            rows.append(row)
        out[sh.get("name")] = rows
    return out


def find_header(rows: list[list[str]], spec: dict[str, list[str]], required: list[str],
                max_scan: int = 20) -> tuple[int, dict[str, int]]:
    """Index of the header row and {key: column} found by case-insensitive substrings.

    spec maps a key to header fragments; the first column whose header contains any fragment wins.
    """
    for i, row in enumerate(rows[:max_scan]):
        low = [c.lower() for c in row]
        cols: dict[str, int] = {}
        for key, frags in spec.items():
            for j, h in enumerate(low):
                if h and j not in cols.values() and any(f.lower() in h for f in frags):
                    cols[key] = j
                    break
        if all(k in cols for k in required):
            return i, cols
    raise ValueError(f"header not found (need {required})")


def cell(row: list[str], cols: dict[str, int], key: str) -> str | None:
    j = cols.get(key)
    if j is None or j >= len(row):
        return None
    v = " ".join(row[j].split())
    return v if v and v not in ("-", "—", "–") else None


# ─── Value parsing ────────────────────────────────────────────────────────

EXCEL_EPOCH = dt.date(1899, 12, 30)


def parse_date(s: str | None) -> str | None:
    """Excel serial ('46336'), 'dd.mm.yyyy' or ISO -> 'yyyy-mm-dd'."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        if re.fullmatch(r"\d{4,5}(\.0+)?", s):
            n = int(float(s))
            if 20000 < n < 80000:
                return (EXCEL_EPOCH + dt.timedelta(days=n)).isoformat()
            return None
        m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
        if m:
            return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None
    return None


def parse_pct(s: str | None) -> float | None:
    """'92,230511', '100%', '4.7796000000000003', '-' -> float or None."""
    s = (s or "").replace(" ", "").replace("%", "").replace(",", ".")
    m = re.search(r"\d+(\.\d+)?", s)
    if not m:
        return None
    v = round(float(m.group(0)), 6)
    return v if 0 <= v <= 100 else None


def edrpou8(s: str | None) -> str | None:
    """ЄДРПОУ zero-padded to 8 digits; None unless it is 1..8 digits."""
    s = re.sub(r"\.0+$", "", (s or "").strip())
    if not re.fullmatch(r"\d{1,8}", s):
        return None
    return s.zfill(8)


def stated_date(rows: list[list[str]], max_scan: int = 4) -> str | None:
    """«Станом на 16.11.2026» / «Дата останніх змін 07.07.2025» in the first rows."""
    for row in rows[:max_scan]:
        for c in row:
            if re.search(r"станом на|дата останніх змін", c, re.I):
                d = parse_date(c)
                if d:
                    return d
    return None


LEGAL_MARKERS = re.compile(
    r"[\"“”«»„]|(?<!\w)(ТОВ|ТДВ|АТ|ПрАТ|ПАТ|ПП|ТОВАРИСТВО|КОМПАНІЯ|КОРПОРАЦІЯ|ПІДПРИЄМСТВО|LIMITED|LTD|INC|LLC|"
    r"GMBH|AG|SE|SA|SAS|AS|OÜ|OU|UAB|SIA|LP|L\.P\.|S\.A|N\.V|B\.V|PLC|CORPORATION|CORP|HOLDING|HOLDINGS|"
    r"STICHTING|FUND|TRUST|ФОНД|БАНК|BANK|ЛІМІТЕД|ЛТД|АГ|ІНК|ХОЛДИНГ|ГРУП|ЕС\.А|С\.А|СТІХТІНГ)(?!\w)",
    re.I)
PERSON_RE = re.compile(r"^[А-ЯЇІЄҐ][а-яїієґ'’ʼ-]+( [А-ЯЇІЄҐ][а-яїієґ'’ʼ-]+){1,3}$")


def owner_kind(name: str) -> str | None:
    if re.search(r"\sспільно з\s", name, re.I):
        return "joint"  # «Іваненко Іван Іванович спільно з Іваненко Оксаною ...»: one joint holding
    if LEGAL_MARKERS.search(name):
        return "legal_entity"
    base = re.sub(r"\s*\(.*\)\s*$", "", name).strip()
    if PERSON_RE.match(base):
        return "person"
    return None


def owner_identity(raw: str) -> dict:
    """Owner name, code and country from a cell such as
    '“НП ХОЛДИНГС ЛІМІТЕД” (NP HOLDINGS LIMITED, Республіка Кіпр, реєстраційний номер: НЕ 359091)' or
    'ТОВ “НоваПей Інвест” (код за ЄДРПОУ 46289633)'."""
    name = " ".join(raw.split())
    out = {"owner_name": name, "owner_code": None, "owner_code_kind": None, "owner_country": None}
    m = re.search(r"код(?:\s+за)?\s+ЄДРПОУ[:\s]*(\d{6,8})", name, re.I)
    if m:
        out.update(owner_code=m[1].zfill(8), owner_code_kind="edrpou", owner_country="Україна")
        out["owner_name"] = re.sub(r"\s*\(\s*код(?:\s+за)?\s+ЄДРПОУ[^)]*\)", "", name, flags=re.I).strip() or name
    else:
        m = re.search(r"\(([^()]*?),\s*([^,()]+?),\s*реєстраційний номер[:\s]*([^)]+)\)", name, re.I)
        if m:
            out.update(owner_code=m[3].strip(), owner_code_kind="foreign_registration",
                       owner_country=m[2].strip())
        else:
            m = re.search(r"реєстраційний номер[:\s-]*([A-ZА-ЯЇІЄ0-9][A-ZА-ЯЇІЄ0-9 /-]{2,30})", name, re.I)
            if m:
                out.update(owner_code=m[1].strip(), owner_code_kind="foreign_registration")
    out["owner_kind"] = owner_kind(out["owner_name"])
    return out


def split_owners(raw: str) -> list[str]:
    """A joint holding lists several persons on separate lines: 'А Б В, \\nГ Д Е'."""
    parts = [p.strip(" ,;") for p in re.split(r"[,;]?\s*\n\s*", raw or "")]
    parts = [p for p in parts if p]
    return parts if len(parts) > 1 and all(owner_kind(p) == "person" for p in parts) else [raw.strip()]


def norm_name(s: str | None) -> str:
    s = (s or "").upper().replace("Ґ", "Г")
    for full, short in (("ПУБЛІЧНЕ АКЦІОНЕРНЕ ТОВАРИСТВО", "ПАТ"), ("ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО", "ПРАТ"),
                        ("АКЦІОНЕРНЕ ТОВАРИСТВО", "АТ"),
                        ("ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ", "ТОВ")):
        s = s.replace(full, short)
    return re.sub(r"[^0-9A-ZА-ЯЇІЄ]+", "", s)


# ─── Parsed snapshot ──────────────────────────────────────────────────────


@dataclass
class Snapshot:
    list_name: str
    rows: list[dict] = field(default_factory=list)          # institutions / edges / documents
    licenses: list[dict] = field(default_factory=list)      # ree_fu only
    snapshot_date: str | None = None
    skipped: int = 0


# ─── ree_fu ───────────────────────────────────────────────────────────────

REE_SPEC = {
    "register_name": ["найменування реєстру"],
    "institution_type": ["тип надавача"],
    "name": ["повне найменування"],
    "edrpou": ["єдрпоу"],
    "address": ["адреса"],
    "head_name": ["керівника"],
    "registered_date": ["дата внесення"],
}
LIC_SPEC = {
    "institution_type": ["тип надавача"],
    "institution_name": ["повне найменування"],
    "edrpou": ["єдрпоу"],
    "license_status": ["статус ліцензії"],
    "license_name": ["назва ліцензії"],
    "service": ["назва послуги", "клас страхування"],
    "insurance_type": ["тип страхування"],
    "issued_date": ["дата видачі"],
    "service_start_date": ["дата початку"],
    "validity": ["строк дії"],
}


def pick_sheet(sheets: dict[str, list[list[str]]], spec: dict, required: list[str],
               prefer: str | None = None):
    order = sorted(sheets, key=lambda n: n != prefer)
    for name in order:
        try:
            return (name, *find_header(sheets[name], spec, required))
        except ValueError:
            continue
    raise ValueError(f"no sheet with columns {required}")


def parse_ree_fu(data: bytes) -> Snapshot:
    sheets = read_xlsx(data)
    name, hi, cols = pick_sheet(sheets, REE_SPEC, ["name", "edrpou", "register_name"], "ree_fu")
    rows = sheets[name]
    snap = Snapshot("ree_fu", snapshot_date=stated_date(rows))
    seen: dict[str, dict] = {}
    for row in rows[hi + 1:]:
        code = edrpou8(cell(row, cols, "edrpou"))
        nm = cell(row, cols, "name")
        if not code or not nm:
            if any(row):
                snap.skipped += 1
            continue
        rec = {
            "edrpou": code, "name": nm,
            "institution_type": cell(row, cols, "institution_type"),
            "register_name": cell(row, cols, "register_name"),
            "address": cell(row, cols, "address"),
            "head_name": cell(row, cols, "head_name"),
            "registered_date": parse_date(cell(row, cols, "registered_date")),
        }
        prev = seen.get(code)
        if prev:
            # One code in both registers (or under two types): keep one row, join the labels.
            for k in ("institution_type", "register_name"):
                if rec[k] and rec[k] not in (prev[k] or "").split("; "):
                    prev[k] = "; ".join(filter(None, [prev[k], rec[k]]))
            prev["registered_date"] = min(filter(None, [prev["registered_date"], rec["registered_date"]]),
                                          default=None)
            continue
        seen[code] = rec
        snap.rows.append(rec)

    lic_sheet = next((n for n in sheets if n != name), None)
    if lic_sheet:
        try:
            lname, lhi, lcols = pick_sheet({n: sheets[n] for n in sheets if n != name}, LIC_SPEC,
                                           ["edrpou", "license_name"], "lic")
        except ValueError:
            lname = None
        if lname:
            snap.snapshot_date = snap.snapshot_date or stated_date(sheets[lname])
            for row in sheets[lname][lhi + 1:]:
                code = edrpou8(cell(row, lcols, "edrpou"))
                if not code or not cell(row, lcols, "license_name"):
                    continue
                snap.licenses.append({
                    "edrpou": code,
                    "institution_name": cell(row, lcols, "institution_name"),
                    "institution_type": cell(row, lcols, "institution_type"),
                    "license_status": cell(row, lcols, "license_status"),
                    "license_name": cell(row, lcols, "license_name"),
                    "service": cell(row, lcols, "service"),
                    "insurance_type": cell(row, lcols, "insurance_type"),
                    "issued_date": parse_date(cell(row, lcols, "issued_date")),
                    "service_start_date": parse_date(cell(row, lcols, "service_start_date")),
                    "validity": cell(row, lcols, "validity"),
                })
    return snap


# ─── Non-bank qualifying holdings ─────────────────────────────────────────


def share_columns(rows: list[list[str]], hi: int, cols: dict[str, int], anchor: str) -> None:
    """The share header spans three columns (Пряма / Опосередкована / Сукупна) on the row below."""
    sub = rows[hi + 1] if hi + 1 < len(rows) else []
    start = cols.get(anchor, 0)
    for j in range(start, min(start + 4, len(sub))):
        h = sub[j].lower()
        if h.startswith("пряма"):
            cols["share_direct"] = j
        elif h.startswith("опосередк"):
            cols["share_indirect"] = j
        elif h.startswith("сукупн"):
            cols["share_total"] = j


def edge_shares(row: list[str], cols: dict[str, int]) -> dict:
    d = parse_pct(cell(row, cols, "share_direct"))
    i = parse_pct(cell(row, cols, "share_indirect"))
    t = parse_pct(cell(row, cols, "share_total"))
    return {"share_direct": d, "share_indirect": i, "share_total": t if t is not None else (
        round((d or 0) + (i or 0), 6) if d is not None or i is not None else None),
        "is_direct": bool(d), "is_indirect": bool(i),
        "participation": ", ".join(p for p, v in (("пряма", d), ("опосередкована", i)) if v) or None}


PV_SPEC = {
    "owner": ["пІб фізичної особи"],
    "institution_name": ["повне найменування небанківської"],
    "institution_edrpou": ["код єдрпоу", "єдрпоу"],
    "action": ["набуття / збільшення", "набуття/збільшення"],
    "share": ["заявлена участь", "участь особи"],
    "decision_date": ["дата прийняття рішення"],
    "decision_number": ["номер рішення"],
    "note": ["примітк"],
    "relation_description": ["опис взаємозв"],
    "restriction_basis": ["підстава для заборони"],
    "trustee_name": ["пІб довіреної"],
    "trustee_appointed": ["дата призначення"],
}


def parse_nonbank(data: bytes, list_name: str) -> Snapshot:
    sheets = read_xlsx(data)
    name, hi, cols = pick_sheet(sheets, PV_SPEC, ["owner", "institution_name", "institution_edrpou", "share"])
    rows = sheets[name]
    share_columns(rows, hi, cols, "share")
    snap = Snapshot(list_name, snapshot_date=stated_date(rows))
    for row in rows[hi + 2:]:
        owner = cell(row, cols, "owner")
        inst = cell(row, cols, "institution_name")
        if not owner or not inst:
            if any(row):
                snap.skipped += 1
            continue
        code = edrpou8(cell(row, cols, "institution_edrpou"))
        decision_date = parse_date(cell(row, cols, "decision_date"))
        base = {
            "source_list": list_name, "institution_kind": "nonbank",
            "institution_edrpou": code, "institution_name": inst,
            "action": cell(row, cols, "action"),
            "decision": None,
            "decision_date": decision_date,
            "decision_number": cell(row, cols, "decision_number"),
            "relation_description": cell(row, cols, "relation_description"),
            "restriction_basis": cell(row, cols, "restriction_basis"),
            "trustee_name": cell(row, cols, "trustee_name"),
            "trustee_appointed": parse_date(cell(row, cols, "trustee_appointed")),
            "note": cell(row, cols, "note"),
            "as_of_date": decision_date or snap.snapshot_date,
            **edge_shares(row, cols),
        }
        if base["relation_description"] and not base["participation"]:
            rel = base["relation_description"].lower()
            base["is_indirect"] = "опосередк" in rel
            base["is_direct"] = "прям" in rel
        for o in split_owners(row[cols["owner"]]):
            snap.rows.append({**base, **owner_identity(o)})
    # «Дата останніх змін» is not always updated when rows are added: take the latest decision too.
    snap.snapshot_date = max(filter(None, [snap.snapshot_date] + [r["decision_date"] for r in snap.rows]),
                             default=None)
    return snap


# ─── Bank qualifying-holding decisions ────────────────────────────────────

SUBPAR_SPEC = {
    "bank": ["найменування банку", "банк"],
    "owner": ["найменування/піб особи", "піб особи"],
    "intent": ["інформація щодо наміру"],
    "decision": ["прийняте рішення"],
    "action": ["набуття / збільшення", "набуття/збільшення"],
    "participation": ["тип заявленої участі", "тип"],
    "share": ["відсоток заявленої участі", "%"],
    "decision_date": ["дата прийняття рішення"],
    "publication_date": ["дата публікації"],
}


def bank_index(banks: list[dict]) -> dict[str, str]:
    """normalised full/short name -> ЄДРПОУ, from NBU_BankInfo get_data_branch_glbank."""
    idx = {}
    for b in banks:
        code = edrpou8(str(b.get("KOD_EDRPOU") or ""))
        if not code:
            continue
        for k in ("FULLNAME", "SHORTNAME"):
            if b.get(k):
                idx[norm_name(b[k])] = code
    return idx


def mfo_index(banks: list[dict]) -> dict[str, str]:
    return {str(b.get("GLMFO") or b.get("IDNBU")): edrpou8(str(b.get("KOD_EDRPOU") or ""))
            for b in banks if b.get("KOD_EDRPOU")}


def parse_bank_decisions(data: bytes, banks: dict[str, str]) -> Snapshot:
    sheets = read_xlsx(data)
    name, hi, cols = pick_sheet(sheets, SUBPAR_SPEC, ["bank", "owner", "decision", "decision_date"])
    snap = Snapshot("bank_decisions")
    pubs = []
    for row in sheets[name][hi + 1:]:
        bank, owner = cell(row, cols, "bank"), cell(row, cols, "owner")
        if not bank or not owner:
            if any(row):
                snap.skipped += 1
            continue
        part = cell(row, cols, "participation") or ""
        pl = part.lower()
        pub = parse_date(cell(row, cols, "publication_date"))
        pubs += [pub] if pub else []
        decision_date = parse_date(cell(row, cols, "decision_date"))
        share = parse_pct(cell(row, cols, "share"))
        direct = "пряме" in pl or "прямого" in pl
        indirect = "опосередк" in pl
        base = {
            "source_list": "bank_decisions", "institution_kind": "bank",
            "institution_edrpou": banks.get(norm_name(bank)), "institution_name": bank,
            "participation": part or None, "is_direct": direct, "is_indirect": indirect,
            "share_direct": share if direct and not indirect else None,
            "share_indirect": share if indirect and not direct else None,
            "share_total": share,
            "action": cell(row, cols, "action"), "decision": cell(row, cols, "decision"),
            "decision_date": decision_date, "decision_number": None, "publication_date": pub,
            "relation_description": cell(row, cols, "intent"),
            "as_of_date": decision_date,
        }
        for o in split_owners(row[cols["owner"]]):
            snap.rows.append({**base, **owner_identity(o)})
    snap.snapshot_date = max(pubs) if pubs else None
    return snap


# ─── Bank ownership-structure PDF index ───────────────────────────────────


def strip_tags(s: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s)).split())


def parse_shareholders_index(page: str) -> list[dict]:
    """[{mfo, label, group}] in page order; group = the preceding <h3> section heading."""
    main = page[page.find("<main"):] if "<main" in page else page
    out, seen, group = [], set(), "Діючі банки"
    for m in re.finditer(r"<h3[^>]*>(.*?)</h3>|<a[^>]+href=\"[^\"]*/supervision/registration/shareholders/(\d+)\"[^>]*>"
                         r"(.*?)</a>", main, re.S):
        if m.group(1) is not None:
            # Section headings all start with «Банки, які ...»; other <h3> are notes above the list.
            h = strip_tags(m.group(1))
            group = h if h.lower().startswith("банк") else group
            continue
        mfo = m.group(2)
        if mfo not in seen:
            seen.add(mfo)
            out.append({"mfo": mfo, "label": strip_tags(m.group(3)), "group": group})
    return out


def parse_bank_page(page: str, base_url: str = BASE) -> dict:
    title = re.search(r'<h2 class="widget-title">(.*?)</h2>', page, re.S)
    names = re.search(r"Перелік усіх назв, які мав банк:\s*<span[^>]*>(.*?)</span>", page, re.S)
    docs = []
    for m in re.finditer(r'<a href="([^"]+\.pdf)"[^>]*>(.*?)</a>', page, re.S):
        url = urllib.parse.urljoin(base_url, m.group(1))
        as_of = parse_date(strip_tags(m.group(2)))
        if not as_of:
            f = re.search(r"_(\d{4})(\d{2})(\d{2})", m.group(1))
            as_of = f"{f[1]}-{f[2]}-{f[3]}" if f else None
        docs.append({"pdf_url": url, "as_of_date": as_of})
    return {"bank_name": strip_tags(title.group(1)) if title else None,
            "name_history": strip_tags(names.group(1)) if names else None, "docs": docs}


def crawl_ownership_docs(index_html: str, mfo_edrpou: dict[str, str], state_dir: str,
                         fetch=None) -> Snapshot:
    fetch = fetch or (lambda url: http_get(url).decode("utf-8", "replace"))
    banks = parse_shareholders_index(index_html)
    key = hashlib.sha256(json.dumps(banks, ensure_ascii=False).encode()).hexdigest()[:16]
    ckpt_path = os.path.join(state_dir, f"bank_ownership_docs_{key}.json")
    done: dict[str, dict] = {}
    # A checkpoint older than CKPT_MAX_AGE belongs to an earlier crawl: bank pages may have new PDFs.
    if os.path.exists(ckpt_path) and time.time() - os.path.getmtime(ckpt_path) > CKPT_MAX_AGE:
        os.remove(ckpt_path)
    if os.path.exists(ckpt_path):
        with open(ckpt_path, encoding="utf-8") as f:
            done = json.load(f)
        log(f"bank_ownership_docs: resuming, {len(done)}/{len(banks)} bank pages in checkpoint")
    snap = Snapshot("bank_ownership_docs", snapshot_date=dt.date.today().isoformat())
    for n, b in enumerate(banks, 1):
        if b["mfo"] not in done:
            try:
                info = parse_bank_page(fetch(f"{URLS['bank_ownership_docs']}/{b['mfo']}"))
            except Exception as e:  # noqa: BLE001 - one bank page must not stop the crawl
                log(f"bank_ownership_docs: МФО {b['mfo']}: {e}")
                snap.skipped += 1
                continue
            done[b["mfo"]] = info
            if state_dir:
                os.makedirs(state_dir, exist_ok=True)
                tmp = ckpt_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(done, f, ensure_ascii=False)
                os.replace(tmp, ckpt_path)
            if n % 25 == 0:
                log(f"bank_ownership_docs: {n}/{len(banks)} bank pages")
            time.sleep(PAGE_DELAY)
        info = done[b["mfo"]]
        for d in info["docs"]:
            snap.rows.append({
                "pdf_url": d["pdf_url"], "bank_mfo": b["mfo"],
                "bank_name": info.get("bank_name") or b["label"], "bank_label": b["label"],
                "bank_edrpou": mfo_edrpou.get(b["mfo"]), "bank_group": b["group"],
                "name_history": info.get("name_history"), "as_of_date": d["as_of_date"],
            })
    # Same PDF linked from two pages: keep the first.
    uniq = {}
    for r in snap.rows:
        uniq.setdefault(r["pdf_url"], r)
    snap.rows = list(uniq.values())
    snap.ckpt_path = ckpt_path  # type: ignore[attr-defined]
    return snap


# ─── Downloads ────────────────────────────────────────────────────────────


def http_get(url: str, accept: str = "*/*") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


_banks_cache: list[dict] | None = None


def nbu_banks() -> list[dict]:
    global _banks_cache
    if _banks_cache is None:
        try:
            _banks_cache = json.loads(http_get(BANKS_API, "application/json"))
        except Exception as e:  # noqa: BLE001 - edges still load, with institution_edrpou NULL
            log(f"NBU_BankInfo unavailable ({e}); bank ЄДРПОУ will not be resolved")
            _banks_cache = []
    return _banks_cache


def parse(list_name: str, data: bytes, state_dir: str = "") -> Snapshot:
    if list_name == "ree_fu":
        return parse_ree_fu(data)
    if list_name in ("nonbank_approved", "nonbank_no_voting"):
        return parse_nonbank(data, list_name)
    if list_name == "bank_decisions":
        return parse_bank_decisions(data, bank_index(nbu_banks()))
    if list_name == "bank_ownership_docs":
        return crawl_ownership_docs(data.decode("utf-8", "replace"), mfo_index(nbu_banks()), state_dir)
    raise ValueError(list_name)


def check_snapshot(snap: Snapshot) -> None:
    if not snap.rows:
        raise RuntimeError(f"{snap.list_name}: no rows parsed")
    if snap.list_name == "ree_fu" and not snap.licenses:
        raise RuntimeError("ree_fu: sheet with licences not found or empty")


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
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def copy_value(v) -> str:
    if v is None:
        return r"\N"
    s = ("true" if v else "false") if isinstance(v, bool) else str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def copy_block(table: str, columns: list[str], rows: list[dict]) -> str:
    body = "\n".join("\t".join(copy_value(r.get(c)) for c in columns) for r in rows)
    return (f"COPY {table} ({', '.join(columns)}) FROM STDIN WITH (FORMAT text, NULL '\\N');\n"
            f"{body}\n\\.\n")


INST_COLS = ["edrpou", "name", "institution_type", "register_name", "address", "head_name", "registered_date"]
LIC_COLS = ["edrpou", "institution_name", "institution_type", "license_status", "license_name", "service",
            "insurance_type", "issued_date", "service_start_date", "validity"]
EDGE_COLS = ["source_list", "institution_kind", "institution_edrpou", "institution_name", "owner_name",
             "owner_kind", "owner_code", "owner_code_kind", "owner_country", "share_direct", "share_indirect",
             "share_total", "is_direct", "is_indirect", "participation", "action", "decision", "decision_date",
             "decision_number", "publication_date", "relation_description", "restriction_basis", "trustee_name",
             "trustee_appointed", "note", "as_of_date"]
DOC_COLS = ["pdf_url", "bank_mfo", "bank_name", "bank_label", "bank_edrpou", "bank_group", "name_history",
            "as_of_date"]


def ratio_guard(name: str, staged_sql: str, held_sql: str) -> str:
    return f"""
DO $$
DECLARE staged bigint; held bigint;
BEGIN
  SELECT count(*) INTO staged FROM {staged_sql};
  SELECT count(*) INTO held FROM {held_sql};
  IF held > 0 AND staged < held * {MIN_RATIO} THEN
    RAISE EXCEPTION '{name}: snapshot has % rows, table holds % (min ratio {MIN_RATIO}), not loaded',
      staged, held;
  END IF;
END $$;
"""


def journal_sql(snap: Snapshot, source_url: str, sha256: str, size: int, parsed: int) -> str:
    return f"""
INSERT INTO nbu_fin_snapshots
  (list_name, file_sha256, snapshot_date, source_url, file_size, rows_parsed, rows_upserted, rows_removed)
SELECT {lit(snap.list_name)}, {lit(sha256)}, {lit(snap.snapshot_date)}::date, {lit(source_url)}, {size},
       {parsed}, (SELECT n FROM nbu_res WHERE k = 'up'), (SELECT n FROM nbu_res WHERE k = 'del')
ON CONFLICT (list_name, file_sha256) DO UPDATE SET
  rows_upserted = EXCLUDED.rows_upserted, rows_removed = EXCLUDED.rows_removed, loaded_at = NOW();
SELECT 'RESULT|' || (SELECT n FROM nbu_res WHERE k = 'up') || '|' || (SELECT n FROM nbu_res WHERE k = 'del');
COMMIT;
"""


def load_sql(snap: Snapshot, source_url: str, sha256: str, size: int) -> str:
    sd = f"{lit(snap.snapshot_date)}::date"
    src = lit(source_url)
    head = "BEGIN;\nCREATE TEMP TABLE nbu_res (k text PRIMARY KEY, n bigint) ON COMMIT DROP;\n"
    if snap.list_name == "ree_fu":
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in INST_COLS if c != "edrpou")
        body = f"""
CREATE TEMP TABLE nbu_inst_stage (LIKE nbu_fin_institutions INCLUDING DEFAULTS) ON COMMIT DROP;
{copy_block('nbu_inst_stage', INST_COLS, snap.rows)}
CREATE TEMP TABLE nbu_lic_stage (LIKE nbu_fin_licenses INCLUDING DEFAULTS) ON COMMIT DROP;
{copy_block('nbu_lic_stage', LIC_COLS, snap.licenses)}
{ratio_guard('ree_fu', 'nbu_inst_stage', 'nbu_fin_institutions WHERE in_register')}
WITH up AS (
  INSERT INTO nbu_fin_institutions ({', '.join(INST_COLS)}, in_register, first_seen_snapshot,
                                    last_seen_snapshot, removed_detected, snapshot_date, source_url)
  SELECT {', '.join(INST_COLS)}, TRUE, {sd}, {sd}, NULL, {sd}, {src} FROM nbu_inst_stage
  ON CONFLICT (edrpou) DO UPDATE SET {sets}, in_register = TRUE, removed_detected = NULL,
    last_seen_snapshot = EXCLUDED.last_seen_snapshot, snapshot_date = EXCLUDED.snapshot_date,
    source_url = EXCLUDED.source_url, updated_at = NOW()
  RETURNING 1
)
INSERT INTO nbu_res SELECT 'up', count(*) FROM up;
WITH gone AS (
  UPDATE nbu_fin_institutions t SET in_register = FALSE, removed_detected = {sd}, updated_at = NOW()
   WHERE t.in_register AND NOT EXISTS (SELECT 1 FROM nbu_inst_stage s WHERE s.edrpou = t.edrpou)
  RETURNING 1
)
INSERT INTO nbu_res SELECT 'del', count(*) FROM gone;
DELETE FROM nbu_fin_licenses;
INSERT INTO nbu_fin_licenses ({', '.join(LIC_COLS)}, snapshot_date, source_url)
SELECT {', '.join(LIC_COLS)}, {sd}, {src} FROM nbu_lic_stage;
"""
        return head + body + journal_sql(snap, source_url, sha256, size, len(snap.rows))

    if snap.list_name == "bank_ownership_docs":
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in DOC_COLS if c != "pdf_url")
        body = f"""
CREATE TEMP TABLE nbu_doc_stage (LIKE nbu_bank_ownership_documents INCLUDING DEFAULTS) ON COMMIT DROP;
{copy_block('nbu_doc_stage', DOC_COLS, snap.rows)}
{ratio_guard('bank_ownership_docs', 'nbu_doc_stage', 'nbu_bank_ownership_documents WHERE last_seen >= CURRENT_DATE - 60')}
WITH up AS (
  INSERT INTO nbu_bank_ownership_documents ({', '.join(DOC_COLS)}, first_seen, last_seen)
  SELECT {', '.join(DOC_COLS)}, CURRENT_DATE, CURRENT_DATE FROM nbu_doc_stage
  ON CONFLICT (pdf_url) DO UPDATE SET {sets}, last_seen = CURRENT_DATE
  RETURNING 1
)
INSERT INTO nbu_res SELECT 'up', count(*) FROM up;
INSERT INTO nbu_res VALUES ('del', 0);
"""
        return head + body + journal_sql(snap, source_url, sha256, size, len(snap.rows))

    # ownership edges: replace the rows of this list
    body = f"""
CREATE TEMP TABLE nbu_edge_stage (LIKE nbu_fin_ownership INCLUDING DEFAULTS) ON COMMIT DROP;
{copy_block('nbu_edge_stage', EDGE_COLS, snap.rows)}
{ratio_guard(snap.list_name, 'nbu_edge_stage', f"nbu_fin_ownership WHERE source_list = {lit(snap.list_name)}")}
WITH del AS (DELETE FROM nbu_fin_ownership WHERE source_list = {lit(snap.list_name)} RETURNING 1)
INSERT INTO nbu_res SELECT 'del', count(*) FROM del;
WITH up AS (
  INSERT INTO nbu_fin_ownership ({', '.join(EDGE_COLS)}, snapshot_date, source_url)
  SELECT {', '.join(EDGE_COLS)}, {sd}, {src} FROM nbu_edge_stage
  RETURNING 1
)
INSERT INTO nbu_res SELECT 'up', count(*) FROM up;
"""
    return head + body + journal_sql(snap, source_url, sha256, size, len(snap.rows))


def already_loaded(list_name: str, sha256: str) -> bool:
    out = psql(f"SELECT 1 FROM nbu_fin_snapshots WHERE list_name = {lit(list_name)} "
               f"AND file_sha256 = {lit(sha256)};")
    return out.strip() == "1"


# ─── Main ─────────────────────────────────────────────────────────────────


def content_hash(snap: Snapshot, data: bytes) -> str:
    """For the crawled PDF index the journal hash is over the parsed rows, not one page."""
    if snap.list_name == "bank_ownership_docs":
        rows = sorted((r["pdf_url"], r["bank_name"] or "", r["bank_group"] or "") for r in snap.rows)
        return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()
    return hashlib.sha256(data).hexdigest()


def run_list(list_name: str, file: str | None, dry_run: bool, force: bool, state_dir: str,
             source_url: str | None = None) -> None:
    t0 = time.time()
    if file:
        with open(file, "rb") as f:
            data = f.read()
        url = source_url or f"file:{os.path.basename(file)}"
    else:
        url = URLS[list_name]
        log(f"{list_name}: downloading {url}")
        data = http_get(url)

    if list_name != "bank_ownership_docs" and not force and not dry_run:
        sha = hashlib.sha256(data).hexdigest()
        if already_loaded(list_name, sha):
            log(f"{list_name}: this file is already loaded, skipping (use --force to reload)")
            return

    snap = parse(list_name, data, state_dir)
    check_snapshot(snap)
    sha = content_hash(snap, data)
    extra = f", {len(snap.licenses)} licence rows" if snap.licenses else ""
    unresolved = sum(1 for r in snap.rows if "institution_edrpou" in r and not r["institution_edrpou"])
    extra += f", {unresolved} without institution ЄДРПОУ" if unresolved else ""
    log(f"{list_name}: {len(snap.rows)} rows parsed ({snap.skipped} skipped){extra}, "
        f"snapshot {snap.snapshot_date}, {len(data) // 1024} KB, sha256 {sha[:12]}")
    if dry_run:
        return
    if list_name == "bank_ownership_docs" and not force and already_loaded(list_name, sha):
        log(f"{list_name}: index unchanged since the last load, skipping")
    else:
        out = psql(load_sql(snap, url, sha, len(data)))
        m = re.search(r"RESULT\|(\d+)\|(\d+)", out)
        upserted, removed = (m[1], m[2]) if m else ("?", "?")
        log(f"{list_name}: {upserted} upserted, {removed} removed/replaced ({time.time() - t0:.0f}s)")
    ckpt = getattr(snap, "ckpt_path", None)
    if ckpt and os.path.exists(ckpt):
        os.remove(ckpt)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="append", required=True, choices=LISTS + ["all"],
                    help="list to load; repeat for several, 'all' for every list")
    ap.add_argument("--file", help="load a local file instead of downloading (one --list only)")
    ap.add_argument("--source-url", help="--file: URL the file was downloaded from (stored as source_url)")
    ap.add_argument("--state-dir", default=os.environ.get("NBU_FIN_STATE_DIR", "/tmp/nbu_fin_state"),
                    help="checkpoint directory for the PDF index crawl")
    ap.add_argument("--dry-run", action="store_true", help="download and parse only")
    ap.add_argument("--force", action="store_true", help="reload a file already journalled")
    a = ap.parse_args(argv)

    lists = LISTS if "all" in a.list else list(dict.fromkeys(a.list))
    if a.file and len(lists) != 1:
        ap.error("--file needs exactly one --list")

    failed = []
    for name in lists:
        try:
            run_list(name, a.file, a.dry_run, a.force, a.state_dir, a.source_url)
        except Exception as e:  # noqa: BLE001 - one broken list must not block the others
            log(f"ERROR {name}: {e}")
            failed.append(name)
    if failed:
        log(f"failed: {', '.join(failed)}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
