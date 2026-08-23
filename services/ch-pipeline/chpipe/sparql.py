"""Minimal SPARQL SELECT client.

Synchronous on purpose: discovery is a handful of long queries, not hundreds of
small ones, and the endpoint is happier with one connection than with twelve.
"""
from __future__ import annotations

from typing import Iterator

import httpx

# Matches the convention in chpipe/http.py: name the pipeline, link back to us,
# and give the endpoint operator a contact address.
USER_AGENT = ("SecondLayer-CH-Pipeline/1.0 (+https://legal.org.ua; "
              "legal research corpus; contact: mcvovkes@gmail.com)")


class SparqlError(RuntimeError):
    pass


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

    def paged(self, query_template: str, page_size: int = 5000
              ) -> Iterator[dict[str, str]]:
        """Walk a query that ends in LIMIT %(limit)d OFFSET %(offset)d.

        Stops on the first short page. The template must ORDER BY something
        stable, or paging silently drops and repeats rows.
        """
        if "%(limit)d" not in query_template or "%(offset)d" not in query_template:
            raise ValueError("paged() needs LIMIT %(limit)d OFFSET %(offset)d")
        offset = 0
        while True:
            rows = self.select(query_template % {"limit": page_size, "offset": offset})
            yield from rows
            if len(rows) < page_size:
                return
            offset += page_size
