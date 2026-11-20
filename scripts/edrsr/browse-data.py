#!/usr/bin/env python3
"""
Інтерактивний браузер відкритих даних на проді.

Навігація:
  ↑↓       — вибір реєстру / документа в списку
  Enter    — відкрити реєстр → показати документи
  ←→       — попередній / наступний документ
  ↓        — прокрутити текст документа вниз
  ↑        — прокрутити вверх
  Escape   — назад до списку реєстрів
  q        — вихід

Usage:
    python3 scripts/edrsr/browse-data.py
"""

import curses
import json
import os
import sys
import textwrap
import threading

# ── Import table config from db-status.py ──

def _load_db_status():
    import importlib.util
    p = os.path.join(os.path.dirname(__file__), "db-status.py")
    spec = importlib.util.spec_from_file_location("db_status", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

_db = _load_db_status()
TABLE_NAMES_UK = _db.TABLE_NAMES_UK
UPDATE_FREQ_DAYS = _db.UPDATE_FREQ_DAYS

# ── DB config (direct psycopg2 via .env.prod) ──

def _load_env_prod():
    env = {}
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env.prod")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
    return env

_env = _load_env_prod()

DATABASES = {
    "secondlayer": {
        "host": _env.get("PROD_DB_HOST", "18.158.242.206"),
        "port": int(_env.get("PROD_DB_PORT", "5438")),
        "user": _env.get("PROD_DB_USER", "secondlayer"),
        "password": _env.get("PROD_DB_PASSWORD", ""),
        "dbname": _env.get("PROD_DB_NAME", "secondlayer_prod"),
        "schema": "public",
    },
    "openreyestr": {
        "host": _env.get("PROD_DB_HOST", "18.158.242.206"),
        "port": int(_env.get("PROD_OPENREYESTR_DB_PORT", "5440")),
        "user": _env.get("PROD_OPENREYESTR_DB_USER", "openreyestr"),
        "password": _env.get("PROD_OPENREYESTR_DB_PASSWORD", ""),
        "dbname": _env.get("PROD_OPENREYESTR_DB_NAME", "openreyestr_prod"),
        "schema": "public",
    },
    "rada": {
        "host": _env.get("PROD_DB_HOST", "18.158.242.206"),
        "port": int(_env.get("PROD_DB_PORT", "5438")),
        "user": _env.get("PROD_DB_USER", "secondlayer"),
        "password": _env.get("PROD_DB_PASSWORD", ""),
        "dbname": _env.get("PROD_DB_NAME", "secondlayer_prod"),
        "schema": "rada",
    },
}

# Connection pool (reuse connections)
_connections: dict = {}

def _get_conn(db_key: str):
    import psycopg2
    if db_key in _connections:
        try:
            _connections[db_key].cursor().execute("SELECT 1")
            return _connections[db_key]
        except Exception:
            try: _connections[db_key].close()
            except: pass
            del _connections[db_key]
    cfg = DATABASES[db_key]
    conn = psycopg2.connect(
        host=cfg["host"], port=cfg["port"], user=cfg["user"],
        password=cfg["password"], dbname=cfg["dbname"],
        connect_timeout=10,
        options=f"-c search_path={cfg['schema']},public" if cfg["schema"] != "public" else "",
    )
    conn.autocommit = True
    _connections[db_key] = conn
    return conn

# Which tables belong to which DB
RADA_TABLES = {"bills", "deputies", "voting_records"}

OPENREYESTR_TABLES = {
    "debtors", "enforcement_proceedings", "arbitration_managers", "bankruptcy_cases",
    "court_experts", "forensic_methods", "notaries", "special_forms", "streets",
    "administrative_units", "legal_acts", "legal_entities", "individual_entrepreneurs",
    "founders", "signers", "beneficiaries", "exchange_data", "members", "predecessors",
    "assignees", "termination_started", "executive_power", "public_associations",
    "bankruptcy_info", "arma_assets", "nazk_declarations", "tax_debt", "esv_debt",
    "vat_payers", "single_tax_payers", "rnbo_sanctions", "inspection_plans",
    "dssu_financial_reports", "street_renamings", "prozorro_tenders",
}

# ── Preview columns per table (most readable fields first) ──

PREVIEW_COLUMNS = {
    # МВС
    "opendata_wanted_persons": ["last_name_u", "first_name_u", "middle_name_u", "birth_date", "sex", "ovd", "category", "lost_date", "lost_place", "article_crim", "restraint"],
    "opendata_missing_persons": ["last_name_u", "first_name_u", "middle_name_u", "birth_date", "sex", "ovd", "category", "lost_date", "lost_place", "contact"],
    "opendata_wanted_vehicles": ["brand_model", "car_type", "color", "vehicle_number", "body_number", "chassis_number", "engine_number", "organ_unit", "insert_date"],
    "opendata_vehicle_registrations": ["brand", "model", "make_year", "color", "kind", "body", "purpose", "fuel", "oper_name", "d_reg"],
    # НАЗК
    "opendata_corruption_offenders": ["last_name", "first_name", "patronymic", "punishment_type", "offense_name", "punishment", "court_case_number", "sentence_date"],
    # Санкції
    "opensanctions_entities": ["id", "schema", "name", "aliases", "birth_date", "countries", "sanctions", "datasets"],
    "rnbo_sanctions": ["name", "aliases", "schema_type", "birth_date", "countries", "sanctions"],
    # Інтелектуальна власність
    "opendata_trademarks": ["registration_number", "app_number", "mark_text", "holder_name", "nice_classes", "status", "registration_date", "expiry_date"],
    "opendata_patents": ["registration_number", "obj_type_name", "title_ua", "title_en", "owner_name", "status", "registration_date"],
    # Юристи
    "opendata_advocates": ["family_name", "name", "additional_name", "ra_name", "certificate_num", "certificate_date", "authority_name"],
    "opendata_lawyers": ["last_name", "first_name", "patronymic", "ra_name", "certificate_num", "certificate_date", "email"],
    "opendata_court_experts": ["surname", "first_name", "patronymic", "org_name", "region", "exp_type", "specialization", "license_num"],
    # ВРП / ВККС
    "vrp_decisions": ["date_time", "authority", "decision_num", "voting_title", "voting_result"],
    "vkks_judges": ["dossier_number", "full_name", "gender", "court_name", "source_date"],
    "vkks_evaluations": ["judge_name", "court_name", "total_score", "collegium_decision_date", "collegium_decision_essence", "evaluation_type"],
    "vkks_declarations": ["judge_name", "court_name", "declaration_type", "year"],
    "vkks_judge_efficiency": ["judge_name", "court_name", "court_level", "year", "workload_criminal_judge", "workload_civil_judge"],
    "vkks_vacancies": ["court_name", "court_level", "region", "positions_limit", "positions_filled", "positions_vacant", "report_date"],
    # Верховна Рада (rada DB — окрема база, columns auto-detected)
    "bills": [],
    "deputies": [],
    "voting_records": [],
    "legislation": ["rada_id", "type", "title", "short_title", "adoption_date", "status", "total_articles"],
    "legislation_articles": ["legislation_id", "article_number", "section_number", "title", "full_text"],
    "legislation_chunks": ["legislation_id", "article_id", "chunk_index", "text"],
    # Фінанси
    "spending_acts": ["edrpou", "document_number", "document_date", "amount", "currency", "sign_date"],
    "spending_addendums": ["edrpou", "document_number", "document_date", "amount", "currency", "sign_date"],
    "spending_contracts": ["edrpou", "document_number", "document_date", "amount", "currency", "subject", "from_date", "to_date"],
    "spending_peny": ["edrpou", "document_number", "document_date", "amount", "currency", "sign_date"],
    # ЄДРНПА
    "opendata_edrnpa_cards": ["publisher", "doc_type", "number", "date_acc", "name", "status", "reestr_code"],
    "opendata_edrnpa_texts": ["id", "reestr_code"],
    # Судова система
    "court_sessions": ["court_name", "judge_name", "case_number", "session_date", "session_time", "session_form", "involved_parties"],
    "opendata_court_case_status": ["court_name", "case_number", "judge", "judges", "registration_date", "stage_name", "cause_result"],
    "opendata_court_schedule": ["court_name", "judges", "case_number", "hearing_date", "court_room", "case_description"],
    "dsa_case_distribution": ["cause_number", "court_name", "presiding_judge", "case_category", "case_essence", "distribution_start"],
    "judges": ["full_name", "court_name", "gender"],
    "judges_current": ["full_name", "court_name", "gender"],
    "judge_analytics": ["judge_name", "court_name", "instance_name", "total_decisions", "unique_cases", "appeal_rate"],
    "echr_cases": ["app_no", "doc_name", "doc_type", "article", "conclusion", "importance", "judgment_date"],
    "supreme_court_reviews": ["chamber_short", "title", "category", "period", "year"],
    # Паспорти / Люстрація / Держдопомога
    "opendata_invalid_passports": ["d_series", "d_number", "d_type", "d_status", "ovd", "theft_date", "insert_date"],
    "opendata_invalid_passports_foreign": ["d_series", "d_number", "d_type", "d_status", "ovd", "theft_date", "insert_date"],
    "opendata_lustration": ["fio", "job", "judgment", "period"],
    "opendata_state_aid": ["provider_name", "recipient_name", "recipient_edrpou", "program_name", "amount", "decision_date"],
    "opendata_financial_statements": ["tin", "c_doc", "period_year", "period_month", "form_type"],
    # Банкрутство / НКЦПФР
    "opendata_bankruptcy": ["firm_name", "firm_edrpou", "case_number", "court_name", "case_type", "publish_date"],
    "opendata_bankruptcy_cases": ["firm_name", "firm_edrpou", "case_number", "court_name", "record_type", "record_date"],
    "opendata_securities_owners": ["issuer_name", "issuer_edrpou", "owner_name", "share_percent", "report_date"],
    "opendata_vat_payers": ["name", "kod_pdv", "dat_reestr"],
    "opendata_declaration_checks": ["family_name", "name", "additional_name", "position", "reporting_period", "status", "result"],
    "opendata_large_taxpayers": ["edrpou", "name"],
    "opendata_wage_debtors": ["region", "company_name", "ownership_form", "economic_activity", "debt_reason"],
    "opendata_public_organizations": ["name", "edrpou", "registry_type", "state", "address"],
    "opendata_judge_candidates": ["full_name", "gender", "total_score", "test_score", "practical_score", "approval_date"],
    "opendata_terrorism_orgs": ["name_ua", "name_en", "org_country", "report_date", "report_num"],
    "opendata_terrorism_persons": ["name_ua", "name_en", "doc_type", "sanctions_type"],
    # OpenReyestr
    "notaries": ["full_name", "certificate_number", "region", "organization", "status"],
    "court_experts": ["full_name", "region", "organization", "status"],
    "arbitration_managers": ["full_name", "registration_number", "certificate_number", "certificate_status"],
    "enforcement_proceedings": ["proceeding_number", "opening_date", "debtor_name", "debtor_edrpou", "creditor_name", "enforcement_agency", "proceeding_status"],
    "debtors": ["proceeding_number", "debtor_name", "debtor_edrpou", "collection_category", "executor_name"],
    "legal_entities": ["name", "edrpou", "short_name", "stan"],
    "individual_entrepreneurs": ["name", "stan"],
    "founders": ["entity_type", "entity_record", "founder_info"],
    "signers": ["entity_type", "entity_record", "signer_info"],
    "beneficiaries": ["entity_type", "entity_record", "beneficiary_info"],
    "special_forms": ["series", "form_number", "recipient", "document_type", "usage_date"],
    "streets": ["street_name", "full_address", "region", "settlement"],
    "administrative_units": ["full_name", "region", "district", "settlement_name"],
    "legal_acts": ["act_id", "publisher", "act_type", "act_number", "act_date", "act_title", "status"],
    "bankruptcy_cases": ["registration_number", "debtor_name", "debtor_edrpou", "case_number", "court_name", "proceeding_status"],
    "forensic_methods": ["registration_code", "method_name", "expertise_type", "developer", "status"],
    "public_associations": ["name", "edrpou", "type_subject", "stan"],
    "arma_assets": ["case_number", "case_date", "court_name", "asset_type", "asset_description", "owner_name", "status"],
    "nazk_declarations": ["declarant_name", "declaration_type", "declaration_year", "declarant_position", "declarant_workplace"],
    "tax_debt": ["name", "tin", "tax_office_name", "tax_name", "report_date"],
    "esv_debt": ["name", "tin", "tax_office", "debt_amount"],
    "vat_payers": ["name", "vat_code", "registration_date", "termination_date"],
    "single_tax_payers": ["name", "tin", "tax_group", "start_date", "rate"],
    "inspection_plans": ["business_name", "supervision_area", "start_date", "duration_days", "supervisory_body", "plan_year"],
    "dssu_financial_reports": ["firm_name", "firm_edrpou", "firm_kved_name", "report_year", "report_period", "form_code"],
    "street_renamings": ["current_name_uk", "old_names", "rename_count", "data_source"],
    "prozorro_tenders": ["tender_id", "title", "buyer_name", "buyer_edrpou", "amount", "status", "procurement_method_type"],
    "exchange_data": ["entity_type", "entity_record", "tax_payer_type", "start_date", "start_num"],
    "members": ["entity_record", "member_info"],
    "predecessors": ["entity_record", "predecessor_name", "predecessor_code"],
    "assignees": ["entity_record", "assignee_name", "assignee_code"],
    "termination_started": ["entity_record", "op_date", "reason", "sbj_state", "signer_name"],
    "executive_power": ["entity_record", "name", "code"],
    "bankruptcy_info": ["entity_record", "op_date", "reason", "sbj_state", "head_name"],
}


def _db_key_for(table: str) -> str:
    if table in RADA_TABLES:
        return "rada"
    if table in OPENREYESTR_TABLES:
        return "openreyestr"
    return "secondlayer"


def fetch_row_count(table: str) -> int:
    db_key = _db_key_for(table)
    try:
        conn = _get_conn(db_key)
        cur = conn.cursor()
        cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = %s", (table,))
        row = cur.fetchone()
        return int(row[0]) if row else 0
    except Exception:
        return 0


def fetch_records(table: str, limit: int = 1, offset: int = 0) -> list[dict]:
    db_key = _db_key_for(table)
    cols = PREVIEW_COLUMNS.get(table)
    if not cols:
        try:
            conn = _get_conn(db_key)
            cur = conn.cursor()
            schema = DATABASES[db_key]["schema"]
            cur.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = %s AND table_schema = %s ORDER BY ordinal_position LIMIT 8",
                (table, schema))
            cols = [r[0] for r in cur.fetchall()]
        except Exception:
            return []
    if not cols:
        return []

    col_list = ", ".join(cols)
    try:
        conn = _get_conn(db_key)
        cur = conn.cursor()
        cur.execute(f"SELECT row_to_json(t) FROM (SELECT {col_list} FROM {table} LIMIT %s OFFSET %s) t", (limit, offset))
        return [row[0] for row in cur.fetchall()]
    except Exception:
        return []


