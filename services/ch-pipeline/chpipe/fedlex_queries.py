"""The Fedlex SPARQL queries, verified against the live endpoint on 2026-08-23.

Counts observed that day, for reference when a run's numbers look wrong:
  jolux:ConsolidationAbstract   17,293 distinct works
  jolux:Consolidation           56,328
  jolux:Act (AS + BBl)         369,181
  enforcement-status 0 (in force)  5,087 works
  enforcement-status 3 (repealed)  7,863 works
  enforcement-status 1                47 works
  no status at all                 4,296 works
"""
from __future__ import annotations

import re

ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint"

# 0 = "In force" / "In Kraft". Confirmed from the vocabulary's own skos:prefLabel.
ENFORCEMENT_STATUS_IN_FORCE = 0

_STATUS_TAIL = re.compile(r"/enforcement-status/(\d+)$")

_PREFIXES = """
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
"""

# One row per work. srNotation, dateDocument and inForce are all OPTIONAL because
# roughly 4,300 works carry no status and some carry no SR notation at all.
ACTS = _PREFIXES + """
SELECT DISTINCT ?work ?srNotation ?dateDocument ?dateEntryForce
                ?dateNoLongerInForce ?inForce WHERE {
  ?work a jolux:ConsolidationAbstract .
  OPTIONAL {
    ?work jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
    FILTER(datatype(?srNotation) =
           <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  }
  OPTIONAL { ?work jolux:dateDocument ?dateDocument }
  OPTIONAL { ?work jolux:dateEntryInForce ?dateEntryForce }
  OPTIONAL { ?work jolux:dateNoLongerInForce ?dateNoLongerInForce }
  OPTIONAL { ?work jolux:inForceStatus ?inForce }
}
ORDER BY ?work
LIMIT %(limit)d OFFSET %(offset)d
"""

# Titles, one row per (work, language). Five languages occur: DEU, FRA, ITA and,
# for many acts, ENG and ROH. titleShort carries the abbreviation ("OR", "CO").
TITLES = _PREFIXES + """
SELECT DISTINCT ?work ?lang ?title ?titleShort WHERE {
  ?work a jolux:ConsolidationAbstract ;
        jolux:isRealizedBy ?expr .
  ?expr jolux:language ?lang ; jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?titleShort }
}
ORDER BY ?work ?lang
LIMIT %(limit)d OFFSET %(offset)d
"""

# One row per (consolidation, language) with the direct file URL. The file URL
# is read from the graph rather than assembled from a string pattern -- the old
# importer assembled it and could not express versions at all.
VERSIONS = _PREFIXES + """
SELECT DISTINCT ?work ?consolidation ?dateApplicability ?dateEndApplicability
                ?lang ?fileUrl WHERE {
  ?consolidation a jolux:Consolidation ;
                 jolux:isMemberOf ?work ;
                 jolux:dateApplicability ?dateApplicability .
  OPTIONAL { ?consolidation jolux:dateEndApplicability ?dateEndApplicability }
  ?consolidation jolux:isRealizedBy ?expr .
  ?expr jolux:language ?lang ;
        jolux:isEmbodiedBy ?manifestation .
  ?manifestation jolux:isExemplifiedBy ?fileUrl ;
                 jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/xml> .
}
ORDER BY ?work ?dateApplicability ?lang
LIMIT %(limit)d OFFSET %(offset)d
"""

LANGUAGE_MAP = {
    "http://publications.europa.eu/resource/authority/language/DEU": "de",
    "http://publications.europa.eu/resource/authority/language/FRA": "fr",
    "http://publications.europa.eu/resource/authority/language/ITA": "it",
    "http://publications.europa.eu/resource/authority/language/ENG": "en",
    "http://publications.europa.eu/resource/authority/language/ROH": "rm",
}


def status_code(uri: str | None) -> int | None:
    if not uri:
        return None
    match = _STATUS_TAIL.search(uri)
    return int(match.group(1)) if match else None


def language_code(uri: str | None) -> str | None:
    return LANGUAGE_MAP.get(uri or "")
