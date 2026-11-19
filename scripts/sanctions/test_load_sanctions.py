#!/usr/bin/env python3
"""Parser tests for load_sanctions.py on small synthetic fixtures (no network, no database).

The fixtures copy the element and attribute layout of the official files as published in
November 2026 (OFAC SDN.XML / CONSOLIDATED.XML, FCDO UK-Sanctions-List.xml, EU FSF XML 1.1);
names and numbers in them are invented.

Run:  python3 -I scripts/sanctions/test_load_sanctions.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load_sanctions as L  # noqa: E402

OFAC_XML = b"""<?xml version="1.0" standalone="yes"?>
<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation>
    <Publish_Date>11/19/2026</Publish_Date>
    <Record_Count>2</Record_Count>
  </publshInformation>
  <sdnEntry>
    <uid>9001</uid>
    <firstName>Ivan</firstName>
    <lastName>TESTOV</lastName>
    <title>Director of TEST BANK</title>
    <sdnType>Individual</sdnType>
    <programList><program>RUSSIA-EO14024</program><program>UKRAINE-EO13662</program></programList>
    <idList>
      <id><uid>1</uid><idType>Passport</idType><idNumber>AB123456</idNumber><idCountry>Russia</idCountry></id>
      <id><uid>2</uid><idType>Gender</idType><idNumber>Male</idNumber></id>
    </idList>
    <akaList>
      <aka><uid>3</uid><type>a.k.a.</type><category>strong</category><lastName>TESTOFF</lastName><firstName>Ivan</firstName></aka>
    </akaList>
    <addressList>
      <address><uid>4</uid><address1>1 Test St</address1><city>Moscow</city><country>Russia</country></address>
    </addressList>
    <nationalityList><nationality><uid>5</uid><country>Russia</country><mainEntry>true</mainEntry></nationality></nationalityList>
    <dateOfBirthList>
      <dateOfBirthItem><uid>6</uid><dateOfBirth>01 Jan 1970</dateOfBirth><mainEntry>true</mainEntry></dateOfBirthItem>
      <dateOfBirthItem><uid>7</uid><dateOfBirth>1971</dateOfBirth><mainEntry>false</mainEntry></dateOfBirthItem>
    </dateOfBirthList>
    <placeOfBirthList><placeOfBirthItem><uid>8</uid><placeOfBirth>Tula, Russia</placeOfBirth><mainEntry>true</mainEntry></placeOfBirthItem></placeOfBirthList>
    <remarks>Test remark.</remarks>
  </sdnEntry>
  <sdnEntry>
    <uid>9002</uid>
    <lastName>TEST VESSEL</lastName>
    <sdnType>Vessel</sdnType>
    <programList><program>IRAN</program></programList>
    <vesselInfo>
      <callSign>ABCD</callSign><vesselType>Crude Oil Tanker</vesselType><vesselFlag>Panama</vesselFlag>
      <vesselOwner>TEST SHIPPING</vesselOwner><tonnage>1000</tonnage><grossRegisteredTonnage>2000</grossRegisteredTonnage>
    </vesselInfo>
  </sdnEntry>
