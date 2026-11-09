#!/usr/bin/env python3
"""Load small Polish open-data files into pl_opendata_rows (migration 251).

  python3 scripts/pl/load_pl_files.py                     # every source
  python3 scripts/pl/load_pl_files.py komornicy kprm_wykaz
  python3 scripts/pl/load_pl_files.py --force             # reload unchanged files

Each source resolves its current file URL at run time (dane.gov.pl datasets
publish a new resource per snapshot; the MSWiA page changes its attachment id
when the list changes), downloads it, and, if its sha256 is not already in
pl_opendata_loads, replaces the source's rows in one transaction.

Files are kept under --raw for provenance.
"""
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

import openpyxl
import requests
import xlrd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "251_pl_opendata_files.sql")
UA = "lawrider.pl open-data loader"
DANE = "https://api.dane.gov.pl/1.4"


def http(url):
    r = requests.get(url, headers={"User-Agent": UA}, timeout=180)
    r.raise_for_status()
    return r


def dane_latest(dataset, title_re=None):
    """(download_url, label) of the newest resource of a dane.gov.pl dataset."""
    d = http(f"{DANE}/datasets/{dataset}/resources?sort=-created&per_page=100").json()
    for r in d["data"]:
        a = r["attributes"]
        if title_re and not re.search(title_re, a.get("title", ""), re.I):
            continue
        url = a.get("download_url") or a.get("file_url")
        if url:
            return url, f"{a.get('created', '')[:10]} {a.get('title', '')}".strip()
    raise RuntimeError(f"dane.gov.pl {dataset}: no resource matching {title_re!r}")


def mswia_sanctions():
    page = http("https://www.gov.pl/web/mswia/lista-osob-i-podmiotow-objetych-sankcjami").text
    m = re.search(r'href="(/attachment/[0-9a-f-]{36})"', page)
    if not m:
        raise RuntimeError("MSWiA sanctions page: no attachment link found")
    return "https://www.gov.pl" + m.group(1), "gov.pl/web/mswia lista sankcyjna"


TERYT = ("https://eteryt.stat.gov.pl/eTeryt/rejestr_teryt/udostepnianie_danych/"
         "baza_teryt/uzytkownicy_indywidualni/pobieranie/pliki_pelne.aspx")


