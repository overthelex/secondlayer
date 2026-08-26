"""Lexwork editions whose content tree holds no article at all.

Measured on prod 2026-08-26: 235 of 38,014 parsed lexwork editions have
article_count = 0. Every one of the 235 payloads was pulled and walked: in
all 235 `json_content.document.content` is a single childless `title`
node, and whatever text the edition has sits in `document.header` /
`document.footer`. Three of the stored payloads were re-fetched live from
their hosts (BS x2, AG) and were byte-identical, so this is what the hosts
publish, not a fetch defect. The fixtures here are one trimmed real payload
per host and reason (tests/fixtures/lexwork_empty_*.json: the requested
language only, modification table and footnotes dropped, annex list cut to
its first entry); the text each parses to is unchanged from the untrimmed
payload."""
import json
import pathlib

import pytest

from chpipe import lexwork

FIXTURES = pathlib.Path(__file__).parent / "fixtures"

# fixture stem -> (lang, expected empty_reason, a phrase the full text must keep)
EMPTY = {
    "lexwork_empty_ag_by_reference": ("de", "published_by_reference", "wird durch Verweisung publiziert"),
    "lexwork_empty_be_by_reference_de": ("de", "published_by_reference", "nur in der Form eines Verweises"),
    "lexwork_empty_be_by_reference_fr": ("fr", "published_by_reference", "sous la forme d’un renvoi"),
    "lexwork_empty_bl_by_reference": ("de", "published_by_reference", "in der Gesetzessammlung nicht publiziert"),
    "lexwork_empty_bl_unstructured": ("de", "unstructured_text", "basellandschaftlichen Standesfarbe"),
    "lexwork_empty_bs_annex_only": ("de", "annex_only", "siehe Anhang"),
    "lexwork_empty_bs_unstructured": ("de", "unstructured_text", "Antragsberechtigte Behörden und Stellen"),
    "lexwork_empty_gl_placeholder": ("de", "placeholder", "In Revision"),
    "lexwork_empty_gl_unstructured": ("de", "unstructured_text", "Steuerbefreiung für Zuwendungen"),
    "lexwork_empty_lu_placeholder": ("de", "placeholder", "überholt, formell aber noch in Kraft"),
    "lexwork_empty_nw_by_reference": ("de", "published_by_reference", "nicht im Volltext veröffentlicht"),
    "lexwork_empty_ow_unstructured": ("de", "unstructured_text", "Eid der Forstbeamten"),
    "lexwork_empty_tg_unstructured": ("de", "unstructured_text", "Uferfischerei"),
    "lexwork_empty_ur_by_reference": ("de", "published_by_reference", "nicht ins Rechtsbuch aufgenommen"),
    "lexwork_empty_zg_by_reference": ("de", "published_by_reference", "Publikationsplattform Intlex"),
    "lexwork_empty_zg_unstructured": ("de", "unstructured_text", "Als Verzeichnis gelten"),
}

# Every other lexwork edition fixture in the directory carries provisions; a
# new fixture must be declared in one of the tables or the sweep fails.
WITH_ARTICLES = {
    "lexwork_be_101_1_v3020": "de",
}
# Lexwork payloads that are not editions (a texts_of_law listing for
# cantonal_acts_stage), so parse_edition() has nothing to say about them.
# tol JSONs (an act's version list, not an edition): the relink track keeps
# one per host it measured, see tests/test_cantonal_acts_stage.py
NOT_EDITIONS = {p.stem for p in FIXTURES.glob("lexwork_*_tol_*.json")}


def _load(stem: str) -> dict:
    return json.loads((FIXTURES / f"{stem}.json").read_text())


def test_every_lexwork_fixture_is_declared():
    on_disk = {p.stem for p in FIXTURES.glob("lexwork_*.json")}
    assert on_disk == set(EMPTY) | set(WITH_ARTICLES) | NOT_EDITIONS


@pytest.mark.parametrize("stem", sorted(WITH_ARTICLES))
def test_fixtures_with_provisions_parse_to_articles(stem):
    articles, text = lexwork.parse_edition(_load(stem), WITH_ARTICLES[stem])
    assert len(articles) > 0 and text


@pytest.mark.parametrize("stem", sorted(EMPTY))
def test_empty_editions_keep_their_text_and_name_the_reason(stem):
    lang, reason, phrase = EMPTY[stem]
    payload = _load(stem)
    articles, text = lexwork.parse_edition(payload, lang)
    assert articles == []
    assert phrase in text, text
    assert lexwork.empty_reason(payload, lang, text) == reason


def test_empty_reason_prefers_the_structural_annex_signal_over_vocabulary():
    # A document that both ships an annex and says "siehe Anhang" is annex_only
    # because of the annex list, not the words: the words vary per host, the
    # list does not.
    payload = _load("lexwork_empty_bs_annex_only")
    _, text = lexwork.parse_edition(payload, "de")
    assert lexwork.empty_reason(payload, "de", text) == "annex_only"
    payload["text_of_law"]["selected_version"]["annex_documents"] = []
    assert lexwork.empty_reason(payload, "de", text) == "unstructured_text"


def test_empty_reasons_are_a_closed_set():
    for lang, reason, _ in EMPTY.values():
        assert reason in lexwork.EMPTY_REASONS
