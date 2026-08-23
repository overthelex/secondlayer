import httpx
import pytest
from chpipe.sparql import SparqlClient, SparqlError

RESULT = {
    "head": {"vars": ["work", "sr"]},
    "results": {"bindings": [
        {"work": {"type": "uri", "value": "https://x/1"},
         "sr": {"type": "typed-literal", "value": "220"}},
        {"work": {"type": "uri", "value": "https://x/2"}},
    ]},
}


def _client(handler, **kw):
    return SparqlClient("https://fake/sparql", transport=httpx.MockTransport(handler), **kw)


def test_select_flattens_bindings_to_plain_values():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    assert c.select("SELECT * WHERE {}") == [
        {"work": "https://x/1", "sr": "220"},
        {"work": "https://x/2"},
    ]


def test_select_posts_the_query_as_form_data():
    seen = {}

    def handler(request):
        seen["body"] = request.content.decode()
        seen["accept"] = request.headers["accept"]
        return httpx.Response(200, json=RESULT)

    _client(handler).select("SELECT ?x WHERE {}")
    assert "query=" in seen["body"]
    assert seen["accept"] == "application/sparql-results+json"


def test_a_non_200_raises():
    c = _client(lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(SparqlError, match="500"):
        c.select("SELECT * WHERE {}")


def test_paged_walks_until_a_short_page():
    pages = [
        {"head": {"vars": ["w"]},
         "results": {"bindings": [{"w": {"value": str(i)}} for i in range(3)]}},
        {"head": {"vars": ["w"]},
         "results": {"bindings": [{"w": {"value": "3"}}]}},
    ]
    calls = {"n": 0}

    def handler(request):
        body = pages[min(calls["n"], len(pages) - 1)]
        calls["n"] += 1
        return httpx.Response(200, json=body)

    c = _client(handler)
    rows = list(c.paged("SELECT ?w WHERE {} LIMIT %(limit)d OFFSET %(offset)d",
                        page_size=3))
    assert [r["w"] for r in rows] == ["0", "1", "2", "3"]
    assert calls["n"] == 2


def test_paged_requires_the_limit_and_offset_placeholders():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="LIMIT"):
        list(c.paged("SELECT ?w WHERE {}"))
