"""chpipe.sil against one real TOC excerpt and one real act page from EACH
host (tests/fixtures/sil_*), captured 2026-08-26 and trimmed of Word's
style sheet only. A fixture from one host proves nothing about the other:
GE and NE mark articles differently (see the module docstring)."""
import datetime
import pathlib

import pytest

from chpipe import sil

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GE_TOC = (FIXTURES / "sil_ge_content_excerpt.htm").read_bytes()
NE_TOC = (FIXTURES / "sil_ne_content_excerpt.htm").read_bytes()
GE_ACT = (FIXTURES / "sil_ge_rsg_i2_09.htm").read_bytes()
NE_ACT = (FIXTURES / "sil_ne_916_510_1.htm").read_bytes()


# --- encoding ----------------------------------------------------------------

def test_pages_declare_windows_1252_and_are_not_utf8():
    for raw in (GE_TOC, NE_TOC, GE_ACT, NE_ACT):
        assert b"charset=windows-1252" in raw[:2048] or b"charset='windows-1252'" in raw[:2048]
        with pytest.raises(UnicodeDecodeError):
            raw.decode("utf-8")


def test_decode_trusts_the_declared_charset_and_defaults_to_cp1252():
    assert "Genève" in sil.decode(GE_TOC)
    assert "Neuchâtel" in sil.decode(NE_TOC)
    assert sil.decode("<html><body>Zürich</body></html>".encode("cp1252")) == "<html><body>Zürich</body></html>"
    utf = "<meta charset=utf-8><body>Zürich ’</body>".encode("utf-8")
    assert "Zürich ’" in sil.decode(utf)


# --- urls -----------------------------------------------------------------------

def test_urls_follow_the_book_layout():
    assert sil.toc_url("silgeneve.ch", "GE") == "https://silgeneve.ch/legis/program/books/rsg/content.htm"
    assert sil.toc_url("rsn.ne.ch", "NE") == "https://rsn.ne.ch/DATA/program/books/rsne/content.htm"
    assert sil.act_url("silgeneve.ch", "GE", "htm/rsg_a1_01.htm") == \
        "https://silgeneve.ch/legis/program/books/rsg/htm/rsg_a1_01.htm"
    assert sil.act_url("rsn.ne.ch", "NE", "htm/916.510.1.htm") == \
        "https://rsn.ne.ch/DATA/program/books/rsne/htm/916.510.1.htm"


# --- TOC ----------------------------------------------------------------------

def test_ge_toc_entries_carry_the_alphanumeric_number_and_the_title():
    entries = sil.parse_toc(sil.decode(GE_TOC))
    assert len(entries) == 30
    assert entries[0] == {"sr_number": "A 1 01", "href": "htm/rsg_a1_01.htm",
                          "title": "Acte d'union de la République de Genève à la Confédération suisse (AcU-GE-CH)"}
    sub = next(e for e in entries if e["href"] == "htm/rsg_j4_18p01.htm")
    assert sub["sr_number"] == "J 4 18.01", "the slug spells the dot as p; the number comes from the label"
    assert all(e["sr_number"] for e in entries)


def test_ne_toc_entries_are_numeric_and_come_from_h3_and_h4_alike():
    entries = sil.parse_toc(sil.decode(NE_TOC))
    assert len(entries) == 38
    assert len({e["href"] for e in entries}) == 38
    assert entries[0]["sr_number"] == "101" and entries[0]["href"] == "htm/101.htm"
    assert entries[0]["title"].startswith("Constitution de la République et Canton de Neuchâtel (Cst. NE)")
    assert {"104.0", "104.1", "416.67"} <= {e["sr_number"] for e in entries}
    assert all(e["sr_number"] for e in entries)


def test_split_number_and_title_refuses_to_guess():
    assert sil.split_number_and_title("101 Constitution") == ("101", "Constitution")
    assert sil.split_number_and_title("831.2a Loi") == ("831.2a", "Loi")
    assert sil.split_number_and_title("B 5 15.24 Règlement") == ("B 5 15.24", "Règlement")
    assert sil.split_number_and_title("Table des matières") == (None, "Table des matières")


