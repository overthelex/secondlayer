"""Tests for chpipe.bench.templates and chpipe.bench.build: pure question
formatting and item construction, no DB, no I/O.
"""
import datetime
import random

from chpipe.bench import build, templates

# --- fixtures shared across the make_items tests ---------------------------
#
# Same shape as tests/test_bench_score.py's GOLD/DISTRACTOR: numbered
# paragraphs, paragraph 1 unchanged, paragraphs 2 and 3 materially reworded
# (not just a single digit swapped) so each side has real gold-only /
# distractor-only units.

OLD_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts anderes "
    "vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung innerhalb von 180 Tagen "
    "gerichtlich anfechten."
)

NEW_TEXT = (
    "1 Die Kündigung des Arbeitsverhältnisses durch den Arbeitgeber ist "
    "nichtig, wenn sie missbräuchlich erfolgt.\n"
    "2 Die Kündigungsfrist richtet sich nach den Bestimmungen des "
    "Einzelarbeitsvertrags, sofern nichts anderes vereinbart wurde.\n"
    "3 Der Arbeitnehmer kann die Kündigung nur durch eine schriftliche "
    "Klage beim zuständigen Gericht anfechten."
)

CHANGE_ROW = {
    "act_id": 1,
    "sr_number": "220",
    "e_id": "art_336",
    "article_number": "336",
    "date_applicability": datetime.date(2021, 1, 1),
}

OLD_ROW = {
    "version_id": 123,
    "date_applicability": datetime.date(2015, 1, 1),
    "date_end_applicability": datetime.date(2021, 1, 1),
    "eli_consolidation_uri": "https://fedlex.data.admin.ch/eli/cc/27/317_321_377/20150101",
    "text": OLD_TEXT,
}

NEW_ROW = {
    "version_id": 124,
    "date_applicability": datetime.date(2021, 1, 1),
    "date_end_applicability": None,
    "eli_consolidation_uri": "https://fedlex.data.admin.ch/eli/cc/27/317_321_377/20210101",
    "text": NEW_TEXT,
}


# --- templates.format_date / templates.question ----------------------------


def test_format_date_de():
    assert templates.format_date(datetime.date(2020, 12, 31), "de") == "31. Dezember 2020"


def test_format_date_fr():
    assert templates.format_date(datetime.date(2020, 12, 31), "fr") == "31 décembre 2020"


def test_format_date_it():
    assert templates.format_date(datetime.date(2020, 12, 31), "it") == "31 dicembre 2020"


def test_format_date_no_leading_zero():
    assert templates.format_date(datetime.date(2021, 1, 1), "de") == "1. Januar 2021"


def test_question_de():
    q = templates.question("de", "336", "OR", "220", datetime.date(2020, 12, 31))
    assert q == (
        "Wie lautet Art. 336 OR (SR 220) in der am 31. Dezember 2020 "
        "geltenden Fassung? Zitiere den Wortlaut."
    )


def test_question_fr():
    q = templates.question("fr", "336", "CO", "220", datetime.date(2020, 12, 31))
    assert q == (
        "Quel est le texte de l'art. 336 CO (RS 220) en vigueur le "
        "31 décembre 2020 ? Citez-le mot à mot."
    )


def test_question_it():
    q = templates.question("it", "336", "CO", "220", datetime.date(2020, 12, 31))
    assert q == (
        "Qual è il testo dell'art. 336 CO (RS 220) in vigore il "
        "31 dicembre 2020? Citalo alla lettera."
    )


# --- select_change -----------------------------------------------------------


def test_select_change_rejects_short_text():
    assert build.select_change("too short", NEW_TEXT) is False
    assert build.select_change(OLD_TEXT, "too short") is False


def test_select_change_rejects_whitespace_only_change():
    # Long enough, but only whitespace differs -- normalise() collapses it
    # away, so the two texts are the same string and there is no change.
    padding = " ".join(["Diese Bestimmung regelt die Kündigungsfristen im Arbeitsverhältnis."] * 3)
    assert build.select_change(padding, padding + "  ") is False
    assert build.select_change(padding, padding.replace(" ", "   ")) is False
    assert build.select_change(padding, "\n".join(padding.split(" "))) is False


