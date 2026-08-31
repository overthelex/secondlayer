#!/usr/bin/env python3
"""
Download ЄДРСР full texts (RTF) on PROD using the secondary-IP egress pool.
Each source IP is a prod ENI secondary private IP with its own EIP, so N IPs ×
THREADS_PER_IP gives N× the per-IP concurrency against od.reyestr.court.gov.ua.

Downloads only docs that have metadata (doc_url) but no row in edrsr_fulltext.
Resumable: RTFs already on disk and doc_ids already in the DB are skipped.

Usage:
    python3 download-fulltext-prod.py --from 2026-06-01 --to 2026-08-01
    python3 download-fulltext-prod.py --from 2026-06-01 --to 2026-08-01 --skip-download
    python3 download-fulltext-prod.py --from 2026-06-01 --to 2026-08-01 --threads 3
"""

import argparse
import asyncio
import html
import aiofiles
import csv
import io
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from collections import defaultdict
from multiprocessing import Pool

# ── Config ──
# Egress pool: prod ENI secondary private IPs, each needing its own EIP for a
# distinct outbound address. This list used to be hardcoded from the 2026-07-15
# run; by 2026-08-13 thirteen of those EIPs had been released, so every address
# in it was dead while the file still claimed they were "verified". The pool is
# now discovered at run time and probed before use — a stale list must not be
# able to look like a working one again.
#
# The primary IP (172.31.29.20 → 18.192.189.254) stays out of the pool by
# default: it carries prod's own traffic (TURN/STUN, outbound API, on-demand
# load_full_texts) and must not risk a reyestr-side throttle. --allow-primary
# overrides that when it is the only address available.
PRIMARY_IP = "172.31.29.20"
EGRESS_IFACE = "ens5"
PROBE_URL = "https://od.reyestr.court.gov.ua/"
THREADS_PER_IP = 5
# Share of overload responses above which a run is doing more harm than good.
THROTTLE_ABORT_RATIO = 0.10


def discover_source_ips(explicit=None, allow_primary=False, iface=EGRESS_IFACE):
    """Return the IPv4 addresses on `iface` that can actually reach reyestr.

    Every candidate is probed; the ones that fail are reported, never dropped in
    silence. An IP configured on the interface without an EIP behind it has no
    route out, so a probe is the only honest test of the pool's real size.
    """
    if explicit:
        candidates = [ip.strip() for ip in explicit.split(',') if ip.strip()]
    else:
        out = subprocess.run(
            ['ip', '-4', '-o', 'addr', 'show', 'dev', iface],
            capture_output=True, text=True,
        ).stdout
        candidates = re.findall(r'inet (\d+\.\d+\.\d+\.\d+)/', out)
        if not allow_primary:
            candidates = [ip for ip in candidates if ip != PRIMARY_IP]

    live, dead = [], []
    for ip in candidates:
        probe = subprocess.run(
            ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
             '--interface', ip, '--max-time', '15', PROBE_URL],
            capture_output=True, text=True,
        )
        (live if probe.stdout.strip().startswith('2') else dead).append(ip)

    if dead:
        print(f"  ! unusable egress IPs (no EIP / no route): {', '.join(dead)}", flush=True)
    return live, dead

RTF_DIR = Path("/home/ubuntu/edrsr-rtf")  # overridden by --rtf-dir
CONTAINER = "secondlayer-postgres-prod"
PGUSER = "secondlayer"
PGDB = "secondlayer_prod"


# ── RTF → plaintext ──
def decode_win1251_byte(match):
    byte_val = int(match.group(1), 16)
    if byte_val > 127:
        try:
            return bytes([byte_val]).decode('windows-1251')
        except Exception:
            return chr(byte_val)
    return chr(byte_val)


def decode_unicode(match):
    code = int(match.group(1))
    return chr(code) if 0 <= code <= 0x10FFFF else ''


