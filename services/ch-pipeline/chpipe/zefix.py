"""The LINDAS queries and parsers behind the `zefix` stage.

Everything below was verified against the live endpoint on 2026-08-26. LINDAS
is a live government dataset, so treat the counts as a point-in-time snapshot,
not as invariants.

Endpoint
    https://lindas.admin.ch/query, SPARQL 1.1 over GET (`?query=`) or POST
    (form-encoded), `Accept: text/csv` or `application/sparql-results+json`.
    chpipe/sparql.py's SparqlClient POSTs and asks for JSON; both were
    exercised against this endpoint, JSON results carry `xml:lang` tags that
    the CSV serialisation drops.

The organisations
    Graph <https://lindas.admin.ch/foj/zefix>, class
    <https://schema.ld.admin.ch/ZefixOrganisation>: 792,332 organisations,
    every one of them carrying a <https://schema.ld.admin.ch/municipality>.
    Predicates used here, all in the http://schema.org/ namespace except the
    municipality: identifier, legalName, additionalType, name, description,
    address (streetAddress / postalCode / addressLocality / addressRegion).

Identifiers arrive as THREE IRIs per organisation -- measured, exactly
12,360 identifier rows over Biel/Bienne's 4,120 organisations:

    .../zefix/company/1198554/UID/CHE242294601      -> uid  CHE-242.294.601
    .../zefix/company/1198554/CHID/CH03640617915    -> chid CH03640617915
    .../zefix/company/1198554/EHRAID                -> no value at all

The third one ends at the segment name: it names the identifier scheme and
says nothing more. The EHRA id is the `company/<n>` segment of the
organisation's OWN IRI, which is where ehraid_from_iri() reads it.

Why the shipped query aggregates
    Three identifier rows times one-to-several schema:name values means 3.4
    rows per organisation (13,986 rows for Biel's 4,120), and EVERY one of
    them repeats the organisation's full purpose text -- often a kilobyte.
    Measured over Zürich (50,438 organisations): the ungrouped query returns
    3,158 organisations in 9.0 MB and 11.3 s, so the full corpus costs about
    250 pages and 47 minutes. The same query with GROUP BY ?org returns
    10,000 organisations in 10.2 MB and 14.3 s. Small municipalities are far
    cheaper still (Romoos, 26 organisations, 0.09 s), which matters because
    most of the 2,111 partitions are small: the whole corpus comes to roughly
    ten minutes rather than the better part of an hour.

    The aggregation also makes the keyset walk exact -- one row is one
    organisation, so a page boundary can never fall inside one.

Why the partition comes from the organisations, not from the municipalities
    3,297 municipalities are a schema.ld:Municipality contained in a canton,
    but organisations reference only 2,111 distinct municipality IRIs -- and
    one of those 2,111 (municipality/700, 5 organisations) is NOT a
    Municipality with a canton at all. A walk driven by the Municipality
    class does 56% more queries AND still silently loses those 5 companies.
    PARTITIONS therefore counts the organisations first and hangs the name
    and canton off that as an OPTIONAL.

Cantons
    A municipality carries no canton abbreviation. schema:containedInPlace
    gives the canton IRI (<https://ld.admin.ch/canton/2>), and the canton
    carries schema:alternateName "BE" (probed live: canton/2 has
    schema:name Bern/Berne/Berna and schema:alternateName BE). That is used
    for ch_zefix_municipality.canton. A COMPANY's canton comes from its own
    schema:addressRegion instead, which is the abbreviation directly and is
    right even for the organisations whose municipality is unknown.

Legal forms
    schema:additionalType is an eCH-0097 IRI whose last segment is the code
    (.../legalforms/0107). The labels are IN the graph -- 43 terms, one
    query, 0.16 s -- with proper de/fr language tags, so LEGAL_FORMS reads
    them rather than shipping a hand-written map. That is not a nicety: the
    map drafted for this stage had 0113 as "Institut des öffentlichen
    Rechts", where LINDAS says 0113 is "Besondere Rechtsform" and 0117 is
    the Institut, and had 0111 as "Zweigniederlassung" where LINDAS says
    "Ausländische Niederlassung im Handelsregister eingetragen". A code
    whose label the graph does not publish is kept AS the code; a guessed
    label is worse than no label.

    The 15 codes observed on organisations, most common first: 0107 (291,066),
    0106 (250,756), 0101 (179,935), 0110 (17,792), 0151 (15,346), 0109
    (13,497), 0103 (11,203), 0108 (7,953), 0111 (3,176), 0104 (1,031), 0117
    (468), 0113 (55), 0119 (32), 0118 (14), 0105 (8).

Licence: "Provide the Source" (LINDAS / Federal Office of Justice).
"""
from __future__ import annotations

