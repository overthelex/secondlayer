"""Rebuild ch_legislation as a projection of the new tables.

Nothing in mcp_backend, lexwebapp or platform references this table (verified
by a word-boundary grep on 2026-08-23; an earlier "47 references" figure was
a substring artefact of `search_legislation`). It is kept only so external
notebooks and audits keep working -- but its sr_number column now holds the
real SR number instead of an ELI fragment, which is a deliberate change of
meaning for that column: the old importer derived a value like
"1971/1069_1068_1068" from the ELI path, which made "SR 220" unfindable by
its own number; this projection writes the real "220" straight from
ch_act.sr_number (see acts_stage.py, which reads it off Fedlex's own
id-systematique notation).

Measured on prod: of ch_legislation's 5,594 rows, 5,382 hold a CSS blob
instead of legislation text -- the old importer built filestore URLs by
string pattern, got HTML error pages back, and a tag-stripping fallback
turned a stylesheet into "full text". Only 212 rows carry genuine Akoma
Ntoso. The projection below upserts on (eli_uri, lang), the table's own
primary key, so any junk row whose eli_uri this corpus never re-derives is
never touched by the UPSERT and survives -- indistinguishable at a glance
from a row this run actually wrote. This module does NOT blind-DELETE those
survivors: nobody has reviewed which of the 5,594 rows are junk and which of
them are among the 212 real ones, so unilaterally deleting rows nobody
looked at would just trade one silent defect for another. Instead:

  * every row this projection writes carries
    metadata_json ->> 'projected_from' = 'ch_act_version', so a real row is
    distinguishable from a survivor by one query instead of by re-parsing
    5,594 akn_xml blobs by hand;
  * unaccounted_rows() counts, and run() logs, how many pre-existing rows
    this pass did NOT write or update -- so the decision to remove them can
    be made on that evidence, by a human, deliberately, not by a DELETE
    nobody reviewed.

Separately: stage='parsed' on ch_act_version is not the same claim as
"usable". A parsed edition with article_count = 0 is real data, not a
parsing defect -- Fedlex serves genuine nineteenth-century declarations
whose <act> has no <body> at all, and chpipe.akn correctly parses those into
zero articles. empty_latest_editions() reports how many of the editions
being projected are like that, so the projection says which case it is
rather than silently writing emptiness into the compatibility table as if
it were ordinary content.
"""
from __future__ import annotations

import logging

from psycopg.rows import tuple_row

from .. import db
from ..config import Settings

log = logging.getLogger(__name__)

# The one place "the latest parsed version per (act_id, lang)" is defined.
#
# An earlier draft of _PROJECT computed that fact twice: once through a JOIN
# LATERAL correlated on act_id -- which, lacking a LIMIT, did not itself
# restrict to the latest edition, only to *an* edition of that act -- and
# once more through an outer `WHERE version_id IN (SELECT DISTINCT ON ...)`
# that did the actual restricting. Two mechanisms computing one fact is how
# they drift apart the day someone edits one and not the other. DISTINCT ON
# alone already expresses "one row per (act_id, lang), the one with the
# latest date_applicability" completely and correctly, so it is the only
# mechanism kept here -- both _PROJECT and the two report queries below
# share this single definition of "latest" rather than each restating it.
_LATEST_PARSED_VERSION = """
    SELECT DISTINCT ON (act_id, lang) *
      FROM ch_act_version
     WHERE stage = 'parsed'
     ORDER BY act_id, lang, date_applicability DESC
"""

_PROJECT = f"""
INSERT INTO ch_legislation
    (eli_uri, lang, sr_number, title, short_title, version_date, in_force,
     date_entry_force, date_end_validity, akn_xml, full_text, xml_url,
     source, metadata_json, updated_at)
SELECT a.eli_work_uri,
       v.lang,
       a.sr_number,
       CASE v.lang WHEN 'de' THEN a.title_de WHEN 'fr' THEN a.title_fr
                   WHEN 'it' THEN a.title_it WHEN 'en' THEN a.title_en
                   ELSE a.title_rm END,
       a.abbreviation,
       v.date_applicability,
       a.in_force,
       a.date_entry_force,
       a.date_no_longer_in_force,
       v.akn_xml,
       v.full_text,
       v.xml_url,
       'fedlex',
       jsonb_build_object('act_id', a.act_id, 'version_id', v.version_id,
                          'projected_from', 'ch_act_version'),
       now()
  FROM ch_act a
  JOIN ({_LATEST_PARSED_VERSION}) v ON v.act_id = a.act_id
ON CONFLICT (eli_uri, lang) DO UPDATE SET
    sr_number         = EXCLUDED.sr_number,
    title             = EXCLUDED.title,
    short_title       = EXCLUDED.short_title,
    version_date      = EXCLUDED.version_date,
    in_force          = EXCLUDED.in_force,
    date_entry_force  = EXCLUDED.date_entry_force,
    date_end_validity = EXCLUDED.date_end_validity,
    akn_xml           = EXCLUDED.akn_xml,
    full_text         = EXCLUDED.full_text,
    xml_url           = EXCLUDED.xml_url,
    metadata_json     = EXCLUDED.metadata_json,
    updated_at        = now()
"""

_UNACCOUNTED = """
SELECT count(*) FROM ch_legislation
 WHERE metadata_json IS NULL
    OR metadata_json ->> 'projected_from' IS DISTINCT FROM 'ch_act_version'
"""

_EMPTY_LATEST = f"""
SELECT count(*) FROM ({_LATEST_PARSED_VERSION}) v
 -- NULL is folded in with an explicit 0: in the real pipeline
 -- parse_akn_stage.store_articles() always sets article_count (0 included)
 -- before a version reaches stage='parsed', so a parsed row with a NULL
 -- count here means something reached 'parsed' without going through that
 -- stage -- itself worth surfacing rather than quietly excluding.
 WHERE COALESCE(v.article_count, 0) = 0
"""


def unaccounted_rows(conn) -> int:
    """Pre-existing ch_legislation rows this run's projection did not write
    or update -- see the module docstring for why this is reported instead
    of deleted. Works against any connection, whatever its default
    row_factory (db.connect()'s dict rows, or a plain psycopg.connect()'s
    tuples), by asking for tuple rows explicitly -- same discipline as
    db.unkeyed_count()."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UNACCOUNTED)
        return cur.fetchone()[0]


def empty_latest_editions(conn) -> int:
    """How many of the latest-parsed editions eligible for projection have
    zero articles -- a genuine body-less Fedlex act, not necessarily a
    parsing failure. See the module docstring."""
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_EMPTY_LATEST)
        return cur.fetchone()[0]


def run(settings: Settings) -> int:
    conn = db.connect(settings)
    try:
        written = conn.execute(_PROJECT).rowcount
        unaccounted = unaccounted_rows(conn)
        empty = empty_latest_editions(conn)
        log.info("projected %d rows into ch_legislation", written)
        if unaccounted:
            log.warning(
                "UNACCOUNTED: %d pre-existing ch_legislation row(s) this "
                "pass did not write or update -- an eli_uri/lang the new "
                "corpus never re-derived. Likely survivors of the old "
                "importer's CSS-blob defect (see module docstring); review "
                "before deciding whether to remove them.", unaccounted)
        if empty:
            log.info(
                "%d of the projected editions are parsed with zero "
                "articles -- a body-less Fedlex act is expected here, not "
                "necessarily a defect.", empty)
        return written
    finally:
        conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    print(run(Settings.from_env()))
