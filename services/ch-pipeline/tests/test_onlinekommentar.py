"""chpipe.onlinekommentar: title parsing, HTML flattening, record shape.
Pure functions, no network, no database. Fixtures are real API responses
trimmed to a few kilobytes of content."""
import json
import pathlib

import pytest

from chpipe import onlinekommentar as ok

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
DETAIL = json.loads((FIXTURES / "onlinekommentar_detail_18dfbfd2.json").read_text())
LIST = json.loads((FIXTURES / "onlinekommentar_list_de_p1.json").read_text())


@pytest.mark.parametrize("title, kind, article, abbr", [
    ("Art. 1b BankG", "article", "1b", "BankG"),
    ("Art. 119a BV", "article", "119a", "BV"),
    ("Art. 1b LB", "article", "1b", "LB"),
    ("Art. 1b LBCR", "article", "1b", "LBCR"),
    ("Art. 119a Cst.", "article", "119a", "Cst."),
    ("Art. 119a Cost.", "article", "119a", "Cost."),
    ("Art. 1 CCC (Übereinkommen über die Cyberkriminalität [Cybercrime Convention])",
     "article", "1", "CCC"),
    ("Art. 6 Abs. 6 und 7 BV", "article", "6", "BV"),
    ("Art. 80c IRSG", "article", "80c", "IRSG"),
    # Latin ordinals, the StGB corruption articles: six of them came back as
    # `other` on the first live walk (2026-09-02) with a three-letter cap.
    ("Art. 179quater StGB", "article", "179quater", "StGB"),
    ("Art. 322decies StGB", "article", "322decies", "StGB"),
    ("Art. 322quinquies StGB", "article", "322quinquies", "StGB"),
    ("Art. 322septies StGB", "article", "322septies", "StGB"),
    ("Art. 5bis LugÜ", "article", "5bis", "LugÜ"),
    ("Art. 12ter DSG", "article", "12ter", "DSG"),
    ("Vorb. zu Art. 13-14a StHG", "preliminary", None, "StHG"),
    ("Vorb. zu Art. 261 – 269 ZPO und Art. 261 ZPO", "preliminary", None, "ZPO"),
    ("Vorb. zu Art. 32 — 37 LugÜ", "preliminary", None, "LugÜ"),
    ("Einleitung KGTG", "introduction", None, "KGTG"),
    ("Übergangsbestimmungen zur Aktienrechtsrevision vom 19. Juni 2020", "other", None, None),
    # A title that ends in a number names no act.
    ("Art. 6 Abs. 6 und 7", "article", "6", None),
])
def test_parse_title(title, kind, article, abbr):
    parsed = ok.parse_title(title)
    assert (parsed.kind, parsed.article_number, parsed.abbr) == (kind, article, abbr)


def test_html_to_text_keeps_paragraph_numbers_and_breaks_blocks():
    html = ('<h2>I. Einleitung</h2><p id="p1"><span class="paragraph-nr">1</span>Erster   Absatz '
            'mit <em>Betonung</em>.</p><p><span class="paragraph-nr">2</span>Zweiter.</p>')
    assert ok.html_to_text(html) == "I. Einleitung\n1Erster Absatz mit Betonung.\n2Zweiter."


def test_html_to_text_of_nothing_is_empty():
    assert ok.html_to_text(None) == ""
    assert ok.html_to_text("  ") == ""


def test_record_shape_from_a_real_detail():
    row = ok.record(DETAIL, "de")
    data = DETAIL["data"]
    assert row["source"] == "onlinekommentar"
    assert row["source_id"] == data["id"]
    assert row["lang"] == "de"
    assert row["kind"] == "article"
    assert row["article_number"] == "1b"
    assert row["abbr"] == "BankG"
    assert row["act_uuid"] == "d673263a-b469-42eb-af67-7c01a19779d7"
    assert row["act_title"] == "Banking Act"
    assert row["authors"] == ["Tamara Teves", "David Meirich"]
    assert row["editors"] == ["Nina Reiser", "Beat Brändli"]
    assert row["version_date"] == data["date"]
    assert row["licence"] == "CC-BY-4.0"
    assert row["source_url"] == data["html_link"]
    assert row["pdf_url"] == data["pdf_link"]
    assert row["content_html"] == data["content"]
    assert "<" not in row["content_text"]
    assert row["content_text"].startswith("I. Einleitung")
    assert row["legal_text"] and "<" not in row["legal_text"]
    assert row["content_hash"] == ok.content_hash(data["content"])
    assert "sr_number" not in row      # resolved by the stage, against the database


def test_record_without_legislative_act_still_parses_the_title():
    detail = json.loads(json.dumps(DETAIL))
    detail["data"]["legislative_act"] = None
    detail["data"]["title"] = "Art. 80c IRSG"
    row = ok.record(detail, "de")
    assert row["act_uuid"] is None and row["act_title"] is None
    assert (row["abbr"], row["article_number"]) == ("IRSG", "80c")


def test_every_curated_act_is_in_the_listing_shape():
    # The uuids the stage trusts are the ones the live listing uses.
    listed = {item["legislative_act"]["id"] for item in ok.list_items(LIST)
              if item.get("legislative_act")}
    assert listed <= set(ok.ACT_BY_UUID)
    assert len(ok.ACT_BY_UUID) == 23
    assert len(set(ok.ACT_BY_UUID.values())) == 23


def test_last_page_falls_back_to_one():
    assert ok.last_page(LIST) == 1
    assert ok.last_page({"meta": {"last_page": "8"}}) == 8
    assert ok.last_page({}) == 1
    assert ok.last_page({"meta": {"last_page": None}}) == 1
