#!/usr/bin/env python3
"""Backfill the AMCU decision texts that never came out of the legacy .doc files.

The import that filled `opendata_amcu_decisions` extracted every .docx and left
every .doc empty: 4,225 rows with `extracted = false` and no body at all. The
source archives are long gone from disk, so this re-fetches them from the
issuing body's own open-data listing (data.gov.ua, dataset "Рішення та
рекомендації Антимонопольного комітету України") and converts the documents
with LibreOffice.

The archive names in the table carry their provenance: `008a2ce8_rish_gruden_2025.zip`
is CKAN resource `008a2ce8-ff41-...`, so every row can be traced back to the
file it came from without guessing.

Usage (on local.lex, where the database and the disk are):

    ./04_backfill_doc_texts.py refresh            # re-read the CKAN resource list
    ./04_backfill_doc_texts.py run                # everything still missing
    ./04_backfill_doc_texts.py run --limit 3      # a few archives, to look first
    ./04_backfill_doc_texts.py report
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

PACKAGE = "8bdd45b8-0684-463a-ba76-26361c32841a"
CKAN = "https://data.gov.ua/api/3/action/package_show?id=" + PACKAGE
ROOT = Path(os.environ.get("AMCU_ROOT", "/data/amcu"))
ARCHIVES = ROOT / "archives"
WORK = ROOT / "work"
LOG = ROOT / "logs" / "backfill.jsonl"
RESOURCES = ROOT / "resources.json"
PSQL = os.environ.get(
    "AMCU_PSQL",
    "docker exec -i secondlayer-postgres-local psql -U secondlayer -d secondlayer_local",
).split()
# LibreOffice writes one .txt per input basename, so the same basename in two
# subdirectories of one archive would overwrite itself. Everything is staged
# under a number instead, which also sidesteps the filename encodings.
BATCH = 120
MIN_CHARS = 200


def sql(query: str, *, quiet: bool = False) -> list[list[str]]:
    out = subprocess.run(
        PSQL + ["-v", "ON_ERROR_STOP=1", "-At", "-F", "\x1f", "-c", query],
        capture_output=True, text=True,
    )
    if out.returncode:
        if not quiet:
            sys.stderr.write(out.stderr)
        raise SystemExit(f"psql failed: {out.stderr.strip()[:300]}")
    return [line.split("\x1f") for line in out.stdout.splitlines() if line]


def copy_in(table: str, columns: str, rows) -> None:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for row in rows:
        writer.writerow(row)
    out = subprocess.run(
        PSQL + ["-v", "ON_ERROR_STOP=1",
                "-c", rf"\copy {table} ({columns}) from stdin with (format csv)"],
        input=buf.getvalue(), capture_output=True, text=True,
    )
    if out.returncode:
        raise SystemExit(f"copy failed: {out.stderr.strip()[:300]}")


def refresh_resources() -> dict[str, str]:
    with urllib.request.urlopen(CKAN, timeout=180) as fh:
        payload = json.load(fh)
    resources = {r["id"][:8]: r["url"] for r in payload["result"]["resources"]}
    RESOURCES.parent.mkdir(parents=True, exist_ok=True)
    RESOURCES.write_text(json.dumps(resources, ensure_ascii=False, indent=1))
    return resources


def resources() -> dict[str, str]:
    if RESOURCES.exists():
        return json.loads(RESOURCES.read_text())
    return refresh_resources()


def pending() -> list[tuple[str, int]]:
    """Archives that still owe us text, worst first."""
    rows = sql(
        "select archive_file, count(*) from opendata_amcu_decisions "
        "where not extracted and (body_text is null or length(body_text) < 200) "
        "group by 1 order by 2 desc"
    )
    return [(r[0], int(r[1])) for r in rows]


def download(name: str, url: str) -> Path:
    path = ARCHIVES / name
    if path.exists() and path.stat().st_size > 0:
        return path
    ARCHIVES.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=600) as fh, tmp.open("wb") as out:
                shutil.copyfileobj(fh, out)
            tmp.rename(path)
            return path
        except Exception as exc:  # noqa: BLE001 - the portal times out often enough
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
            sys.stderr.write(f"    retrying {name}: {exc}\n")
    return path


def norm(text: str) -> str:
    return unicodedata.normalize("NFC", text).strip().casefold()


NESTED = {".zip", ".7z", ".rar", ".gz"}


def unpack(path: Path, dest: Path) -> None:
    subprocess.run(["7z", "x", "-y", "-bso0", "-bsp0", f"-o{dest}", str(path)],
                   check=True, capture_output=True)


def extract_archive(path: Path, dest: Path) -> list[Path]:
    """Unpack, including the archives nested inside: some 2017 uploads are a zip
    of per-day 7z files, and the table records those as `outer!inner`."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    unpack(path, dest)
    for _ in range(4):
        nested = [f for f in dest.rglob("*")
                  if f.is_file() and f.suffix.lower() in NESTED]
        if not nested:
            break
        for inner in nested:
            try:
                unpack(inner, inner.parent / (inner.name + "_x"))
            except subprocess.CalledProcessError:
                continue
            inner.unlink()
    return [f for f in dest.rglob("*") if f.is_file()]


