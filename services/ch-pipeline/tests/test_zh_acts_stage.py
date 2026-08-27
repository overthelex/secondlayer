"""zh_acts_stage against a mocked zh.ch, real Postgres.

The mock serves an index whose cap is 4 rows (the site's is 150) so the
bisection is exercised, and edition pages built from the fields the
parser reads. Two acts: 101 with six editions across the 1869 and 2005
constitutions (current), 102 with two editions and a repeal (withdrawn)."""
import datetime
import json
import math
import os
import pathlib
from urllib.parse import parse_qs

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import zhlex
from chpipe.config import Settings
from chpipe.stages import zh_acts_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

D = datetime.date
CAP = 4
PAGE = 2

# (nr, enactment, entry, version, publication, withdrawal, title, kinds)
EDITIONS = [
    ("101", D(1869, 4, 18), None, "000", None, D(1995, 9, 30), "Verfassung des eidgenössischen Standes Zürich", ("html",)),
    ("101", D(1869, 4, 18), None, "039", None, D(2006, 1, 1), "Verfassung des eidgenössischen Standes Zürich", ("html", "pdf")),
    ("101", D(2005, 2, 27), D(2006, 1, 1), "051", D(2006, 1, 1), D(2009, 1, 1), "Verfassung des Kantons Zürich", ("pdf",)),
    ("101", D(2005, 2, 27), D(2006, 1, 1), "121", D(2023, 4, 1), D(2024, 7, 1), "Verfassung des Kantons Zürich", ("pdf",)),
    ("101", D(2005, 2, 27), D(2006, 1, 1), "125", D(2024, 7, 1), D(2024, 7, 1), "Verfassung des Kantons Zürich", ("pdf",)),
    ("101", D(2005, 2, 27), D(2006, 1, 1), "129", D(2024, 7, 1), None, "Verfassung des Kantons Zürich", ("pdf",)),
    ("102", D(1877, 4, 15), None, "000", None, D(1998, 12, 31), "Gesetz betreffend die Einführung der Bundesverfassung", ("html",)),
    ("102", D(1877, 4, 15), None, "023", None, D(1999, 1, 1), "Gesetz betreffend die Einführung der Bundesverfassung", ()),
]


def _link(nr, enactment, entry, version):
    return (f"/de/politik-staat/gesetze-beschluesse/gesetzessammlung/zhlex-ls/erlass-{nr.replace('.', '_')}-"
            f"{enactment.strftime('%Y_%m_%d')}-{entry.strftime('%Y_%m_%d') if entry else ''}-{version}.html")


def _d(value):
    return value.strftime("%d.%m.%Y") if value else "-"


def _page(nr, enactment, entry, version, publication, withdrawal, title, kinds):
    history = "".join(
        f'<li><a href="{_link(*e[:4])}"><input {"checked" if e[3] == version else ""} id="h{e[3]}" '
        f'name="singleSelectHistory" type="radio" value="{e[3]}">'
        f'<label for="h{e[3]}">{e[3]} ({"aktuell" if e[5] is None else "in Kraft bis " + _d(e[5])})</label></a></li>'
        for e in EDITIONS if e[0] == nr)
    downloads = ""
    if "pdf" in kinds:
        downloads += (f'<a class="atm-linklist_item atm-linklist_item--download" href="{zhlex.PDF_PREFIX}'
                      f'?Open&amp;docid=D{nr}{version}&amp;file={nr}_{version}.pdf">PDF</a>')
    if "html" in kinds:
        downloads += (f'<a class="atm-linklist_item atm-linklist_item--download" href="{zhlex.WEBRT_PREFIX}'
                      f'H{nr.replace(".", "")}{version}">HTML</a>')
    fields = [("Erlasstitel", title), ("Ordnungsnummer", nr), ("Kurztitel", "-"),
              ("Erlassdatum", _d(enactment)), ("Inkraftsetzungsdatum", _d(entry)),
              ("Aufhebungsdatum", _d(withdrawal)), ("Bandnummer", "1"),
              ("Publikationsdatum", _d(publication)), ("Hinweise", "-"),
              (f"Link auf {version} (x)", f"<span>http://www.zhlex.zh.ch/Erlass.html?Open&amp;Ordnr={nr},{version}</span>"),
              ("Link auf aktuelle Version", f"<span>http://www.zhlex.zh.ch/Erlass.html?Open&amp;Ordnr={nr}</span>")]
    dl = "".join(f"<dl><dt>{k}</dt><dd>{v}</dd></dl>" for k, v in fields)
    return (f'<html><head><meta charset="utf-8"></head><body><h1>{title}</h1>'
            f'<ul class="atm-list">{history}</ul><div class="mdl-download_list">{downloads}</div>'
            f'<div class="mdl-metablock">{dl}</div></body></html>')


