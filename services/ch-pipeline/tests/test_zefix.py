"""The pure parsers behind the zefix stage, against rows captured live.

tests/fixtures/registries/lindas_orgs_371.csv is a verbatim capture of the
shipped ORGANISATIONS query (Biel/Bienne, 2026-08-26), so what is asserted
here is what LINDAS actually returns, not a hand-written idea of it.
"""
import csv
import pathlib

import pytest

from chpipe import zefix

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "registries"


def _rows(name):
    """CSV back into the shape SparqlClient.select() hands out: a dict per
    row, unbound variables absent rather than empty (the JSON results format
    omits them, and municipality/700 has no name and no canton at all)."""
    with (FIXTURES / name).open(encoding="utf-8") as handle:
        return [{k: v for k, v in row.items() if v}
                for row in csv.DictReader(handle)]


# --- identifiers -----------------------------------------------------------
# One organisation carries exactly three schema:identifier IRIs (measured:
# 12,360 identifier rows over 4,120 organisations in Biel/Bienne). Only the
# UID and CHID ones carry a value; the EHRAID one ends at the segment name.

def test_uid_from_iri_is_canonicalised_with_dots_and_a_hyphen():
    assert zefix.uid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554/UID/CHE242294601"
    ) == "CHE-242.294.601"


def test_uid_from_iri_ignores_the_other_two_identifier_kinds():
    assert zefix.uid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554/CHID/CH03640617915") is None
    assert zefix.uid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554/EHRAID") is None


@pytest.mark.parametrize("iri", ["", "not an iri", ".../UID/CHE24229460",
                                 ".../UID/CHE2422946012", ".../UID/ABC242294601"])
def test_uid_from_iri_refuses_anything_that_is_not_a_che_number(iri):
    assert zefix.uid_from_iri(iri) is None


def test_chid_from_iri_keeps_the_registry_form():
    assert zefix.chid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554/CHID/CH03640617915"
    ) == "CH03640617915"
    assert zefix.chid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554/UID/CHE242294601") is None


def test_ehraid_comes_from_the_subject_iri_not_the_ehraid_identifier():
    """The `.../EHRAID` identifier IRI carries no value -- verified live on
    2026-08-26, every one of them ends at the segment name. The EHRA id is
    the company segment of the organisation's own IRI."""
    assert zefix.ehraid_from_iri(
        "https://register.ld.admin.ch/zefix/company/1198554") == "1198554"
    assert zefix.ehraid_from_iri("https://example.org/nothing") is None


# --- legal form ------------------------------------------------------------

def test_legal_form_code_is_the_last_path_segment():
    assert zefix.legal_form_code(
        "https://ld.admin.ch/ech/97/legalforms/0107") == "0107"
    assert zefix.legal_form_code("") is None


def test_legal_form_label_prefers_the_labels_lindas_published():
    labels = {"0107": "Gesellschaft mit beschränkter Haftung GMBH / SARL"}
    assert zefix.legal_form_label("0107", labels) == \
        "Gesellschaft mit beschränkter Haftung GMBH / SARL"


def test_an_unknown_legal_form_code_is_kept_as_the_code():
    """Never invented. 0113 was documented in the plan as "Institut des
    öffentlichen Rechts"; LINDAS says it is "Besondere Rechtsform" and that
    0117 is the Institut. A guessed label is worse than a code."""
    assert zefix.legal_form_label("9999", {}) == "9999"
    assert zefix.legal_form_label(None, {}) is None


# --- municipality ----------------------------------------------------------

def test_municipality_from_iri():
    assert zefix.municipality_from_iri(
        "https://ld.admin.ch/municipality/371") == 371


@pytest.mark.parametrize("iri", ["", "https://ld.admin.ch/canton/2",
                                 "https://ld.admin.ch/municipality/",
                                 "https://ld.admin.ch/municipality/abc"])
def test_municipality_from_iri_refuses_anything_else(iri):
    assert zefix.municipality_from_iri(iri) is None


# --- address ---------------------------------------------------------------

def test_address_line_is_street_comma_zip_space_locality():
    assert zefix.address_line("Rue des Cygnes 54 c", "2503", "Biel/Bienne") == \
        "Rue des Cygnes 54 c, 2503 Biel/Bienne"


def test_a_multi_line_street_address_is_folded_onto_one_line():
    """Captured live: `c/o Merse Immobiliers SA\\nrue de l'Hôpital 12`."""
    assert zefix.address_line("c/o Merse Immobiliers SA\nrue de l'Hôpital 12",
                              "2502", "Biel/Bienne") == \
        "c/o Merse Immobiliers SA, rue de l'Hôpital 12, 2502 Biel/Bienne"


def test_address_line_drops_the_parts_that_are_missing():
    assert zefix.address_line(None, "2503", "Biel/Bienne") == "2503 Biel/Bienne"
    assert zefix.address_line("Mühlebrücke 2", None, None) == "Mühlebrücke 2"
    assert zefix.address_line(None, None, None) is None


# --- grouping --------------------------------------------------------------

def test_group_by_org_keeps_walk_order_and_collects_every_row():
    rows = [{"org": "a", "identifiers": "x"}, {"org": "b"},
            {"org": "a", "identifiers": "y"}]
    grouped = zefix.group_by_org(rows)
    assert list(grouped) == ["a", "b"]
    assert grouped["a"] == [rows[0], rows[2]]


def test_group_by_org_drops_a_row_with_no_subject():
    assert zefix.group_by_org([{"legalName": "orphan"}]) == {}


# --- company_row -----------------------------------------------------------

SEEN = "2026-08-26T09:00:00+00:00"


