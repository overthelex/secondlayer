#!/usr/bin/env python3
"""
Bulk download all Rada legislation from zakon.rada.gov.ua using multiple source IPs.

3 phases:
  1. index   — crawl index pages, collect all rada_ids
  2. download — fetch /print pages for each rada_id (multi-IP, multi-thread)
  3. import   — parse HTML and import into PostgreSQL

Usage:
    python3 bulk-download-legislation.py --phase=index
    python3 bulk-download-legislation.py --phase=download [--resume]
    python3 bulk-download-legislation.py --phase=import [--db-url=...]
    python3 bulk-download-legislation.py --phase=all

On prod with 5 IPs (5 threads each = 25 workers), download ~290K docs in ~1.5 hours.
"""

import argparse
import gzip
import io
import json
import os
import re
import socket
import ssl
import http.client
import sys
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from html.parser import HTMLParser
from urllib.parse import quote as url_quote

# --- Config ---
BASE_URL = "https://zakon.rada.gov.ua"
HOST = "zakon.rada.gov.ua"
INDEX_PATH = "/laws/main/a"

# Prod Frankfurt (10 IPs)
SOURCE_IPS_PROD = [
    "172.31.29.20",
    "172.31.21.255",
    "172.31.31.40",
    "172.31.22.206",
    "172.31.28.109",
    "172.31.22.152",
    "172.31.21.47",
    "172.31.20.75",
    "172.31.20.51",
    "172.31.27.192",
]
# Paris secondlayer-paris (3 IPs)
SOURCE_IPS_PARIS = [
    "172.31.7.50",
    "172.31.5.228",
    "172.31.9.173",
]
# Default: use all available IPs on current host
SOURCE_IPS = SOURCE_IPS_PROD  # Override with --ips or auto-detect
THREADS_PER_IP = 5
MAX_RETRIES = 5
RETRY_DELAY = 2
TIMEOUT = 30

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "data")
INDEX_FILE = os.path.join(SCRIPT_DIR, "all-rada-ids.json")
PROGRESS_FILE = os.path.join(SCRIPT_DIR, "download-progress-py.json")
ERRORS_FILE = os.path.join(SCRIPT_DIR, "download-errors-py.json")

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(SCRIPT_DIR, "bulk-download.log")),
    ],
)
log = logging.getLogger(__name__)

# --- DNS cache ---
_dns_cache = {}
_dns_lock = Lock()


def resolve_host(host):
    with _dns_lock:
        if host not in _dns_cache:
            _dns_cache[host] = socket.getaddrinfo(host, 443)[0][4][0]
        return _dns_cache[host]


# --- Stats ---
stats = {"downloaded": 0, "skipped": 0, "failed": 0, "requests": 0, "bytes": 0}
stats_lock = Lock()
errors_list = []
errors_lock = Lock()


# --- HTTP with source IP binding ---

