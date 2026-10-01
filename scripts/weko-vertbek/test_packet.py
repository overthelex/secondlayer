"""The packet's own rules, without the database or the embedding service."""
from datetime import date

import packet


def test_recitation_is_measured_on_the_proposition_not_the_passage():
    prop = "Know-how ist eine Gesamtheit nicht patentgeschützter praktischer Kenntnisse."
    assert packet.recital_share(prop, "Gemäss Ziff. 8: " + prop + " Daraus folgt ...") > 0.95
    assert packet.recital_share(prop, "Die Abrede betrifft den Vertrieb von Uhren.") < 0.25
    # a hyphen at a line break does not hide a quotation
    assert packet.recital_share("Weiterverkauf der Vertragswaren", "Wei-\nterverkauf der Vertragswaren") > 0.95


def test_the_regime_follows_the_cartel_acts():
    assert packet.regime(date(1996, 6, 30)) == "KG 1985"
    assert packet.regime(date(1996, 7, 1)) == "KG 1995"
    assert packet.regime(date(2004, 3, 31)) == "KG 1995"
    assert packet.regime(date(2004, 4, 1)) == "KG 2003"
    assert packet.regime(None) is None


def test_tiers():
    assert packet.tier("CH_WEKO_RPW") == "1"
    assert packet.tier("CH_BVGer") == "1"
    assert packet.tier("ZH_Obergericht") == "2"
    assert packet.tier("SG_Publikationen") == "2"
    assert packet.tier("CH_EDOEB") == "other"
    assert packet.tier("CH_VB") == "other"


def test_mergers_are_told_apart_from_the_agencys_other_decisions():
    m = {"spider": "CH_WEKO_RPW", "section_name": "Unternehmenszusammenschlüsse", "opening": ""}
    assert packet.source_class(m) == "merger"
    m = {"spider": "CH_WEKO_RPW", "section_name": "Untersuchungen", "opening": ""}
    assert packet.source_class(m) == "agency"
    assert packet.source_class({"spider": "VD_FindInfo", "section_name": None, "opening": ""}) == "cantonal"


def test_controls_are_in_the_packet_and_the_regime_control_stops_before_2004():
    kinds = [c["kind"] for c in packet.CONTROLS]
    assert kinds.count("negative") == 4 and kinds.count("positive") == 3
    regime = [c for c in packet.CONTROLS if c["kind"] == "regime"][0]
    assert regime["before"] == date(2004, 4, 1)


def test_page_furniture_and_broken_words_are_gone_from_a_passage():
    raw = ("beziehungsweise zwei Jahre, wenn nur der Geschäfts-\n 46\n"
           "wert Gegenstand der Transaktion ist.\n"
           "RPW/DPC 2014/1\n"
           "22-00027/COO.2101.111.7.305747                       38\n"
           "Die Abrede gilt als Wettbewerbs- beschränkung gemäss den Vertikalleitlinien12 und\n"
           "die Herstellungs- oder Vertriebskosten sinken.")
    out = packet.readable("CH_WEKO", raw)
    assert "Geschäftswert Gegenstand" in out
    assert "RPW/DPC" not in out and "COO." not in out and "\n46\n" not in out
    assert "Wettbewerbsbeschränkung" in out and "Vertikalleitlinien und" in out
    assert "Herstellungs- oder Vertriebskosten" in out


def test_a_short_journal_passage_is_read_column_by_column():
    pad = " " * 62
    raw = "\n".join([
        pad + "dann wirtschaftlich sinnvoll gewesen, wenn mit dem Ver-",
        "Kriterium der Erheblichkeit nach Art. 5 Abs. 1 KG. Vor-",
        pad + "trieb eine Marge erwirtschaftet werden konnte.",
        "liegend sind keine Elemente ersichtlich, welche auf eine",
        "vertikalen Preisabreden zwischen Husqvarna und ih-          74. Der temporäre Schutz von",
        pad + "abreden können für einen Hersteller, der ein neues Pro-",
        "B.4.4. Rechtfertigung aus Effizienzgründen",
        pad + "dukt auf den Markt bringen will, hilfreich sein."])
    out = packet.readable("CH_WEKO_RPW", raw)
    assert "neues Produkt auf den Markt" in out
    assert "Vorliegend sind keine Elemente" in out


def test_the_reading_window_finds_the_passage_in_reading_order_text():
    clean = ("Vertikale Preisabreden können für einen Hersteller, der ein neues Produkt auf den Markt "
             "bringen will, hilfreich sein, um in der Einführungsphase die Händler zu gewinnen. "
             "B.4.4. Rechtfertigung aus Effizienzgründen 70. Wettbewerbsabreden sind gemäss Art. 5 "
             "Abs. 2 KG durch Gründe der wirtschaftlichen Effizienz gerechtfertigt, wenn sie notwendig sind.")
    layout = ("abreden können für einen Hersteller, der ein neues Pro-\n"
              "B.4.4. Rechtfertigung aus Effizienzgründen\n"
              "dukt auf den Markt bringen will, hilfreich sein, um in der\n"
              "70. Wettbewerbsabreden sind gemäss Art. 5 Abs. 2 KG")
    w = packet.reading_window(clean, layout)
    assert w and "ein neues Produkt auf den Markt bringen will" in w
    assert packet.reading_window(clean, "Ganz anderer Text über Fusionskontrolle " * 6) is None