def format_record(record: dict, width: int = 80) -> list[str]:
    """Format a single record as key-value lines for display."""
    lines = []
    for key, value in record.items():
        val_str = str(value) if value is not None else "—"
        label = key.replace("_", " ").title()
        # Wrap long values
        if len(val_str) > width - len(label) - 4:
            wrapped = textwrap.wrap(val_str, width=width - 4)
            lines.append(f"  {label}: {wrapped[0] if wrapped else '—'}")
            for w in wrapped[1:]:
                lines.append(f"    {w}")
        else:
            lines.append(f"  {label}: {val_str}")
    return lines


# ── Curses UI ──

BATCH_SIZE = 20
PREFETCH_TRIGGER = 15  # start loading next batch when reaching this index within current batch


class DataBrowser:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.tables = sorted(
            [t for t in UPDATE_FREQ_DAYS.keys() if t in TABLE_NAMES_UK],
            key=lambda t: TABLE_NAMES_UK.get(t, t)
        )
        self.cursor = 0
        self.scroll_offset = 0
        self.mode = "list"  # list | detail
        self.current_table = ""
        self.record_idx = 0
        self.record_total = 0
        self.detail_lines = []
        self.detail_scroll = 0
        self.status_msg = ""

        # Batch cache: {global_index: record_dict}
        self._cache: dict[int, dict] = {}
        self._cache_start = 0  # first loaded index
        self._cache_end = 0    # last loaded index + 1
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: threading.Thread | None = None

        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_BLACK, curses.COLOR_CYAN)   # selected
        curses.init_pair(2, curses.COLOR_CYAN, -1)                   # header
        curses.init_pair(3, curses.COLOR_YELLOW, -1)                 # status
        curses.init_pair(4, curses.COLOR_GREEN, -1)                  # key
        curses.init_pair(5, curses.COLOR_WHITE, -1)                  # value

    def run(self):
        while True:
            if self.mode == "list":
                self.draw_list()
            elif self.mode == "detail":
                self.draw_detail()

            key = self.stdscr.getch()

            if key == ord("q"):
                break
            elif key == 27:  # Escape
                if self.mode == "detail":
                    self.mode = "list"
                else:
                    break
            elif self.mode == "list":
                self.handle_list_key(key)
            elif self.mode == "detail":
                self.handle_detail_key(key)

    def draw_list(self):
        self.stdscr.clear()
        h, w = self.stdscr.getmaxyx()

        # Header
        title = " Відкриті дані — Браузер реєстрів "
        self.stdscr.attron(curses.color_pair(2) | curses.A_BOLD)
        self.stdscr.addnstr(0, 0, f"{'═' * w}", w - 1)
        self.stdscr.addnstr(1, max(0, (w - len(title)) // 2), title, w - 1)
        self.stdscr.addnstr(2, 0, f"{'═' * w}", w - 1)
        self.stdscr.attroff(curses.color_pair(2) | curses.A_BOLD)

        # Help line
        help_text = " ↑↓ вибір  Enter відкрити  q вихід"
        self.stdscr.attron(curses.color_pair(3))
        self.stdscr.addnstr(3, 0, help_text, w - 1)
        self.stdscr.attroff(curses.color_pair(3))

        # Table list
        list_start = 5
        visible = h - list_start - 2

        # Adjust scroll
        if self.cursor < self.scroll_offset:
            self.scroll_offset = self.cursor
        if self.cursor >= self.scroll_offset + visible:
            self.scroll_offset = self.cursor - visible + 1

        for i in range(visible):
            idx = self.scroll_offset + i
            if idx >= len(self.tables):
                break
            table = self.tables[idx]
            name = TABLE_NAMES_UK.get(table, table)
            line = f"  {idx + 1:>3}. {name}"

            y = list_start + i
            if y >= h - 1:
                break

            if idx == self.cursor:
                self.stdscr.attron(curses.color_pair(1) | curses.A_BOLD)
                self.stdscr.addnstr(y, 0, line.ljust(w - 1), w - 1)
                self.stdscr.attroff(curses.color_pair(1) | curses.A_BOLD)
            else:
                self.stdscr.addnstr(y, 0, line, w - 1)

        # Status bar
        if self.status_msg:
            self.stdscr.attron(curses.color_pair(3))
            self.stdscr.addnstr(h - 1, 0, f" {self.status_msg}".ljust(w - 1), w - 1)
            self.stdscr.attroff(curses.color_pair(3))

        self.stdscr.refresh()

    def handle_list_key(self, key):
        if key == curses.KEY_UP:
            self.cursor = max(0, self.cursor - 1)
        elif key == curses.KEY_DOWN:
            self.cursor = min(len(self.tables) - 1, self.cursor + 1)
        elif key == curses.KEY_PPAGE:  # Page Up
            self.cursor = max(0, self.cursor - 20)
        elif key == curses.KEY_NPAGE:  # Page Down
            self.cursor = min(len(self.tables) - 1, self.cursor + 20)
        elif key in (curses.KEY_ENTER, 10, 13):
            self.open_table()

    def _load_batch(self, start: int, size: int = BATCH_SIZE) -> list[dict]:
        """Load a batch of records starting from `start`."""
        return fetch_records(self.current_table, limit=size, offset=start)

    def _prefetch_next(self):
        """Background prefetch: load next batch into cache."""
        start = self._cache_end
        if start >= self.record_total:
            return
        records = self._load_batch(start)
        with self._prefetch_lock:
            for i, rec in enumerate(records):
                self._cache[start + i] = rec
            self._cache_end = start + len(records)

    def _maybe_prefetch(self):
        """Trigger async prefetch when approaching cache boundary."""
        idx_in_batch = self.record_idx - self._cache_start
        remaining_in_cache = self._cache_end - self.record_idx - 1
        if remaining_in_cache <= (BATCH_SIZE - PREFETCH_TRIGGER) and self._cache_end < self.record_total:
            if self._prefetch_thread is None or not self._prefetch_thread.is_alive():
                self._prefetch_thread = threading.Thread(target=self._prefetch_next, daemon=True)
                self._prefetch_thread.start()

    def open_table(self):
        table = self.tables[self.cursor]
        self.current_table = table
        self.record_idx = 0
        self.detail_scroll = 0
        self._cache.clear()
        self._cache_start = 0
        self._cache_end = 0
        self.status_msg = f"Завантаження {TABLE_NAMES_UK.get(table, table)}..."
        self.draw_list()

        self.record_total = fetch_row_count(table)
        records = self._load_batch(0)

        if records:
            with self._prefetch_lock:
                for i, rec in enumerate(records):
                    self._cache[i] = rec
                self._cache_end = len(records)
            h, w = self.stdscr.getmaxyx()
            self.detail_lines = format_record(records[0], width=w - 4)
            self.mode = "detail"
            cached = len(self._cache)
            self.status_msg = f"Завантажено {cached} записів"
            self._maybe_prefetch()
        else:
            self.status_msg = "Порожній реєстр або помилка з'єднання"

    def _show_record(self, idx: int):
        """Display record from cache, or fetch if missing."""
        rec = self._cache.get(idx)
        if rec is None:
            self.status_msg = f"Завантаження запису {idx + 1}..."
            self.draw_detail()
            records = self._load_batch(idx, size=BATCH_SIZE)
            if records:
                with self._prefetch_lock:
                    for i, r in enumerate(records):
                        self._cache[idx + i] = r
                    self._cache_start = min(self._cache_start, idx)
                    self._cache_end = max(self._cache_end, idx + len(records))
                rec = records[0]
            else:
                self.status_msg = "Не вдалося завантажити запис"
                return

        self.record_idx = idx
        self.detail_scroll = 0
        h, w = self.stdscr.getmaxyx()
        self.detail_lines = format_record(rec, width=w - 4)
        cached = len(self._cache)
        self.status_msg = f"[кеш: {cached}]"
        self._maybe_prefetch()

    def draw_detail(self):
        self.stdscr.clear()
        h, w = self.stdscr.getmaxyx()

        name = TABLE_NAMES_UK.get(self.current_table, self.current_table)
        total_str = f"{self.record_total:,}".replace(",", " ") if self.record_total > 0 else "?"

        # Header
        self.stdscr.attron(curses.color_pair(2) | curses.A_BOLD)
        header = f" {name}  —  запис {self.record_idx + 1} з {total_str} "
        self.stdscr.addnstr(0, 0, f"{'═' * w}", w - 1)
        self.stdscr.addnstr(1, max(0, (w - len(header)) // 2), header, w - 1)
        self.stdscr.addnstr(2, 0, f"{'═' * w}", w - 1)
        self.stdscr.attroff(curses.color_pair(2) | curses.A_BOLD)

        # Help
        help_text = " ←→ документи  Shift+←→ ×100  ↑↓ скрол  Esc назад  q вихід"
        self.stdscr.attron(curses.color_pair(3))
        self.stdscr.addnstr(3, 0, help_text, w - 1)
        self.stdscr.attroff(curses.color_pair(3))

        # Record content
        content_start = 5
        visible = h - content_start - 2

        for i in range(visible):
            line_idx = self.detail_scroll + i
            if line_idx >= len(self.detail_lines):
                break

            y = content_start + i
            if y >= h - 1:
                break

            line = self.detail_lines[line_idx]

            # Color key: value
            colon_pos = line.find(":")
            if colon_pos > 0 and line.lstrip().find(":") == colon_pos - len(line) + len(line.lstrip()):
                # Key part
                self.stdscr.attron(curses.color_pair(4) | curses.A_BOLD)
                self.stdscr.addnstr(y, 0, line[:colon_pos + 1], min(colon_pos + 1, w - 1))
                self.stdscr.attroff(curses.color_pair(4) | curses.A_BOLD)
                # Value part
                if colon_pos + 1 < len(line):
                    self.stdscr.addnstr(y, colon_pos + 1, line[colon_pos + 1:], max(0, w - colon_pos - 2))
            else:
                self.stdscr.addnstr(y, 0, line, w - 1)

        # Scroll indicator
        if len(self.detail_lines) > visible:
            pct = int((self.detail_scroll / max(1, len(self.detail_lines) - visible)) * 100)
            scroll_info = f" [{pct}%] ↕ {len(self.detail_lines)} рядків"
            self.stdscr.attron(curses.color_pair(3))
            self.stdscr.addnstr(h - 1, w - len(scroll_info) - 1, scroll_info, len(scroll_info))
            self.stdscr.attroff(curses.color_pair(3))

        # Status bar
        if self.status_msg:
            self.stdscr.attron(curses.color_pair(3))
            self.stdscr.addnstr(h - 1, 0, f" {self.status_msg}", min(len(self.status_msg) + 1, w - 1))
            self.stdscr.attroff(curses.color_pair(3))

        self.stdscr.refresh()

    def handle_detail_key(self, key):
        h, _ = self.stdscr.getmaxyx()
        visible = h - 7

        if key == curses.KEY_DOWN:
            max_scroll = max(0, len(self.detail_lines) - visible)
            self.detail_scroll = min(max_scroll, self.detail_scroll + 1)
        elif key == curses.KEY_UP:
            self.detail_scroll = max(0, self.detail_scroll - 1)
        elif key == curses.KEY_NPAGE:
            max_scroll = max(0, len(self.detail_lines) - visible)
            self.detail_scroll = min(max_scroll, self.detail_scroll + visible)
        elif key == curses.KEY_PPAGE:
            self.detail_scroll = max(0, self.detail_scroll - visible)
        elif key == curses.KEY_RIGHT:
            # Next record
            if self.record_idx < self.record_total - 1:
                self._show_record(self.record_idx + 1)
        elif key == curses.KEY_SRIGHT or key == 561:
            # Shift+Right: jump 100 records forward
            new_idx = min(self.record_total - 1, self.record_idx + 100)
            if new_idx != self.record_idx:
                self._show_record(new_idx)
        elif key == curses.KEY_LEFT:
            # Previous record
            if self.record_idx > 0:
                self._show_record(self.record_idx - 1)
        elif key == curses.KEY_SLEFT or key == 560:
            # Shift+Left: jump 100 records back
            new_idx = max(0, self.record_idx - 100)
            if new_idx != self.record_idx:
                self._show_record(new_idx)


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("--help", "-h"):
        print(__doc__)
        sys.exit(0)

    curses.wrapper(lambda stdscr: DataBrowser(stdscr).run())


if __name__ == "__main__":
    main()
