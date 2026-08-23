"""Walk each act's editions in date order and write the change log.

Fedlex publishes editions, not amendments. ch_act_change is computed here, and
it is the answer to "which article changed, when" -- the question the flat
table could not express at all.

Editions are compared in date_applicability order, never insertion order: a
corpus that discovered editions out of the order Fedlex published them (a
plausible walk order for versions_stage, which is driven by work batches, not
by date) would otherwise diff a later edition against an earlier one it
happens to have been written after, not the one immediately before it in
force. Languages are diffed separately -- one lang value drives every query in
a run, and diff_articles.diff() is only ever called with two editions of the
same lang -- so a German wording change is never compared against a French
edition of the same date.

Guarding the per-act body: same defect class as acts_stage.run()'s per-row
try/except and parse_akn_stage.run()'s per-version one. One act with
malformed articles (a bad row, a parser exception surfacing late) must not
kill a walk over thousands of others -- the whole per-act body, from reading
its editions through writing every comparison's changes, is wrapped, and a
failure inside it is logged, counted in report.errors, and skipped, so the
walk continues.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, diff_articles
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class DiffReport:
    acts: int = 0
    comparisons: int = 0
    changes: int = 0
    added: int = 0
    modified: int = 0
    repealed: int = 0
    # One act whose editions raise (a malformed article, a write error) must
    # not abort the walk over the rest of ch_act. Counted here instead, same
    # shape as acts_stage.ActsReport.errors / parse_akn_stage.ParseReport.failed.
    errors: int = 0


_UPSERT_CHANGE = """
INSERT INTO ch_act_change
    (act_id, lang, from_version_id, to_version_id, e_id,
     article_number, change_type, date_applicability)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (to_version_id, e_id) DO UPDATE SET
    from_version_id    = EXCLUDED.from_version_id,
    change_type        = EXCLUDED.change_type,
    article_number     = EXCLUDED.article_number,
    date_applicability = EXCLUDED.date_applicability
"""


def _articles(conn, version_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT e_id, article_number, text FROM ch_act_article "
        "WHERE version_id = %s ORDER BY ordinal", (version_id,)).fetchall()]


def run(settings: Settings, lang: str = "de", act_id: int | None = None) -> DiffReport:
    report = DiffReport()
    conn = db.connect(settings)
    try:
        sql = ("SELECT DISTINCT act_id FROM ch_act_version "
               "WHERE lang = %s AND stage = 'parsed'")
        params: list = [lang]
        if act_id is not None:
            sql += " AND act_id = %s"
            params.append(act_id)
        sql += " ORDER BY act_id"
        acts = [r["act_id"] for r in conn.execute(sql, params).fetchall()]

        for current_act in acts:
            # The whole per-act body is guarded, not just one query inside
            # it: a malformed row can surface from the versions SELECT, from
            # _articles(), from diff_articles.diff() itself, or from the
            # write -- and any of those must count as one failed act, not
            # kill the walk over the rest of ch_act. See the module
            # docstring.
            try:
                versions = conn.execute(
                    "SELECT version_id, date_applicability FROM ch_act_version "
                    "WHERE act_id = %s AND lang = %s AND stage = 'parsed' "
                    "ORDER BY date_applicability, version_id",
                    (current_act, lang)).fetchall()
                previous = None
                for version in versions:
                    if previous is None:
                        previous = version
                        continue
                    changes = diff_articles.diff(
                        _articles(conn, previous["version_id"]),
                        _articles(conn, version["version_id"]))
                    report.comparisons += 1
                    for change in changes:
                        conn.execute(_UPSERT_CHANGE, (
                            current_act, lang, previous["version_id"],
                            version["version_id"], change.e_id,
                            change.article_number, change.change_type,
                            version["date_applicability"]))
                        report.changes += 1
                        setattr(report, change.change_type,
                                getattr(report, change.change_type) + 1)
                    previous = version
            except Exception as exc:                        # noqa: BLE001
                log.error("act %s: %s", current_act, exc)
                report.errors += 1
                continue

            report.acts += 1
            if report.acts % 200 == 0:
                log.info("acts=%d changes=%d", report.acts, report.changes)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(), lang=os.environ.get("CHPIPE_LANG", "de"))
    log.info("acts=%d comparisons=%d changes=%d (added=%d modified=%d repealed=%d) "
             "errors=%d", result.acts, result.comparisons, result.changes,
             result.added, result.modified, result.repealed, result.errors)
