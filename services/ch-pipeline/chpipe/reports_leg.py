"""Gate E: control acts whose expected shape is independently known.

Every count here is count(*). n_live_tup has been observed badly wrong on
this database (see chpipe/reports.py's module docstring for the measured
example), so it must never stand in for a real count here either.

gate_e() reports what THIS connection's tables say about each control act --
its own edition count, its latest edition's article count, and how many
changes were computed for it. That is only half of Gate E: the count is
meaningless as a completeness check unless it is also compared against
Fedlex's own SPARQL counts for the same SR number, which need a live network
round trip gate_e() itself deliberately does not make (a report function
should not depend on network reachability to run against a database that
already has the data). fedlex_edition_count(), fedlex_consolidation_count()
and cross_check_fedlex() below are that network half, kept as companions
rather than folded into gate_e() itself. A caller who wants Gate E's full
picture in one shot does:

    client = SparqlClient(fq.ENDPOINT)
    rows = reports_leg.cross_check_fedlex(reports_leg.gate_e(conn), client)
    for row in rows:
        print(row.get("coverage") or row["note"])

which prints, live on 2026-08-24 against a fully loaded corpus:

    220:   14 of 100 (XML: 14 of 14)
    210:   11 of  70 (XML: 11 of 11)
    311.0: 19 of 120 (XML: 19 of 20)

THE FIRST PAIR IS THE ONE THAT MATTERS, AND IT IS THE ONE THIS GATE USED TO
HIDE. An earlier version reported only the parenthesised pair, because both
sides of that comparison are constrained to XML: the corpus can only be
built from consolidations Fedlex serves as XML, and the Fedlex-side query
asked only about those. So "14 of 14" was a green tick on 14% coverage.
Spec section 9 asked for the count against jolux:Consolidation -- the
denominators 100, 70 and 120 -- and a reader has to see it in the gate's own
output, not in a docstring. The XML pair is still reported and still
correct for what it measures: it is the only thing that can catch an edition
this pipeline could have fetched and did not, which is why 311.0's 19-of-20
is a real (and diagnosed) discrepancy while 19-of-120 is a publishing limit.
See EDITIONS_BY_SR's comment for that diagnosis.

`found: False` on a control act is a legitimate, expected outcome on a
partially-seeded (or scratch) database -- it means "not loaded into this
connection's ch_act", not "missing from the corpus". Each such row carries
a `note` saying so explicitly, so a partially-loaded scratch database does
not read as a corpus gap.

Row-dict access below is done through an explicit dict_row cursor rather
than relying on the connection's own default, so this module works
identically whether the caller hands in db.connect()'s dict rows or a plain
psycopg.connect()'s tuples -- the same discipline chpipe/db.py's
unkeyed_count() uses for the same reason.
"""
from __future__ import annotations

from psycopg.rows import dict_row

from . import fedlex_queries as fq
from .sparql import SparqlClient

# SR 220 Code of Obligations, SR 210 Civil Code, SR 311.0 Criminal Code.
CONTROL_ACTS = ["220", "210", "311.0"]

_NOT_LOADED_NOTE = (
    "not loaded into this database -- absence here is not evidence of a "
    "corpus gap; run acts_stage/versions_stage for this SR (or check a "
    "database that has) before treating this as a finding"
)


def gate_e(conn, sr_numbers: list[str] | None = None,
           lang: str = "de") -> list[dict]:
    """The local half of Gate E, one row per control act.

    `lang` is an ISO code, the value ch_act_version.lang actually holds, and
    it is echoed back on every row so cross_check_fedlex() drives its network
    query from the same value rather than from a default of its own. That
    split is what this parameter exists to close: this function used to
    hardcode 'de' while cross_check_fedlex() defaulted to "DEU", so the two
    halves of one comparison were configured in two places, in two
    vocabularies.

    The edition count is reported as `editions` (not `editions_de`) for the
    same reason -- the key must not name a language the caller can change.

    `editions` counts source='fedlex' rows only -- an XML-manifestation
    count, to stay comparable with fedlex_editions (cross_check_fedlex's own
    network count of the act's XML manifestations). A pdf-a edition
    fedlex_pdf_text_stage has parsed (source='fedlex_pdf') is real corpus
    coverage but is deliberately not counted here; see the SQL comment below
    for why mixing the two sources into one number breaks the comparison
    this count exists for.
    """
    out: list[dict] = []
    for sr in (sr_numbers or CONTROL_ACTS):
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT act_id, title_de, in_force FROM ch_act "
                "WHERE sr_number = %s ORDER BY act_id LIMIT 1", (sr,))
            act = cur.fetchone()
        if not act:
            out.append({"sr_number": sr, "found": False, "lang": lang,
                        "note": _NOT_LOADED_NOTE})
            continue

        with conn.cursor(row_factory=dict_row) as cur:
            # source = 'fedlex': this count is compared against
            # fedlex_editions (cross_check_fedlex/coverage_line), which is
            # Fedlex's own count of the act's XML manifestations -- so the
            # local side has to stay an XML-source count too, or the two
            # numbers are not measuring the same thing. Without this filter,
            # fedlex_pdf_text_stage moving a pre-XML pdf-a edition to
            # stage='parsed' inflates `editions` past anything the XML-only
            # Fedlex query could ever match, and gate_e reports a false
            # mismatch on every control act with pre-XML history -- which is
            # most of them (see versions_stage's module docstring on why
            # pdf-a exists at all). A pdf-a row is real corpus coverage, just
            # not the XML-comparable kind this particular count reports.
            cur.execute(
                "SELECT count(*) AS n FROM ch_act_version "
                "WHERE act_id = %s AND lang = %s AND stage = 'parsed' "
                "AND source = 'fedlex'",
                (act["act_id"], lang))
            editions = cur.fetchone()["n"]

            cur.execute(
                "SELECT article_count FROM ch_act_version WHERE act_id = %s "
                "AND lang = %s AND stage = 'parsed' "
                "ORDER BY date_applicability DESC LIMIT 1",
                (act["act_id"], lang))
            latest = cur.fetchone()

            # AND lang, like its two sibling queries above. Without it this
            # one counted every language's change log while `editions` and
            # `articles_latest` counted one, so a German gate on a corpus
            # loaded in de/fr/it reported roughly three times the changes
            # its own edition count could account for -- and the ratio a
            # reader takes from Gate E is changes-per-edition. ch_act_change
            # carries lang precisely so the two can be read together
            # (migration 197; diff_stage never compares across languages).
            cur.execute(
                "SELECT count(*) AS n FROM ch_act_change "
                "WHERE act_id = %s AND lang = %s",
                (act["act_id"], lang))
            changes = cur.fetchone()["n"]

        out.append({
            "sr_number": sr, "found": True, "title": act["title_de"],
            "in_force": act["in_force"], "lang": lang, "editions": editions,
            "articles_latest": latest["article_count"] if latest else None,
            "changes": changes,
        })
    return out


