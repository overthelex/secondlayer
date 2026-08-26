"""chpipe.ti_rl on real (trimmed) pages of Ticino's Raccolta delle leggi,
captured 2026-08-26: the elenco-atti list, the constitution (101.000, the
act with the most footnotes), the decree on the cantonal colours (110.110,
nine one-line articles and an annex of figures) and the page the portal
serves for an id it does not have (HTTP 200, no act)."""
import datetime
import pathlib

import pytest

from chpipe import ti_rl

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
LIST = (FIXTURES / "ti_rl_list.html").read_text()
CONSTITUTION = (FIXTURES / "ti_rl_act_101_000.html").read_text()
COLOURS = (FIXTURES / "ti_rl_act_110_110.html").read_text()
MISSING = (FIXTURES / "ti_rl_missing.html").read_text()


# --- the list -------------------------------------------------------------

def test_the_list_yields_one_entry_per_act_in_page_order():
    entries = ti_rl.parse_list(LIST)
    assert len(entries) == 17
    assert [e["rl_id"] for e in entries[:4]] == [1, 2, 3, 101]
    assert len({e["rl_id"] for e in entries}) == 17


def test_a_list_entry_splits_number_title_and_date():
    first = ti_rl.parse_list(LIST)[0]
    assert first == {
        "rl_id": 1,
        "sr_number": "101.000",
        "title": "Costituzione della Repubblica e Cantone Ticino",
        "date_text": "14 dicembre 1997",
        "date_document": datetime.date(1997, 12, 14),
        "url": "https://www3.ti.ch/CAN/RLeggi/public/index.php/raccolta-leggi/legge/num/1",
        "flat_url": "https://www3.ti.ch/CAN/RLeggi/public/index.php/raccolta-leggi/legge-piatta/num/1",
    }


def test_a_title_with_an_abbreviation_and_a_dash_keeps_the_dash_before_the_date():
    entries = {e["rl_id"]: e for e in ti_rl.parse_list(LIST)}
    cqi = entries[15]
    assert cqi["sr_number"] == "120.300"
    assert cqi["title"].startswith("Convenzione quadro per la collaborazione intercantonale")
    assert cqi["title"].endswith("(Convenzione quadro intercantonale, CQI)")
    assert cqi["date_document"] == datetime.date(2005, 6, 24)


def test_an_empty_list_is_an_error_not_zero_acts():
    with pytest.raises(ti_rl.TiParseError):
        ti_rl.parse_list("<html><body>manutenzione</body></html>")


# --- the act page ---------------------------------------------------------

def test_the_missing_act_page_is_recognised_and_refused():
    assert not ti_rl.is_act_page(MISSING)
    assert ti_rl.is_act_page(CONSTITUTION)
    with pytest.raises(ti_rl.TiParseError, match="non è presente"):
        ti_rl.parse_act(MISSING)


def test_constitution_articles_numbers_and_order():
    articles, _, _ = ti_rl.parse_act(CONSTITUTION)
    numbers = [a.article_number for a in articles]
    assert numbers[:8] == ["1", "2", "3", "4", "5", "6", "7", "8"]
    assert "34bis" in numbers and "34ter" in numbers and "67" in numbers and "96" in numbers
    assert [a.ordinal for a in articles] == list(range(len(articles)))
    assert len({a.e_id for a in articles}) == len(articles)
    assert articles[0].e_id == "art_1"


def test_a_capoverso_number_is_separated_from_the_article_number_and_the_text():
    """The Word export writes 'Art. 1' + superscript '1' + 'Il Cantone' with
    no whitespace: read naively it is 'Art. 11Il Cantone'."""
    art1 = ti_rl.parse_act(CONSTITUTION)[0][0]
    assert art1.article_number == "1"
    assert art1.marginal_note == "Cantone Ticino"
    assert art1.text.startswith("1 Il Cantone Ticino è una repubblica democratica")
    assert "2 Il Cantone è membro della Confederazione svizzera" in art1.text


def test_bis_is_joined_to_the_article_number_but_the_capoverso_is_not():
    by_number = {a.article_number: a for a in ti_rl.parse_act(CONSTITUTION)[0]}
    assert by_number["34bis"].text.startswith("1 La gestione finanziaria dello Stato")
    assert by_number["9a"].text.startswith("1 Nessuno può dissimulare")


