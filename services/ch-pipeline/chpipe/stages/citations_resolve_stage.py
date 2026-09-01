"""Resolution stage: turns the raw edges citations_stage writes into
resolved ones. Set-based SQL only -- no per-row Python loop, because prod
carries millions of ch_legislation_citations rows and this has to be a join,
not a cursor.

Four UPDATE ... FROM statements, run in order because each one's input is
the previous one's output:

  1. acts:      abbr_raw -> ch_act_alias -> sr_number/act_id (lang ranks
                the candidates, it does not filter them -- see _RESOLVE_ACTS).
  2. editions:  act_id (+ lang, from_date) -> ch_act_version -> version_id.
  3. articles:  version_id (+ article) -> ch_act_article -> article_id.
  4. cases:     to_raw (+ cite_kind) -> ch_court_decisions -> to_ecli.

Steps 1 and 4 are the two entry points -- they pick up every row whose
match_method is still NULL, i.e. every row citations_stage has extracted but
nothing has ever tried to resolve. Each sets match_method to a *terminal*
value even on failure ('unresolved_abbr' / 'unresolved'): once a row has been
attempted, it stays attempted, so a re-run's WHERE match_method IS NULL finds
nothing left to do -- that is what makes running this stage twice a no-op
(see the module's own test, test_running_twice_changes_nothing).

Steps 2 and 3 chase down that terminal-ness for the one path that legitimately
deserves another try: a row that found its act but not yet an edition stays
at match_method = 'act_only' (not NULL) rather than a dead end, and a row
that found its edition but not yet an article keeps article_id NULL under
match_method IN ('edition_at_date', 'latest_edition') -- so if versions_stage
or parse_akn_stage later fill in the edition or article this row was missing,
the next ordinary run (not even CHPIPE_CIT_RESOLVE_ALL) picks it up again.
Steps 1 and 4 do not get that same second chance deliberately: ch_act_alias
and ch_court_decisions both grow over time (a new alias, a newly indexed
decision), and re-scanning the full unresolved_abbr/unresolved backlog on
every run to catch that would turn a bounded set-based pass into an
unbounded one. Two deliberate, operator-driven ways to pay that cost exist:
CHPIPE_CIT_RESOLVE_ALL=1 recomputes everything from scratch, and
CHPIPE_CIT_RETRY_UNRESOLVED=1 revisits ONLY the unresolved_abbr backlog in
id-ordered batches (CHPIPE_CIT_BATCH, default 100000) without touching a
single resolved row -- the right tool when the alias map grew (e.g. the
cantonal aliases of migration 206) and the 15.7M already-resolved rows have
no reason to be rewritten. See _RETRY_ACTS.

CHPIPE_CIT_RESOLVE_ALL=1 (resolve_all=True): reset every column this stage
owns back to NULL/false first (only on rows a previous run actually touched --
match_method IS NOT NULL -- so a fresh corpus with nothing resolved yet pays
nothing extra), then run the same four statements. Their own WHERE clauses
need no separate resolve_all branch: after the reset, match_method really is
NULL again for every row, so the ordinary first-pass condition already covers
recomputing everything.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from .. import db, throttle
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ResolveReport:
    """Rows each step RESOLVED, never rows it attempted.

    Steps 2 and 3 only ever update a row that found what it was looking for,
    so their rowcount already means this. Steps 1 and 4 stamp a terminal
    match_method on every row they touch, resolved or not, so they count
    through a CTE instead -- otherwise two of these four numbers would mean
    "tried" and two would mean "succeeded" in the same log line.
    """
    acts: int = 0
    editions: int = 0
    articles: int = 0
    cases: int = 0


_RESET_LEGISLATION = """
UPDATE ch_legislation_citations
   SET sr_number = NULL, act_id = NULL, version_id = NULL, article_id = NULL,
       resolved = false, match_method = NULL
 WHERE match_method IS NOT NULL
"""

_RESET_CASES = """
UPDATE ch_case_citations
   SET to_ecli = NULL, resolved = false, match_method = NULL
 WHERE match_method IS NOT NULL
