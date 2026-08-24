"""The Fedlex SPARQL queries, verified against the live endpoint on 2026-08-23.

Counts observed that day. Fedlex is a live government dataset, so treat these
as a point-in-time snapshot, not invariants -- a later run measuring numbers
in the same ballpark is fine; ordinary drift is expected:
  jolux:ConsolidationAbstract   17,293 distinct works
  jolux:Consolidation           56,326 (only 12,033 of them carry an
                                XML manifestation, which is what VERSIONS
                                requires -- see stages/versions_stage.py)

56,326 is THE measured number for the consolidation total, and it is the one
every file in this pipeline quotes. Three files used to disagree with each
other about it -- migration 197 and stages/fetch_xml_stage.py said 56,328,
this module and stages/versions_stage.py said 56,326 -- which is exactly the
shape of a number nobody re-derived. Re-measured live on 2026-08-24 by a
keyset walk of `SELECT DISTINCT ?c WHERE { ?c a jolux:Consolidation }` at
10,000 rows per page, counting the distinct URIs in Python (never a
SPARQL-side COUNT; see this module's warning about that below): 56,326 in
about six seconds over six requests. 56,328 was simply wrong. It remains a
snapshot of 2026-08-24 all the same, not an invariant.
  jolux:Act (AS + BBl)         211,637 distinct (COUNT(*) says 369,181 --
                               a raw triple count, not a count of acts;
                               see AS_ACTS's own comment below)
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
#
# WHAT THIS QUERY CANNOT SEE, AND WHY CONSOLIDATIONS_BY_SR EXISTS. The
# userFormat/xml clause below is the same limitation the local side of Gate
# E has: this pipeline builds a corpus only from consolidations that carry
# an XML manifestation, so ch_act_version can only ever hold XML editions.
# Comparing the two therefore compares two halves of one constraint, and a
# green tick means "we fetched what we chose to look for", never "we have
# the act's editions". Measured live on 2026-08-24, German:
#
#   SR      this query   all consolidations   share
#   220     14           100                  14%
#   210     11            70                  16%
#   311.0   20           120                  17%
#
# Spec section 9 asked for the count against jolux:Consolidation, which is
# the second column. Narrowing to XML is defensible engineering -- there is
# nothing to parse in a PDF-only edition -- but it must not be what the gate
# REPORTS, or a 14%-covered act reads as complete. So both queries ship, and
# reports_leg.cross_check_fedlex() renders both: "14 of 100 (XML: 14 of 14)".
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

# Gate E's ceiling: every consolidated edition Fedlex publishes for an SR
# number, in any format and any language -- the denominator EDITIONS_BY_SR
# above cannot see. This is the count spec section 9 actually asked for.
#
# Deliberately carries NO language clause. A jolux:Consolidation is the
# edition itself; language lives one level down, on the expressions that
# realise it, so an act's edition count is language-independent and binding
# a language here would just re-narrow the very denominator this query
# exists to widen. Measured live on 2026-08-24: SR 220 = 100, SR 210 = 70,
# SR 311.0 = 120 -- against 14, 11 and 20 XML editions in German
# respectively.
#
# Counted as SELECT DISTINCT rows in Python, for the same reason as every
# other number in this module -- never a SPARQL-side COUNT(DISTINCT ...).
CONSOLIDATIONS_BY_SR = _PREFIXES + """
SELECT DISTINCT ?c WHERE {
  ?work a jolux:ConsolidationAbstract ;
        jolux:classifiedByTaxonomyEntry/skos:notation
            "%(sr)s"^^<https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique> .
  ?c a jolux:Consolidation ; jolux:isMemberOf ?work .
}
"""

LANGUAGE_MAP = {
    "http://publications.europa.eu/resource/authority/language/DEU": "de",
    "http://publications.europa.eu/resource/authority/language/FRA": "fr",
    "http://publications.europa.eu/resource/authority/language/ITA": "it",
    "http://publications.europa.eu/resource/authority/language/ENG": "en",
    "http://publications.europa.eu/resource/authority/language/ROH": "rm",
}

# The reverse of LANGUAGE_MAP: the ISO code every other module in this
# package speaks ("de", the value in ch_act_version.lang and the one
# reports_leg.gate_e() queries the local tables with) to the EU authority
# code the graph is keyed on ("DEU"). Derived from LANGUAGE_MAP rather than
# written out a second time, so the two cannot drift apart.
ISO_TO_AUTHORITY = {iso: uri.rsplit("/", 1)[-1] for uri, iso in LANGUAGE_MAP.items()}


class UnknownLanguage(ValueError):
    """A language code no Fedlex query can be built from.

    This is an exception rather than a query returning nothing because of
    what the alternative did. EDITIONS_BY_SR interpolates its language into
    an IRI (.../authority/language/%(lang)s), so ANY string produces a
    well-formed query -- and one that binds a language the graph does not
    use returns zero rows rather than an error. Reproduced live on
    2026-08-23: fedlex_edition_count(c, "220") returned 14 and the same call
    with lang="de" -- the code the whole rest of this package uses -- returned
    0, in silence.

    In a gate, 0 is the single worst value to return by accident: it does not
    read as a broken call, it reads as a finding. A reviewer chasing that
    zero spent real time believing an act had lost every edition. So an
    unmappable code raises here, and the only strings that map are the ISO
    codes in ISO_TO_AUTHORITY.
    """


def authority_language(code: str) -> str:
    """ISO code ("de") -> Fedlex's EU authority code ("DEU").

    Raises UnknownLanguage for anything else -- including "DEU" itself.
    Accepting both vocabularies is what let the two halves of one Gate E
    comparison drift apart in the first place (the local half hardcoded
    'de', the network half defaulted to "DEU"), so this package speaks ISO
    everywhere and translates in exactly this one place.
    """
    try:
        return ISO_TO_AUTHORITY[code]
    except KeyError:
        raise UnknownLanguage(
            f"{code!r} is not a language this pipeline knows. Pass an ISO "
            f"code -- one of {sorted(ISO_TO_AUTHORITY)} -- not Fedlex's own "
            "authority code ('DEU'); authority_language() adds that.") from None


def editions_by_sr(sr_number: str, lang: str = "de") -> str:
    """EDITIONS_BY_SR, ready to send. The ONLY place %(lang)s is filled in,
    so an unmappable language cannot reach the endpoint as a query that
    binds nothing and answers 0."""
    return EDITIONS_BY_SR % {"sr": sr_number,
                             "lang": authority_language(lang)}


def consolidations_by_sr(sr_number: str) -> str:
    """CONSOLIDATIONS_BY_SR, ready to send. No language: see the query."""
    return CONSOLIDATIONS_BY_SR % {"sr": sr_number}


# ELI collection segments, verified on the live graph:
#   /eli/cc/…  Classified Compilation (SR)  — handled by ACTS/acts_stage
#   /eli/oc/…  Official Compilation (AS/RO)
#   /eli/fga/… Federal Gazette (BBl/FF)
_COLLECTION_SEGMENT = re.compile(r"/eli/(cc|oc|fga)/")
_COLLECTION_NAME = {"oc": "AS", "fga": "BBl"}


def collection_of(eli_uri: str | None) -> str | None:
    """'AS' or 'BBl' for an Official Compilation or Federal Gazette ELI, else
    None -- including for a Classified Compilation (/eli/cc/) ELI, which
    belongs in ch_act via ACTS/acts_stage, not in ch_as_act."""
    match = _COLLECTION_SEGMENT.search(eli_uri or "")
    return _COLLECTION_NAME.get(match.group(1)) if match else None


# jolux:Act, discovered into ch_as_act by as_bbl_stage. `?act a jolux:Act`
# with COUNT(*) returns 369,181 (measured live 2026-08-23, and reproduced
# 2026-08-24) -- but that number is a raw triple count, not a row count of
# this SELECT DISTINCT: COUNT(DISTINCT ?act) over the same pattern returns
# 211,637, a materially different figure. Per this module's own warning
# above, neither COUNT form is trusted here; the only number this pipeline
# treats as authoritative is rows of an explicit SELECT DISTINCT counted in
# Python, which for a corpus this size means walking it, not asking
# Virtuoso to aggregate it. This task deliberately did NOT run that walk in
# full (369,181-ish rows would be substantial live traffic for a discovery
# task); a bounded slice was measured instead -- see as_bbl_stage's
# docstring and Task 4's report for the page timing that was actually
# observed. Treat any of these three numbers as a snapshot to re-derive,
# not as ground truth.
#
# Keyset paging, same discipline as ACTS: `>=`, not `>`, ORDER BY the paged
# key first, no OFFSET (see chpipe/sparql.py for the SR353 ceiling). Titles
# are not fetched here -- see as_bbl_stage's module docstring for why.
AS_ACTS = _PREFIXES + """
SELECT DISTINCT ?act ?dateDocument ?publicationDate ?dateEntryForce ?typeDocument WHERE {
  ?act a jolux:Act .
  FILTER(STR(?act) >= "%(after)s")
  OPTIONAL { ?act jolux:dateDocument ?dateDocument }
  OPTIONAL { ?act jolux:publicationDate ?publicationDate }
  OPTIONAL { ?act jolux:dateEntryInForce ?dateEntryForce }
  OPTIONAL { ?act jolux:typeDocument ?typeDocument }
}
ORDER BY ?act
LIMIT %(limit)d
"""

# jolux:basicAct: the only structured Classified-Compilation -> Official-
# Compilation relation Fedlex publishes, and it is establishment, not
# amendment -- there is no "amends" predicate anywhere in this graph (see
# migration 198's comment and basic_act_stage's module docstring).
#
# Measured live 2026-08-24 by walking this exact query (SELECT DISTINCT rows
# counted in Python, the only counting method this module trusts -- see the
# warning above AS_ACTS): 17,055 rows, cross-checked against a plain
# `COUNT(*) WHERE { ?work jolux:basicAct ?basicAct }` on the same day, which
# agreed exactly (17,055; no named-graph duplication on this predicate,
# unlike jolux:Act above). That is NOT the 69,190 figure recorded elsewhere
# in this codebase (migration 198's comment, this task's own brief) as
# "verified 2026-08-23" -- see Task 4's report for that discrepancy; it is
# reported here rather than silently reconciled, per this module's own rule
# about numbers nobody re-derived.
BASIC_ACTS = _PREFIXES + """
SELECT DISTINCT ?work ?basicAct WHERE {
  ?work a jolux:ConsolidationAbstract ; jolux:basicAct ?basicAct .
  FILTER(STR(?work) >= "%(after)s")
}
ORDER BY ?work
LIMIT %(limit)d
"""


def status_code(uri: str | None) -> int | None:
    if not uri:
        return None
    match = _STATUS_TAIL.search(uri)
    return int(match.group(1)) if match else None


def language_code(uri: str | None) -> str | None:
    return LANGUAGE_MAP.get(uri or "")
