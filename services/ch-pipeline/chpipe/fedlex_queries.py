"""The Fedlex SPARQL queries, verified against the live endpoint on 2026-08-23.

Counts observed that day. Fedlex is a live government dataset, so treat these
as a point-in-time snapshot, not invariants -- a later run measuring numbers
in the same ballpark is fine; ordinary drift is expected:
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

# Works bound into one VALUES block by the TITLES and VERSIONS walks.
#
# Fedlex's Virtuoso raises SR353 once a sorted TOP asks for more than 10,000
# rows, so a batch's whole result set must stay under that even in the worst
# case. Measured against the live endpoint on 2026-08-23, by grouping each
# query by ?work and summing the heaviest works in the corpus:
#
#   TITLES  heaviest single work 770 rows; top-15 sum 7,216; top-20 sum 8,692;
#           top-25 sum 10,021  <-- over the ceiling
#   VERSIONS heaviest single work 282 rows; top-25 sum 2,796; top-50 sum 4,094
#
# TITLES is the binding constraint, so 20 is the largest batch whose absolute
# worst case -- the twenty heaviest works in the entire corpus all landing in
# one batch, which the eli_work_uri ordering makes wildly unlikely -- still
# comes in under 10,000. Typical batches are far smaller: 52,491 title rows and
# ~170,000 version rows over 17,293 works average 3 and 10 rows per work, so a
# batch of 20 usually returns 60 and 200 rows respectively.
#
# It is also large enough not to be chatty against a public government service:
# 17,293 works is roughly 865 requests per pass rather than 17,293.
WORK_BATCH_SIZE = 20

# 0 = "In force" / "In Kraft". Confirmed from the vocabulary's own skos:prefLabel.
ENFORCEMENT_STATUS_IN_FORCE = 0

_STATUS_TAIL = re.compile(r"/enforcement-status/(\d+)$")

_PREFIXES = """
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
"""

# One row per (work, distinct inForceStatus binding) -- NOT one row per work.
# srNotation, dateDocument and inForce are all OPTIONAL because roughly 4,300
# works carry no status and some carry no SR notation at all.
#
# Twelve works in the live graph assert BOTH inForceStatus 0 (in force) and 3
# (no longer in force) at the same time -- always that exact pattern, 0 and 3
# together, never any other combination: cc/2003/31, cc/2010/724, cc/2018/335,
# cc/2018/615, cc/2020/711, cc/2020/982, cc/2020/1073, cc/2021/217,
# cc/2021/302, cc/2022/278, cc/2022/544, cc/2023/135. For each of them this
# query returns two rows, identical except for ?inForce. That is correct:
# SELECT DISTINCT is not deduplicating a work, it is reporting two genuinely
# different triples the source graph actually asserts. Resolving which status
# is true -- or whether to keep both -- is the ingesting task's job, not this
# query's or the client's; nothing here merges, drops, or prefers one.
ACTS = _PREFIXES + """
SELECT DISTINCT ?work ?srNotation ?dateDocument ?dateEntryForce
                ?dateNoLongerInForce ?inForce WHERE {
  ?work a jolux:ConsolidationAbstract .
  # Keyset paging: page N+1 resumes at the last work of page N instead of
  # counting rows skipped. `>=`, not `>`, so the dual-status works below can
  # never lose their second row at a page boundary; SparqlClient.keyset()
  # suppresses the rows the overlap re-fetches. Deliberately no row-skipping
  # clause here -- see chpipe/sparql.py for the SR353 ceiling one would hit.
  FILTER(STR(?work) >= "%(after)s")
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
ORDER BY ?work ?inForce
LIMIT %(limit)d
"""

# Titles, one row per (work, language). Five languages occur: DEU, FRA, ITA and,
# for many acts, ENG and ROH. titleShort carries the abbreviation ("OR", "CO").
TITLES = _PREFIXES + """
SELECT DISTINCT ?work ?lang ?title ?titleShort WHERE {
  VALUES ?work { %(values)s }
  ?work a jolux:ConsolidationAbstract ;
        jolux:isRealizedBy ?expr .
  ?expr jolux:language ?lang ; jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?titleShort }
}
ORDER BY ?work ?lang
"""

# One row per (consolidation, language) with the direct file URL. The file URL
# is read from the graph rather than assembled from a string pattern -- the old
# importer assembled it and could not express versions at all.
VERSIONS = _PREFIXES + """
SELECT DISTINCT ?work ?consolidation ?dateApplicability ?dateEndApplicability
                ?lang ?fileUrl WHERE {
  VALUES ?work { %(values)s }
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