def test_select_change_accepts_a_real_change():
    assert build.select_change(OLD_TEXT, NEW_TEXT) is True


def test_select_change_accepts_a_one_number_change():
    """The headline case: an amendment that swaps a single figure and
    leaves the rest of the paragraph untouched. A SequenceMatcher ratio
    gate would score this ~0.98 and throw it away; it is exactly the item
    this benchmark exists to ask about."""
    new_text = OLD_TEXT.replace("180 Tagen", "30 Tagen")
    assert new_text != OLD_TEXT
    assert build.select_change(OLD_TEXT, new_text) is True


def test_select_change_accepts_a_one_character_change():
    new_text = OLD_TEXT.replace("drei Monate", "zwei Monate")
    assert build.select_change(OLD_TEXT, new_text) is True


# --- make_items ---------------------------------------------------------------


def test_make_items_returns_before_and_after():
    items, skipped = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    assert skipped == []
    assert [item["kind"] for item in items] == ["before", "after"]


def test_make_items_as_of_values():
    items, _skipped = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    before, after = items
    assert before["as_of"] == "2020-12-31"
    assert after["as_of"] == "2021-01-01"
    assert before["change_date"] == "2021-01-01"
    assert after["change_date"] == "2021-01-01"


def test_make_items_gold_and_distractor_swap():
    items, _skipped = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    before, after = items
    assert before["gold"]["text"] == OLD_TEXT
    assert before["distractor"]["text"] == NEW_TEXT
    assert after["gold"]["text"] == NEW_TEXT
    assert after["distractor"]["text"] == OLD_TEXT
    assert before["gold"]["version_id"] == 123
    assert before["distractor"]["version_id"] == 124
    assert after["gold"]["version_id"] == 124
    assert after["distractor"]["version_id"] == 123
    assert before["gold"]["eli"] == OLD_ROW["eli_consolidation_uri"]
    assert before["gold"]["date_end_applicability"] == "2021-01-01"
    assert after["distractor"]["date_end_applicability"] == "2021-01-01"
    assert after["gold"]["date_end_applicability"] is None


def test_make_items_ids_are_stable_and_distinct():
    items_a, _ = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    items_b, _ = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    before_a, after_a = items_a
    before_b, after_b = items_b
    # stable across two independent calls
    assert before_a["id"] == before_b["id"]
    assert after_a["id"] == after_b["id"]
    # distinct between before/after (different as_of)
    assert before_a["id"] != after_a["id"]
    assert before_a["id"] == build.item_id("de", "220", "art_336", datetime.date(2020, 12, 31))
    assert after_a["id"] == build.item_id("de", "220", "art_336", datetime.date(2021, 1, 1))
    assert len(before_a["id"]) == 16


def test_make_items_provenance_fields():
    items, _skipped = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    for item in items:
        assert item["source"] == "Fedlex (fedlex.admin.ch)"
        assert item["licence"] == "Fedlex data may be reused free of charge with source attribution"


def test_make_items_question_text():
    items, _skipped = build.make_items(CHANGE_ROW, OLD_ROW, NEW_ROW, "OR", "de")
    before, after = items
    assert before["question"] == (
        "Wie lautet Art. 336 OR (SR 220) in der am 31. Dezember 2020 "
        "geltenden Fassung? Zitiere den Wortlaut."
    )
    assert after["question"] == (
        "Wie lautet Art. 336 OR (SR 220) in der am 1. Januar 2021 "
        "geltenden Fassung? Zitiere den Wortlaut."
    )


