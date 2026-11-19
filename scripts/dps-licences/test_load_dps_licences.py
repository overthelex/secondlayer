#!/usr/bin/env python3
"""Parser tests for load_dps_licences.py on small synthetic fixtures (no network, no database).

The fixtures copy the layouts of the ДПС licence CSVs on data.gov.ua (";"-separated, "" escapes,
CRLF): the 23.02.2022 snapshots (NM;TIN;VDNM;LICNUM;LICBEG;LICEND), the e-cig retail file whose
header puts TRADEADDRESS before LICNUM while the data carries the address last, the undated files
(RN;STI_NM;STI_ADDR;NM;LICNUM;LICBEG;LICEND) and the long Ukrainian headers. Names, codes and
addresses are invented.

Run:  python3 -I scripts/dps-licences/test_load_dps_licences.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_dps_licences as L  # noqa: E402


def res(file_name: str, licence_type: str | None = None) -> L.Resource:
    return L.Resource(resource_id="r-" + file_name, url="https://example.invalid/" + file_name,
                      file_name=file_name, register_code=L.register_code_for(file_name),
                      licence_type=licence_type, snapshot_date=L.date_from_file_name(file_name))


SNAPSHOT_2022 = (
    "NM;TIN;VDNM;LICNUM;LICBEG;LICEND\r\n"
    '"ТОВАРИСТВО З ОБМЕЖЕНОЮ ВIДПОВIДАЛЬНIСТЮ ""ТЕСТ ВИНО""";1234567;'
    "Оптова торгівля алкогольними напоями, крім сидру та перрі (без додання спирту);100001;27.02.2017;27.02.2022\r\n"
    "ФІЗИЧНА ОСОБА - ПІДПРИЄМЕЦЬ ТЕСТЕНКО ІВАН ІВАНОВИЧ;**********;"
    "Оптова торгівля алкогольними напоями, крім сидру та перрі (без додання спирту);990208202200001;10.02.2022;10.02.2027\r\n"
)

# Header order says TRADEADDRESS is 4th; the data has LICNUM;LICBEG;LICEND and then the address.
ECIG_RETAIL = (
    "NM;TIN;VDNM;TRADEADDRESS;LICNUM;LICBEG;LICEND\r\n"
    '"ТОВ ""ТЕСТ ПАР""";00012345;Роздрібна торгівля рідинами, що використовуються в електронних сигаретах;'
    "№04170319202100001;14.05.2021;14.05.2022;УКРАЇНА, ТЕСТОВА ОБЛ., М. ТЕСТІВ, вул. Перша, буд 1, павільйон\r\n"
    "ФОП ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ;*;Роздрібна торгівля рідинами, що використовуються в електронних сигаретах;"
    "№04170319202100002;12.03.2021;12.03.2022;УКРАЇНА, ТЕСТОВА ОБЛ., М. ТЕСТІВ, вул. Перша,1, Павільйон\r\n"
)

UNDATED = (
    "RN;STI_NM;STI_ADDR;NM;LICNUM;LICBEG;LICEND\r\n"
    '1;ДЕРЖАВНА ПОДАТКОВА СЛУЖБА  УКРАЇНИ;М.КИЇВ-53, ПЛ. ЛЬВІВСЬКА, 8;"ТОВ ""ТЕСТ ТАБАК""";№300001;29.01.2015;29.01.2020\r\n'
    '2;ДЕРЖАВНА ПОДАТКОВА СЛУЖБА  УКРАЇНИ;М.КИЇВ-53, ПЛ. ЛЬВІВСЬКА, 8;"ПП ""ТЕСТ""";№300002;08.04.2015;08.04.2020\r\n'
)

LONG_HEADERS = (
    "№ п/п;Орган ліцезування - Найменування;Орган ліцезування - Адреса;Найменування суб’єкта господарювання;"
    "Вид господарської діяльності згідно з виданою ліцензією - Найменування;Реєстраційний № ліцензії;"
    "Термін дії ліцензії з;Термін дії ліцензії до\r\n"
    '1;ДЕРЖАВНА ФІСКАЛЬНА СЛУЖБА  УКРАЇНИ;М.КИЇВ-53, ПЛ. ЛЬВІВСЬКА, 8;"ТОВ ""ТЕСТ""";'
    "Оптова торгівля алкогольними напоями - сидром та перрі (без додання спирту);№990209201900001;30.05.2019;30.05.2024\r\n"
)

FUEL_WITH_STATUS = (
    "NM;TIN;VDNM;ADDRESS;LICNUM;LICBEG;LICEND;STATUS;DATEANUL\r\n"
    '"ТОВ ""ТЕСТ ПАЛИВО""";22334455;Зберігання пального;УКРАЇНА, ТЕСТОВА ОБЛ., С. ТЕСТОВЕ, вул. Нафтова, 7;'
    "990212202100001;01.02.2021;01.02.2026;анульована;15.06.2021\r\n"
)


