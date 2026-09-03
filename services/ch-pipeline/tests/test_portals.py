"""The portal parsers against captured pages (tests/fixtures/portals, taken
live on 2026-09-03 and trimmed), and the shared helpers. No network, no
database: discovery is exercised with a MockTransport that serves the
fixtures, so what is under test is that each portal turns its page shape
into PortalDocs the queue can carry."""
import asyncio
import datetime
import re
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
    assert PortalDoc(doc_id="x", url="u", lang="xx").lang is None


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
                if isinstance(body, bytes):          # the site's raw bytes, no charset header
                    return httpx.Response(200, content=body, headers={"content-type": "text/html"})
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
    # the description cell is the title; the other cells land in the metadata
    assert docs[0].title.startswith("UBI b.1111: ") and len(docs[0].title) > len("UBI b.1111: ")
    assert "b.1111" not in docs[0].title[len("UBI b.1111"):]
    assert docs[0].extra["broadcaster"] == "Schweizer Radio und Fernsehen (SRF)" and docs[0].extra["complaint"]
    assert docs[0].extra["programme"] is None                      # the cell's second label is empty here
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


def test_ubi_joined_decisions_in_one_pdf_are_one_row_each():
    docs, nxt = ubi.parse_page(fx("ubi_joined.html"))
    assert [d.doc_id for d in docs] == ["b.998", "b.1017", "b.1021"] and nxt is None
    assert len({d.url for d in docs}) == 1 and docs[0].url.endswith("/b_998_1017_1021_1026.pdf")
    assert docs[2].extra["outcome"] == "Gutgeheissen" and docs[0].decision_date == D(2025, 4, 4)
    assert all(d.lang == "de" for d in docs)


def test_safe_doc_id_refuses_a_cap_with_no_room_for_the_digest():
    with pytest.raises(ValueError):
        safe_doc_id("x" * 50, max_len=9)
    assert len(safe_doc_id("x" * 50, max_len=10)) == 10


def test_ubi_marker_with_a_letter_is_the_number_and_leaves_the_title():
    docs, _ = ubi.parse_page(fx("ubi_joined.html").replace(">b.998</a>", ">B_998a</a>", 1))
    assert docs[0].doc_id == "b.998a" and "pdf)" not in docs[0].title and docs[0].lang == "de"   # Deutsch in the beschluss cell wins
    docs, _ = ubi.parse_page(fx("ubi_joined.html").replace(">b.1017</a>", ">b.1017 1018</a>", 1))
    assert docs[1].doc_id == "b.1017" and "pdf)" not in docs[1].title and "1018" not in docs[1].title


def test_ubi_two_complaints_under_one_number_become_one_row_and_rumantsch_is_a_language():
    page = fx("ubi_same_number.html")
    docs, _ = ubi.parse_page(page)
    # the site's own letter keeps the two complaints apart: b.750 and b.750a share one PDF
    assert [d.doc_id for d in docs] == ["b.750", "b.750a", "b.454"]
    assert len(ubi.merge(docs)) == 3 and docs[2].lang == "rm" and docs[2].extra["programme"] == "Novitads"
    # without the letter (older rows) the second description joins the first row's title
    merged = ubi.merge(ubi.parse_page(page.replace(">b.750a</a>", ">b.750</a>"))[0])
    assert [d.doc_id for d in merged] == ["b.750", "b.454"]
    assert "Islamzentrum" in merged[0].title and "Teletext" in merged[0].title


def test_ubi_stops_after_two_pages_without_a_pdf():
    page = fx("ubi_p1.html")
    nopdf = "<html><table><tr><td class=\"column-beschreibung\">alt b.325</td></tr></table>" \
            "<a href=\"/de/entscheide/entscheide-suchen-sie-mit-suchkriterien?p=NEXT\">Nächster</a></html>"
    site = Site({"currentPage%5D=2": nopdf.replace("NEXT", "3"), "p=3": nopdf.replace("NEXT", "4"),
                 "p=4": page, "entscheide-suchen": page})
    docs = discover(ubi, site)
    assert len(docs) == len(ubi.parse_page(page)[0]) and len(site.calls) == 3   # page 1, two empty pages, stop


def test_comcom_reads_the_decision_date_from_the_filename():
    site = Site({"entscheide-2024-2025": fx("comcom_2024_2025.html")})
    docs = discover(comcom, site)
    assert docs and docs[0].decision_date == D(2024, 12, 19)
    assert docs[0].title.startswith("Interconnect Peering") and docs[0].lang == "de"
    # the id is the filename, so a re-uploaded file (new DAM hash) keeps its identity
    assert docs[0].doc_id == "COMCOM_offVF_2024-12-19._Entscheid_ComCom_i.S._Init7_vs._Swisscom_Interconnect_Pering.pdf"


def test_comcom_keeps_one_copy_of_a_decision_filed_under_two_ranges():
    page = fx("comcom_2024_2025.html")
    site = Site({"entscheide-2024-2025": page, "entscheide-2022-2023": page.replace("/sd-web/", "/sd-web/older-")})
    docs = discover(comcom, site)
    ids = [d.doc_id for d in docs]
    assert len(ids) == len(set(ids)) and all("/sd-web/older-" not in d.url for d in docs)


