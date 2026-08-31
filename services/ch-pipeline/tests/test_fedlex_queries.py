import httpx
import pytest

from chpipe import fedlex_queries as q
from chpipe.sparql import SparqlClient


def test_every_select_query_is_distinct():
    """Fedlex serves the same triples from several named graphs. A versions
    query for SR 220 without DISTINCT returned the same edition six times."""
    for name in ("ACTS", "VERSIONS", "TITLES"):
        assert "SELECT DISTINCT" in getattr(q, name), f"{name} is missing DISTINCT"


def test_acts_filters_the_sr_notation_by_its_datatype():
    assert "id-systematique" in q.ACTS


def test_no_query_walks_by_offset():
    """The regression guard for the whole fix.

    Fedlex runs Virtuoso, which raises SR353 as soon as a sorted TOP clause
    asks for more than 10,000 rows -- and the limit is on OFFSET + LIMIT
    together, so a bigger page size only moves the wall. Verified live on
    2026-08-23: OFFSET 9990 LIMIT 10 returns rows, OFFSET 10000 LIMIT 10 does
    not. ACTS must cover 17,293 works, and TITLES and VERSIONS tens of
    thousands of rows each, so an OFFSET walk cannot reach most of the corpus
    at all. Every
    one of these three queries used to end in `LIMIT %(limit)d OFFSET
    %(offset)d`; none of them may again."""
    for name in ("ACTS", "TITLES", "VERSIONS"):
        text = getattr(q, name)
        assert "OFFSET" not in text.upper(), f"{name} walks by offset again"
        assert "%(offset)d" not in text, f"{name} walks by offset again"


def test_every_query_still_orders_stably():
    for name in ("ACTS", "TITLES", "VERSIONS"):
        assert "ORDER BY" in getattr(q, name), \
            f"{name} without ORDER BY can drop or repeat rows"


def test_acts_pages_by_key_not_by_a_row_counter():
    """ACTS has no driving set of its own, so it is walked by filtering past
    the last work seen. `>=` rather than `>`: a work can occupy two rows (see
    the dual-status test below) and a strict comparison would drop whichever
    of them fell on the far side of a page boundary."""
    assert "%(after)s" in q.ACTS
    assert "%(limit)d" in q.ACTS
    assert 'FILTER(STR(?work) >= "%(after)s")' in q.ACTS


def test_titles_and_versions_are_driven_by_a_values_batch():
    """Once ch_act is populated both are driven by batches of known work URIs
    rather than walked globally. That bounds every query far below the
    ceiling, makes each batch an independent query, and -- for VERSIONS -- makes
    an orphaned version impossible by construction, because the parent work is
    by definition already in ch_act."""
    for name in ("TITLES", "VERSIONS"):
        text = getattr(q, name)
        assert "VALUES ?work { %(values)s }" in text, f"{name} is not batch-driven"
        assert "%(limit)d" not in text, f"{name} should be bounded by its batch"


# The worst case a batch can produce, measured on 2026-08-23 by running the
# SHIPPED queries (the ones with SELECT DISTINCT) over the heaviest works in
# the corpus and counting returned rows. VERSIONS is the constraint; TITLES is
# nowhere near it, because exactly five languages exist and a work carries one
# title per language.
WORST_CASE_VERSION_ROWS_PER_WORK = 282        # cc/2022/151, the largest act
WORST_CASE_VERSION_ROWS_PER_BATCH = 2461      # the twenty heaviest works
WORST_CASE_TITLE_ROWS_PER_WORK = 5            # de/fr/it/en/rm, one title each
SR353_CEILING = 10000