"""

# Step 1: abbr_raw -> act. Design rule 1 -- among the acts ch_act_alias names
# for this abbreviation, prefer a FEDERAL alias over the citing canton's
# (see below), then the one whose alias is written in the citation's own
# language, then the one whose [date_entry_force,
# date_no_longer_in_force) actually contains from_date; failing that (no
# from_date, or none covers it), prefer the one currently in force
# (enforcement_status = 0), then the one with the latest date_entry_force --
# a deterministic tiebreak over a's act_id closes out any remaining tie.
#
# Jurisdiction (migration 206): a cantonal abbreviation is only meaningful
# within its own canton -- a court decision cites its own canton's law, and
# "LPJA" names a different act in BE, VS and JU. The citing decision's
# canton comes from ch_court_decisions.canton (index_stage fills it from the
# spider name; 1,222,921 of 1,222,924 prod rows carry it, 2026-08-31), via a
# LEFT JOIN on from_ecli -- so a citation whose decision row is gone, or
# whose canton is NULL, is offered federal aliases only. The candidate set
# is the federal aliases plus the CITING canton's, never another canton's.
#
# Precedence: `(al.jurisdiction = 'CH') DESC` ranks every federal candidate
# ahead of every cantonal one, so an abbreviation that exists both federally
# and in the citing canton resolves federally -- the status quo, and
# bit-identical for every citation a genuine federal alias already resolved
# (for those, all previous candidates tie on the new first key). The
# cantonal alias only wins when no federal alias carries the abbreviation at
# all -- which is exactly the population that used to land at
# unresolved_abbr. The join also pins a.jurisdiction = al.jurisdiction:
# cantonal collections reuse each other's (and the federal) numbering plans,
# so sr_number alone would let a canton's alias resolve to whatever federal
# act happens to share the number (87,082 prod citations had resolved that
# way through the pre-206 leaked aliases).
#
# Language RANKS the candidates, it does not filter them: a citation's `lang`
# is what the extractor inferred, and it falls back to 'de' whenever no
# keyword in the reference decides (chpipe/citations.py's inference order).
# "les art. 9 et 10 LPGA" is French text with no paragraph keyword, so it
# arrives here as 'de' -- and an `al.lang IN (c2.lang, 'any')` filter would
# then refuse the fr-only LPGA alias and leave a perfectly resolvable
# citation at unresolved_abbr, terminally. Ranking gets the same answer
# whenever the language really is right and still resolves when it is not.
#
# match_method is set either way: 'act_only' when an act was found (editions
# take it from there), 'unresolved_abbr' when ch_act_alias has nothing for
# this abbr at all -- see the module docstring for why that is terminal.
#
# The UPDATE is wrapped in a data-modifying CTE so the statement can report
# how many rows it RESOLVED rather than how many it touched: every row it
# touches gets a terminal match_method, resolved or not, so a plain rowcount
# here would count attempts while steps 2/3 count successes and the four
# numbers in one report line would not be comparable.
# The LATERAL body is shared verbatim between the first pass over
# match_method IS NULL (_RESOLVE_ACTS) and the batched retry over
# unresolved_abbr rows (_RETRY_ACTS): one copy of the ranking, two WHEREs.
_BEST_ACT_LATERAL = """
       SELECT a.sr_number, a.act_id
         FROM ch_act_alias al
         JOIN ch_act a ON a.sr_number = al.sr_number
                      AND a.jurisdiction = al.jurisdiction
        WHERE al.abbr = c2.abbr_raw
          AND (al.jurisdiction = 'CH' OR al.jurisdiction = c2.from_canton)
        ORDER BY
          (al.jurisdiction = 'CH') DESC,
          (al.lang = c2.lang) DESC,
          (c2.from_date IS NOT NULL
             AND a.date_entry_force IS NOT NULL
             AND a.date_entry_force <= c2.from_date
             AND (a.date_no_longer_in_force IS NULL
                  OR c2.from_date < a.date_no_longer_in_force)
          ) DESC,
          (a.enforcement_status = 0) DESC,
          a.date_entry_force DESC NULLS LAST,
          a.act_id
        LIMIT 1
