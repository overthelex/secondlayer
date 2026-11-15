#!/usr/bin/env python3
"""Tests for the citation parser of build_decision_citations.py. No database needed.

  python3 scripts/pl/test_build_decision_citations.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_decision_citations as B  # noqa: E402


def nos(text):
    return [n for n, *_ in B.parse_articles(text)]


class Eli(unittest.TestCase):
    def test_isap_link(self):
        self.assertEqual(B.isap_eli("http://isap.sejm.gov.pl/DetailsServlet?id=WDU20120000270", ""), "DU/2012/270")
        self.assertEqual(B.isap_eli("http://isap.sejm.gov.pl/DetailsServlet?id=WDU20040290257", ""), "DU/2004/257")
        self.assertEqual(B.isap_eli("http://isap.sejm.gov.pl/DetailsServlet?id=WMP20190000012", ""), "MP/2019/12")

    def test_court_raw_keys(self):
        refs = B.references("hf-pl-court-raw", [{"art": "art. 477(14);art. 477(14) § 2", "isap_id": "WDU19640430296",
                                                 "address": "Dz. U. z 1964 r. Nr 43, poz. 296"}])
        self.assertEqual(refs[0][:2], ("DU/1964/296", "art. 477(14);art. 477(14) § 2"))
        self.assertEqual(B.isap_eli(None, "Dz. U. z 1998 r. Nr 162, poz. 1118"), "DU/1998/1118")

    def test_journal_fallback_and_eu(self):
        self.assertEqual(B.isap_eli(None, "Dz.U. 2004 nr 29 poz 257"), "DU/2004/257")
        self.assertIsNone(B.isap_eli(None, "Dz.U.UE.L 1995 nr 312 poz 1 art. 1 ust.1"))

    def test_saos(self):
        self.assertEqual(B.saos_eli({"text": "Kodeks (Dz. U. z 1964 r. Nr 43, poz. 296 - art. 1)",
                                     "journalYear": 1964, "journalEntry": 296}), "DU/1964/296")
        self.assertEqual(B.saos_eli({"text": "Uchwała (M. P. z 2001 r. Nr 5, poz. 77)",
                                     "journalYear": 2001, "journalEntry": 77}), "MP/2001/77")
        self.assertIsNone(B.saos_eli({"text": "Dyrektywa"}))
        self.assertIsNone(B.saos_eli({"text": "Ustawa", "journalYear": "1991", "journalEntry": "0"}))


class Articles(unittest.TestCase):
    def test_lists_and_units(self):
        self.assertEqual(nos("Art. 199, art. 246 par. 1 pkt 1, art. 252 par. 1, art. 255"), ["199", "246", "252", "255"])
        self.assertEqual(nos("art. 7,75,77 par. 1"), ["7", "75", "77"])
        self.assertEqual(nos("art. 51, ust. 5, art. 52, art. 32 ust. 2, art. 36a ust. 2"), ["51", "52", "32", "36a"])
        self.assertEqual(nos("art. 71 ust. 2 pkt 1, 2"), ["71"])
        self.assertEqual(nos("art. 220 § 1 i 3"), ["220"])
        self.assertEqual(nos("Art. 5 pkt 4a i art. 12 ust. 2 pkt 1"), ["5", "12"])
        self.assertEqual(nos("art. 210 par. 2 i 4, art. 120, 121, 122"), ["210", "120", "121", "122"])
        self.assertEqual(nos("art.151"), ["151"])
        self.assertEqual(nos("§ 12; § 12 ust. 1"), [])

    def test_superscripts(self):
        self.assertEqual(nos("art. 477(14); art. 477(14) § 1"), ["477^14", "477^14"])
        self.assertEqual(nos("art. 22¹ § 1"), ["22^1"])
        self.assertEqual(nos("art. 18^3a"), ["18^3a"])
        self.assertEqual(nos("art. 15zzzzzn"), ["15zzzzzn"])

    def test_runtogether(self):
        kpc = {"393", "393^5", "393^19", "3", "935"}
        self.assertEqual(B.resolve_runtogether("3935", kpc), "393^5")      # 3^935 is not an article
        self.assertEqual(B.resolve_runtogether("393", kpc), "393")         # exists as written
        self.assertEqual(B.resolve_runtogether("3935", set()), "3935")     # act without articles
        self.assertEqual(B.resolve_runtogether("3935", kpc | {"39^35"}), "3935")  # ambiguous

    def test_saos_article_text(self):
        t = "Ustawa - Kodeks postępowania cywilnego (Dz. U. z 1964 r. Nr 43, poz. 296 - art. 385; art. 393(19))"
        self.assertEqual(B.saos_article_text(t), "art. 385; art. 393(19)")


class Rows(unittest.TestCase):
    def test_consolidation_folds_and_dedupes(self):
        acts = {"DU/2012/270": "DU/2002/1270", "DU/2002/1270": "DU/2002/1270"}
        arts = {"DU/2002/1270": {"145", "151"}}
        payload = [{"link": "http://isap.sejm.gov.pl/DetailsServlet?id=WDU20120000270",
                    "article": "art. 145 par. 1, art. 145 par. 2, art. 999"},
                   {"journal": "Dz.U.UE.L 2006 nr 347 poz 1 art. 211"}]
        stats = {"no_eli": 0}
        rows = B.citation_rows(("d1", "2015-03-03", "administrative court"), "hf-pl-nsa", payload, acts, arts, stats)
        by = {r[6]: r for r in rows}
        self.assertEqual(set(by), {"145", "999"})
        self.assertEqual(by["145"][4:6], ("DU/2002/1270", "DU/2012/270"))
        self.assertEqual(by["145"][7], "art. 145 par. 1; art. 145 par. 2")
        self.assertEqual(by["145"][8:], (True, True))
        self.assertEqual(by["999"][8:], (True, False))
        self.assertEqual(stats["no_eli"], 1)

    def test_saos_act_level_and_runtogether(self):
        acts = {"DU/1964/296": "DU/1964/296"}
        arts = {"DU/1964/296": {"393^5", "385"}}
        payload = [{"text": "KPC (Dz. U. z 1964 r. Nr 43, poz. 296 - art. 3935; art. 385)",
                    "journalYear": 1964, "journalEntry": 296},
                   {"text": "Rozporządzenie (Dz. U. z 2002 r. Nr 163, poz. 1349 - § 12; § 12 ust. 1)",
                    "journalYear": 2002, "journalEntry": 1349}]
        rows = B.citation_rows(("s1", "2015-03-03", "COMMON"), "saos", payload, acts, arts, {"no_eli": 0})
        got = sorted((r[5], r[6], r[8], r[9]) for r in rows if r[6])
        self.assertEqual(got, [("DU/1964/296", "385", True, True), ("DU/1964/296", "393^5", True, True)])
        act_level = [r for r in rows if r[6] is None]
        self.assertEqual(len(act_level), 1)
        self.assertEqual((act_level[0][5], act_level[0][7], act_level[0][8]), ("DU/2002/1349", "§ 12; § 12 ust. 1", False))


if __name__ == "__main__":
    unittest.main()
