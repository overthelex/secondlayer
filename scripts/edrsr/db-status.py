#!/usr/bin/env python3
"""
Prod DB Status — огляд усіх баз даних на проді з часом останнього оновлення.

Підключається через SSH (ssh prod), читає pg_class + pg_stat для швидких результатів.

Usage:
    python3 scripts/edrsr/db-status.py
    python3 scripts/edrsr/db-status.py --format csv
    python3 scripts/edrsr/db-status.py --format json
    python3 scripts/edrsr/db-status.py --page-size 40
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

# ── Connection config ──

DATABASES = {
    "secondlayer": {
        "container": "secondlayer-postgres-prod",
        "user": "secondlayer",
        "db": "secondlayer_prod",
        "label": "SecondLayer (основна)",
    },
    "openreyestr": {
        "container": "openreyestr-postgres-prod",
        "user": "openreyestr",
        "db": "openreyestr_prod",
        "label": "OpenReyestr (реєстри)",
    },
}

# ── Tables to exclude ──

EXCLUDE_PREFIXES = ("edrsr_", "spain_")
EXCLUDE_TABLES = {
    "schema_migrations", "migrations", "billing_migration_log",
    "system_config", "tool_usage_stats",
}

# Only show tables that are open data sources (listed in UPDATE_FREQ_DAYS).
# App tables (billing, users, oauth, etc.) are filtered out.
ONLY_OPENDATA = True

# ── Expected update frequency (in days) per table ──
# green = within expected window, yellow = 1.5x, orange = 2x, red = 3x+
# Tables not listed default to 7 days (weekly)

UPDATE_FREQ_DAYS = {
    # ── SecondLayer: щоденні джерела ──
    "opendata_missing_persons": 1,
    "opendata_wanted_persons": 1,
    "opendata_wanted_vehicles": 1,
    "opendata_corruption_offenders": 1,
    "opendata_invalid_passports": 1,
    "opendata_invalid_passports_foreign": 1,
    "opendata_vehicle_registrations": 1,
    "opendata_financial_statements": 1,
    "opendata_state_aid": 1,
    "opendata_lustration": 1,
    # ── SecondLayer: щотижневі джерела ──
    "opendata_patents": 7,
    "opendata_trademarks": 7,
    "opendata_advocates": 7,
    "opendata_lawyers": 7,
    "opendata_court_experts": 7,
    "opendata_bankruptcy": 7,
    "opendata_bankruptcy_cases": 7,
    "opendata_securities_owners": 7,
    "opendata_vat_payers": 7,
    "opendata_declaration_checks": 7,
    "opendata_large_taxpayers": 7,
    "opendata_wage_debtors": 7,
    "opendata_public_organizations": 7,
    "opensanctions_entities": 7,
    "spending_acts": 7,
    "spending_addendums": 7,
    "spending_contracts": 7,
    "spending_peny": 7,
    "bills": 7,
    "deputies": 7,
    "voting_records": 7,
    "legislation": 7,
    "legislation_articles": 7,
    "legislation_chunks": 7,
    "judge_analytics": 7,
    "vkks_judges": 7,
    "vkks_evaluations": 7,
    "vkks_declarations": 7,
    "vkks_judge_efficiency": 7,
    "vkks_vacancies": 7,
    "vrp_decisions": 7,
    "echr_cases": 7,
    "supreme_court_reviews": 7,
    "dsa_case_distribution": 7,
    # ── SecondLayer: щомісячні / рідкі ──
    "court_sessions": 30,
    "opendata_edrnpa_texts": 30,
    "opendata_edrnpa_cards": 30,
    "opendata_court_case_status": 30,
    "opendata_court_schedule": 30,
    "opendata_judge_candidates": 30,
    "opendata_terrorism_orgs": 90,
    "opendata_terrorism_persons": 90,
    "judges": 90,
    "judges_current": 90,
    # ── OpenReyestr: щоденні ──
    "debtors": 1,
    "enforcement_proceedings": 1,
    # ── OpenReyestr: щотижневі ──
    "arbitration_managers": 7,
    "bankruptcy_cases": 7,
    "court_experts": 7,
    "forensic_methods": 7,
    "notaries": 7,
    "special_forms": 7,
    "streets": 7,
    "administrative_units": 7,
    "legal_acts": 7,
    # ── OpenReyestr: щомісячні / квартальні ──
    "legal_entities": 30,
    "individual_entrepreneurs": 30,
    "founders": 30,
    "signers": 30,
    "beneficiaries": 30,
    "exchange_data": 30,
    "members": 30,
    "predecessors": 30,
    "assignees": 30,
    "termination_started": 30,
    "executive_power": 30,
    "public_associations": 30,
    "bankruptcy_info": 30,
    "arma_assets": 30,
    "nazk_declarations": 30,
    "tax_debt": 30,
    "esv_debt": 30,
    "vat_payers": 30,
    "single_tax_payers": 30,
    "rnbo_sanctions": 30,
    "inspection_plans": 30,
    "dssu_financial_reports": 30,
    "street_renamings": 30,
    "prozorro_tenders": 30,
}

# ── Ukrainian display names for tables ──

TABLE_NAMES_UK = {
    # SecondLayer: МВС
    "opendata_missing_persons": "МВС — Безвісно зниклі особи",
    "opendata_wanted_persons": "МВС — Особи, які переховуються",
    "opendata_wanted_vehicles": "МВС — Транспорт у розшуку",
    # SecondLayer: НАЗК
    "opendata_corruption_offenders": "НАЗК — Правопорушники",
    "opendata_declaration_checks": "НАЗК — Перевірки декларацій",
    # SecondLayer: документи
    "opendata_invalid_passports": "ДМС — Недійсні паспорти",
    "opendata_invalid_passports_foreign": "ДМС — Недійсні закордонні паспорти",
    "opendata_vehicle_registrations": "МВС — Реєстрація транспортних засобів",
    "opendata_financial_statements": "ДССУ — Фінзвітність підприємств",
    "opendata_state_aid": "АМКУ — Державна допомога",
    "opendata_lustration": "Мін'юст — Реєстр люстрованих осіб",
    # SecondLayer: інтелектуальна власність
    "opendata_patents": "УІПВ — Патенти на винаходи",
    "opendata_trademarks": "УІПВ — Торговельні марки",
    # SecondLayer: юристи
    "opendata_advocates": "ЄРАУ — Реєстр адвокатів",
    "opendata_lawyers": "ЄРАР — Реєстр адвокатів (розширений)",
    "opendata_court_experts": "Мін'юст — Атестовані судові експерти",
    # SecondLayer: банкрутство / фінанси
    "opendata_bankruptcy": "ВГСУ — Реєстр банкрутств",
    "opendata_bankruptcy_cases": "ВГСУ — Справи про банкрутство",
    "opendata_securities_owners": "НКЦПФР — Власники цінних паперів",
    "opendata_vat_payers": "ДПС — Реєстр платників ПДВ",
    "opendata_large_taxpayers": "ДПС — Великі платники податків",
    "opendata_wage_debtors": "Держпраці — Боржники із зарплати",
    "opendata_public_organizations": "Мін'юст — Громадські об'єднання",
    "opensanctions_entities": "OpenSanctions — Міжнародні санкції",
    # SecondLayer: публічні фінанси
    "spending_acts": "Казначейство — Акти (spending.gov.ua)",
    "spending_addendums": "Казначейство — Додатки (spending.gov.ua)",
    "spending_contracts": "Казначейство — Договори (spending.gov.ua)",
    "spending_peny": "Казначейство — Пені (spending.gov.ua)",
    # SecondLayer: Верховна Рада
    "bills": "ВРУ — Законопроєкти",
    "deputies": "ВРУ — Народні депутати",
    "voting_records": "ВРУ — Результати голосувань",
    "legislation": "ВРУ — Тексти законодавства",
    "legislation_articles": "ВРУ — Статті законодавства",
    "legislation_chunks": "ВРУ — Секції законодавства",
    # SecondLayer: судова система
    "judge_analytics": "Аналітика суддів",
    "vkks_judges": "ВККС — Реєстр суддів",
    "vkks_evaluations": "ВККС — Оцінювання суддів",
    "vkks_declarations": "ВККС — Декларації суддів",
    "vkks_judge_efficiency": "ВККС — Ефективність суддів",
    "vkks_vacancies": "ВККС — Вакансії суддів",
    "vrp_decisions": "ВРП — Рішення Вищої ради правосуддя",
    "echr_cases": "ЄСПЛ — Рішення Європейського суду",
    "supreme_court_reviews": "ВС — Огляди Верховного Суду",
    "dsa_case_distribution": "ДСА — Автоматичний розподіл справ",
    "court_sessions": "Судові засідання",
    # SecondLayer: нормативна база
    "opendata_edrnpa_texts": "ЄДРНПА — Тексти нормативних актів",
    "opendata_edrnpa_cards": "ЄДРНПА — Картки нормативних актів",
    "opendata_court_case_status": "Судова влада — Стан справ",
    "opendata_court_schedule": "Судова влада — Розклад засідань",
    "opendata_judge_candidates": "ВККС — Кандидати на посаду судді",
    # SecondLayer: безпека
    "opendata_terrorism_orgs": "ДСФМУ — Терористичні організації",
    "opendata_terrorism_persons": "ДСФМУ — Терористичні особи",
    "judges": "Судова влада — Реєстр суддів",
    "judges_current": "Судова влада — Діючі судді",
    # ── OpenReyestr ──
    "debtors": "НАІС — Єдиний реєстр боржників",
    "enforcement_proceedings": "НАІС — Виконавчі провадження (АСВП)",
    "arbitration_managers": "НАІС — Арбітражні керуючі",
    "bankruptcy_cases": "НАІС — Реєстр банкрутства",
    "court_experts": "НАІС — Атестовані судові експерти",
    "forensic_methods": "НАІС — Методики судових експертиз",
    "notaries": "НАІС — Єдиний реєстр нотаріусів",
    "special_forms": "НАІС — Спеціальні бланки нотаріальних документів",
    "streets": "НАІС — Словник вулиць",
    "administrative_units": "НАІС — Адміністративно-територіальний устрій",
    "legal_acts": "НАІС — ЄДРНПА (нормативно-правові акти)",
    "legal_entities": "ЄДР — Юридичні особи",
    "individual_entrepreneurs": "ЄДР — Фізичні особи-підприємці",
    "founders": "ЄДР — Засновники",
    "signers": "ЄДР — Підписанти",
    "beneficiaries": "ЄДР — Кінцеві бенефіціарні власники",
    "exchange_data": "ЄДР — Дані обміну",
    "members": "ЄДР — Учасники",
    "predecessors": "ЄДР — Попередники",
    "assignees": "ЄДР — Правонаступники",
    "termination_started": "ЄДР — Припинення (в процесі)",
    "executive_power": "ЄДР — Органи виконавчої влади",
    "public_associations": "ЄДР — Громадські формування",
    "bankruptcy_info": "ЄДР — Інформація про банкрутство",
    "arma_assets": "АРМА — Реєстр активів",
    "nazk_declarations": "НАЗК — Декларації",
    "tax_debt": "ДПС — Податковий борг",
    "esv_debt": "ДПС — Борг з ЄСВ",
    "vat_payers": "ДПС — Платники ПДВ",
    "single_tax_payers": "ДПС — Платники єдиного податку",
    "rnbo_sanctions": "РНБО — Санкційні списки",
    "inspection_plans": "Держнагляд — Плани перевірок",
    "dssu_financial_reports": "ДССУ — Фінансова звітність",
    "street_renamings": "Перейменування вулиць",
    "prozorro_tenders": "Prozorro — Тендери",
}

DEFAULT_FREQ_DAYS = 7

# ── Queries ──

Q_TABLE_STATS = """
SELECT
  c.relname,
  c.reltuples::bigint,
  pg_total_relation_size(c.oid),
  COALESCE(s.last_autoanalyze, s.last_analyze),
  s.n_tup_ins,
  s.n_tup_upd,
  s.n_tup_del
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relname = c.relname
WHERE c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;
"""

Q_DB_SIZE = """
SELECT pg_database_size(current_database());
"""

Q_IMPORT_TASKS = """
SELECT DISTINCT ON (source_name)
  source_name, status, records_imported, completed_at, elapsed_ms, last_error
