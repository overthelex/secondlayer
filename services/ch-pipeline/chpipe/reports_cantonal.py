"""Gate F: is the cantonal corpus what the two independent sources say it
should be?

Per canton, four questions, each answered by a count whose method is the
SQL right here (spec section 7):

  1. acts: ch_act (jurisdiction = X) against ch_cantonal_registry
     (canton = X), joined on the systematic number -- and the two
     symmetric differences, with samples, because a total that matches
     can still hide two lists that do not;
  2. editions: our versions against LexFind's version_count, and, on the
     acts both sides hold, how many of our date_applicability values
     LexFind also lists as a version_active_since. Both sides come from
     different systems, which is what makes it a gate rather than a
     tautology (the lesson of Gate E's first version);
  3. quality: parsed / failed by reason, editions with no articles,
     editions with suspiciously short text;
  4. amendments: computed changes, provenance rows, how many of them link
     to a change document, and change documents nothing links to.

The date comparison uses the FIRST language of the canton (cantons.py)
so bilingual cantons are not counted twice.
"""
from __future__ import annotations

from psycopg.rows import dict_row

from . import cantons

_SAMPLE = 12

_ACTS = """
WITH ours AS (
    SELECT sr_number FROM ch_act WHERE jurisdiction = %(canton)s AND sr_number IS NOT NULL
), theirs AS (
    SELECT DISTINCT systematic_number AS sr_number FROM ch_cantonal_registry
     WHERE canton = %(canton)s AND systematic_number IS NOT NULL
)
SELECT
    (SELECT count(*) FROM ours)   AS acts_lexwork,
    (SELECT count(*) FROM theirs) AS acts_lexfind,
    (SELECT count(*) FROM ch_act WHERE jurisdiction = %(canton)s AND in_force) AS in_force_lexwork,
    (SELECT count(*) FROM ch_cantonal_registry WHERE canton = %(canton)s AND is_active) AS active_lexfind,
    ARRAY(SELECT sr_number FROM theirs EXCEPT SELECT sr_number FROM ours ORDER BY 1 LIMIT %(sample)s)
        AS only_in_lexfind,
    (SELECT count(*) FROM (SELECT sr_number FROM theirs EXCEPT SELECT sr_number FROM ours) d)
        AS only_in_lexfind_count,
    ARRAY(SELECT sr_number FROM ours EXCEPT SELECT sr_number FROM theirs ORDER BY 1 LIMIT %(sample)s)
        AS only_in_lexwork,
    (SELECT count(*) FROM (SELECT sr_number FROM ours EXCEPT SELECT sr_number FROM theirs) d)
        AS only_in_lexwork_count,
    -- Phase 2: acts and editions materialised FROM the registry
    -- (lexfind_versions_stage). They sit in the same tables, so without
    -- this split "acts lexwork" would count LexFind's own acts against
    -- LexFind and the comparison above would read as agreement it is not.
    (SELECT count(*) FROM ch_act WHERE jurisdiction = %(canton)s
        AND metadata_json ->> 'platform' = 'lexfind') AS acts_from_lexfind,
    (SELECT count(*) FROM ch_act_version v JOIN ch_act a USING (act_id)
      WHERE a.jurisdiction = %(canton)s AND v.source = 'lexfind') AS editions_from_lexfind
"""

_VERSIONS = """
WITH ours AS (
    -- parsed editions only: a PDF-only edition (stage failed, reason
    -- pdf_only) is reported in failed_by_reason and predates LexFind's
    -- history anyway (FR 2026-08-26: 1,272 of 1,274 "mismatches" were those)
    SELECT a.sr_number, v.date_applicability
      FROM ch_act_version v JOIN ch_act a USING (act_id)
     WHERE a.jurisdiction = %(canton)s AND v.source = 'lexwork' AND v.lang = %(lang)s
       AND v.stage = 'parsed'
), theirs AS (
    SELECT r.systematic_number AS sr_number,
           to_date(e ->> 'version_active_since', 'DD.MM.YYYY') AS date_applicability
      FROM ch_cantonal_registry r, jsonb_array_elements(r.versions_json) e
     WHERE r.canton = %(canton)s AND (e ->> 'version_active_since') ~ '^\\d{2}\\.\\d{2}\\.\\d{4}$'
), shared AS (
    SELECT sr_number FROM ours INTERSECT SELECT sr_number FROM theirs
)
SELECT
    (SELECT count(*) FROM ch_act_version v JOIN ch_act a USING (act_id)
      WHERE a.jurisdiction = %(canton)s AND v.source = 'lexwork' AND v.lang = %(lang)s) AS versions_lexwork,
    (SELECT coalesce(sum(version_count), 0) FROM ch_cantonal_registry WHERE canton = %(canton)s)
        AS versions_lexfind,
    (SELECT count(*) FROM ours o WHERE o.sr_number IN (SELECT sr_number FROM shared)
        AND EXISTS (SELECT 1 FROM theirs t WHERE t.sr_number = o.sr_number
                       AND t.date_applicability = o.date_applicability)) AS date_matches,
    (SELECT count(*) FROM ours o WHERE o.sr_number IN (SELECT sr_number FROM shared)
        AND o.date_applicability <= current_date
        AND NOT EXISTS (SELECT 1 FROM theirs t WHERE t.sr_number = o.sr_number
                           AND t.date_applicability = o.date_applicability)) AS date_mismatches,
    -- LexFind lists a version once it is in force; ours knows future ones
    -- from the host's future_versions[] (BE 2026-08-26: 70 of 73 "mismatches").
    (SELECT count(*) FROM ours o WHERE o.sr_number IN (SELECT sr_number FROM shared)
        AND o.date_applicability > current_date) AS date_future
"""