</sdnList>
"""

UK_XML = """<?xml version="1.0" encoding="utf-8"?>
<Designations xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <DateGenerated>17/11/2026</DateGenerated>
  <Designation>
    <LastUpdated>04/08/2026</LastUpdated>
    <DateDesignated>15/03/2022</DateDesignated>
    <UniqueID>RUS9999</UniqueID>
    <OFSIGroupID>99999</OFSIGroupID>
    <Names>
      <Name><Name1>Ivan</Name1><Name2>Ivanovich</Name2><Name6>TESTOV</Name6><NameType>Primary Name</NameType></Name>
      <Name><Name1>Ivan</Name1><Name6>TESTOFF</Name6><NameType>Alias</NameType><AliasStrength>Good quality</AliasStrength></Name>
      <Name><Name1>Ivan</Name1><Name2>Ivanovich</Name2><Name6>TESTOV</Name6><NameType>Primary name variation</NameType></Name>
    </Names>
    <NonLatinNames>
      <NonLatinName><NameNonLatinScript>Иван Иванович ТЕСТОВ</NameNonLatinScript><NonLatinScriptType>Cyrillic</NonLatinScriptType><NonLatinScriptLanguage>Russian</NonLatinScriptLanguage></NonLatinName>
    </NonLatinNames>
    <Titles><Title>Mr</Title></Titles>
    <RegimeName>The Russia (Sanctions) (EU Exit) Regulations 2019</RegimeName>
    <IndividualEntityShip>Individual</IndividualEntityShip>
    <DesignationSource>UK</DesignationSource>
    <SanctionsImposed>Asset freeze|Travel Ban</SanctionsImposed>
    <SanctionsImposedIndicators><AssetFreeze>true</AssetFreeze><TravelBan>true</TravelBan><ArmsEmbargo>false</ArmsEmbargo></SanctionsImposedIndicators>
    <OtherInformation>Test information.</OtherInformation>
    <UKStatementofReasons>Involved in a test.</UKStatementofReasons>
    <Addresses><Address><AddressLine1>1 Test St</AddressLine1><AddressLine6>Moscow</AddressLine6><AddressCountry>Russia</AddressCountry></Address></Addresses>
    <PhoneNumbers><PhoneNumber>+7 000 000</PhoneNumber></PhoneNumbers>
    <IndividualDetails>
      <Individual>
        <DOBs><DOB>01/01/1970</DOB><DOB>dd/mm/1971</DOB></DOBs>
        <Nationalities><Nationality>Russia</Nationality></Nationalities>
        <PassportDetails>
          <Passport><PassportNumber>AB123456</PassportNumber><PassportAdditionalInformation>Russian passport</PassportAdditionalInformation></Passport>
          <Passport><PassportNumber>AB123456</PassportNumber><PassportAdditionalInformation>Russian passport</PassportAdditionalInformation></Passport>
        </PassportDetails>
        <Positions><Position>Director of TEST BANK</Position></Positions>
        <Genders><Gender>Male</Gender></Genders>
        <BirthDetails><Location><TownOfBirth>Tula</TownOfBirth><CountryOfBirth>Russia</CountryOfBirth></Location></BirthDetails>
      </Individual>
    </IndividualDetails>
  </Designation>
  <Designation>
    <LastUpdated>01/10/2026</LastUpdated>
    <DateDesignated>01/10/2026</DateDesignated>
    <UniqueID>RUS9998</UniqueID>
    <Names><Name><Name6>TEST TANKER</Name6><NameType>Primary name</NameType></Name></Names>
    <RegimeName>The Russia (Sanctions) (EU Exit) Regulations 2019</RegimeName>
    <IndividualEntityShip>Ship</IndividualEntityShip>
    <DesignationSource>UK</DesignationSource>
    <SanctionsImposed>Ship specification</SanctionsImposed>
    <ShipDetails><Ship><IMONumbers><IMONumber>IMO1234567</IMONumber></IMONumbers><CurrentBelievedFlagOfShips><CurrentBelievedFlagOfShip>Gabon</CurrentBelievedFlagOfShip></CurrentBelievedFlagOfShips></Ship></ShipDetails>
  </Designation>
</Designations>
""".encode("utf-8")

EU_XML = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-10-23T17:05:43.888+02:00" globalFileId="1">
  <sanctionEntity designationDetails="" unitedNationId="" euReferenceNumber="EU.1.1" logicalId="501">
    <remark>Test remark</remark>
    <regulation regulationType="amendment" organisationType="council" publicationDate="2022-02-23" entryIntoForceDate="2022-02-23" numberTitle="2022/261 (OJ L42I)" programme="UKR" logicalId="1">
      <publicationUrl>https://eur-lex.europa.eu/test</publicationUrl>
    </regulation>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Ivan" middleName="" lastName="Testov" wholeName="Ivan Testov" function="Director" gender="M" title="" nameLanguage="" strong="true" regulationLanguage="en" logicalId="2"/>
    <nameAlias firstName="" middleName="" lastName="" wholeName="\xd0\x98\xd0\xb2\xd0\xb0\xd0\xbd \xd0\xa2\xd0\xb5\xd1\x81\xd1\x82\xd0\xbe\xd0\xb2" function="" title="" nameLanguage="RU" strong="true" regulationLanguage="en" logicalId="3"/>
    <nameAlias firstName="" middleName="" lastName="" wholeName="Ivan Testov" function="" title="" nameLanguage="EN" strong="false" regulationLanguage="en" logicalId="4"/>
    <citizenship region="" countryIso2Code="RU" countryDescription="RUSSIA" regulationLanguage="en" logicalId="5"/>
    <birthdate circa="false" calendarType="GREGORIAN" city="Tula" birthdate="1970-01-01" year="1970" countryDescription="RUSSIA" regulationLanguage="en" logicalId="6"/>
    <identification diplomatic="false" knownExpired="false" knownFalse="false" reportedLost="false" revokedByIssuer="false" issuedBy="" latinNumber="" nameOnDocument="" number="AB123456" region="" identificationTypeCode="passport" identificationTypeDescription="National passport" countryIso2Code="RU" countryDescription="RUSSIA" regulationLanguage="en" logicalId="7">
      <remark>valid until 2030</remark>
    </identification>
    <address city="Moscow" street="1 Test St" poBox="" zipCode="" region="" place="" asAtListingTime="false" countryIso2Code="RU" countryDescription="RUSSIA" regulationLanguage="en" logicalId="8"/>
  </sanctionEntity>
  <sanctionEntity designationDetails="" unitedNationId="QDe.001" euReferenceNumber="EU.2.2" logicalId="502">
    <regulation regulationType="regulation" organisationType="commission" publicationDate="2002-05-29" entryIntoForceDate="" numberTitle="881/2002 (OJ L139)" programme="TAQA" logicalId="9"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="Test Front" strong="true" logicalId="10"/>
  </sanctionEntity>
</export>
"""


