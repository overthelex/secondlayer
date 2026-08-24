import pathlib

import pytest

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


# --- Streaming, because one listing is 116,000,062 bytes ---
#
# Measured on a synthetic listing of exactly that size (220,539 documents),
# tracemalloc peak for the whole parse:
#
#   OLD  Fetcher.text() body + _HREF.findall list + a set per doc   247.9 MB
#   NEW  stream_text chunks + finditer + interned frozensets         36.3 MB
#
# 85.3% less, with the same wall time (1.77 s vs 1.75 s). On a retry the old
# path re-downloaded all 116 MB from byte zero, up to three times.

FIXTURE_LISTING = FIXTURE


def _chunks(text, size):
    for start in range(0, len(text), size):
        yield text[start:start + size]


def test_streaming_finds_the_same_documents_as_one_whole_string():
    listing = FIXTURE_LISTING.read_text()
    whole = es_listing.parse_listing(listing)
    streamed = es_listing.parse_listing_stream(_chunks(listing, 64))
    assert streamed == whole
    assert whole, "the fixture must actually contain documents"


@pytest.mark.parametrize("size", [1, 2, 7, 13, 64, 1000, 10 ** 6])
def test_an_href_split_across_a_chunk_boundary_is_still_found(size):
    """The failure mode a naive chunked parser has: a document silently
    missing because its href straddled a read boundary. Chunk size 1 puts a
    boundary between every pair of characters."""
    listing = FIXTURE_LISTING.read_text()
    expected = es_listing.parse_listing(listing)
    assert es_listing.parse_listing_stream(_chunks(listing, size)) == expected


def test_no_document_is_yielded_twice_across_chunks():
    listing = FIXTURE_LISTING.read_text()
    entries = list(es_listing.iter_listing_entries(_chunks(listing, 31)))
    assert len(entries) == len(set(entries))


def test_extension_sets_are_interned():
    """A Python set costs ~216 bytes; 400,000 of them is ~86 MB for eight
    distinct values. Every doc_id shares one of eight frozensets instead."""
    inventory = es_listing.parse_listing(FIXTURE_LISTING.read_text())
    identities = {id(value) for value in inventory.values()}
    assert len(identities) <= 8
    assert len(inventory) > 100, "the fixture must be big enough for this to mean something"


def test_the_interned_sets_still_behave_like_sets():
    inventory = es_listing.parse_listing(
        '<a href="d.json">x</a><a href="d.pdf">x</a>')
    assert inventory["d"] == {"json", "pdf"}
    assert inventory["d"] & {"html", "pdf"} == {"pdf"}
    assert "pdf" in inventory["d"]
