"""Async fetcher with a concurrency cap, bounded retries and a User-Agent that
says who we are. entscheidsuche is a small volunteer-run mirror; this pipeline
pulls hundreds of thousands of files from it, so politeness is not optional.
"""
from __future__ import annotations

import asyncio

import httpx

USER_AGENT = ("SecondLayer-CH-Pipeline/1.0 (+https://legal.org.ua; "
              "legal research corpus; contact: mcvovkes@gmail.com)")

# A 404 is a fact about the document, not a transient fault.
_NO_RETRY = frozenset({400, 401, 403, 404, 410})


class FetchError(RuntimeError):
    pass


class Fetcher:
    def __init__(self, concurrency: int, retries: int = 3, timeout: float = 60.0,
                 backoff: float = 1.0, transport: httpx.BaseTransport | None = None):
        self._sem = asyncio.Semaphore(concurrency)
        self._retries = retries
        self._backoff = backoff
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            transport=transport,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=concurrency,
                                max_keepalive_connections=concurrency),
        )

    async def __aenter__(self) -> "Fetcher":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _get(self, url: str) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self._retries):
            async with self._sem:
                try:
                    response = await self._client.get(url)
                except httpx.HTTPError as exc:
                    last = exc
                else:
                    if response.status_code == 200:
                        return response
                    if response.status_code in _NO_RETRY:
                        raise FetchError(f"{response.status_code} for {url}")
                    last = FetchError(f"{response.status_code} for {url}")
            if attempt + 1 < self._retries and self._backoff:
                await asyncio.sleep(self._backoff * (2 ** attempt))
        raise FetchError(f"{url} failed after {self._retries} attempts: {last}")

    async def text(self, url: str) -> str:
        return (await self._get(url)).text

    async def bytes(self, url: str) -> bytes:
        return (await self._get(url)).content

    async def json(self, url: str) -> dict:
        return (await self._get(url)).json()
