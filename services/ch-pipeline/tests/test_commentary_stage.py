"""commentary_stage against a mocked onlinekommentar.ch, real Postgres.

The mock serves the trimmed de listing (3 commentaries, one page) and the
three matching details; the other languages list nothing. What is under
test is the walk's bookkeeping -- upsert, unchanged-skip by listed date,
resolution through the curated uuid map and through ch_act_alias, the
unresolved and stale counters -- not the parsing, which
test_onlinekommentar.py covers without a database."""
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import apply_migration_208

from chpipe import onlinekommentar as ok
from chpipe.config import Settings
from chpipe.stages import commentary_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
LIST = json.loads((FIXTURES / "onlinekommentar_list_de_p1.json").read_text())
DETAILS = {
    d["data"]["id"]: d
    for d in (json.loads(p.read_text()) for p in FIXTURES.glob("onlinekommentar_detail_*.json"))
}
IDS = [item["id"] for item in LIST["data"]]
BANKG = next(i for i in IDS if DETAILS[i]["data"]["title"].endswith("BankG"))
CCC = next(i for i in IDS if "CCC" in DETAILS[i]["data"]["title"])
GWG = next(i for i in IDS if DETAILS[i]["data"]["title"].endswith("GwG"))


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_commentary")
        c.execute("DROP TABLE IF EXISTS ch_act_alias")
        apply_migration_208(c)
        yield c


class Site:
    """The mocked API. `listing` and `details` are mutable so a test can
    change what the second walk sees."""

    def __init__(self):
        self.listing = json.loads(json.dumps(LIST))
        self.details = json.loads(json.dumps(DETAILS))
        self.calls: list[str] = []
        # uuid -> how many more times to answer 429 before serving the detail.
        self.throttle: dict[str, int] = {}

    def __call__(self, request):
        self.calls.append(str(request.url))
        path = request.url.path
        if path == "/api/commentaries":
            lang = request.url.params.get("language")
            if lang == "de" and request.url.params.get("page") == "1":
                return httpx.Response(200, json=self.listing)
            return httpx.Response(200, json={"data": [], "meta": {"last_page": 1}})
        if path.startswith("/api/commentaries/"):
            uuid = path.rsplit("/", 1)[-1]
            if self.throttle.get(uuid, 0) > 0:
                self.throttle[uuid] -= 1
                return httpx.Response(429, text="Too Many Requests")
            if uuid in self.details:
                return httpx.Response(200, json=self.details[uuid])
            return httpx.Response(404, text=uuid)
        return httpx.Response(404, text=path)


def _run(settings, site, langs=None):
    return commentary_stage.run(settings, langs=langs or ["de", "fr"],
                                transport=httpx.MockTransport(site), delay=0.0, retry_wait=0.0)


def _rows(conn):
    return {r[0]: r for r in conn.execute(
        "SELECT source_id, sr_number, abbr, article_number, kind, lang, licence, "
        "       to_char(version_date, 'YYYY-MM-DD'), cardinality(authors), content_hash "
        "  FROM ch_commentary ORDER BY source_id").fetchall()}


def test_first_walk_upserts_every_listed_commentary(settings, conn):
    site = Site()
    report = _run(settings, site)
    assert (report.listed, report.fetched, report.upserted) == (3, 3, 3)
    assert report.skipped_unchanged == 0 and report.errors == 0 and report.stale == 0
    assert report.by_lang == {"de": 3}
    rows = _rows(conn)
    assert set(rows) == set(IDS)
    # Curated uuid map: Banking Act -> 952.0, Cybercrime Convention -> 0.311.43.
    assert rows[BANKG][1] == "952.0" and rows[BANKG][3] == "1b" and rows[BANKG][4] == "article"
    assert rows[CCC][1] == "0.311.43" and rows[CCC][2] == "CCC"
    assert rows[GWG][1] == "955.0"
    assert {r[6] for r in rows.values()} == {"CC-BY-4.0"}
    assert all(r[5] == "de" for r in rows.values())
    assert rows[BANKG][8] == 2
    # One list request per language, one detail per commentary.
    assert sum("language=de" in c for c in site.calls) == 1
    assert sum("language=fr" in c for c in site.calls) == 1
    assert sum("/api/commentaries/" in c for c in site.calls) == 3


def test_second_walk_skips_unchanged_by_listed_date(settings, conn):
    site = Site()
    _run(settings, site)
    site.calls.clear()
    report = _run(settings, site)
    assert report.listed == 3 and report.fetched == 0 and report.upserted == 0
    assert report.skipped_unchanged == 3
    assert not [c for c in site.calls if "/api/commentaries/" in c]
    # last_seen_at moved on the skipped rows.
    stale = conn.execute("SELECT count(*) FROM ch_commentary WHERE last_seen_at < fetched_at").fetchone()[0]
    assert stale == 0