FROM import_tasks
ORDER BY source_name, completed_at DESC NULLS LAST;
"""

Q_IMPORT_LOG = """
SELECT DISTINCT ON (registry_name)
  registry_name, status, records_imported, import_completed_at
FROM import_log
ORDER BY registry_name, import_completed_at DESC NULLS LAST;
"""


def prod_psql(container: str, user: str, db: str, sql: str) -> str:
    flat_sql = " ".join(sql.strip().split())
    shell_cmd = f'docker exec {container} psql -U {user} -d {db} -t -A -c "{flat_sql}"'
    cmd = ["ssh", "prod", shell_cmd]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return ""
    return r.stdout.strip()


def psql(db_key: str, sql: str) -> str:
    cfg = DATABASES[db_key]
    return prod_psql(cfg["container"], cfg["user"], cfg["db"], sql)


def fmt_num(n: int) -> str:
    if n < 0:
        return "—"
    return f"{n:,}".replace(",", " ")


def fmt_size(b: int) -> str:
    if b < 0:
        return "—"
    if b < 1024:
        return f"{b} B"
    elif b < 1024 ** 2:
        return f"{b / 1024:.0f} KB"
    elif b < 1024 ** 3:
        return f"{b / 1024**2:.0f} MB"
    else:
        return f"{b / 1024**3:.1f} GB"


def _normalize_ts(ts_str: str) -> str:
    """Normalize postgres timestamp: +02 → +02:00 for Python parsing."""
    import re
    ts_str = ts_str.strip()
    # Fix short timezone offset: +02 → +02:00, -05 → -05:00
    ts_str = re.sub(r'([+-]\d{2})$', r'\1:00', ts_str)
    return ts_str


def _parse_ts(ts_str: str) -> datetime | None:
    """Parse postgres timestamp string into datetime."""
    if not ts_str:
        return None
    ts_str = _normalize_ts(ts_str)
    for fmt in (
        "%Y-%m-%d %H:%M:%S.%f%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
    ):
        try:
            dt = datetime.strptime(ts_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def time_ago(ts_str: str) -> str:
    """Convert timestamp string to human-readable 'time ago'."""
    if not ts_str:
        return "невідомо"
    try:
        dt = _parse_ts(ts_str)
        if not dt:
            return ts_str[:16]

        now = datetime.now(timezone.utc)
        delta = now - dt
        total_sec = int(delta.total_seconds())

        if total_sec < 0:
            return "щойно"
        elif total_sec < 60:
            return f"{total_sec}с тому"
        elif total_sec < 3600:
            return f"{total_sec // 60}хв тому"
        elif total_sec < 86400:
            h = total_sec // 3600
            return f"{h}год тому"
        elif total_sec < 86400 * 30:
            d = total_sec // 86400
            return f"{d}д тому"
        else:
            m = total_sec // (86400 * 30)
            return f"{m}міс тому"
    except Exception:
        return ts_str[:16]


def freshness_icon(ts_str: str, table_name: str = "") -> str:
    """Return icon based on how fresh data is relative to expected update frequency.

    🟢 within expected window (freq * 1.5)
    🟡 slightly overdue (freq * 1.5 .. freq * 2.5)
    🟠 overdue (freq * 2.5 .. freq * 4)
    🔴 very overdue (> freq * 4)
    """
    if not ts_str:
        return "⚪"
    dt = _parse_ts(ts_str)
    if not dt:
        return "⚪"

    freq = UPDATE_FREQ_DAYS.get(table_name, DEFAULT_FREQ_DAYS)
    days = (datetime.now(timezone.utc) - dt).total_seconds() / 86400

    if days <= freq * 1.5:
        return "🟢"
    elif days <= freq * 2.5:
        return "🟡"
    elif days <= freq * 4:
        return "🟠"
    else:
        return "🔴"


def wait_for_key():
    print("  ─── ПРОБІЛ/ENTER — далі, q — вихід ───", end="", flush=True)
    try:
        import tty
        import termios
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print("\r" + " " * 60 + "\r", end="")
        if ch in ("q", "Q"):
            print()
            sys.exit(0)
    except (ImportError, termios.error, ValueError, EOFError):
        print("\r" + " " * 60 + "\r", end="")


def parse_table_stats(raw: str, exclude_prefixes=(), exclude_tables=None):
    """Parse table stats output into list of dicts."""
    exclude_tables = exclude_tables or set()
    rows = []
    seen = set()
    for line in raw.split("\n"):
        if not line or "|" not in line:
            continue
        parts = line.split("|")
        if len(parts) < 7:
            continue
        name = parts[0]
        if name in seen:
            continue
        if name in exclude_tables:
            continue
        if any(name.startswith(p) for p in exclude_prefixes):
            continue
        seen.add(name)

        row_est = int(parts[1]) if parts[1] else 0
        size_bytes = int(parts[2]) if parts[2] else 0
        last_activity = parts[3] if parts[3] else ""
        n_ins = int(parts[4]) if parts[4] else 0
        n_upd = int(parts[5]) if parts[5] else 0
        n_del = int(parts[6]) if parts[6] else 0

        rows.append({
            "table": name,
            "rows": max(row_est, 0),
            "size_bytes": size_bytes,
            "last_activity": last_activity,
            "n_ins": n_ins,
            "n_upd": n_upd,
            "n_del": n_del,
        })
    return rows


def parse_import_tasks(raw: str) -> dict:
    """Parse import_tasks into {source_name: {...}}."""
    result = {}
    for line in raw.split("\n"):
        if not line or "|" not in line:
            continue
        parts = line.split("|")
        result[parts[0]] = {
            "status": parts[1],
            "records_imported": int(parts[2]) if parts[2] else 0,
            "completed_at": parts[3] if len(parts) > 3 else "",
            "elapsed_ms": int(parts[4]) if len(parts) > 4 and parts[4] else 0,
            "last_error": parts[5] if len(parts) > 5 else "",
        }
    return result


def parse_import_log(raw: str) -> dict:
    result = {}
    for line in raw.split("\n"):
        if not line or "|" not in line:
            continue
        parts = line.split("|")
        result[parts[0]] = {
            "status": parts[1],
            "records_imported": int(parts[2]) if parts[2] else 0,
            "completed_at": parts[3] if len(parts) > 3 else "",
        }
    return result


def print_db_section(db_key: str, label: str, tables: list, import_info: dict,
                     db_size: int, page_size: int, fmt: str):
    """Print one database section."""
    total_rows = sum(r["rows"] for r in tables)
    total_size = sum(r["size_bytes"] for r in tables)

    if fmt == "csv":
        print(f"\n# {label}")
        print("table,name_uk,rows,size,last_activity,time_ago")
        for r in tables:
            imp = import_info.get(r["table"], {})
            last = imp.get("completed_at", "") or r["last_activity"]
            name_uk = TABLE_NAMES_UK.get(r["table"], r["table"])
            print(f"{r['table']},{name_uk},{r['rows']},{r['size_bytes']},{last},{time_ago(last)}")
        return

    W = 120
    print()
    print(f"  {'═' * W}")
    print(f"  📦 {label}  —  {len(tables)} таблиць, {fmt_size(db_size)} загалом")
    print(f"  {'═' * W}")
    HDR = f"  {'#':<4} {'Реєстр':<48} {'Рядків':>12} {'Розмір':>9} {'Оновл.':>10}  {'Норма':>6} {'Давність':>14} {'':>2}"
    print(HDR)
    print(f"  {'─' * W}")

    for i, r in enumerate(tables):
        imp = import_info.get(r["table"], {})
        last_ts = imp.get("completed_at", "") or r["last_activity"]
        ago = time_ago(last_ts)
        icon = freshness_icon(last_ts, r["table"])
        row_str = fmt_num(r["rows"]) if r["rows"] > 0 else "—"
        display_name = TABLE_NAMES_UK.get(r["table"], r["table"])

        # Last import size
        last_imported = imp.get("records_imported", 0)
        imported_str = fmt_num(last_imported) if last_imported > 0 else "—"

        # Expected frequency label
        freq = UPDATE_FREQ_DAYS.get(r["table"], DEFAULT_FREQ_DAYS)
        if freq <= 1:
            freq_lbl = "1д"
        elif freq <= 7:
            freq_lbl = "7д"
        elif freq <= 30:
            freq_lbl = "30д"
        else:
            freq_lbl = f"{freq}д"

        # Show import status if failed
        imp_status = ""
        if imp.get("status") == "failed":
            imp_status = " ⛔"
        elif imp.get("status") == "running":
            imp_status = " 🔄"

        print(f"  {i + 1:<4} {display_name:<48} {row_str:>12} {fmt_size(r['size_bytes']):>9} {imported_str:>10}  {freq_lbl:>6} {ago:>14} {icon}{imp_status}")

        if (i + 1) % page_size == 0 and i + 1 < len(tables):
            remaining = len(tables) - i - 1
            print(f"  {'─' * W}")
            print(f"  ... ще {remaining} таблиць")
            wait_for_key()
            print(f"  {'─' * W}")
            print(HDR)
            print(f"  {'─' * W}")

    print(f"  {'─' * W}")
    print(f"  {'':4} {'РАЗОМ: ' + str(len(tables)) + ' таблиць':<38} {fmt_num(total_rows):>12} {fmt_size(total_size):>9}")
    print()


def main():
    parser = argparse.ArgumentParser(description="Prod DB status: all databases overview")
    parser.add_argument("--format", choices=["table", "csv", "json"], default="table")
    parser.add_argument("--page-size", type=int, default=35, help="rows per page (default: 35)")
    args = parser.parse_args()

    print("⏳ Сканування прод-баз...", file=sys.stderr)

    # ── 1. SecondLayer DB ──
    print("  → secondlayer_prod...", file=sys.stderr)
    sl_raw = psql("secondlayer", Q_TABLE_STATS)
    sl_size_raw = psql("secondlayer", Q_DB_SIZE)
    sl_import_raw = psql("secondlayer", Q_IMPORT_TASKS)

    sl_tables_all = parse_table_stats(sl_raw, EXCLUDE_PREFIXES, EXCLUDE_TABLES)
    sl_db_size = int(sl_size_raw.strip()) if sl_size_raw.strip() else 0
    sl_imports = parse_import_tasks(sl_import_raw)

    # Filter to open data tables only
    if ONLY_OPENDATA:
        sl_tables = [r for r in sl_tables_all if r["table"] in UPDATE_FREQ_DAYS]
    else:
        sl_tables = sl_tables_all

    # Map import source → target table for lookup
    src_catalog_raw = psql("secondlayer",
        "SELECT name, target_table FROM import_source_catalog;")
    src_to_table = {}
    for line in src_catalog_raw.split("\n"):
        if "|" in line:
            parts = line.split("|")
            src_to_table[parts[0]] = parts[1]

    # Build import info keyed by table name
    sl_import_by_table = {}
    for src_name, info in sl_imports.items():
        tbl = src_to_table.get(src_name, src_name)
        # Keep the most recent entry per table
        if tbl not in sl_import_by_table or (info.get("completed_at", "") > sl_import_by_table[tbl].get("completed_at", "")):
            sl_import_by_table[tbl] = info

    # ── 2. OpenReyestr DB ──
    print("  → openreyestr_prod...", file=sys.stderr)
    or_raw = psql("openreyestr", Q_TABLE_STATS)
    or_size_raw = psql("openreyestr", Q_DB_SIZE)
    or_import_raw = psql("openreyestr", Q_IMPORT_LOG)

    or_tables_all = parse_table_stats(or_raw, exclude_tables=EXCLUDE_TABLES)
    or_db_size = int(or_size_raw.strip()) if or_size_raw.strip() else 0
    or_imports = parse_import_log(or_import_raw)

    # Filter to open data tables only
    if ONLY_OPENDATA:
        or_tables = [r for r in or_tables_all if r["table"] in UPDATE_FREQ_DAYS]
    else:
        or_tables = or_tables_all

    # Map import log registry_name → table
    or_import_by_table = {}
    for reg_name, info in or_imports.items():
        or_import_by_table[reg_name] = info

    # ── 3. EDRSR summary (special) ──
    edrsr_docs_raw = psql("secondlayer",
        "SELECT SUM(reltuples::bigint) FROM pg_class WHERE relname LIKE 'edrsr_documents_p_%%' AND relkind = 'r';")
    edrsr_ft_raw = psql("secondlayer",
        "SELECT SUM(reltuples::bigint) FROM pg_class WHERE relname LIKE 'edrsr_fulltext_p_%%' AND relkind = 'r';")
    edrsr_size_raw = psql("secondlayer",
        "SELECT SUM(pg_total_relation_size(c.oid)) FROM pg_class c WHERE c.relname LIKE 'edrsr_%%' AND c.relkind = 'r';")

    edrsr_docs = int(edrsr_docs_raw) if edrsr_docs_raw else 0
    edrsr_ft = int(edrsr_ft_raw) if edrsr_ft_raw else 0
    edrsr_size = int(edrsr_size_raw) if edrsr_size_raw else 0
    edrsr_pct = round(edrsr_ft / edrsr_docs * 100, 1) if edrsr_docs > 0 else 0

    # ── Output ──
    # Use all tables for JSON (full picture) or filtered for table view
    sl_tables_json = sl_tables_all if args.format == "json" else sl_tables
    or_tables_json = or_tables_all if args.format == "json" else or_tables

    if args.format == "json":
        out = {
            "edrsr": {
                "docs": edrsr_docs, "fulltext": edrsr_ft,
                "coverage_pct": edrsr_pct, "size": fmt_size(edrsr_size),
            },
            "secondlayer": {
                "db_size": fmt_size(sl_db_size),
                "tables": [{
                    "table": r["table"], "rows": r["rows"],
                    "size": fmt_size(r["size_bytes"]),
                    "last_activity": r["last_activity"],
                    "writes": r["n_ins"] + r["n_upd"],
                } for r in sl_tables_json],
            },
            "openreyestr": {
                "db_size": fmt_size(or_db_size),
                "tables": [{
                    "table": r["table"], "rows": r["rows"],
                    "size": fmt_size(r["size_bytes"]),
                    "last_activity": r["last_activity"],
                    "writes": r["n_ins"] + r["n_upd"],
                } for r in or_tables_json],
            },
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    # ── EDRSR summary banner ──
    if args.format == "table":
        W = 100
        print()
        print(f"  {'═' * W}")
        print(f"  ⚖️  ЄДРСР (судові рішення)  —  окрема партиціонована структура")
        print(f"  {'═' * W}")
        print(f"  Документів:     {fmt_num(edrsr_docs):>14}")
        print(f"  Повних текстів: {fmt_num(edrsr_ft):>14}  ({edrsr_pct}% покриття)")
        print(f"  Розмір:         {fmt_size(edrsr_size):>14}")
        print(f"  👉 Детально: python3 scripts/edrsr/edrsr-stats.py")
        print()
        wait_for_key()

    # ── SecondLayer tables ──
    print_db_section("secondlayer", DATABASES["secondlayer"]["label"],
                     sl_tables, sl_import_by_table, sl_db_size,
                     args.page_size, args.format)

    if args.format == "table":
        wait_for_key()

    # ── OpenReyestr tables ──
    print_db_section("openreyestr", DATABASES["openreyestr"]["label"],
                     or_tables, or_import_by_table, or_db_size,
                     args.page_size, args.format)

    # ── Legend ──
    if args.format == "table":
        print(f"  📋 Легенда: 🟢 в нормі  🟡 злегка прострочено  🟠 прострочено  🔴 сильно прострочено  ⚪ невідомо  ⛔ імпорт failed  🔄 running")
        print(f"  📋 Норма залежить від джерела: щоденні (МВС, паспорти), щотижневі (УІПВ, НАІС), щомісячні (ЄДР, ЄДРПОУ)")
        print(f"  📋 Оновл. = кількість записів завантажених при останньому імпорті")
        print()


if __name__ == "__main__":
    main()
