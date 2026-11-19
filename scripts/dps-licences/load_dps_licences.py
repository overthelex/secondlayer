#!/usr/bin/env python3
"""
Load the ДПС licence registers from data.gov.ua into dps_licences (LEXAI-2298).

Publisher: «Державна податкова служба України» (data.gov.ua organization `tax`). The registers are
CSV files, one or two per dataset: an undated file (registerN-M.csv, licences of 2014-2019) and a
snapshot of 23.02.2022 (registerN-M_2022-02-23.csv, with ЄДРПОУ). Since КМУ resolution No 1151
(10.09.2025) the datasets are marked «Більше не оновлюється»; the schedule only picks up a new file
if ДПС resumes publishing.

Datasets are resolved through the CKAN API on every run (data.gov.ua dataset ids move): a
package_search over the `tax` organization for «Ліцензійний реєстр…» titles, plus package_show of
the ids in KNOWN_DATASETS. Every CSV resource except structure_* files is one snapshot.

Columns differ between files (codes NM/TIN/VDNM/LICNUM/LICBEG/LICEND/TRADEADDRESS/STI_NM/STI_ADDR
or long Ukrainian headers), and in some files the header order does not match the data (the e-cig
retail file names TRADEADDRESS 4th, the data carries it last), so a header's column is checked
against the values and re-assigned by content when it does not fit.

ФОП licensees: the register prints «*» instead of the РНОКПП; only the name is stored. A 10-digit
code (an РНОКПП) is never stored either.

A load replaces the rows of that resource in dps_licences and journals the file (sha256, snapshot
date, source URL) in dps_licence_snapshots, in one transaction. A file whose sha256 is already
journalled for that resource is skipped. A snapshot under DPS_LICENCES_MIN_RATIO (default 0.5) of
the rows the table holds for that resource, or with more than DPS_LICENCES_MAX_SKIP (default 0.2) of
its rows unparseable, aborts.

Usage:
  load_dps_licences.py --all                       # resolve every licence dataset and load it
  load_dps_licences.py --all --list-only           # print the resolved datasets and resources
  load_dps_licences.py --dataset 295e8687-056a-4195-bbba-4a538489e728
  load_dps_licences.py --file register4-3_2022-02-23.csv [--register register4-3]
                       [--licence-type "Роздрібна торгівля тютюновими виробами"] [--source-url URL]
  add --dry-run to parse and print counts only, --force to reload a journalled file.

Database access goes through the psql client (Python standard library only):
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

USER_AGENT = "SecondLayer-opendata-sync/1.0 (dps licences loader)"
HTTP_TIMEOUT = int(os.environ.get("DPS_LICENCES_HTTP_TIMEOUT", "300"))
MIN_RATIO = float(os.environ.get("DPS_LICENCES_MIN_RATIO", "0.5"))
MAX_SKIP = float(os.environ.get("DPS_LICENCES_MAX_SKIP", "0.2"))
CKAN_API = os.environ.get("DPS_LICENCES_CKAN_API", "https://data.gov.ua/api/3/action")
ORGANIZATION = "tax"

# Licence datasets of ДПС seen on data.gov.ua (dataset page ids, 2026). The search finds the rest;
# these are also asked by id so a search-index hiccup cannot silently drop them.
KNOWN_DATASETS = [
    "295e8687-056a-4195-bbba-4a538489e728",  # роздрібна торгівля тютюновими виробами (Register4.3)
    "87ed18a7-c4ef-4ed7-87d1-8cd06ca21db7",  # роздрібна торгівля сидром та перрі (Register4.2)
    "2c33b2b3-e767-4827-b9c7-ea2db5a3f952",  # роздрібна торгівля рідинами для е-сигарет
]

TITLE_RE = re.compile(r"ліценз", re.I)
TITLE_PREFIX_RE = re.compile(
    r"^\s*ліцензійний\s+реєстр\s+(?:виданих\s+)?ліцензій\s+(?:на\s+)?(?:право\s+)?(?:здійснення\s+)?", re.I)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── Value parsing ────────────────────────────────────────────────────────

DATE_RE = re.compile(r"^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$")
ISO_DATE_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})")
LICNUM_RE = re.compile(r"^\s*№?\s*\d{5,}\s*$")
ADDRESS_HINT_RE = re.compile(r"УКРА[ЇI]НА|ОБЛ\.|ОБЛАСТЬ|\bВУЛ\.?|\bВУЛИЦЯ\b|\bПРОСП|\bБУД\b|\bМ\.\s*\w|\bСМТ\b|\bС\.\s*\w|РАЙОН|Р-Н", re.I)
FOP_NAME_RE = re.compile(r"^\s*(ФІЗИЧНА\s+ОСОБА|ФIЗИЧНА\s+ОСОБА|ФОП\b|Ф\.О\.П\.|СПД\b|СУБ.ЄКТ\s+ПІДПРИЄМНИЦЬКОЇ)", re.I)


def parse_date(s: str | None) -> str | None:
    """'14.05.2021' -> '2021-05-14'; ISO dates pass through; anything else -> None."""
    s = (s or "").strip()
    m = DATE_RE.match(s)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
    else:
        m = ISO_DATE_RE.match(s)
        if not m:
            return None
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def clean(s: str | None) -> str | None:
    if s is None:
        return None
    s = re.sub(r"\s+", " ", s.replace("\u00a0", " ")).strip()
    return s or None


def licence_number(s: str | None) -> str | None:
    s = clean(s)
    if not s:
        return None
    return re.sub(r"^№\s*", "", s) or None


def edrpou_code(tin: str | None) -> str | None:
    """ЄДРПОУ of a legal entity, zero-padded to 8 digits; None for masked, РНОКПП-like or junk."""
    t = (tin or "").strip()
    if not t or "*" in t:
        return None
    if re.fullmatch(r"\d+(?:\.0)?", t):
        t = t.split(".")[0]
        if len(t) <= 8 and int(t) > 0:
            return t.zfill(8)
    return None


def licensee_type(name: str | None, tin: str | None) -> str:
    """fop for a ФОП (name prefix, masked «*» code or a 9-10 digit РНОКПП), else legal_entity."""
    t = (tin or "").strip()
    if FOP_NAME_RE.match(name or "") or "*" in t or re.fullmatch(r"\d{9,10}", t):
        return "fop"
    return "legal_entity" if (name or "").strip() else "unknown"


_LATIN_TO_CYR = str.maketrans({"I": "І", "i": "і", "A": "А", "O": "О", "E": "Е", "C": "С", "P": "Р",
                               "K": "К", "M": "М", "H": "Н", "T": "Т", "X": "Х", "B": "В"})


def normalize_address(addr: str | None) -> str | None:
    """Upper-case, Latin look-alikes -> Cyrillic, punctuation -> space, no leading «УКРАЇНА»."""
    a = clean(addr)
    if not a:
        return None
    a = a.upper().translate(_LATIN_TO_CYR).replace("’", "'").replace("`", "'").replace("ʼ", "'")
    a = re.sub(r"[\"«»“”.,;:()\-–—/\\№]+", " ", a)
    a = re.sub(r"\s+", " ", a).strip()
    a = re.sub(r"^(?:\d{5}\s+)?УКРАЇНА\s+", "", a)
    a = " ".join(t for t in (ADDRESS_TOKENS.get(w, w) for w in a.split(" ")) if t)
    return a or None


# Spelling variants of the same address part; «буд.» is dropped so «вул. Перша, буд 1» == «вул. Перша,1».
ADDRESS_TOKENS = {
    "ВУЛИЦЯ": "ВУЛ", "ОБЛАСТЬ": "ОБЛ", "МІСТО": "М", "РАЙОН": "Р Н", "ПРОСПЕКТ": "ПРОСП",
    "ПРОВУЛОК": "ПРОВ", "БУЛЬВАР": "БУЛЬВ", "СЕЛИЩЕ": "СЕЛ", "БУД": "", "БУДИНОК": "",
}


def classify(licence_type: str | None) -> tuple[str | None, str | None]:
    """(category, activity) from the licence type text."""
    t = (licence_type or "").lower()
    if not t:
        return None, None
    if "пальн" in t:
        cat = "fuel"
    elif "тютюн" in t:
        cat = "tobacco"
    elif "рідин" in t or "електронн" in t:
        cat = "ecig_liquid"
    elif "сидр" in t and "крім сидр" not in t:
        cat = "cider_perry"
    elif "алкогол" in t or "вин" in t or "коньяк" in t or "пив" in t:
        cat = "alcohol"
    elif "спирт" in t or "біоетанол" in t or "дистилят" in t:
        cat = "spirit"
    else:
        cat = "other"
    if "оптов" in t:
        act = "wholesale"
    elif "роздрібн" in t:
        act = "retail"
    elif "зберіган" in t:
        act = "storage"
    elif "виробництв" in t:
        act = "production"
    else:
        act = "other"
    return cat, act


def licence_type_from_title(title: str | None) -> str | None:
    t = clean(title)
    if not t:
        return None
    t = TITLE_PREFIX_RE.sub("", t).strip()
    return (t[:1].upper() + t[1:]) if t else None


# ─── File decoding and column roles ───────────────────────────────────────


def decode(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8"), "utf-8"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("cp1251"), "cp1251"


def sniff_delimiter(header_line: str) -> str:
    counts = {d: header_line.count(d) for d in (";", "\t", ",")}
    return max(counts, key=lambda d: counts[d]) if max(counts.values()) else ";"


HEADER_ROLES: list[tuple[str, re.Pattern]] = [
    ("rn", re.compile(r"^(rn|№\s*п/п|№|n\s*п/п)$", re.I)),
    # «Орган ліцезування» (sic) in the ДПС headers
    ("authority_address", re.compile(r"^sti_addr$|орган\s+ліце\w*.*адрес|адреса\s+органу", re.I)),
    ("authority", re.compile(r"^sti_nm$|орган\s+ліце", re.I)),
    ("tin", re.compile(r"^(tin|edrpou|єдрпоу)$|код\s+(за\s+)?єдрпоу|ідентифікаційн", re.I)),
    ("activity", re.compile(r"^vdnm$|вид\s+(господарсько|діяльн)", re.I)),
    ("number", re.compile(r"^(licnum|lic_num)$|(реєстраційн\w*|серія\s*(та|і)?)\s*№?\s*(номер\s+)?ліценз|номер\s+ліценз|№\s+ліценз", re.I)),
    ("valid_from", re.compile(r"^(licbeg|lic_beg|datebeg)$|термін\s+дії.*\bз$|дата\s+початку|дійсна\s+з", re.I)),
    ("valid_to", re.compile(r"^(licend|lic_end|dateend)$|термін\s+дії.*\bдо$|дата\s+закінчення|дійсна\s+до", re.I)),
    ("revocation_date", re.compile(r"^(dateanul|anuldate)$|дата\s+(анулювання|скасування|припинення)", re.I)),
    ("revocation_reason", re.compile(r"^(anulreason)$|підстав\w*\s+(анулювання|скасування|припинення)|причин", re.I)),
    ("status", re.compile(r"^(status|state|stan)$|стан\s+ліценз|статус", re.I)),
    ("address", re.compile(r"^(tradeaddress|address|addr|placeaddress)$|адрес\w*\s+(місц|торг|потужн|складу|акциз)|місц\w*\s+(торгівлі|провадження|зберігання|виробництва)", re.I)),
    ("name", re.compile(r"^(nm|name)$|найменування\s+(суб|юридичн|ліценз)|прізвище|ліцензіат", re.I)),
]

CONTENT_ROLES = ("number", "valid_from", "valid_to", "address")


def header_roles(header: list[str]) -> dict[str, int]:
    roles: dict[str, int] = {}
    for i, h in enumerate(header):
        h = clean(h.lstrip("\ufeff")) or ""
        for role, rx in HEADER_ROLES:
            if role not in roles and rx.search(h):
                roles[role] = i
                break
    return roles


def column_profile(rows: list[list[str]], ncols: int, sample: int = 500) -> list[dict[str, float]]:
    rows = rows[:sample]
    prof = []
    for i in range(ncols):
        vals = [r[i].strip() for r in rows if i < len(r) and r[i].strip()]
        n = len(vals) or 1
        prof.append({
            "date": sum(1 for v in vals if parse_date(v)) / n,
            "number": sum(1 for v in vals if LICNUM_RE.match(v)) / n,
            "address": sum(1 for v in vals if ADDRESS_HINT_RE.search(v)) / n,
            "filled": len(vals) / (len(rows) or 1),
        })
    return prof


def fits(role: str, p: dict[str, float]) -> bool:
    if role in ("valid_from", "valid_to"):
        return p["date"] >= 0.5
    if role == "number":
        return p["number"] >= 0.5
    if role == "address":
        return p["address"] >= 0.3 and p["date"] < 0.5 and p["number"] < 0.5
    return True


def resolve_roles(header: list[str], rows: list[list[str]]) -> tuple[dict[str, int], list[str]]:
    """Header roles, with number/dates/address re-assigned by content when the header misleads."""
    roles = header_roles(header)
    ncols = max([len(header)] + [len(r) for r in rows[:500]])
    prof = column_profile(rows, ncols)
    notes = []
    if not rows:
        return roles, notes
    fixed = {roles[r] for r in roles if r not in CONTENT_ROLES}
    bad = [r for r in CONTENT_ROLES if r in roles and not fits(r, prof[roles[r]])]
    if not bad:
        return roles, notes
    free = [i for i in range(ncols) if i not in fixed]
    for r in CONTENT_ROLES:
        roles.pop(r, None)
    dates = [i for i in free if prof[i]["date"] >= 0.5]
    if len(dates) >= 2:
        roles["valid_from"], roles["valid_to"] = dates[0], dates[1]
    elif len(dates) == 1:
        roles["valid_from"] = dates[0]
    nums = sorted((i for i in free if prof[i]["number"] >= 0.5 and i not in dates),
                  key=lambda i: -prof[i]["number"])
    if nums:
        roles["number"] = nums[0]
    taken = set(roles.values())
    addrs = sorted((i for i in free if i not in taken and fits("address", prof[i])),
                   key=lambda i: -prof[i]["address"])
    if addrs:
        roles["address"] = addrs[0]
    notes.append(f"header order does not match the data ({', '.join(bad)}); columns assigned by content")
    return roles, notes


# ─── Parsed snapshot ──────────────────────────────────────────────────────

COLUMNS = [
    "resource_id", "row_no", "register_code", "licence_type", "licence_category", "activity",
    "licence_number", "edrpou", "licensee_type", "licensee_name", "premises_address",
    "premises_address_norm", "licensing_authority", "licensing_authority_address", "valid_from",
    "valid_to", "status", "revocation_date", "revocation_reason", "snapshot_date", "source_url",
]


@dataclass
class Resource:
    resource_id: str
    url: str
    file_name: str
    register_code: str
    licence_type: str | None = None   # default when the file has no VDNM column
    dataset_id: str | None = None
    dataset_title: str | None = None
    snapshot_date: str | None = None
    last_modified: str | None = None


@dataclass
class Snapshot:
    resource: Resource
    rows: list[dict] = field(default_factory=list)
    skipped: int = 0
    encoding: str = "utf-8"
    notes: list[str] = field(default_factory=list)


def cell(row: list[str], roles: dict[str, int], role: str) -> str | None:
    i = roles.get(role)
    return clean(row[i]) if i is not None and i < len(row) else None


def parse_csv(data: bytes, res: Resource) -> Snapshot:
    text, enc = decode(data)
    snap = Snapshot(res, encoding=enc)
    first = text.split("\n", 1)[0]
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=sniff_delimiter(first))
    all_rows = [r for r in reader if any(c.strip() for c in r)]
    if not all_rows:
        raise ValueError(f"{res.file_name}: empty file")
    header, body = all_rows[0], all_rows[1:]
    roles, snap.notes = resolve_roles(header, body)
    if "name" not in roles:
        raise ValueError(f"{res.file_name}: no licensee name column in header {header}")
    if "number" not in roles and "valid_from" not in roles:
        raise ValueError(f"{res.file_name}: neither a licence number nor a date column in header {header}")

    for n, r in enumerate(body, start=1):
        name = cell(r, roles, "name")
        number = licence_number(cell(r, roles, "number"))
        if not name or not (number or cell(r, roles, "valid_from")):
            snap.skipped += 1
            continue
        tin = cell(r, roles, "tin")
        code = edrpou_code(tin)
        ltype = licensee_type(name, tin)
        if ltype == "fop":
            code = None
        lt = cell(r, roles, "activity") or res.licence_type or res.register_code
        cat, act = classify(lt)
        addr = cell(r, roles, "address")
        snap.rows.append({
            "resource_id": res.resource_id,
            "row_no": n,
            "register_code": res.register_code,
            "licence_type": lt,
            "licence_category": cat,
            "activity": act,
            "licence_number": number,
            "edrpou": code,
            "licensee_type": ltype,
            "licensee_name": name,
            "premises_address": addr,
            "premises_address_norm": normalize_address(addr),
            "licensing_authority": cell(r, roles, "authority"),
            "licensing_authority_address": cell(r, roles, "authority_address"),
            "valid_from": parse_date(cell(r, roles, "valid_from")),
            "valid_to": parse_date(cell(r, roles, "valid_to")),
            "status": cell(r, roles, "status"),
            "revocation_date": parse_date(cell(r, roles, "revocation_date")),
            "revocation_reason": cell(r, roles, "revocation_reason"),
            "snapshot_date": res.snapshot_date,
        })
    return snap


def check_snapshot(snap: Snapshot) -> None:
    total = len(snap.rows) + snap.skipped
    if not snap.rows:
        raise RuntimeError(f"{snap.resource.file_name}: no licences parsed")
    if total and snap.skipped / total > MAX_SKIP:
        raise RuntimeError(f"{snap.resource.file_name}: {snap.skipped} of {total} rows unparseable "
                           f"(max {MAX_SKIP:.0%}), not loaded")


# ─── CKAN resolution ──────────────────────────────────────────────────────

FILE_DATE_RES = [
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), lambda m: (m[1], m[2], m[3])),
    (re.compile(r"(?<!\d)(\d{2})[._](\d{2})[._](\d{4})(?!\d)"), lambda m: (m[3], m[2], m[1])),
    (re.compile(r"(?<!\d)(\d{2})(\d{2})(20\d{2})(?!\d)"), lambda m: (m[3], m[2], m[1])),
]


def date_from_file_name(name: str) -> str | None:
    for rx, ymd in FILE_DATE_RES:
        m = rx.search(name)
        if m:
            y, mo, d = ymd(m)
            try:
                return dt.date(int(y), int(mo), int(d)).isoformat()
            except ValueError:
                continue
    return None


def register_code_for(file_name: str, dataset_name: str | None = None) -> str:
    base = file_name.rsplit("/", 1)[-1].lower()
    m = re.search(r"register\s*(\d+(?:[-_.]\d+)?)", base)
    if m:
        return "register" + re.sub(r"[_.]", "-", m[1]).rstrip("-")
    if "sugaret" in base or "cigaret" in base or "elektron" in base:
        if "rozdrib" in base:
            return "ecig_retail"
        if "optov" in base:
            return "ecig_wholesale"
        return "ecig"
    stem = re.sub(r"\.[a-z0-9]+$", "", base)
    stem = re.sub(r"[-_]?\d{4}-\d{2}-\d{2}$", "", stem)
    stem = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return stem or (dataset_name or "unknown")


def is_data_resource(r: dict) -> bool:
    url = str(r.get("url") or "")
    fname = url.split("?")[0].rsplit("/", 1)[-1].lower()
    fmt = str(r.get("format") or "").strip().lower().lstrip(".")
    if fname.startswith("structure") or "struktur" in fname or "passport" in fname:
        return False
    return fname.endswith(".csv") or fmt in ("csv", "сsv")  # ДПС spells it with a Cyrillic «с»


def resources_of(pkg: dict) -> list[Resource]:
    out = []
    lt = licence_type_from_title(pkg.get("title"))
    for r in pkg.get("resources") or []:
        if not is_data_resource(r):
            continue
        url = str(r["url"])
        fname = url.split("?")[0].rsplit("/", 1)[-1]
        lm = r.get("last_modified") or r.get("metadata_modified") or r.get("created")
        out.append(Resource(
            resource_id=str(r.get("id") or fname), url=url, file_name=fname,
            register_code=register_code_for(fname, pkg.get("name")), licence_type=lt,
            dataset_id=pkg.get("id"), dataset_title=pkg.get("title"),
            snapshot_date=date_from_file_name(fname) or (lm[:10] if lm else None), last_modified=lm,
        ))
    return out


def is_licence_dataset(pkg: dict) -> bool:
    org = (pkg.get("organization") or {}).get("name")
    return bool(TITLE_RE.search(pkg.get("title") or "")) and (org in (None, ORGANIZATION))


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


def ckan(action: str, **params) -> dict:
    url = f"{CKAN_API}/{action}?{urllib.parse.urlencode(params)}"
    body = http_get(url, "application/json")
    try:
        doc = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"CKAN {action}: not JSON (portal down? first bytes: {body[:80]!r})")
    if not doc.get("success"):
        raise RuntimeError(f"CKAN {action}: {doc.get('error')}")
    return doc["result"]


def resolve_datasets(ids: list[str] | None = None) -> list[dict]:
    """Licence datasets of ДПС: package_search plus package_show of KNOWN_DATASETS (or of ids)."""
    pkgs: dict[str, dict] = {}
    if ids is None:
        start = 0
        while True:
            res = ckan("package_search", fq=f"organization:{ORGANIZATION}", q="ліцензій",
                       rows=200, start=start)
            for p in res.get("results", []):
                if is_licence_dataset(p):
                    pkgs[p["id"]] = p
            start += 200
            if start >= int(res.get("count", 0)):
                break
        ids = KNOWN_DATASETS
    for i in ids:
        try:
            p = ckan("package_show", id=i)
        except Exception as e:  # noqa: BLE001 - a moved id is reported, the search result still counts
            log(f"package_show {i}: {e}")
            continue
        pkgs[p["id"]] = p
    return sorted(pkgs.values(), key=lambda p: p.get("title") or "")


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
    s = str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def load_sql(snap: Snapshot, source_url: str, sha256: str, size: int) -> str:
    res = snap.resource
    cols = ", ".join(COLUMNS)
    rows = "\n".join("\t".join(copy_value(r.get(c)) for c in COLUMNS) for r in snap.rows)
    rid = lit(res.resource_id)
    return f"""