def _company(index, **kw):
    rows = _rows("lindas_orgs_371.csv")
    grouped = zefix.group_by_org(rows)
    org = list(grouped)[index]
    kw.setdefault("municipality_id", 371)
    kw.setdefault("municipality_name", "Biel/Bienne")
    kw.setdefault("labels", {"0106": "Aktiengesellschaft",
                             "0107": "Gesellschaft mit beschränkter Haftung GMBH / SARL"})
    return zefix.company_row(grouped[org], seen_at=SEEN, **kw)


def test_company_row_reads_the_captured_biel_organisation():
    row = _company(0)
    assert row["uid"] == "CHE-116.292.808"
    assert row["chid"] == "CH03640492438"
    assert row["ehraid"] == "1001367"
    assert row["name"] == "Mode-Email Pneu-mode Sàrl"
    assert row["legal_form_code"] == "0107"
    assert row["legal_form"] == "Gesellschaft mit beschränkter Haftung GMBH / SARL"
    assert row["legal_seat"] == "Biel/Bienne"
    assert row["canton"] == "BE"
    assert row["municipality_id"] == 371
    assert row["address"] == "Rue des Cygnes 54 c, 2503 Biel/Bienne"
    assert row["status"] == "active"
    assert row["seen_at"] == SEEN
    assert row["source_iri"] == "https://register.ld.admin.ch/zefix/company/1001367"
    assert row["purpose"].startswith("La société a pour but la peinture industrielle")


def test_the_canton_comes_from_the_address_not_the_municipality():
    """A municipality IRI carries no canton abbreviation -- only the canton
    it is containedInPlace does -- and 5 organisations sit in a municipality
    (700) that is not in the Municipality class at all. schema:addressRegion
    on the organisation's own address is the abbreviation, always present."""
    row = _company(0, municipality_name=None)
    assert row["canton"] == "BE"
    assert row["legal_seat"] == "Biel/Bienne", \
        "with no municipality name, the address locality is the seat"


def test_the_trade_names_are_kept_in_metadata_not_in_name():
    """HTDS carries two schema:name values on top of its legalName."""
    row = _company(3)
    assert row["name"] == "HTDS AG High Torque Drive Systems"
    assert row["metadata"]["names"] == ["HTDS SA High Torque Drive Systems",
                                        "HTDS Ltd. High Torque Drive Systems"]


def test_company_row_unions_identifiers_spread_over_several_rows():
    """The shipped query GROUP_CONCATs the three identifier IRIs into one
    binding, but the same organisation arriving as one row per identifier --
    what the ungrouped query returns -- must parse to the same company."""
    base = {"org": "https://register.ld.admin.ch/zefix/company/1198554",
            "legalName": "Beispiel AG",
            "legalForm": "https://ld.admin.ch/ech/97/legalforms/0106",
            "region": "BE"}
    rows = [
        {**base, "ident": ".../company/1198554/UID/CHE242294601"},
        {**base, "ident": ".../company/1198554/CHID/CH03640617915"},
        {**base, "ident": ".../company/1198554/EHRAID"},
    ]
    row = zefix.company_row(rows, municipality_id=371,
                            municipality_name="Biel/Bienne", seen_at=SEEN,
                            labels={})
    assert row["uid"] == "CHE-242.294.601"
    assert row["chid"] == "CH03640617915"
    assert row["ehraid"] == "1198554"


def test_a_company_with_no_uid_is_not_a_company_row():
    """The UID is the primary key. A row that cannot supply one cannot be
    upserted, and must be reported rather than written under a made-up key."""
    assert zefix.company_row(
        [{"org": "https://register.ld.admin.ch/zefix/company/1",
          "legalName": "No UID AG",
          "identifiers": "https://register.ld.admin.ch/zefix/company/1/EHRAID"}],
        municipality_id=371, municipality_name="Biel/Bienne", seen_at=SEEN,
        labels={}) is None


def test_company_row_metadata_keeps_the_raw_bindings():
    row = _company(1)
    assert row["metadata"]["source"] == "lindas-zefix"
    assert row["metadata"]["identifiers"] == [
        "https://register.ld.admin.ch/zefix/company/1001530/UID/CHE116301086",
        "https://register.ld.admin.ch/zefix/company/1001530/CHID/CH03630492540",
        "https://register.ld.admin.ch/zefix/company/1001530/EHRAID"]
    assert row["metadata"]["municipality_iri"] == "https://ld.admin.ch/municipality/371"


# --- the queries themselves ------------------------------------------------

def test_the_organisations_query_is_a_keyset_template_sparql_client_accepts():
    """chpipe/sparql.py's keyset() requires both placeholders and refuses
    OFFSET; the walk of Zürich's 50,438 organisations depends on it."""
    template = zefix.organisations_query("https://ld.admin.ch/municipality/371")
    assert '%(after)s' in template and '%(limit)d' in template
    assert "OFFSET" not in template.upper()
    assert "ORDER BY ?org" in template
    assert "<https://ld.admin.ch/municipality/371>" in template


def test_the_organisations_query_carries_no_stray_percent():
    """The template is rendered with %-formatting by keyset(); a bare % in
    the query text would raise ValueError on the first page."""
    rendered = zefix.organisations_query(
        "https://ld.admin.ch/municipality/371") % {"after": "", "limit": 5000}
    assert "LIMIT 5000" in rendered


def test_the_municipality_iri_is_rejected_if_it_could_break_out_of_the_brackets():
    with pytest.raises(ValueError):
        zefix.organisations_query("https://ld.admin.ch/municipality/1> } #")