# --- dates ------------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("du 16 juin 1988", datetime.date(1988, 6, 16)),
    ("(Entrée en vigueur : 13 août 1988)", datetime.date(1988, 8, 13)),
    ("Etat au 1er janvier 2026", datetime.date(2026, 1, 1)),
    ("Dernières modifications au 27 février 2026", datetime.date(2026, 2, 27)),
    ("24 janvier 1996", datetime.date(1996, 1, 24)),
    ("31 février 2020", None),
    ("no date here", None),
    (None, None),
])
def test_french_dates(text, expected):
    assert sil.parse_fr_date(text) == expected


# --- GE act -----------------------------------------------------------------

@pytest.fixture(scope="module")
def ge():
    return sil.parse_act(sil.decode(GE_ACT))


def test_ge_meta(ge):
    assert ge.meta["title"] == "Loi sur le commerce d’objets usagés ou de seconde main (LCOU)"
    assert ge.meta["sr_number"] == "I 2 09"
    assert ge.meta["date_adoption"] == datetime.date(1988, 6, 16)
    assert ge.meta["date_entry_force"] == datetime.date(1988, 8, 13)
    assert ge.meta["date_state"] == datetime.date(2026, 2, 27)


def test_ge_articles_are_split_on_p_article_with_the_marginal_in_the_heading(ge):
    assert [a.article_number for a in ge.articles] == [str(n) for n in range(1, 18)]
    art4 = ge.articles[3]
    assert art4.e_id == "art_4" and art4.marginal_note == "Autorisation préalable" and art4.ordinal == 3
    assert art4.text.startswith("1 Le commerce professionnel, à titre principal ou accessoire")
    assert "Conditions et délivrance" in art4.text, "p.sousmargi is a sub-heading inside the article"
    assert "2 L’autorisation est délivrée à condition que le requérant : a) soit de nationalité" in art4.text
    assert "(12)" not in art4.text, "footnote reference removed from the text"
    assert art4.notes == ("n.t. : rectification selon 7C/1, B 2 05 (4/1) | 27.02.2026 | 27.02.2026",), \
        "resolved against the modification table, dates included"


def test_ge_full_text_keeps_the_modification_table_out_of_the_articles(ge):
    assert "Dernières modifications au 27 février 2026" in ge.text
    assert "RSG Intitulé" in ge.text
    assert not any("RSG Intitulé" in a.text or "Date d'adoption" in a.text for a in ge.articles)
    assert "\xa0" not in ge.text and "\xa0" not in " ".join(a.text for a in ge.articles)


# --- NE act -----------------------------------------------------------------

@pytest.fixture(scope="module")
def ne():
    return sil.parse_act(sil.decode(NE_ACT))


def test_ne_meta(ne):
    assert ne.meta["title"] == "Arrêté d'exécution de la loi concernant l'élimination des déchets animaux"
    assert ne.meta["sr_number"] == "916.510.1"
    assert ne.meta["date_adoption"] == datetime.date(1996, 1, 24), "three p.xDateAdoption blocks joined"
    assert ne.meta["date_state"] == datetime.date(2013, 8, 1)
    assert ne.meta["footnotes"] == 14


def test_ne_articles_are_split_inline_with_the_marginal_before_and_the_alinea_spaced(ne):
    numbers = [a.article_number for a in ne.articles]
    assert numbers == ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "13a",
                       "14", "15", "16"]
    first = ne.articles[0]
    assert first.e_id == "art_1" and first.text.startswith("Le Département du développement territorial")
    art8 = next(a for a in ne.articles if a.article_number == "8")
    assert art8.text.startswith("1 Les communes qui ont constitué un centre de ramassage"), "space after <sup>"
    assert "2 La demande doit être adressée" in art8.text
    assert "[9]" not in art8.text and any(n.startswith("Teneur selon A du 18 avril 2007") for n in art8.notes)
    art7 = next(a for a in ne.articles if a.article_number == "7")
    assert "a) les parties métalliques" in art7.text and "e) les eaux" in art7.text


