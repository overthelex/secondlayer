"""chpipe/rpw.py: cutting an RPW issue into decisions. The pages below are
shaped like pdftotext -layout output of real issues (1999/1, 2008/1,
2024/2): running header on the first line, two columns, headings that name
the document's place in the journal's systematics."""
from datetime import date

import pytest

from chpipe import rpw
from chpipe.stages import rpw_stage

ISSUE = rpw.Issue(2024, 2, "")


def page(number, *lines):
    return "\n".join([f"2024/2                                                        {number}", *lines])


FRONT = "\n".join(["                                                 2024/2                  II",
                   "Systematik           A       Tätigkeitsberichte",
                   "                             B2     Wettbewerbskommission",
                   "                             B3     Bundesverwaltungsgericht"])

BODY = "Die Wettbewerbskommission hat den Zusammenschluss geprüft und festgestellt, dass " * 8

PAGES = [
    "Recht und Politik des Wettbewerbs      RPW\n                                       2024/2",
    FRONT,
    page(375,
         "B2          3.       Unternehmenszusammenschlüsse",
         "",
         "B 2.3       1.       TX/H. Locher Consulting & Marketing",
         "",
         "Vorläufige Prüfung; Art. 4 Abs. 3 KG                         4. Die Locher Consulting sei",
         "Stellungnahme der Wettbewerbskommission vom 25.              als OOH-Unternehmen tätig.",
         "April 2024                                                   Sie bezwecke die Vermarktung",
         "                                                             von Werbeflächen und sei be-",
         "Examen préalable; art. 4 al. 3 LCart                         rechtigt, gewisse Flächen zu",
         "                                                             vermarkten, wobei sie Dritte",
         "Esame preliminare; art. 4 cpv. 3 LCart                       damit beauftragt habe.",
         "A.     Sachverhalt                                           5. Gemäss Meldung beabsichtigt",
         "1. Am 2. April 2024 ging die Meldung ein.                    TX alle Anteile zu erwerben.",
         BODY),
    page(376, BODY),
    page(377, BODY,
         "B 2.3         2.       Post CH AG/Quickmail Holding AG",
         "",
         "Stellungnahme der Wettbewerbskommission vom 15. Januar 2024",
         BODY),
    # A content page with no running header: 2024/2 opens its court chapter on one.
    "\n".join(["B3          1.      Urteil vom 12. Dezember 2023 in Sachen Siegenia-Aubi AG gegen WEKO",
               "                    – Unzulässige Wettbewerbsabrede",
               BODY]),
    page(447, BODY),
    "\n".join(["                                                 2024/2                  VI", "Index", "Kartell - 12"]),
]


@pytest.fixture
def docs():
    return rpw.split(rpw.pages_of(PAGES, ISSUE))


def test_issue_names_as_weko_writes_them():
    assert rpw.issue_of("rpw_2001-3.pdf") == rpw.Issue(2001, 3, "")
    assert rpw.issue_of("RPW 2018-4.pdf") == rpw.Issue(2018, 4, "")
    assert rpw.issue_of("rpw_dpc_2024_2.pdf") == rpw.Issue(2024, 2, "")
    assert rpw.issue_of("RPW 2025_4a.pdf") == rpw.Issue(2025, 4, "a")
    assert rpw.issue_of("DPC 2024-1.pdf") == rpw.Issue(2024, 1, "")
    assert rpw.issue_of("Chronologisches Verzeichnis aller RPW ab 2016 bis 2025_04c.pdf") is None
    assert rpw.issue_of("index.9.pdf") is None


def test_running_headers_give_the_journal_page_and_are_dropped():
    pages = rpw.pages_of(PAGES, ISSUE)
    assert [p.number for p in pages] == [None, "II", "375", "376", "377", None, "447", "VI"]
    assert not any("2024/2" in line for line in pages[2].lines)
    old = rpw.pages_of(["RPW/DPC                             1999/1                  94\ntext"], rpw.Issue(1999, 1, ""))
    assert old[0].number == "94" and old[0].lines == ["text"]


def test_an_issue_printed_in_parts_carries_the_part_letter_in_its_header():
    pages = rpw.pages_of(["                  2020/3a                                  877\ntext"],
                         rpw.Issue(2020, 3, "a"))
    assert pages[0].number == "877" and pages[0].lines == ["text"]