class OfacTest(unittest.TestCase):
    def setUp(self):
        self.snap = L.parse_ofac(OFAC_XML, "sdn", "ofac_sdn")
        L.check_snapshot(self.snap)
        self.by = {r["uid"]: r for r in self.snap.rows}

    def test_snapshot(self):
        self.assertEqual(self.snap.snapshot_date, "2026-11-19")
        self.assertEqual(self.snap.declared_count, 2)
        self.assertEqual(len(self.snap.rows), 2)
        self.assertEqual(self.snap.scope_sql, "entry_type = 'sdn'")

    def test_individual(self):
        r = self.by["9001"]
        self.assertEqual(r["sdn_name"], "Ivan TESTOV")
        self.assertEqual(r["programs"], ["RUSSIA-EO14024", "UKRAINE-EO13662"])
        self.assertEqual(r["program"], "RUSSIA-EO14024; UKRAINE-EO13662")
        self.assertEqual(r["aliases"], [{"type": "a.k.a.", "category": "strong", "name": "Ivan TESTOFF"}])
        self.assertIn({"type": "Passport", "number": "AB123456", "country": "Russia"}, r["ids"])
        self.assertEqual(r["dates_of_birth"][0], {"date": "01 Jan 1970", "main": True})
        self.assertEqual(r["places_of_birth"], [{"place": "Tula, Russia", "main": True}])
        self.assertEqual(r["nationalities"], ["Russia"])
        self.assertEqual(r["addresses"], [{"address1": "1 Test St", "city": "Moscow", "country": "Russia"}])

    def test_vessel(self):
        r = self.by["9002"]
        self.assertEqual((r["sdn_type"], r["call_sign"], r["vessel_flag"], r["grt"]),
                         ("Vessel", "ABCD", "Panama", "2000"))

    def test_record_count_mismatch_is_an_error(self):
        snap = L.parse_ofac(OFAC_XML.replace(b"<Record_Count>2<", b"<Record_Count>3<"), "sdn", "ofac_sdn")
        with self.assertRaises(RuntimeError):
            L.check_snapshot(snap)

    def test_consolidated_scope(self):
        snap = L.parse_ofac(OFAC_XML, "consolidated", "ofac_consolidated")
        self.assertEqual({r["entry_type"] for r in snap.rows}, {"consolidated"})


class UkTest(unittest.TestCase):
    def setUp(self):
        self.snap = L.parse_uk(UK_XML)
        L.check_snapshot(self.snap)
        self.by = {r["unique_id"]: r for r in self.snap.rows}

    def test_snapshot(self):
        self.assertEqual(self.snap.snapshot_date, "2026-11-17")
        self.assertEqual(len(self.snap.rows), 2)

    def test_individual(self):
        r = self.by["RUS9999"]
        self.assertEqual(r["name"], "Ivan Ivanovich TESTOV")
        self.assertEqual(r["name_aliases"], ["Ivan TESTOFF", "Иван Иванович ТЕСТОВ"])
        self.assertEqual(r["date_designated"], "2022-03-15")
        self.assertEqual(r["last_updated"], "2026-08-04")
        self.assertEqual(r["regime_name"], "The Russia (Sanctions) (EU Exit) Regulations 2019")
        self.assertEqual(r["sanctions_indicators"], {"AssetFreeze": True, "TravelBan": True, "ArmsEmbargo": False})
        self.assertEqual(r["dates_of_birth"], ["01/01/1970", "dd/mm/1971"])
        self.assertEqual(r["birth_places"], [{"town": "Tula", "country": "Russia"}])
        # the duplicated passport is kept once
        self.assertEqual(r["identifications"],
                         [{"type": "Passport", "number": "AB123456", "details": "Russian passport"}])
        self.assertEqual(r["contacts"], {"phones": ["+7 000 000"]})
        self.assertEqual(r["addresses"], [{"lines": ["1 Test St", "Moscow"], "country": "Russia"}])
        self.assertEqual(r["statement_of_reasons"], "Involved in a test.")

    def test_ship(self):
        r = self.by["RUS9998"]
        self.assertEqual(r["entity_type"], "Ship")
        self.assertEqual(r["name"], "TEST TANKER")
        self.assertEqual(r["identifications"], [{"type": "IMO number", "number": "IMO1234567"}])
        self.assertEqual(r["ship_details"], {"imo_numbers": ["IMO1234567"], "current_flags": ["Gabon"]})

    def test_url_from_govuk_record(self):
        record = {"details": {"attachments": [
            {"url": "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.ods"},
            {"url": "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml"},
            {"url": "https://assets.publishing.service.gov.uk/media/x/SanctionsListSchema-4.33.3.xsd"},
        ]}}
        self.assertEqual(L.uk_xml_url(record), "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml")
        self.assertEqual(L.uk_xml_url({}), L.UK_XML_FALLBACK)