class ParseTests(unittest.TestCase):
    def test_snapshot_2022_edrpou_padding_and_fop(self):
        s = L.parse_csv(SNAPSHOT_2022.encode("utf-8"), res("register3-2_2022-02-23.csv"))
        self.assertEqual(len(s.rows), 2)
        a, b = s.rows
        self.assertEqual(a["register_code"], "register3-2")
        self.assertEqual(a["snapshot_date"], "2022-02-23")
        self.assertEqual(a["edrpou"], "01234567")
        self.assertEqual(a["licensee_type"], "legal_entity")
        self.assertEqual(a["licence_number"], "100001")
        self.assertEqual((a["valid_from"], a["valid_to"]), ("2017-02-27", "2022-02-27"))
        self.assertEqual((a["licence_category"], a["activity"]), ("alcohol", "wholesale"))
        self.assertEqual(a["licensee_name"], 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВIДПОВIДАЛЬНIСТЮ "ТЕСТ ВИНО"')
        self.assertEqual(b["licensee_type"], "fop")
        self.assertIsNone(b["edrpou"])
        for v in b.values():  # the masked code never reaches a column
            self.assertNotIn("*", str(v))

    def test_ecig_retail_header_order_fixed_by_content(self):
        s = L.parse_csv(ECIG_RETAIL.encode("utf-8"), res(
            "reestr-vudanux-licenziy-rozdribna-torgivlya-riduna-elektron_sugaretu-2022-02-23.csv"))
        self.assertTrue(s.notes)
        a, b = s.rows
        self.assertEqual(a["register_code"], "ecig_retail")
        self.assertEqual(a["licence_number"], "04170319202100001")
        self.assertEqual((a["valid_from"], a["valid_to"]), ("2021-05-14", "2022-05-14"))
        self.assertTrue(a["premises_address"].startswith("УКРАЇНА, ТЕСТОВА ОБЛ."))
        self.assertEqual(a["edrpou"], "00012345")
        self.assertEqual((a["licence_category"], a["activity"]), ("ecig_liquid", "retail"))
        # both premises normalise to the same key -> a "same address" edge
        self.assertEqual(a["premises_address_norm"], b["premises_address_norm"])
        self.assertEqual(a["premises_address_norm"], "ТЕСТОВА ОБЛ М ТЕСТІВ ВУЛ ПЕРША 1 ПАВІЛЬЙОН")
        self.assertEqual(b["licensee_type"], "fop")
        self.assertIsNone(b["edrpou"])

    def test_undated_file_authority_and_default_type(self):
        r = res("register3-5.csv", L.licence_type_from_title(
            "Ліцензійний реєстр виданих ліцензій на право оптової торгівлі тютюновими виробами"))
        s = L.parse_csv(UNDATED.encode("utf-8"), r)
        a = s.rows[0]
        self.assertEqual(a["register_code"], "register3-5")
        self.assertIsNone(a["snapshot_date"])
        self.assertEqual(a["licensing_authority"], "ДЕРЖАВНА ПОДАТКОВА СЛУЖБА УКРАЇНИ")
        self.assertEqual(a["licensing_authority_address"], "М.КИЇВ-53, ПЛ. ЛЬВІВСЬКА, 8")
        self.assertEqual(a["licence_type"], "Оптової торгівлі тютюновими виробами")
        self.assertEqual((a["licence_category"], a["activity"]), ("tobacco", "wholesale"))
        self.assertIsNone(a["edrpou"])
        self.assertEqual(a["licensee_type"], "legal_entity")
        self.assertEqual(a["row_no"], 1)

    def test_long_ukrainian_headers_cp1251(self):
        s = L.parse_csv(LONG_HEADERS.encode("cp1251"), res("register3.csv"))
        self.assertEqual(s.encoding, "cp1251")
        a = s.rows[0]
        self.assertEqual(a["licence_number"], "990209201900001")
        self.assertEqual((a["licence_category"], a["activity"]), ("cider_perry", "wholesale"))
        self.assertEqual(a["valid_to"], "2024-05-30")
        self.assertEqual(a["licensing_authority"], "ДЕРЖАВНА ФІСКАЛЬНА СЛУЖБА УКРАЇНИ")

    def test_status_and_revocation_columns(self):
        a = L.parse_csv(FUEL_WITH_STATUS.encode("utf-8-sig"), res("register5-1_2022-02-23.csv")).rows[0]
        self.assertEqual((a["licence_category"], a["activity"]), ("fuel", "storage"))
        self.assertEqual(a["status"], "анульована")
        self.assertEqual(a["revocation_date"], "2021-06-15")
        self.assertEqual(a["premises_address_norm"], "ТЕСТОВА ОБЛ С ТЕСТОВЕ ВУЛ НАФТОВА 7")

    def test_rejects_mostly_unparseable_file(self):
        bad = "NM;TIN;VDNM;LICNUM;LICBEG;LICEND\r\n" + ";;;;;x\r\n" * 5 + SNAPSHOT_2022.split("\r\n", 1)[1]
        s = L.parse_csv(bad.encode("utf-8"), res("register3-2_2022-02-23.csv"))
        with self.assertRaises(RuntimeError):
            L.check_snapshot(s)

    def test_no_name_column_is_an_error(self):
        with self.assertRaises(ValueError):
            L.parse_csv(b"A;B\r\n1;2\r\n", res("register9.csv"))


class HelperTests(unittest.TestCase):
    def test_edrpou(self):
        self.assertEqual(L.edrpou_code("39546612"), "39546612")
        self.assertEqual(L.edrpou_code("123"), "00000123")
        self.assertIsNone(L.edrpou_code("**********"))
        self.assertIsNone(L.edrpou_code("1234567890"))  # an РНОКПП is never stored
        self.assertIsNone(L.edrpou_code(""))
        self.assertIsNone(L.edrpou_code("0"))

    def test_licensee_type(self):
        self.assertEqual(L.licensee_type("ФІЗИЧНА ОСОБА - ПІДПРИЄМЕЦЬ ТЕСТ", None), "fop")
        self.assertEqual(L.licensee_type("ТОВ ТЕСТ", "*"), "fop")
        self.assertEqual(L.licensee_type("ТЕСТ", "1234567890"), "fop")
        self.assertEqual(L.licensee_type("ТОВ ТЕСТ", "12345678"), "legal_entity")

    def test_file_names(self):
        self.assertEqual(L.register_code_for("register4-3_2022-02-23.csv"), "register4-3")
        self.assertEqual(L.register_code_for("Register4.2.csv"), "register4-2")
        self.assertEqual(L.register_code_for("register3.csv"), "register3")
        self.assertEqual(L.register_code_for(
            "reestr-vudanux-licenziy-optova-torgivlya-riduna-elektron_sugaretu-2022-02-23.csv"), "ecig_wholesale")
        self.assertEqual(L.date_from_file_name("register4-3_2022-02-23.csv"), "2022-02-23")
        self.assertEqual(L.date_from_file_name("reyestr_licenziativ_14_12_2021.csv"), "2021-12-14")
        self.assertIsNone(L.date_from_file_name("register4-3.csv"))

    def test_ckan_resource_selection(self):
        pkg = {
            "id": "pkg-1", "name": "x", "organization": {"name": "tax"},
            "title": "Ліцензійний реєстр виданих ліцензій на роздрібну торгівлю тютюновими виробами",
            "resources": [
                {"id": "a", "format": "CSV", "url": "https://h/d/structure_register4-3.csv"},
                {"id": "b", "format": "CSV", "url": "https://h/d/register4-3_2022-02-23.csv",
                 "last_modified": "2025-11-05T11:47:00"},
                {"id": "c", "format": "сsv", "url": "https://h/d/register4-3",
                 "last_modified": "2024-01-02T00:00:00"},
                {"id": "d", "format": "PDF", "url": "https://h/d/passport.pdf"},
            ],
        }
        self.assertTrue(L.is_licence_dataset(pkg))
        rs = L.resources_of(pkg)
        self.assertEqual([r.resource_id for r in rs], ["b", "c"])
        self.assertEqual(rs[0].snapshot_date, "2022-02-23")      # date in the file name wins
        self.assertEqual(rs[1].snapshot_date, "2024-01-02")      # else CKAN last_modified
        self.assertEqual(rs[0].licence_type, "Роздрібну торгівлю тютюновими виробами")
        self.assertFalse(L.is_licence_dataset({"title": "Реєстр великих платників податків"}))

    def test_resolve_datasets_search_plus_known_ids(self):
        lic = {"id": "p1", "title": "Ліцензійний реєстр виданих ліцензій на оптову торгівлю пальним",
               "organization": {"name": "tax"}, "resources": []}
        other = {"id": "p2", "title": "Реєстр великих платників податків", "organization": {"name": "tax"}}
        known = {"id": L.KNOWN_DATASETS[0], "title": "Ліцензійний реєстр виданих ліцензій на роздрібну торгівлю"}
        calls = []

        def fake_ckan(action, **params):
            calls.append(action)
            if action == "package_search":
                return {"count": 2, "results": [lic, other]}
            if params["id"] == L.KNOWN_DATASETS[0]:
                return known
            raise RuntimeError("Not found")  # a moved id is logged, not fatal

        orig = L.ckan
        L.ckan = fake_ckan
        try:
            ids = sorted(p["id"] for p in L.resolve_datasets())
        finally:
            L.ckan = orig
        self.assertEqual(ids, sorted(["p1", L.KNOWN_DATASETS[0]]))
        self.assertEqual(calls.count("package_search"), 1)

    def test_load_sql_is_one_transaction_with_guard(self):
        s = L.parse_csv(SNAPSHOT_2022.encode("utf-8"), res("register3-2_2022-02-23.csv"))
        sql = L.load_sql(s, "https://example.invalid/f.csv", "ab" * 32, 123)
        self.assertTrue(sql.strip().startswith("BEGIN;"))
        self.assertTrue(sql.strip().endswith("COMMIT;"))
        self.assertIn("RAISE EXCEPTION", sql)
        self.assertIn("DELETE FROM dps_licences WHERE resource_id = 'r-register3-2_2022-02-23.csv'", sql)
        self.assertIn("INSERT INTO dps_licence_snapshots", sql)


if __name__ == "__main__":
    unittest.main(verbosity=1)