def test_a_header_of_another_issue_is_not_this_issues_page():
    assert rpw.pages_of([page(12, "x")], rpw.Issue(2023, 2, ""))[0].number is None


def test_the_section_name_comes_from_the_issue_not_from_the_table():
    """B 2.8 is "Diverses" in SECTION_NAMES and "BGBM" in the 2016 issues."""
    pages = rpw.pages_of([
        page(565,
             "B 2.         8.     BGBM",
             "                    LMI",
             "",
             "B 2.8        1.     Recommandation à l'attention du Grand Conseil",
             "",
             BODY),
    ], ISSUE)
    doc, = rpw.split(pages)
    assert rpw.SECTION_NAMES[("B2", "8")] == "Diverses"      # the fallback says otherwise
    assert doc.section_label == "BGBM" and doc.section_name == "BGBM"


def test_the_issues_own_heading_is_read_in_the_ordinary_case(docs):
    assert docs[0].section_label == "Unternehmenszusammenschlüsse"


def test_without_a_section_heading_the_table_answers():
    pages = rpw.pages_of([page(375, "B 2.3       1.       Kein Abschnittstitel hier", "", BODY)], ISSUE)
    doc, = rpw.split(pages)
    assert doc.section_label is None
    assert doc.section_name == "Unternehmenszusammenschlüsse"      # from SECTION_NAMES


def test_a_case_name_is_not_read_as_a_section_name():
    pages = rpw.pages_of([page(218,
                               "B 2.3       3.       General Electric Company",
                               "", BODY)], ISSUE)
    doc, = rpw.split(pages)
    assert doc.section_label is None


def test_split_cuts_at_every_heading_and_keeps_only_b1_b2(docs):
    assert [(d.chapter, d.section, d.item) for d in docs] == [("B2", "3", 1), ("B2", "3", 2)]
    tx, post = docs
    assert tx.title == "TX/H. Locher Consulting & Marketing"
    assert tx.journal_pages == (375, 377) and tx.start_page.index == 3
    assert "Post CH AG" not in tx.text                      # cut at the next heading, mid-page
    assert post.text.startswith("B 2.3") and post.journal_pages[0] == 377


def test_the_court_chapter_on_a_headerless_page_ends_the_last_decision(docs):
    post = docs[1]
    assert "Siegenia" not in post.text
    assert post.journal_pages == (377, 377)


def test_front_matter_and_index_are_never_documents():
    only_front = rpw.split(rpw.pages_of([FRONT, PAGES[-1]], ISSUE))
    assert only_front == []


def test_a_chapter_without_sections_is_cut_when_it_is_asked_for():
    """B3 numbers its judgments at chapter level ("B3   1.   Urteil ..."),
    so the same line that is a section heading in B2 is a document here."""
    doc, = rpw.split(rpw.pages_of(PAGES, ISSUE), chapters=("B3",))
    assert (doc.chapter, doc.section, doc.item) == ("B3", "", 1)
    assert doc.title.startswith("Urteil vom 12. Dezember 2023 in Sachen Siegenia")
    assert rpw.doc_id(ISSUE, doc) == "RPW_2024-2_B3.1"
    assert doc.section_name == "Bundesverwaltungsgericht"        # the chapter's own name
    assert "Post CH AG" not in doc.text


def test_the_notices_of_part_d1():
    """What the audit needs: every version of a Bekanntmachung as published."""
    pages = rpw.pages_of([
        page(608,
             "D1          Erlasse, Bekanntmachungen",
             "",
             "D1          1.       Bekanntmachung über die wettbewerbsrechtliche Behandlung",
             "                     vertikaler Abreden (Vertikalbekanntmachung, VertBek)",
             "",
             BODY),
        page(616,
             "D1          2.       Communication concernant l'appréciation des accords verticaux",
             "",
             BODY),
    ], ISSUE)
    de, fr = rpw.split(pages, chapters=("D1",))
    assert de.title.startswith("Bekanntmachung über die wettbewerbsrechtliche Behandlung vertikaler Abreden")
    assert (de.chapter, de.section, de.item) == ("D1", "", 1)
    assert de.section_name == "Erlasse, Bekanntmachungen"
    assert de.journal_pages == (608, 608) and fr.journal_pages[0] == 616
    assert rpw.doc_id(ISSUE, de) == "RPW_2024-2_D1.1"
    assert rpw.citation(ISSUE, de) == "RPW 2024/2, S. 608"