class EuTest(unittest.TestCase):
    def setUp(self):
        self.snap = L.parse_eu(EU_XML)
        L.check_snapshot(self.snap)
        self.by = {r["entity_id"]: r for r in self.snap.rows}

    def test_snapshot(self):
        self.assertEqual(self.snap.snapshot_date, "2026-10-23")
        self.assertEqual(len(self.snap.rows), 2)

    def test_person(self):
        r = self.by["501"]
        self.assertEqual(r["entity_type"], "person")
        self.assertEqual(r["name"], "Ivan Testov")
        self.assertEqual(r["name_aliases"], ["Иван Тестов"])
        self.assertEqual(r["eu_reference_number"], "EU.1.1")
        self.assertEqual(r["programme"], "UKR")
        self.assertEqual(r["regulation_basis"], "2022/261 (OJ L42I)")
        self.assertEqual(r["listing_date"], "2022-02-23")
        self.assertEqual(r["birth_date"], "1970-01-01")
        self.assertEqual(r["birth_place"], "Tula, RUSSIA")
        self.assertEqual(r["citizenship"], ["RUSSIA"])
        self.assertEqual(r["addresses"], ["1 Test St, Moscow, RUSSIA"])
        self.assertEqual(r["identifications"], [{"type": "National passport", "number": "AB123456",
                                                 "country": "RUSSIA", "remark": "valid until 2030"}])
        self.assertEqual(r["remark"], "Test remark")

    def test_entity(self):
        r = self.by["502"]
        self.assertEqual((r["entity_type"], r["un_reference_number"], r["listing_date"], r["programme"]),
                         ("enterprise", "QDe.001", "2002-05-29", "TAQA"))

    def test_url_from_data_europa_record(self):
        record = {"result": {"distributions": [
            {"download_url": ["https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=abc"]},
            {"access_url": ["https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=abc"]},
        ]}}
        url = L.eu_xml_url(record)
        self.assertIn("xmlFullSanctionsList_1_1", url)
        self.assertEqual(L.strip_token(url),
                         "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content")
        with self.assertRaises(RuntimeError):
            L.eu_xml_url({"result": {"distributions": []}})


class CopyFormatTest(unittest.TestCase):
    def test_values(self):
        self.assertEqual(L.copy_value(None), r"\N")
        self.assertEqual(L.copy_value("a\tb\nc\\d"), "a\\tb\\nc\\\\d")
        self.assertEqual(L.copy_value(["x", 'y"z']), '{"x","y\\\\"z"}')
        self.assertEqual(json.loads(L.copy_value({"k": "в"})), {"k": "в"})

    def test_row_jsonb_lists(self):
        snap = L.parse_uk(UK_XML)
        row = next(r for r in snap.rows if r["unique_id"] == "RUS9998")
        cells = L.copy_row(snap, row).split("\t")
        col = dict(zip(snap.columns, cells))
        self.assertEqual(col["non_latin_names"], "[]")   # jsonb list column, empty
        self.assertEqual(col["nationalities"], r"\N")    # text[] column, empty
        self.assertEqual(len(cells), len(snap.columns))

    def test_dates(self):
        self.assertEqual(L.parse_dmy("dd/mm/1945"), None)
        self.assertEqual(L.parse_dmy("31/02/2020"), None)
        self.assertEqual(L.parse_mdy("11/19/2026"), "2026-11-19")


if __name__ == "__main__":
    unittest.main()