import re

ENDPOINT = "https://lindas.admin.ch/query"
GRAPH = "https://lindas.admin.ch/foj/zefix"

# One row per organisation, so a keyset page never splits one. 5,000 leaves
# room under chpipe/sparql.py's MAX_PAGE_SIZE (10,000, the sorted-TOP ceiling)
# and keeps a page around 5 MB; only about ten municipalities need a second
# page at all, and Zürich -- the largest, 50,438 organisations -- needs eleven.
PAGE_SIZE = 5000

# Rows per executemany batch into ch_zefix_companies.
UPSERT_BATCH = 1000

# The municipality IRIs organisations actually reference, with the name and
# canton where the Municipality class knows them. 2,111 rows, 4.7 s -- well
# inside one page, so this needs no walk of its own.
PARTITIONS = """
SELECT ?municipality ?organisations ?name ?canton WHERE {
  {
    SELECT ?municipality (COUNT(?org) AS ?organisations) WHERE {
      GRAPH <https://lindas.admin.ch/foj/zefix> {
        ?org a <https://schema.ld.admin.ch/ZefixOrganisation> ;
             <https://schema.ld.admin.ch/municipality> ?municipality .
      }
    } GROUP BY ?municipality
  }
  OPTIONAL {
    ?municipality a <https://schema.ld.admin.ch/Municipality> ;
                  <http://schema.org/name> ?name ;
                  <http://schema.org/containedInPlace> ?c .
    FILTER(STRSTARTS(STR(?c), "https://ld.admin.ch/canton/"))
    OPTIONAL { ?c <http://schema.org/alternateName> ?canton }
  }
}
ORDER BY ?municipality
"""

# eCH-0097. `inDefinedTermset` is spelled with a lower-case "s" in the source
# data (schema.org's own property is `inDefinedTermSet`); this matches what
# LINDAS publishes, not what schema.org documents.
LEGAL_FORMS = """
SELECT ?form ?name WHERE {
  ?form <http://schema.org/inDefinedTermset> <https://ld.admin.ch/ech/97/legalforms> ;
        <http://schema.org/name> ?name .
  FILTER(langMatches(lang(?name), "de"))
}
ORDER BY ?form
"""

# One municipality's organisations, one row each. GROUP_CONCAT collapses the
# three identifier IRIs (separated by a space, which an IRI cannot contain)
# and the trade names (separated by a newline, which schema:name values do
# not contain -- streetAddress does, which is why the address parts are
# SAMPLEd rather than concatenated).
#
# Rendered by chpipe/sparql.py's keyset(): `FILTER(STR(?org) >= "%(after)s")`
# with `ORDER BY ?org` first and `LIMIT %(limit)d`, and no OFFSET anywhere.
_ORGANISATIONS = """
SELECT ?org
       (SAMPLE(?legal) AS ?legalName)
       (SAMPLE(?formIri) AS ?legalForm)
       (SAMPLE(?desc) AS ?purpose)
       (GROUP_CONCAT(DISTINCT STR(?ident); separator=" ") AS ?identifiers)
       (GROUP_CONCAT(DISTINCT ?nameValue; separator="\\n") AS ?names)
       (SAMPLE(?street) AS ?street)
       (SAMPLE(?zip) AS ?zip)
       (SAMPLE(?locality) AS ?locality)
       (SAMPLE(?region) AS ?region)
WHERE {
  GRAPH <https://lindas.admin.ch/foj/zefix> {
    ?org a <https://schema.ld.admin.ch/ZefixOrganisation> ;
         <https://schema.ld.admin.ch/municipality> <%(municipality)s> ;
         <http://schema.org/identifier> ?ident ;
         <http://schema.org/legalName> ?legal ;
         <http://schema.org/additionalType> ?formIri .
    OPTIONAL { ?org <http://schema.org/name> ?nameValue }
    OPTIONAL { ?org <http://schema.org/description> ?desc }
    OPTIONAL { ?org <http://schema.org/address> ?a .
               ?a <http://schema.org/streetAddress> ?street ;
                  <http://schema.org/postalCode> ?zip ;
                  <http://schema.org/addressLocality> ?locality ;
                  <http://schema.org/addressRegion> ?region . }
  }
  FILTER(STR(?org) >= "%%(after)s")
}
GROUP BY ?org
ORDER BY ?org
LIMIT %%(limit)d
"""

