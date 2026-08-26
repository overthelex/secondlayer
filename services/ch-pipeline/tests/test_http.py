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


# --- CHPIPE_HTTP_CONCURRENCY=0 hung every request forever ---
#
# asyncio.Semaphore(0) is a valid semaphore that never grants: no error, no
# log line, no timeout, just a stage that looks alive and fetches nothing.
# And throttle.py's ceiling documents "0 or less disables the guard", so this
# codebase's own convention trains an operator to expect 0 = off.

@pytest.mark.parametrize("bad", [0, -1])
def test_a_concurrency_below_one_is_refused(bad):
    with pytest.raises(ValueError, match="at least 1"):
        Fetcher(concurrency=bad)


@pytest.mark.asyncio
async def test_a_concurrency_of_one_still_works():
    async with Fetcher(concurrency=1, transport=_transport(
            lambda r: httpx.Response(200, text="hello"))) as f:
        assert await f.text("https://x/") == "hello"


def test_the_refusal_says_zero_is_not_an_opt_out():
    """The message has to correct the expectation, not just report a bound:
    the operator arrived here because another setting in this codebase does
    treat 0 as off."""
    with pytest.raises(ValueError, match="no limit"):
        Fetcher(concurrency=0)


# --- proxy -----------------------------------------------------------------
#
# amtsblattportal.ch does not answer AWS IPs at all, so the SHAB stages fetch
# through a reverse SOCKS tunnel. Everything else stays direct, which is why
# this is a Fetcher argument and not an env var read inside http.py.

def _proxy_mounts(fetcher):
    """The proxy transports httpx built for this client, keyed by pattern.

    httpx 0.28 does not replace `_transport` for a proxy: it adds a mount
    (an "all://" URLPattern for an explicit `proxy=`, one pattern per
    variable for the env ones) and leaves `_transport` as the direct
    transport. `_mounts` is therefore the thing to assert on -- and the
    thing to remember when passing `transport=` and `proxy=` together,
    because the mount wins over the transport.
    """
    return {pattern.pattern: transport
            for pattern, transport in fetcher._client._mounts.items()
            if transport is not None}


_PROXY_ENV = ("ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY",
              "all_proxy", "https_proxy", "http_proxy")


@pytest.mark.asyncio
async def test_no_proxy_unless_one_is_asked_for(monkeypatch):
    for var in _PROXY_ENV:
        monkeypatch.delenv(var, raising=False)
    async with Fetcher(concurrency=1) as f:
        assert _proxy_mounts(f) == {}


@pytest.mark.asyncio
async def test_a_socks_proxy_is_mounted_for_every_url(monkeypatch):
    for var in _PROXY_ENV:
        monkeypatch.delenv(var, raising=False)
    async with Fetcher(concurrency=1, proxy="socks5h://127.0.0.1:1080") as f:
        mounts = _proxy_mounts(f)
        assert list(mounts) == ["all://"]
        url = mounts["all://"]._pool._proxy_url
        assert (url.scheme, url.host, url.port) == (b"socks5h", b"127.0.0.1", 1080)


@pytest.mark.asyncio
async def test_a_proxy_of_none_is_the_same_as_not_passing_one(monkeypatch):
    """settings.shab_proxy is None whenever the tunnel is not configured, and
    the stages pass it through unconditionally."""
    for var in _PROXY_ENV:
        monkeypatch.delenv(var, raising=False)
    async with Fetcher(concurrency=1, proxy=None) as f:
        assert _proxy_mounts(f) == {}


@pytest.mark.asyncio
async def test_trust_env_still_reads_the_environment(monkeypatch):
    """Unchanged behaviour, pinned: httpx's trust_env default is left alone,
    so HTTPS_PROXY in the unit's environment still applies to every stage.
    The explicit argument exists because that is exactly what we do NOT want
    here -- only SHAB goes through the tunnel."""
    for var in _PROXY_ENV:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:3128")
    async with Fetcher(concurrency=1) as f:
        assert list(_proxy_mounts(f)) == ["https://"]