def remove_nested_group(text, keyword):
    idx = text.find('{\\' + keyword)
    while idx != -1:
        depth = 0
        end = idx
        for i in range(idx, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        text = text[:idx] + text[end:]
        idx = text.find('{\\' + keyword)
    return text


def rtf_to_text(raw: bytes) -> str | None:
    text = raw.decode('latin1')
    for kw in ['fonttbl', 'colortbl', 'stylesheet', 'info', '*\\']:
        text = remove_nested_group(text, kw)
    text = re.sub(r'\\rtf1[^\\{]*', '', text)
    text = re.sub(r'\\par\b', '\n', text)
    text = re.sub(r'\\line\b', '\n', text)
    text = re.sub(r'\\tab\b', '\t', text)
    text = re.sub(r"\\'([0-9a-fA-F]{2})", decode_win1251_byte, text)
    text = re.sub(r'\\u(\d+)\??', decode_unicode, text)
    text = re.sub(r'\\[a-zA-Z]+-?\d*\s?', '', text)
    text = text.replace('{', '').replace('}', '')
    text = text.replace('\x00', '')
    text = text.replace('\r\n', '\n')
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()
    return text if text else None



def _html_charset(raw: bytes) -> str:
    """Charset declared by the document, defaulting to the registry's own encoding."""
    m = re.search(rb'charset\s*=\s*["\']?([A-Za-z0-9_-]+)', raw[:4096])
    if not m:
        return 'windows-1251'
    enc = m.group(1).decode('ascii', errors='ignore').lower()
    return 'utf-8' if enc in ('utf8', 'utf-8') else enc


def html_to_text(raw: bytes) -> str | None:
    """Decode registry HTML with its real encoding and strip it down to the decision.

    The registry serves a large share of documents as windows-1251 HTML. They used to
    fall through to the RTF branch, which decodes latin1 — that is how ~427K documents
    of 2016-2018 came to hold `<HTML>… Íàéìåíóâàííÿ ñóäó` and not one Cyrillic
    character, unfindable by any Ukrainian query.
    """
    try:
        text = raw.decode(_html_charset(raw), errors='replace')
    except LookupError:
        text = raw.decode('windows-1251', errors='replace')

    text = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', text)
    text = re.sub(r'(?s)<!--.*?-->', ' ', text)
    # Block-level ends become newlines so paragraphs survive as paragraphs.
    text = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>|</h[1-6]>', '\n', text)
    text = re.sub(r'(?s)<[^>]+>', ' ', text)
    text = html.unescape(text)
    text = text.replace('\xa0', ' ').replace('\x00', '')
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()
    return text or None


def file_to_text(filepath: Path) -> str | None:
    """Pick the parser by what the bytes ARE, not by what the URL was called.

    The old sniff keyed on an exact prefix, so anything that did not start exactly with
    an HTML doctype went to the RTF parser regardless of content — the defect behind the
    2016-2018 mojibake population, and still live: a 2026 refetch had 41 documents
    rejected as undecoded HTML.
    """
    try:
        raw = filepath.read_bytes()
    except (IOError, OSError):
        return None
    if not raw:
        return None

    head = raw[:2048].lstrip()
    if head[:5] == b'{\\rtf':
        return rtf_to_text(raw)
    lowered = head.lower()
    if any(marker in lowered for marker in (b'<html', b'<!doctype html', b'<?xml', b'<head', b'<body', b'<meta')):
        return html_to_text(raw)
    # Unknown shape: the RTF branch is the historical default and copes with plain text.
    return rtf_to_text(raw)


# ── DB helpers ──
def psql(sql: str, tuples=False) -> str:
    cmd = ["docker", "exec", CONTAINER, "psql", "-U", PGUSER, "-d", PGDB, "-Atc", sql]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql error: {r.stderr}")
    if tuples:
        return [line for line in r.stdout.strip().split('\n') if line]
    return r.stdout.strip()


def psql_copy_rows(rows, date_from: str, date_to: str, replace: bool = False):
    """COPY (doc_id, full_text) into a staging table, then insert with every column
    the readers depend on.

    edrsr_fulltext is LIST-partitioned on adj_year and its GIN index is on tsv, so a
    bare COPY of (doc_id, full_text) fails outright ("no partition ... adj_year = null")
    and, were the row to land, would be invisible to FTS. adj_year/justice_kind come
    from edrsr_documents; the date predicate on the join lets PG prune to the relevant
    document partitions instead of probing all of them by doc_id.

    Uses COPY text format with explicit escaping rather than CSV: decision texts are
    multi-line, and quoted CSV fields spanning newlines are misread as unquoted
    newlines when the COPY block is fed inline through a psql script.
    """
    lines = []
    for doc_id, text in rows:
        esc = (text.replace('\\', '\\\\')
                   .replace('\t', '\\t')
                   .replace('\n', '\\n')
                   .replace('\r', ''))
        lines.append(f"{doc_id}\t{esc}")
    if not lines:
        return False
    copy_block = '\n'.join(lines)

    if replace:
        # Refetch mode: the row already exists and holds a damaged text, so the insert
        # would be a no-op under ON CONFLICT DO NOTHING. adj_year is left alone — the
        # document's date has not changed, only its text — which also keeps the row in
        # its current partition.
        y_from, y_to = int(date_from[:4]), int(date_to[:4])
        write_stmt = f"""UPDATE edrsr_fulltext f
   SET full_text = s.full_text,
       text_length = length(s.full_text),
       tsv = to_tsvector('simple', s.full_text)
  FROM _ft_stage s
 WHERE f.doc_id = s.doc_id
   AND f.adj_year BETWEEN {y_from} AND {y_to};"""
    else:
        write_stmt = f"""INSERT INTO edrsr_fulltext (doc_id, full_text, text_length, tsv, adj_year, justice_kind)
SELECT s.doc_id,
       s.full_text,
       length(s.full_text),
       to_tsvector('simple', s.full_text),
       extract(year FROM d.adjudication_date)::smallint,
       d.justice_kind
FROM _ft_stage s
JOIN edrsr_documents d
  ON d.doc_id = s.doc_id
 AND d.adjudication_date >= '{date_from}'
 AND d.adjudication_date < '{date_to}'
ON CONFLICT DO NOTHING;"""

    sql = f"""
CREATE TEMP TABLE _ft_stage (doc_id bigint, full_text text);
COPY _ft_stage (doc_id, full_text) FROM STDIN;
{copy_block}
\\.
{write_stmt}
DROP TABLE _ft_stage;
"""
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER,
           "-d", PGDB, "-v", "ON_ERROR_STOP=1", "-q"]
    r = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  COPY error: {r.stderr[:300]}", file=sys.stderr, flush=True)
        return False
    return True