# RFC 3987 forbids these inside an IRI, i.e. they are what a hostile or
# merely broken municipality IRI would need to break out of the <...>
# brackets it is substituted into. Same guard as sparql.batched().
_UNSAFE_IN_IRI = re.compile(r"""[<>"{}|\\^`\s]""")

_UID = re.compile(r"/UID/(CHE)(\d{9})$")
_CHID = re.compile(r"/CHID/(CH\d+)$")
_EHRAID = re.compile(r"/zefix/company/(\d+)$")
_MUNICIPALITY = re.compile(r"^https://ld\.admin\.ch/municipality/(\d+)$")
_LEGAL_FORM = re.compile(r"/legalforms/(\w+)$")


def organisations_query(municipality_iri: str) -> str:
    """The keyset template for one municipality.

    The municipality is substituted first and the keyset placeholders are
    left escaped (`%%`), so what comes back is exactly what keyset() expects
    to render with `%`. A stray literal `%` in the query text would blow up
    on the first page, which is what test_the_organisations_query_carries_no
    _stray_percent checks.
    """
    if not municipality_iri or _UNSAFE_IN_IRI.search(municipality_iri):
        raise ValueError(
            f"not a usable municipality IRI: {municipality_iri!r}")
    return _ORGANISATIONS % {"municipality": municipality_iri}


def uid_from_iri(iri: str | None) -> str | None:
    """`.../UID/CHE242294601` -> `CHE-242.294.601`, the canonical Zefix form.

    Returns None for the CHID and EHRAID identifier IRIs, and for anything
    that is not nine digits after CHE -- the UID is fixed-width by law, so a
    near miss is a parse failure, not a shorter company number.
    """
    match = _UID.search(iri or "")
    if not match:
        return None
    digits = match.group(2)
    return f"CHE-{digits[0:3]}.{digits[3:6]}.{digits[6:9]}"


def chid_from_iri(iri: str | None) -> str | None:
    """`.../CHID/CH03640617915` -> `CH03640617915`, kept as the register
    writes it: unlike the UID there is no single canonical punctuation for
    it, so inventing one would be inventing data."""
    match = _CHID.search(iri or "")
    return match.group(1) if match else None


def ehraid_from_iri(org_iri: str | None) -> str | None:
    """The EHRA id, read from the organisation's own IRI.

    NOT from the `.../EHRAID` identifier IRI: that one carries no value at
    all (verified live -- every EHRAID identifier ends at the segment name).
    """
    match = _EHRAID.search(org_iri or "")
    return match.group(1) if match else None


def municipality_from_iri(iri: str | None) -> int | None:
    match = _MUNICIPALITY.match(iri or "")
    return int(match.group(1)) if match else None


def legal_form_code(iri: str | None) -> str | None:
    match = _LEGAL_FORM.search(iri or "")
    return match.group(1) if match else None


def legal_form_label(code: str | None, labels: dict[str, str]) -> str | None:
    """The eCH-0097 label LINDAS publishes, or the bare code.

    Never a guess: see this module's docstring for the two labels a
    hand-written map got wrong. A code with no published label still
    identifies the form unambiguously; a wrong label does not.
    """
    if not code:
        return None
    return labels.get(code) or code


def legal_form_labels(rows: list[dict]) -> dict[str, str]:
    """LEGAL_FORMS rows -> {code: German label}."""
    labels = {}
    for row in rows:
        code = legal_form_code(row.get("form"))
        name = (row.get("name") or "").strip()
        if code and name:
            labels[code] = name
    return labels


def address_line(street: str | None, postal_code: str | None,
                 locality: str | None) -> str | None:
    """`Rue des Cygnes 54 c, 2503 Biel/Bienne`.

    streetAddress is genuinely multi-line in the source (`c/o Merse
    Immobiliers SA\\nrue de l'Hôpital 12`), and ch_zefix_companies.address is
    one line, so the newlines become the same comma the rest of the address
    uses rather than being dropped -- "c/o Merse Immobiliers SArue de
    l'Hôpital 12" would be an address that does not exist.
    """
    parts = [p.strip() for p in (street or "").splitlines() if p.strip()]
    tail = " ".join(p for p in ((postal_code or "").strip(),
                                (locality or "").strip()) if p)
    if tail:
        parts.append(tail)
    return ", ".join(parts) or None