"""

_RESOLVE_ACTS = f"""
WITH updated AS (
UPDATE ch_legislation_citations c
   SET sr_number = best.sr_number,
       act_id = best.act_id,
       match_method = CASE WHEN best.act_id IS NULL
                            THEN 'unresolved_abbr' ELSE 'act_only' END
  FROM (SELECT c0.*, d.canton AS from_canton
          FROM ch_legislation_citations c0
          LEFT JOIN ch_court_decisions d ON d.ecli = c0.from_ecli
         WHERE c0.match_method IS NULL) c2
  LEFT JOIN LATERAL ({_BEST_ACT_LATERAL}) best ON true
 WHERE c.id = c2.id
RETURNING c.act_id
)
SELECT count(*) AS resolved FROM updated WHERE act_id IS NOT NULL
"""

# The batched retry pass (CHPIPE_CIT_RETRY_UNRESOLVED=1): revisit ONLY the
# rows already stamped 'unresolved_abbr', in id-ordered batches, against the
# alias map as it stands today. This is the operator-driven way to pay for a
# grown alias map without _RESET_LEGISLATION's cost of recomputing the
# 15.7M rows that already resolved -- those are never touched: the batch
# SELECT's WHERE is the only row source, and a row that fails again is NOT
# rewritten (the UPDATE requires best.act_id IS NOT NULL), so the pass
# leaves 'unresolved_abbr' rows byte-identical instead of churning dead
# tuples through a 17.6M-row table. Progress is by id cursor, not by
# re-claiming: a still-unresolved row keeps its terminal stamp and the next
# batch starts past it, so the loop terminates after one sweep.
_RETRY_ACTS = f"""
WITH batch AS (
    SELECT c0.id, c0.abbr_raw, c0.lang, c0.from_date, d.canton AS from_canton
      FROM ch_legislation_citations c0
      LEFT JOIN ch_court_decisions d ON d.ecli = c0.from_ecli
     WHERE c0.match_method = 'unresolved_abbr' AND c0.id > %(after)s
     ORDER BY c0.id
     LIMIT %(limit)s
),
updated AS (
UPDATE ch_legislation_citations c
   SET sr_number = best.sr_number,
       act_id = best.act_id,
       match_method = 'act_only'
  FROM batch c2
  JOIN LATERAL ({_BEST_ACT_LATERAL}) best ON true
 WHERE c.id = c2.id
   AND best.act_id IS NOT NULL
RETURNING c.id
)
SELECT (SELECT max(id) FROM batch) AS last_id,
       (SELECT count(*) FROM batch) AS attempted,
       (SELECT count(*) FROM updated) AS resolved
