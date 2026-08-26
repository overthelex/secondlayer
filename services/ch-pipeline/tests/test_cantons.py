import pytest
from chpipe import cantons


def test_nineteen_lexwork_cantons_and_twenty_six_in_total():
    assert len(cantons.LEXWORK) == 19
    assert len(cantons.ALL) == 26
    assert set(cantons.LEXWORK) < set(cantons.ALL)


def test_every_canton_has_a_distinct_lexfind_entity_id():
    ids = [c.lexfind_id for c in cantons.ALL.values()]
    assert sorted(ids) == list(range(1, 27))


def test_lexwork_urls_are_built_from_the_host():
    be = cantons.LEXWORK["BE"]
    assert cantons.api(be) == "https://www.belex.sites.be.ch/api/de"
    assert cantons.api(be, "fr") == "https://www.belex.sites.be.ch/api/fr"
    assert cantons.deep_link(be, "101.1", 3020) == \
        "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1/versions/3020"
    assert cantons.canonical_link(be, "101.1") == \
        "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1"
    assert cantons.show_as_json_url(be, "101.1", 3020) == \
        "https://www.belex.sites.be.ch/api/de/texts_of_law/101.1/versions/3020/show_as_json"


def test_bilingual_cantons_list_their_languages():
    assert cantons.LEXWORK["BE"].langs == ("de", "fr")
    assert cantons.LEXWORK["GR"].langs == ("de", "it", "rm")
    assert cantons.LEXWORK["ZG"].langs == ("de",)


def test_bespoke_cantons_have_no_lexwork_host():
    for code in ("ZH", "VD", "NE", "GE", "JU", "SZ"):
        assert cantons.ALL[code].platform == "lexfind"
        assert cantons.ALL[code].host == ""
        assert code not in cantons.LEXWORK


def test_canton_selection_from_the_environment_value():
    assert cantons.lexwork_codes(None) == sorted(cantons.LEXWORK)
    assert cantons.lexwork_codes("") == sorted(cantons.LEXWORK)
    assert cantons.lexwork_codes("be, gr") == ["BE", "GR"]
    with pytest.raises(ValueError):
        cantons.lexwork_codes("ZH")


def test_ticino_has_its_own_platform_and_a_version_source():
    ti = cantons.ALL["TI"]
    assert ti.platform == "ti_rl" and ti.host == "www3.ti.ch" and ti.langs == ("it",)
    assert "TI" not in cantons.LEXWORK
    assert cantons.version_source("TI") == "ti_rl"
    assert cantons.version_source("BE") == "lexwork"
    assert cantons.version_source("ZH") is None
    assert cantons.text_codes() == sorted(list(cantons.LEXWORK) + ["TI"])
