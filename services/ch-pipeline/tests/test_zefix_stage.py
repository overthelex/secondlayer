"""zefix_stage.run(): LINDAS organisations into ch_zefix_companies.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_zefix_stage.py

No live HTTP: FakeSparql answers from the two CSVs under
tests/fixtures/registries/, each captured from the live endpoint on
2026-08-26 with the very queries chpipe/zefix.py ships.
"""
import csv
import datetime as dt
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import zefix
from chpipe.config import Settings
from chpipe.stages import zefix_stage

from conftest import apply_migration_201

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "registries"


def _csv(name):
    """SparqlClient.select()'s shape: a dict per row with unbound variables
    absent, which is how the JSON results format reports them."""
    with (FIXTURES / name).open(encoding="utf-8") as handle:
        return [{k: v for k, v in row.items() if v}
                for row in csv.DictReader(handle)]


class FakeSparql:
    """Stands in for SparqlClient. Dispatches on what the query asks for
    rather than on call order, so the stage is free to reorder its queries.

    `orgs` maps a municipality IRI to the rows that municipality returns; a
    municipality absent from it returns nothing (Zürich and Davos are in the
    municipality fixture but have no organisation fixture).
    """

    def __init__(self, municipalities, orgs, labels=None):
        self.municipalities = municipalities
        self.orgs = orgs
        self.labels = labels if labels is not None else [
            {"form": "https://ld.admin.ch/ech/97/legalforms/0106",
             "name": "Aktiengesellschaft"},
            {"form": "https://ld.admin.ch/ech/97/legalforms/0107",
             "name": "Gesellschaft mit beschränkter Haftung GMBH / SARL"},
        ]
        self.queries = []
        self.closed = False

    def select(self, query):
        self.queries.append(query)
        if "legalforms" in query and "ZefixOrganisation" not in query:
            return list(self.labels)
        return list(self.municipalities)

    def keyset(self, query_template, key="work", page_size=2000):
        self.queries.append(query_template)
        for iri, rows in self.orgs.items():
            if f"<{iri}>" in query_template:
                yield from rows
                return

    def close(self):
        self.closed = True


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        for t in ("ch_zefix_progress", "ch_zefix_municipality",
                  "ch_shab_progress", "ch_shab_publications",
                  "ch_zefix_companies"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        apply_migration_201(c)
        yield c


BIEL = "https://ld.admin.ch/municipality/371"
TODAY = dt.date(2026, 8, 26)
TOMORROW = dt.date(2026, 8, 27)


@pytest.fixture
def client():
    orgs = _csv("lindas_orgs_371.csv")
    return FakeSparql(municipalities=_csv("lindas_municipalities.csv"),
                      orgs={BIEL: orgs})


def _run(settings, client, run_date=TODAY, municipalities=None):
    return zefix_stage.run(settings, run_date=run_date,
                           municipalities=municipalities, client=client)


def _companies(conn):
    return {r["uid"]: r for r in conn.execute(
        "SELECT * FROM ch_zefix_companies").fetchall()}


# --- the walk --------------------------------------------------------------

def test_a_run_upserts_the_municipalitys_companies(conn, settings, client):
    report = _run(settings, client, municipalities=[371])

    companies = _companies(conn)
    assert len(companies) == 4
    biel = companies["CHE-116.292.808"]
    assert biel["name"] == "Mode-Email Pneu-mode Sàrl"
    assert biel["legal_form"] == "Gesellschaft mit beschränkter Haftung GMBH / SARL"
    assert biel["legal_form_code"] == "0107"
    assert biel["legal_seat"] == "Biel/Bienne"
    assert biel["canton"] == "BE"
    assert biel["municipality_id"] == 371
    assert biel["chid"] == "CH03640492438"
    assert biel["ehraid"] == 1001367      # integer, as migration 129 declares it
    assert biel["address"] == "Rue des Cygnes 54 c, 2503 Biel/Bienne"
    assert biel["status"] == "active"
    assert biel["seen_at"] is not None
    assert biel["source_iri"] == "https://register.ld.admin.ch/zefix/company/1001367"
    assert biel["metadata_json"]["source"] == "lindas-zefix"

    assert report.municipalities == 1
    assert report.companies_seen == 4
    assert report.upserted == 4
    assert report.inactivated == 0


def test_the_municipality_table_is_filled_from_the_partition_query(conn, settings,
                                                                  client):
    _run(settings, client)
    rows = {r["id"]: r for r in conn.execute(
        "SELECT * FROM ch_zefix_municipality").fetchall()}
    assert rows[371]["name"] == "Biel/Bienne"
    assert rows[371]["canton"] == "BE"
    assert rows[371]["iri"] == BIEL


def test_a_municipality_outside_the_municipality_class_is_still_walked(conn,
                                                                      settings,
                                                                      client):
    """Measured live on 2026-08-26: organisations reference 2,111 distinct
    municipality IRIs, but only 2,110 of them are a schema.ld:Municipality
    contained in a canton. Municipality 700 is the odd one out, and its 5
    organisations are lost by any walk driven by the Municipality class
    instead of by the organisations themselves."""
    _run(settings, client)
    row = conn.execute(
        "SELECT * FROM ch_zefix_municipality WHERE id = 700").fetchone()
    assert row is not None, "the partition list must come from the organisations"
    assert row["name"] is None and row["canton"] is None
    assert any("municipality/700" in q for q in client.queries), \
        "it must be walked, not merely recorded"


# --- progress and resume ---------------------------------------------------

def test_progress_is_written_per_municipality_and_run_date(conn, settings, client):
    _run(settings, client, municipalities=[371])
    row = conn.execute(
        "SELECT * FROM ch_zefix_progress WHERE municipality_id = 371").fetchone()
    assert row["run_date"] == TODAY
    assert row["companies"] == 4
    assert row["done_at"] is not None


def test_a_second_run_the_same_day_skips_the_municipality(conn, settings, client):
    _run(settings, client, municipalities=[371])
    before = len(client.queries)

    second = _run(settings, client, municipalities=[371])

    assert second.municipalities == 0
    assert second.companies_seen == 0
    # "GROUP BY ?org", not "ZefixOrganisation": the partition query names
    # the class too, and it is issued on every run by design.
    org_queries = [q for q in client.queries[before:] if "GROUP BY ?org" in q]
    assert org_queries == [], "a municipality already done today is not re-walked"


def test_the_next_days_run_walks_it_again(conn, settings, client):
    _run(settings, client, municipalities=[371])
    second = _run(settings, client, run_date=TOMORROW, municipalities=[371])
    assert second.municipalities == 1
    assert second.companies_seen == 4


# --- inactivation ----------------------------------------------------------

def test_a_company_missing_from_the_next_full_run_becomes_inactive(conn, settings,
                                                                   client):
    _run(settings, client)
    assert len(_companies(conn)) == 4

    gone = "CHE-116.292.808"
    survivors = FakeSparql(
        municipalities=_csv("lindas_municipalities.csv"),
        orgs={BIEL: [r for r in _csv("lindas_orgs_371.csv")
                     if "CHE116292808" not in r["identifiers"]]})
    report = _run(settings, survivors, run_date=TOMORROW)

    companies = _companies(conn)
    assert companies[gone]["status"] == "inactive"
    assert companies["CHE-116.301.086"]["status"] == "active"
    assert report.inactivated == 1
    assert len(companies) == 4, "an inactive company is kept, never deleted"


def test_a_partial_run_never_inactivates_anything(conn, settings, client):
    """The sweep asserts something about the WHOLE active set, so it may
    only run once every partition has been walked for this run_date. A run
    restricted to one municipality has not looked at the other 2,110, and
    marking their companies inactive would report every company in
    Switzerland as struck off."""
    _run(settings, client)
    report = _run(settings, client, run_date=TOMORROW, municipalities=[371])
    assert report.inactivated == 0
    assert all(r["status"] == "active" for r in _companies(conn).values())


def test_a_resumed_run_does_not_inactivate_what_the_earlier_half_saw(conn,
                                                                    settings,
                                                                    client):
    """Two invocations, same run_date: the first walks Biel, the second
    resumes and finishes the rest. The companies the FIRST invocation wrote
    carry a seen_at from before the second one started, so a sweep keyed on
    "seen during this process" would strike off everything the resume was
    supposed to preserve."""
    _run(settings, client, municipalities=[371])
    report = _run(settings, client)          # resumes, skips 371, finishes
    assert report.inactivated == 0
    assert all(r["status"] == "active" for r in _companies(conn).values())


def _seed_active(conn, n: int) -> None:
    """n companies the walk will not see, all 'active' and never confirmed."""
    conn.execute("""
        INSERT INTO ch_zefix_companies (uid, name, status)
        SELECT format('CHE-900.000.%%s', to_char(g, 'FM000')), 'Stale AG', 'active'
          FROM generate_series(1, %s) AS g""", (n,))


def test_a_walk_that_saw_a_fraction_of_the_register_does_not_sweep(conn, settings,
                                                                   client):
    """An empty-but-200 answer from LINDAS is indistinguishable from "every
    company in Switzerland has been struck off", and the sweep would write
    that to all 792K rows. A walk that confirms less than half of what is
    currently active is not a register snapshot, it is a broken source."""
    _seed_active(conn, 10)
    report = _run(settings, client)          # the fixture municipality: 4 companies

    assert report.sweep_skipped is True
    assert report.inactivated == 0
    assert all(r["status"] == "active" for r in _companies(conn).values())


def test_a_walk_that_saw_most_of_the_register_still_sweeps(conn, settings, client):
    """The guard is a magnitude check, not a ban: a normal run, where a
    handful of companies have left the register, sweeps as before."""
    _seed_active(conn, 3)
    report = _run(settings, client)          # 4 seen against 7 active

    assert report.sweep_skipped is False
    assert report.inactivated == 3
    assert sum(r["status"] == "inactive" for r in _companies(conn).values()) == 3


def test_an_inactive_company_that_comes_back_is_active_again(conn, settings, client):
    _run(settings, client)
    survivors = FakeSparql(
        municipalities=_csv("lindas_municipalities.csv"),
        orgs={BIEL: [r for r in _csv("lindas_orgs_371.csv")
                     if "CHE116292808" not in r["identifiers"]]})
    _run(settings, survivors, run_date=TOMORROW)
    assert _companies(conn)["CHE-116.292.808"]["status"] == "inactive"

    _run(settings, client, run_date=dt.date(2026, 8, 28))
    assert _companies(conn)["CHE-116.292.808"]["status"] == "active"


# --- upsert semantics ------------------------------------------------------

def test_a_second_days_run_updates_rather_than_duplicates(conn, settings, client):
    _run(settings, client)
    first = _companies(conn)["CHE-116.292.808"]
    _run(settings, client, run_date=TOMORROW)
    second = _companies(conn)["CHE-116.292.808"]
    assert len(_companies(conn)) == 4
    assert second["seen_at"] >= first["seen_at"]
    assert second["updated_at"] >= first["updated_at"]


def test_a_renamed_company_keeps_its_uid_and_takes_the_new_name(conn, settings,
                                                                client):
    _run(settings, client)
    renamed = _csv("lindas_orgs_371.csv")
    renamed[0] = {**renamed[0], "legalName": "Mode-Email Pneu-mode SA"}
    _run(settings, FakeSparql(_csv("lindas_municipalities.csv"), {BIEL: renamed}),
         run_date=TOMORROW)
    assert _companies(conn)["CHE-116.292.808"]["name"] == "Mode-Email Pneu-mode SA"


def test_the_client_is_closed_when_the_stage_owns_it(settings, conn, monkeypatch):
    made = {}

    def fake_client(endpoint, *a, **kw):
        made["client"] = FakeSparql(_csv("lindas_municipalities.csv"),
                                    {BIEL: _csv("lindas_orgs_371.csv")})
        return made["client"]

    monkeypatch.setattr(zefix_stage, "SparqlClient", fake_client)
    zefix_stage.run(settings, run_date=TODAY, municipalities=[371])
    assert made["client"].closed


# --- entry point -----------------------------------------------------------

def test_main_is_reachable_and_reads_chpipe_zefix_municipalities(settings,
                                                                 monkeypatch):
    from chpipe import config
    seen = {}

    monkeypatch.setattr(config.Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(zefix_stage.throttle, "renice", lambda *a: None)
    monkeypatch.setattr(zefix_stage, "run",
                        lambda s, **kw: seen.update(kw) or zefix_stage.ZefixReport())
    monkeypatch.setenv("CHPIPE_ZEFIX_MUNICIPALITIES", "371, 700")
    zefix_stage.main()
    assert seen["municipalities"] == [371, 700]


def test_an_empty_municipality_env_var_means_every_municipality(settings,
                                                                monkeypatch):
    """run-stage.sh's dispatcher exports nothing for `zefix`, but the same
    empty-string shape that broke CHPIPE_SPIDER must not become a partition
    list of one nonsense municipality."""
    from chpipe import config
    seen = {}
    monkeypatch.setattr(config.Settings, "from_env", classmethod(lambda cls: settings))
    monkeypatch.setattr(zefix_stage.throttle, "renice", lambda *a: None)
    monkeypatch.setattr(zefix_stage, "run",
                        lambda s, **kw: seen.update(kw) or zefix_stage.ZefixReport())
    monkeypatch.setenv("CHPIPE_ZEFIX_MUNICIPALITIES", "")
    zefix_stage.main()
    assert seen["municipalities"] is None


def test_the_legal_form_labels_come_from_lindas_not_from_a_hardcoded_map(
        conn, settings):
    """0113 was documented as "Institut des öffentlichen Rechts"; LINDAS
    says "Besondere Rechtsform". The labels are read from the graph, so a
    label this pipeline never guessed is what lands in the column."""
    orgs = _csv("lindas_orgs_371.csv")
    orgs = [{**orgs[0],
             "legalForm": "https://ld.admin.ch/ech/97/legalforms/0113"}]
    client = FakeSparql(
        _csv("lindas_municipalities.csv"), {BIEL: orgs},
        labels=[{"form": "https://ld.admin.ch/ech/97/legalforms/0113",
                 "name": "Besondere Rechtsform"}])
    _run(settings, client, municipalities=[371])
    assert _companies(conn)["CHE-116.292.808"]["legal_form"] == "Besondere Rechtsform"
