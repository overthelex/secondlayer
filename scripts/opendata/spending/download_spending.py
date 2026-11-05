#!/usr/bin/env python3
"""
Download acts, addendums, and peny from spending.gov.ua API.
Uses 5 source IPs with 5 threads each (25 total concurrent workers).
Splits by signDate (1 day), then auto-splits by documentDate ranges
if a response is truncated (API returns max ~1000 docs per response).

Usage:
    python3 download_spending.py                         # all 3 types, from 2016-01-01
    python3 download_spending.py --type acts             # only acts
    python3 download_spending.py --from 2024-01-01       # custom start date
    python3 download_spending.py --to 2026-03-25         # custom end date
    python3 download_spending.py --resume                # skip days already downloaded
"""

import argparse
import json
import os
import sys
import socket
import ssl
import http.client
import time
import logging
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# --- Config ---
API_BASE = "https://api.spending.gov.ua/api/v2/disposers"
API_HOST = "api.spending.gov.ua"
SOURCE_IPS = [
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
THREADS_PER_IP = 5
MAX_RETRIES = 7
RETRY_DELAY = 3
TIMEOUT = 120
OUTPUT_DIR = "/home/ubuntu/SecondLayer/scripts/opendata/spending/data"
DOC_TYPES = ["acts", "addendums", "peny"]
MAX_DOCS_PER_RESPONSE = 950  # API limit is ~1000, use 950 as safe threshold

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("spending_download.log"),
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
stats = {"downloaded": 0, "skipped": 0, "failed": 0, "documents": 0, "truncated": 0, "requests": 0, "split_days": 0}
stats_lock = Lock()
skip_truncated_mode = False
truncated_log_lock = Lock()


def fetch_url(url, source_ip):
    """Fetch URL bound to source IP. Returns (status, bytes)."""
    host_ip = resolve_host(API_HOST)
    path = url.replace(f"https://{API_HOST}", "")

    context = ssl.create_default_context()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((source_ip, 0))
        sock.settimeout(TIMEOUT)
        sock.connect((host_ip, 443))
        ssock = context.wrap_socket(sock, server_hostname=API_HOST)

        conn = http.client.HTTPSConnection(API_HOST)
        conn.sock = ssock
        conn.request("GET", path, headers={
            "Accept": "application/json",
            "User-Agent": "SecondLayer-OpenData/1.0",
        })
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data
    except Exception:
        try:
            sock.close()
        except Exception:
            pass
        raise


def fetch_with_retry(url, source_ip, label=""):
    """Fetch with retries and backoff. Returns parsed JSON or None."""
    for attempt in range(MAX_RETRIES):
        try:
            with stats_lock:
                stats["requests"] += 1
            status, raw = fetch_url(url, source_ip)

            if status == 429:
                wait = RETRY_DELAY * (2 ** attempt) + 5
                log.warning(f"Rate limited on {label} via {source_ip}, waiting {wait}s")
                time.sleep(wait)
                continue

            if status in (502, 503, 504):
                wait = RETRY_DELAY * (2 ** attempt)
                log.warning(f"Server error {status} on {label}, retry in {wait}s")
                time.sleep(wait)
                continue

            if status != 200:
                log.error(f"HTTP {status} for {label} via {source_ip}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY * (2 ** attempt))
                    continue
                return None

            return json.loads(raw)

        except (ConnectionError, socket.timeout, OSError, TimeoutError) as e:
            wait = RETRY_DELAY * (2 ** attempt)
            log.warning(f"Network error on {label} via {source_ip}: {e}, retry in {wait}s")
            time.sleep(wait)
        except json.JSONDecodeError as e:
            log.error(f"Invalid JSON for {label}: {e}")
            return None

    log.error(f"FAILED after {MAX_RETRIES} retries: {label}")
    return None


def split_date_range(start, end):
    """Split a date range in half."""
    days = (end - start).days
    if days <= 0:
        return [(start, end)]
    mid = start + timedelta(days=days // 2)
    return [(start, mid), (mid + timedelta(days=1), end)]


def fetch_docs_recursive(doc_type, sign_date_str, doc_date_from, doc_date_to, source_ip, depth=0):
    """Recursively fetch documents, splitting by documentDate if count exceeds limit."""
    from_str = doc_date_from.strftime("%Y-%m-%d")
    to_str = doc_date_to.strftime("%Y-%m-%d")
    label = f"{doc_type}/{sign_date_str}/docDate={from_str}..{to_str}"

    url = (f"{API_BASE}/{doc_type}"
           f"?signDateFrom={sign_date_str}&signDateTo={sign_date_str}"
           f"&documentDateFrom={from_str}&documentDateTo={to_str}")

    data = fetch_with_retry(url, source_ip, label)
    if data is None:
        return None

    size = data.get("size", 0)
    count = data.get("count", 0)
    more = data.get("moreThenCount", False)

    # If count > threshold and we can still split, recurse
    if (count > MAX_DOCS_PER_RESPONSE or more) and doc_date_from < doc_date_to and depth < 10:
        log.info(f"  Splitting {label}: count={count}, size={size}, depth={depth}")
        with stats_lock:
            stats["split_days"] += 1

        all_docs = []
        for sub_from, sub_to in split_date_range(doc_date_from, doc_date_to):
            sub_docs = fetch_docs_recursive(doc_type, sign_date_str, sub_from, sub_to, source_ip, depth + 1)
            if sub_docs is not None:
                all_docs.extend(sub_docs)
        return all_docs

    # If single day and still truncated, just take what we get and warn
    if count > MAX_DOCS_PER_RESPONSE and doc_date_from == doc_date_to:
        log.warning(f"  Cannot split further {label}: count={count}, got {size}")

    docs = data.get("documents", [])
    if docs:
        log.debug(f"  Fetched {label}: {len(docs)} docs")
    return docs


def fetch_day(doc_type, sign_date_str, source_ip, output_dir):
    """Download all documents for a single signDate."""
    out_file = os.path.join(output_dir, doc_type, f"{sign_date_str}.json")

    # Skip if already exists and complete (not truncated)
    if os.path.exists(out_file) and os.path.getsize(out_file) > 10:
        try:
            with open(out_file, "r") as f:
                existing = json.load(f)
            if not existing.get("_incomplete") and not existing.get("_truncated"):
                with stats_lock:
                    stats["skipped"] += 1
                return True
        except (json.JSONDecodeError, KeyError):
            pass

    label = f"{doc_type}/{sign_date_str}"

    # First, try simple fetch
    url = f"{API_BASE}/{doc_type}?signDateFrom={sign_date_str}&signDateTo={sign_date_str}"
    data = fetch_with_retry(url, source_ip, label)
    if data is None:
        with stats_lock:
            stats["failed"] += 1
        return False

    size = data.get("size", 0)
    count = data.get("count", 0)
    more = data.get("moreThenCount", False)

    if count <= MAX_DOCS_PER_RESPONSE and not more:
        # Simple case — all docs fit in one response
        save_result(out_file, data, label, source_ip)
        return True

    # Truncated day
    if skip_truncated_mode:
        # Save partial data with marker, log for second pass
        data["_truncated"] = True
        data["_actual_count"] = count
        save_result(out_file, data, label, source_ip)
        with stats_lock:
            stats["truncated"] += 1
        with truncated_log_lock:
            with open(os.path.join(output_dir, "truncated_days.txt"), "a") as f:
                f.write(f"{doc_type}\t{sign_date_str}\t{count}\t{size}\n")
        log.warning(f"TRUNCATED {label}: count={count}, got {size} (skipping split)")
        return True

    # Full mode — split by documentDate using monthly windows
    log.info(f"Truncated {label}: count={count}, size={size}, splitting by documentDate...")
    sign_date = datetime.strptime(sign_date_str, "%Y-%m-%d")

    all_docs = []
    doc_date_cursor = sign_date

    # Go back up to 6 months — covers 99%+ of documents
    lookback_limit = sign_date - timedelta(days=180)
    windows = []
    for _ in range(7):
        window_end = doc_date_cursor
        window_start = doc_date_cursor.replace(day=1)
        if window_start < lookback_limit:
            window_start = lookback_limit
        windows.append((window_start, window_end))
        doc_date_cursor = window_start - timedelta(days=1)
        if doc_date_cursor < lookback_limit:
            break

    for win_start, win_end in windows:
        chunk = fetch_docs_recursive(doc_type, sign_date_str, win_start, win_end, source_ip)
        if chunk:
            all_docs.extend(chunk)

    # Deduplicate by id
    seen = set()
    unique = []
    for doc in all_docs:
        did = doc.get("id")
        if did not in seen:
            seen.add(did)
            unique.append(doc)

    result = {
        "size": len(unique),
        "count": len(unique),
        "moreThenCount": False,
        "documents": unique,
        "_merged_from_splits": True,
    }

    log.info(f"MERGED {label}: {len(unique)} unique docs (original count: {count})")

    save_result(out_file, result, label, source_ip)
    return True


def save_result(out_file, data, label, source_ip):
    """Save result to file and update stats."""
    doc_count = data.get("size", 0)
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    with stats_lock:
        stats["downloaded"] += 1
        stats["documents"] += doc_count

    if doc_count > 0:
        log.info(f"OK {label}: {doc_count} docs via {source_ip}")


def generate_dates(start_date, end_date):
    dates = []
    current = start_date
    while current <= end_date:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return dates


def main():
    parser = argparse.ArgumentParser(description="Download spending.gov.ua documents")
    parser.add_argument("--type", choices=DOC_TYPES + ["all"], default="all",
                        help="Document type to download")
    parser.add_argument("--from", dest="date_from", default="2016-01-01",
                        help="Start date (YYYY-MM-DD)")
    parser.add_argument("--to", dest="date_to", default=datetime.now().strftime("%Y-%m-%d"),
                        help="End date (YYYY-MM-DD)")
    parser.add_argument("--resume", action="store_true",
                        help="Skip days that already have data files")
    parser.add_argument("--output", default=OUTPUT_DIR,
                        help="Output directory")
    parser.add_argument("--ips", nargs="+", default=SOURCE_IPS,
                        help="Source IPs to use")
    parser.add_argument("--threads-per-ip", type=int, default=THREADS_PER_IP,
                        help="Threads per IP")
    parser.add_argument("--skip-truncated", action="store_true",
                        help="Save partial data for truncated days, process them later")
    args = parser.parse_args()

    global skip_truncated_mode
    skip_truncated_mode = args.skip_truncated

    types = DOC_TYPES if args.type == "all" else [args.type]
    start_date = datetime.strptime(args.date_from, "%Y-%m-%d")
    end_date = datetime.strptime(args.date_to, "%Y-%m-%d")
    dates = generate_dates(start_date, end_date)
    output_dir = args.output

    for t in types:
        os.makedirs(os.path.join(output_dir, t), exist_ok=True)

    # Build task list
    tasks = []
    for doc_type in types:
        for date_str in dates:
            if args.resume:
                out_file = os.path.join(output_dir, doc_type, f"{date_str}.json")
                if os.path.exists(out_file) and os.path.getsize(out_file) > 10:
                    try:
                        with open(out_file, "r") as f:
                            existing = json.load(f)
                        if not existing.get("_incomplete"):
                            stats["skipped"] += 1
                            continue
                    except (json.JSONDecodeError, KeyError):
                        pass
            tasks.append((doc_type, date_str))

    total_tasks = len(tasks)
    total_ips = len(args.ips)
    total_threads = total_ips * args.threads_per_ip

    log.info(f"Starting download: {len(types)} types, {len(dates)} days, "
             f"{total_tasks} tasks ({stats['skipped']} pre-skipped)")
    log.info(f"Using {total_ips} IPs x {args.threads_per_ip} threads = {total_threads} workers")
    log.info(f"Output: {output_dir}")

    if not tasks:
        log.info("Nothing to download, all files exist.")
        return

    # Assign tasks round-robin to IPs
    ip_tasks = {ip: [] for ip in args.ips}
    for i, task in enumerate(tasks):
        ip = args.ips[i % total_ips]
        ip_tasks[ip].append(task)

    all_futures = []
    executors = []

    for ip, ip_task_list in ip_tasks.items():
        executor = ThreadPoolExecutor(max_workers=args.threads_per_ip)
        executors.append(executor)
        for doc_type, date_str in ip_task_list:
            future = executor.submit(fetch_day, doc_type, date_str, ip, output_dir)
            all_futures.append(future)

    completed = 0
    start_time = time.time()
    for future in as_completed(all_futures):
        completed += 1
        if completed % 50 == 0 or completed == total_tasks:
            elapsed = time.time() - start_time
            rate = completed / elapsed if elapsed > 0 else 0
            eta = (total_tasks - completed) / rate if rate > 0 else 0
            log.info(
                f"Progress: {completed}/{total_tasks} ({completed*100//total_tasks}%) "
                f"| {rate:.1f} days/s | ETA: {eta/60:.0f}m "
                f"| docs: {stats['documents']} | reqs: {stats['requests']} "
                f"| failed: {stats['failed']} | splits: {stats['split_days']}"
            )

    for executor in executors:
        executor.shutdown(wait=True)

    elapsed = time.time() - start_time
    log.info(f"\nDone in {elapsed/60:.1f} minutes")
    log.info(f"Downloaded: {stats['downloaded']} | Skipped: {stats['skipped']} | "
             f"Failed: {stats['failed']} | Splits: {stats['split_days']} | "
             f"Requests: {stats['requests']} | Total docs: {stats['documents']}")


if __name__ == "__main__":
    main()