# ── Download stats ──
# ── Overload-page detection at download time ──
# The registry answers HTTP 200 with an "overloaded, try later" page instead of the
# decision. Caught only at import, those bytes are already on disk and the run reports
# them as downloaded; caught here, the request is simply retried with backoff, which is
# what a 429 would have got. The page is cp1251 HTML, which is exactly why it ends up as
# mojibake when the RTF path decodes it as latin1.
OVERLOAD_PHRASES = ('Сервер перевантажений', 'Перегляд сторінки недоступний')


def is_overload_payload(data: bytes) -> bool:
    if len(data) > 32768:          # the notice is ~2KB; real decisions are far bigger
        return False
    if data[:5] == b'{\\rtf1':     # a real RTF is never the notice
        return False
    head = data[:8192].decode('cp1251', errors='ignore')
    return any(p in head for p in OVERLOAD_PHRASES)


class DownloadStats:
    def __init__(self, total: int):
        self.total = total
        self.downloaded = 0
        self.failed = 0
        self.skipped = 0
        self.throttled = 0
        self.start = time.time()
        self.lock = asyncio.Lock()
        self.per_ip = defaultdict(int)

    async def inc(self, field: str, ip: str = None):
        async with self.lock:
            setattr(self, field, getattr(self, field) + 1)
            if ip and field == 'downloaded':
                self.per_ip[ip] += 1

    def report(self) -> str:
        elapsed = time.time() - self.start
        done = self.downloaded + self.failed + self.skipped
        rate = self.downloaded / elapsed if elapsed > 0 else 0
        remaining = self.total - done
        eta = remaining / rate if rate > 0 else 0
        ip_stats = " | ".join(f"{ip.split('.')[-1]}={cnt}" for ip, cnt in sorted(self.per_ip.items()))
        return (
            f"[{done}/{self.total}] "
            f"ok={self.downloaded} fail={self.failed} skip={self.skipped} "
            f"throttled={self.throttled} | "
            f"{rate:.0f}/s | ETA {eta/60:.0f}m | IPs: {ip_stats}"
        )


