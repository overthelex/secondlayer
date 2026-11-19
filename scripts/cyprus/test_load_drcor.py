#!/usr/bin/env python3
"""Parser tests for load_drcor.py on small synthetic fixtures (no network, no database).

The fixtures copy the layout of the data.gov.cy DRCOR CSV files as published in November 2026
(UTF-8 with BOM, CRLF, unquoted names, lines padded to the column count when a line break inside a
field splits a record); company and person names and numbers in them are invented.

Run:  python3 -I scripts/cyprus/test_load_drcor.py
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_drcor as L  # noqa: E402

ORG_HEADER = ("\ufeffORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,"
              "ORGANISATION_SUB_TYPE,NAME_STATUS_CODE,NAME_STATUS,REGISTRATION_DATE,ORGANISATION_STATUS,"
              "ORGANISATION_STATUS_DATE,ADDRESS_SEQ_NO\r\n")
ORGS = ORG_HEADER + (
    "ALPHA TEST HOLDINGS LIMITED,100001,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,05/03/2012,"
    "Εγγεγραμμένη,05/03/2012,501\r\n"
    "BETA OVERSEAS PLC,77,O,Αλλοδαπή Εταιρεία,,ACR,Τελευταίο Όνομα,20/06/1990,Διαγραμμένη,16/08/2001,\r\n"
    "GAMMA TRADING,77,B,Εμπορική Επωνυμία,,ACR,Τελευταίο Όνομα,01/02/2020,Εγγεγραμμένη,,502\r\n"
    "DELTA AND CO,12,P,Συνεταιρισμός,Ομόρρυθμος,ACR,Τελευταίο Όνομα,31/12/1999,Εγγεγραμμένη,,\r\n"
    # name broken by a line break, registration number kept on the second line
    "EPSILON RESEARCH AND,,,,,,,,,,\r\n"
    "100002,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,08/03/2026,Εγγεγραμμένη,,19/06/5594,\r\n"
    # name broken, registration number lost: rejected
    "ZETA STUDIO,,,,,,,,,,\r\n"
    "B,Εμπορική Επωνυμία,,ACR,Τελευταίο Όνομα,26/10/2026,Εγγεγραμμένη,,1418200,,\r\n"
    ",,,,,,,,,,\r\n"
    # duplicate key
    "ALPHA TEST HOLDINGS LIMITED,100001,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,05/03/2012,"
    "Εγγεγραμμένη,05/03/2012,501\r\n"
)

OFFICES = (
    "\ufeffADDRESS_SEQ_NO,STREET,BUILDING,TERRITORY\r\n"
    '501,"Testou, 12, ","TEST HOUSE, Floor 2, ","1065, Λευκωσία, Κύπρος"\r\n'
    '502,"Meydan Road, ",, \r\n'
    # line break typed into TERRITORY: the rest arrives on the next line
    '503,"Dokimis, 51, ",,"Αγιος Αθανάσιος, 4104"\r\n'
    ' Λεμεσός," Κύπρος""",,\r\n'
    '504,"Dokimis, 6, ",,"2121, Λευκωσία, Κύπρος"\r\n'
)

OFFICIALS = (
    "\ufeffORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,"
    "PERSON_OR_ORGANISATION_NAME,OFFICIAL_POSITION\r\n"
    "ALPHA TEST HOLDINGS LIMITED,100001,C,Εταιρεία,IVAN TESTENKO,Διευθυντής\r\n"
    "ALPHA TEST HOLDINGS LIMITED,100001,C,Εταιρεία,TEST SECRETARIES LIMITED,Γραμματέας\r\n"
    # position on its own line after a line break
    "ALPHA TEST HOLDINGS LIMITED,100001,C,Εταιρεία,MARIA PROBNA,\r\n"
    "Διευθυντής,,,,,\r\n"
    "BETA OVERSEAS PLC,77,O,Αλλοδαπή Εταιρεία,JOHN EXAMPLE,Εξουσιοδοτημένο Πρόσωπο\r\n"
    # verbatim repeat, empty position
    "DELTA AND CO,12,P,Συνεταιρισμός,ΑΝΔΡΕΑΣ ΔΟΚΙΜΗΣ,\r\n"
    ",,,,,\r\n"
    "DELTA AND CO,12,P,Συνεταιρισμός,ΑΝΔΡΕΑΣ ΔΟΚΙΜΗΣ,\r\n"
    # name broken, registration number lost: rejected
    "ZETA STUDIO,,,,,\r\n"
    "B,Εμπορική Επωνυμία,ΕΚΑΤΕΡΙΝΑ ΔΟΚΙΜΗ,Ιδιοκτήτης,,\r\n"
    "GAMMA TRADING,77,B,Εμπορική Επωνυμία,ΠΕΤΡΟΣ ΔΟΚΙΜΟΣ,Ιδιοκτήτης\r\n"
)


def lines(text: str) -> io.StringIO:
    # what open(path, encoding="utf-8-sig", newline="") yields
    return io.StringIO(text.lstrip("\ufeff"), newline="")