class Site:
    def __init__(self, fail_pages: set[str] = frozenset(), cap: int = CAP,
                 hide_from_index: set[str] = frozenset()):
        self.calls: list[str] = []
        self.index_calls: list[dict] = []
        self.fail_pages = set(fail_pages)
        self.cap = cap
        self.hide_from_index = set(hide_from_index)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        if path.endswith(".zhweb-cache.json"):
            q = {k: v[0] for k, v in parse_qs(str(request.url.query, "ascii")).items()}
            self.index_calls.append(q)
            assert q.get("includeRepealedEnactments") == "true"
            since, until = (D.fromisoformat(s) for s in q["enactmentDate"].split("_"))
            rows = [e for e in EDITIONS if since <= e[1] <= until and e[3] not in self.hide_from_index]
            capped = len(rows) > self.cap
            rows = rows[:self.cap] if capped else rows
            page = int(q.get("page", "1"))
            chunk = rows[(page - 1) * PAGE:page * PAGE]
            return httpx.Response(200, json={
                "data": [{"link": _link(*e[:4]), "referenceNumber": e[0], "enactmentTitle": e[6],
                          "enactmentDate": _d(e[1]), "withdrawalDate": _d(e[5]) if e[5] else ""}
                         for e in chunk],
                "numberOfResults": len(rows), "numberOfResultPages": math.ceil(len(rows) / PAGE),
                "moreSearchResultsThanAllowed": capped})
        for e in EDITIONS:
            if path == _link(*e[:4]):
                if e[3] in self.fail_pages and e[0] == "101":
                    return httpx.Response(503, text="down")
                return httpx.Response(200, content=_page(*e).encode("utf-8"),
                                      headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404, text=f"unmocked {path}")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, retry_backoff_minutes=(), cantonal_per_host=2)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, "
                  "is_active, versions_json, version_count) VALUES (21736, 'ZH', '101', true, '[]', 0), "
                  "(99, 'ZH', '102', false, '[]', 0), (98, 'ZH', '102', true, '[]', 0), "
                  "(5, 'BE', '101', true, '[]', 0)")
        yield c


def _run(settings, site, **kw):
    return zh_acts_stage.run(settings, transport=httpx.MockTransport(site), rate=0, **kw)


def _versions(conn, nr):
    return conn.execute(
        "SELECT v.eli_consolidation_uri, v.date_applicability, v.date_end_applicability, v.xml_url, "
        "v.source, v.stage, v.lang FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number = %s ORDER BY v.eli_consolidation_uri", (nr,)).fetchall()