async def download_one(session, doc_id, url, stats, semaphore, source_ip):
    import aiohttp

    outpath = RTF_DIR / f"{doc_id}.rtf"
    if outpath.exists() and outpath.stat().st_size > 0:
        await stats.inc('skipped')
        return

    async with semaphore:
        for attempt in range(3):
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status == 200:
                        data = await resp.read()
                        if data and is_overload_payload(data):
                            # Same handling as an explicit 429 — the server IS throttling,
                            # it just says so with a 200 and a page.
                            await stats.inc('throttled')
                            await asyncio.sleep(5 * (attempt + 1))
                            continue
                        if data:
                            async with aiofiles.open(outpath, 'wb') as f:
                                await f.write(data)
                            await stats.inc('downloaded', source_ip)
                            return
                    elif resp.status == 429:
                        await asyncio.sleep(5 * (attempt + 1))
                        continue
                    elif resp.status >= 500:
                        await asyncio.sleep(2 * (attempt + 1))
                        continue
            except Exception:
                pass
            await asyncio.sleep(2 * (attempt + 1))

        await stats.inc('failed')


BATCH_SIZE = 50000  # Process in batches to avoid OOM on 8M+ items


async def download_batch(batch_items, stats, threads_per_ip, source_ips):
    """Download one batch of items across all IPs."""
    import aiohttp

    ip_items = defaultdict(list)
    for i, item in enumerate(batch_items):
        ip = source_ips[i % len(source_ips)]
        ip_items[ip].append(item)

    async def ip_worker(source_ip, ip_docs):
        semaphore = asyncio.Semaphore(threads_per_ip)
        connector = aiohttp.TCPConnector(
            limit=threads_per_ip,
            limit_per_host=threads_per_ip,
            local_addr=(source_ip, 0),
        )
        async with aiohttp.ClientSession(connector=connector) as session:
            tasks = [
                download_one(session, doc_id, url, stats, semaphore, source_ip)
                for doc_id, url in ip_docs
            ]
            await asyncio.gather(*tasks)

    await asyncio.gather(*[ip_worker(ip, docs) for ip, docs in ip_items.items()])


async def download_all(items, threads_per_ip, source_ips):
    stats = DownloadStats(len(items))
    total_batches = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE

    print(f"  Total: {len(items)}, batch size: {BATCH_SIZE}, batches: {total_batches}", flush=True)

    async def progress():
        while True:
            await asyncio.sleep(15)
            print(f"  {stats.report()}", flush=True)
            # The rate is the knob that decides whether the registry serves decisions or
            # overload pages: the 2026-04-19 run at ~1200 docs/s poisoned 36% of April,
            # 100 docs/s gave 0.03%. Rather than let a fast pool burn a whole range,
            # say so early — the operator lowers --threads and re-runs, and nothing is
            # lost because the harvest is resumable.
            attempted = stats.downloaded + stats.throttled
            if attempted >= 500 and stats.throttled / attempted > THROTTLE_ABORT_RATIO:
                print(
                    f"\n  ABORTING: {stats.throttled} of {attempted} responses were the registry's "
                    f"overload page (>{THROTTLE_ABORT_RATIO:.0%}). The pool is fetching faster than "
                    f"the registry will serve. Lower --threads and re-run; already-downloaded files "
                    f"are kept and skipped.",
                    flush=True,
                )
                raise SystemExit(2)

    prog_task = asyncio.create_task(progress())

    for batch_idx in range(total_batches):
        start = batch_idx * BATCH_SIZE
        batch = items[start:start + BATCH_SIZE]
        print(f"\n  --- Batch {batch_idx + 1}/{total_batches} ({len(batch)} items) ---", flush=True)
        await download_batch(batch, stats, threads_per_ip, source_ips)

    prog_task.cancel()
    print(f"\n  Download complete: {stats.report()}", flush=True)
    return stats


