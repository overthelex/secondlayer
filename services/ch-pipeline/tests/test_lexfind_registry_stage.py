"""lexfind_registry_stage against a mocked lexfind.ch, real Postgres.
Fixtures are real responses trimmed: BE's systematics (root + node 634 and
its leaves 635/636) and one with-version-groups record (8 families of
versions)."""
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import lexfind_api
from chpipe.config import Settings
from chpipe.stages import lexfind_registry_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
TREE = json.loads((FIXTURES / "lexfind_systematics_be.json").read_text())
GROUPS = json.loads((FIXTURES / "lexfind_groups_23149.json").read_text())
N_TOLS = len(lexfind_api.tols_of(TREE))       # 13 acts under leaves 635 and 636


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=2, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, cantonal_per_host=2)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        yield c


class LexFind:
    def __init__(self):
        self.calls: list[str] = []

    def __call__(self, request):
        url = str(request.url)
        self.calls.append(url)
        path = request.url.path
        if path == "/api/fe/de/entities/4/systematics":
            wanted = request.url.params.get_list("tols_for_systematics[]")
            tree = json.loads(json.dumps(TREE))
            for key, node in tree.items():
                if key and key not in wanted:
                    node["tols"] = []
            return httpx.Response(200, json=tree)
        if path.startswith("/api/fe/de/texts-of-law/") and path.endswith("/with-version-groups"):
            tol_id = int(path.split("/")[-2])
            groups = json.loads(json.dumps(GROUPS))
            groups["id"] = tol_id
            if tol_id == 32335:
                groups["families"] = [[[groups["families"][0][0][0]]]]
            return httpx.Response(200, json=groups)
        return httpx.Response(404, text=path)


def _run(settings, server, **kw):
    return lexfind_registry_stage.run(settings, canton_code="BE",
                                      transport=httpx.MockTransport(server), **kw)


def test_nodes_leaves_and_tols_are_read_from_the_tree():
    assert lexfind_api.node_ids(TREE) == [633, 634, 635, 636]
    assert lexfind_api.leaves(TREE) == [635, 636]
    tols = lexfind_api.tols_of(TREE)
    assert N_TOLS == 13
    assert {t["systematic_number"] for t in tols} >= {"101.1", "101.2", "102.1", "102.111"}
    assert next(t for t in tols if t["systematic_number"] == "101.1")["category"] == "101 Verfassung"


def test_versions_are_flattened_in_document_order():
    versions = lexfind_api.flatten_versions(GROUPS)
    assert len(versions) == 19
    assert versions[0]["info_badge"] == "current"
    assert versions[0]["version_active_since"] == "01.07.2024"
    assert versions[0]["languages"] == ["de"]
    assert "dtah_urls" not in versions[0]


def test_registers_every_act_under_every_leaf_with_its_versions(conn, settings):
    server = LexFind()
    report = _run(settings, server)
    assert report.acts == N_TOLS and report.errors == 0 and report.by_canton == {"BE": N_TOLS}
    rows = conn.execute(
        "SELECT lexfind_tol_id, canton, systematic_number, is_active, category, version_count, "
        "original_url FROM ch_cantonal_registry ORDER BY systematic_number").fetchall()
    assert rows[0][:6] == (23149, "BE", "101.1", True, "101 Verfassung", 19)
    assert rows[0][6].startswith("https://www.zh.ch/")   # the fixture record's original_url
    assert rows[1][:6] == (32335, "BE", "101.2", False, "101 Verfassung", 1)
    assert report.versions == 19 * (N_TOLS - 1) + 1
    systematics_calls = [c for c in server.calls if "/systematics" in c]
    assert len(systematics_calls) == 2, "one call for the tree, one chunk with every node id"
    assert systematics_calls[1].count("tols_for_systematics") == 4, "inner nodes 633/634 are asked too"


def test_rerun_updates_in_place(conn, settings):
    _run(settings, LexFind())
    conn.execute("UPDATE ch_cantonal_registry SET version_count = 0, title = 'stale'")
    _run(settings, LexFind())
    assert conn.execute("SELECT count(*) FROM ch_cantonal_registry").fetchone()[0] == N_TOLS
    assert conn.execute("SELECT min(version_count) FROM ch_cantonal_registry").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM ch_cantonal_registry WHERE title='stale'").fetchone()[0] == 0


def test_a_failing_act_is_counted_and_the_rest_are_written(conn, settings):
    class Flaky(LexFind):
        def __call__(self, request):
            if request.url.path == "/api/fe/de/texts-of-law/23121/with-version-groups":
                return httpx.Response(500, text="boom")
            return super().__call__(request)
    report = _run(settings, Flaky())
    assert report.acts == N_TOLS - 1 and report.errors == 1


def test_canton_selection_accepts_the_seven_bespoke_cantons_too():
    assert lexfind_registry_stage.codes("zh, be") == ["ZH", "BE"]
    assert len(lexfind_registry_stage.codes(None)) == 26
    with pytest.raises(ValueError):
        lexfind_registry_stage.codes("XX")