BEGIN;
CREATE TEMP TABLE dps_lic_stage (LIKE dps_licences INCLUDING DEFAULTS) ON COMMIT DROP;
ALTER TABLE dps_lic_stage DROP COLUMN id;
COPY dps_lic_stage ({cols}) FROM STDIN WITH (FORMAT text, NULL '\\N');
{rows}
\\.
UPDATE dps_lic_stage SET source_url = {lit(source_url)};
DO $$
DECLARE staged bigint; held bigint;
BEGIN
  SELECT count(*) INTO staged FROM dps_lic_stage;
  SELECT count(*) INTO held FROM dps_licences WHERE resource_id = {rid};
  IF held > 0 AND staged < held * {MIN_RATIO} THEN
    RAISE EXCEPTION '{res.file_name}: snapshot has % rows, table holds % (min ratio {MIN_RATIO}), not loaded',
      staged, held;
  END IF;
END $$;
WITH del AS (
  DELETE FROM dps_licences WHERE resource_id = {rid} RETURNING 1
), ins AS (
  INSERT INTO dps_licences ({cols}) SELECT {cols} FROM dps_lic_stage RETURNING 1
), j AS (
  INSERT INTO dps_licence_snapshots
    (resource_id, file_sha256, dataset_id, register_code, file_name, snapshot_date, source_url,
     file_size, encoding, rows_parsed, rows_skipped, rows_loaded, rows_removed)
  SELECT {rid}, {lit(sha256)}, {lit(res.dataset_id)}, {lit(res.register_code)}, {lit(res.file_name)},
         {lit(res.snapshot_date)}::date, {lit(source_url)}, {size}, {lit(snap.encoding)},
         {len(snap.rows)}, {snap.skipped}, (SELECT count(*) FROM ins), (SELECT count(*) FROM del)
  ON CONFLICT (resource_id, file_sha256) DO UPDATE SET
    rows_loaded = EXCLUDED.rows_loaded, rows_removed = EXCLUDED.rows_removed, loaded_at = NOW()
  RETURNING rows_loaded, rows_removed
)
SELECT 'RESULT|' || rows_loaded || '|' || rows_removed FROM j;
COMMIT;
"""


def already_loaded(resource_id: str, sha256: str) -> bool:
    out = psql(f"SELECT 1 FROM dps_licence_snapshots WHERE resource_id = {lit(resource_id)} "
               f"AND file_sha256 = {lit(sha256)};")
    return out.strip() == "1"


# ─── Main ─────────────────────────────────────────────────────────────────


def run_resource(res: Resource, data: bytes | None, dry_run: bool, force: bool) -> int:
    t0 = time.time()
    if data is None:
        log(f"{res.register_code}: downloading {res.url}")
        data = http_get(res.url)
    sha = hashlib.sha256(data).hexdigest()
    snap = parse_csv(data, res)
    check_snapshot(snap)
    for note in snap.notes:
        log(f"{res.file_name}: {note}")
    by_type: dict[str, int] = {}
    for r in snap.rows:
        by_type[r["licence_type"]] = by_type.get(r["licence_type"], 0) + 1
    fop = sum(1 for r in snap.rows if r["licensee_type"] == "fop")
    with_code = sum(1 for r in snap.rows if r["edrpou"])
    with_addr = sum(1 for r in snap.rows if r["premises_address"])
    log(f"{res.register_code} ({res.file_name}): {len(snap.rows)} licences, {snap.skipped} skipped, "
        f"ЄДРПОУ {with_code}, ФОП {fop}, address {with_addr}, snapshot {res.snapshot_date}, "
        f"{snap.encoding}, {len(data) // 1024} KB, sha256 {sha[:12]}")
    for t, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
        log(f"    {n:7d}  {t}")
    if dry_run:
        return len(snap.rows)
    if not force and already_loaded(res.resource_id, sha):
        log(f"{res.file_name}: already loaded, skipping (use --force to reload)")
        return len(snap.rows)
    out = psql(load_sql(snap, res.url, sha, len(data)))
    m = re.search(r"RESULT\|(\d+)\|(\d+)", out)
    loaded, removed = (m[1], m[2]) if m else ("?", "?")
    log(f"{res.file_name}: {loaded} rows loaded, {removed} previous rows replaced ({time.time() - t0:.0f}s)")
    return len(snap.rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--all", action="store_true", help="resolve every ДПС licence dataset via CKAN")
    src.add_argument("--dataset", action="append", help="CKAN dataset id or slug (repeatable)")
    src.add_argument("--file", help="load a local CSV instead of downloading")
    ap.add_argument("--register", help="--file: register code (default: from the file name)")
    ap.add_argument("--licence-type", help="--file: licence type when the file has no VDNM column")
    ap.add_argument("--snapshot-date", help="--file: snapshot date YYYY-MM-DD (default: from the file name)")
    ap.add_argument("--source-url", help="--file: URL the file was downloaded from")
    ap.add_argument("--resource-id", help="--file: CKAN resource id (default file:<name>)")
    ap.add_argument("--list-only", action="store_true", help="print the resolved resources and exit")
    ap.add_argument("--dry-run", action="store_true", help="download and parse only")
    ap.add_argument("--force", action="store_true", help="reload a file already journalled")
    a = ap.parse_args(argv)

    if a.file:
        fname = os.path.basename(a.file)
        res = Resource(resource_id=a.resource_id or f"file:{fname}", url=a.source_url or f"file:{fname}",
                       file_name=fname, register_code=a.register or register_code_for(fname),
                       licence_type=a.licence_type,
                       snapshot_date=a.snapshot_date or date_from_file_name(fname))
        with open(a.file, "rb") as f:
            data = f.read()
        try:
            run_resource(res, data, a.dry_run, a.force)
        except Exception as e:  # noqa: BLE001
            log(f"ERROR {fname}: {e}")
            return 1
        return 0

    try:
        pkgs = resolve_datasets(None if a.all else a.dataset)
    except Exception as e:  # noqa: BLE001 - data.gov.ua down or blocking: nothing changes
        log(f"ERROR resolving datasets via CKAN: {e}")
        return 1
    resources = [r for p in pkgs for r in resources_of(p)]
    log(f"{len(pkgs)} licence datasets, {len(resources)} data files")
    for p in pkgs:
        files = [r.file_name for r in resources_of(p)]
        log(f"  {p['id']}  {p.get('name')}  «{p.get('title')}»  "
            f"freq={p.get('update_frequency') or p.get('frequency') or '?'}  "
            f"licence={p.get('license_id') or p.get('license_title')}  files={files}")
    if not resources:
        log("no licence resources resolved")
        return 1
    if a.list_only:
        return 0

    failed = []
    for res in resources:
        try:
            run_resource(res, None, a.dry_run, a.force)
        except Exception as e:  # noqa: BLE001 - one broken file must not block the others
            log(f"ERROR {res.file_name}: {e}")
            failed.append(res.file_name)
    if failed:
        log(f"failed: {', '.join(failed)}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