def test_enumerates_the_index_under_the_cap_and_materialises_acts_and_editions(conn, settings):
    site = Site()
    report = _run(settings, site)
    assert report.errors == 0 and report.capped_slices == []
    assert report.editions_indexed == 8 and report.acts == 2 and report.versions == 8
    assert report.html_editions == 3 and report.pdf_editions == 4 and report.no_text == 1
    assert report.lexfind_matched == 2 and report.pages_failed == 0 and report.historie_mismatch == 0
    ranges = [q["enactmentDate"] for q in site.index_calls]
    assert ranges[0].startswith("1800-01-01_") and len(ranges) > 1, "the full range is capped and bisected"
    assert all(len(q["enactmentDate"]) == 21 for q in site.index_calls)

    act = conn.execute(
        "SELECT eli_work_uri, jurisdiction, title_de, in_force, enforcement_status, date_document, "
        "date_entry_force, date_no_longer_in_force, metadata_json FROM ch_act WHERE sr_number='101'").fetchone()
    assert act[0] == "http://www.zhlex.zh.ch/Erlass.html?Open&Ordnr=101"
    assert act[1:5] == ("ZH", "Verfassung des Kantons Zürich", True, 0)
    assert act[5] == D(1869, 4, 18) and act[6] == D(1869, 4, 18) and act[7] is None
    meta = act[8]
    assert meta["platform"] == "zhlex" and meta["lexfind_tol_id"] == 21736
    assert meta["current_version"] == "129" and meta["page_url"].endswith("-129.html")
    assert meta["editions"]["039"]["kind"] == "html" and meta["editions"]["129"]["kind"] == "pdf"
    assert meta["editions"]["121"]["publication"] == "2023-04-01"

    rows = _versions(conn, "101")
    assert [r[0] for r in rows] == [f"zhlex:101/{n}" for n in ("000", "039", "051", "121", "125", "129")]
    assert [(r[1], r[2]) for r in rows] == [
        (D(1869, 4, 18), D(1995, 9, 30)),
        (D(1995, 10, 1), D(2005, 12, 31)),
        (D(2006, 1, 1), D(2023, 3, 31)),
        (D(2023, 4, 1), D(2024, 6, 30)),
        (D(2024, 7, 1), D(2024, 6, 30)),      # replaced the same day: never in force
        (D(2024, 7, 1), None),
    ]
    assert rows[0][3].startswith(zhlex.WEBRT_PREFIX) and rows[1][3].startswith(zhlex.WEBRT_PREFIX)
    assert rows[5][3].startswith(zhlex.PDF_PREFIX)
    assert {r[4:] for r in rows} == {("zhlex", "discovered", "de")}
    assert conn.execute("SELECT count(*) FROM ch_act_version v JOIN ch_act a USING (act_id) "
                        "WHERE a.sr_number='101' AND v.date_end_applicability IS NULL").fetchone()[0] == 1

    withdrawn = conn.execute("SELECT in_force, enforcement_status, date_no_longer_in_force, metadata_json "
                             "FROM ch_act WHERE sr_number='102'").fetchone()
    assert withdrawn[:3] == (False, 3, D(1999, 1, 1))
    assert withdrawn[3]["lexfind_tol_id"] == 98, "the active LexFind entry wins a duplicated number"
    rows = _versions(conn, "102")
    assert [(r[1], r[2], r[3]) for r in rows] == [
        (D(1877, 4, 15), D(1998, 12, 31), zhlex.WEBRT_PREFIX + "H102000"),
        (D(1999, 1, 1), D(1998, 12, 31), None),
    ]


def test_rerun_is_idempotent_and_keeps_stage_while_re_deriving_ends(conn, settings):
    _run(settings, Site())
    conn.execute("UPDATE ch_act_version SET stage = 'parsed', date_end_applicability = NULL")
    _run(settings, Site())
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 2
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 8
    assert conn.execute("SELECT DISTINCT stage FROM ch_act_version").fetchall() == [("parsed",)]
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE date_end_applicability IS NOT NULL"
                        ).fetchone()[0] == 7


def test_a_failed_edition_page_is_counted_and_the_act_still_written(conn, settings):
    report = _run(settings, Site(fail_pages={"121"}))
    assert report.pages_failed == 1 and report.acts == 2 and report.errors == 0
    assert "101/121" in report.pages_failed_samples[0]
    rows = _versions(conn, "101")
    assert len(rows) == 5 and not any(r[0].endswith("/121") for r in rows)
    # 051's end now comes from 125's start, the neighbours' own pages
    assert rows[2][1:3] == (D(2006, 1, 1), D(2024, 6, 30))
    assert report.historie_mismatch == 0, "the Historie is compared with the index, not with what was fetched"


def test_only_restricts_the_walk_to_the_named_numbers(conn, settings):
    site = Site()
    report = _run(settings, site, only={"102"})
    assert report.acts == 1
    assert conn.execute("SELECT sr_number FROM ch_act").fetchall() == [("102",)]
    assert not any(p.endswith("-129.html") for p in site.calls)


def test_a_single_day_still_over_the_cap_falls_back_to_chapters_and_is_reported(conn, settings):
    """Six editions of 101 share the enactment day 27.02.2005 only in part
    here; with the cap at 1 even one day overflows, so the walk splits by
    fileNumber and reports the slices that are still capped."""
    site = Site(cap=1)
    report = _run(settings, site)
    assert any("fileNumber" in q for q in site.index_calls)
    assert report.capped_slices and all("fileNumber=" in s for s in report.capped_slices)
    assert report.acts == 2, "the rows under the cap are still materialised"


def test_an_edition_the_index_skipped_is_fetched_from_the_historie(conn, settings):
    """zh.ch pages on an unstable sort: two full walks on 2026-08-27 gave
    7,055 and 6,740 rows for 6,765 distinct pages."""
    site = Site(hide_from_index={"121"})
    report = _run(settings, site)
    assert report.editions_indexed == 7 and report.historie_added == 1 and report.versions == 8
    assert report.historie_mismatch == 0
    rows = _versions(conn, "101")
    assert [r[0] for r in rows] == [f"zhlex:101/{n}" for n in ("000", "039", "051", "121", "125", "129")]
    assert rows[3][1:3] == (D(2023, 4, 1), D(2024, 6, 30))
