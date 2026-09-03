"""The portal parsers against captured pages (tests/fixtures/portals, taken
live on 2026-09-03 and trimmed), and the shared helpers. No network, no
database: discovery is exercised with a MockTransport that serves the
fixtures, so what is under test is that each portal turns its page shape
into PortalDocs the queue can carry."""
import asyncio
import datetime
import json
import pathlib

import httpx
import pytest

from chpipe.http import Fetcher
from chpipe.portals import PORTALS, PORTAL_SPIDERS, comcom, elcom, emark, esbk, eschk, finma, finma_vr, mkg, postcom, pue, rab, ubi
from chpipe.portals import common
from chpipe.portals.common import PortalDoc, parse_date, last_date, safe_doc_id

FIX = pathlib.Path(__file__).parent / "fixtures" / "portals"
D = datetime.date


def fx(name: str) -> str:
    return (FIX / name).read_text()


@pytest.mark.parametrize("text, expected", [
    ("13.07.2026", D(2026, 7, 13)),
    ("Beschluss vom 23. Januar 2024", D(2024, 1, 23)),
    ("arrêt du 18 mai 2005", D(2005, 5, 18)),
    ("1er février 2020", D(2020, 2, 1)),
    ("sentenza del 3 agosto 2021", D(2021, 8, 3)),
    ("öffVF 2024-12-19. Entscheid", D(2024, 12, 19)),
    ("PDF, 584.19 kB, 13. August 2026", D(2026, 8, 13)),
    ("32.13.2020 nothing", None),
    ("", None),
    (None, None),
])
def test_parse_date(text, expected):
    assert parse_date(text) == expected


def test_last_date_takes_the_trailing_one():
    assert last_date("211-00500 Anrechenbarkeit ... 2021, 2.6.2026") == D(2026, 6, 2)
    assert last_date("Verfügung 1-2023 vom 02.02.2023, publiziert 10.03.2023") == D(2023, 3, 10)


def test_safe_doc_id_is_a_filename_and_deterministic():
    assert safe_doc_id("FINMA", "2025-35") == "FINMA_2025-35"
    assert safe_doc_id("öffVF 2024-12-19. Entscheid/ComCom i.S. Init7") == "offVF_2024-12-19._Entscheid_ComCom_i.S._Init7"
    assert safe_doc_id("Verf%C3%BCgung_der_RAB") == "Verfugung_der_RAB"
    assert safe_doc_id("a" * 300).__len__() <= 120
    assert safe_doc_id("") == "doc"
    with pytest.raises(ValueError):
        PortalDoc(doc_id="has/slash", url="u")
    with pytest.raises(ValueError):
        PortalDoc(doc_id="x", url="u", text_source="docx")
    assert PortalDoc(doc_id="x", url="u", lang="rm").lang is None


def test_registry_names_are_safe_spider_names():
    assert len(PORTALS) == 12
    for name, mod in PORTALS.items():
        assert name == mod.SPIDER and name.startswith("CH_")
        assert safe_doc_id(name) == name
        assert mod.TEXT_SOURCE in ("pdf", "html") and mod.COURT_NAME and mod.DECISION_TYPE
    assert PORTAL_SPIDERS == frozenset(PORTALS)


def test_download_items_reads_title_description_and_meta():
    items = common.download_items(fx("eschk_2024.html"), "https://www.eschk.admin.ch")
    assert len(items) == 2
    assert items[0].title == "GT K (Beschluss vom 23. Januar 2024)"
    assert items[0].description.startswith("Konzerte")
    assert items[0].href == "https://www.eschk.admin.ch/dam/de/sd-web/WczDveCpZFab/gtk-dfi-2024.pdf"
    assert items[0].meta_date == D(2024, 1, 23)


def test_nuxt_payload_decodes_file_objects():
    payload = common.nuxt_payload(fx("esbk_strafrecht.html"))
    files = common.nuxt_files(payload)
    assert len(files) == 27
    assert all(f["url"].startswith("https://backend.esbk.admin.ch/fileservice/") for f in files)
    assert {f["filename"] for f in files} >= {"62-2023-016-01-f.pdf", "62-2023-002-03-d.pdf"}