def fetch_url(path, source_ip=None):
    """Fetch URL, optionally binding to source_ip. Returns (status, body_bytes)."""
    host_ip = resolve_host(HOST)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if source_ip:
            sock.bind((source_ip, 0))
        sock.settimeout(TIMEOUT)
        sock.connect((host_ip, 443))

        context = ssl.create_default_context()
        ssock = context.wrap_socket(sock, server_hostname=HOST)

        conn = http.client.HTTPSConnection(HOST)
        conn.sock = ssock
        conn.request("GET", path, headers={
            "Host": HOST,
            "User-Agent": "Mozilla/5.0 (compatible; SecondLayer/1.0; +https://legal.org.ua)",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "uk,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        })
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()

        # Decompress if gzipped
        encoding = resp.getheader("Content-Encoding", "")
        if "gzip" in encoding:
            data = gzip.decompress(data)

        return status, data
    except Exception:
        try:
            sock.close()
        except Exception:
            pass
        raise


def fetch_with_retry(path, source_ip=None, label=""):
    """Fetch with retries. Returns (status, body_str) or (None, None)."""
    for attempt in range(MAX_RETRIES):
        try:
            with stats_lock:
                stats["requests"] += 1
            status, raw = fetch_url(path, source_ip)

            if status == 429:
                wait = RETRY_DELAY * (2 ** attempt) + 5
                log.warning(f"Rate limited on {label}, waiting {wait}s")
                time.sleep(wait)
                continue

            if status in (502, 503, 504):
                wait = RETRY_DELAY * (2 ** attempt)
                log.warning(f"Server error {status} on {label}, retry in {wait}s")
                time.sleep(wait)
                continue

            body = raw.decode("utf-8", errors="replace")
            return status, body

        except (ConnectionError, socket.timeout, OSError, TimeoutError) as e:
            wait = RETRY_DELAY * (2 ** attempt)
            if attempt < MAX_RETRIES - 1:
                log.debug(f"Network error on {label}: {e}, retry in {wait}s")
                time.sleep(wait)
            else:
                log.warning(f"FAILED after {MAX_RETRIES} retries: {label}: {e}")
                return None, None

    return None, None


# --- Simple HTML link extractor (no external deps) ---

class LinkExtractor(HTMLParser):
    """Extract href values from <a> tags matching a pattern."""

    def __init__(self, pattern):
        super().__init__()
        self.pattern = re.compile(pattern)
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value and self.pattern.search(value):
                    self.links.append(value)


# --- Phase 1: Crawl Index ---

def crawl_index(source_ips):
    log.info("=== Phase 1: Crawling document index ===")

    # Fetch first page to find total pages
    status, html = fetch_with_retry(f"{INDEX_PATH}/page", label="index page 1")
    if status != 200 or not html:
        log.error(f"Failed to fetch first index page: status={status}")
        return []

    # Find max page number
    page_re = re.compile(r'/laws/main/a/page(\d+)')
    matches = page_re.findall(html)
    max_page = max(int(m) for m in matches) if matches else 1
    log.info(f"Found {max_page} index pages (est. {max_page * 50} documents)")

    # Extract rada_ids from HTML
    def extract_ids(html_str):
        ids = set()
        for m in re.finditer(r'/laws/show/([^/?#"\'<>\s]+)', html_str):
            rada_id = m.group(1)
            # URL decode %XX sequences
            try:
                from urllib.parse import unquote
                rada_id = unquote(rada_id)
            except Exception:
                pass
            if rada_id and len(rada_id) < 200:
                ids.add(rada_id)
        return ids

    all_ids = extract_ids(html)
    log.info(f"  Page 1: {len(all_ids)} ids")

    # Load existing index to merge with
    existing_ids = set()
    if os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                existing_ids = set(json.load(f))
            log.info(f"  Loaded {len(existing_ids)} existing ids from previous index")
            all_ids.update(existing_ids)
        except Exception:
            pass

    # Support --index-from and --index-to for splitting across servers
    start_page = int(os.environ.get("INDEX_FROM", "2"))
    end_page = int(os.environ.get("INDEX_TO", str(max_page)))
    pages = list(range(start_page, end_page + 1))
    log.info(f"  Crawling pages {start_page}-{end_page} ({len(pages)} pages)")
    completed = 1
    page_errors = 0
    consecutive_errors = 0
    completed_lock = Lock()
    BATCH_SIZE = 5  # small batches to avoid rate limiting
    BATCH_DELAY = 3.0  # seconds between batches — rada blocks at faster rates

    def fetch_page(page_num, ip):
        nonlocal completed, page_errors, consecutive_errors
        status, body = fetch_with_retry(
            f"{INDEX_PATH}/page{page_num}", source_ip=ip, label=f"index page {page_num}"
        )
        ids = set()
        if status == 200 and body:
            ids = extract_ids(body)
            with completed_lock:
                consecutive_errors = 0
        else:
            with completed_lock:
                page_errors += 1
                consecutive_errors += 1

        with completed_lock:
            completed += 1
            if completed % 200 == 0:
                log.info(f"  Index progress: {completed}/{max_page} pages, {len(all_ids)} ids, {page_errors} errors")

        return ids

    total_threads = min(len(source_ips), BATCH_SIZE)  # limit concurrency for index
    with ThreadPoolExecutor(max_workers=total_threads) as executor:
        for batch_start in range(0, len(pages), BATCH_SIZE):
            batch = pages[batch_start:batch_start + BATCH_SIZE]
            futures = {}
            for i, page_num in enumerate(batch):
                ip = source_ips[i % len(source_ips)] if source_ips else None
                futures[executor.submit(fetch_page, page_num, ip)] = page_num

            for future in as_completed(futures):
                try:
                    ids = future.result()
                    all_ids.update(ids)
                except Exception as e:
                    log.error(f"Index page error: {e}")

            # Pause between batches
            time.sleep(BATCH_DELAY)

            # If too many consecutive errors, back off more
            if consecutive_errors > 20:
                log.warning(f"  {consecutive_errors} consecutive errors, backing off 10s...")
                time.sleep(10)
                consecutive_errors = 0

            # Checkpoint every 1000 pages
            if (batch_start + BATCH_SIZE) % 1000 == 0:
                with open(INDEX_FILE, "w", encoding="utf-8") as f:
                    json.dump(sorted(all_ids), f, ensure_ascii=False)
                log.info(f"  Checkpoint saved: {len(all_ids)} ids")

    ids_list = sorted(all_ids)
    log.info(f"Index complete: {len(ids_list)} unique rada_ids ({page_errors} page errors)")

    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(ids_list, f, ensure_ascii=False)
    log.info(f"Saved to {INDEX_FILE}")

    return ids_list


# --- Phase 2: Download Documents ---

def safe_filename(rada_id):
    return rada_id.replace("/", "__").replace(":", "_").replace("?", "_").replace("*", "_")


def download_one(rada_id, source_ip, resume=True):
    """Download one document's /print page. Returns True on success."""
    filename = safe_filename(rada_id) + ".html"
    filepath = os.path.join(DATA_DIR, filename)

    # Skip if already downloaded
    if resume and os.path.exists(filepath) and os.path.getsize(filepath) > 100:
        with stats_lock:
            stats["skipped"] += 1
        return True

    # safe="/" — the slash in a registry id is a PATH SEPARATOR to zakon.rada,
    # not data. Percent-encoding it 404s every act whose number contains one:
    # 52 278 acts, 15% of the corpus, the Constitution and every presidential
    # decree among them. This exact line, with safe="", is how that happened.
    encoded = url_quote(rada_id, safe="/")
    path = f"/laws/show/{encoded}/print"
    status, body = fetch_with_retry(path, source_ip=source_ip, label=rada_id)

    if status == 404:
        with stats_lock:
            stats["failed"] += 1
        with errors_lock:
            errors_list.append({"rada_id": rada_id, "error": "404"})
        return False

    if status != 200 or not body:
        with stats_lock:
            stats["failed"] += 1
        with errors_lock:
            errors_list.append({"rada_id": rada_id, "error": f"HTTP {status}"})
        return False

    # Check for meaningful content (not error page)
    if len(body) < 200:
        with stats_lock:
            stats["failed"] += 1
        with errors_lock:
            errors_list.append({"rada_id": rada_id, "error": "too_small"})
        return False

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(body)

    with stats_lock:
        stats["downloaded"] += 1
        stats["bytes"] += len(body)

    return True


def download_all(source_ips, resume=True):
    log.info("=== Phase 2: Downloading documents ===")

    if not os.path.exists(INDEX_FILE):
        log.error(f"Index file not found: {INDEX_FILE}. Run --phase=index first.")
        return

    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        all_ids = json.load(f)
    log.info(f"Loaded {len(all_ids)} rada_ids from index")

    os.makedirs(DATA_DIR, exist_ok=True)

    # Pre-filter already downloaded
    if resume:
        existing = set()
        if os.path.exists(DATA_DIR):
            for fn in os.listdir(DATA_DIR):
                if fn.endswith(".html"):
                    existing.add(fn)
        pending = []
        for rada_id in all_ids:
            fn = safe_filename(rada_id) + ".html"
            if fn in existing:
                stats["skipped"] += 1
            else:
                pending.append(rada_id)
        log.info(f"Already downloaded: {stats['skipped']}, pending: {len(pending)}")
    else:
        pending = all_ids

    if not pending:
        log.info("All documents already downloaded!")
        return

    total = len(pending)
    total_threads = len(source_ips) * THREADS_PER_IP

    log.info(f"Using {len(source_ips)} IPs x {THREADS_PER_IP} threads = {total_threads} workers")
    log.info(f"Downloading {total} documents...")

    # Assign round-robin to IPs
    ip_tasks = {ip: [] for ip in source_ips}
    for i, rada_id in enumerate(pending):
        ip = source_ips[i % len(source_ips)]
        ip_tasks[ip].append(rada_id)

    all_futures = []
    executors = []

    for ip, ip_task_list in ip_tasks.items():
        executor = ThreadPoolExecutor(max_workers=THREADS_PER_IP)
        executors.append(executor)
        for rada_id in ip_task_list:
            future = executor.submit(download_one, rada_id, ip, resume=False)  # already pre-filtered
            all_futures.append(future)

    completed = 0
    start_time = time.time()
    for future in as_completed(all_futures):
        completed += 1
        if completed % 1000 == 0 or completed == total:
            elapsed = time.time() - start_time
            rate = completed / elapsed if elapsed > 0 else 0
            eta = (total - completed) / rate if rate > 0 else 0
            mb = stats["bytes"] / (1024 * 1024)
            log.info(
                f"Progress: {completed}/{total} ({completed*100//total}%) "
                f"| {rate:.1f} docs/s | ETA: {eta/60:.0f}m "
                f"| downloaded: {stats['downloaded']} | failed: {stats['failed']} "
                f"| {mb:.0f} MB | reqs: {stats['requests']}"
            )

    for executor in executors:
        executor.shutdown(wait=True)

    # Save errors
    if errors_list:
        with open(ERRORS_FILE, "w", encoding="utf-8") as f:
            json.dump(errors_list, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    mb = stats["bytes"] / (1024 * 1024)
    log.info(
        f"\nDownload complete in {elapsed/60:.1f} minutes: "
        f"{stats['downloaded']} downloaded, {stats['skipped']} skipped, "
        f"{stats['failed']} failed, {mb:.0f} MB, "
        f"{stats['requests']} requests"
    )


# --- Phase 3: Import to PostgreSQL ---

def import_all(db_url, db_concurrency=20):
    log.info("=== Phase 3: Importing to PostgreSQL ===")

    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        log.error("psycopg2 not installed. Run: pip install psycopg2-binary")
        return

    if not os.path.exists(DATA_DIR):
        log.error(f"Data directory not found: {DATA_DIR}. Run --phase=download first.")
        return

    files = [f for f in os.listdir(DATA_DIR) if f.endswith(".html")]
    log.info(f"Found {len(files)} HTML files to import")
    if not files:
        return

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()

    # Check current count
    cur.execute("SELECT count(*) FROM legislation")
    current = cur.fetchone()[0]
    log.info(f"Current legislation count: {current}")

    imported = 0
    skipped = 0
    error_count = 0
    start_time = time.time()

    for i, filename in enumerate(files):
        law_number = filename.replace(".html", "").replace("__", "/")
        filepath = os.path.join(DATA_DIR, filename)

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                html = f.read()

            if len(html) < 100:
                skipped += 1
                continue

            # Extract title
            title_match = re.search(r'<title>([^<]+)</title>', html, re.IGNORECASE)
            title = title_match.group(1).strip() if title_match else f"Document {law_number}"
            title = title.replace(" | Законодавство України", "").strip()

            # Determine type
            law_type = "regulation"
            if "Кодекс" in title or "кодекс" in law_number:
                law_type = "code"
            elif "Закон" in title:
                law_type = "law"

            # Extract alias (abbreviation)
            law_alias = None
            abbr_match = re.search(r'\(([А-ЯІЇЄҐ]{2,}(?:\s+України)?)\)', title)
            if abbr_match:
                law_alias = abbr_match.group(1)

            full_url = f"{BASE_URL}/laws/show/{url_quote(law_number, safe='/')}"

            # Extract plain text (strip tags)
            text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = re.sub(r'\s+', ' ', text).strip()

            # Extract articles as JSONB array
            article_pattern = re.compile(
                r'Стаття\s+(\d+(?:-\d+)?)\.\s*([^\n<]{0,200})',
                re.IGNORECASE
            )
            matches = list(article_pattern.finditer(html))
            articles_json = []
            for idx, m in enumerate(matches):
                art_num = m.group(1)
                art_title = m.group(2).strip()
                start_pos = m.start()
                end_pos = matches[idx + 1].start() if idx + 1 < len(matches) else len(html)
                chunk = html[start_pos:end_pos]
                chunk_text = re.sub(r'<[^>]+>', ' ', chunk)
                chunk_text = re.sub(r'\s+', ' ', chunk_text).strip()
                articles_json.append({
                    "number": art_num,
                    "title": art_title,
                    "text": chunk_text[:50000],  # limit per article
                })

            article_count = len(articles_json)

            # Upsert using actual schema: law_number (unique), law_alias, law_type, etc.
            cur.execute("""
                INSERT INTO legislation (law_number, law_alias, title, law_type, url, status,
                    full_text_html, full_text_plain, article_count, articles, metadata)
                VALUES (%s, %s, %s, %s, %s, 'active', %s, %s, %s, %s::jsonb, '{}'::jsonb)
                ON CONFLICT (law_number) DO UPDATE SET
                    title = EXCLUDED.title,
                    law_alias = COALESCE(EXCLUDED.law_alias, legislation.law_alias),
                    law_type = EXCLUDED.law_type,
                    url = EXCLUDED.url,
                    full_text_html = EXCLUDED.full_text_html,
                    full_text_plain = EXCLUDED.full_text_plain,
                    article_count = EXCLUDED.article_count,
                    articles = EXCLUDED.articles,
                    updated_at = NOW()
            """, (
                law_number, law_alias, title, law_type, full_url,
                html[:5000000],  # limit HTML size
                text[:5000000],  # limit plain text size
                article_count,
                json.dumps(articles_json, ensure_ascii=False),
            ))

            conn.commit()
            imported += 1

            if imported % 1000 == 0:
                elapsed = time.time() - start_time
                rate = imported / elapsed if elapsed > 0 else 0
                eta = (len(files) - i) / rate / 60 if rate > 0 else 0
                log.info(
                    f"  Import: {imported}/{len(files)} ({imported*100//len(files)}%) "
                    f"| {rate:.1f} docs/s | ETA: {eta:.0f}m | errors: {error_count}"
                )

        except Exception as e:
            conn.rollback()
            error_count += 1
            if error_count <= 20:
                log.error(f"Import error for {law_number}: {e}")

    cur.execute("SELECT count(*) FROM legislation")
    final_count = cur.fetchone()[0]
    conn.close()

    elapsed = time.time() - start_time
    log.info(
        f"\nImport complete in {elapsed/60:.1f}m: {imported} imported, "
        f"{skipped} skipped, {error_count} errors"
    )
    log.info(f"DB total: {final_count} legislation records")


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="Bulk download Rada legislation (multi-IP)")
    parser.add_argument("--phase", choices=["index", "download", "import", "all"], required=True)
    parser.add_argument("--resume", action="store_true", default=True,
                        help="Skip already downloaded files (default: true)")
    parser.add_argument("--no-resume", action="store_true", help="Re-download everything")
    parser.add_argument("--ips", nargs="+", default=SOURCE_IPS, help="Source IPs")
    parser.add_argument("--threads-per-ip", type=int, default=THREADS_PER_IP)
    parser.add_argument("--db-url", default=os.environ.get(
        "DATABASE_URL",
        "postgresql://secondlayer:secondlayer@localhost:5433/secondlayer_rada"
    ))
    parser.add_argument("--db-concurrency", type=int, default=20)
    args = parser.parse_args()

    threads_per_ip = args.threads_per_ip

    resume = not args.no_resume

    log.info("=" * 60)
    log.info("  Rada Legislation Bulk Downloader (Multi-IP)")
    log.info("=" * 60)

    if args.phase in ("index", "all"):
        crawl_index(args.ips)

    if args.phase in ("download", "all"):
        download_all(args.ips, resume=resume)

    if args.phase in ("import", "all"):
        import_all(args.db_url, args.db_concurrency)

    log.info("Done!")


if __name__ == "__main__":
    main()
