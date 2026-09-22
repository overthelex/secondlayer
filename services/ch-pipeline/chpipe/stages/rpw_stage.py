"""RPW/DPC issues -> one ch_court_decisions row per WEKO / Secretariat
decision (spider CH_WEKO_RPW). See chpipe/rpw.py for why and how the cut
works.

What this stage does, per issue listed on the RPW page of weko.admin.ch:

  1. downloads the issue PDF once into {raw_dir}/CH_WEKO_RPW/issues/ (kept:
     a re-cut after a parser fix must not cost a re-download of ~170 files
     from a federal office's server);
  2. skips it when its rows already carry this file's sha256 (resume: an
     interrupted walk restarts where it stopped). An issue is written in ONE
     transaction, so a sha in the table means the whole issue landed, never
     a prefix of it;
  3. pdftotext -layout, the flags text_extract.from_pdf uses for every other
     Swiss PDF, split into pages on the form feeds;
  4. cuts the chapters B1/B2 into documents and writes each one with its
     text already in place, at stage 'extracted' (or 'failed' when the text
     is under the quality threshold -- a slice of a page range has no scan
     of its own to OCR);
  5. deletes, in the same transaction, the rows of this issue that the cut
     no longer produces (a parser or chapter change on a forced re-cut), with
     their citation edges and queue rows -- a document the journal does not
     contain must not stay searchable.

It skips fetch and extract because there is no per-document file to fetch.
From 'extracted' on, the rows are the pipeline's like any other:

    ./run-stage.sh rpw                       # every issue
    CHPIPE_RPW_YEARS=2024 ./run-stage.sh rpw # one year (or 1997-2005)
    ./run-stage.sh load CH_WEKO_RPW
    ./run-stage.sh citations CH_WEKO_RPW

Environment: CHPIPE_RPW_YEARS (a year or a range, default all),
CHPIPE_RPW_CHAPTERS (default B1,B2), CHPIPE_RPW_FORCE=1 (download every
selected issue again and re-cut it even when its sha256 is loaded -- for a
parser change, or to pick up a file WEKO replaced: without it a downloaded
issue is never fetched a second time).

An upsert rewrites a row only when its text or its source file changed, so a
re-run does not churn ch_court_decisions' 7.6 GB full-text GIN for nothing.
A new file with byte-identical text for a document rewrites that row (its
pdf_sha256 and pdf_url must follow the file) but does not re-queue it for
citations.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

import psycopg

from .. import db, rpw, text_extract, text_quality, throttle
from ..config import Settings
from ..http import Fetcher, FetchError
from ..portals.common import filename_of, links

log = logging.getLogger(__name__)

INDEX_URL = "https://www.weko.admin.ch/de/recht-und-politik-des-wettbewerbs-rpw"
REQUEST_DELAY = 1.0             # seconds between downloads: one federal server
PDFTOTEXT_TIMEOUT = 900         # a 1,000-page issue takes minutes, not the 120 s a decision gets
DOWNLOAD_TIMEOUT = 300.0


@dataclass
class RpwReport:
    issues_listed: int = 0
    issues_downloaded: int = 0
    issues_skipped: int = 0          # already loaded from this very file
    issues_failed: int = 0           # could not be downloaded or read: exit status 1
    documents: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    below_threshold: int = 0         # written as 'failed'
    deleted: int = 0                 # rows of a re-cut issue its new cut no longer produces
    same_as_entscheidsuche: int = 0
    by_issue: dict[str, int] = field(default_factory=dict)


_UPSERT = """
INSERT INTO ch_court_decisions
    (ecli, spider, doc_id, canton, court_code, court_name, chamber, decision_type,
     decision_date, docket_number, abstract, full_text, languages, metadata_json,
     pdf_url, text_source, text_quality, pdf_sha256, stage, attempts, last_error,
     failed_stage, stage_updated_at, imported_at, updated_at)
VALUES
    (%(ecli)s, %(spider)s, %(doc_id)s, 'CH', %(court_code)s, %(court_name)s, %(chamber)s,
     %(decision_type)s, %(decision_date)s, %(docket_number)s, %(abstract)s, %(full_text)s,
     %(languages)s, %(metadata)s::jsonb, %(pdf_url)s, 'pdf', %(text_quality)s, %(pdf_sha256)s,
     %(stage)s, 0, %(last_error)s, NULL, now(), now(), now())