_QUALITY = """
SELECT
    count(*) FILTER (WHERE v.stage = 'parsed') AS parsed,
    count(*) FILTER (WHERE v.stage = 'failed') AS failed,
    count(*) FILTER (WHERE v.stage IN ('discovered', 'fetched')) AS pending,
    count(*) FILTER (WHERE v.stage = 'parsed' AND coalesce(v.article_count, 0) = 0) AS empty_articles,
    count(*) FILTER (WHERE v.stage = 'parsed' AND length(coalesce(v.full_text, '')) < 200) AS short_text
  FROM ch_act_version v JOIN ch_act a USING (act_id)
 WHERE a.jurisdiction = %(canton)s AND v.source = 'lexwork'
"""

_FAILED_BY_REASON = """
SELECT left(coalesce(v.last_error, '<none>'), 60) AS reason, count(*) AS n
  FROM ch_act_version v JOIN ch_act a USING (act_id)
 WHERE a.jurisdiction = %(canton)s AND v.source = 'lexwork' AND v.stage = 'failed'
 GROUP BY 1 ORDER BY 2 DESC LIMIT 10
"""

_AMENDMENTS = """
SELECT
    (SELECT count(*) FROM ch_act_change c JOIN ch_act a USING (act_id)
      WHERE a.jurisdiction = %(canton)s) AS changes,
    (SELECT count(*) FROM ch_article_provenance p JOIN ch_act_version v USING (version_id)
       JOIN ch_act a USING (act_id) WHERE a.jurisdiction = %(canton)s) AS provenance_rows,
    (SELECT count(*) FROM ch_article_provenance p JOIN ch_act_version v USING (version_id)
       JOIN ch_act a USING (act_id)
      WHERE a.jurisdiction = %(canton)s AND p.change_document_id IS NOT NULL) AS provenance_linked,
    (SELECT count(*) FROM ch_act_change_document d WHERE d.jurisdiction = %(canton)s) AS change_documents,
    (SELECT count(*) FROM ch_act_change_document d WHERE d.jurisdiction = %(canton)s
        AND NOT EXISTS (SELECT 1 FROM ch_article_provenance p
                         WHERE p.change_document_id = d.change_document_id)) AS change_documents_unlinked
"""


def gate_f(conn, canton: str | None = None) -> list[dict]:
    selected = [canton.upper()] if canton else sorted(cantons.LEXWORK)
    rows = []
    with conn.cursor(row_factory=dict_row) as cur:
        for code in selected:
            lang = cantons.ALL[code].langs[0] if cantons.ALL[code].langs else "de"
            params = {"canton": code, "lang": lang, "sample": _SAMPLE}
            cur.execute(_ACTS, params)
            row = {"canton": code, **cur.fetchone()}
            cur.execute(_VERSIONS, params)
            row.update(cur.fetchone())
            cur.execute(_QUALITY, params)
            row.update(cur.fetchone())
            cur.execute(_FAILED_BY_REASON, params)
            row["failed_by_reason"] = {r["reason"]: r["n"] for r in cur.fetchall()}
            cur.execute(_AMENDMENTS, params)
            row.update(cur.fetchone())
            rows.append(row)
    return rows


def format_gate_f(rows: list[dict]) -> str:
    out = ["Gate F: cantonal corpus against LexFind (acts by systematic number; "
           "parsed editions by date_applicability = version_active_since on shared acts)"]
    for r in rows:
        out.append(
            f"{r['canton']}: acts lexwork {r['acts_lexwork']} (in force {r['in_force_lexwork']}) / "
            f"lexfind {r['acts_lexfind']} (active {r['active_lexfind']}); "
            f"only_in_lexfind {r['only_in_lexfind_count']} {r['only_in_lexfind']}; "
            f"only_in_lexwork {r['only_in_lexwork_count']} {r['only_in_lexwork']}; "
            f"from lexfind: acts {r['acts_from_lexfind']}, editions {r['editions_from_lexfind']}")
        out.append(
            f"    editions lexwork {r['versions_lexwork']} / lexfind {r['versions_lexfind']}; "
            f"dates match {r['date_matches']} / mismatch {r['date_mismatches']} / future {r['date_future']}")
        out.append(
            f"    parsed {r['parsed']} failed {r['failed']} pending {r['pending']} "
            f"empty_articles {r['empty_articles']} short_text {r['short_text']} "
            f"failed_by_reason {r['failed_by_reason']}")
        out.append(
            f"    changes {r['changes']} provenance {r['provenance_rows']} "
            f"(linked {r['provenance_linked']}) change_documents {r['change_documents']} "
            f"(unlinked {r['change_documents_unlinked']})")
    return "\n".join(out)
