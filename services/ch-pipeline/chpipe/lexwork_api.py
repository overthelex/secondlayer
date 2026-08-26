"""Async client for the Lexwork REST API (`https://{host}/api/{lang}/`).

One semaphore per host on top of http.Fetcher's global cap: the 19
cantonal collections are 19 small government servers, and
CHPIPE_HTTP_CONCURRENCY=12 aimed at one of them is a burst none of them was
sized for. The global cap still holds across all hosts.

Endpoints, as observed 2026-08-26 on belex.sites.be.ch (BE), bl.clex.ch,
gr-lex.gr.ch, ai.clex.ch, bdlf.fr.ch and srl.lu.ch -- the same Angular
bundle everywhere:

  status                                    counters
  texts_of_law/lightweight_index            in-force acts, keyed by category
  change_documents/lightweight_index        amending acts, keyed by month
  texts_of_law/{sysnr}                      one act with its version list
  texts_of_law/{sysnr}/versions/{id}/show_as_json   one version, all languages
  status/recent_changes?offset=N            paginated change log (delta)
"""
from __future__ import annotations

import asyncio

from . import cantons
from .http import FetchError, Fetcher


def _is_404(exc: FetchError) -> bool:
    return str(exc).startswith("404 ")


class LexworkClient:
    def __init__(self, fetcher: Fetcher, per_host: int = 2):
        if per_host < 1:
            raise ValueError(f"per_host must be at least 1, got {per_host}")
        self._fetcher = fetcher
        self._per_host = per_host
        self._locks: dict[str, asyncio.Semaphore] = {}

    def _lock(self, host: str) -> asyncio.Semaphore:
        if host not in self._locks:
            self._locks[host] = asyncio.Semaphore(self._per_host)
        return self._locks[host]

    async def get_json(self, canton: cantons.Canton, url: str):
        async with self._lock(canton.host):
            return await self._fetcher.json(url)

    async def get_bytes(self, canton: cantons.Canton, url: str) -> bytes:
        async with self._lock(canton.host):
            return await self._fetcher.bytes(url)

    async def status(self, canton: cantons.Canton) -> dict:
        data = await self.get_json(canton, f"{cantons.api(canton)}/status")
        return data["status"]

    async def lightweight_index(self, canton: cantons.Canton) -> list[dict]:
        """Every in-force act, flattened out of the per-category dict.
        In-force ONLY: BE lists 712 here against 1,129 in LexFind, so the
        abrogated ones have to come from elsewhere (the registry)."""
        data = await self.get_json(canton, f"{cantons.api(canton)}/texts_of_law/lightweight_index")
        return [tol for group in data.values() for tol in group]

    async def change_documents_index(self, canton: cantons.Canton) -> list[dict]:
        data = await self.get_json(canton, f"{cantons.api(canton)}/change_documents/lightweight_index")
        return [doc for group in data.values() for doc in group]

    async def text_of_law(self, canton: cantons.Canton, sysnr: str,
                          lang: str = "de") -> dict | None:
        """The act's detail record, or None when the host has no such act
        (a registry number the host does not serve)."""
        try:
            data = await self.get_json(canton, f"{cantons.api(canton, lang)}/texts_of_law/{sysnr}")
        except FetchError as exc:
            if _is_404(exc):
                return None
            raise
        return data["text_of_law"]

    async def recent_changes(self, canton: cantons.Canton, offset: int = 0) -> dict:
        return await self.get_json(
            canton, f"{cantons.api(canton)}/status/recent_changes?offset={offset}")
