"""Minimal SPARQL SELECT client.

Synchronous on purpose: discovery is a handful of long queries, not hundreds of
small ones, and the endpoint is happier with one connection than with twelve.

Neither walker uses OFFSET, and both refuse a template that does. Fedlex runs
Virtuoso, whose sorted-TOP implementation rejects any query whose OFFSET +
LIMIT exceeds 10,000:

    Virtuoso 22023 Error SR353: Sorted TOP clause specifies more then 10005
    rows to sort. Only 10000 are allowed.

Verified against the live endpoint on 2026-08-23: OFFSET 9990 LIMIT 10 returns
rows, OFFSET 10000 LIMIT 10 raises SR353. The ceiling is on OFFSET + LIMIT
together, so a larger page size does not buy anything -- it just moves the
wall. The corpus is far past it (17,293 works, ~52,000 title rows, ~170,000
version rows), so an OFFSET walk cannot reach most of it at all.

Two walkers replace the OFFSET walk:

  * keyset() -- for a query with no natural driving set, walked by filtering
    past the last key seen instead of counting rows skipped.
  * batched() -- for a query driven by a set of subject URIs we already hold,
    bound through a VALUES block. Every such query is bounded by the batch,
    so it never approaches the ceiling, and the walk is resumable per batch.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable, Iterator

import httpx

log = logging.getLogger(__name__)

# Matches the convention in chpipe/http.py: name the pipeline, link back to us,
# and give the endpoint operator a contact address.
USER_AGENT = ("SecondLayer-CH-Pipeline/1.0 (+https://legal.org.ua; "
              "legal research corpus; contact: mcvovkes@gmail.com)")

# Rows per keyset page. Only LIMIT is sent (never OFFSET), so the sorted TOP
# stays at this size for every page no matter how deep the walk goes.
DEFAULT_PAGE_SIZE = 2000

# Subject URIs bound into one VALUES block. See fedlex_queries.WORK_BATCH_SIZE
# for the measurement that picked the number.
DEFAULT_BATCH_SIZE = 20

# Characters RFC 3987 forbids inside an IRI, i.e. the ones that would break out
# of the <...> brackets of a VALUES block.
_UNSAFE_IN_IRI = re.compile(r"""[<>"{}|\\^`\s]""")


class SparqlError(RuntimeError):
    pass


def _sparql_string(value: str) -> str:
    """Escape a value for use inside a SPARQL double-quoted literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _fingerprint(row: dict[str, str]) -> tuple:
    return tuple(sorted(row.items()))


def _reject_offset(query_template: str, walker: str) -> None:
    if "OFFSET" in query_template.upper():
        raise ValueError(
            f"{walker}() will not run a query containing OFFSET: Fedlex's "
            "Virtuoso raises SR353 once OFFSET + LIMIT exceeds 10,000, which "
            "is well inside this corpus")


class SparqlClient:
    def __init__(self, endpoint: str, timeout: float = 180.0,
                 transport: httpx.BaseTransport | None = None):
        self._endpoint = endpoint
        self._client = httpx.Client(
            timeout=timeout, transport=transport,
            headers={"Accept": "application/sparql-results+json",
                     "User-Agent": USER_AGENT},
        )

    def close(self) -> None:
        self._client.close()

    def select(self, query: str) -> list[dict[str, str]]:
        response = self._client.post(self._endpoint, data={"query": query})
        if response.status_code != 200:
            raise SparqlError(f"{response.status_code}: {response.text[:300]}")
        bindings = response.json().get("results", {}).get("bindings", [])
        return [{k: v["value"] for k, v in row.items()} for row in bindings]

    def keyset(self, query_template: str, key: str = "work",
               page_size: int = DEFAULT_PAGE_SIZE) -> Iterator[dict[str, str]]:
        """Walk a query by key, not by a row counter.

        The template must carry `FILTER(STR(?<key>) >= "%(after)s")` and end in
        `LIMIT %(limit)d`, and must ORDER BY ?<key> first, or the walk silently
        drops rows.

        The comparison is `>=`, not `>`, and that is deliberate. One subject can
        occupy several rows -- in Fedlex's ACTS, twelve works assert two
        contradictory inForceStatus values and so return two rows each. A strict
        `>` would drop whichever of those rows fell on the far side of a page
        boundary, and the work would be stored with a single status instead of
        being flagged as conflicting. `>=` re-fetches the whole of the boundary
        subject instead, which can never skip a row; the rows already yielded
        are then suppressed here so each row is still handed out exactly once.

        Progress therefore depends on the boundary subject having fewer rows
        than a page. If a whole page turns out to be one subject the walk cannot
        advance, and this raises rather than looping forever or skipping ahead.
        """
        if "%(after)s" not in query_template or "%(limit)d" not in query_template:
            raise ValueError(
                'keyset() needs FILTER(STR(?key) >= "%(after)s") and LIMIT %(limit)d')
        _reject_offset(query_template, "keyset")

        after = ""
        boundary: set[tuple] = set()
        while True:
            rows = self.select(query_template % {"after": _sparql_string(after),
                                                 "limit": page_size})
            for row in rows:
                # Suppress only the rows this page re-fetched because of the
                # `>=`; everything else is new by construction of the ORDER BY.
                if _fingerprint(row) not in boundary:
                    yield row
            if len(rows) < page_size:
                return

            last = rows[-1].get(key)
            if last is None:
                raise SparqlError(
                    f"keyset(): the last row of a full page has no ?{key} to "
                    "page on; the walked query must always bind its key")
            if last == after:
                raise SparqlError(
                    f"keyset(): a full page of {page_size} rows all share "
                    f"?{key} = {last!r}, so the walk cannot advance without "
                    "skipping rows -- raise page_size")
            after = last
            boundary = {_fingerprint(r) for r in rows if r.get(key) == last}

    def batched(self, query_template: str, uris: Iterable[str],
                batch_size: int = DEFAULT_BATCH_SIZE) -> Iterator[dict[str, str]]:
        """Run a query once per batch of subject URIs bound through VALUES.

        The template must carry `VALUES ?subject { %(values)s }`. Every query
        this issues is bounded by its batch rather than by a position in a
        global ordering, so it stays far below Virtuoso's ceiling, the walk
        resumes batch by batch, and -- for the Fedlex version query -- a row
        cannot be orphaned by construction, since its parent is by definition
        already one of the URIs driving the batch.
        """
        if "%(values)s" not in query_template:
            raise ValueError("batched() needs a VALUES block: %(values)s")
        _reject_offset(query_template, "batched")
        if batch_size < 1:
            raise ValueError("batched() needs a batch_size of at least 1")

        batch: list[str] = []
        for uri in uris:
            # One unusable URI must not abort a walk of 17,293 of them.
            if not uri or _UNSAFE_IN_IRI.search(uri):
                log.error("batched: skipping an unusable subject URI: %r", uri)
                continue
            batch.append(uri)
            if len(batch) >= batch_size:
                yield from self._values_query(query_template, batch)
                batch = []
        if batch:
            yield from self._values_query(query_template, batch)

    def _values_query(self, query_template: str,
                      batch: list[str]) -> list[dict[str, str]]:
        values = " ".join(f"<{uri}>" for uri in batch)
        return self.select(query_template % {"values": values})