def test_changed_date_refetches_and_rewrites(settings, conn):
    site = Site()
    _run(settings, site)
    before = _rows(conn)[BANKG]
    for item in site.listing["data"]:
        if item["id"] == BANKG:
            item["date"] = "2027-01-01"
    site.details[BANKG]["data"]["date"] = "2027-01-01"
    site.details[BANKG]["data"]["content"] = "<p>neu</p>"
    report = _run(settings, site)
    assert report.fetched == 1 and report.upserted == 1 and report.skipped_unchanged == 2
    after = _rows(conn)[BANKG]
    assert after[7] == "2027-01-01" and after[9] != before[9]
    assert conn.execute("SELECT content_text FROM ch_commentary WHERE source_id = %s",
                        (BANKG,)).fetchone()[0] == "neu"
    assert conn.execute("SELECT count(*) FROM ch_commentary").fetchone()[0] == 3


def test_act_resolved_through_alias_when_uuid_unknown(settings, conn):
    conn.execute("INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) VALUES "
                 "('IRSG', 'de', '351.1', 'fedlex_abbreviation', 'CH'), "
                 "('IRSG', 'de', '326.1', 'title_paren', 'AR')")   # a cantonal homonym must not count
    site = Site()
    site.details[BANKG]["data"]["legislative_act"] = None
    site.details[BANKG]["data"]["title"] = "Art. 80c IRSG"
    report = _run(settings, site)
    assert report.unresolved == 0
    row = _rows(conn)[BANKG]
    assert (row[1], row[2], row[3]) == ("351.1", "IRSG", "80c")


def test_ambiguous_alias_stays_unresolved_and_is_counted(settings, conn):
    conn.execute("INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) VALUES "
                 "('OR', 'de', '220', 'fedlex_abbreviation', 'CH'), "
                 "('OR', 'de', '999', 'fedlex_abbreviation', 'CH')")
    site = Site()
    site.details[BANKG]["data"]["legislative_act"] = {"id": "not-in-the-map", "title": "Something"}
    site.details[BANKG]["data"]["title"] = "Art. 5 OR"
    report = _run(settings, site)
    assert report.unresolved == 1 and report.upserted == 3
    row = _rows(conn)[BANKG]
    assert row[1] is None and row[2] == "OR" and row[3] == "5"


def test_language_specific_alias_wins_over_fedlex_fallback(settings, conn):
    # "OR" is 220 for a German record but an Italian title abbreviation for
    # 511.11: the record's language decides, the Fedlex fallback only runs
    # when the language lookup found nothing.
    conn.execute("INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) VALUES "
                 "('OR', 'de', '220', 'fedlex_abbreviation', 'CH'), "
                 "('OR', 'it', '511.11', 'title_paren', 'CH')")
    assert commentary_stage.resolve_sr(conn, None, "OR", "de") == "220"
    assert commentary_stage.resolve_sr(conn, None, "OR", "it") == "511.11"
    assert commentary_stage.resolve_sr(conn, None, "OR", "fr") == "220"     # fedlex fallback
    assert commentary_stage.resolve_sr(conn, None, None, "de") is None
    assert commentary_stage.resolve_sr(conn, "d673263a-b469-42eb-af67-7c01a19779d7", None, "en") == "952.0"


def test_rows_missing_from_the_listing_are_kept_and_counted_stale(settings, conn):
    site = Site()
    _run(settings, site)
    site.listing["data"] = [i for i in site.listing["data"] if i["id"] != BANKG]
    report = _run(settings, site)
    assert report.listed == 2 and report.stale == 1
    assert conn.execute("SELECT count(*) FROM ch_commentary").fetchone()[0] == 3


def test_a_throttled_detail_is_retried_once_after_the_wait(settings, conn):
    # The Fetcher makes 3 attempts per call; 4 x 429 exhausts the first call
    # and the stage's one extra call then succeeds. 7 x 429 exhausts both.
    site = Site()
    site.throttle[BANKG] = 4
    site.throttle[GWG] = 7
    report = _run(settings, site)
    assert report.retried == 2
    assert report.errors == 1 and report.upserted == 2
    rows = _rows(conn)
    assert BANKG in rows and GWG not in rows


def test_detail_failure_is_counted_not_fatal(settings, conn):
    site = Site()
    del site.details[BANKG]
    report = _run(settings, site)
    assert report.errors == 1 and report.upserted == 2
    assert BANKG not in _rows(conn)


def test_langs_from_env():
    assert commentary_stage.langs_from_env(None) == list(ok.LANGS)
    assert commentary_stage.langs_from_env("de, FR") == ["de", "fr"]
    with pytest.raises(ValueError):
        commentary_stage.langs_from_env("de,rm")
