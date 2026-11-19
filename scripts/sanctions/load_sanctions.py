#!/usr/bin/env python3
"""
Load the EU, UK and US (OFAC) sanctions lists from their official publishers (LEXAI-2299).

  list               source                                               table
  ofac_sdn           OFAC SDN.XML (sanctionslistservice.ofac.treas.gov)    us_ofac_sanctions (entry_type 'sdn')
  ofac_consolidated  OFAC CONSOLIDATED.XML (non-SDN lists)                 us_ofac_sanctions (entry_type 'consolidated')
  uk_fcdo            UK Sanctions List, FCDO XML (sanctionslist.fcdo.gov.uk) uk_sanctions
  eu_fsf             EU Financial Sanctions Files, XML 1.1                 eu_sanctions

OpenSanctions is not used (CC BY-NC). The OFSI Consolidated List closed on 28.01.2026, so the UK
list comes from the FCDO UK Sanctions List; its file URL is read from the gov.uk publication record
at load time. The EU FSF URL carries a public token that the Commission rotates: it is read from the
data.europa.eu dataset record at load time and is never stored (source_url is kept without it).

Each list is one full snapshot. A load stages every row with COPY, upserts it into the table, deletes
the entries of that list the publisher no longer lists, and journals the file in
intl_sanctions_snapshots — all in one transaction. A file whose sha256 is already journalled is
skipped. A snapshot with fewer than SANCTIONS_MIN_RATIO (default 0.5) of the rows the table holds for
that list aborts the transaction, so a truncated download cannot wipe the table.

Usage:
  load_sanctions.py --list all                    # download and load the four lists
  load_sanctions.py --list uk_fcdo --list eu_fsf
  load_sanctions.py --list ofac_sdn --file SDN.XML [--source-url URL] [--force]
  load_sanctions.py --list all --dry-run          # download and parse only, print counts

Database access goes through the psql client, so the script needs only the Python standard library:
  DATABASE_URL=postgresql://...  -> psql "$DATABASE_URL"
  otherwise                      -> docker exec -i $PG_CONTAINER psql -U $PGUSER -d $PGDATABASE
                                    (defaults: secondlayer-postgres-local / secondlayer / secondlayer_local)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Callable, Iterable

USER_AGENT = "SecondLayer-opendata-sync/1.0 (sanctions loader)"
HTTP_TIMEOUT = int(os.environ.get("SANCTIONS_HTTP_TIMEOUT", "300"))
MIN_RATIO = float(os.environ.get("SANCTIONS_MIN_RATIO", "0.5"))

OFAC_SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"
OFAC_CONS_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML"
UK_PUBLICATION_API = "https://www.gov.uk/api/content/government/publications/the-uk-sanctions-list"
UK_XML_FALLBACK = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml"
EU_DATASET_API = ("https://data.europa.eu/api/hub/search/datasets/"
                  "consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions")
EU_FILE_MARKER = "xmlFullSanctionsList_1_1"


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── Small helpers ────────────────────────────────────────────────────────


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def kids(el: ET.Element | None, name: str) -> list[ET.Element]:
    return [c for c in el if local(c.tag) == name] if el is not None else []


def kid(el: ET.Element | None, name: str) -> ET.Element | None:
    for c in (el if el is not None else []):
        if local(c.tag) == name:
            return c
    return None


def text(el: ET.Element | None, name: str | None = None) -> str | None:
    """Stripped text of el (or of its first child called name); None when empty."""
    node = kid(el, name) if name else el
    if node is None or node.text is None:
        return None
    s = node.text.strip()
    return s or None


def texts(el: ET.Element | None, *path: str) -> list[str]:
    """Texts of every element reached by following path of child names."""
    nodes = [el] if el is not None else []
    for name in path:
        nodes = [c for n in nodes for c in kids(n, name)]
    return [t for t in (text(n) for n in nodes) if t]


def attr(el: ET.Element | None, key: str) -> str | None:
    if el is None:
        return None
    v = (el.get(key) or "").strip()
    return v or None


def dedup(values: Iterable[str | None], exclude: Iterable[str | None] = ()) -> list[str]:
    seen = {e.casefold() for e in exclude if e}
    out = []
    for v in values:
        if v and v.casefold() not in seen:
            seen.add(v.casefold())
            out.append(v)
    return out


def drop_empty(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def parse_dmy(s: str | None, sep: str = "/") -> str | None:
    """'17/11/2026' -> '2026-11-17'; None for partial dates such as 'dd/mm/1945'."""
    m = re.fullmatch(rf"(\d{{1,2}}){sep}(\d{{1,2}}){sep}(\d{{4}})", (s or "").strip())
    if not m:
        return None
    try:
        return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        return None


def parse_mdy(s: str | None) -> str | None:
    """OFAC Publish_Date '11/19/2026' -> '2026-11-19'."""
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", (s or "").strip())
    if not m:
        return None
    try:
        return dt.date(int(m[3]), int(m[1]), int(m[2])).isoformat()
    except ValueError:
        return None


def parse_iso_date(s: str | None) -> str | None:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", (s or "").strip())
    if not m:
        return None
    try:
        return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def strip_token(url: str) -> str:
    """Drop access tokens from a URL before it is stored."""
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in ("token", "x-amz-security-token", "x-amz-signature", "x-amz-credential")]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


# ─── Parsed snapshot ──────────────────────────────────────────────────────


@dataclass
class Snapshot:
    list_name: str
    table: str
    key: list[str]
    columns: list[str]
    rows: list[dict] = field(default_factory=list)
    snapshot_date: str | None = None
    declared_count: int | None = None
    skipped: int = 0
    # rows of this list in the table (for the stale-entry delete and the ratio guard)
    scope_sql: str = "TRUE"


# ─── OFAC (legacy SDN XML schema, shared by SDN.XML and CONSOLIDATED.XML) ──

OFAC_COLUMNS = [
    "uid", "entry_type", "sdn_name", "first_name", "last_name", "sdn_type", "program", "programs",
    "title", "remarks", "call_sign", "vessel_type", "tonnage", "grt", "vessel_flag", "vessel_owner",
    "addresses", "aliases", "ids", "dates_of_birth", "places_of_birth", "nationalities", "citizenships",
    "snapshot_date", "source_url",
]


def ofac_name(first: str | None, last: str | None) -> str | None:
    return " ".join(p for p in (first, last) if p) or None


def parse_ofac(data: bytes, entry_type: str, list_name: str) -> Snapshot:
    root = ET.fromstring(data)
    if local(root.tag) != "sdnList":
        raise ValueError(f"{list_name}: root element is <{local(root.tag)}>, expected <sdnList>")
    info = kid(root, "publshInformation")
    snap = Snapshot(list_name, "us_ofac_sanctions", ["uid", "entry_type"], OFAC_COLUMNS,
                    snapshot_date=parse_mdy(text(info, "Publish_Date")),
                    scope_sql=f"entry_type = '{entry_type}'")
    rc = text(info, "Record_Count")
    snap.declared_count = int(rc) if rc and rc.isdigit() else None

    for e in kids(root, "sdnEntry"):
        uid = text(e, "uid")
        first, last = text(e, "firstName"), text(e, "lastName")
        name = ofac_name(first, last)
        if not uid or not name:
            snap.skipped += 1
            continue
        programs = texts(e, "programList", "program")
        aliases = [drop_empty({
            "type": text(a, "type"), "category": text(a, "category"),
            "name": ofac_name(text(a, "firstName"), text(a, "lastName")),
        }) for a in kids(kid(e, "akaList"), "aka")]
        addresses = [drop_empty({
            "address1": text(a, "address1"), "address2": text(a, "address2"),
            "address3": text(a, "address3"), "city": text(a, "city"),
            "stateOrProvince": text(a, "stateOrProvince"), "postalCode": text(a, "postalCode"),
            "country": text(a, "country"),
        }) for a in kids(kid(e, "addressList"), "address")]
        ids = [drop_empty({
            "type": text(i, "idType"), "number": text(i, "idNumber"), "country": text(i, "idCountry"),
            "issue_date": text(i, "issueDate"), "expiration_date": text(i, "expirationDate"),
        }) for i in kids(kid(e, "idList"), "id")]
        dobs = [drop_empty({"date": text(d, "dateOfBirth"), "main": text(d, "mainEntry") == "true"})
                for d in kids(kid(e, "dateOfBirthList"), "dateOfBirthItem")]
        pobs = [drop_empty({"place": text(p, "placeOfBirth"), "main": text(p, "mainEntry") == "true"})
                for p in kids(kid(e, "placeOfBirthList"), "placeOfBirthItem")]
        v = kid(e, "vesselInfo")
        snap.rows.append({
            "uid": uid, "entry_type": entry_type, "sdn_name": name,
            "first_name": first, "last_name": last, "sdn_type": text(e, "sdnType"),
            "program": "; ".join(programs) or None, "programs": programs,
            "title": text(e, "title"), "remarks": text(e, "remarks"),
            "call_sign": text(v, "callSign"), "vessel_type": text(v, "vesselType"),
            "tonnage": text(v, "tonnage"), "grt": text(v, "grossRegisteredTonnage"),
            "vessel_flag": text(v, "vesselFlag"), "vessel_owner": text(v, "vesselOwner"),
            "addresses": [a for a in addresses if a], "aliases": [a for a in aliases if a.get("name")],
            "ids": [i for i in ids if i], "dates_of_birth": [d for d in dobs if d.get("date")],
            "places_of_birth": [p for p in pobs if p.get("place")],
            "nationalities": dedup(texts(e, "nationalityList", "nationality", "country")),
            "citizenships": dedup(texts(e, "citizenshipList", "citizenship", "country")),
            "snapshot_date": snap.snapshot_date,
        })
    return snap


# ─── UK Sanctions List (FCDO XML) ─────────────────────────────────────────

UK_COLUMNS = [
    "unique_id", "ofsi_group_id", "un_reference_number", "entity_type", "name", "name_aliases",
    "names", "non_latin_names", "regime_name", "designation_source", "sanctions_imposed",
    "sanctions_indicators", "date_designated", "last_updated", "dates_of_birth", "birth_places",
    "nationalities", "genders", "positions", "titles", "addresses", "identifications", "contacts",
    "entity_details", "ship_details", "other_information", "statement_of_reasons",
    "snapshot_date", "source_url",
]


def uk_full_name(n: ET.Element) -> str | None:
    # Name1 = forename, Name2..Name5 = further names, Name6 = surname or the entity/ship name.
    return " ".join(p for p in (text(n, f"Name{i}") for i in range(1, 7)) if p) or None


def parse_uk(data: bytes) -> Snapshot:
    root = ET.fromstring(data)
    if local(root.tag) != "Designations":
        raise ValueError(f"uk_fcdo: root element is <{local(root.tag)}>, expected <Designations>")
    snap = Snapshot("uk_fcdo", "uk_sanctions", ["unique_id"], UK_COLUMNS,
                    snapshot_date=parse_dmy(text(root, "DateGenerated")))

    for d in kids(root, "Designation"):
        uid = text(d, "UniqueID")
        names = []
        for n in kids(kid(d, "Names"), "Name"):
            full = uk_full_name(n)
            if full:
                names.append(drop_empty({"name": full, "type": text(n, "NameType"),
                                         "strength": text(n, "AliasStrength")}))
        primary = next((n["name"] for n in names if (n.get("type") or "").lower() == "primary name"),
                       names[0]["name"] if names else None)
        if not uid or not primary:
            snap.skipped += 1
            continue
        non_latin = [drop_empty({"name": text(n, "NameNonLatinScript"),
                                 "script": text(n, "NonLatinScriptType"),
                                 "language": text(n, "NonLatinScriptLanguage")})
                     for n in kids(kid(d, "NonLatinNames"), "NonLatinName")]
        non_latin = [n for n in non_latin if n.get("name")]

        ind = kid(kid(d, "IndividualDetails"), "Individual")
        ent = kid(kid(d, "EntityDetails"), "Entity")
        ship = kid(kid(d, "ShipDetails"), "Ship")

        ids = []
        for p in kids(kid(ind, "PassportDetails"), "Passport"):
            ids.append(drop_empty({"type": "Passport", "number": text(p, "PassportNumber"),
                                   "details": text(p, "PassportAdditionalInformation")}))
        for p in kids(kid(ind, "NationalIdentifierDetails"), "NationalIdentifier"):
            ids.append(drop_empty({"type": "National identifier",
                                   "number": text(p, "NationalIdentifierNumber"),
                                   "details": text(p, "NationalIdentifierAdditionalInformation")}))
        for num in texts(ent, "BusinessRegistrationNumbers", "BusinessRegistrationNumber"):
            ids.append({"type": "Business registration number", "number": num})
        for num in texts(ship, "IMONumbers", "IMONumber"):
            ids.append({"type": "IMO number", "number": num})
        for num in texts(ship, "HullIdentificationNumbers", "HullIdentificationNumber"):
            ids.append({"type": "Hull identification number", "number": num})
        # The file repeats identical documents (one copy per name variant): keep each once.
        uniq_ids = list({json.dumps(i, sort_keys=True, ensure_ascii=False): i for i in ids if i}.values())

        addresses = []
        for a in kids(kid(d, "Addresses"), "Address"):
            lines = [text(a, f"AddressLine{i}") for i in range(1, 7)]
            addr = drop_empty({"lines": [x for x in lines if x], "postal_code": text(a, "AddressPostalCode"),
                               "country": text(a, "AddressCountry")})
            if addr:
                addresses.append(addr)

        ind_el = kid(d, "SanctionsImposedIndicators")
        indicators = {local(c.tag): (c.text or "").strip().lower() == "true"
                      for c in (list(ind_el) if ind_el is not None else [])}

        birth_places = [drop_empty({"town": text(loc, "TownOfBirth"), "country": text(loc, "CountryOfBirth")})
                        for loc in kids(kid(ind, "BirthDetails"), "Location")]

        snap.rows.append({
            "unique_id": uid,
            "ofsi_group_id": text(d, "OFSIGroupID"),
            "un_reference_number": text(d, "UNReferenceNumber"),
            "entity_type": text(d, "IndividualEntityShip") or "Unknown",
            "name": primary,
            "name_aliases": dedup([n["name"] for n in names] + [n["name"] for n in non_latin], exclude=[primary]),
            "names": names,
            "non_latin_names": non_latin,
            "regime_name": text(d, "RegimeName"),
            "designation_source": text(d, "DesignationSource"),
            "sanctions_imposed": text(d, "SanctionsImposed"),
            "sanctions_indicators": indicators or None,
            "date_designated": parse_dmy(text(d, "DateDesignated")),
            "last_updated": parse_dmy(text(d, "LastUpdated")),
            "dates_of_birth": dedup(texts(ind, "DOBs", "DOB")),
            "birth_places": [b for b in birth_places if b],
            "nationalities": dedup(texts(ind, "Nationalities", "Nationality")),
            "genders": dedup(texts(ind, "Genders", "Gender")),
            "positions": dedup(texts(ind, "Positions", "Position")),
            "titles": dedup(texts(d, "Titles", "Title")),
            "addresses": addresses,
            "identifications": uniq_ids,
            "contacts": drop_empty({"phones": dedup(texts(d, "PhoneNumbers", "PhoneNumber")),
                                    "emails": dedup(texts(d, "EmailAddresses", "EmailAddress")),
                                    "websites": dedup(texts(d, "Websites", "Website"))}) or None,
            "entity_details": drop_empty({
                "types": dedup(texts(ent, "TypeOfEntities", "TypeOfEntity")),
                "parent_companies": dedup(texts(ent, "ParentCompanies", "ParentCompany")),
                "subsidiaries": dedup(texts(ent, "Subsidiaries", "Subsidiary")),
            }) or None,
            "ship_details": drop_empty({
                "imo_numbers": dedup(texts(ship, "IMONumbers", "IMONumber")),
                "current_owner_operators": dedup(texts(ship, "CurrentOwnerOperators", "CurrentOwnerOperator")),
                "previous_owner_operators": dedup(texts(ship, "PreviousOwnerOperators", "PreviousOwnerOperator")),
                "current_flags": dedup(texts(ship, "CurrentBelievedFlagOfShips", "CurrentBelievedFlagOfShip")),
                "previous_flags": dedup(texts(ship, "PreviousFlags", "PreviousFlag")),
                "types": dedup(texts(ship, "TypeOfShipDetails", "TypeOfShip")),
                "tonnage": dedup(texts(ship, "TonnageOfShipDetails", "TonnageOfShip")),
                "length": dedup(texts(ship, "LengthOfShipDetails", "LengthOfShip")),
                "years_built": dedup(texts(ship, "YearsBuilt", "YearBuilt")),
            }) or None,
            "other_information": text(d, "OtherInformation"),
            "statement_of_reasons": text(d, "UKStatementofReasons"),
            "snapshot_date": snap.snapshot_date,
        })
    return snap


# ─── EU Financial Sanctions Files (XML 1.1) ───────────────────────────────

EU_COLUMNS = [
    "entity_id", "entity_type", "name", "name_aliases", "birth_date", "birth_place", "citizenship",
    "addresses", "identifications", "regulation_basis", "listing_date", "programme", "remark",
    "metadata_json", "eu_reference_number", "un_reference_number", "regulations",
    "snapshot_date", "source_url",
]


def parse_eu(data: bytes) -> Snapshot:
    root = ET.fromstring(data)
    if local(root.tag) != "export":
        raise ValueError(f"eu_fsf: root element is <{local(root.tag)}>, expected <export>")
    snap = Snapshot("eu_fsf", "eu_sanctions", ["entity_id"], EU_COLUMNS,
                    snapshot_date=parse_iso_date(attr(root, "generationDate")))

    for e in kids(root, "sanctionEntity"):
        # Keyed by logicalId like the earlier loader (#2117); euReferenceNumber has its own column.
        entity_id = attr(e, "logicalId") or attr(e, "euReferenceNumber")
        aliases = kids(e, "nameAlias")
        whole = [attr(a, "wholeName") for a in aliases]
        strong = next((a for a in aliases if attr(a, "strong") == "true" and attr(a, "wholeName")), None)
        name = attr(strong, "wholeName") if strong is not None else next((w for w in whole if w), None)
        if not entity_id or not name:
            snap.skipped += 1
            continue

        regs = [drop_empty({
            "type": attr(r, "regulationType"), "number_title": attr(r, "numberTitle"),
            "programme": attr(r, "programme"), "publication_date": attr(r, "publicationDate"),
            "entry_into_force_date": attr(r, "entryIntoForceDate"),
            "url": text(r, "publicationUrl"),
        }) for r in kids(e, "regulation")]
        listing_dates = sorted(filter(None, (parse_iso_date(r.get("publication_date") or r.get("entry_into_force_date"))
                                             for r in regs)))
        births = kids(e, "birthdate")
        birth_dates = [attr(b, "birthdate") or attr(b, "year") for b in births]
        birth_places = [", ".join(p for p in (attr(b, "city") or attr(b, "place"), attr(b, "countryDescription")) if p)
                        for b in births]
        addresses = [", ".join(p for p in (attr(a, "street"), attr(a, "poBox"), attr(a, "zipCode"), attr(a, "city"),
                                           attr(a, "place"), attr(a, "region"), attr(a, "countryDescription"))
                               if p and p != "UNKNOWN")
                     for a in kids(e, "address")]
        identifications = [drop_empty({
            "type": attr(i, "identificationTypeDescription") or attr(i, "identificationTypeCode"),
            "number": attr(i, "number") or attr(i, "latinNumber"),
            "country": attr(i, "countryDescription") if attr(i, "countryDescription") != "UNKNOWN" else None,
            "issued_by": attr(i, "issuedBy"), "issue_date": attr(i, "issueDate"),
            "valid_to": attr(i, "validTo"), "name_on_document": attr(i, "nameOnDocument"),
            "diplomatic": attr(i, "diplomatic") == "true" or None,
            "known_false": attr(i, "knownFalse") == "true" or None,
            "remark": "; ".join(texts(i, "remark")) or None,
        }) for i in kids(e, "identification")]
        snap.rows.append({
            "entity_id": entity_id,
            "entity_type": attr(kid(e, "subjectType"), "code") or "unknown",
            "name": name,
            "name_aliases": dedup(whole, exclude=[name]),
            "birth_date": next((b for b in birth_dates if b), None),
            "birth_place": next((p for p in birth_places if p), None),
            "citizenship": dedup(attr(c, "countryDescription") for c in kids(e, "citizenship")
                                 if attr(c, "countryDescription") != "UNKNOWN"),
            "addresses": dedup(addresses),
            "identifications": [i for i in identifications if i],
            "regulation_basis": regs[0].get("number_title") if regs else None,
            "listing_date": listing_dates[0] if listing_dates else None,
            "programme": next((r["programme"] for r in regs if r.get("programme")), None),
            "remark": "; ".join(texts(e, "remark")) or None,
            "metadata_json": drop_empty({
                "designation_details": attr(e, "designationDetails"),
                "name_aliases": [drop_empty({
                    "whole_name": attr(a, "wholeName"), "first_name": attr(a, "firstName"),
                    "middle_name": attr(a, "middleName"), "last_name": attr(a, "lastName"),
                    "function": attr(a, "function"), "title": attr(a, "title"), "gender": attr(a, "gender"),
                    "language": attr(a, "nameLanguage"), "strong": attr(a, "strong") == "true",
                }) for a in aliases],
                "birthdates": [drop_empty({k: attr(b, k) for k in ("birthdate", "year", "circa", "city", "place",
                                                                    "countryDescription")}) for b in births],
            }),
            "eu_reference_number": attr(e, "euReferenceNumber"),
            "un_reference_number": attr(e, "unitedNationId"),
            "regulations": regs,
            "snapshot_date": snap.snapshot_date,
        })
    return snap


# ─── Downloads ────────────────────────────────────────────────────────────


def http_get(url: str, accept: str = "*/*") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {strip_token(url)}: {last}")


def uk_xml_url(record: dict) -> str:
    """XML file URL from the gov.uk content API record of «The UK Sanctions List»."""
    for a in record.get("details", {}).get("attachments", []):
        url = a.get("url") or ""
        if url.lower().endswith(".xml") and "sanctions-list" in url.lower():
            return url
    return UK_XML_FALLBACK


def eu_xml_url(record: dict) -> str:
    """FSF XML 1.1 URL (with its current public token) from the data.europa.eu dataset record."""
    result = record.get("result", record)
    for dist in result.get("distributions", []):
        for url in (dist.get("download_url") or []) + (dist.get("access_url") or []):
            if EU_FILE_MARKER in url:
                return url
    raise RuntimeError(f"data.europa.eu record has no {EU_FILE_MARKER} distribution")


def resolve_url(list_name: str) -> str:
    if list_name == "ofac_sdn":
        return OFAC_SDN_URL
    if list_name == "ofac_consolidated":
        return OFAC_CONS_URL
    if list_name == "uk_fcdo":
        try:
            return uk_xml_url(json.loads(http_get(UK_PUBLICATION_API, "application/json")))
        except Exception as e:  # noqa: BLE001 - the docs URL has been stable since 2022
            log(f"uk_fcdo: gov.uk record unavailable ({e}); using {UK_XML_FALLBACK}")
            return UK_XML_FALLBACK
    if list_name == "eu_fsf":
        return eu_xml_url(json.loads(http_get(EU_DATASET_API, "application/json")))
    raise ValueError(list_name)


PARSERS: dict[str, Callable[[bytes], Snapshot]] = {
    "ofac_sdn": lambda b: parse_ofac(b, "sdn", "ofac_sdn"),
    "ofac_consolidated": lambda b: parse_ofac(b, "consolidated", "ofac_consolidated"),
    "uk_fcdo": parse_uk,
    "eu_fsf": parse_eu,
}
LISTS = list(PARSERS)


def check_snapshot(snap: Snapshot) -> None:
    if not snap.rows:
        raise RuntimeError(f"{snap.list_name}: no entries parsed")
    keys = [tuple(r[k] for k in snap.key) for r in snap.rows]
    if len(set(keys)) != len(keys):
        raise RuntimeError(f"{snap.list_name}: duplicate keys in the file")
    if snap.declared_count is not None and snap.declared_count != len(snap.rows) + snap.skipped:
        raise RuntimeError(f"{snap.list_name}: file declares {snap.declared_count} records, "
                           f"parsed {len(snap.rows) + snap.skipped}")


# ─── Database (psql) ──────────────────────────────────────────────────────


def psql_cmd() -> list[str]:
    base = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    url = os.environ.get("DATABASE_URL")
    if url:
        return ["psql", url, *base]
    return ["docker", "exec", "-i", os.environ.get("PG_CONTAINER", "secondlayer-postgres-local"),
            "psql", "-U", os.environ.get("PGUSER", "secondlayer"),
            "-d", os.environ.get("PGDATABASE", "secondlayer_local"), *base]


def psql(sql: str) -> str:
    r = subprocess.run(psql_cmd(), input=sql, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[-2000:]}")
    return r.stdout


def lit(s: str | None) -> str:
    return "NULL" if s is None else "'" + s.replace("'", "''") + "'"


def pg_array(values: list) -> str:
    return "{" + ",".join('"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"' for v in values) + "}"


def copy_value(v) -> str:
    """One cell in COPY text format: lists become text[], dicts and lists of dicts jsonb."""
    if v is None:
        return r"\N"
    if isinstance(v, bool):
        s = "true" if v else "false"
    elif isinstance(v, dict) or (isinstance(v, list) and any(isinstance(x, dict) for x in v)):
        s = json.dumps(v, ensure_ascii=False)
    elif isinstance(v, list):
        s = pg_array(v)
    else:
        s = str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


# Columns stored as jsonb get '[]' rather than a text[] literal when the list is empty.
JSONB_LIST_COLUMNS = {
    "us_ofac_sanctions": {"addresses", "aliases", "ids", "dates_of_birth", "places_of_birth"},
    "uk_sanctions": {"names", "non_latin_names", "birth_places", "addresses", "identifications"},
    "eu_sanctions": {"identifications", "regulations"},
}


def copy_row(snap: Snapshot, row: dict) -> str:
    jsonb = JSONB_LIST_COLUMNS.get(snap.table, set())
    cells = []
    for c in snap.columns:
        v = row.get(c)
        if c in jsonb and isinstance(v, list):
            cells.append(copy_value(json.dumps(v, ensure_ascii=False)))
        elif isinstance(v, list) and not v:
            cells.append(r"\N")
        else:
            cells.append(copy_value(v))
    return "\t".join(cells)


def load_sql(snap: Snapshot, source_url: str, sha256: str, size: int) -> str:
    cols = ", ".join(snap.columns)
    key = ", ".join(snap.key)
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in snap.columns if c not in snap.key)
    join = " AND ".join(f"s.{k} = t.{k}" for k in snap.key)
    ts = "updated_at = NOW()"
    rows = "\n".join(copy_row(snap, r) for r in snap.rows)
    return f"""
