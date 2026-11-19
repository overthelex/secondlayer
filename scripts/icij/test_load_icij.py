#!/usr/bin/env python3
"""Tests for load_icij.py on small synthetic archives (no ICIJ data is committed).

  python3 scripts/icij/test_load_icij.py
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_icij as L  # noqa: E402

ENTITIES = (
    "node_id,name,original_name,former_name,jurisdiction,jurisdiction_description,company_type,address,"
    "internal_id,incorporation_date,inactivation_date,struck_off_date,dorm_date,status,service_provider,"
    "ibcRUC,country_codes,countries,sourceID,valid_until,note\n"
    '10000001,"ALPHA TRADING CO., LTD.","ALPHA TRADING CO., LTD.",,SAM,Samoa,,"ROOM 1; KOWLOON",1001256,'
    "23-MAR-2006,18-FEB-2013,15-FEB-2013,,Defaulted,Mossack Fonseca,25221,HKG;UKR,Hong Kong;Ukraine,"
    "Panama Papers,The Panama Papers data is current through 2015,\n"
    "10000002,Société Bêta S.A.,,,BVI,British Virgin Islands,,,,2006-03-27,someday,,,Active,,,UKR,Ukraine,"
    "Pandora Papers - Trident Trust,,\n"
)
OFFICERS = (
    "node_id,name,countries,country_codes,sourceID,valid_until,note\n"
    "12000001,Іванов Іван Іванович,Ukraine,UKR,Offshore Leaks,,\n"
    "51122,\"Peng, Wan-Hsiung\",Taiwan,TWN,Offshore Leaks,,\n"
)
INTERMEDIARIES = (
    "node_id,name,status,internal_id,address,countries,country_codes,sourceID,valid_until,note\n"
    "51122,\"Peng, Wan-Hsiung\",ACTIVE,1,,Taiwan,TWN,Offshore Leaks,,\n"
)
ADDRESSES = (
    "node_id,address,name,countries,country_codes,sourceID,valid_until,note\n"
    '24000001,"P.O. BOX N-4805, NASSAU, BAHAMAS",,Bahamas,BHS,Bahamas Leaks,,\n'
)
OTHERS = (
    "node_id,name,type,incorporation_date,struck_off_date,closed_date,jurisdiction,jurisdiction_description,"
    "countries,country_codes,sourceID,valid_until,note\n"
    "85004929,ANTAM ENTERPRISES N.V.,LIMITED LIABILITY COMPANY,18-MAY-1983,,28-NOV-2012,AW,Aruba,,,"
    "Paradise Papers - Aruba corporate registry,,Closed date stands for Cancelled date.\n"
)
RELATIONSHIPS = (
    "node_id_start,node_id_end,rel_type,link,status,start_date,end_date,sourceID\n"
    "12000001,10000001,officer_of,director of,,23/03/2006,*,Panama Papers\n"
    "12000001,10000001,officer_of,shareholder of,,2006-03-23,,Panama Papers\n"
    "10000001,24000001,registered_address,registered address,,,,Panama Papers\n"
    ",10000001,officer_of,,,,,Panama Papers\n"
)


def make_zip(path: str, skip: str | None = None, extra: dict | None = None) -> None:
    files = {
        "GENERATED_ON_20260909.txt": "",
        "nodes-entities.csv": ENTITIES, "nodes-officers.csv": OFFICERS,
        "nodes-intermediaries.csv": INTERMEDIARIES, "nodes-addresses.csv": ADDRESSES,
        "nodes-others.csv": OTHERS, "relationships.csv": RELATIONSHIPS,
        **(extra or {}),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in files.items():
            if name != skip:
                zf.writestr(name, body)


class Normalisation(unittest.TestCase):
    def test_dates(self):
        cases = {
            "23-MAR-2006": "2006-03-23", "23-Mar-2006": "2006-03-23", "2006-03-23": "2006-03-23",
            "Jul 05, 2001": "2001-07-05", "06.5.2004": "2004-05-06", "23/03/2006": "2006-03-23",
            "3/4/2006": "2006-04-03",     # Bahamas Leaks: day first
            "03/23/2006": "2006-03-23",   # second part > 12: month first
            "1/2/99": "1999-02-01", "1/2/05": "2005-02-01",
            "31-FEB-2006": None, "*": None, "": None, None: None, "2006": None, "99/99/999": None,
        }
        for raw, want in cases.items():
            self.assertEqual(L.parse_date(raw), want, raw)

    def test_name_key(self):
        self.assertEqual(L.name_key("Société Bêta S.A."), "societe beta s a")
        self.assertEqual(L.name_key('"ALPHA TRADING CO., LTD."'), "alpha trading co ltd")
        self.assertEqual(L.name_key("Іванов  Іван-Іванович"), "іванов іван іванович")
        self.assertIsNone(L.name_key(" ,. "))
        self.assertIsNone(L.name_key(None))

    def test_source_leak(self):
        self.assertEqual(L.source_leak("Paradise Papers - Malta corporate registry"), "Paradise Papers")
        self.assertEqual(L.source_leak("Pandora Papers - Alemán, Cordero, Galindo & Lee (Alcogal)"), "Pandora Papers")
        self.assertEqual(L.source_leak("Panama Papers"), "Panama Papers")
        self.assertEqual(L.source_leak("New Leak - Registry"), "New Leak")
        self.assertIsNone(L.source_leak(None))

    def test_copy_escaping(self):
        line = L.copy_line({"a": "x\ty\\z\nw", "b": None, "c": ["A;B", 'q"'], "d": {"k": "в"}, "e": []},
                           ["a", "b", "c", "d", "e"])
        self.assertEqual(line, 'x\\ty\\\\z\\nw\t\\N\t{"A;B","q\\\\""}\t{"k": "в"}\t\\N\n')


class Rows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.zip = os.path.join(self.tmp, "a.zip")
        make_zip(self.zip)

    def rows(self):
        counts: dict = {}
        a = L.Archive(self.zip)
        return a, list(a.nodes(counts)), list(a.relationships(counts)), counts

    def test_archive_counts_and_generation_date(self):
        a, nodes, rels, counts = self.rows()
        self.assertEqual(a.generated_on, "2026-09-09")
        self.assertEqual(counts, {"nodes-entities.csv": 2, "nodes-officers.csv": 2, "nodes-intermediaries.csv": 1,
                                  "nodes-addresses.csv": 1, "nodes-others.csv": 1, "relationships.csv": 3,
                                  "skipped": 1})
        L.check_counts(counts)

    def test_entity_row(self):
        _, nodes, _, _ = self.rows()
        e = next(n for n in nodes if n["node_id"] == "10000001")
        self.assertEqual(e["node_type"], "entity")
        self.assertEqual(e["name_key"], "alpha trading co ltd")
        self.assertEqual(e["country_codes"], ["HKG", "UKR"])
        self.assertEqual(e["countries"], ["Hong Kong", "Ukraine"])
        self.assertEqual((e["incorporation_date"], e["inactivation_date"], e["struck_off_date"]),
                         ("2006-03-23", "2013-02-18", "2013-02-15"))
        self.assertEqual(e["source_leak"], "Panama Papers")
        self.assertEqual(e["extra"], {"internal_id": "1001256", "ibcRUC": "25221"})
        b = next(n for n in nodes if n["node_id"] == "10000002")
        self.assertEqual(b["extra"], {"inactivation_date_raw": "someday"})
        self.assertIsNone(b["inactivation_date"])
        self.assertEqual(b["source_leak"], "Pandora Papers")

    def test_same_node_id_as_officer_and_intermediary(self):
        _, nodes, _, _ = self.rows()
        self.assertEqual(sorted(n["node_type"] for n in nodes if n["node_id"] == "51122"),
                         ["intermediary", "officer"])
        keys = [(n["node_id"], n["node_type"]) for n in nodes]
        self.assertEqual(len(keys), len(set(keys)))

    def test_address_and_other_rows(self):
        _, nodes, _, _ = self.rows()
        ad = next(n for n in nodes if n["node_type"] == "address")
        self.assertIsNone(ad["name"])
        self.assertEqual(ad["name_key"], "p o box n 4805 nassau bahamas")
        o = next(n for n in nodes if n["node_type"] == "other")
        self.assertEqual(o["company_type"], "LIMITED LIABILITY COMPANY")
        self.assertEqual(o["extra"], {"closed_date": "28-NOV-2012"})
        self.assertEqual(o["note"], "Closed date stands for Cancelled date.")
        self.assertIsNone(o["country_codes"] or None)

    def test_relationships_keep_repeated_triples(self):
        _, _, rels, _ = self.rows()
        officer = [r for r in rels if r["rel_type"] == "officer_of"]
        self.assertEqual([r["link"] for r in officer], ["director of", "shareholder of"])
        self.assertEqual(officer[0]["start_date"], "2006-03-23")
        self.assertEqual(officer[0]["metadata_json"], {"end_date_raw": "*"})
        self.assertIsNone(officer[1]["metadata_json"])

    def test_missing_member_rejected(self):
        bad = os.path.join(self.tmp, "bad.zip")
        make_zip(bad, skip="nodes-others.csv")
        with self.assertRaisesRegex(RuntimeError, "nodes-others.csv"):
            L.Archive(bad)

    def test_empty_member_rejected(self):
        bad = os.path.join(self.tmp, "empty.zip")
        make_zip(bad, extra={"nodes-others.csv": OTHERS.splitlines()[0] + "\n"})
        counts: dict = {}
        a = L.Archive(bad)
        list(a.nodes(counts))
        list(a.relationships(counts))
        with self.assertRaisesRegex(RuntimeError, "nodes-others.csv"):
            L.check_counts(counts)


class Script(unittest.TestCase):
    def test_stream_load_script(self):
        tmp = tempfile.mkdtemp()
        z = os.path.join(tmp, "a.zip")
        make_zip(z)
        out = io.StringIO()
        counts = L.stream_load(L.Archive(z), out, "https://example.test/full-oldb.zip", "ab" * 32,
                               '"etag-1"', "Wed, 09 Sep 2026 10:55:34 GMT", 1234)
        sql = out.getvalue()
        self.assertEqual(counts["relationships.csv"], 3)
        # one transaction: stage, guard, journal, truncate + refill, commit
        order = ["BEGIN;", "COPY icij_stage_nodes", "COPY icij_stage_rels", "duplicate (node_id, node_type)",
                 "min ratio", "INSERT INTO icij_snapshots", "TRUNCATE icij_relationships", "TRUNCATE icij_nodes",
                 "INSERT INTO icij_nodes", "INSERT INTO icij_relationships", "COMMIT;", "ANALYZE icij_nodes"]
        pos = [sql.index(s) for s in order]
        self.assertEqual(pos, sorted(pos))
        self.assertEqual(sql.count("\n\\.\n"), 2)
        self.assertIn("'2026-09-09'::date", sql)
        self.assertIn("'\"etag-1\"'", sql)
        self.assertIn(json.dumps(counts).replace("'", "''"), sql)
        copy_nodes = sql.split("COPY icij_stage_nodes")[1].split("\\.\n")[0].splitlines()[1:]
        self.assertEqual(len(copy_nodes), 7)
        self.assertTrue(all(len(line.split("\t")) == len(L.NODE_COLUMNS) for line in copy_nodes))

    def test_dry_run_needs_no_database(self):
        tmp = tempfile.mkdtemp()
        z = os.path.join(tmp, "a.zip")
        make_zip(z)
        saved = L.psql_cmd
        L.psql_cmd = lambda: (_ for _ in ()).throw(AssertionError("psql called in a dry run"))
        try:
            self.assertEqual(L.main(["--file", z, "--dry-run"]), 0)
        finally:
            L.psql_cmd = saved


if __name__ == "__main__":
    unittest.main()