def test_footnote_references_leave_the_text_and_become_notes():
    by_number = {a.article_number: a for a in ti_rl.parse_act(CONSTITUTION)[0]}
    art4 = by_number["4"]
    assert "[2]" not in art4.text and "[3]" not in art4.text
    assert "3 Il Cantone promuove le pari opportunità per i cittadini." in art4.text
    assert len(art4.notes) == 3
    assert art4.notes[1].startswith("Modifica dell’art. 4 cpv. 3 approvata con votazione popolare del 5.6.2011")
    # an abrogated article keeps its number and its ellipsis, and its note
    art67 = by_number["67"]
    assert art67.text == "…"
    assert art67.notes[0].startswith("Abrogazione dell’art. 67")


def test_letters_of_an_enumeration_are_kept_in_the_article_text():
    by_number = {a.article_number: a for a in ti_rl.parse_act(CONSTITUTION)[0]}
    assert "a) la libertà personale, l’integrità fisica e morale;" in by_number["8"].text


def test_section_headings_and_marginal_notes_are_not_article_text():
    articles, _, _ = ti_rl.parse_act(CONSTITUTION)
    by_number = {a.article_number: a for a in articles}
    assert "TITOLO II" not in by_number["5"].text
    assert "Tutela della dignità umana" not in by_number["5"].text
    assert by_number["6"].marginal_note == "Tutela della dignità umana"
    assert "Sovranità" not in by_number["1"].text


def test_full_text_is_one_line_per_paragraph_with_the_footnotes_at_the_end():
    _, text, _ = ti_rl.parse_act(CONSTITUTION)
    lines = text.split("\n")
    assert lines[0] == "101.000"
    assert lines[1] == "Costituzione"
    assert "del 14 dicembre 1997 (stato 1° gennaio 2023)" in lines
    assert "TITOLO I" in lines
    assert "Art. 1 1 Il Cantone Ticino è una repubblica democratica di cultura e lingua italiane." in lines
    assert "Entrata in vigore: 1° gennaio 1998." in lines
    assert any(line.startswith("[1] Modifica dell’art. 4 cpv. 1") for line in lines)
    assert "" not in lines


def test_constitution_meta():
    _, _, meta = ti_rl.parse_act(CONSTITUTION)
    assert meta["sr_number"] == "101.000"
    assert meta["title"] == "Costituzione della Repubblica e Cantone Ticino del 14 dicembre 1997"
    assert meta["date_document"] == datetime.date(1997, 12, 14)
    assert meta["date_status"] == datetime.date(2023, 1, 1)
    assert meta["date_entry_force"] == datetime.date(1998, 1, 1)


def test_a_small_decree_with_no_marginal_notes_and_an_annex_of_figures():
    articles, text, meta = ti_rl.parse_act(COLOURS)
    assert [a.article_number for a in articles] == [str(n) for n in range(1, 10)]
    assert all(a.marginal_note is None for a in articles)
    assert articles[0].text.startswith("I colori rosso e azzurro sono quelli definiti alla fig. 1.")
    # the preamble ("decreta:") is not a marginal note and not article text
    assert "decreta" not in articles[0].text
    assert "decreta:" in text.split("\n")
    assert meta["sr_number"] == "110.110"
    assert meta["date_document"] == datetime.date(1996, 4, 18)
    assert meta["date_status"] is None
    # the annex after the last article stays in full_text and in the last article
    assert "Fig. 10" in text and "Fig. 10" in articles[-1].text
    assert articles[-1].notes[0].startswith("Figura modificata dal DE 29.1.2002")


def test_a_repeated_article_number_gets_a_distinct_e_id():
    page = COLOURS.replace("Art. 9</span>", "Art. 8</span>")
    articles, _, _ = ti_rl.parse_act(page)
    assert [a.e_id for a in articles][-2:] == ["art_8", "art_8#2"]


def test_italian_dates():
    assert ti_rl.parse_date("del 14 dicembre 1997") == datetime.date(1997, 12, 14)
    assert ti_rl.parse_date("1° gennaio 2023") == datetime.date(2023, 1, 1)
    assert ti_rl.parse_date("(del 18 aprile 1996)") == datetime.date(1996, 4, 18)
    assert ti_rl.parse_date("in vigore dal 5.2.2002") == datetime.date(2002, 2, 5)
    assert ti_rl.parse_date("Legge sui colori") is None


def test_entry_into_force_may_sit_in_the_paragraph_after_its_heading():
    page = CONSTITUTION.replace("Entrata in vigore: 1° gennaio 1998.",
                                "Entrata in vigore</span></p><p><span>1° gennaio 1998.")
    assert "Entrata in vigore</span></p>" in page
    assert ti_rl.parse_act(page)[2]["date_entry_force"] == datetime.date(1998, 1, 1)
    # a heading alone (a transitional article's title) yields nothing
    page = CONSTITUTION.replace("Entrata in vigore: 1° gennaio 1998.", "Entrata in vigore")
    assert ti_rl.parse_act(page)[2]["date_entry_force"] is None