"""

# Step 2: act_id (+ lang, from_date) -> edition. Design rule 2 -- the parsed
# edition whose [date_applicability, date_end_applicability] contains
# from_date, or (from_date NULL) the parsed edition with the greatest
# date_applicability not in the future. Tries the citation's own language
# first and falls back to 'de' only when nothing in that language satisfies
# the date condition (ORDER BY (v.lang = c2.lang) DESC ranks an exact-language
# match ahead of the fallback whenever both exist). `, v.version_id` closes
# out the remaining tie the same way step 4's `, d.ecli` does: two parsed
# editions of one act can legitimately share a date_applicability (a
# correction re-published under the same date), and without a final
# deterministic key the pick is whatever order Postgres happens to return
# rows in -- so the same citation could resolve to a different edition, and
# therefore a different article, from one run to the next. Only rows that actually
# found an edition (best.version_id IS NOT NULL) get updated: a row that
# found no edition at all -- in any language -- stays at match_method =
# 'act_only', not overwritten with something that looks resolved.
#
# date_end_applicability is INCLUSIVE -- it is the LAST DAY the edition is
# in force, not the first day it no longer is. Verified on prod (2026-08-23):
# 19,428 consecutive parsed editions of the same act+lang have
# next.date_applicability = prev.date_end_applicability + 1 day (e.g. SR 220
# de: 2021-01-01..2021-01-31, then 2021-02-01..2021-04-30, ...). A `<`
# predicate here treats the last day as already outside the edition, so a
# from_date that lands exactly on it matches neither this edition nor the
# next (whose date_applicability is one day later) -- `no edition for date`
# on what is in fact a perfectly ordinary, covered date.
_RESOLVE_EDITIONS = """
UPDATE ch_legislation_citations c
   SET version_id = best.version_id,
       match_method = best.method
  FROM (SELECT * FROM ch_legislation_citations WHERE match_method = 'act_only') c2
  LEFT JOIN LATERAL (
       SELECT v.version_id,
              CASE WHEN c2.from_date IS NOT NULL
                   THEN 'edition_at_date' ELSE 'latest_edition' END AS method
         FROM ch_act_version v
        WHERE v.act_id = c2.act_id
          AND v.stage = 'parsed'
          AND v.lang = ANY (ARRAY[c2.lang, 'de'])
          AND (
                (c2.from_date IS NOT NULL
                   AND v.date_applicability <= c2.from_date
                   AND (v.date_end_applicability IS NULL
                        OR c2.from_date <= v.date_end_applicability))
             OR (c2.from_date IS NULL AND v.date_applicability <= CURRENT_DATE)
              )
        ORDER BY (v.lang = c2.lang) DESC, v.date_applicability DESC, v.version_id
        LIMIT 1
  ) best ON true
 WHERE c.id = c2.id
   AND best.version_id IS NOT NULL
"""

# Step 3: version_id (+ article number) -> article. Design rule 3, plus the
# transitional-provision tiebreak: several ch_act_article rows can share the
# same bare article_number (a top-level 'art_336' and a transitional
# 'disp_u17/art_336' both carry article_number = '336'), and the path-shaped
# e_id (contains '/') is the one that must lose -- ORDER BY (e_id LIKE '%/%')
# puts non-path e_ids first, ordinal only breaks a tie within that. Only rows
# that actually found an article are updated, same reasoning as editions
# above: no match leaves article_id NULL and match_method at
# edition_at_date/latest_edition, not silently marked resolved.
_RESOLVE_ARTICLES = """
UPDATE ch_legislation_citations c
   SET article_id = best.article_id,
       resolved = true
  FROM (SELECT * FROM ch_legislation_citations
         WHERE match_method IN ('edition_at_date', 'latest_edition')
           AND article_id IS NULL) c2
  LEFT JOIN LATERAL (
       SELECT a.article_id
         FROM ch_act_article a
        WHERE a.version_id = c2.version_id
          AND a.article_number = c2.article
        ORDER BY (a.e_id LIKE '%/%'), a.ordinal
        LIMIT 1
  ) best ON true
 WHERE c.id = c2.id
   AND best.article_id IS NOT NULL