def fedlex_edition_count(client: SparqlClient, sr_number: str,
                         lang: str = "de") -> int:
    """How many editions of `sr_number` Fedlex's own graph claims to publish
    as an XML manifestation in `lang` -- the narrow half of Gate E's network
    check. See chpipe.fedlex_queries.EDITIONS_BY_SR for the query and why it
    counts Python-side len() rather than a SPARQL COUNT(DISTINCT ...).

    `lang` is an ISO code ("de"), and an unmappable one raises
    fedlex_queries.UnknownLanguage rather than returning a count. See that
    exception's docstring: passing "de" to the previous signature -- which
    took Fedlex's own "DEU" -- produced a well-formed query binding nothing
    and a silent 0, which in a gate reads as a finding rather than an error.
    """
    return len(client.select(fq.editions_by_sr(sr_number, lang)))


def fedlex_consolidation_count(client: SparqlClient, sr_number: str) -> int:
    """Every consolidated edition Fedlex publishes for `sr_number`, in any
    format and any language -- Gate E's ceiling, and the count spec section
    9 actually asked for. No `lang`: a consolidation is language-independent
    (see fedlex_queries.CONSOLIDATIONS_BY_SR)."""
    return len(client.select(fq.consolidations_by_sr(sr_number)))


def coverage_line(row: dict) -> str:
    """One found row's Gate E result as the sentence a reader has to see:

        220: 14 of 100 (XML: 14 of 14)

    The first pair is what this corpus holds against everything Fedlex
    publishes for the act; the parenthesised pair is what it holds against
    the XML subset it is able to build from at all. Reporting only the
    second is how "we have 14% of the editions" became a green tick.
    """
    return (f"{row['sr_number']}: {row['editions']} of "
            f"{row['fedlex_consolidations']} (XML: {row['editions']} of "
            f"{row['fedlex_editions']})")


def cross_check_fedlex(rows: list[dict], client: SparqlClient,
                       lang: str | None = None) -> list[dict]:
    """Annotate gate_e()'s output with the live Fedlex counts -- one call
    instead of a hand-assembled script.

    Three keys are added to every found row:

      fedlex_consolidations   every edition Fedlex publishes for the act
      fedlex_editions         the XML subset of those, in `lang`
      coverage                both, rendered (see coverage_line())

    BOTH counts, always. fedlex_editions alone constrains the Fedlex side to
    exactly the XML-only limitation the local side already has, so the two
    can only ever agree about what this pipeline chose to look for -- SR
    220's 14-of-14 is 14 of the 100 editions Fedlex actually publishes.
    fedlex_editions is still the right number for "did the walk drop an
    edition it could have had"; fedlex_consolidations is the ceiling that
    number sits under, and the gate has to print it.

    `lang` defaults to each row's own `lang`, the one gate_e() counted the
    local side with, so a single comparison cannot be configured in two
    places. Pass it explicitly only to override that deliberately.

    A row with found=False is returned unchanged: there is nothing in
    ch_act to cross-check for a control act this database never loaded (see
    gate_e()'s `note` on that row for why that is not itself a finding).
    """
    out = []
    for row in rows:
        row = dict(row)
        if row.get("found"):
            row["fedlex_editions"] = fedlex_edition_count(
                client, row["sr_number"], lang or row.get("lang") or "de")
            row["fedlex_consolidations"] = fedlex_consolidation_count(
                client, row["sr_number"])
            row["coverage"] = coverage_line(row)
        out.append(row)
    return out


def corpus_summary(conn) -> dict:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("""
            SELECT (SELECT count(*) FROM ch_act)                              AS acts,
                   (SELECT count(*) FROM ch_act WHERE in_force)                AS in_force,
                   (SELECT count(*) FROM ch_act WHERE sr_number IS NOT NULL)   AS with_sr,
                   (SELECT count(*) FROM ch_act_version)                       AS versions,
                   (SELECT count(*) FROM ch_act_version WHERE stage='parsed')  AS parsed,
                   (SELECT count(*) FROM ch_act_article)                       AS articles,
                   (SELECT count(*) FROM ch_act_change)                        AS changes
        """)
        return dict(cur.fetchone())
