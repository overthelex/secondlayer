"""The provenance scores on texts small enough to check by eye."""
import provenance


def test_swiss_spelling_and_drafting_do_not_hide_eu_wording():
    swiss = "Die Anbieterin verpflichtet die Abnehmerin, mass- geblich zu liefern; Grösse"
    assert provenance.words(swiss) == ["die", "anbieter", "verpflichtet", "die", "abnehmer",
                                       "massgeblich", "zu", "liefern", "grösse"]
    assert provenance.words("Maßgeblich") == ["massgeblich"]


def test_terminology_is_a_separate_score():
    assert provenance.words("Wettbewerbsabreden der Anbieterin")[0] == "wettbewerbsabreden"
    assert provenance.words("Wettbewerbsabreden der Anbieterin", terms=True) == [
        "vereinbarungen", "der", "lieferant"]


def test_containment_and_alignment(tmp_path, monkeypatch):
    monkeypatch.setattr(provenance, "EU_DIR", tmp_path)
    (tmp_path / "eu.txt").write_text(
        "Artikel 4 Die Freistellung gilt nicht für vertikale Vereinbarungen, die "
        "unmittelbar oder mittelbar die Beschränkung der Möglichkeit des Abnehmers "
        "bezwecken, seinen Verkaufspreis selbst festzusetzen.", encoding="utf-8")
    c = provenance.Corpus(["eu.txt"])
    copied = provenance.words("die Beschränkung der Möglichkeit des Abnehmers bezwecken, "
                              "seinen Verkaufspreis selbst festzusetzen")
    assert c.containment(copied) == 1.0
    assert c.aligned(copied)[0] == 1.0
    own = provenance.words("Die Wettbewerbskommission prüft im Einzelfall, ob die Abrede "
                           "den Wettbewerb in der Schweiz erheblich beeinträchtigt")
    assert c.containment(own) == 0.0
