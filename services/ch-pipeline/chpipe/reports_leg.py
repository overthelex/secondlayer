"""Gate E: control acts whose expected shape is independently known.

Every count here is count(*). n_live_tup has been observed badly wrong on
this database (see chpipe/reports.py's module docstring for the measured
example), so it must never stand in for a real count here either.

gate_e() reports what THIS connection's tables say about each control act --
its own edition count, its latest edition's article count, and how many
changes were computed for it. That is only half of Gate E: the count is
meaningless as a completeness check unless it is also compared against
Fedlex's own SPARQL count for the same SR number, which needs a live network
round trip gate_e() itself deliberately does not make (a report function
should not depend on network reachability to run against a database that
already has the data). fedlex_edition_count() and cross_check_fedlex() below
are that network half, kept as a companion pair rather than folded into
gate_e() itself: fedlex_edition_count(client, sr) runs
chpipe.fedlex_queries.EDITIONS_BY_SR -- see that query's own comment for why
its language/manifestation binding and its choice not to require a
retrievable file matter -- and cross_check_fedlex(rows, client) is the
one-call convenience that takes gate_e()'s own output and adds each found
row's live count. A caller who wants Gate E's full picture in one shot does:

    client = SparqlClient(fq.ENDPOINT)
    rows = reports_leg.cross_check_fedlex(reports_leg.gate_e(conn), client)

which lands the exact query this task's own Gate E run used to produce
14/14, 11/11 and the diagnosed 19-versus-20 for the three control acts (see
EDITIONS_BY_SR's comment for that diagnosis) -- so the next run does not
have to re-derive it from a scratch script or a report.

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


def gate_e(conn, sr_numbers: list[str] | None = None) -> list[dict]:
    out: list[dict] = []
    for sr in (sr_numbers or CONTROL_ACTS):
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT act_id, title_de, in_force FROM ch_act "
                "WHERE sr_number = %s ORDER BY act_id LIMIT 1", (sr,))
            act = cur.fetchone()
        if not act:
            out.append({"sr_number": sr, "found": False, "note": _NOT_LOADED_NOTE})
            continue

        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT count(*) AS n FROM ch_act_version "
                "WHERE act_id = %s AND lang = 'de' AND stage = 'parsed'",
                (act["act_id"],))
            editions = cur.fetchone()["n"]

            cur.execute(
                "SELECT article_count FROM ch_act_version WHERE act_id = %s "
                "AND lang = 'de' AND stage = 'parsed' "
                "ORDER BY date_applicability DESC LIMIT 1", (act["act_id"],))
            latest = cur.fetchone()

            cur.execute(
                "SELECT count(*) AS n FROM ch_act_change WHERE act_id = %s",
                (act["act_id"],))
            changes = cur.fetchone()["n"]

        out.append({
            "sr_number": sr, "found": True, "title": act["title_de"],
            "in_force": act["in_force"], "editions_de": editions,
            "articles_latest": latest["article_count"] if latest else None,
            "changes": changes,
        })
    return out


def fedlex_edition_count(client: SparqlClient, sr_number: str, lang: str = "DEU") -> int:
    """How many editions of `sr_number` Fedlex's own graph claims to publish
    as an XML manifestation in `lang` -- the network half of Gate E. See
    chpipe.fedlex_queries.EDITIONS_BY_SR for the query and why it counts
    Python-side len() rather than a SPARQL COUNT(DISTINCT ...), and for what
    a mismatch against gate_e()'s local `editions_de` does and does not
    mean."""
    return len(client.select(fq.EDITIONS_BY_SR % {"sr": sr_number, "lang": lang}))


def cross_check_fedlex(rows: list[dict], client: SparqlClient,
                       lang: str = "DEU") -> list[dict]:
    """Annotate gate_e()'s output with each found row's live Fedlex edition
    count, under the key `fedlex_editions` -- one call instead of a
    hand-assembled script. With the default lang="DEU" this is the number to
    compare against the row's own `editions_de`. A row with found=False is
    returned unchanged: there is nothing in ch_act to cross-check for a
    control act this database never loaded (see gate_e()'s `note` on that
    row for why that is not itself a finding)."""
    out = []
    for row in rows:
        row = dict(row)
        if row.get("found"):
            row["fedlex_editions"] = fedlex_edition_count(
                client, row["sr_number"], lang)
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
