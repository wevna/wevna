"""Outgoing HTTP capture, against a real httpx client and a real ASGI target.

httpx talking to an in-process ASGI app is a genuine request/response cycle —
real request objects, real status codes, real exceptions — without needing the
network.
"""

from __future__ import annotations

import logging

import httpx
import pytest

from wevna import correlation
from wevna.httpx import instrument
from wevna.protocol import Envelope
from wevna.runtime import Runtime


async def target(scope, receive, send):  # type: ignore[no-untyped-def]
    """A minimal ASGI app that echoes a status from the path."""
    path = scope.get("path", "/")
    status = 500 if path == "/boom" else 200
    await send({"type": "http.response.start", "status": status, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def calls(seen: list[Envelope]) -> list[dict[str, object]]:
    return [e.payload.attributes for e in seen if e.payload.kind == "http.client"]


@pytest.fixture
def runtime() -> Runtime:
    instance = Runtime()
    instance.start_session()
    return instance


def sync_client() -> httpx.Client:
    return httpx.Client(transport=httpx.WSGITransport(app=_wsgi), base_url="http://api.test")


def _wsgi(environ, start_response):  # type: ignore[no-untyped-def]
    status = "500 Server Error" if environ.get("PATH_INFO") == "/boom" else "200 OK"
    start_response(status, [("content-type", "text/plain")])
    return [b"ok"]


class TestSyncClient:
    def test_publishes_an_http_client_event(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("/v1/rates")

        recorded = calls(seen)
        assert len(recorded) == 1
        assert recorded[0]["method"] == "GET"
        assert recorded[0]["statusCode"] == 200
        assert "/v1/rates" in str(recorded[0]["url"])
        assert isinstance(recorded[0]["durationMs"], float)

    def test_records_a_non_2xx_status(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("/boom")

        assert calls(seen)[0]["statusCode"] == 500

    def test_the_response_still_reaches_the_caller(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        assert client.get("/x").status_code == 200

    def test_is_idempotent(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("/x")

        assert len(calls(seen)) == 1


class TestTheCaptureBoundary:
    def test_redacts_sensitive_query_values(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("/v1/rates?api_key=secret123&page=2")

        url = str(calls(seen)[0]["url"])
        assert "secret123" not in url
        assert "api_key" in url  # the key survives; the value does not
        assert "page=2" in url  # non-sensitive params are kept

    def test_never_records_headers_or_bodies(self, runtime: Runtime) -> None:
        # Headers hold the credentials and bodies hold the payload, and neither
        # is needed to answer which call was slow.
        client = sync_client()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.post(
            "/v1/orders",
            headers={"authorization": "Bearer super-secret"},
            json={"card": "4111111111111111"},
        )

        serialized = str(calls(seen))
        assert "super-secret" not in serialized
        assert "4111111111111111" not in serialized
        assert set(calls(seen)[0]) == {"method", "url", "statusCode", "durationMs"}


class TestIgnoreHosts:
    def test_ignored_hosts_produce_no_event(self, runtime: Runtime) -> None:
        # A metrics sink polled every second would otherwise bury the calls
        # worth looking at.
        client = sync_client()
        instrument(client, runtime=runtime, ignore_hosts=["api.test"])
        seen = collect(runtime)

        client.get("/x")

        assert calls(seen) == []

    def test_other_hosts_still_captured(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime, ignore_hosts=["metrics.internal"])
        seen = collect(runtime)

        client.get("/x")

        assert len(calls(seen)) == 1


class TestFailures:
    def test_a_transport_failure_is_published_without_a_status(self, runtime: Runtime) -> None:
        # A refused connection never reaches a status code, and it is exactly
        # the case somebody is trying to see.
        client = httpx.Client(base_url="http://127.0.0.1:1", timeout=0.5)
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(httpx.HTTPError):
            client.get("/x")

        recorded = calls(seen)
        assert len(recorded) == 1
        assert "statusCode" not in recorded[0]
        assert recorded[0]["error"]

    def test_the_exception_still_reaches_the_caller(self, runtime: Runtime) -> None:
        client = httpx.Client(base_url="http://127.0.0.1:1", timeout=0.5)
        instrument(client, runtime=runtime)

        with pytest.raises(httpx.HTTPError):
            client.get("/x")


class TestCorrelation:
    def test_an_outgoing_call_joins_the_active_correlation(self, runtime: Runtime) -> None:
        # The point of the whole feature: the outbound call appears in the
        # waterfall of the inbound request that triggered it.
        client = sync_client()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("request-1"):
            client.get("/x")

        events = [e for e in seen if e.payload.kind == "http.client"]
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "request-1"


class TestAsyncClient:
    async def test_publishes_for_an_async_client(self, runtime: Runtime) -> None:
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=target), base_url="http://api.test"
        )
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        response = await client.get("/v1/rates")
        await client.aclose()

        assert response.status_code == 200
        assert calls(seen)[0]["statusCode"] == 200

    async def test_correlation_holds_across_an_await(self, runtime: Runtime) -> None:
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=target), base_url="http://api.test"
        )
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("async-request"):
            await client.get("/x")
        await client.aclose()

        events = [e for e in seen if e.payload.kind == "http.client"]
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "async-request"


class TestNeverBreaksTheApplication:
    def test_an_object_without_send_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.WARNING, logger="wevna.httpx"):
            instrument(object())
        assert "cannot instrument" in caplog.text

    def test_a_failing_subscriber_does_not_fail_the_request(self, runtime: Runtime) -> None:
        client = sync_client()
        instrument(client, runtime=runtime)
        runtime.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("down")))

        assert client.get("/x").status_code == 200