def test_the_work_batch_size_keeps_the_worst_case_under_the_ceiling():
    """20 is justified by measurement, not by taste.

    Earlier revisions of this comment cited 770 title rows for the heaviest
    work and a top-20 sum of 8,692. Those came from the query pattern WITHOUT
    its SELECT DISTINCT, and were wrong by up to 150x: Fedlex serves the same
    triples from many named graphs, and DISTINCT collapses that duplication
    before any row reaches a stage. Measured through the shipped queries, the
    heaviest work returns 5 title rows, not 770."""
    assert q.WORK_BATCH_SIZE == 20
    worst = (WORST_CASE_VERSION_ROWS_PER_BATCH
             + WORST_CASE_TITLE_ROWS_PER_WORK * q.WORK_BATCH_SIZE)
    assert worst < SR353_CEILING, "a batch could exceed the sorted-TOP ceiling"
    # And the margin is real, not marginal: roughly 4x.
    assert worst < SR353_CEILING // 3


def test_versions_not_titles_is_what_constrains_the_batch_size():
    """The comment must name the right constraint. A work has at most five
    titles ever, but the largest act has 282 editions across five languages."""
    assert WORST_CASE_TITLE_ROWS_PER_WORK < WORST_CASE_VERSION_ROWS_PER_WORK
    assert (WORST_CASE_TITLE_ROWS_PER_WORK * q.WORK_BATCH_SIZE
            < WORST_CASE_VERSION_ROWS_PER_BATCH)
    assert len(q.LANGUAGE_MAP) == WORST_CASE_TITLE_ROWS_PER_WORK, \
        "five languages exist on SC expressions, and all five are mapped"


def _batch_size_comment() -> str:
    """The comment block that justifies WORK_BATCH_SIZE."""
    import inspect
    source = inspect.getsource(q)
    start = source.index("# Works bound into one VALUES block")
    return source[start:source.index("WORK_BATCH_SIZE = 20")]


def test_the_batch_size_comment_does_not_cite_the_discredited_numbers():
    """These figures came from the query pattern WITHOUT its SELECT DISTINCT
    and are wrong by up to 150x -- the 'heaviest work, 770 title rows' is 5
    rows through the shipped query. A comment that states a measurement of a
    query the pipeline does not ship is exactly the kind of unearned claim
    this branch exists to stop shipping."""
    comment = _batch_size_comment()
    for discredited in ("770", "8,692", "10,021", "7,216", "15,549"):
        assert discredited not in comment, \
            f"{discredited} is a non-DISTINCT measurement and is not true"


def test_the_batch_size_comment_names_versions_as_the_constraint():
    """It used to name TITLES, which is off by a factor of 25."""
    comment = _batch_size_comment()
    assert "VERSIONS is what constrains the batch size" in comment
    assert "282" in comment and "2,461" in comment


def test_the_batch_size_comment_warns_about_count_distinct():
    """COUNT(DISTINCT ?x) returned a nineteen-digit number on this endpoint
    where the answer was 1, and COUNT(*) over a subselect with an inner
    DISTINCT returned 22,675 against a true 17,305. Anyone re-measuring these
    numbers must be told before they trust a COUNT."""
    import inspect
    source = inspect.getsource(q)
    assert "COUNT(DISTINCT" in source and "unreliable" in source


def test_status_code_extracts_the_trailing_integer():
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0") == 0
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3") == 3


def test_status_code_of_none_or_junk_is_none():
    assert q.status_code(None) is None
    assert q.status_code("not a uri") is None


def test_in_force_is_zero_not_one():
    """Verified against the vocabulary on 2026-08-23: 0 = 'In force',
    3 = 'Nicht mehr in Kraft'. Guessing 1 here would mark 5,087 acts repealed."""
    assert q.ENFORCEMENT_STATUS_IN_FORCE == 0


def test_acts_starts_from_the_beginning_when_the_key_is_empty():
    """The first page of a keyset walk passes an empty key; the filter must
    then admit every work rather than none."""
    assert 'STR(?work) >= ""' in (q.ACTS % {"limit": 5, "after": ""})


def test_acts_orders_by_status_too_for_full_determinism():
    """ORDER BY ?work alone does not order the two rows of a dual-status work
    against each other, so a paged walk could interleave them differently
    between runs. The ordering key must include ?inForce."""
    assert "ORDER BY ?work ?inForce" in q.ACTS