BEGIN;
CREATE TEMP TABLE sanc_stage (LIKE {snap.table}) ON COMMIT DROP;
COPY sanc_stage ({cols}) FROM STDIN WITH (FORMAT text, NULL '\\N');
{rows}
\\.
UPDATE sanc_stage SET source_url = {lit(source_url)};
DO $$
DECLARE staged bigint; held bigint;
BEGIN
  SELECT count(*) INTO staged FROM sanc_stage;
  SELECT count(*) INTO held FROM {snap.table} WHERE {snap.scope_sql};
  IF held > 0 AND staged < held * {MIN_RATIO} THEN
    RAISE EXCEPTION '{snap.list_name}: snapshot has % rows, table holds % (min ratio {MIN_RATIO}), not loaded',
      staged, held;
  END IF;
END $$;
WITH up AS (
  INSERT INTO {snap.table} ({cols})
  SELECT {cols} FROM sanc_stage
  ON CONFLICT ({key}) DO UPDATE SET {sets}, {ts}
  RETURNING 1
), del AS (
  DELETE FROM {snap.table} t
   WHERE {snap.scope_sql.replace("entry_type", "t.entry_type")}
     AND NOT EXISTS (SELECT 1 FROM sanc_stage s WHERE {join})
  RETURNING 1
), j AS (
  INSERT INTO intl_sanctions_snapshots
    (list_name, file_sha256, snapshot_date, source_url, file_size, rows_parsed, rows_upserted, rows_removed)
  SELECT {lit(snap.list_name)}, {lit(sha256)}, {lit(snap.snapshot_date)}::date, {lit(source_url)}, {size},
         {len(snap.rows)}, (SELECT count(*) FROM up), (SELECT count(*) FROM del)
  ON CONFLICT (list_name, file_sha256) DO UPDATE SET
    rows_upserted = EXCLUDED.rows_upserted, rows_removed = EXCLUDED.rows_removed, loaded_at = NOW()
  RETURNING rows_upserted, rows_removed
)
SELECT 'RESULT|' || rows_upserted || '|' || rows_removed FROM j;
COMMIT;
"""


def already_loaded(list_name: str, sha256: str) -> bool:
    out = psql(f"SELECT 1 FROM intl_sanctions_snapshots WHERE list_name = {lit(list_name)} "
               f"AND file_sha256 = {lit(sha256)};")
    return out.strip() == "1"


# ─── Main ─────────────────────────────────────────────────────────────────


def run_list(list_name: str, file: str | None, dry_run: bool, force: bool,
             source_url: str | None = None) -> None:
    t0 = time.time()
    if file:
        with open(file, "rb") as f:
            data = f.read()
        url = source_url or f"file:{os.path.basename(file)}"
    else:
        url = resolve_url(list_name)
        log(f"{list_name}: downloading {strip_token(url)}")
        data = http_get(url)
    stored_url = strip_token(url)
    sha = hashlib.sha256(data).hexdigest()

    snap = PARSERS[list_name](data)
    check_snapshot(snap)
    log(f"{list_name}: {len(snap.rows)} entries parsed ({snap.skipped} skipped), "
        f"snapshot {snap.snapshot_date}, {len(data) // 1024} KB, sha256 {sha[:12]}")
    if dry_run:
        return
    if not force and already_loaded(list_name, sha):
        log(f"{list_name}: this file is already loaded, skipping (use --force to reload)")
        return
    out = psql(load_sql(snap, stored_url, sha, len(data)))
    m = re.search(r"RESULT\|(\d+)\|(\d+)", out)
    upserted, removed = (m[1], m[2]) if m else ("?", "?")
    log(f"{list_name}: {upserted} upserted into {snap.table}, {removed} delisted removed "
        f"({time.time() - t0:.0f}s)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="append", required=True, choices=LISTS + ["all"],
                    help="list to load; repeat for several, 'all' for the four")
    ap.add_argument("--file", help="load a local file instead of downloading (one --list only)")
    ap.add_argument("--source-url", help="--file: URL the file was downloaded from (stored as source_url)")
    ap.add_argument("--dry-run", action="store_true", help="download and parse only")
    ap.add_argument("--force", action="store_true", help="reload a file already journalled")
    a = ap.parse_args(argv)

    lists = LISTS if "all" in a.list else list(dict.fromkeys(a.list))
    if a.file and len(lists) != 1:
        ap.error("--file needs exactly one --list")

    failed = []
    for name in lists:
        try:
            run_list(name, a.file, a.dry_run, a.force, a.source_url)
        except Exception as e:  # noqa: BLE001 - one broken list must not block the others
            log(f"ERROR {name}: {e}")
            failed.append(name)
    if failed:
        log(f"failed: {', '.join(failed)}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