"""

# Step 4: to_raw (+ cite_kind) -> ch_court_decisions.ecli. Design rule 4 --
# 'bge' matches docket_number restricted to spider = 'CH_BGE' (ATF/DTF numbers
# are only ever CH_BGE's own docket format); 'docket' matches docket_number
# under any spider, preferring CH_BGer when several carry the same docket
# number; 'ecli' matches ecli directly. Every row citations_stage ever wrote
# gets a match_method here, including 'unresolved' when nothing matched --
# see the module docstring for why that, like unresolved_abbr, is terminal
# rather than retried on every ordinary run. `, d.ecli` closes out the
# remaining tie -- two decisions (both CH_BGer, or both some other spider)
# can legitimately share one docket_number (a correction, a re-publication),
# and without a final deterministic key the CH_BGer-preference ORDER BY alone
# leaves the pick to whatever order Postgres returns matching rows in, which
# is not guaranteed stable run to run.
_RESOLVE_CASES = """
WITH updated AS (
UPDATE ch_case_citations c
   SET to_ecli = best.ecli,
       resolved = (best.ecli IS NOT NULL),
       match_method = COALESCE(best.method, 'unresolved')
  FROM (SELECT * FROM ch_case_citations WHERE match_method IS NULL) c2
  LEFT JOIN LATERAL (
       SELECT d.ecli,
              CASE WHEN c2.cite_kind = 'ecli' THEN 'ecli_exact'
                   ELSE 'docket_exact' END AS method
         FROM ch_court_decisions d
        WHERE (c2.cite_kind = 'bge' AND d.docket_number = c2.to_raw
                                    AND d.spider = 'CH_BGE')
           OR (c2.cite_kind = 'docket' AND d.docket_number = c2.to_raw)
           OR (c2.cite_kind = 'ecli' AND d.ecli = c2.to_raw)
        ORDER BY (c2.cite_kind = 'docket' AND d.spider = 'CH_BGer') DESC, d.ecli
        LIMIT 1
  ) best ON true
 WHERE c.id = c2.id
RETURNING c.to_ecli
)
SELECT count(*) AS resolved FROM updated WHERE to_ecli IS NOT NULL
"""


def run(settings: Settings, resolve_all: bool = False,
        retry_unresolved: bool = False, retry_batch: int = 100_000) -> ResolveReport:
    if resolve_all and retry_unresolved:
        raise ValueError(
            "CHPIPE_CIT_RESOLVE_ALL and CHPIPE_CIT_RETRY_UNRESOLVED are "
            "mutually exclusive: one recomputes everything, the other only "
            "the unresolved_abbr backlog")
    report = ResolveReport()
    conn = db.connect(settings)
    try:
        with conn.cursor() as cur:
            if retry_unresolved:
                # Only the unresolved_abbr backlog, in id-ordered batches --
                # see _RETRY_ACTS. Resolved rows are never touched, and rows
                # that fail again are not rewritten, so the cursor (not a
                # re-claim) is what guarantees termination.
                after = 0
                while True:
                    cur.execute(_RETRY_ACTS,
                                {"after": after, "limit": retry_batch})
                    row = cur.fetchone()
                    if row["last_id"] is None:
                        break
                    report.acts += row["resolved"]
                    log.info("retry: attempted=%d resolved=%d through id %d",
                             row["attempted"], row["resolved"], row["last_id"])
                    after = row["last_id"]
            else:
                if resolve_all:
                    cur.execute(_RESET_LEGISLATION)
                    cur.execute(_RESET_CASES)

                # fetchone(), not rowcount: both entry points are wrapped in
                # a counting CTE (see _RESOLVE_ACTS) so all four counters
                # report resolutions rather than attempts.
                cur.execute(_RESOLVE_ACTS)
                report.acts = cur.fetchone()["resolved"]

            # Steps 2 and 3 run in every mode: their own WHEREs already
            # select exactly the rows that deserve another look (act_only,
            # and editions still missing an article) -- including the ones
            # the retry loop above just promoted to act_only.
            cur.execute(_RESOLVE_EDITIONS)
            report.editions = cur.rowcount

            cur.execute(_RESOLVE_ARTICLES)
            report.articles = cur.rowcount

            if not retry_unresolved:
                cur.execute(_RESOLVE_CASES)
                report.cases = cur.fetchone()["resolved"]
    finally:
        conn.close()
    return report


def main() -> ResolveReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 (throttle.NICE_IO): the work happens inside Postgres, not this
    process -- four UPDATE ... FROM statements and a wait for each to
    return, the same shape as aliases_stage (a handful of set-based
    queries), not a multi-hour CPU stage held open by this process's own
    threads. No wait_for_capacity(): nothing here claims a growing queue in
    a loop that could be paused between batches; it is four statements and
    done.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    resolve_all = os.environ.get("CHPIPE_CIT_RESOLVE_ALL", "") not in ("", "0")
    retry = os.environ.get("CHPIPE_CIT_RETRY_UNRESOLVED", "") not in ("", "0")
    retry_batch = int(os.environ.get("CHPIPE_CIT_BATCH", "") or 100_000)
    result = run(Settings.from_env(), resolve_all=resolve_all,
                 retry_unresolved=retry, retry_batch=retry_batch)
    log.info("acts=%d editions=%d articles=%d cases=%d",
             result.acts, result.editions, result.articles, result.cases)
    return result


if __name__ == "__main__":
    main()