# --- EDITIONS_BY_SR: Gate E's live cross-check against Fedlex (reports_leg.py) ---

def test_editions_by_sr_is_select_distinct():
    assert "SELECT DISTINCT" in q.EDITIONS_BY_SR


def test_editions_by_sr_binds_language_and_manifestation_through_one_expression():
    """Two independent property paths off ?c -- isRealizedBy/language and
    isRealizedBy/isEmbodiedBy/userFormat -- do not require the same
    expression node to satisfy both: a consolidation with a French XML
    edition and a German PDF-only edition would match both paths at once,
    silently counting a German XML edition that does not exist. Verified
    live against SR 220 on 2026-08-23: the independent-path form returns 100
    (any XML manifestation in any language, joined against a German
    realization in any format); the shared-node form returns 14, matching
    this pipeline's own VERSIONS-driven discovery exactly. isRealizedBy must
    therefore be traversed exactly once, into one ?expr that both the
    language and the manifestation hang off of."""
    text = q.EDITIONS_BY_SR
    assert text.count("jolux:isRealizedBy") == 1, (
        "isRealizedBy must be traversed once, into a shared ?expr -- a "
        "second occurrence means language and manifestation are independent "
        "paths again")
    assert "?expr jolux:language" in text
    assert "jolux:isEmbodiedBy" in text
    # Both the language and the manifestation must hang off the SAME ?expr:
    # one occurrence binds it (object of isRealizedBy), the rest must reuse
    # it as their subject rather than re-deriving it via a second path.
    assert text.count("?expr") >= 2


def test_editions_by_sr_takes_the_sr_notation_and_language_as_parameters():
    """A hardcoded SR number would make this query only ever answer for one
    act; %(sr)s and %(lang)s are what let reports_leg.fedlex_edition_count()
    reuse it for all three control acts (and any other SR)."""
    assert "%(sr)s" in q.EDITIONS_BY_SR
    assert "%(lang)s" in q.EDITIONS_BY_SR
    assert '"220"' not in q.EDITIONS_BY_SR
    assert "/DEU>" not in q.EDITIONS_BY_SR


def test_editions_by_sr_filters_the_sr_notation_by_its_datatype():
    assert "id-systematique" in q.EDITIONS_BY_SR


def test_editions_by_sr_does_not_require_a_retrievable_file():
    """Deliberately broader than VERSIONS: this counts what Fedlex's graph
    claims is an XML edition, not what actually has a file behind it --
    otherwise it would just re-derive VERSIONS's own filter and could never
    catch the metadata gap this query exists to surface. See EDITIONS_BY_SR's
    own comment for the diagnosed SR 311.0 case (20 claimed vs. 19 with a
    real file, traced to one manifestation with no isExemplifiedBy triple)."""
    assert "isExemplifiedBy" not in q.EDITIONS_BY_SR