ON CONFLICT (ecli) DO UPDATE SET
    court_name = EXCLUDED.court_name, chamber = EXCLUDED.chamber,
    decision_type = EXCLUDED.decision_type, decision_date = EXCLUDED.decision_date,
    docket_number = EXCLUDED.docket_number, abstract = EXCLUDED.abstract,
    full_text = EXCLUDED.full_text, languages = EXCLUDED.languages,
    metadata_json = EXCLUDED.metadata_json, pdf_url = EXCLUDED.pdf_url,
    text_source = 'pdf', text_quality = EXCLUDED.text_quality,
    pdf_sha256 = EXCLUDED.pdf_sha256, stage = EXCLUDED.stage, attempts = 0,
    last_error = EXCLUDED.last_error, failed_stage = NULL,
    stage_updated_at = now(), updated_at = now()
WHERE ch_court_decisions.full_text IS DISTINCT FROM EXCLUDED.full_text
   OR ch_court_decisions.pdf_sha256 IS DISTINCT FROM EXCLUDED.pdf_sha256
RETURNING (xmax = 0) AS inserted,
          (SELECT full_text FROM ch_court_decisions o WHERE o.ecli = %(ecli)s) IS DISTINCT FROM %(full_text)s AS text_changed
"""

_ISSUE_ROWS = ("SELECT ecli, doc_id FROM ch_court_decisions "
               "WHERE spider = %s AND metadata_json->'rpw'->>'issue_key' = %s")

_LOADED_SHAS = ("SELECT DISTINCT pdf_sha256 FROM ch_court_decisions "
                "WHERE spider = %s AND pdf_sha256 IS NOT NULL")
_ENTSCHEIDSUCHE_WEKO = ("SELECT ecli, docket_number, abstract, decision_date "
                        "FROM ch_court_decisions WHERE spider = 'CH_WEKO'")


def years_filter(spec: str | None):
    """'2024' -> {2024}; '1997-2005' -> that range; empty -> no filter."""
    if not spec or not spec.strip():
        return None
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d{4})(?:-(\d{4}))?", part)
        if not m:
            raise ValueError(f"CHPIPE_RPW_YEARS: {part!r} is not a year or a range")
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        out.update(range(lo, hi + 1))
    return out


def list_issues(page_html: str, base: str = INDEX_URL) -> list[tuple[rpw.Issue, str]]:
    """Every issue PDF the RPW page links, once, oldest first. The indexes
    ("Chronologisches/Systematisches Verzeichnis") are not issues."""
    seen: dict[rpw.Issue, str] = {}
    for href, _text in links(page_html, base, r"\.pdf"):
        name = filename_of(href)
        if re.search(r"verzeichnis|index", name, re.I):
            continue
        issue = rpw.issue_of(name)
        if issue and issue not in seen:
            seen[issue] = href
    return sorted(seen.items(), key=lambda kv: (kv[0].year, kv[0].number, kv[0].part))


def pdf_pages(path) -> list[str]:
    completed = subprocess.run(
        ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
        capture_output=True, timeout=PDFTOTEXT_TIMEOUT)
    if completed.returncode != 0:
        raise RuntimeError(f"pdftotext exit {completed.returncode}: {completed.stderr[:300]!r}")
    text = completed.stdout.decode("utf-8", errors="replace")
    # Form feeds split the pages BEFORE the control characters go (\f is one).
    return [text_extract._strip_control_characters(p) for p in text.split("\f")]


def language_of(text: str) -> tuple[str, float]:
    """The language the text reads best in, and that score. RPW prints each
    decision in its procedural language only, and the issue says nothing
    about which one."""
    scores = {lang: text_quality.score(text, [lang]) for lang in text_quality.CH_LANGUAGES}
    lang = max(scores, key=scores.get)
    return lang, scores[lang]


def same_as_index(rows) -> dict[str, list[tuple[str, int | None]]]:
    """entscheidsuche's CH_WEKO rows by normalised title: a document that is
    in both keeps both rows (the RPW one has the journal citation, the
    entscheidsuche one the source's own file), and says so in metadata.
    Rows are db.connect()'s dict rows."""
    out: dict[str, list[tuple[str, int | None]]] = {}
    for r in rows:
        key = rpw.norm_title(r["docket_number"] or r["abstract"])
        if key:
            d = r["decision_date"]
            out.setdefault(key, []).append((r["ecli"], d.year if d else None))
    return out


def match_same(index, title: str, year: int | None) -> str | None:
    key = rpw.norm_title(title)
    if not key:
        return None
    for ecli, y in index.get(key, []):
        if year is None or y is None or abs(y - year) <= 1:
            return ecli
    return None


def row_for(issue: rpw.Issue, url: str, sha: str, doc: rpw.Document, same_as: dict) -> dict:
    lang, quality = language_of(doc.text)
    decided = rpw.decision_date(doc.text)
    doc_id = rpw.doc_id(issue, doc)
    same = match_same(same_as, doc.title, decided.year if decided else issue.year)
    good = quality >= text_quality.ACCEPT_THRESHOLD and len(doc.text) >= 200
    meta = {
        "rpw": {
            "issue": issue.label, "issue_key": issue.key, "issue_url": url, "issue_sha256": sha,
            "chapter": doc.chapter, "section": doc.section, "section_name": doc.section_name,
            "item": doc.item, "journal_pages": list(doc.journal_pages),
            "pdf_page": doc.start_page.index, "citation": rpw.citation(issue, doc),
            **({"same_as": same} if same else {}),
        },
        "Sprache": lang,
    }
    return {
        "ecli": f"ECLI:CH:{rpw.SPIDER}:{doc_id}",
        "spider": rpw.SPIDER,
        "doc_id": doc_id,
        "court_code": rpw.COURT_CODE,
        "court_name": rpw.COURT_NAME,
        "chamber": rpw.CHAPTER_NAMES.get(doc.chapter, doc.chapter),
        "decision_type": doc.section_name or f"{doc.chapter}.{doc.section}",
        "decision_date": decided,
        "docket_number": rpw.citation(issue, doc),
        "abstract": doc.title or None,
        "full_text": doc.text,
        "languages": [lang],
        "metadata": json.dumps(meta, ensure_ascii=False, default=str),
        # #page= opens the issue at the decision in any PDF viewer.
        "pdf_url": f"{url}#page={doc.start_page.index}",
        "text_quality": round(quality, 4),
        "pdf_sha256": sha,
        "stage": "extracted" if good else "failed",
        "last_error": None if good else
            f"rpw: text quality {quality:.3f} / {len(doc.text)} chars below the threshold",
    }


def write_issue(conn, issue, url, sha, docs, same_as, report: RpwReport) -> None:
    """One issue, one transaction: its rows, the deletion of the rows its cut
    no longer produces, and their citation-queue bookkeeping. The sha256 is
    the resume marker, so it must never be committed for part of an issue."""
    with conn.transaction():
        written: set[str] = set()
        for doc in docs:
            row = row_for(issue, url, sha, doc, same_as)
            written.add(row["ecli"])
            res = conn.execute(_UPSERT, row).fetchone()
            report.documents += 1
            if row["stage"] == "failed":
                report.below_threshold += 1
            if "same_as" in json.loads(row["metadata"])["rpw"]:
                report.same_as_entscheidsuche += 1
            if res is None:
                report.unchanged += 1
                continue
            report.inserted += int(bool(res["inserted"]))
            report.updated += int(not res["inserted"])
            if row["stage"] == "extracted" and (res["inserted"] or res["text_changed"]):
                # New text: its citation edges (if any) are stale -- the same
                # re-queue db.complete(-> 'extracted') does for every other spider.
                db.enqueue_for_citations(conn, [row["ecli"]])
        stale = [r["ecli"] for r in conn.execute(_ISSUE_ROWS, (rpw.SPIDER, issue.key)).fetchall()
                 if r["ecli"] not in written]
        if stale:
            db.delete_citations(conn, stale)
            conn.execute("DELETE FROM ch_citation_state WHERE ecli = ANY(%s)", (stale,))
            conn.execute("DELETE FROM ch_court_decisions WHERE ecli = ANY(%s)", (stale,))
            report.deleted += len(stale)
            log.info("%s: deleted %d rows the new cut no longer produces", issue.key, len(stale))


async def _download(fetcher: Fetcher, url: str, path) -> None:
    await asyncio.sleep(REQUEST_DELAY)
    body = await fetcher.bytes(url)
    if not body.startswith(b"%PDF"):
        raise FetchError(f"{url}: not a PDF ({body[:40]!r})")
    tmp = path.with_suffix(".part")
    tmp.write_bytes(body)
    tmp.replace(path)


async def _run_async(settings: Settings, years, chapters, force: bool, transport) -> RpwReport:
    report = RpwReport()
    issues_dir = settings.raw_dir / rpw.SPIDER / "issues"
    issues_dir.mkdir(parents=True, exist_ok=True)
    conn = db.connect(settings)
    try:
        loaded = {r["pdf_sha256"] for r in conn.execute(_LOADED_SHAS, (rpw.SPIDER,)).fetchall()}
        same_as = same_as_index(conn.execute(_ENTSCHEIDSUCHE_WEKO).fetchall())
        async with Fetcher(concurrency=1, timeout=DOWNLOAD_TIMEOUT, transport=transport) as fetcher:
            issues = list_issues(await fetcher.text(INDEX_URL))
            if not issues:
                # The page always lists ~170 issues: none is a changed page, not an empty journal.
                raise RuntimeError(f"{INDEX_URL}: no issue PDFs found")
            issues = [(i, u) for i, u in issues if years is None or i.year in years]
            report.issues_listed = len(issues)
            for issue, url in issues:
                path = issues_dir / f"RPW_{issue.key}.pdf"
                try:
                    if force or not path.exists():
                        await _download(fetcher, url, path)
                        report.issues_downloaded += 1
                    sha = hashlib.sha256(path.read_bytes()).hexdigest()
                    if sha in loaded and not force:
                        report.issues_skipped += 1
                        continue
                    throttle.wait_for_capacity(settings.load_ceiling, "rpw")
                    pages = rpw.pages_of(pdf_pages(path), issue)
                    docs = rpw.split(pages, chapters)
                except (FetchError, RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
                    log.error("%s: %s", issue.key, exc)
                    report.issues_failed += 1
                    continue
                if not any(p.arabic for p in pages):
                    log.error("%s: no running header on any page -- not an RPW issue layout", issue.key)
                    report.issues_failed += 1
                    continue
                try:
                    write_issue(conn, issue, url, sha, docs, same_as, report)
                except (psycopg.DataError, psycopg.IntegrityError) as exc:
                    # A value the table refuses: this issue's transaction is
                    # rolled back whole and the walk goes on. A lost
                    # connection or a missing column is no issue's fault and
                    # propagates, as in portals_discover_stage.
                    log.error("%s: write failed, issue rolled back: %s", issue.key, exc)
                    report.issues_failed += 1
                    continue
                report.by_issue[issue.key] = len(docs)
                log.info("%s: %d documents (%d pages)", issue.key, len(docs), len(pages))
    finally:
        conn.close()
    return report


def run(settings: Settings, years=None, chapters=rpw.DEFAULT_CHAPTERS, force: bool = False,
        transport=None) -> RpwReport:
    return asyncio.run(_run_async(settings, years, tuple(chapters), force, transport))


def main() -> RpwReport:
    """Entry point (a function -- see tests/test_entry_points.py)."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    chapters = tuple(c.strip() for c in (os.environ.get("CHPIPE_RPW_CHAPTERS") or "").split(",") if c.strip()) \
        or rpw.DEFAULT_CHAPTERS
    result = run(Settings.from_env(),
                 years=years_filter(os.environ.get("CHPIPE_RPW_YEARS")),
                 chapters=chapters,
                 force=os.environ.get("CHPIPE_RPW_FORCE") == "1")
    log.info("rpw issues listed=%d downloaded=%d skipped=%d failed=%d documents=%d "
             "inserted=%d updated=%d unchanged=%d deleted=%d below_threshold=%d same_as=%d",
             result.issues_listed, result.issues_downloaded, result.issues_skipped,
             result.issues_failed, result.documents, result.inserted, result.updated,
             result.unchanged, result.deleted, result.below_threshold, result.same_as_entscheidsuche)
    return result


if __name__ == "__main__":
    sys.exit(1 if main().issues_failed else 0)