def test_ne_sections_become_parents_and_an_abrogated_article_keeps_its_note(ne):
    art3 = next(a for a in ne.articles if a.article_number == "3")
    art4 = next(a for a in ne.articles if a.article_number == "4")
    assert art3.parent_e_id and art4.parent_e_id and art3.parent_e_id != art4.parent_e_id
    art13 = next(a for a in ne.articles if a.article_number == "13")
    assert art13.text == ""
    assert art13.notes and art13.notes[0].startswith("Abrogé par A du 14 juin 2006")
    assert "Section 8: Financement" in ne.text and "[12] Abrogé par" in ne.text


def _ge_page(*headings_and_bodies):
    body = "".join(f"<p class=article>{h}</p><p class=Texte>{b}</p>" for h, b in headings_and_bodies)
    return f"<html><head><title>x</title></head><body><p class=TitreLoi>T</p>{body}</body></html>"


def test_ge_old_treaties_number_their_articles_in_every_way_word_allows():
    # Shapes measured on the live pages 2026-08-26: A 1 02 (1749) "Articles
    # 1er ." then "2.", A 1 07 (1816) "Article I" / "Article II.", A 1 01
    # (1815) "Art.e I.", plus the modern "Art. 7A" and "Art. 2 bis".
    parsed = sil.parse_act(_ge_page(("Articles 1er .", "a"), ("2.", "b"), ("Article I", "c"),
                                    ("Article II.", "d"), ("Art.e III.", "e"), ("Art. 7A Hymne", "f"),
                                    ("Art. 2 bis", "g"), ("Dispositions finales", "h")))
    assert [(a.article_number, a.marginal_note, a.text) for a in parsed.articles] == [
        ("1", None, "a"), ("2", None, "b"), ("I", None, "c"), ("II", None, "d"), ("III", None, "e"),
        ("7A", "Hymne", "f"), ("2bis", None, "g")]
    assert "Dispositions finales" in parsed.text, "a p.article without a number is a structural line"


def test_ge_numbered_list_items_in_p_article_stay_inside_their_article():
    # A 5 05.03 (live 2026-08-26): "Art. 1 Arrondissements" is followed by
    # "1. Cité-Rive" ... "17. Champel" in p.article, then "Art. 2".
    parsed = sil.parse_act(_ge_page(("Art. 1 Arrondissements et périmètre", "Les arrondissements :"),
                                    ("1. Cité-Rive", "rues a"), ("2. Pâquis", "rues b"),
                                    ("Art. 2 Information des électeurs", "x"), ("Article unique", "y")))
    assert [(a.article_number, a.marginal_note) for a in parsed.articles] == [
        ("1", "Arrondissements et périmètre"), ("2", "Information des électeurs"), ("unique", None)]
    assert parsed.articles[0].text == "Les arrondissements : 1. Cité-Rive rues a 2. Pâquis rues b"


def test_ne_body_paragraphs_are_not_split_on_plural_or_bare_numbers():
    page = ("<html><head><title>x</title></head><body><p class=xNom>T</p>"
            "<p class=xNormal>Art. 3 Un texte.</p>"
            "<p class=xNormal>Articles 27 à 30 sont réservés.</p>"
            "<p class=xNormal>4. Une énumération, pas un article.</p>"
            "<p class=xNormal>Article 5 Un autre.</p></body></html>")
    parsed = sil.parse_act(page)
    assert [a.article_number for a in parsed.articles] == ["3", "5"]
    assert parsed.articles[0].text == "Un texte. Articles 27 à 30 sont réservés. 4. Une énumération, pas un article."


def test_no_page_yields_no_articles_and_little_text():
    parsed = sil.parse_act("<html><head><title>x</title></head><body><p>Texte en vigueur</p></body></html>")
    assert parsed.articles == [] and len(parsed.text) < 200
