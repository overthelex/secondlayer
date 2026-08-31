"""portal_amendments: the GE/NE/TI note grammars over real prod note strings
(sampled 2026-08-31 from stored akn_xml, 45 pages), and the write path
against real Postgres."""
import datetime
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import akn, portal_amendments as pa

D = datetime.date


# --- GE --------------------------------------------------------------------

def test_ge_single_group_note_is_one_event_with_the_adoption_date_as_ref():
    events = pa.parse_note(
        "GE", "n.t. : 13/2e 2°, 13/2e 3°, 38 | 04.10.2013 | 01.01.2014", "38")
    assert events == [pa.Event("amended", D(2013, 10, 4), D(2014, 1, 1), "04.10.2013")]


def test_ge_multi_group_note_resolves_the_action_by_this_articles_number():
    note = ("n. : 5, 5A, 7/h, 18, 24A, 43; n.t. : 1/1, 2, chap. II, 7/f, chap. III, "
            "22, 23, 24, 25; a. : 13/f (d. : 13/g-j >> 13/f-i) | 28.01.2022 | 01.07.2022")
    assert pa.parse_note("GE", note, "24A")[0].action == "inserted"
    assert pa.parse_note("GE", note, "22")[0].action == "amended"
    # "24" must not match the "24A" token in the n. group
    assert pa.parse_note("GE", note, "24")[0].action == "amended"
    # article 13's letter f is repealed, but 13 is not in any other group:
    # exactly one group hit -> that action
    assert pa.parse_note("GE", note, "13")[0].action == "repealed"


def test_ge_article_in_two_groups_or_no_group_leaves_action_none():
    note = "n. : 15/3, 15/4; n.t. : 12/2, 15/1, 21 | 10.12.2007 | 01.01.2008"
    assert pa.parse_note("GE", note, "15")[0].action is None      # both groups
    assert pa.parse_note("GE", note, "99")[0].action is None      # neither
    event = pa.parse_note("GE", note, "12")[0]
    assert event.action == "amended"
    assert (event.date_decision, event.date_in_force) == (D(2007, 12, 10), D(2008, 1, 1))


def test_ge_free_text_prefix_keeps_dates_and_ref():
    note = ("Restructuration des sections 3 et 4 du chap. III en 3 sections du "
            "nouveau chap. IIIA; n. : 12/1 phr. 3, 24A, 24B; n.t. : 1, 23, 24 "
            "| 25.04.1996 | 22.06.1996")
    [event] = pa.parse_note("GE", note, "24B")
    assert event.source_ref == "25.04.1996" and event.action == "inserted"


def test_ge_note_without_the_two_date_cells_yields_nothing():
    assert pa.parse_note("GE", "n.t. : 4/1", "4") == []


# --- NE --------------------------------------------------------------------

def test_ne_teneur_selon_with_effet():
    [event] = pa.parse_note(
        "NE", "Teneur selon A du 21 décembre 2022 (FO 2022 N° 51) avec effet au 1er janvier 2023")
    assert event == pa.Event("amended", D(2022, 12, 21), D(2023, 1, 1), "FO 2022 N° 51")


def test_ne_ref_is_normalised_and_effet_immediat_stays_unknown():
    [event] = pa.parse_note(
        "NE", "Modifié par A du 12 décembre 2012 (FO 2012 N°51) avec effet au 1er janvier 2013")
    assert event.source_ref == "FO 2012 N° 51"
    [immediate] = pa.parse_note(
        "NE", "Teneur selon A du 8 juillet 2019 (FO 2019 N° 28) avec effet immédiat")
    assert immediate.date_in_force is None and immediate.date_decision == D(2019, 7, 8)


def test_ne_multi_event_note_binds_each_effet_to_its_own_event():
    events = pa.parse_note(
        "NE", "Teneur selon L du 23 juin 1999 (FO 1999 N° 50), L du 5 novembre 2013 "
        "(FO 2013 N° 47) avec effet au 1er janvier 2014 et L du 28 mai 2019 "
        "(FO 2019 N° 24) avec effet au 1er juillet 2019")
    assert [e.source_ref for e in events] == ["FO 1999 N° 50", "FO 2013 N° 47", "FO 2019 N° 24"]
    assert [e.date_in_force for e in events] == [None, D(2014, 1, 1), D(2019, 7, 1)]
    # the leading verb governs the whole list
    assert {e.action for e in events} == {"amended"}


