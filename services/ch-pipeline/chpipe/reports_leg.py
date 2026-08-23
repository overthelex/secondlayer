"""Gate E: control acts whose expected shape is independently known.

Every count here is count(*). n_live_tup has been observed badly wrong on
this database (see chpipe/reports.py's module docstring for the measured
example), so it must never stand in for a real count here either.

gate_e() reports what THIS connection's tables say about each control act --
its own edition count, its latest edition's article count, and how many
changes were computed for it. That is only half of Gate E: the count is
meaningless as a completeness check unless it is also compared against
Fedlex's own SPARQL count for the same SR number, which needs a live network
round trip this module deliberately does not make on its own (a report
function should not depend on network reachability to run against a
database that already has the data). That comparison is done by the
operator running this gate, using chpipe.sparql.SparqlClient against
chpipe.fedlex_queries.ENDPOINT with each row's sr_number -- see the
pipeline's Gate E run log for the query and the numbers it produced.

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