# Registry file layout changed: the old flat form (od.reyestr.court.gov.ua/files/<hash>.rtf)
# is gone and answers 404, only the sharded form (/files/NN/<hash>.rtf) resolves. Measured
# 2026-08-14 on samples from 2019, 2020, 2022 and 2023 — all flat URLs dead, all sharded
# ones 200; guessing a shard directory for a flat hash does not find the file either.
# Without this filter a refetch of 2019 queues 191,946 documents and fails every one of
# them: the URL is stored, it just no longer points anywhere.
LIVE_URL_SHAPE = '/files/[0-9]+/'

# ── Selecting rows whose stored text is damaged ──
# The detector is content-based, but a LIKE over full_text means detoasting the whole
# partition (~90GB/year). The same populations are reachable through the GIN index on
# tsv, because both damage classes tokenise into stable mojibake lexemes. Verified
# against the content census: 513,696 on 2026 for the overload page (identical to the
# LIKE count) and 189,539 on 2016 for the latin1 HTML, in ~20s each instead of hours.
OVERLOAD_TSQUERY = 'рґрёрѕрёр & рґрµсђр & сѓсѓрґрѕрірёс'   # "Єдиний державний …судових" as stored
LATIN1_TSQUERY = 'ñóäó'                                   # "суду" read as latin1

DAMAGED_PREDICATE = (
    f"(f.tsv @@ to_tsquery('simple', '{OVERLOAD_TSQUERY}')"
    f" OR f.tsv @@ to_tsquery('simple', '{LATIN1_TSQUERY}'))"
)

# ── Content gate ──
# The registry answers HTTP 200 with an overload notice under load, and the downloader
# counts any 200 as success. The 2026-04-19 run at ~1200 docs/s stored that page as the
# decision text for 36% of April 2026; the 2026-08-13 runs at ~100 docs/s, 0.03%. Left
# ungated, a faster pool multiplies the damage and still reports a clean finish.
#
# Signatures below are anchored on CONTENT, not length: 2,091 chars looked like a
# reliable marker, but 608 rows of exactly that length on the 2026 partition are real
# decisions, and 2,670 overload pages have other lengths.
OVERLOAD_MOJIBAKE = 'Р„РґРёРЅРёР№ РґРµСЂР¶Р°РІРЅРёР№'
OVERLOAD_DECODED = ('Сервер перевантажений запитами', 'Перегляд сторінки недоступний')
# Anchored at the start: a stored HTML export always opens with the tag, while a real
# decision can quote markup in its body (an IT dispute over a copied page does exactly
# that), and a "appears near the top" rule discards it as damaged.
HTML_OPENING_RE = re.compile(r'^\s*<(!doctype\s+html|html\b|\?xml\b)', re.I)
CYRILLIC_RE = re.compile('[\u0400-\u04FF]')
# Deliberately NO minimum-length rule. The corpus holds faithful stubs — lawful
# "Інформація заборонена для оприлюднення" notices, one-line procedural entries, even
# date-only texts — and the 2026-08-13 audit fetched five of them and found the SOURCE
# files themselves are 314-675 bytes. Rejecting those would delete the RTF, refetch it
# on the next run, reject it again, and never let the document reach the corpus.