def test_ne_actions_and_extra_ref_in_the_paren():
    [event] = pa.parse_note(
        "NE", "Introduit par L du 5 novembre 2013 (FO 2013 N° 47) avec effet au 1er janvier 2014")
    assert event.action == "inserted"
    [event] = pa.parse_note(
        "NE", "Abrogé par L du 18 mars 2025 (RSN 152.130; FO 2025 N° 13) avec effet au 1er janvier 2026")
    assert event == pa.Event("repealed", D(2025, 3, 18), D(2026, 1, 1), "FO 2025 N° 13")


def test_ne_cross_references_and_legacy_refs_yield_nothing():
    for note in ("RS 220", "RSN 152.510", "RLN V 384", "RLN XI 386",
                 "Approbation fédérale le 27 février 2019"):
        assert pa.parse_note("NE", note) == [], note


def test_ne_bare_fo_reference_is_a_ref_only_event():
    assert pa.parse_note("NE", "FO 2022 N° 51") == [pa.Event(None, None, None, "FO 2022 N° 51")]


# --- TI --------------------------------------------------------------------

def test_ti_modificato_with_vigore_and_bu():
    [event] = pa.parse_note(
        "TI", "Cpv. modificato dal R 10.11.2021; in vigore dal 12.11.2021 - BU 2021, 328.")
    assert event == pa.Event("amended", D(2021, 11, 10), D(2021, 11, 12), "BU 2021, 328")


def test_ti_actions():
    assert pa.parse_note(
        "TI", "Art. abrogato dalla L 1.2.1990; in vigore dal 2.9.1991 - BU 1991, 287.")[0].action == "repealed"
    assert pa.parse_note(
        "TI", "Art. introdotto dal R 24.8.1994; in vigore dal 1.1.1995 - BU 1994, 459.")[0].action == "inserted"


def test_ti_precedenti_modifiche_become_ref_only_events():
    events = pa.parse_note(
        "TI", "Art. modificato dal R 1.3.2011; in vigore dal 4.3.2011 - BU 2011, 119; "
        "precedenti modifiche: BU 2005, 450; BU 2008, 527.")
    assert events[0] == pa.Event("amended", D(2011, 3, 1), D(2011, 3, 4), "BU 2011, 119")
    assert events[1:] == [pa.Event(None, None, None, "BU 2005, 450"),
                          pa.Event(None, None, None, "BU 2008, 527")]


def test_ti_bu_without_the_bu_token_and_two_pages():
    [event] = pa.parse_note(
        "TI", "Nota marginale modificata dal R 4.6.2025; in vigore dal 1.6.2025 - 2025, 118.")
    assert event.source_ref == "BU 2025, 118"
    [event] = pa.parse_note(
        "TI", "Art. modificato dalla L 24.9.2013; in vigore dal 1.3.2014 - BU 2013, 476 e 481.")
    assert event.source_ref == "BU 2013, 476 e 481"


def test_ti_popular_vote_and_unparseable_vigore():
    [event] = pa.parse_note(
        "TI", "Modifica dell'art. 4 cpv. 1 approvata con votazione popolare del 25.9.2016; "
        "in vigore dal 1.4.2018 - BU 2018, 81.")
    assert event == pa.Event("amended", D(2016, 9, 25), D(2018, 4, 1), "BU 2018, 81")
    # "in vigore dall'anno scolastico 1987/88" is not a date; nothing is invented
    [event] = pa.parse_note(
        "TI", "Art. modificato dalla L 18.3.1986; in vigore dall’anno scolastico 1987/88, "
        "per le SM che già hanno applicato il sistema di cui al nuovo art. 7 "
        "dall’anno scolastico 1986/87 - BU 1986, 101.")
    assert event.date_in_force is None and event.date_decision == D(1986, 3, 18)


def test_ti_own_history_notes_yield_nothing():
    for note in ("Entrata in vigore: 1° luglio 1976 - BU 1976, 95.",
                 "Approvazione federale: 28 settembre 2005 - BU 2005, 346.",
                 "Norma transitoria: v. BU 1999, 119; testo completo, nota a fine legge.",
                 "Abrogazione formale con effetto 1° gennaio 2007 della L concernente "
                 "l’istituzione di un Ente del 20 giugno 1988 - BU 2007, 487."):
        assert pa.parse_note("TI", note) == [], note


# --- events_of / source_id -------------------------------------------------

def _article(e_id, number, notes):
    return akn.Article(e_id=e_id, article_number=number, marginal_note=None,
                       text="x", ordinal=0, parent_e_id=None, notes=tuple(notes))