def build_index(files: list[Path], dest: Path) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = {}
    for file in files:
        parts = [norm(p) for p in file.relative_to(dest).parts]
        for depth in range(1, min(len(parts), 3) + 1):
            index.setdefault("/".join(parts[-depth:]), []).append(file)
    return index


def locate(inner: str, index: dict[str, list[Path]]) -> Path | None:
    """The stored path carries an `!` where an archive was nested, so match on
    the deepest tail that is unambiguous."""
    parts = [norm(p) for p in inner.replace("!", "/").split("/") if p]
    for depth in range(min(len(parts), 3), 0, -1):
        hits = index.get("/".join(parts[-depth:]))
        if hits and len(hits) == 1:
            return hits[0]
    return None


def signature(path: str) -> tuple:
    """Digits survive the encoding damage, decision numbers are unique inside an
    archive, and 649 rows were stored with their names already mangled beyond
    repair ('79-�.doc'), so this is what is left to match them on."""
    parts = [p for p in path.replace("!", "/").split("/") if p]
    tail = "/".join(parts[-2:]) if len(parts) > 1 else parts[-1] if parts else ""
    return tuple(re.findall(r"\d+", tail))


def convert(staged: list[Path], outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(staged), BATCH):
        chunk = [str(p) for p in staged[i:i + BATCH]]
        subprocess.run(
            ["soffice", "--headless", "--norestore",
             "--convert-to", "txt:Text (encoded):UTF8", "--outdir", str(outdir)] + chunk,
            capture_output=True, timeout=1800,
        )