def test_a_work_with_two_conflicting_statuses_returns_both_rows_not_one():
    """Twelve works in the live Fedlex graph assert BOTH inForceStatus 0 (in
    force) and 3 (no longer in force) at once, e.g. cc/2003/31. SELECT
    DISTINCT is correct there -- the two rows genuinely differ -- and the
    client must not merge or drop either one. Resolving the conflict is the
    ingesting task's job, not the query's or the client's."""
    fixture = {
        "head": {"vars": ["work", "inForce"]},
        "results": {"bindings": [
            {"work": {"type": "uri",
                      "value": "https://fedlex.data.admin.ch/eli/cc/2003/31"},
             "inForce": {"type": "uri", "value":
                         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"}},
            {"work": {"type": "uri",
                      "value": "https://fedlex.data.admin.ch/eli/cc/2003/31"},
             "inForce": {"type": "uri", "value":
                         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"}},
        ]},
    }
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=fixture))
    client = SparqlClient("https://fake/sparql", transport=transport)

    rows = client.select(q.ACTS % {"limit": 5, "after": ""})

    assert len(rows) == 2, "neither row of the conflicting pair may be dropped"
    assert all(r["work"] == "https://fedlex.data.admin.ch/eli/cc/2003/31" for r in rows)
    statuses = {q.status_code(r["inForce"]) for r in rows}
    assert statuses == {0, 3}


# --- Finding 1: CONSOLIDATIONS_BY_SR, the ceiling EDITIONS_BY_SR cannot see ---
# EDITIONS_BY_SR constrains the Fedlex side to userFormat/xml, which is the
# same limitation the local side of Gate E has (the corpus can only be built
# from XML editions). Both sides sharing one constraint means the comparison
# can only confirm we fetched what we chose to look for. Measured live on
# 2026-08-24: SR 220 = 14 XML editions but 100 consolidations, SR 210 =
# 11/70, SR 311.0 = 20/120 -- so a "14 of 14" green tick was 14% coverage.

def test_the_ceiling_query_does_not_carry_the_filter_it_exists_to_lift():
    assert "user-format/xml" not in q.CONSOLIDATIONS_BY_SR
    assert "userFormat" not in q.CONSOLIDATIONS_BY_SR


def test_the_ceiling_query_counts_consolidations_of_the_work():
    """Spec section 9 asked for the count against jolux:Consolidation."""
    assert "SELECT DISTINCT" in q.CONSOLIDATIONS_BY_SR
    assert "?c a jolux:Consolidation" in q.CONSOLIDATIONS_BY_SR
    assert "jolux:isMemberOf ?work" in q.CONSOLIDATIONS_BY_SR
    assert "id-systematique" in q.CONSOLIDATIONS_BY_SR


def test_the_ceiling_query_binds_no_language():
    """A jolux:Consolidation is the edition; language lives on the
    expressions realising it. Binding one here would re-narrow the very
    denominator this query exists to widen."""
    assert "%(lang)s" not in q.CONSOLIDATIONS_BY_SR
    assert "authority/language" not in q.CONSOLIDATIONS_BY_SR


def test_the_ceiling_query_takes_the_sr_notation_as_a_parameter():
    assert "%(sr)s" in q.CONSOLIDATIONS_BY_SR
    assert '"220"' not in q.CONSOLIDATIONS_BY_SR


def test_the_ceiling_query_walks_no_offset():
    assert "OFFSET" not in q.CONSOLIDATIONS_BY_SR.upper()


# --- Finding 3: one language vocabulary, translated in exactly one place ---

def test_the_iso_map_is_the_reverse_of_language_map():
    """Derived, not restated: two hand-written tables drift."""
    assert q.ISO_TO_AUTHORITY == {
        "de": "DEU", "fr": "FRA", "it": "ITA", "en": "ENG", "rm": "ROH"}
    for uri, iso in q.LANGUAGE_MAP.items():
        assert uri.endswith("/" + q.ISO_TO_AUTHORITY[iso])


def test_authority_language_maps_the_iso_code_the_package_speaks():
    assert q.authority_language("de") == "DEU"
    assert q.authority_language("rm") == "ROH"


def test_authority_language_raises_on_a_code_it_cannot_map():
    """An unmappable language must be an exception, never a count: the IRI
    interpolation makes ANY string a well-formed query that binds nothing,
    and a gate reads the resulting 0 as a finding rather than as an error."""
    for bad in ("DEU", "xx", "", "german"):
        with pytest.raises(q.UnknownLanguage):
            q.authority_language(bad)


def test_editions_by_sr_builder_is_the_only_place_the_language_is_filled_in():
    built = q.editions_by_sr("311.0", "fr")
    assert "authority/language/FRA>" in built
    assert '"311.0"' in built
    assert "%(" not in built


def test_the_editions_builder_refuses_an_unmappable_language():
    with pytest.raises(q.UnknownLanguage):
        q.editions_by_sr("220", "de-CH")


def test_the_ceiling_builder_needs_no_language():
    built = q.consolidations_by_sr("210")
    assert '"210"' in built
    assert "%(" not in built
