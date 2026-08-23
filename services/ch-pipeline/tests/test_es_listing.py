import pathlib
from chpipe import es_listing

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "listing_zg_obergericht.html"


def test_listing_url_is_the_directory_not_the_sitemap():
    assert es_listing.listing_url("ZG_Obergericht") == \
        "https://entscheidsuche.ch/docs/ZG_Obergericht/"


def test_parses_doc_ids_and_their_formats():
    inv = es_listing.parse_listing(FIXTURE.read_text(errors="replace"))
    assert "ZG_OG_001_Z1-2020-5_2022-02-18" in inv
    assert inv["ZG_OG_001_Z1-2020-5_2022-02-18"] == {"json", "pdf"}


def test_ignores_the_sort_links_and_the_parent_directory():
    inv = es_listing.parse_listing(FIXTURE.read_text(errors="replace"))
    assert not any(d.startswith("?") for d in inv)
    assert "" not in inv
    assert not any("/" in d for d in inv)


def test_a_document_with_html_reports_html():
    html = ('<tr><td><a href="X_1_2020.json">X_1_2020.json</a></td></tr>'
            '<tr><td><a href="X_1_2020.html">X_1_2020.html</a></td></tr>')
    assert es_listing.parse_listing(html) == {"X_1_2020": {"json", "html"}}


def test_unknown_extensions_are_dropped():
    html = '<a href="X_1_2020.json">j</a><a href="X_1_2020.checksum">c</a>'
    assert es_listing.parse_listing(html) == {"X_1_2020": {"json"}}


def test_percent_encoded_names_are_decoded():
    html = '<a href="X_1%20b_2020.json">j</a>'
    assert es_listing.parse_listing(html) == {"X_1 b_2020": {"json"}}