def clean(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    out: list[str] = []
    for line in lines:
        if not line and out and not out[-1]:
            continue
        out.append(line)
    return "\n".join(out).strip()


def do_archive(name: str, url: str) -> dict:
    stats = {"archive": name, "url": url, "at": time.strftime("%FT%T")}
    rows = sql(
        "select id, doc_file from opendata_amcu_decisions "
        f"where archive_file = '{name.replace(chr(39), chr(39) * 2)}' and not extracted "
        "and (body_text is null or length(body_text) < 200)"
    )
    stats["rows"] = len(rows)
    archive = download(name, url)
    stats["bytes"] = archive.stat().st_size
    work = WORK / name.replace("/", "_")
    files = extract_archive(archive, work / "x")
    index = build_index(files, work / "x")
    stats["files_in_archive"] = len(files)
    stage = work / "stage"
    stage.mkdir(parents=True, exist_ok=True)
    inners = [(int(rid), doc_file.split("!", 1)[1] if "!" in doc_file else doc_file)
              for rid, doc_file in rows]
    found: dict[int, Path] = {}
    for rid, inner in inners:
        file = locate(inner, index)
        if file is not None:
            found[rid] = file
    stats["matched_by_name"] = len(found)

    left = [(rid, inner) for rid, inner in inners if rid not in found]
    if left:
        claimed = set(found.values())
        by_sig: dict[tuple, list[Path]] = {}
        for file in files:
            if file not in claimed:
                by_sig.setdefault(signature(str(file.relative_to(work / "x"))), []).append(file)
        ambiguous = 0
        for rid, inner in left:
            sig = signature(inner)
            hits = by_sig.get(sig)
            if not sig or not hits:
                continue
            if len(hits) > 1:
                # Several files carry the same decision number and date: these
                # archives keep a loose copy of a decision next to the per-day
                # archive that also holds it. Take the shallowest copy.
                ambiguous += 1
            found[rid] = min(hits, key=lambda f: (len(f.parts), str(f)))
        stats["ambiguous"] = ambiguous
    stats["matched_by_number"] = len(found) - stats["matched_by_name"]

    pairs: list[tuple[int, Path]] = []
    missing: list[str] = []
    for n, (rid, inner) in enumerate(inners):
        file = found.get(rid)
        if file is None:
            missing.append(inner)
            continue
        target = stage / f"{n:05d}{file.suffix.lower()}"
        shutil.copyfile(file, target)
        pairs.append((rid, target))
    stats["matched"] = len(pairs)
    stats["unmatched"] = len(missing)
    if missing[:3]:
        stats["unmatched_sample"] = missing[:3]

    out = work / "txt"
    convert([p for _, p in pairs], out)
    written: list[tuple[int, str]] = []
    empty = 0
    for rid, staged in pairs:
        txt = out / (staged.stem + ".txt")
        if not txt.exists():
            empty += 1
            continue
        body = clean(txt.read_text(encoding="utf-8", errors="replace"))
        if len(body) < MIN_CHARS:
            empty += 1
            continue
        written.append((rid, body))
    stats["converted"] = len(written)
    stats["empty"] = empty

    if written:
        copy_in("amcu_text_backfill", "id, body_text", written)
        sql("""
            update opendata_amcu_decisions d
               set body_text = b.body_text, extracted = true
              from amcu_text_backfill b
             where b.id = d.id and not d.extracted;
            truncate amcu_text_backfill;
        """)
    shutil.rmtree(work, ignore_errors=True)
    return stats


def singles() -> None:
    """Some rows are not in an archive at all: the portal publishes a few
    decisions as a bare .doc, and `doc_file` then carries the resource id the
    same way an archive name does. The .xlsx rows are the registers of
    decisions rather than decisions, so they are left alone."""
    rows = sql("select id, doc_file from opendata_amcu_decisions "
               "where coalesce(archive_file, '') = '' and not extracted "
               "and doc_file !~* '\\.xlsx$'")
    res = resources()
    print(f"{len(rows)} standalone documents")
    work = WORK / "_singles"
    shutil.rmtree(work, ignore_errors=True)
    (work / "stage").mkdir(parents=True)
    pairs: list[tuple[int, Path]] = []
    for n, (rid, doc_file) in enumerate(rows):
        url = res.get(doc_file[:8])
        if not url:
            continue
        try:
            path = download(doc_file, url)
        except Exception as exc:  # noqa: BLE001
            print(f"  {doc_file}: {exc}")
            continue
        target = work / "stage" / f"{n:05d}{Path(doc_file).suffix.lower()}"
        shutil.copyfile(path, target)
        pairs.append((int(rid), target))
    convert([p for _, p in pairs], work / "txt")
    written = []
    for rid, staged in pairs:
        txt = work / "txt" / (staged.stem + ".txt")
        if not txt.exists():
            continue
        body = clean(txt.read_text(encoding="utf-8", errors="replace"))
        if len(body) >= MIN_CHARS:
            written.append((rid, body))
    if written:
        sql("create table if not exists amcu_text_backfill "
            "(id bigint primary key, body_text text not null)")
        copy_in("amcu_text_backfill", "id, body_text", written)
        sql("""
            update opendata_amcu_decisions d
               set body_text = b.body_text, extracted = true
              from amcu_text_backfill b
             where b.id = d.id and not d.extracted;
            truncate amcu_text_backfill;
        """)
    print(f"filled {len(written)} of {len(pairs)} downloaded")
    shutil.rmtree(work, ignore_errors=True)


def run(limit: int | None, only: list[str]) -> None:
    res = resources()
    todo = pending()
    if only:
        todo = [(a, n) for a, n in todo if a in only]
    if limit:
        todo = todo[:limit]
    LOG.parent.mkdir(parents=True, exist_ok=True)
    # One staging table for the whole run: psql is invoked per statement, so a
    # temporary table would not survive from the COPY to the UPDATE.
    sql("create table if not exists amcu_text_backfill "
        "(id bigint primary key, body_text text not null)")
    print(f"{len(todo)} archives, {sum(n for _, n in todo)} rows to fill")
    for i, (name, count) in enumerate(todo, 1):
        url = res.get(name[:8])
        if not url:
            print(f"[{i}/{len(todo)}] {name}: no CKAN resource, skipped")
            with LOG.open("a") as fh:
                fh.write(json.dumps({"archive": name, "error": "no resource"}) + "\n")
            continue
        try:
            stats = do_archive(name, url)
        except Exception as exc:  # noqa: BLE001 - one bad archive must not stop the run
            stats = {"archive": name, "error": repr(exc)[:300]}
        with LOG.open("a") as fh:
            fh.write(json.dumps(stats, ensure_ascii=False) + "\n")
        print(f"[{i}/{len(todo)}] {name}: want {count}, "
              f"matched {stats.get('matched', 0)}, filled {stats.get('converted', 0)}"
              + (f", ERROR {stats['error']}" if "error" in stats else ""))


def report() -> None:
    for line in sql("""
        select coalesce(nullif(lower(regexp_replace(doc_file, '^.*\\.', '')), ''), '?') as ext,
               count(*), count(*) filter (where extracted) as extracted,
               count(*) filter (where length(body_text) > 500) as with_text
          from opendata_amcu_decisions group by 1 order by 2 desc
    """):
        print(f"{line[0]:>6} total {line[1]:>6} extracted {line[2]:>6} with text {line[3]:>6}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command",
                    choices=["refresh", "run", "singles", "report", "pending"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--archive", action="append", default=[])
    args = ap.parse_args()
    if args.command == "refresh":
        print(len(refresh_resources()), "resources")
    elif args.command == "pending":
        for name, count in pending():
            print(f"{count:>5}  {name}")
    elif args.command == "singles":
        singles()
    elif args.command == "report":
        report()
    else:
        run(args.limit, args.archive)


if __name__ == "__main__":
    main()