def damage_kind(text: str) -> str | None:
    """Return why this text must not be stored as a decision, or None if it is fine."""
    if not text:
        return 'empty'
    if OVERLOAD_MOJIBAKE in text or any(m in text for m in OVERLOAD_DECODED):
        return 'registry_overload_page'
    if HTML_OPENING_RE.match(text):
        return 'undecoded_html'
    if len(text) >= 400 and not CYRILLIC_RE.search(text):
        return 'no_cyrillic'
    return None


def _convert_one(doc_id):
    """Pool worker: RTF file → (doc_id, text), or None if it yielded nothing.

    Reads RTF_DIR as a module global — set in main() before the Pool is created, so
    fork start method carries it into the children.
    """
    text = file_to_text(RTF_DIR / f"{doc_id}.rtf")
    if not text:
        return None
    kind = damage_kind(text)
    if kind:
        # Reject, and drop the file so the next run refetches it instead of replaying
        # the same bad bytes from disk. Resumability is what makes this safe: nothing
        # is lost, the document simply stays unharvested until a healthy fetch.
        try:
            (RTF_DIR / f"{doc_id}.rtf").unlink()
        except OSError:
            pass
        return ('rejected', doc_id, kind)
    return (doc_id, text)


# ── Import to DB ──
def import_to_db(date_from, date_to, batch_size=2000, workers=None, replace=False):
    print("[3/4] Importing RTFs to edrsr_fulltext...", flush=True)

    downloaded = set()
    for f in RTF_DIR.iterdir():
        if f.suffix == '.rtf' and f.stat().st_size > 0:
            try:
                downloaded.add(int(f.stem))
            except ValueError:
                pass
    print(f"  RTF files on disk: {len(downloaded)}", flush=True)

    min_doc = min(downloaded) if downloaded else 0
    existing_raw = psql(
        f"SELECT doc_id FROM edrsr_fulltext WHERE doc_id >= {min_doc};",
        tuples=True
    )
    existing = {int(x) for x in existing_raw}
    print(f"  Already in DB: {len(existing)}" + (" (these are the rows being replaced)" if replace else ""), flush=True)

    # In refetch mode the existing rows ARE the targets: they hold the damaged text we
    # came to replace, so subtracting them would leave nothing to do.
    to_import = sorted(downloaded if replace else downloaded - existing)
    print(f"  To import: {len(to_import)}", flush=True)

    if not to_import:
        return

    total_imported = 0
    rejected: dict[str, int] = {}
    total_batches = (len(to_import) + batch_size - 1) // batch_size
    start = time.time()

    # RTF→text is pure CPU and by far the slower half of the import (measured at
    # 77 docs/s serial, with the parser pegging one core and the box's other 7 idle),
    # so fan it out. The COPY stays serial — one writer keeps the GIN index churn on
    # edrsr_fulltext predictable while prod is serving live traffic.
    with Pool(processes=workers) as pool:
        for batch_idx in range(total_batches):
            batch_start = batch_idx * batch_size
            batch_ids = to_import[batch_start: batch_start + batch_size]

            converted = [r for r in pool.map(_convert_one, batch_ids, chunksize=32) if r]
            rows = [r for r in converted if r[0] != 'rejected']
            for r in converted:
                if r[0] == 'rejected':
                    rejected[r[2]] = rejected.get(r[2], 0) + 1

            if rows:
                if psql_copy_rows(rows, date_from, date_to, replace=replace):
                    total_imported += len(rows)

            if (batch_idx + 1) % 10 == 0 or batch_idx == total_batches - 1:
                elapsed = time.time() - start
                rate = total_imported / elapsed if elapsed > 0 else 0
                eta = (len(to_import) - total_imported) / rate if rate > 0 else 0
                print(f"  Batch {batch_idx + 1}/{total_batches}: {total_imported} imported, "
                      f"{rate:.0f}/s | ETA {eta/60:.0f}m", flush=True)

    print(f"  Import complete: {total_imported} records", flush=True)
    if rejected:
        detail = ', '.join(f"{k}={v}" for k, v in sorted(rejected.items()))
        total_rejected = sum(rejected.values())
        print(f"  Rejected by content gate: {total_rejected} ({detail})", flush=True)
        print("  Their RTFs were deleted; re-run the same range to fetch them again.", flush=True)


