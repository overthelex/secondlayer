#!/usr/bin/env python3
"""Tests for load_fgvfo.py on synthetic fixtures (no network).

The XLSX fixtures are built here with the cell layout of the fg.gov.ua files as published in
November 2026 (debtors list «станом на 01.10.2026», related-persons file «станом на 01.07.2026»);
every name, case number and amount in them is invented.

Run:  python3 -I scripts/fgvfo/test_load_fgvfo.py
With FGVFO_TEST_DATABASE_URL=postgresql://… (an empty scratch database) the load and the
small-snapshot guard are also run against PostgreSQL, after applying migration 285.
"""
import io
import os
import subprocess
import sys
import unittest
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import load_fgvfo as L  # noqa: E402

MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations", "285_fgvfo_debtors.sql")


def make_xlsx(rows: list[list]) -> bytes:
    """Minimal XLSX: strings go to sharedStrings, numbers stay numeric cells."""
    shared: list[str] = []
    sheet_rows = []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row):
            if v is None:
                continue
            ref = f"{chr(ord('A') + c)}{r}"
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                shared.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>')
        sheet_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns}><sheets><sheet name="Аркуш1" sheetId="1"/></sheets></workbook>')
        z.writestr("xl/sharedStrings.xml",
                   f'<sst {ns}>' + "".join(f"<si><t>{escape(s)}</t></si>" for s in shared) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>')
    return buf.getvalue()


DEBTORS_TITLE = ('СПИСОК список усіх позичальників, які не є керівниками та колишніми акціонерами АТ «ТЕСТ БАНК», '
                 'які ще мають повернути свої борги згідно з рішеннями суду\n станом на 01.10.2026 року\n'
                 'Цей Список складений відповідно до та з дотриманням положень статті 6 Закону України')
DEBTORS_XLSX = make_xlsx([
    [None, None, None, None, None],
    [DEBTORS_TITLE],
    [],
    ["№", "Єдиний унікальний номер судової справи, у якій постановлено рішення суду",
     "Найменування юридичної особи або прізвище, ім’я, по батькові фізичної особи",
     "Сума боргу перед банком у розмірі та валюті", "Сума боргу перед банком (гривень)"],
    ["1", "910/1111/16", 'ТОВ «ВИГАДАНА ФІРМА» код 1234567', "1 000 000,00 дол. США", 41000000.5],
    ["2", "2-111/2010", "Тестенко Олена Іванівна, 01.01.1970 р.н., РНОКПП 1234567890", "12 345,67 грн", "12 345,67 грн."],
    ["3", "761/2222/20", "Вигаданко О.І., Прикладенко П.П. (солідарний боржник)", "500 грн", "439 997, 12"],
    ["4.", "520/3333/19", "ФОП Зразковий Іван Петрович", None, 219],
    ["5", "910/4444/21", "Прикладна Ганна Олегівна та Прикладний Олег Іванович", None, "1000"],
    ["6", "910/5555/21", "ФРАНКЛІН ЛІМІТЕД", None, "10"],
    [],
    ["Викладена інформація є підтвердженою матеріалами"],
    ["Уповноважена особа Фонду гарантування вкладів", None, None, None, "Іван ВИГАДАНИЙ"],
])

RELATED_XLSX = make_xlsx([
    ["Інформація про колишніх власників неплатоспроможних банків, пов’язаних із такими банками осіб, \n"
     "станом на 01.07.2026"],
    ["Найменування банку, що ліквідується або був ліквідований Фондом", "№ судової справи", "Тип провадження",
     "Сума заявлених Фондом позовних вимог, грн", "Кількість відповідачів, осіб", "Рішення суду про стягнення збитків"],
    [None, None, None, None, None, "ПІБ відповідачів", "Сума"],
    ["АТ «ТЕСТ БАНК»", "910/7777/21", "Господарське", 15938891.02, 3,
     "Вигаданко\xa0 Петро Іванович\nПрикладенко  Ольга Петрівна\nЗразковий Іван Іванович", "15 938 891,02 грн"],
    ["АТ «ТЕСТ БАНК»", "761/8888/24", "Цивільне в кримінальному провадженні ", 112498799.29, 6, "", ""],
    ["АТ «ІНШИЙ БАНК»", "761/9999/20", "Цивільне на підставі вироку", "2517699717.98", "1",
     "Тестовий Тарас Тарасович", "26 502 632,50 дол. США, \nщо в еквіваленті становить 650 295 093,65 грн"],
])

DEBTORS_PAGE = """
<table><thead><tr><td>Банк</td><td>Список позичальників, які не є керівниками</td>
<td>Список позичальників, які є керівниками</td></tr></thead><tbody>
<tr><td>
   АТ «ТЕСТ БАНК»
</td><td><a href="https://www.fg.gov.ua/storage/files/test-bank-dodatok-24-01-10-2026.xlsx">Завантажити </a></td>
<td>Відсутні</td></tr>
<tr><td>ПАТ &laquo;ІНШИЙ БАНК&raquo;</td><td><a href="/storage/files/inshyi-dodatok-24-01-10-2026.xlsx">Завантажити</a></td>
<td><a href="/storage/files/inshyi-kerivnyky-01-10-2026.xlsx">Завантажити</a></td></tr>
</tbody></table>"""

RELATED_PAGE = """
<a href="/storage/files/inform-kolishn-vlasn-pov-osib-ta-sumi-vidshkod-01-07-2026.xlsx">Скачати</a>
<a href="/storage/files/inform-kolishn-vlasn-pov-osib-ta-sumi-vidshkod-01_1759490514.xlsx">Скачати</a>
<a href="/storage/files/inform-kolishn-vlasn-pov-osib-ta-sumi-vidshkod-01-07-2026.xlsx">Скачати</a>
<a href="/storage/files/informaciya-pro-kolishnih-vlasnikiv-kerivnikiv-ta-povyazanih.pdf">Скачати</a>"""

# [input, norm_ua, ua_match_key] — the golden cases of
# mcp_openreyestr/src/services/edr-history/__tests__/norm.test.ts (invented names).
GOLDEN = [
    ('ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "СКАРАМАНДЕР ЛІМІТЕД"', 'товариство з обмеженою відповідальністю скарамандер лімітед', 'skaramander'),
    ('Scaramander Limited', 'scaramander limited', 'skaramander'),
    ('БЕЛЛІНІ МАРКО', 'белліні марко', 'belini marko'),
    ('Marco Bellini', 'marco bellini', 'marko belini'),
    ("В'ЯЧЕСЛАВ Йосипович", 'вячеслав йосипович', 'viakeslav iosipovik'),
    ('ДЖОНАТАН ДЖОН', 'джонатан джон', 'dzhonatan dzhon'),
    ('Jonathan John', 'jonathan john', 'dzhonatan dzhon'),
    ('ТЕСТЕНКО ОЛЕНА ІВАНІВНА', 'тестенко олена іванівна', 'testenko olena ivanivna'),
    ('ЩУКА Ю. Ж.', 'щука ю ж', 'shkuka iu zh'),
    ('Ålborg Ærø Øresund GmbH & Co. KG', 'alborg r resund gmbh co kg', 'alborh resund'),
    ('Ёлкин Пётр Ильич', 'елкин петр ильич', 'elkin petr ilik'),
    ('ЖИТОМИРСЬКА ЄВРОПА-ҐРУНТ «ЇЖАК»', 'житомирська європа ґрунт їжак', 'zhitomirska ievropa hrunt izhak'),
    ('Müller-Lüdenscheidt Holding B.V.', 'muller ludenscheidt holding b v', 'muler ludensheidt holdinh'),
    ('КРАНМОР ХОЛДІНГС ЛІМІТЕД (KRANMOR HOLDINGS LIMITED)', 'кранмор холдінгс лімітед kranmor holdings limited', 'kranmor holdinhs'),
    ('Kranmor Holdings Ltd', 'kranmor holdings ltd', 'kranmor holdinhs'),
    ('Xavier Quentin Wright', 'xavier quentin wright', 'ksavier kuentin vriht'),
    ("КСАВ'ЄР КВЕНТІН РАЙТ", 'ксавєр квентін райт', 'ksavier kventin rait'),
    ('Thomas Schmidt', 'thomas schmidt', 'tomas shmidt'),
    ('ТОМАС ШМІДТ', 'томас шмідт', 'tomas shmidt'),
    ('Philippe Chatelain', 'philippe chatelain', 'filipe katelain'),
    ('ФІЛІП ШАТЛЕН', 'філіп шатлен', 'filip shatlen'),
    ('Ahmed Al-Hajj', 'ahmed al hajj', 'amed al hadzhdzh'),
    ('АХМЕД АЛЬ-ХАДЖ', 'ахмед аль хадж', 'amed al hadzh'),
    ('', '', ''),
    ('   ', '', ''),
    ('12345678', '12345678', '12345678'),
    ('ТОВ ПП АТ', 'тов пп ат', ''),
    ('A B C', 'a b c', ''),
    ('Ńeść Żółw', 'nesc zo w', 'nesk'),
    ('İstanbul Şirketi', 'istanbul sirketi', 'istanbul sirketi'),
    ('ß straße', 'stra e', 'stra'),
    ('O’Brien ʼMcDonald‘s', 'obrien mcdonalds', 'obrien mkdonalds'),
    ('«Альфа»—Вест “Плюс” „Мінус“', 'альфа вест плюс мінус', 'alfa vest plius minus'),
    ('Hhh Ahh Ohh john', 'hhh ahh ohh john', 'ah oh dzhon'),
    ('ЯЮЄЇ щЩ ьЬъЪ ыэ', 'яюєї щщ ььъъ ыэ', 'iaiuiei shkshk ie'),
    ('Ⅻ ﬁnance ²', 'xii finance 2', 'ksi finanke'),
    ('Dzhon Dzhons', 'dzhon dzhons', 'dzhon dzhons'),
    ('Ivan Ivanenko Ivan', 'ivan ivanenko ivan', 'ivan ivanenko'),
]

URL = "https://www.fg.gov.ua/storage/files/test-bank-dodatok-24-01-10-2026.xlsx"


class NormTest(unittest.TestCase):
    def test_golden_matches_ts_port(self):
        for src, norm, key in GOLDEN:
            with self.subTest(src=src):
                self.assertEqual(L.norm_ua(src), norm)
                self.assertEqual(L.ua_match_key(src), key)


class HelpersTest(unittest.TestCase):
    def test_parse_amount(self):
        cases = {"1 234 567,89 грн.": 1234567.89, "891307403.87": 891307403.87, "439 997, 12": 439997.12,
                 "219,00": 219.0, "821284626.58000004": 821284626.58, "2.5E3": 2500.0, 41000000.5: 41000000.5,
                 "26\xa0502\xa0632,50 дол. США": 26502632.5, "": None, None: None, "немає": None}
        for src, want in cases.items():
            with self.subTest(src=src):
                self.assertEqual(L.parse_amount(src), want)

    def test_kind(self):
        self.assertEqual(L.debtor_kind('ТОВ «ВИГАДАНА ФІРМА»'), "company")
        self.assertEqual(L.debtor_kind("Державна іпотечна установа"), "company")
        self.assertEqual(L.debtor_kind("ФРАНКЛІН ЛІМІТЕД"), "company")
        self.assertEqual(L.debtor_kind("ФОП Зразковий Іван Петрович"), "fop")
        self.assertEqual(L.debtor_kind("Фізична особа- підприємець Зразковий І.П."), "fop")
        self.assertEqual(L.debtor_kind("Тестенко Олена Іванівна"), "person")
        self.assertEqual(L.debtor_kind("Кодак Атанас Банкович"), "person")

    def test_person_name_drops_ids_and_birth_dates(self):
        self.assertEqual(L.person_name("Тестенко Олена Іванівна, 01.01.1970 р.н., РНОКПП 1234567890"),
                         "Тестенко Олена Іванівна")
        self.assertEqual(L.person_name("Тестенко Олена Іванівна (ІПН 1234567890)"), "Тестенко Олена Іванівна")
        self.assertEqual(L.person_name("ФОП Зразковий Іван Петрович"), "Зразковий Іван Петрович")
        self.assertEqual(L.person_name("СПД ФО Зразковий Іван Петрович"), "Зразковий Іван Петрович")
        self.assertEqual(L.person_name("Кодак Р.М."), "Кодак Р.М.")

    def test_split_person_cell(self):
        self.assertEqual(L.split_person_cell("Вигаданко О.І., Прикладенко П.П. (солідарний боржник)"),
                         [("Вигаданко О.І.", None), ("Прикладенко П.П.", "солідарний боржник")])
        self.assertEqual(L.split_person_cell("Прикладна Ганна Олегівна та Прикладний Олег Іванович"),
                         [("Прикладна Ганна Олегівна", None), ("Прикладний Олег Іванович", None)])
        self.assertEqual(L.split_person_cell("Прикладна (Вигадана) Ганна Олегівна"),
                         [("Прикладна (Вигадана) Ганна Олегівна", None)])

    def test_company_edrpou_zero_padded(self):
        self.assertEqual(L.company_edrpou("ТОВ «Х» код 1234567"), "01234567")
        self.assertEqual(L.company_edrpou('ДП "Х" (ДВЕК) код 33161769'), "33161769")
        self.assertEqual(L.company_edrpou('ТОВ «АТП 10911»'), None)


class ParseDebtorsTest(unittest.TestCase):
    def setUp(self):
        self.snap = L.parse_debtors(DEBTORS_XLSX, URL, "АТ «ТЕСТ БАНК»", "borrowers")
        L.check_snapshot(self.snap)
        self.by = {(r["row_no"], r["debtor_ord"]): r for r in self.snap.rows}

    def test_snapshot(self):
        s = self.snap
        self.assertEqual((s.dataset, s.list_key, s.bank_name, s.snapshot_date),
                         ("debtors", "test-bank:borrowers", "АТ «ТЕСТ БАНК»", "2026-10-01"))
        # 6 numbered rows, two cells with two joint debtors; signature lines are not rows
        self.assertEqual(len(s.rows), 8)
        self.assertEqual(s.skipped, 0)

    def test_company(self):
        r = self.by[(1, 1)]
        self.assertEqual((r["debtor_kind"], r["debtor_edrpou"], r["case_number"], r["debt_uah"]),
                         ("company", "01234567", "910/1111/16", 41000000.5))
        self.assertEqual(r["debt_text"], "1 000 000,00 дол. США")
        self.assertEqual(r["name_match_key"], L.ua_match_key('ТОВ «ВИГАДАНА ФІРМА» код 1234567'))

    def test_person_without_personal_ids(self):
        r = self.by[(2, 1)]
        self.assertEqual(r["debtor_name"], "Тестенко Олена Іванівна")
        self.assertEqual(r["name_match_key"], "testenko olena ivanivna")
        self.assertIsNone(r["debtor_edrpou"])
        self.assertEqual(r["debt_uah"], 12345.67)
        for row in self.snap.rows:
            if row["debtor_kind"] != "company":
                self.assertNotRegex(row["debtor_name"], r"\d")

    def test_joint_debtors(self):
        self.assertEqual(self.by[(3, 2)]["debtor_note"], "солідарний боржник")
        self.assertEqual(self.by[(3, 1)]["debt_uah"], self.by[(3, 2)]["debt_uah"])
        self.assertEqual(self.by[(5, 2)]["debtor_name"], "Прикладний Олег Іванович")

    def test_fop_and_row_number_with_dot(self):
        r = self.by[(4, 1)]
        self.assertEqual((r["debtor_kind"], r["debtor_name"], r["debt_uah"]), ("fop", "Зразковий Іван Петрович", 219.0))

    def test_title_fallbacks(self):
        s = L.parse_debtors(DEBTORS_XLSX, URL)
        self.assertEqual((s.bank_name, s.list_key), ("АТ «ТЕСТ БАНК»", "test-bank:borrowers"))

    def test_no_header_raises(self):
        with self.assertRaises(ValueError):
            L.parse_debtors(make_xlsx([["щось інше"]]), URL)


class ParseRelatedTest(unittest.TestCase):
    def setUp(self):
        self.snap = L.parse_related(RELATED_XLSX, "https://www.fg.gov.ua/storage/files/x.xlsx")
        L.check_snapshot(self.snap)

    def test_claims(self):
        s = self.snap
        self.assertEqual((s.snapshot_date, len(s.rows), len(s.defendants)), ("2026-07-01", 3, 4))
        c = s.rows[0]
        self.assertEqual((c["bank_name"], c["case_number"], c["claim_uah"], c["defendants_count"], c["awarded_uah"]),
                         ("АТ «ТЕСТ БАНК»", "910/7777/21", 15938891.02, 3, 15938891.02))
        self.assertEqual(s.rows[1]["proceeding_type"], "Цивільне в кримінальному провадженні")
        self.assertIsNone(s.rows[1]["awarded_uah"])
        self.assertEqual(s.rows[2]["defendants_count"], 1)
        self.assertIn("дол. США", s.rows[2]["awarded_text"])

    def test_defendants(self):
        d = self.snap.defendants
        self.assertEqual([x["defendant_name"] for x in d[:3]],
                         ["Вигаданко Петро Іванович", "Прикладенко Ольга Петрівна", "Зразковий Іван Іванович"])
        self.assertEqual({x["claim_row_no"] for x in d}, {1, 3})
        self.assertEqual(d[0]["name_match_key"], L.ua_match_key("Вигаданко Петро Іванович"))


class DiscoveryTest(unittest.TestCase):
    def test_debtor_files(self):
        refs = L.debtor_files(DEBTORS_PAGE)
        self.assertEqual([(r.bank_name, r.list_kind, r.url) for r in refs], [
            ("АТ «ТЕСТ БАНК»", "borrowers", "https://www.fg.gov.ua/storage/files/test-bank-dodatok-24-01-10-2026.xlsx"),
            ("ПАТ «ІНШИЙ БАНК»", "borrowers", "https://www.fg.gov.ua/storage/files/inshyi-dodatok-24-01-10-2026.xlsx"),
            ("ПАТ «ІНШИЙ БАНК»", "insiders", "https://www.fg.gov.ua/storage/files/inshyi-kerivnyky-01-10-2026.xlsx"),
        ])

    def test_related_files_newest_first_dedup_xlsx_only(self):
        self.assertEqual([os.path.basename(r.url) for r in L.related_files(RELATED_PAGE)], [
            "inform-kolishn-vlasn-pov-osib-ta-sumi-vidshkod-01-07-2026.xlsx",
            "inform-kolishn-vlasn-pov-osib-ta-sumi-vidshkod-01_1759490514.xlsx",
        ])


class SqlTest(unittest.TestCase):
    def test_empty_snapshot_rejected(self):
        with self.assertRaises(RuntimeError):
            L.check_snapshot(L.Snapshot("debtors", "x:borrowers", None, "2026-10-01"))

    def test_load_sql_is_one_transaction_with_guard(self):
        snap = L.parse_debtors(DEBTORS_XLSX, URL, "АТ «ТЕСТ БАНК»", "borrowers")
        sql = L.load_sql(snap, URL, "ab" * 32, 123)
        self.assertTrue(sql.lstrip().startswith("BEGIN;"))
        self.assertTrue(sql.rstrip().endswith("COMMIT;"))
        self.assertIn("RAISE EXCEPTION", sql)
        self.assertIn("COPY fg_stage", sql)


@unittest.skipUnless(os.environ.get("FGVFO_TEST_DATABASE_URL"), "FGVFO_TEST_DATABASE_URL not set")
class DatabaseTest(unittest.TestCase):
    """Runs against an empty scratch database: applies migration 285 and loads the fixtures."""

    @classmethod
    def setUpClass(cls):
        os.environ["DATABASE_URL"] = os.environ["FGVFO_TEST_DATABASE_URL"]
        L.psql("DROP TABLE IF EXISTS fgvfo_related_defendants, fgvfo_related_claims, fgvfo_debtors, "
               "fgvfo_snapshots CASCADE;")
        with open(MIGRATION, encoding="utf-8") as f:
            sql = f.read()
        L.psql(sql)
        L.psql(sql)   # idempotent

    def test_load_skip_and_guard(self):
        ref = L.FileRef(URL, "АТ «ТЕСТ БАНК»", "borrowers")
        L.run_file("debtors", ref, DEBTORS_XLSX, dry_run=False, force=False)
        L.run_file("debtors", ref, DEBTORS_XLSX, dry_run=False, force=False)   # same sha: skipped
        self.assertEqual(L.psql("SELECT count(*) FROM fgvfo_snapshots;").strip(), "1")
        self.assertEqual(L.psql("SELECT count(*) FROM fgvfo_debtors_current;").strip(), "8")
        self.assertEqual(L.psql("SELECT count(DISTINCT row_no) FROM fgvfo_debtors;").strip(), "6")

        rel = L.FileRef("https://www.fg.gov.ua/storage/files/r.xlsx")
        L.run_file("related", rel, RELATED_XLSX, dry_run=False, force=False)
        self.assertEqual(L.psql("SELECT count(*), count(defendant_name) FROM fgvfo_related_current;").strip(), "5|4")

        # a later snapshot with far fewer rows than the previous one is refused (guard threshold lowered)
        old = L.GUARD_MIN_ROWS
        L.GUARD_MIN_ROWS = 5
        try:
            small = make_xlsx([[DEBTORS_TITLE.replace("01.10.2026", "01.01.2027")],
                               ["№", "номер судової справи", "Найменування", "Сума", "Сума"],
                               ["1", "910/1/27", "Тестенко Олена Іванівна", None, 1]])
            with self.assertRaises(RuntimeError):
                L.run_file("debtors", ref, small, dry_run=False, force=False)
        finally:
            L.GUARD_MIN_ROWS = old
        self.assertEqual(L.psql("SELECT count(*) FROM fgvfo_snapshots WHERE dataset = 'debtors';").strip(), "1")


if __name__ == "__main__":
    unittest.main(verbosity=1)
