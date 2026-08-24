import httpx
import pytest
from chpipe.sparql import MAX_PAGE_SIZE, SparqlClient, SparqlError

RESULT = {
    "head": {"vars": ["work", "sr"]},
    "results": {"bindings": [
        {"work": {"type": "uri", "value": "https://x/1"},
         "sr": {"type": "typed-literal", "value": "220"}},
        {"work": {"type": "uri", "value": "https://x/2"}},
    ]},
}

KEYSET_Q = 'SELECT ?work WHERE { FILTER(STR(?work) >= "%(after)s") } LIMIT %(limit)d'
VALUES_Q = "SELECT ?work WHERE { VALUES ?work { %(values)s } }"


def _client(handler, **kw):
    return SparqlClient("https://fake/sparql", transport=httpx.MockTransport(handler), **kw)


def _bindings(*works):
    return {"head": {"vars": ["work"]},
            "results": {"bindings": [{"work": {"value": w}} for w in works]}}


def _rows(*pairs):
    """Bindings with two columns, so a subject can occupy more than one row."""
    return {"head": {"vars": ["work", "inForce"]},
            "results": {"bindings": [
                {"work": {"value": w}, "inForce": {"value": s}} for w, s in pairs]}}


def _replay(pages, seen):
    """A transport that serves `pages` in order and records every request body."""
    def handler(request):
        body = request.content.decode()
        seen.append(body)
        return httpx.Response(200, json=pages[min(len(seen) - 1, len(pages) - 1)])
    return handler


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
    c = _client(lambda r: httpx.Response(500, text="boom"), backoff=0.0)
    with pytest.raises(SparqlError, match="500"):
        c.select("SELECT * WHERE {}")


# --- Bounded retry, the one chpipe/http.py's Fetcher already had ---
#
# The walks built on select() issue hundreds to thousands of pages against
# Fedlex over hours. A single 502 from a load balancer killed the whole walk
# and the recovery was to start again from the first page.

@pytest.mark.parametrize("transient", [429, 500, 502, 503, 504])
def test_a_transient_failure_is_retried_and_then_succeeds(transient):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(transient, text="upstream had a moment")
        return httpx.Response(200, json=RESULT)

    c = _client(handler, backoff=0.0)
    assert len(c.select("SELECT * WHERE {}")) == 2
    assert calls["n"] == 2


