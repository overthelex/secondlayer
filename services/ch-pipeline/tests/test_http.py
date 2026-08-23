import httpx
import pytest
from chpipe.http import Fetcher, FetchError


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_returns_body_on_200():
    async with Fetcher(concurrency=2, transport=_transport(
            lambda r: httpx.Response(200, text="hello"))) as f:
        assert await f.text("https://x/") == "hello"


@pytest.mark.asyncio
async def test_retries_a_500_then_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(500) if calls["n"] == 1 else httpx.Response(200, text="ok")

    async with Fetcher(concurrency=2, retries=3, backoff=0.0,
                       transport=_transport(handler)) as f:
        assert await f.text("https://x/") == "ok"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_raises_after_exhausting_retries():
    async with Fetcher(concurrency=2, retries=2, backoff=0.0,
                       transport=_transport(lambda r: httpx.Response(503))) as f:
        with pytest.raises(FetchError, match="503"):
            await f.text("https://x/")


@pytest.mark.asyncio
async def test_a_404_does_not_retry():
    """A missing document is an answer, not a transient failure; retrying it
    three times across 800,000 documents is 1.6M pointless requests."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(404)

    async with Fetcher(concurrency=2, retries=3, backoff=0.0,
                       transport=_transport(handler)) as f:
        with pytest.raises(FetchError, match="404"):
            await f.text("https://x/")
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_concurrency_is_capped():
    import asyncio
    live = {"now": 0, "peak": 0}

    async def handler(request):
        live["now"] += 1
        live["peak"] = max(live["peak"], live["now"])
        await asyncio.sleep(0.01)
        live["now"] -= 1
        return httpx.Response(200, text="x")

    async with Fetcher(concurrency=3, transport=httpx.MockTransport(handler)) as f:
        await asyncio.gather(*(f.text(f"https://x/{i}") for i in range(20)))
    assert live["peak"] <= 3
