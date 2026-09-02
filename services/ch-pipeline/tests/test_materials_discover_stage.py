"""materials_discover_stage against a mocked Fedlex SPARQL endpoint, real
Postgres. The mock answers the MATERIALS keyset walk with one page (fewer
rows than page_size, so the walk ends after it) built from bindings that
mirror what the live graph returned for eli/fga/2001/318 on 2026-09-02
(three languages, three different Gazette pages)."""
import json
import os
import pathlib
from urllib.parse import parse_qs

import httpx
import psycopg
import pytest
from conftest import apply_migration_209

from chpipe import bbl
from chpipe import fedlex_queries as fq
from chpipe.config import Settings
from chpipe.stages import materials_discover_stage as stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

BOTSCHAFT = "https://fedlex.data.admin.ch/eli/fga/2001/318"
REPORT = "https://fedlex.data.admin.ch/eli/fga/2010/999"
MODERN = "https://fedlex.data.admin.ch/eli/fga/2021/2318"
T23 = fq._RESOURCE_TYPE + "23"
T30 = fq._RESOURCE_TYPE + "30"
LANG = "http://publications.europa.eu/resource/authority/language/"


def _pdf(eli, lang):
    tail = eli.rsplit("/eli/", 1)[1]
    return (f"https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/{tail}/{lang}/pdf-a/"
            f"fedlex-data-admin-ch-eli-{tail.replace('/', '-')}-{lang}-pdf-a.pdf")


def _binding(act, type_uri, lang, title, hist, page, pub="2001-04-17", doc="2000-12-20"):
    code = {"DEU": "de", "FRA": "fr", "ITA": "it", "ENG": "en"}[lang]
    b = {"act": act, "typeDocument": type_uri, "lang": LANG + lang, "title": title,
         "publicationDate": pub, "fileUrl": _pdf(act, code)}
    if doc:
        b["dateDocument"] = doc
    if hist:
        b["historicalId"] = hist
        b["memorialYear"] = hist.split()[1]
        b["memorialPage"] = str(page)
    return b


ROWS = [
    _binding(BOTSCHAFT, T23, "DEU", "Botschaft zum Bundesgesetz über die Durchsetzung von internationalen Sanktionen (Embargogesetz, EmbG)", "BBl 2001 1433", 1433),
    _binding(BOTSCHAFT, T23, "FRA", "Message sur la loi fédérale sur l'application de sanctions internationales", "FF 2001 1341", 1341),
    _binding(BOTSCHAFT, T23, "ITA", "Messaggio concernente la legge federale sull'applicazione di sanzioni internazionali", "FF 2001 1247", 1247),
    _binding(REPORT, T30, "DEU", "Bericht der Kommission", None, None, pub="2010-10-12", doc=None),
    _binding(REPORT, T30, "ENG", "Committee report", None, None, pub="2010-10-12", doc=None),
    # 2021+: no historicalLegalId on the expression, the citation is the document number.
    _binding(MODERN, T23, "DEU", "Botschaft zur Änderung des DNA-Profil-Gesetzes", None, None, pub="2021-10-06", doc="2021-09-24"),
]


class Sparql:
    """Serves ROWS whose ?act is >= the page's `after`, like the real walk;
    a page smaller than page_size ends it."""

    def __init__(self, rows=None):
        self.rows = rows if rows is not None else json.loads(json.dumps(ROWS))
        self.calls = 0

    def __call__(self, request):
        self.calls += 1
        query = parse_qs(request.content.decode())["query"][0]
        after = query.split('FILTER(STR(?act) >= "', 1)[1].split('"', 1)[0]
        rows = [r for r in self.rows if r["act"] >= after]
        return httpx.Response(200, json={
            "head": {"vars": list(rows[0]) if rows else []},
            "results": {"bindings": [
                {k: {"type": "literal", "value": v} for k, v in r.items()} for r in rows]},
        })


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        apply_migration_209(c)
        c.execute("INSERT INTO ch_as_act (eli_uri, collection, publication_date) VALUES (%s, 'BBl', '2001-04-17')",
                  (BOTSCHAFT,))
        yield c


def _run(settings, sparql):
    return stage.run(settings, page_size=2000, transport=httpx.MockTransport(sparql))


def _rows(conn):
    return {(r[0], r[1]): r for r in conn.execute(
        "SELECT eli_work_uri, lang, material_type, title, historical_id, bbl_key, memorial_year, "
        "       memorial_page, date_document::text, publication_date::text, pdf_url, as_id, stage, attempts "
        "  FROM ch_material ORDER BY eli_work_uri, lang").fetchall()}


def test_bbl_key_normalises_both_spellings():
    assert bbl.bbl_key("BBl 2001 1433") == "2001||1433"
    assert bbl.bbl_key("FF 2001 1341") == "2001||1341"
    assert bbl.bbl_key("FF 1986 II 360") == "1986|II|360"
    assert bbl.bbl_key("BBl 2015 657 ff.") == "2015||657"
    assert bbl.bbl_key(" ff 2013 6489") == "2013||6489"
    assert bbl.bbl_key("AS 2018 1813") is None
    assert bbl.bbl_key(None) is None
    assert bbl.bbl_key("") is None


def test_eli_key_only_for_the_document_numbered_era():
    assert bbl.eli_key("https://fedlex.data.admin.ch/eli/fga/2021/2318") == "2021||2318"
    assert bbl.eli_key("https://fedlex.data.admin.ch/eli/fga/2026/0042") == "2026||42"
    assert bbl.eli_key("https://fedlex.data.admin.ch/eli/fga/2020/2143") is None      # paginated era
    assert bbl.eli_key("https://fedlex.data.admin.ch/eli/cc/2002/564") is None
    assert bbl.eli_key(None) is None


