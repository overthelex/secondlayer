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
                 backoff: float = 1.0, transport: httpx.BaseTransport | None = None,
                 proxy: str | None = None, local_address: str | None = None):
        # asyncio.Semaphore(0) is a valid semaphore that never grants: every
        # request would await forever, with no error, no log line and no
        # timeout -- a stage that looks alive and fetches nothing. And this
        # codebase actively trains an operator to try it: throttle.py's
        # ceiling documents "0 or less disables the guard", so
        # CHPIPE_HTTP_CONCURRENCY=0 reads as "no cap" and does the opposite
        # of unlimited. Refuse it here, at the one place every caller
        # (Settings.from_env's http_concurrency, delta's Fetcher(concurrency=1),
        # the tests) has to pass through, rather than in from_env alone.
        if concurrency < 1:
            raise ValueError(
                f"Fetcher concurrency must be at least 1, got {concurrency}. "
                "0 does not mean 'no limit' here -- it builds a semaphore that "
                "never grants, so every request hangs forever. Unlike "
                "CHPIPE_LOAD_CEILING, this setting has no opt-out value.")
        # local_address binds the client's outbound socket to a specific
        # source IP -- amtsblattportal.ch caps requests at roughly 50/s per
        # source IP, and the local server's second uplink has its own public
        # IPs, so binding to one of them is a second, independent per-IP
        # quota at the portal. httpx has no client-level kwarg for this: the
        # bind lives on the transport (AsyncHTTPTransport(local_address=...)),
        # so building one here and handing it to AsyncClient as `transport=`
        # is the only way in. That only happens when the caller did not
        # already pass a `transport` -- an explicit one (every test suite's
        # MockTransport) must win, exactly as `proxy` documents below for its
        # own precedence, or local_address would silently open real sockets
        # under a mocked test.
        #
        # It also cannot be combined with `proxy`: an explicit proxy mounts
        # at "all://" and httpx routes every request through that mount
        # rather than the client's `_transport` (see the proxy tests), so a
        # local_address's bound transport would sit unused -- configured and
        # silently doing nothing. Refused here rather than left to look like
        # it works.
        if local_address is not None and proxy is not None:
            raise ValueError(
                "Fetcher local_address and proxy cannot be combined: an "
                "explicit proxy= mounts at \"all://\" and httpx routes every "
                "request through that mount instead of the client's "
                "transport, so local_address's bound AsyncHTTPTransport "
                "would never be used.")
        if local_address is not None and transport is None:
            transport = httpx.AsyncHTTPTransport(local_address=local_address,
                                                 retries=0)
        self._sem = asyncio.Semaphore(concurrency)
        self._retries = retries
        self._backoff = backoff
        # `proxy` is per-Fetcher rather than per-process because only the two
        # SHAB stages need one: amtsblattportal.ch does not answer AWS IPs at
        # all (the TCP connection hangs), while LINDAS, Fedlex and
        # entscheidsuche are all reachable directly from the same box. Setting
        # HTTPS_PROXY for the whole unit would push those three through a
        # tunnel they do not need and lose them whenever it is down.
        #
        # trust_env is left at its default: HTTPS_PROXY in the environment
        # still applies where it is set, and this argument only adds a mount
        # on top. Note that httpx gives an explicit proxy an "all://" mount,
        # which takes precedence over `transport` -- passing both is a way to
        # bypass a MockTransport without noticing.
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            transport=transport,
            proxy=proxy,
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

    async def body(self, url: str) -> tuple[bytes, str | None]:
        """Raw bytes AND the Content-Type header that describes them.

        Separate from bytes() because the header is the only authoritative
        statement of an HTML body's charset, and it exists only here -- the
        file that fetch_stage writes to disk has no headers. Discarding it
        and letting the parser guess later is what produced the mojibake
        this pipeline exists to repair.
        """
        response = await self._get(url)
        return response.content, response.headers.get("content-type")

    async def json(self, url: str) -> dict:
        return (await self._get(url)).json()

    async def stream_text(self, url: str, chunk_size: int = 1 << 16):
        """Decoded chunks of a response, without ever holding it whole.

        text() buffers the entire body: the CH_BGer directory listing is
        116,000,062 bytes and takes 132.9 s to download, so one call costs
        ~116 MB of resident string before anything has been parsed. This
        yields str chunks instead, so the peak is one chunk plus whatever
        the caller keeps.

        Retries are deliberately NOT applied here. _get() can retry because
        it holds the whole response; a stream that failed halfway has
        already handed part of the body to the caller, and silently
        restarting from byte zero would duplicate it. A failure mid-stream
        raises FetchError and the caller decides -- for `index` that means
        one spider's listing is abandoned and the other 53 continue.
        """
        try:
            async with self._sem:
                async with self._client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise FetchError(f"{response.status_code} for {url}")
                    async for chunk in response.aiter_text(chunk_size):
                        yield chunk
        except httpx.HTTPError as exc:
            raise FetchError(f"{url} failed mid-stream: {exc}") from exc