def test_a_sectioned_chapter_still_reads_its_section_headings_as_headings():
    """The same shape, the other reading: B2 numbers its items with a
    section, so "B2   3.   Unternehmenszusammenschlüsse" is not a document."""
    docs = rpw.split(rpw.pages_of(PAGES, ISSUE), chapters=("B2",))
    assert [(d.chapter, d.section, d.item) for d in docs] == [("B2", "3", 1), ("B2", "3", 2)]
    assert all(d.title != "Unternehmenszusammenschlüsse" for d in docs)


def test_wrapped_titles_join_and_hyphen_breaks_close():
    lines = ["B 2.3     7.   Zusammenschlussvorhaben Carrier Corpora-",
             "               tion - Toshiba Corporation",
             "",
             "Text"]
    assert rpw._heading_title(lines, 0) == "Zusammenschlussvorhaben Carrier Corporation - Toshiba Corporation"
    lines = ["B 1.4     1.   Selbstregulierungen der Bankiervereinigung im",
             "               Bereich Sustainable Finance",
             "1. Die Anfrage"]
    assert rpw._heading_title(lines, 0) == "Selbstregulierungen der Bankiervereinigung im Bereich Sustainable Finance"
    lines = ["B 2.2     1.   Hoch- und Tiefbau", "", "x"]
    assert rpw._heading_title(lines, 0) == "Hoch- und Tiefbau"


def test_decision_date_reads_across_the_column_break(docs):
    assert rpw.decision_date(docs[0].text) == date(2024, 4, 25)
    assert rpw.decision_date(docs[1].text) == date(2024, 1, 15)
    assert rpw.decision_date("Décision du 12 décembre 2022 de la Commission " + BODY) == date(2022, 12, 12)
    assert rpw.decision_date("Parere del 3 agosto 2021 " + BODY) == date(2021, 8, 3)
    assert rpw.decision_date("Einleitende Bemerkungen " + BODY) is None
    # a recital's letter or an earlier act is not this document's date
    assert rpw.decision_date("A. Sachverhalt 1. Mit Schreiben vom 3. März 2024 meldete X. " + BODY) is None
    assert rpw.decision_date("Mit Verfügung vom 1. Mai 2019 eröffnete das Sekretariat. "
                             "Verfügung vom 7. Juni 2021 " + BODY) == date(2021, 6, 7)


def test_ids_and_citation(docs):
    assert rpw.doc_id(ISSUE, docs[0]) == "RPW_2024-2_B2.3.1"
    assert rpw.doc_id(rpw.Issue(2020, 3, "b"), docs[0]) == "RPW_2020-3b_B2.3.1"
    assert rpw.citation(ISSUE, docs[0]) == "RPW 2024/2, S. 375"
    assert rpw.citation(rpw.Issue(2020, 3, "a"), docs[0]) == "RPW 2020/3a, S. 375"


def test_norm_title_matches_entscheidsuche_names():
    assert rpw.norm_title("Zusammenschlussvorhaben Post CH AG / Quickmail Holding AG") == \
        rpw.norm_title("Post CH AG/Quickmail Holding AG")
    assert rpw.norm_title("Hors-Liste Medikamente") == rpw.norm_title("Hors-Liste-Medikamente")


INDEX_HTML = """<html><body>
<a href="/dam/de/sd-web/AAAA/rpw_dpc_2024_2.pdf">RPW 2024-2</a>
<a href="/dam/de/sd-web/BBBB/Chronologisches%20Verzeichnis%20aller%20RPW%20ab%202016.pdf">Verzeichnis</a>
<a href="/dam/de/sd-web/CCCC/rpw_1999-1.pdf">RPW 1999-1</a>
</body></html>"""


def test_years_filter():
    assert rpw_stage.years_filter("2024") == {2024}
    assert rpw_stage.years_filter("1997-1999, 2005") == {1997, 1998, 1999, 2005}
    assert rpw_stage.years_filter("") is None
    with pytest.raises(ValueError):
        rpw_stage.years_filter("24")