def test_events_of_walks_articles_and_unknown_jurisdiction_yields_nothing():
    articles = [_article("art_1", "1", ["Teneur selon A du 21 décembre 2022 (FO 2022 N° 51) "
                                        "avec effet au 1er janvier 2023", "RS 220"])]
    events = pa.events_of("NE", articles)
    assert len(events) == 1 and events[0].e_id == "art_1"
    assert events[0].raw_note.startswith("Teneur selon")
    assert pa.events_of("ZH", articles) == []


def test_source_id_is_stable_positive_and_distinct():
    a, b = pa.source_id_of("FO 2022 N° 51"), pa.source_id_of("FO 2022 N° 52")
    assert a == pa.source_id_of("FO 2022 N° 51")
    assert a != b and 0 < a < 2 ** 63 and 0 < b < 2 ** 63


# --- store(), real Postgres ------------------------------------------------

pytestmark_db = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    if not os.environ.get("CHPIPE_TEST_DSN"):
        pytest.skip("CHPIPE_TEST_DSN not set")
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                  "VALUES (1, 'https://rsn.ne.ch/x', 'NE', '821.10')")
        c.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                  "lang, date_applicability, xml_url, source, stage) VALUES (10, 1, 'ne:821.10', "
                  "'fr', '2026-01-01', 'u', 'sil', 'fetched')")
        c.execute("SELECT setval('ch_act_version_version_id_seq', 100)")
        yield c


def _events(conn=None):
    return pa.events_of("NE", [
        _article("art_14", "14", ["Teneur selon L du 23 juin 1999 (FO 1999 N° 50), "
                                  "L du 5 novembre 2013 (FO 2013 N° 47) avec effet au 1er janvier 2014"]),
        _article("art_6a", "6a", ["Introduit par L du 24 juin 2020 (FO 2020 N° 28) "
                                  "avec effet au 1er janvier 2021"]),
        _article("art_23", "23", ["Teneur selon L du 5 novembre 2013 (FO 2013 N° 47) "
                                  "avec effet au 1er janvier 2014"]),
    ])


def test_store_writes_documents_and_provenance_and_is_idempotent(conn):
    result = pa.store(conn, 10, 1, "NE", _events(), platform="sil")
    assert (result.documents, result.rows, result.linked) == (3, 4, 4)
    docs = conn.execute(
        "SELECT number, source_id, date_decision FROM ch_act_change_document "
        "WHERE act_id = 1 ORDER BY number").fetchall()
    assert [d[0] for d in docs] == ["FO 1999 N° 50", "FO 2013 N° 47", "FO 2020 N° 28"]
    assert all(d[1] == pa.source_id_of(d[0]) for d in docs)
    # FO 2013 N° 47 is cited twice with the same decision date -> filled
    assert dict((d[0], d[2]) for d in docs)["FO 2013 N° 47"] == datetime.date(2013, 11, 5)
    rows = conn.execute(
        "SELECT e_id, action, as_reference, effective_date, source_act_date, raw_note, "
        "change_document_id FROM ch_article_provenance WHERE version_id = 10 "
        "ORDER BY provenance_id").fetchall()
    assert len(rows) == 4 and all(r[6] is not None for r in rows)
    assert rows[0][0] == "art_14" and rows[0][2] == "FO 1999 N° 50"
    assert rows[1][3] == datetime.date(2014, 1, 1)
    assert rows[2] [1] == "inserted"
    # raw_note is the whole original note, repeated on multi-event notes
    assert rows[0][5] == rows[1][5]
    # a second run replaces, never duplicates
    again = pa.store(conn, 10, 1, "NE", _events(), platform="sil")
    assert (again.documents, again.rows) == (3, 4)
    assert conn.execute("SELECT count(*) FROM ch_article_provenance").fetchone()[0] == 4
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 3


def test_store_event_without_ref_gets_a_row_but_no_document(conn):
    events = pa.events_of("NE", [_article("art_1", "1", [
        "Teneur selon A du 29 avril 2025 (FO 2025 N° 18) avec effet immédiat"])])
    ge_like = [pa.NoteEvent("art_2", "note", pa.Event("amended", None, None, None))]
    result = pa.store(conn, 10, 1, "NE", events + ge_like, platform="sil")
    assert (result.documents, result.rows, result.linked) == (1, 2, 1)
    unlinked = conn.execute("SELECT change_document_id FROM ch_article_provenance "
                            "WHERE e_id = 'art_2'").fetchone()[0]
    assert unlinked is None