def test_esbk_reads_docket_and_language_from_the_filename():
    site = Site({"/de/strafrecht": fx("esbk_strafrecht.html"), "/de/verwaltungsrecht": "<html></html>"})
    docs = discover(esbk, site)
    assert len(docs) == 27
    by = {d.docket_number: d for d in docs}
    assert by["62-2023-016-01"].lang == "fr" and by["62-2023-002-03"].lang == "de"
    assert by["62-2023-016-01"].chamber == "Strafbescheid" and by["62-2023-016-01"].decision_date is None
    assert by["62-2023-016-01"].decision_type == "Strafbescheid"
    assert esbk._DOCKET.search("strafbescheid-81-07-046-01.pdf").group(1) == "81-07-046-01"
    assert by["62-2023-016-01"].url.startswith("https://backend.esbk.admin.ch/fileservice/")


def test_postcom_reads_the_record_from_the_filename():
    docs = discover(postcom, Site({"/de/verfuegungen": fx("postcom_verfuegungen.html")}))
    assert len(docs) > 200
    a = next(d for d in docs if d.docket_number == "VFG-8-2026")
    assert a.decision_date == D(2026, 5, 13) and a.extra["status"] == "rechtskräftig"
    assert a.title.startswith("Verfügung 8-2026 betreffend")
    assert a.doc_id.startswith("VFG-8-2026_") and a.lang == "de"
    # an annex or a translation sharing the docket keeps its own id (the file's uuid)
    assert postcom.doc_from_file({"url": "https://x/files/2026/07/09/deadbeef-1.pdf", "filename": "Décision 8-2026 concernant.pdf"}).lang == "fr"
    assert postcom.doc_from_file({"url": "https://x/files/2026/07/09/deadbeef-1.pdf", "filename": "Verfügung 8-2026 Anhang.pdf"}).doc_id == "VFG-8-2026_deadbeef-1"
    b = next(d for d in docs if d.docket_number == "VFG-6-2026")
    assert b.decision_date == D(2026, 5, 13)             # from the trailing _20260513
    assert len({d.doc_id for d in docs}) == len(docs)


def test_pue_skips_republished_court_rulings():
    docs = discover(pue, Site({"formelle-entscheide": fx("pue_formelle.html"),
                               "einvernehmliche": "<html></html>", "empfehlungen": "<html></html>"}))
    assert docs
    titles = [d.title for d in docs]
    assert any("Booking.com" in t for t in titles)
    assert not any("Bundesverwaltungsgerichts" in t for t in titles)
    assert pue._COURT_RULING.search("10.11.2023 - Bundesverwaltungsgerichtsentscheid betr. X")
    assert pue._COURT_RULING.search("Bundesgerichtsurteil") and not pue._COURT_RULING.search("Verfügung gegen Booking.com")
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
    assert len(docs) == 6 and any("Band" in t for t in re.findall(r'download-item__title[^>]*>([^<]*)<', fx("mkg_index.html")))


def test_emark_enumerates_a_year_and_stops_after_a_run_of_misses(monkeypatch):
    monkeypatch.delenv("CHPIPE_PORTAL_FULL", raising=False)
    page = fx("emark_2005_12.htm").encode("latin-1")     # the site's bytes, no charset header
    routes = {f"/emark/2005/{n:02d}.htm": page for n in range(1, 13)}
    site = Site(routes)
    # every other year "complete" at a high number: each costs MISSES_TO_STOP probes and nothing more
    known = {f"EMARK-{y}-{emark.MAX_NR}" for y in emark.YEARS if y != 2005}
    docs = discover(emark, site, known)
    assert len(docs) == 12
    assert docs[0].doc_id == "EMARK-2005-01" and docs[0].text_source == "html"
    assert docs[11].decision_date == D(2005, 5, 18) and docs[11].lang == "de"
    assert len(site.calls) == 12 + emark.MISSES_TO_STOP


def test_emark_resumes_an_interrupted_year_after_its_highest_known_number(monkeypatch):
    monkeypatch.delenv("CHPIPE_PORTAL_FULL", raising=False)
    page = fx("emark_2005_12.htm").encode("latin-1")
    site = Site({f"/emark/2005/{n:02d}.htm": page for n in range(1, 13)})
    known = {f"EMARK-{y}-{emark.MAX_NR}" for y in emark.YEARS if y != 2005} | {"EMARK-2005-07"}
    docs = discover(emark, site, known)
    assert [d.doc_id for d in docs] == [f"EMARK-2005-{n:02d}" for n in range(8, 13)]
    assert not any("/2005/07.htm" in c or "/2005/01.htm" in c for c in site.calls)


def test_emark_decodes_the_declared_latin1_charset():
    raw = "<html><head><meta charset=ISO-8859-1></head><body>Urteil vom 18. Mai 2005 Wegweisung Äthiopien</body></html>".encode("latin-1")
    text = emark.decode(raw, "text/html")
    assert "Äthiopien" in text and "\ufffd" not in text
    assert emark.decode("ü".encode("utf-8"), None) == "ü"
    assert emark.decode(b"\xfc", None) == "ü"