def group_by_org(rows) -> dict[str, list[dict]]:
    """Rows -> {organisation IRI: its rows}, in walk order.

    The shipped query already returns one row per organisation, so every
    list here is normally of length one. It is a grouping all the same: an
    organisation that arrives as one row per identifier -- what the same
    query without its GROUP BY returns, and what a keyset page boundary
    hands back when the aggregation is dropped -- must still parse to one
    company, not to three quarters of one.
    """
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        org = row.get("org")
        if not org:
            continue
        grouped.setdefault(org, []).append(row)
    return grouped


def _identifier_iris(rows: list[dict]) -> list[str]:
    """Every identifier IRI the rows carry, deduplicated, order preserved.

    Handles both shapes: `identifiers`, the GROUP_CONCAT of the shipped
    query, and `ident`, one identifier per row.
    """
    seen: dict[str, None] = {}
    for row in rows:
        for iri in (row.get("identifiers") or "").split():
            seen.setdefault(iri, None)
        one = row.get("ident")
        if one:
            seen.setdefault(one, None)
    return list(seen)


def _first(rows: list[dict], key: str) -> str | None:
    for row in rows:
        value = row.get(key)
        if value:
            return value
    return None


def _names(rows: list[dict]) -> list[str]:
    seen: dict[str, None] = {}
    for row in rows:
        for name in (row.get("names") or "").split("\n"):
            if name.strip():
                seen.setdefault(name.strip(), None)
        one = (row.get("name") or "").strip()
        if one:
            seen.setdefault(one, None)
    return list(seen)


def company_row(rows: list[dict], *, municipality_id: int | None,
                municipality_name: str | None, seen_at,
                labels: dict[str, str]) -> dict | None:
    """One organisation's rows -> the parameters of one upsert.

    Returns None when the rows carry no UID: `uid` is ch_zefix_companies'
    primary key, so a company without one cannot be written at all, and
    synthesising a key would put a row in the table that no later run and no
    SHAB publication could ever match back to it. The stage counts those
    instead.
    """
    org = _first(rows, "org")
    identifiers = _identifier_iris(rows)
    uid = next((u for u in map(uid_from_iri, identifiers) if u), None)
    if not uid:
        return None

    code = legal_form_code(_first(rows, "legalForm") or _first(rows, "form"))
    street = _first(rows, "street")
    postal_code = _first(rows, "zip")
    locality = _first(rows, "locality")
    names = _names(rows)

    metadata = {
        "source": "lindas-zefix",
        "graph": GRAPH,
        "organisation_iri": org,
        "identifiers": identifiers,
        "legal_form_iri": _first(rows, "legalForm") or _first(rows, "form"),
        "municipality_iri": (f"https://ld.admin.ch/municipality/{municipality_id}"
                             if municipality_id is not None else None),
        "names": names,
        "address": {"street": street, "postal_code": postal_code,
                    "locality": locality, "region": _first(rows, "region")},
    }

    return {
        "uid": uid,
        # legalName, not schema:name: one organisation carries exactly one
        # legalName (4,120 for Biel's 4,120 organisations) and up to several
        # schema:name values, which are the trade name in the other national
        # languages. Those go to metadata_json.
        "name": _first(rows, "legalName") or (names[0] if names else uid),
        "legal_form": legal_form_label(code, labels),
        "legal_form_code": code,
        # The municipality name where the Municipality class has one; the
        # address locality for the 5 organisations in municipality/700,
        # which it does not.
        "legal_seat": municipality_name or locality,
        "status": "active",
        "purpose": _first(rows, "desc") or _first(rows, "purpose"),
        "address": address_line(street, postal_code, locality),
        # schema:addressRegion IS the canton abbreviation ("BE"), and it is
        # on the organisation, so it survives an unknown municipality.
        "canton": _first(rows, "region"),
        "chid": next((c for c in map(chid_from_iri, identifiers) if c), None),
        "ehraid": ehraid_from_iri(org),
        "municipality_id": municipality_id,
        "source_iri": org,
        "seen_at": seen_at,
        "metadata": metadata,
    }