def test_a_400_fails_immediately_without_a_retry():
    """Virtuoso answers a query it will not run -- a syntax error, and SR353,
    the sorted-TOP ceiling this whole module is built around -- with a 400.
    That is a statement ABOUT the query: retrying re-asks a question already
    answered, and reports the same failure minutes later than it could."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(
            400, text="Virtuoso 22023 Error SR353: Sorted TOP clause specifies "
                      "more then 10005 rows to sort. Only 10000 are allowed.")

    c = _client(handler, backoff=0.0)
    with pytest.raises(SparqlError, match="SR353"):
        c.select("SELECT * WHERE {}")
    assert calls["n"] == 1, "a 400 is an answer, not a fault"


def test_a_transport_error_is_retried_too():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, json=RESULT)

    c = _client(handler, backoff=0.0)
    assert len(c.select("SELECT * WHERE {}")) == 2
    assert calls["n"] == 3


def test_retries_are_bounded_and_the_last_failure_is_reported():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, text="still down")

    c = _client(handler, retries=3, backoff=0.0)
    with pytest.raises(SparqlError, match="after 3 attempts"):
        c.select("SELECT * WHERE {}")
    assert calls["n"] == 3


# --------------------------------------------------------------------------
# keyset(): the walk must advance by key, never by a row counter.
#
# Fedlex's Virtuoso raises SR353 once OFFSET + LIMIT exceeds 10,000 (verified
# live: OFFSET 9990 works, OFFSET 10000 does not), and the corpus is 17,293
# works. Every test below fails against the OFFSET walker these replaced.
# --------------------------------------------------------------------------

def test_keyset_walks_until_a_short_page():
    seen = []
    c = _client(_replay([_bindings("a", "b", "c"), _bindings("d")], seen))
    rows = list(c.keyset(KEYSET_Q, page_size=3))
    assert [r["work"] for r in rows] == ["a", "b", "c", "d"]
    assert len(seen) == 2


def test_keyset_advances_by_the_last_key_seen_not_by_a_row_counter():
    """The regression guard. An OFFSET walker sends `OFFSET 3` for page two and
    knows nothing about page one's contents; a keyset walker must carry the
    last key forward and must never send an offset at all."""
    seen = []
    c = _client(_replay([_bindings("a", "b", "https://x/last"), _bindings("z")], seen))
    list(c.keyset(KEYSET_Q, page_size=3))

    assert len(seen) == 2
    first, second = seen
    # Page one starts from the empty key, i.e. from the beginning.
    assert "%3E%3D+%22%22" in first or '>= ""' in first
    # Page two resumes from page one's last key -- not from a count of rows.
    assert "https%3A%2F%2Fx%2Flast" in second or "https://x/last" in second
    assert "OFFSET" not in second.upper()


def test_keyset_refuses_a_template_that_still_uses_offset():
    """A return to OFFSET paging must fail loudly at the client, not silently
    at row 10,001 against the live endpoint."""
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="SR353"):
        list(c.keyset('SELECT ?work WHERE { FILTER(STR(?work) >= "%(after)s") } '
                      "LIMIT %(limit)d OFFSET 20000"))


def test_keyset_requires_the_after_and_limit_placeholders():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="after"):
        list(c.keyset("SELECT ?work WHERE {}"))


def test_keyset_never_skips_the_second_row_of_a_subject_split_by_a_boundary():
    """The reason the filter is `>=` and not `>`.

    Twelve live Fedlex works assert inForceStatus 0 AND 3, so they occupy two
    rows. Here one of them straddles a page boundary: its status-0 row is the
    last row of page one. A strict `>` would resume *after* that work and lose
    the status-3 row entirely, and acts_stage would then store a confident
    enforcement_status of 0 for a work whose status is genuinely unknown."""
    seen = []
    pages = [
        # page one ends on the status-0 row of the conflicted work
        _rows(("cc/1", "0"), ("cc/2", "0"), ("cc/2003/31", "0")),
        # `>=` re-fetches that row and so also brings back the status-3 row
        _rows(("cc/2003/31", "0"), ("cc/2003/31", "3"), ("cc/9", "0")),
        _rows(("cc/9", "0")),
    ]
    c = _client(_replay(pages, seen))
    rows = list(c.keyset(KEYSET_Q, page_size=3))

    conflicted = [r["inForce"] for r in rows if r["work"] == "cc/2003/31"]
    assert sorted(conflicted) == ["0", "3"], "no row of a split subject may be lost"
    assert [(r["work"], r["inForce"]) for r in rows] == [
        ("cc/1", "0"), ("cc/2", "0"), ("cc/2003/31", "0"),
        ("cc/2003/31", "3"), ("cc/9", "0")]


def test_keyset_yields_a_re_fetched_boundary_row_only_once():
    """`>=` re-fetches the boundary subject on purpose; the rows it duplicates
    must still reach the caller exactly once."""
    seen = []
    pages = [_bindings("a", "b"), _bindings("b", "c"), _bindings("d")]
    c = _client(_replay(pages, seen))
    assert [r["work"] for r in c.keyset(KEYSET_Q, page_size=2)] == ["a", "b", "c", "d"]


def test_keyset_raises_instead_of_looping_when_a_page_cannot_advance():
    """If one subject fills a whole page the walk cannot move without skipping
    rows. Saying so beats an infinite loop against a public endpoint."""
    seen = []
    c = _client(_replay([_bindings("a", "a")], seen))
    with pytest.raises(SparqlError, match="cannot advance"):
        list(c.keyset(KEYSET_Q, page_size=2))


def test_the_cannot_advance_message_does_not_advise_raising_the_page_size():
    """The obvious advice is the one move that reintroduces the bug: page_size
    is already capped by the very ceiling this walker exists to avoid, so
    'raise page_size' is a dead end at best and SR353 at worst. The message
    must point at a finer key instead."""
    seen = []
    c = _client(_replay([_bindings("a", "a")], seen))
    with pytest.raises(SparqlError) as exc:
        list(c.keyset(KEYSET_Q, page_size=2))
    message = str(exc.value)
    assert "raise page_size" not in message
    assert "finer key" in message
    assert str(MAX_PAGE_SIZE) in message


def test_keyset_refuses_a_page_size_that_would_hit_the_ceiling_on_its_own():
    """Measured live on 2026-08-23: LIMIT 10000 returns rows, LIMIT 10001
    raises SR353 -- with no OFFSET anywhere. An unbounded page size is the
    same bug wearing a different hat, so the cap is enforced, not advised."""
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    assert MAX_PAGE_SIZE == 10000
    for bad in (MAX_PAGE_SIZE + 1, 20000, 0, -1):
        with pytest.raises(ValueError, match="page_size"):
            list(c.keyset(KEYSET_Q, page_size=bad))


def test_keyset_accepts_a_page_size_exactly_at_the_cap():
    seen = []
    c = _client(_replay([_bindings("a")], seen))
    assert [r["work"] for r in c.keyset(KEYSET_Q, page_size=MAX_PAGE_SIZE)] == ["a"]


def test_keyset_raises_when_the_key_is_not_bound():
    seen = []
    c = _client(_replay([{"head": {"vars": ["other"]},
                          "results": {"bindings": [{"other": {"value": "x"}},
                                                   {"other": {"value": "y"}}]}}], seen))
    with pytest.raises(SparqlError, match="no \\?work"):
        list(c.keyset(KEYSET_Q, page_size=2))


def test_keyset_escapes_a_key_containing_a_quote():
    seen = []
    c = _client(_replay([_bindings('a"b'), _bindings()], seen))
    list(c.keyset(KEYSET_Q, page_size=1))
    assert "%5C%22" in seen[1] or '\\"' in seen[1]


# --------------------------------------------------------------------------
# batched(): the driven walk, bounded by its VALUES block.
# --------------------------------------------------------------------------

def test_batched_binds_the_uris_through_values_in_chunks():
    seen = []
    c = _client(_replay([_bindings("r")], seen))
    uris = [f"https://x/{i}" for i in range(5)]
    rows = list(c.batched(VALUES_Q, uris, batch_size=2))

    assert len(seen) == 3, "5 uris in batches of 2 is three requests"
    assert len(rows) == 3
    assert "https%3A%2F%2Fx%2F0" in seen[0] and "https%3A%2F%2Fx%2F1" in seen[0]
    assert "https%3A%2F%2Fx%2F2" not in seen[0]
    assert "https%3A%2F%2Fx%2F4" in seen[2]


def test_batched_issues_nothing_for_an_empty_driving_set():
    seen = []
    c = _client(_replay([_bindings("r")], seen))
    assert list(c.batched(VALUES_Q, [], batch_size=2)) == []
    assert seen == []


def test_batched_refuses_a_template_that_still_uses_offset():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="SR353"):
        list(c.batched("SELECT ?work WHERE { VALUES ?work { %(values)s } } "
                       "LIMIT 10 OFFSET 20000", ["https://x/1"]))


def test_batched_requires_the_values_placeholder():
    c = _client(lambda r: httpx.Response(200, json=RESULT))
    with pytest.raises(ValueError, match="VALUES"):
        list(c.batched("SELECT ?work WHERE {}", ["https://x/1"]))


def test_batched_skips_an_unusable_uri_instead_of_aborting_the_walk():
    """One malformed URI out of 17,293 must not lose the other 17,292, and must
    not be smuggled into the query where it would break out of the brackets."""
    seen = []
    c = _client(_replay([_bindings("r")], seen))
    rows = list(c.batched(VALUES_Q, ["https://x/1", "bad> } ATTACK {", None,
                                     "https://x/2"], batch_size=10))
    assert len(seen) == 1 and len(rows) == 1
    assert "ATTACK" not in seen[0]
    assert "https%3A%2F%2Fx%2F1" in seen[0] and "https%3A%2F%2Fx%2F2" in seen[0]


def test_batched_consumes_a_generator_lazily():
    """The driving set is read from ch_act; it must not have to be a list."""
    seen = []
    c = _client(_replay([_bindings("r")], seen))
    rows = list(c.batched(VALUES_Q, (f"https://x/{i}" for i in range(4)),
                          batch_size=2))
    assert len(seen) == 2 and len(rows) == 2