def verify(date_from, date_to):
    print("\n[4/4] Verification...", flush=True)
    r = psql("""
        SELECT count(*) AS total,
               pg_size_pretty(pg_total_relation_size('edrsr_fulltext')) AS size
        FROM edrsr_fulltext;
    """)
    print(f"  edrsr_fulltext: {r}", flush=True)

    lines = psql(f"""
        SELECT to_char(d.adjudication_date, 'YYYY-MM') AS month,
               count(d.doc_id) AS total_docs,
               count(ft.doc_id) AS with_fulltext,
               round(100.0 * count(ft.doc_id) / NULLIF(count(d.doc_id),0), 1) AS pct
        FROM edrsr_documents d
        LEFT JOIN edrsr_fulltext ft ON d.doc_id = ft.doc_id
        WHERE d.adjudication_date >= '{date_from}'
          AND d.adjudication_date < '{date_to}'
        GROUP BY 1 ORDER BY 1;
    """, tuples=True)
    print("  month | total_docs | with_fulltext | %", flush=True)
    for line in lines:
        print(f"  {line}", flush=True)


def main():
    global RTF_DIR

    parser = argparse.ArgumentParser(description="ЄДРСР fulltext — PROD multi-IP downloader")
    parser.add_argument('--from', dest='date_from', required=True,
                        help='adjudication_date >= this (YYYY-MM-DD)')
    parser.add_argument('--to', dest='date_to', required=True,
                        help='adjudication_date < this (YYYY-MM-DD, exclusive)')
    parser.add_argument('--rtf-dir', default=None,
                        help='RTF scratch dir (default /home/ubuntu/edrsr-rtf-<from>_<to>)')
    parser.add_argument('--skip-download', action='store_true', help='Skip RTF download, only import to DB')
    parser.add_argument('--threads', type=int, default=THREADS_PER_IP, help='Threads per IP (default 5)')
    parser.add_argument('--batch', type=int, default=2000, help='DB import batch size')
    parser.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1),
                        help='CPU workers for RTF→text parsing (default: cores-1)')
    parser.add_argument('--ips', default=None,
                        help='Comma-separated egress IPs to use instead of discovering them')
    parser.add_argument('--refetch-damaged', action='store_true',
                        help='Re-fetch documents whose STORED text is damaged (registry overload page '
                             'or latin1-mangled HTML) and replace it, instead of fetching documents '
                             'that have no text at all')
    parser.add_argument('--allow-primary', action='store_true',
                        help=f"Permit the primary IP ({PRIMARY_IP}) in the pool — it carries prod's own traffic")
    args = parser.parse_args()

    for d in (args.date_from, args.date_to):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', d):
            parser.error(f"date must be YYYY-MM-DD, got: {d}")
    if args.date_from >= args.date_to:
        parser.error(f"--from ({args.date_from}) must be before --to ({args.date_to})")

    RTF_DIR = Path(args.rtf_dir) if args.rtf_dir else \
        Path(f"/home/ubuntu/edrsr-rtf-{args.date_from}_{args.date_to}")

    threads_per_ip = args.threads

    source_ips = []
    if not args.skip_download:
        print("[0/4] Probing egress pool...", flush=True)
        source_ips, _dead = discover_source_ips(args.ips, args.allow_primary)
        if not source_ips:
            print(
                "ERROR: no usable egress IP. Secondary private IPs need an EIP each "
                "(aws ec2 allocate-address + associate-address, then `ip addr add <priv>/20 dev ens5`). "
                "Re-run with --allow-primary to use the prod primary IP instead.",
                file=sys.stderr, flush=True,
            )
            return 1
    total_workers = len(source_ips) * threads_per_ip

    RTF_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60, flush=True)
    print(f"  ЄДРСР Fulltext — PROD multi-IP download", flush=True)
    print(f"  Range: {args.date_from} .. {args.date_to} (adjudication_date)", flush=True)
    print(f"  Mode: {'REFETCH damaged texts (replaces rows)' if args.refetch_damaged else 'fetch missing texts'}", flush=True)
    print(f"  IPs: {len(source_ips)} × {threads_per_ip} threads = {total_workers} workers", flush=True)
    print(f"  Egress: {', '.join(source_ips) or 'n/a (import only)'}", flush=True)
    print(f"  RTF parse workers: {args.workers}", flush=True)
    print(f"  RTF dir: {RTF_DIR}", flush=True)
    print("=" * 60, flush=True)

    if not args.skip_download:
        print(f"\n[1/4] Querying doc URLs from DB...", flush=True)
        if args.refetch_damaged:
            # adj_year prunes the fulltext side; the date range prunes the documents side.
            y_from, y_to = int(args.date_from[:4]), int(args.date_to[:4])
            raw = psql(f"""
                SELECT d.doc_id || '|' || d.doc_url
                FROM edrsr_fulltext f
                JOIN edrsr_documents d ON d.doc_id = f.doc_id
                WHERE f.adj_year BETWEEN {y_from} AND {y_to}
                  AND d.adjudication_date >= '{args.date_from}'
                  AND d.adjudication_date < '{args.date_to}'
                  AND d.doc_url ~ '{LIVE_URL_SHAPE}'
                  AND {DAMAGED_PREDICATE}
                ORDER BY d.doc_id;
            """, tuples=True)
        else:
            raw = psql(f"""
                SELECT d.doc_id || '|' || d.doc_url
                FROM edrsr_documents d
                LEFT JOIN edrsr_fulltext ft ON d.doc_id = ft.doc_id
                WHERE d.adjudication_date >= '{args.date_from}'
                  AND d.adjudication_date < '{args.date_to}'
                  AND d.doc_url ~ '{LIVE_URL_SHAPE}'
                  AND ft.doc_id IS NULL
                ORDER BY d.doc_id;
            """, tuples=True)

        items = []
        for line in raw:
            parts = line.split('|', 1)
            if len(parts) == 2:
                items.append((int(parts[0]), parts[1]))

        print(f"  Total URLs: {len(items)}", flush=True)
        if args.refetch_damaged:
            y_from, y_to = int(args.date_from[:4]), int(args.date_to[:4])
            skipped = psql(f"""
                SELECT count(*)
                FROM edrsr_fulltext f
                JOIN edrsr_documents d ON d.doc_id = f.doc_id
                WHERE f.adj_year BETWEEN {y_from} AND {y_to}
                  AND d.adjudication_date >= '{args.date_from}'
                  AND d.adjudication_date < '{args.date_to}'
                  AND (d.doc_url IS NULL OR d.doc_url !~ '{LIVE_URL_SHAPE}')
                  AND {DAMAGED_PREDICATE};
            """)
            print(f"  Damaged but unreachable (no URL, or dead flat-format URL): {skipped}", flush=True)

        # Filter already on disk
        before = len(items)
        items = [(doc_id, url) for doc_id, url in items
                 if not (RTF_DIR / f"{doc_id}.rtf").exists()]
        print(f"  Already on disk: {before - len(items)}", flush=True)
        print(f"  To download: {len(items)}", flush=True)

        if items:
            print(f"\n[2/4] Downloading {len(items)} RTFs ({len(source_ips)} IPs × {threads_per_ip} threads)...", flush=True)
            asyncio.run(download_all(items, threads_per_ip, source_ips))
        else:
            print("[2/4] All files already downloaded", flush=True)
    else:
        print("[1-2/4] Skipped download", flush=True)

    import_to_db(args.date_from, args.date_to, args.batch, args.workers, replace=args.refetch_damaged)
    verify(args.date_from, args.date_to)
    print("\n=== Done! ===", flush=True)


if __name__ == '__main__':
    # Exit code matters: this runs unattended from cron, where a silent 0 on
    # "no usable egress IP" would look exactly like a successful harvest.
    sys.exit(main() or 0)
