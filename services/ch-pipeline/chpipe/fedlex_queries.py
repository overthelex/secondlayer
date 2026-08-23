"""The Fedlex SPARQL queries, verified against the live endpoint on 2026-08-23.

Counts observed that day. Fedlex is a live government dataset, so treat these
as a point-in-time snapshot, not invariants -- a later run measuring numbers
in the same ballpark is fine; ordinary drift is expected:
  jolux:ConsolidationAbstract   17,293 distinct works
  jolux:Consolidation           56,326 (only 12,033 of them carry an
                                XML manifestation, which is what VERSIONS
                                requires -- see stages/versions_stage.py)
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
# Measured on 2026-08-23 by running the SHIPPED queries below -- the ones with
# SELECT DISTINCT -- over batches of real works and counting the rows that came
# back. Measuring the same query patterns WITHOUT their DISTINCT gives numbers
# up to 150x too large, because Fedlex serves the same triples from many named
# graphs; DISTINCT collapses that before a single row reaches a stage.
#
#   VERSIONS  largest act in the corpus 282 rows (cc/2022/151); the twenty
#             heaviest works together 2,461 rows
#   TITLES    5 rows for any work, ever: exactly five languages exist on SC
#             expressions (DEU/FRA/ITA/ENG/ROH, all mapped by LANGUAGE_MAP)
#             and a work carries one title per language. The twenty heaviest
#             works together are 100 rows.
#
# So VERSIONS is what constrains the batch size and TITLES is nowhere near it.
# A batch of 20 tops out around 2,461 rows even in the adversarial case where
# the twenty heaviest works in the whole corpus land in one batch -- a 4x
# margin under the 10,000 ceiling described in chpipe/sparql.py. Typical
# batches are far smaller: sampled over 2,000 random works, VERSIONS averages
# 2.2 rows per work (65% of works return none, having no XML edition) and
# TITLES 3.0, so a batch of 20 usually returns about 44 and 60 rows.
#
# Strictly, the ceiling cannot fire on either query at all: both are bound by
# their VALUES block and carry no LIMIT and no OFFSET, and SR353 is raised only
# by a sorted TOP clause. The margin above is therefore about politeness and
# memory, not survival. 20 is also large enough not to be chatty against a
# public government service: ~865 requests per pass rather than 17,293.
#
# A warning for whoever re-measures this. COUNT(DISTINCT ?x) is unreliable on
# this endpoint -- it returned a nineteen-digit number where the true answer
# was 1 -- and so is COUNT(*) over a subselect containing an inner DISTINCT,
# which returned 22,675 against a true 17,305. Count the ROWS of an explicit
# SELECT DISTINCT projection instead, which is what every number above is.
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

# Gate E's live cross-check (chpipe/reports_leg.py): how many consolidated
# editions of a work identified by SR number Fedlex itself claims to publish
# as an XML manifestation, in a given language -- independent of what this
# pipeline has actually discovered and stored. This is the only part of Gate
# E that can catch an edition the corpus silently missed (see reports_leg.py
# and Task 8's Decision 4): gate_e() itself only counts what already made it
# into ch_act_version, so a walk that skipped a work, dropped a row at a
# batch boundary, or lost one to a swallowed exception would look clean by
# gate_e()'s own count alone.
#
# ?lang and ?manifestation are bound through the SAME expression node
# (?expr), exactly as VERSIONS above does -- NOT as two independent property
# paths off ?c. `?c jolux:isRealizedBy/jolux:language ?lang` and
# `?c jolux:isRealizedBy/jolux:isEmbodiedBy/jolux:userFormat ?format` as two
# separate paths do NOT require the same ?expr to satisfy both: a
# consolidation with (say) a French XML edition and a German PDF-only
# edition matches both paths independently, which silently counts a German
# XML edition that does not exist. Verified live against SR 220 on
# 2026-08-23: the independent-path form returns 100 (any consolidation with
# an XML manifestation in ANY language, joined against any German
# realization in any format); the shared-?expr form here returns 14 --
# exactly this pipeline's own VERSIONS-driven discovery for SR 220's German
# editions.
#
# Deliberately does NOT require `jolux:isExemplifiedBy` (a retrievable file
# URL), unlike VERSIONS -- this counts what Fedlex's graph *claims* is an
# XML edition, not what is actually downloadable. That is intentional: it
# is what surfaces Fedlex-side metadata gaps rather than silently absorbing
# them into "close enough". Measured live on 2026-08-23, German, this exact
# query: SR 220 (Code of Obligations) = 14, matching VERSIONS-driven
# discovery exactly; SR 210 (Civil Code) = 11, also exact; SR 311.0
# (Criminal Code) = 20 against this pipeline's own count of 19 -- diagnosed
# directly against the graph: consolidation .../20190101's German expression
# has a manifestation node typed userFormat=xml with NO isExemplifiedBy
# triple at all (its four sibling manifestations -- pdf-a, html, doc, docx
# -- all carry a file; the xml one carries none), so there is genuinely
# nothing for VERSIONS/fetch_xml_stage to retrieve. A mismatch here is a
# prompt to diagnose exactly like that, not proof of a bug in this pipeline
# -- but it must never be silently reconciled away by requiring
# isExemplifiedBy here too, which would just make this query re-derive
# VERSIONS's own filter and lose its power as an independent check. A run
# producing figures wildly different from 14 / 11 / 20 for these three acts
# is a signal something changed -- in Fedlex's data, in this query, or in
# this pipeline -- not routine drift.
#
# Counted as SELECT DISTINCT rows in Python (len(client.select(...))), never
# as a SPARQL-side COUNT(DISTINCT ...) -- see this module's own warning
# above about COUNT(DISTINCT ?x) being unreliable on this endpoint.
EDITIONS_BY_SR = _PREFIXES + """
SELECT DISTINCT ?c WHERE {
  ?work a jolux:ConsolidationAbstract ;
        jolux:classifiedByTaxonomyEntry/skos:notation
            "%(sr)s"^^<https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique> .
  ?c a jolux:Consolidation ; jolux:isMemberOf ?work ;
     jolux:isRealizedBy ?expr .
  ?expr jolux:language <http://publications.europa.eu/resource/authority/language/%(lang)s> ;
        jolux:isEmbodiedBy ?manifestation .
  ?manifestation jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/xml> .
}
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