def test_list_issues_drops_the_indexes_and_sorts_oldest_first():
    issues = rpw_stage.list_issues(INDEX_HTML)
    assert [i.key for i, _ in issues] == ["1999-1", "2024-2"]
    assert issues[1][1] == "https://www.weko.admin.ch/dam/de/sd-web/AAAA/rpw_dpc_2024_2.pdf"


def test_the_link_text_names_the_issue_when_the_file_name_does_not():
    assert rpw.issue_of_link("RPW 2019-3a PDF 14.00 MB 6. August 2025", "rpw.pdf") == rpw.Issue(2019, 3, "a")
    assert rpw.issue_of_link("RPW 2019-3b PDF 4.11 MB", "rpw20193.pdf") == rpw.Issue(2019, 3, "b")
    assert rpw.issue_of_link("RPW 2013-1 PDF 1.36 MB", "rpw_2013-1.1.pdf") == rpw.Issue(2013, 1, "")
    assert rpw.issue_of_link("DPC 2024-1 PDF", "DPC 2024-1.pdf") == rpw.Issue(2024, 1, "")
    # the per-issue indexes and the annual report are not issues
    assert rpw.issue_of_link("Index 2008-1 PDF 99.52 kB", "index.50.pdf") is None
    assert rpw.issue_of_link("Index 2004-4 PDF", "index_2004-4.pdf") is None
    assert rpw.issue_of_link("Jahresbericht 1999 PDF", "1999.pdf") is None
    # no text: the file name decides
    assert rpw.issue_of_link("", "rpw_2001-3.pdf") == rpw.Issue(2001, 3, "")


def test_list_issues_reads_odd_file_names_off_their_link_text():
    html = ('<a href="/dam/de/sd-web/X/rpw.pdf">RPW 2019-3a</a>'
            '<a href="/dam/de/sd-web/Y/index.50.pdf">Index 2008-1</a>'
            '<a href="/dam/de/sd-web/Z/rpw_2006-4.1.pdf">RPW 2006-4</a>')
    assert [i.key for i, _ in rpw_stage.list_issues(html)] == ["2006-4", "2019-3a"]


def test_a_number_the_journal_printed_twice_gets_its_page_in_the_id():
    pages = rpw.pages_of([
        page(218, "B 2.3       3.       General Electric Company/ALSTOM Energy", "", BODY),
        page(256, "B 2.3       3.       Astorg/Goldman Sachs/HRA Pharma", "", BODY),
    ], ISSUE)
    ids = [rpw.doc_id(ISSUE, d) for d in rpw.split(pages)]
    assert ids == ["RPW_2024-2_B2.3.3", "RPW_2024-2_B2.3.3_S256"]


def test_a_misprinted_section_name_that_belongs_to_another_section_is_refused():
    """RPW 2017/3 prints "B2 8. Unternehmenszusammenschlüsse" over its BGBM
    section, and section 3 of the same issue carries that name for real."""
    pages = rpw.pages_of([
        page(500, "B2          3.       Unternehmenszusammenschlüsse", "",
             "B 2.3       1.       Amcor/SIDEL/JV", "", BODY),
        page(560, "B2          8.       Unternehmenszusammenschlüsse", "",
             "B 2.8       1.       Recommandation au canton de Genève", "", BODY),
    ], ISSUE)
    merger, recommendation = rpw.split(pages)
    assert merger.section_name == "Unternehmenszusammenschlüsse"
    assert recommendation.section_label is None
    assert recommendation.section_name == "Diverses"        # the fallback, not the misprint


def test_the_journals_spelling_slips_are_recorded_under_one_name():
    assert rpw.canonical_section("Stehlungnahmen") == "Stellungnahmen"
    assert rpw.canonical_section("Stellungsnahmen") == "Stellungnahmen"
    assert rpw.canonical_section("Vorabklärung") == "Vorabklärungen"
    assert rpw.canonical_section("BGBM") == "BGBM"
    # a name the journal really does use for something else is left alone
    assert rpw.canonical_section("Bekanntmachungen") == "Bekanntmachungen"