def teryt(button):
    """GUS TERYT full file via the page's own form button (ASP.NET postback).
    Returns (csv bytes, url, label). The ZIP holds the same catalogue as XML
    and as ';'-separated CSV; the CSV is used."""
    def fetch():
        import html as _html
        import zipfile
        s = requests.Session()
        s.headers["User-Agent"] = UA
        page = s.get(TERYT, timeout=120).text
        form = {m.group(1): _html.unescape(m.group(2)) for m in re.finditer(
            r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', page)}
        form.update(__EVENTTARGET=f"ctl00$body${button}", __EVENTARGUMENT="")
        r = s.post(TERYT, data=form, timeout=600)
        r.raise_for_status()
        if r.content[:2] != b"PK":
            raise RuntimeError(f"TERYT {button}: not a zip ({r.headers.get('Content-Type')})")
        z = zipfile.ZipFile(io.BytesIO(r.content))
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return z.read(name), TERYT + "#" + button, name
    return fetch


def patent_attorneys():
    """UPRP register of patent attorneys (rzecznicy.uprp.gov.pl), a paged HTML
    table. Returns (rows, url, label, bytes-for-hash).

    per_page is capped at 100, and a page past the end returns the LAST page
    again rather than an empty one, so the loop stops on a short page or on a
    page identical to the previous one."""
    import html as _html
    base = "https://rzecznicy.uprp.gov.pl/attorneys"
    s = requests.Session()
    s.headers["User-Agent"] = UA
    rows, hdr, raw, page, prev_first = [], None, [], 1, None
    while True:
        t = s.get(base, params={"per_page": 100, "sort": "registration_number",
                                "dir": "asc", "page": page}, timeout=120).text
        trs = re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)
        cells = [[re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
                  for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
                 for tr in trs]
        if hdr is None and cells:
            # header cells carry the sort arrows of the table UI
            hdr = [re.sub(r"[\u2191-\u21ff\u25b2-\u25bc]", "", h).strip() for h in cells[0]]
            cells[0] = hdr
        body = [c for c in cells[1:] if c and c != hdr]
        if not body or (rows and body[0] == prev_first):
            break
        prev_first = body[0]
        for c in body:
            rec = {h: v for h, v in zip(hdr, c) if h and v and v != "\u2014"}
            if rec:
                rows.append(("", len(rows) + 1, rec))
        raw.append(t)
        if len(body) < 100:
            break
        page += 1
        if page > 200:
            raise RuntimeError("patent attorneys: more than 200 pages, stopping")
    blob = json.dumps([r[2] for r in rows], ensure_ascii=False, sort_keys=True).encode()
    return rows, base, f"{len(rows)} entries", blob


SOURCES = {
    "komornicy":      {"resolve": lambda: dane_latest(927), "kind": "xlsx"},
    "sady_teleadres": {"resolve": lambda: dane_latest(985, r"teleadres"), "kind": "xlsx"},
    "sady_lista":     {"resolve": lambda: dane_latest(985, r"^Lista s"), "kind": "xlsx",
                       "header": ["nazwa"]},
    "sady_struktura": {"resolve": lambda: dane_latest(985, r"^Struktura"), "kind": "xls"},
    "sady_wlasciwosc": {"resolve": lambda: dane_latest(985, r"^W.a.ciwo"), "kind": "xls",
                        "sheets": ["Arkusz1"]},
    "kprm_wykaz":     {"resolve": lambda: ("https://www.gov.pl/register-file/Rejestr_20874195.csv",
                                           "gov.pl wykaz prac legislacyjnych RM"),
                       "kind": "csv"},
    "mswia_sankcje":  {"resolve": mswia_sanctions, "kind": "xlsx"},
    "rzecznicy_patentowi": {"fetch_rows": patent_attorneys, "kind": "json"},
    "teryt_terc":     {"fetch": teryt("BTERCUrzedowyPobierz"), "kind": "csv"},
    "teryt_simc":     {"fetch": teryt("BSIMCUrzedowyPobierz"), "kind": "csv"},
    "teryt_ulic":     {"fetch": teryt("BULICUrzedowyPobierz"), "kind": "csv"},
}


def cell(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def rows_xlsx(blob, header=None):
    """-> [(sheet, row_no, dict)]. First non-empty row is the header unless
    header is given (sady_lista has no header row)."""
    wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        hdr = header
        n = 0
        for raw in ws.iter_rows(values_only=True):
            vals = [cell(c) for c in raw]
            if not any(v is not None for v in vals):
                continue
            if hdr is None:
                hdr = [str(v) if v is not None else None for v in vals]
                continue
            rec = {h: v for h, v in zip(hdr, vals) if h and v is not None}
            if rec:
                n += 1
                out.append((ws.title, n, rec))
    return out


def rows_xls(blob, sheets=None):
    """Legacy .xls with one tabular sheet. The header is the first row with at
    least two cells, which skips the one-cell title; the court is only named on
    the first of its rows, so appellate/regional cells are filled downward."""
    wb = xlrd.open_workbook(file_contents=blob)
    out = []
    for ws in wb.sheets():
        if ws.nrows == 0 or (sheets and ws.name not in sheets):
            continue
        hdr, last, n = None, {}, 0
        for i in range(ws.nrows):
            vals = [cell(v) if v != "" else None for v in ws.row_values(i)]
            if not any(v is not None for v in vals):
                continue
            if hdr is None:
                if sum(v is not None for v in vals) >= 2:
                    hdr = [re.sub(r"\s+", " ", str(v)).strip() if v is not None else None
                           for v in vals]
                continue
            rec = {}
            for h, v in zip(hdr, vals):
                if not h or h.lower().startswith("l.p"):
                    continue
                if v is None:
                    v = last.get(h)
                else:
                    last[h] = v
                if v is not None:
                    rec[h] = v
            n += 1
            out.append((ws.title, n, rec))
    return out


def rows_csv(blob):
    text = blob.decode("utf-8-sig")
    rd = csv.DictReader(io.StringIO(text), delimiter=";")
    out = []
    for n, r in enumerate(rd, 1):
        rec = {k.strip(): v.strip() for k, v in r.items() if k and v and v.strip()}
        if rec:
            out.append(("", n, rec))
    return out


def load(name, cfg, raw_dir, force):
    parsed = None
    if "fetch_rows" in cfg:
        parsed, url, label, blob = cfg["fetch_rows"]()
    elif "fetch" in cfg:
        blob, url, label = cfg["fetch"]()
    else:
        url, label = cfg["resolve"]()
        blob = http(url).content
    sha = hashlib.sha256(blob).hexdigest()
    seen = plprod.scalar(
        f"SELECT count(*) FROM pl_opendata_loads WHERE source = '{name}' AND sha256 = '{sha}'")
    if seen != "0" and not force:
        print(f"{name}: unchanged ({sha[:12]}), skipped", flush=True)
        return
    os.makedirs(raw_dir, exist_ok=True)
    ext = cfg["kind"]
    with open(os.path.join(raw_dir, f"{name}-{sha[:12]}.{ext}"), "wb") as f:
        f.write(blob)

    if parsed is not None:
        rows = parsed
    elif ext == "xlsx":
        rows = rows_xlsx(blob, cfg.get("header"))
    elif ext == "xls":
        rows = rows_xls(blob, cfg.get("sheets"))
    else:
        rows = rows_csv(blob)
    if not rows:
        raise RuntimeError(f"{name}: parsed 0 rows from {url}")

    data = "".join(
        "\t".join(plprod.esc(c) for c in
                  (name, sheet, n, json.dumps(rec, ensure_ascii=False), url)) + "\n"
        for sheet, n, rec in rows)
    q = name.replace("'", "''")
    lbl = (label or "").replace("'", "''")
    sql = (
        "BEGIN;\n"
        f"DELETE FROM pl_opendata_rows WHERE source = '{q}';\n"
        "COPY pl_opendata_rows (source, sheet, row_no, data, source_url) "
        "FROM STDIN WITH (FORMAT text);\n")
    tail = (
        "INSERT INTO pl_opendata_loads (source, source_url, published, sha256, rows) "
        f"VALUES ('{q}', '{url}', '{lbl}', '{sha}', {len(rows)}) "
        "ON CONFLICT (source, sha256) DO UPDATE SET loaded_at = now(), rows = EXCLUDED.rows;\n"
        "COMMIT;\n")
    r = subprocess.run(plprod._argv(), input=sql + data + "\\.\n" + tail,
                       capture_output=True, text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"{name}: load failed: {r.stderr.strip()[:600]}")
    sheets = sorted({s for s, _, _ in rows})
    print(f"{name}: {len(rows)} rows {sheets if sheets != [''] else ''} from {label}",
          flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="*", default=list(SOURCES))
    ap.add_argument("--raw", default=os.path.expanduser("~/lawrider/pl-files/raw"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True,
                           text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    failed = 0
    for name in a.sources:
        try:
            load(name, SOURCES[name], a.raw, a.force)
        except Exception as e:  # one broken source must not stop the others
            failed += 1
            print(f"{name}: FAILED {e}", file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