# --- one discovery per portal, against a mocked site ----------------------------

class Site:
    """Routes by URL substring to a fixture (or a status)."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.calls: list[str] = []

    def __call__(self, request):
        url = str(request.url)
        self.calls.append(url)
        for key, body in self.routes.items():
            if key in url:
                if isinstance(body, int):
                    return httpx.Response(body, text="")
                if isinstance(body, dict):
                    return httpx.Response(200, json=body)
                return httpx.Response(200, text=body)
        return httpx.Response(404, text=url)


def discover(mod, site, known=frozenset()):
    async def go():
        async with Fetcher(concurrency=1, transport=httpx.MockTransport(site)) as f:
            return await mod.discover(f, set(known))
    return asyncio.run(go())


def test_finma_enforcement_lists_the_api_and_points_at_the_html_detail():
    site = Site({"api/search/getresult": json.loads(fx("finma_enf_api.json"))})
    docs = discover(finma, site)
    assert [d.docket_number for d in docs][:3] == ["2025-35", "2025-47", "2025-34"]
    d = docs[0]
    assert d.doc_id == "FINMA_2025-35" and d.text_source == "html"
    assert d.url == "https://www.finma.ch/de/dokumentation/enforcementberichterstattung/kasuistik/2025-35/"
    assert d.decision_date == D(2025, 12, 19) and d.lang == "de" and d.chamber == "Bewilligte"
    assert site.calls and "getresult" in site.calls[0]


def test_finma_insurance_collection_reads_language_and_origin_from_the_title():
    site = Site({"api/search/getresult": json.loads(fx("finma_vr_api.json"))})
    docs = discover(finma_vr, site)
    assert len(docs) == 4
    d = docs[0]
    assert d.title == "21. Oktober 2024 Tessin Italienisch"
    assert d.lang == "it" and d.chamber == "Tessin" and d.decision_date == D(2024, 10, 21)
    assert d.url.startswith("https://www.finma.ch/~/media/finma/") and d.url.lower().endswith(".pdf")
    assert d.text_source == "pdf" and d.doc_id.startswith("VR_")
    assert len({x.doc_id for x in docs}) == len(docs)
    assert docs[2].lang == "de" and docs[2].chamber == "Bundesgericht"


def test_ubi_reads_rows_and_follows_the_next_link_once():
    page = fx("ubi_p1.html")
    site = Site({"currentPage%5D=2": "<html><table></table></html>", "entscheide-suchen": page})
    docs = discover(ubi, site)
    assert docs and docs[0].docket_number == "b.1111" and docs[0].doc_id == "b.1111"
    assert docs[0].url == "https://www.ubi.admin.ch/inhalte/entscheide/b.1111.pdf"
    assert docs[0].decision_date == D(2026, 7, 13) and docs[0].lang == "de"
    assert docs[0].extra["outcome"] == "Nicht eintreten"
    assert len(site.calls) == 2                      # page 1, then the (empty) page 2


def test_elcom_deduplicates_by_dam_hash_and_reads_docket_and_date():
    docs = discover(elcom, Site({"/de/verfuegungen": fx("elcom.html")}))
    assert docs
    d = docs[0]
    assert d.docket_number == "211-00500" and d.decision_date == D(2026, 6, 2) and d.lang == "de"
    assert d.doc_id == "211-00500_gRIQjRhHFJ9N"
    assert len({x.url for x in docs}) == len(docs)


def test_eschk_walks_years_and_skips_missing_ones():
    site = Site({"beschluesse-2024": fx("eschk_2024.html")})
    docs = discover(eschk, site)
    assert len(docs) == 2
    assert docs[0].doc_id == "2024_gtk-dfi-2024" and docs[0].decision_date == D(2024, 1, 23)
    assert docs[0].docket_number == "gtk-dfi-2024" and docs[0].lang == "de"
    # every year from this one back to 1991 was asked for, the 404s skipped
    assert sum("beschluesse-" in c for c in site.calls) == datetime.date.today().year - 1991 + 1


def test_comcom_reads_the_decision_date_from_the_filename():
    site = Site({"entscheide-2024-2025": fx("comcom_2024_2025.html")})
    docs = discover(comcom, site)
    assert docs and docs[0].decision_date == D(2024, 12, 19)
    assert docs[0].title.startswith("Interconnect Peering") and docs[0].lang == "de"
    assert docs[0].doc_id.startswith("COMCOM_2024-12-19_")


def test_esbk_reads_docket_and_language_from_the_filename():
    site = Site({"/de/strafrecht": fx("esbk_strafrecht.html"), "/de/verwaltungsrecht": "<html></html>"})
    docs = discover(esbk, site)
    assert len(docs) == 27
    by = {d.docket_number: d for d in docs}
    assert by["62-2023-016-01"].lang == "fr" and by["62-2023-002-03"].lang == "de"
    assert by["62-2023-016-01"].chamber == "Strafbescheid" and by["62-2023-016-01"].decision_date is None
    assert by["62-2023-016-01"].url.startswith("https://backend.esbk.admin.ch/fileservice/")


def test_postcom_reads_the_record_from_the_filename():
    docs = discover(postcom, Site({"/de/verfuegungen": fx("postcom_verfuegungen.html")}))
    assert len(docs) > 200
    a = next(d for d in docs if d.docket_number == "VFG-8-2026")
    assert a.decision_date == D(2026, 5, 13) and a.extra["status"] == "rechtskräftig"
    assert a.title.startswith("Verfügung 8-2026 betreffend")
    b = next(d for d in docs if d.docket_number == "VFG-6-2026")
    assert b.decision_date == D(2026, 5, 13)             # from the trailing _20260513
    assert len({d.doc_id for d in docs}) == len(docs)


def test_pue_skips_republished_court_rulings():
    docs = discover(pue, Site({"formelle-entscheide": fx("pue_formelle.html"),
                               "einvernehmliche": "<html></html>", "empfehlungen": "<html></html>"}))
    assert docs
    titles = [d.title for d in docs]
    assert any("Booking.com" in t for t in titles)
    assert not any("Bundesverwaltungsgerichtsurteil" in t for t in titles)
    booking = next(d for d in docs if "Booking.com" in d.title)
    assert booking.decision_date == D(2025, 5, 20) and booking.chamber == "Verfügung"


def test_rab_reads_docket_from_the_tile_and_date_from_the_filename():
    # page 1 repeats page 0, as the live site does past its last page: the walk must stop there.
    site = Site({"page=0": fx("rab_p0.html"), "page=1": fx("rab_p0.html"), "page=2": fx("rab_p0.html")})
    docs = discover(rab, site)
    assert docs and len({d.doc_id for d in docs}) == len(docs)
    assert len(site.calls) == 2
    d = docs[0]
    assert d.docket_number and d.docket_number.startswith("20")
    assert d.decision_date == D(2020, 9, 28)
    assert d.url.startswith("https://www.rab-asr.ch/sites/default/files/")


def test_mkg_takes_single_decisions_not_the_bound_volumes():
    docs = discover(mkg, Site({"urteile-militarkassationsgericht": fx("mkg_index.html")}))
    assert docs and all(d.docket_number.startswith("MKGE ") for d in docs)
    assert docs[0].doc_id == "MKGE-16-1" and docs[0].title == "MKGE 16 Nr. 1"
    assert not any("Band" in (d.title or "") for d in docs)


def test_emark_enumerates_a_year_and_stops_after_a_run_of_misses():
    page = fx("emark_2005_12.htm")
    routes = {f"/emark/2005/{n:02d}.htm": page for n in range(1, 13)}
    site = Site(routes)
    known = {f"EMARK-{y}-01" for y in emark.YEARS if y != 2005}     # every other year known
    docs = discover(emark, site, known)
    assert len(docs) == 12
    assert docs[0].doc_id == "EMARK-2005-01" and docs[0].text_source == "html"
    assert docs[11].decision_date == D(2005, 5, 18) and docs[11].lang == "de"
    # 12 hits + MISSES_TO_STOP misses for 2005, nothing for the known years
    assert len(site.calls) == 12 + emark.MISSES_TO_STOP


def test_emark_frozen_archive_is_not_rewalked_once_known():
    site = Site({})
    assert discover(emark, site, {f"EMARK-{y}-01" for y in emark.YEARS}) == []
    assert site.calls == []
