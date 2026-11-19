#!/usr/bin/env python3
"""Parser tests for load_nbu_fin.py on small synthetic fixtures (no network, no database).

The xlsx fixtures copy the sheet and header layout of the NBU files as published in November 2026
(ree_fu.xlsx, pv_pohodjen.xlsx, pv_bpg.xlsx, subpar.xlsx) and the HTML of the bank
ownership-structure pages; names and codes in them are invented.

Run:  python3 -I scripts/nbu-fin/test_load_nbu_fin.py
"""
import io
import os
import sys
import tempfile
import unittest
import zipfile
from xml.sax.saxutils import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_nbu_fin as L  # noqa: E402


def col_ref(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def make_xlsx(sheets: dict[str, list[list]]) -> bytes:
    """Minimal workbook: numbers as <v>, strings in sharedStrings (like Excel writes them)."""
    shared: list[str] = []
    buf = io.BytesIO()
    z = zipfile.ZipFile(buf, "w")
    sheet_xml = []
    for rows in sheets.values():
        out = []
        for ri, row in enumerate(rows, 1):
            cells = []
            for ci, v in enumerate(row):
                if v is None or v == "":
                    continue
                ref = f"{col_ref(ci)}{ri}"
                if isinstance(v, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{v}</v></c>')
                else:
                    shared.append(str(v))
                    cells.append(f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>')
            out.append(f'<row r="{ri}">{"".join(cells)}</row>')
        sheet_xml.append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                         f'<sheetData>{"".join(out)}</sheetData></worksheet>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    z.writestr("xl/workbook.xml", f'<workbook {ns} {rns}><sheets>' + "".join(
        f'<sheet name="{escape(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(sheets, 1))
        + "</sheets></workbook>")
    z.writestr("xl/_rels/workbook.xml.rels",
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
                   f'<Relationship Id="rId{i}" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
               + "</Relationships>")
    for i, x in enumerate(sheet_xml, 1):
        z.writestr(f"xl/worksheets/sheet{i}.xml", x)
    z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(
        f"<si><t>{escape(s)}</t></si>" for s in shared) + "</sst>")
    z.close()
    return buf.getvalue()


REE_FU = make_xlsx({
    "ree_fu": [
        ["Станом на 16.11.2026"],
        ["Інформація з Державного реєстру фінансових установ та реєстру осіб, які не є фінансовими установами"],
        ["№ з/п", "Найменування реєстру", "Тип надавача фінансових послуг", "Повне найменування", "Код за ЄДРПОУ",
         "Повна адреса", "ПІБ керівника", "Дата внесення до відповідного реєстру"],
        [1, "Державний реєстр фінансових установ", "Фінансова компанія", "ТОВ «ФК ТЕСТ»", "45000001",
         "01001 КИЇВ, вул. Тестова, 1", "Тестенко Тест  Тестович", 46336],
        [2, "Державний реєстр фінансових установ", "Ломбард", "ПТ «ЛОМБАРД ПРИКЛАД»", "123456",
         "61000 ХАРКІВ", "Прикладенко П. П.", "01.02.2021"],
        [3, "Реєстр осіб, які не є фінансовими установами, але мають право надавати окремі фінансові послуги",
         "Лізингодавець", "ТОВ «ФК ТЕСТ»", "45000001", "01001 КИЇВ", "", 45000],
        [4, "", "", "", "", "", "", ""],
    ],
    "lic": [
        ["Станом на 16.11.2026"],
        [],
        ["№ з/п", "Тип надавача фінансових послуг", "Повне найменування", "Код за ЄДРПОУ", "Статус ліцензії",
         "Назва ліцензії", "Назва послуги/клас страхування/ризик страхування", "Тип страхування",
         "Дата видачі ліцензії\n(за наявності)", "Дата початку дії послуги/ризику страхування", "Строк дії ліцензії"],
        [1, "Фінансова компанія", "ТОВ «ФК ТЕСТ»", "45000001", "Діюча", "ЛІЦЕНЗІЯ НА ДІЯЛЬНІСТЬ ФІНАНСОВОЇ КОМПАНІЇ",
         "ФАКТОРИНГ", "-", 45470, 46315, "необмежений"],
        [2, "Ломбард", "ПТ «ЛОМБАРД ПРИКЛАД»", "123456", "Зупинення дії", "ЛІЦЕНЗІЯ НА ДІЯЛЬНІСТЬ ЛОМБАРДУ",
         "НАДАННЯ КОШТІВ У КРЕДИТ", "-", "", 45000, "необмежений"],
    ],
})

PV_POHODJEN = make_xlsx({"pv_pohodjen": [
    ["Дата останніх змін 07.07.2025"],
    ["Інформація з переліку осіб, які отримали погодження Національного банку України на набуття (збільшення) "
     "істотної участі у небанківських фінансових установах"],
    ["№ з/п", "ПІБ фізичної особи або повне найменування юридичної особи, якій погоджено набуття істотної участі",
     "Повне найменування небанківської фінансової установи", "Код ЄДРПОУ небанківської фінансової установи",
     "Набуття / збільшення істотної участі", "Заявлена участь в небанківській \nфінансовій установі, %", "", "",
     "Дата прийняття рішення про погодження істотної участі", "Номер рішення про погодження", "Примітки"],
    ["", "", "", "", "", "Пряма", "Опосередкована", "Сукупна"],
    [1, "ТЕСТ Ферзіхерунген АГ", "ПрАТ «СК «ПРИКЛАД»", "20000001", "Набуття істотної участі", "92,230511 ", "-",
     "92,230511 ", 44106, "21/1468-пк"],
    [2, "Іваненко Іван Іванович", "ПрАТ «СК «ПРИКЛАД»", "20000001", "Збільшення істотної участі", "-",
     "4.7796000000000003", "4.7796000000000003", 46328, "21/885-рк", "через ТОВ «ХОЛДИНГ»"],
    [3, "Петренко Петро Петрович спільно з Петренко Оксаною Петрівною", "ТДВ «СК «ДРУГА»", "1234567",
     "Набуття істотної участі", "19.4103", "-", "19.4103", 44452, "21/2625-пк"],
    [],
]})

PV_BPG = make_xlsx({"pv_bpg": [
    ["Дата останніх змін 18.12.2023"],
    ["Інформація з переліку власників істотної участі, які не мають права користуватися правом голосу"],
    ["№ з/п", "ПІБ фізичної особи або повне найменування юридичної особи",
     "Повне найменування небанківської фінансової установи", "Код ЄДРПОУ небанківської фінансової установи",
     "Участь особи в небанківській \nфінансовій установі, %\nна дату внесення до цього переліку", "", "",
     "Опис взаємозв'язку особи з небанківською фінансовою установою",
     "Підстава для заборони користуватися правом голосу та брати участь в управлінні",
     "ПІБ довіреної особи", "Дата призначення довіреної особи"],
    ["", "", "", "", "Пряма", "Опосередкована", "Сукупна"],
    [1, "Семенко Семен Семенович", "ТДВ «СК «ТРЕТЯ»", "30000003", "-", "98", "98",
     "опосередкований (через ТОВ «ГЛОБ») власник істотної участі", "набуття без погодження",
     "Довіренко Микола Олександрович", 45201],
]})

SUBPAR = make_xlsx({"subpar": [
    ["", "", " Інформація про прийняті рішення щодо істотної участі в банках"],
    [],
    [],
    ["№", "Найменування банку", "Найменування/ПІБ особи",
     "Інформація щодо наміру набуття істотної участі або набутої істотної участі", "Прийняте рішення",
     "Набуття / Збільшення", "Тип заявленої участі", "Відсоток заявленої участі, (%)", "Дата прийняття рішення",
     "Дата публікації"],
    [1, "АКЦІОНЕРНЕ ТОВАРИСТВО “ТЕСТ БАНК”", "Суботенко Віктор Георгійович, \nСуботенко Олена Олексіївна",
     "Щодо спільного набуття", "Заборонено", "Набуття",
     "Спільне пряме та опосередковане володіння істотною участю в банку", "98,263536", 44476, 44477],
    [2, "АКЦІОНЕРНЕ ТОВАРИСТВО \"ТЕСТ БАНК\"",
     "“НП ТЕСТ ЛІМІТЕД” (NP TEST LIMITED, Республіка Кіпр, реєстраційний номер: НЕ 359091) ",
     "Набуття опосередкованої істотної участі", "Погоджено", "Набуття",
     "Опосередковане володіння істотною участю в банку", "100%", 46338, 46339],
    [3, "АКЦІОНЕРНЕ ТОВАРИСТВО “ЗНИКЛИЙ БАНК”",
     "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ “Тест Інвест” (код за ЄДРПОУ 46289633) ",
     "Набуття прямої істотної участі", "Погоджено", "Набуття", "Пряме володіння істотною участю в банку",
     "100%", 46338, 46339],
]})

BANKS = [{"GLMFO": 300001, "KOD_EDRPOU": "14360506", "FULLNAME": "АКЦІОНЕРНЕ ТОВАРИСТВО \"ТЕСТ БАНК\"",
          "SHORTNAME": "АТ \"ТЕСТ БАНК\""}]

INDEX_HTML = """<html><body><nav><a href="/ua/supervision/registration/shareholders/999">меню</a></nav>
<main id="mainContent"><h3>Дані публікуються на підставі поданої банками інформації</h3>
<p><a href="/ua/supervision/registration/shareholders/300001">ТЕСТ БАНК</a></p>
<p><a href="/ua/supervision/registration/shareholders/300002">ДРУГИЙ&nbsp;БАНК</a></p>
<h3>Банки, які перебувають в стані ліквідації</h3>
<p><a href="/ua/supervision/registration/shareholders/300003">СТАРИЙ БАНК</a></p>
<p><a href="/ua/supervision/registration/shareholders/300001">ТЕСТ БАНК</a></p>
</main></body></html>"""


def bank_page(mfo: str, title: str, dates: list[str]) -> str:
    links = "".join(f'<a href="/files/Shareholders/{mfo}/{mfo}_{d[6:]}{d[3:5]}{d[:2]}.pdf">{d}</a>  <br>'
                    for d in dates)
    return (f'<main><div class="widget-header"><h2 class="widget-title">\n {title}</h2></div>'
            f'<div class="box">Перелік усіх назв, які мав банк: <span class="mark mt0 mr0"> &quot;Тест&quot; '
            f'(з 15.12.1997); АТ &quot;Тест Банк&quot; (з 20.12.2018) </span><br>Станом на:<br>'
            f'<div class="box">{links}</div></div></main>')


class XlsxTest(unittest.TestCase):
    def test_reader_keeps_column_positions(self):
        sheets = L.read_xlsx(make_xlsx({"a": [["x", "", "z"], [], [1, None, " y "]]}))
        self.assertEqual(sheets["a"], [["x", "", "z"], [], ["1", "", "y"]])

    def test_values(self):
        self.assertEqual(L.parse_date("46336"), "2026-11-10")
        self.assertEqual(L.parse_date("Станом на 16.11.2026"), "2026-11-16")
        self.assertIsNone(L.parse_date("необмежений"))
        self.assertEqual(L.parse_pct("92,230511 "), 92.230511)
        self.assertEqual(L.parse_pct("4.7796000000000003"), 4.7796)
        self.assertEqual(L.parse_pct("100%"), 100.0)
        self.assertIsNone(L.parse_pct("-"))
        self.assertEqual(L.edrpou8("123456"), "00123456")
        self.assertIsNone(L.edrpou8("1234567890"))


class ReeFuTest(unittest.TestCase):
    def test_institutions_and_licences(self):
        s = L.parse_ree_fu(REE_FU)
        self.assertEqual(s.snapshot_date, "2026-11-16")
        self.assertEqual([r["edrpou"] for r in s.rows], ["45000001", "00123456"])
        fk = s.rows[0]
        self.assertEqual(fk["institution_type"], "Фінансова компанія; Лізингодавець")
        self.assertIn("Реєстр осіб", fk["register_name"])
        self.assertEqual(fk["registered_date"], "2023-03-15")  # the earlier of the two entries
        self.assertEqual(fk["head_name"], "Тестенко Тест Тестович")
        self.assertEqual(s.rows[1]["registered_date"], "2021-02-01")
        self.assertEqual(len(s.licenses), 2)
        lic = s.licenses[1]
        self.assertEqual((lic["edrpou"], lic["license_status"], lic["issued_date"], lic["insurance_type"]),
                         ("00123456", "Зупинення дії", None, None))
        self.assertEqual(s.licenses[0]["service_start_date"], "2026-10-20")


class NonbankTest(unittest.TestCase):
    def test_approved_holdings(self):
        s = L.parse_nonbank(PV_POHODJEN, "nonbank_approved")
        self.assertEqual(len(s.rows), 3)
        a, b, c = s.rows
        self.assertEqual((a["institution_edrpou"], a["share_direct"], a["share_indirect"], a["share_total"]),
                         ("20000001", 92.230511, None, 92.230511))
        self.assertEqual((a["owner_kind"], a["is_direct"], a["is_indirect"], a["participation"]),
                         ("legal_entity", True, False, "пряма"))
        self.assertEqual((a["decision_date"], a["decision_number"]), ("2020-10-02", "21/1468-пк"))
        self.assertEqual((b["owner_kind"], b["share_indirect"], b["is_indirect"], b["note"]),
                         ("person", 4.7796, True, "через ТОВ «ХОЛДИНГ»"))
        self.assertEqual((c["institution_edrpou"], c["owner_kind"]), ("01234567", "joint"))
        # «Дата останніх змін» lags behind the newest decision
        self.assertEqual(s.snapshot_date, "2026-11-02")

    def test_no_voting_list(self):
        s = L.parse_nonbank(PV_BPG, "nonbank_no_voting")
        (r,) = s.rows
        self.assertEqual((r["share_direct"], r["share_indirect"], r["share_total"]), (None, 98.0, 98.0))
        self.assertTrue(r["is_indirect"])
        self.assertEqual((r["trustee_name"], r["trustee_appointed"]), ("Довіренко Микола Олександрович", "2023-10-02"))
        self.assertEqual(r["restriction_basis"], "набуття без погодження")
        self.assertIn("опосередкований", r["relation_description"])


class BankDecisionsTest(unittest.TestCase):
    def test_decisions(self):
        s = L.parse_bank_decisions(SUBPAR, L.bank_index(BANKS))
        self.assertEqual(len(s.rows), 4)  # the joint holding of two persons becomes two edges
        p1, p2, cy, ua = s.rows
        self.assertEqual([p1["owner_name"], p2["owner_name"]],
                         ["Суботенко Віктор Георгійович", "Суботенко Олена Олексіївна"])
        self.assertEqual((p1["institution_edrpou"], p1["decision"], p1["share_total"], p1["is_direct"],
                          p1["is_indirect"]), ("14360506", "Заборонено", 98.263536, True, True))
        self.assertEqual((cy["institution_edrpou"], cy["owner_code"], cy["owner_code_kind"], cy["owner_country"]),
                         ("14360506", "НЕ 359091", "foreign_registration", "Республіка Кіпр"))
        self.assertEqual((cy["share_indirect"], cy["share_direct"]), (100.0, None))
        self.assertEqual((ua["owner_code"], ua["owner_country"], ua["institution_edrpou"]),
                         ("46289633", "Україна", None))
        self.assertNotIn("ЄДРПОУ", ua["owner_name"])
        self.assertEqual(s.snapshot_date, "2026-11-13")


class OwnershipDocsTest(unittest.TestCase):
    def test_index_and_crawl_with_checkpoint(self):
        idx = L.parse_shareholders_index(INDEX_HTML)
        self.assertEqual([(b["mfo"], b["label"]) for b in idx],
                         [("300001", "ТЕСТ БАНК"), ("300002", "ДРУГИЙ БАНК"), ("300003", "СТАРИЙ БАНК")])
        self.assertEqual(idx[0]["group"], "Діючі банки")
        self.assertEqual(idx[2]["group"], "Банки, які перебувають в стані ліквідації")

        pages = {"300001": bank_page("300001", 'АТ &quot;Тест Банк&quot;', ["01.01.2026", "01.01.2025"]),
                 "300002": None,  # fails on the first crawl
                 "300003": bank_page("300003", "ПАТ Старий", ["08.03.2015"])}
        calls = []

        def fetch(url):
            mfo = url.rsplit("/", 1)[1]
            calls.append(mfo)
            if pages[mfo] is None:
                raise RuntimeError("timeout")
            return pages[mfo]

        L.PAGE_DELAY = 0
        with tempfile.TemporaryDirectory() as d:
            s = L.crawl_ownership_docs(INDEX_HTML, L.mfo_index(BANKS), d, fetch)
            self.assertEqual(s.skipped, 1)
            self.assertEqual(len(s.rows), 3)
            r = s.rows[0]
            self.assertEqual((r["bank_mfo"], r["bank_edrpou"], r["bank_name"], r["as_of_date"]),
                             ("300001", "14360506", 'АТ "Тест Банк"', "2026-01-01"))
            self.assertEqual(r["pdf_url"], "https://bank.gov.ua/files/Shareholders/300001/300001_20260101.pdf")
            self.assertIn("з 15.12.1997", r["name_history"])
            # second run resumes: only the failed page is fetched again
            pages["300002"] = bank_page("300002", "АТ Другий", ["01.01.2026"])
            calls.clear()
            s2 = L.crawl_ownership_docs(INDEX_HTML, {}, d, fetch)
            self.assertEqual(calls, ["300002"])
            self.assertEqual(len(s2.rows), 4)
            self.assertIsNone(s2.rows[0]["bank_edrpou"])


class SqlTest(unittest.TestCase):
    def test_load_sql_shapes(self):
        s = L.parse_ree_fu(REE_FU)
        sql = L.load_sql(s, "https://bank.gov.ua/x.xlsx", "ab" * 32, 10)
        self.assertIn("COPY nbu_inst_stage", sql)
        self.assertIn("in_register = FALSE", sql)
        self.assertTrue(sql.strip().endswith("COMMIT;"))
        e = L.parse_bank_decisions(SUBPAR, {})
        sql = L.load_sql(e, "u", "cd" * 32, 10)
        self.assertIn("DELETE FROM nbu_fin_ownership WHERE source_list = 'bank_decisions'", sql)
        self.assertIn("“НП ТЕСТ ЛІМІТЕД”", sql)


if __name__ == "__main__":
    unittest.main(verbosity=1)