class OrganisationsTest(unittest.TestCase):
    def setUp(self):
        self.stats = L.Stats()
        self.rows = list(L.parse_organisations(lines(ORGS), self.stats))
        self.by = {(r["org_type_code"], r["registration_no"]): r for r in self.rows}

    def test_counts(self):
        self.assertEqual(len(self.rows), 5)
        self.assertEqual(self.stats.parsed, 5)
        self.assertEqual(self.stats.rejected, 1)
        self.assertEqual(self.stats.reasons, {"no registration number": 1})
        self.assertEqual(self.stats.repaired, 2)
        self.assertEqual(self.stats.duplicates, 1)

    def test_company_fields(self):
        r = self.by[("C", "100001")]
        self.assertEqual(r["registration_code"], "HE100001")
        self.assertEqual(r["name"], "ALPHA TEST HOLDINGS LIMITED")
        self.assertEqual(r["org_sub_type"], "Ιδιωτική")
        self.assertEqual(r["registration_date"], "2012-03-05")
        self.assertEqual(r["status"], "Εγγεγραμμένη")
        self.assertEqual(r["address_seq_no"], 501)

    def test_registration_codes_by_type(self):
        self.assertEqual(self.by[("O", "77")]["registration_code"], "AE77")
        self.assertIsNone(self.by[("B", "77")]["registration_code"])  # same number, other register
        self.assertIsNone(self.by[("P", "12")]["registration_code"])

    def test_broken_name_joined(self):
        r = self.by[("C", "100002")]
        self.assertEqual(r["name"], "EPSILON RESEARCH AND")
        self.assertEqual(r["registration_date"], "2026-03-08")
        self.assertIsNone(r["address_seq_no"])  # '19/06/5594' is not an address number

    def test_bad_header(self):
        with self.assertRaises(RuntimeError):
            list(L.parse_organisations(lines("A,B,C\r\n1,2,3\r\n"), L.Stats()))


class OfficesTest(unittest.TestCase):
    def test_parse(self):
        stats = L.Stats()
        rows = {r["address_seq_no"]: r for r in L.parse_offices(lines(OFFICES), stats)}
        self.assertEqual(sorted(rows), [501, 502, 503, 504])
        self.assertEqual(rows[501], {"address_seq_no": 501, "street": "Testou, 12",
                                     "building": "TEST HOUSE, Floor 2",
                                     "territory": "1065, Λευκωσία, Κύπρος"})
        self.assertEqual(rows[502]["street"], "Meydan Road")
        self.assertIsNone(rows[502]["building"])
        self.assertIsNone(rows[502]["territory"])
        self.assertEqual(rows[503]["territory"], "Αγιος Αθανάσιος, 4104, Λεμεσός, Κύπρος")
        self.assertEqual(stats.repaired, 1)
        self.assertEqual(stats.rejected, 0)


class OfficialsTest(unittest.TestCase):
    def test_parse(self):
        stats = L.Stats()
        rows = list(L.parse_officials(lines(OFFICIALS), stats))
        got = [(r["org_type_code"], r["registration_no"], r["person_name"], r["position"]) for r in rows]
        self.assertEqual(got, [
            ("C", "100001", "IVAN TESTENKO", "Διευθυντής"),
            ("C", "100001", "TEST SECRETARIES LIMITED", "Γραμματέας"),
            ("C", "100001", "MARIA PROBNA", "Διευθυντής"),
            ("O", "77", "JOHN EXAMPLE", "Εξουσιοδοτημένο Πρόσωπο"),
            ("P", "12", "ΑΝΔΡΕΑΣ ΔΟΚΙΜΗΣ", ""),
            ("P", "12", "ΑΝΔΡΕΑΣ ΔΟΚΙΜΗΣ", ""),   # repeats are aggregated in SQL (occurrences)
            ("B", "77", "ΠΕΤΡΟΣ ΔΟΚΙΜΟΣ", "Ιδιοκτήτης"),
        ])
        self.assertEqual(rows[0]["organisation_name"], "ALPHA TEST HOLDINGS LIMITED")
        self.assertEqual(stats.rejected, 1)
        self.assertEqual(stats.reasons, {"no registration number": 1})
        self.assertEqual(stats.repaired, 2)


class HelpersTest(unittest.TestCase):
    def test_dates(self):
        self.assertEqual(L.parse_dmy("01/02/2020"), "2020-02-01")
        self.assertIsNone(L.parse_dmy("19/06/5594"))
        self.assertIsNone(L.parse_dmy("31/02/2020"))
        self.assertIsNone(L.parse_dmy(""))

    def test_urls_from_dcat(self):
        rec = {"dcat:Distribution": [
            {"dcat:downloadURL": {"@rdf:resource": L.FILES_BASE + "registered_office_102.csv"}},
            {"dcat:downloadURL": {"@rdf:resource": L.FILES_BASE + "organisations_103.csv"}},
            {"dcat:downloadURL": {"@rdf:resource": L.FILES_BASE + "organisation_officials_89.csv"}},
        ]}
        self.assertEqual(L.urls_from_dcat(rec), {
            "registered_office": L.FILES_BASE + "registered_office_102.csv",
            "organisations": L.FILES_BASE + "organisations_103.csv",
            "organisation_officials": L.FILES_BASE + "organisation_officials_89.csv",
        })

    def test_urls_from_page(self):
        page = ('<a href="/sites/default/files/organisation_officials_90.csv">x</a>'
                '<a href="/sites/default/files/organisations_104.csv">y</a>'
                '<a href="/sites/default/files/registered_office_103.csv">z</a>')
        urls = L.urls_from_page(page)
        self.assertEqual(urls["organisations"], L.FILES_BASE + "organisations_104.csv")
        self.assertEqual(urls["organisation_officials"], L.FILES_BASE + "organisation_officials_90.csv")

    def test_min_rows_guard(self):
        s = L.Stats(parsed=10)
        with self.assertRaises(RuntimeError):
            L.check_stats(L.ORG, s)

    def test_copy_line(self):
        row = {"address_seq_no": 1, "street": "a\tb\\c", "building": None, "territory": "x"}
        self.assertEqual(L.copy_line(L.OFFICE, row), "1\ta\\tb\\\\c\t\\N\tx\n")


if __name__ == "__main__":
    unittest.main()
