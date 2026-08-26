"""chpipe.shab: the amtsblattportal.ch list-page parser and the title parser.

Pure, no database and no network. The three fixtures under
tests/fixtures/registries/ were captured live on 2026-08-26 (see
tests/fixtures/registries/shab_titles.txt for the exact requests).
"""
import datetime as dt
import pathlib

import pytest

from chpipe import shab

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "registries"


def _fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _titles() -> list[tuple[str, str, str, str, str | None, str | None]]:
    rows = []
    for line in (FIXTURES / "shab_titles.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        rubric, sub_rubric, lang, title, name, seat = line.split("\t")
        rows.append((rubric, sub_rubric, lang, title, name or None, seat or None))
    return rows


TITLES = _titles()


# --- parse_list_page -------------------------------------------------------

def test_the_total_is_the_whole_result_set_not_the_page():
    total, metas = shab.parse_list_page(_fixture("shab_list_hr.xml"))
    assert total == 1095
    assert len(metas) == 3


def test_a_meta_carries_every_column_the_stage_writes():
    _, metas = shab.parse_list_page(_fixture("shab_list_hr.xml"))
    first = metas[0]
    assert first["id"] == "0ef473fa-7ccb-428e-b4f6-2cf3fdde6e2f"
    assert first["rubric"] == "HR"
    assert first["sub_rubric"] == "HR02"
    assert first["language"] == "de"
    assert first["publication_number"] == "HR02-1006722419"
    assert first["publication_date"] == dt.date(2026, 8, 3)
    assert first["cantons"] == "ZG"
    assert first["registration_office"] == (
        "Bundesamt für Justiz (BJ), Eidgenössisches Amt für das Handelsregister")


def test_the_title_is_the_one_in_the_publications_own_language():
    _, metas = shab.parse_list_page(_fixture("shab_list_hr.xml"))
    first = metas[0]
    assert first["language"] == "de"
    assert first["title"].startswith("Mutation PROTECTORSHIP COMPANY SA")
    assert set(first["titles"]) == {"de", "en", "it", "fr"}
    assert first["titles"]["fr"].startswith("Mutation PROTECTORSHIP COMPANY SA")
    assert first["titles"]["en"].startswith("Change PROTECTORSHIP COMPANY SA")


def test_the_title_falls_back_to_german_when_the_language_has_none():
    """A publication whose own language is missing from <title> must still be
    stored with a title rather than a NULL: German is the one every SHAB
    publication carries."""
    xml = _fixture("shab_list_hr.xml").replace(
        b"<language>de</language>", b"<language>rm</language>", 1)
    _, metas = shab.parse_list_page(xml)
    assert metas[0]["language"] == "rm"
    assert metas[0]["title"].startswith("Mutation PROTECTORSHIP COMPANY SA")


def test_legal_remedy_is_not_captured():
    """Boilerplate repeated verbatim on every publication of a sub-rubric --
    2.5M copies of the same paragraph is not metadata."""
    _, metas = shab.parse_list_page(_fixture("shab_list_hr.xml"))
    assert "legal_remedy" not in metas[0]
    assert "legalRemedy" not in metas[0]


def test_the_kk_page_parses_with_the_same_envelope():
    total, metas = shab.parse_list_page(_fixture("shab_list_kk.xml"))
    assert total == 86
    assert [m["rubric"] for m in metas] == ["KK", "KK", "KK"]
    assert metas[0]["sub_rubric"] == "KK01"
    assert metas[0]["language"] == "fr"
    assert metas[0]["registration_office"] == "Office des faillites de l'Etat Genève"
    assert metas[0]["publication_date"] == dt.date(2026, 8, 3)


def test_a_page_with_no_publications_is_an_empty_list_not_an_error():
    """The last page of a month is routinely empty, and so is every page of a
    month before the rubric existed."""
    total, metas = shab.parse_list_page(
        b'<bulk:bulk-export xmlns:bulk="https://shab.ch/bulk-export">'
        b"<total>0</total><pageRequest><page>0</page><size>2000</size>"
        b"</pageRequest></bulk:bulk-export>")
    assert (total, metas) == (0, [])


def test_a_publication_without_an_id_is_dropped():
    """shab_id is the upsert key; a row without one cannot be written back and
    must not reach the stage as a half-row."""
    xml = _fixture("shab_list_hr.xml").replace(
        b"<id>0ef473fa-7ccb-428e-b4f6-2cf3fdde6e2f</id>", b"<id></id>", 1)
    _, metas = shab.parse_list_page(xml)
    assert len(metas) == 2
    assert "0ef473fa-7ccb-428e-b4f6-2cf3fdde6e2f" not in [m["id"] for m in metas]


def test_an_unparsable_publication_date_is_none_and_the_row_survives():
    xml = _fixture("shab_list_hr.xml").replace(
        b"<publicationDate>2026-08-03</publicationDate>",
        b"<publicationDate>03.08.2026</publicationDate>", 1)
    _, metas = shab.parse_list_page(xml)
    assert len(metas) == 3
    assert metas[0]["publication_date"] is None


# --- parse_title -----------------------------------------------------------

@pytest.mark.parametrize(
    "rubric,sub_rubric,lang,title,name,seat", TITLES,
    ids=[f"{r[1]}-{r[2]}-{i}" for i, r in enumerate(TITLES)])
def test_every_captured_title_parses_to_its_recorded_name_and_seat(
        rubric, sub_rubric, lang, title, name, seat):
    assert shab.parse_title(title, lang, rubric) == (name, seat)


def test_the_fixture_really_covers_fifty_hr_and_twenty_kk_titles():
    """A fixture that quietly shrank would make the parametrised test above
    pass while testing nothing."""
    assert sum(1 for row in TITLES if row[0] == "HR") == 50
    assert sum(1 for row in TITLES if row[0] == "KK") == 20


def test_a_move_keeps_the_seat_the_company_had_when_it_was_published():
    """`Mutation X, <old seat>, neu <new seat>` -- the tail is the change the
    publication announces, not the row's own seat. shab-detail overwrites
    both from the detail XML later."""
    assert shab.parse_title(
        "Mutation lease it ag, Baden, neu Zürich", "de", "HR") == (
            "lease it ag", "Baden")


def test_a_branch_name_containing_a_comma_keeps_it():
    assert shab.parse_title(
        "Mutation Hälg & Co. AG, Zweigniederlassung Ebikon, Ebikon",
        "de", "HR") == ("Hälg & Co. AG, Zweigniederlassung Ebikon", "Ebikon")


def test_a_kk_title_has_no_seat_even_when_it_has_commas():
    assert shab.parse_title(
        "Avis préalable d'ouverture de faillite MOBS CH SARL, EN LIQUIDATION",
        "fr", "KK") == ("MOBS CH SARL, EN LIQUIDATION", None)


def test_a_renounced_inheritance_qualifier_is_not_part_of_the_name():
    assert shab.parse_title(
        "Vorläufige Konkursanzeige Patrick Jenni, ausgeschlagene Erbschaft",
        "de", "KK") == ("Patrick Jenni", None)


def test_an_unknown_leading_verb_leaves_the_title_intact_rather_than_guessing():
    """The table holds every phrase the gazette was observed to publish, but
    the gazette can add one. A verb this parser has never seen must degrade to
    a name that still contains it -- searchable -- not to a name cut at an
    arbitrary word."""
    assert shab.parse_title(
        "Sistierung des Konkursverfahrens Beispiel GmbH", "de", "KK") == (
            "Sistierung des Konkursverfahrens Beispiel GmbH", None)


def test_an_empty_title_parses_to_nothing_rather_than_raising():
    assert shab.parse_title("", "de", "HR") == (None, None)
    assert shab.parse_title("   ", "de", "KK") == (None, None)


def test_a_title_that_is_only_a_verb_yields_no_name():
    assert shab.parse_title("Mutation", "de", "HR") == (None, None)


def test_whitespace_and_newlines_inside_a_title_are_collapsed():
    assert shab.parse_title("Mutation  Enderli\n AG,   Uzwil", "de", "HR") == (
        "Enderli AG", "Uzwil")


def test_an_unknown_rubric_is_parsed_like_hr():
    """Only HR and KK are fetched, but the parser is exported and must not
    depend on a caller passing a rubric at all."""
    assert shab.parse_title("Mutation Enderli AG, Uzwil", "de", None) == (
        "Enderli AG", "Uzwil")


# --- sub-rubric labels -----------------------------------------------------

def test_the_labels_cover_every_sub_rubric_the_endpoint_publishes():
    for code, label in (("HR01", "Neueintragung"), ("HR02", "Mutation"),
                        ("HR03", "Löschung"), ("KK01", "Vorläufige Konkursanzeige"),
                        ("KK02", "Konkurspublikation/Schuldenruf"),
                        ("KK03", "Einstellung des Konkursverfahrens"),
                        ("KK04", "Kollokationsplan und Inventar"),
                        ("KK05", "Verteilungsliste und Schlussrechnung"),
                        ("KK06", "Schluss des Konkursverfahrens"),
                        ("KK07", "Widerruf des Konkurses"),
                        ("KK08", "Konkursamtliche Grundstücksteigerung"),
                        ("KK09", "Lastenverzeichnisse"),
                        ("KK11", "Anerkennung eines ausländischen Konkurses"),
                        ("KK12", "Verzicht auf die Durchführung eines "
                                 "IPRG-Konkursverfahrens")):
        assert shab.sub_rubric_label(code) == label


def test_a_sub_rubric_with_no_phrase_to_label_it_keeps_its_code():
    """HR04..HR07 answer total=0 over a 20-month window, so there is nothing to
    read a label off. KK10 has 1,163 publications and no fixed phrase at all --
    its titles are free text, identical in all four languages. Inventing a
    label for either would put a guess in publication_type, which the tools
    display verbatim."""
    for code in ("HR04", "HR05", "HR06", "HR07", "KK10", "SB01"):
        assert shab.sub_rubric_label(code) == code


def test_a_free_text_kk10_title_survives_whole():
    """No verb, so nothing to strip: the office's own sentence is the best name
    available and cutting it at a guessed boundary would lose the debtor."""
    assert shab.parse_title(
        "Beschwerde mit aufschiebender Wirkung, Yalcin Mehmet, Unterkulm",
        "de", "KK") == (
            "Beschwerde mit aufschiebender Wirkung, Yalcin Mehmet, Unterkulm",
            None)


def test_the_two_apostrophes_the_gazette_uses_are_both_matched():
    """KK08 fr writes "d\'immeubles" with U+0027 and KK11 fr writes "d\u2019une"
    with U+2019, in the same rubric on the same day."""
    for mark in ("'", "\u2019"):
        title = ("Reconnaissance d" + mark + "une faillite étrangère "
                 "(cf. art. 166 ss. LDIP) Ashot EGIAZARAN")
        assert shab.parse_title(title, "fr", "KK") == ("Ashot EGIAZARAN", None)


def test_the_short_forms_the_offices_also_use_are_stripped():
    """KK04 publishes with and without the inventory, in German and in French;
    Geneva also shortens "succession répudiée" to "succession". Both were found
    only by walking a whole month -- neither is in the 20-title sample."""
    assert shab.parse_title(
        "Etat de collocation Catherine GRANDJEAN", "fr", "KK") == (
            "Catherine GRANDJEAN", None)
    assert shab.parse_title(
        "Etat de collocation Gérard Daniel COQUOZ, succession", "fr", "KK") == (
            "Gérard Daniel COQUOZ", None)
    assert shab.parse_title(
        "Kollokationsplan Econom Treuhand AG", "de", "KK") == (
            "Econom Treuhand AG", None)


def test_a_verb_that_is_also_a_company_name_is_stripped_only_once():
    """"Mutation Change Coaching GmbH in Liquidation, Büttikon" is a real HR02
    title: the company is called Change Coaching GmbH. Stripping the leading
    verb must not go on to strip the company's first word too."""
    assert shab.parse_title(
        "Mutation Change Coaching GmbH in Liquidation, Büttikon",
        "de", "HR") == ("Change Coaching GmbH in Liquidation", "Büttikon")


def test_the_estate_qualifier_is_dropped_in_all_four_languages():
    for qualifier in ("ausgeschlagene Erbschaft", "succession répudiée",
                      "eredità rifiutata", "refused estate"):
        assert shab.parse_title(
            f"Kollokationsplan Ruth Laubscher, {qualifier}", "de", "KK") == (
                "Ruth Laubscher", None)


def test_a_missing_sub_rubric_has_no_label():
    assert shab.sub_rubric_label(None) is None
    assert shab.sub_rubric_label("") is None


# --- the list URL ----------------------------------------------------------

def test_the_list_url_carries_the_month_bounds_and_the_page():
    url = shab.list_url("HR", dt.date(2026, 8, 1), dt.date(2026, 8, 31),
                        page=3, size=2000)
    assert url.startswith("https://amtsblattportal.ch/api/v1/publications/xml?")
    for part in ("publicationStates=PUBLISHED", "rubrics=HR",
                 "publicationDate.start=2026-08-01",
                 "publicationDate.end=2026-08-31",
                 "pageRequest.size=2000", "pageRequest.page=3"):
        assert part in url


def test_month_bounds_cover_the_whole_month_including_december():
    assert shab.month_bounds(dt.date(2026, 2, 1)) == (
        dt.date(2026, 2, 1), dt.date(2026, 2, 28))
    assert shab.month_bounds(dt.date(2024, 2, 1)) == (
        dt.date(2024, 2, 1), dt.date(2024, 2, 29))
    assert shab.month_bounds(dt.date(2026, 12, 1)) == (
        dt.date(2026, 12, 1), dt.date(2026, 12, 31))