def test_make_items_drops_item_with_no_discriminating_unit():
    # NEW_TEXT2 is OLD_TEXT2 plus one genuinely new trailing paragraph:
    # every unit of OLD_TEXT2 also occurs in NEW_TEXT2, so the "before"
    # item (gold=old, distractor=new) has no gold-only unit and must be
    # dropped; the "after" item (gold=new, distractor=old) keeps its new
    # paragraph as a gold-only unit and survives.
    p1 = (
        "1 Diese Bestimmung regelt die Kündigungsfristen im "
        "Arbeitsverhältnis nach den gesetzlichen Vorgaben im Einzelnen."
    )
    p2 = (
        "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts "
        "anderes vereinbart wurde zwischen den beiden Vertragsparteien."
    )
    p3 = (
        "3 Zusätzlich gilt eine Sonderregelung für befristete "
        "Arbeitsverhältnisse mit außerordentlicher fristloser Kündigung."
    )
    old_text_2 = p1 + "\n" + p2
    new_text_2 = p1 + "\n" + p2 + "\n" + p3

    old_row = dict(OLD_ROW, text=old_text_2)
    new_row = dict(NEW_ROW, text=new_text_2)

    items, skipped = build.make_items(CHANGE_ROW, old_row, new_row, "OR", "de")

    assert [item["kind"] for item in items] == ["after"]
    assert len(skipped) == 1
    assert skipped[0]["kind"] == "before"
    assert skipped[0]["reason"] == "no_discriminating_unit"
    assert skipped[0]["as_of"] == "2020-12-31"


# --- _build_lang: the language cap counts ITEMS, not changes ----------------
#
# A change contributes at most two items, but often only one (the other
# half loses its discriminating unit -- see the test above). Capping the
# number of CHANGES at ceil(per_lang_cap / 2) therefore leaves the cap
# unfilled whenever that happens; the loop must keep consuming eligible
# changes until the ITEM count reaches the cap.

_P1 = (
    "1 Diese Bestimmung regelt die Kündigungsfristen im "
    "Arbeitsverhältnis nach den gesetzlichen Vorgaben im Einzelnen."
)
_P2 = (
    "2 Die Kündigungsfrist beträgt drei Monate, sofern nichts "
    "anderes vereinbart wurde zwischen den beiden Vertragsparteien."
)


def _row(act_id: int, e_id: str, old_text: str, new_text: str) -> dict:
    """One _CHANGE_SQL-shaped row, enough for _build_lang()."""
    return {
        "act_id": act_id,
        "sr_number": str(200 + act_id),
        "e_id": e_id,
        "article_number": e_id.split("_")[-1],
        "date_applicability": datetime.date(2021, 1, 1),
        "abbreviation": "OR",
        "old_version_id": 100 + act_id,
        "old_date_applicability": datetime.date(2015, 1, 1),
        "old_date_end_applicability": datetime.date(2020, 12, 31),
        "old_eli": f"https://x/{act_id}/old",
        "old_text": old_text,
        "new_version_id": 200 + act_id,
        "new_date_applicability": datetime.date(2021, 1, 1),
        "new_date_end_applicability": None,
        "new_eli": f"https://x/{act_id}/new",
        "new_text": new_text,
    }


def _one_item_row(act_id: int) -> dict:
    """A change that yields exactly ONE item: the new edition only adds a
    paragraph, so `before` has no gold-only unit and is dropped."""
    p3 = (
        f"3 Sonderregelung Nummer {act_id} für befristete "
        "Arbeitsverhältnisse mit außerordentlicher fristloser Kündigung."
    )
    return _row(act_id, f"art_{act_id}", _P1 + "\n" + _P2,
                _P1 + "\n" + _P2 + "\n" + p3)


def _two_item_row(act_id: int) -> dict:
    return _row(act_id, f"art_{act_id}", OLD_TEXT, NEW_TEXT)


def test_build_lang_fills_items_up_to_the_language_cap():
    rows = [_one_item_row(i) for i in (1, 2, 3)]
    items, lang_report = build._build_lang(
        rows, "de", per_lang_cap=3, per_act_cap=50, rng=random.Random(0))

    # Every change yields one item, so filling a cap of 3 needs all three
    # changes -- a ceil(3/2) = 2 change budget would stop at 2 items.
    assert len(items) == 3
    assert lang_report["items"] == 3
    assert all(item["kind"] == "after" for item in items)
    assert lang_report["skipped"]["no_discriminating_unit"] == 3
    assert "capped" not in lang_report["skipped"]


def test_build_lang_counts_only_changes_beyond_the_cap_as_capped():
    rows = [_two_item_row(i) for i in (1, 2, 3)]
    items, lang_report = build._build_lang(
        rows, "de", per_lang_cap=4, per_act_cap=50, rng=random.Random(0))

    # Two changes fill the cap of 4 exactly; only the third is unused.
    assert len(items) == 4
    assert lang_report["skipped"]["capped"] == 1