def test_first_walk_stores_one_row_per_language_with_the_gazette_key(settings, conn):
    sparql = Sparql()
    report = _run(settings, sparql)
    assert sparql.calls == 1
    assert (report.rows, report.upserted, report.inserted) == (6, 5, 5)
    assert report.skipped_lang == 1 and report.skipped_type == 0 and report.requeued == 0
    assert report.by_type == {"botschaft": 4, "bericht_kommission": 1}
    rows = _rows(conn)
    assert set(rows) == {(BOTSCHAFT, "de"), (BOTSCHAFT, "fr"), (BOTSCHAFT, "it"), (REPORT, "de"), (MODERN, "de")}
    # 2021+: the key comes from the ELI number, historical_id stays NULL.
    modern = rows[(MODERN, "de")]
    assert (modern[4], modern[5]) == (None, "2021||2318")
    de = rows[(BOTSCHAFT, "de")]
    assert de[2] == "botschaft" and de[3].startswith("Botschaft zum Bundesgesetz")
    assert (de[4], de[5], de[6], de[7]) == ("BBl 2001 1433", "2001||1433", 2001, "1433")
    assert (de[8], de[9]) == ("2000-12-20", "2001-04-17")
    assert de[10].endswith("-de-pdf-a.pdf") and de[12] == "discovered"
    assert de[11] is not None                      # as_id resolved through ch_as_act
    assert rows[(BOTSCHAFT, "fr")][5] == "2001||1341"
    assert rows[(BOTSCHAFT, "it")][5] == "2001||1247"
    rep = rows[(REPORT, "de")]
    assert rep[2] == "bericht_kommission" and rep[5] is None and rep[8] is None and rep[11] is None


def test_second_walk_is_idempotent_and_keeps_a_parsed_row_parsed(settings, conn):
    sparql = Sparql()
    _run(settings, sparql)
    conn.execute("UPDATE ch_material SET stage = 'parsed', full_text = 'x' WHERE lang = 'de' AND eli_work_uri = %s",
                 (BOTSCHAFT,))
    report = _run(settings, sparql)
    assert (report.upserted, report.inserted, report.requeued) == (5, 0, 0)
    assert _rows(conn)[(BOTSCHAFT, "de")][12] == "parsed"
    assert conn.execute("SELECT count(*) FROM ch_material").fetchone()[0] == 5


def test_a_changed_pdf_url_requeues_a_parsed_row(settings, conn):
    sparql = Sparql()
    _run(settings, sparql)
    conn.execute("UPDATE ch_material SET stage = 'parsed', full_text = 'x', attempts = 2 "
                 " WHERE lang = 'de' AND eli_work_uri = %s", (BOTSCHAFT,))
    for r in sparql.rows:
        if r["act"] == BOTSCHAFT and r["lang"].endswith("DEU"):
            r["fileUrl"] = r["fileUrl"].replace("pdf-a.pdf", "pdf-a-v2.pdf")
    conn.execute("UPDATE ch_material SET text_quality = 0.9, pdf_bytes = 10, fetched_at = now() "
                 " WHERE lang = 'de' AND eli_work_uri = %s", (BOTSCHAFT,))
    report = _run(settings, sparql)
    assert report.requeued == 1
    de = _rows(conn)[(BOTSCHAFT, "de")]
    assert de[12] == "discovered" and de[13] == 0 and de[10].endswith("pdf-a-v2.pdf")
    assert _rows(conn)[(BOTSCHAFT, "fr")][12] == "discovered"
    # The old file's text and receipt went with it: nothing of the old PDF is served.
    assert conn.execute("SELECT full_text, text_quality, pdf_bytes, fetched_at FROM ch_material "
                        " WHERE lang = 'de' AND eli_work_uri = %s", (BOTSCHAFT,)).fetchone() == (None, None, None, None)
    # A third walk with the same URL is not a requeue.
    assert _run(settings, sparql).requeued == 0


def test_metadata_is_refreshed_but_never_blanked(settings, conn):
    sparql = Sparql()
    _run(settings, sparql)
    for r in sparql.rows:
        if r["act"] == BOTSCHAFT and r["lang"].endswith("DEU"):
            r["title"] = "Botschaft (Neufassung des Titels)"
            del r["historicalId"]
    _run(settings, sparql)
    de = _rows(conn)[(BOTSCHAFT, "de")]
    assert de[3] == "Botschaft (Neufassung des Titels)"
    assert de[4] == "BBl 2001 1433" and de[5] == "2001||1433"


def test_a_binding_without_a_file_is_not_a_row(settings, conn):
    rows = json.loads(json.dumps(ROWS))
    del rows[0]["fileUrl"]
    report = _run(settings, Sparql(rows))
    assert report.rows == 6 and report.upserted == 4
    assert (BOTSCHAFT, "de") not in _rows(conn)


def test_materials_query_is_a_valid_keyset_template():
    assert '%(after)s' in fq.MATERIALS and '%(limit)d' in fq.MATERIALS
    assert "OFFSET" not in fq.MATERIALS
    assert fq.MATERIALS.count("%") == 2
    assert set(fq.MATERIAL_TYPES.values()) == {"botschaft", "bericht_br", "stellungnahme_br", "bericht_kommission"}
