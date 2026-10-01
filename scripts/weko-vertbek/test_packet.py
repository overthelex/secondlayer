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
