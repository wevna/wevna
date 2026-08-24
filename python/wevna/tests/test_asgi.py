"""The ASGI middleware, exercised through a real Starlette application.

Starlette is a test dependency only. The middleware imports nothing from it —
these tests use it because asserting against a real router is the only way to
know that route resolution, exception propagation and status capture work
against a framework rather than against a mock of one.
"""

from __future__ import annotations

import logging

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from wevna.asgi import WevnaMiddleware
from wevna.protocol import Envelope
from wevna.runtime import Runtime


def build(runtime: Runtime) -> TestClient:
    async def ok(request):  # type: ignore[no-untyped-def]
        return JSONResponse({"ok": True})

    async def slow(request):  # type: ignore[no-untyped-def]
        logging.getLogger("app.asgi").info("handling %s", request.path_params["item_id"])
        return PlainTextResponse("done")

    async def boom(request):  # type: ignore[no-untyped-def]
        raise ValueError("handler exploded")

    app = Starlette(
        routes=[
            Route("/ok", ok),
            Route("/items/{item_id}", slow),
            Route("/boom", boom),
        ]
    )
    wrapped = WevnaMiddleware(app, runtime=runtime)
    return TestClient(wrapped, raise_server_exceptions=False)


def events(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def only(seen: list[Envelope], kind: str) -> list[Envelope]:
    return [e for e in seen if e.payload.kind == kind]


def test_publishes_an_http_request_event() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    build(runtime).get("/ok")

    requests = only(seen, "http.request")
    assert len(requests) == 1
    assert requests[0].payload.attributes["method"] == "GET"
    assert requests[0].payload.attributes["statusCode"] == 200


def test_captures_the_route_pattern_not_the_concrete_path() -> None:
    # "/items/{item_id}" rather than "/items/42", so a thousand requests to one
    # endpoint group as one route.
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    build(runtime).get("/items/42")

    attributes = only(seen, "http.request")[0].payload.attributes
    assert attributes["route"] == "/items/{item_id}"
    assert attributes["url"] == "/items/42"


def test_measures_a_duration() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    build(runtime).get("/ok")

    duration = only(seen, "http.request")[0].payload.attributes["durationMs"]
    assert isinstance(duration, float)
    assert duration >= 0


def test_everything_in_a_request_shares_one_correlation() -> None:
    # The whole point of the middleware: a log written inside the handler must
    # land under the request that caused it, without the handler cooperating.
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    from wevna.logging_capture import install

    logger = logging.getLogger("app.asgi")
    logger.setLevel(logging.INFO)
    uninstall = install(runtime.publish, logger)
    try:
        build(runtime).get("/items/7")
    finally:
        uninstall()

    correlations = {e.payload.correlation.id for e in seen if e.payload.correlation is not None}
    kinds = {e.payload.kind for e in seen}
    assert "log.record" in kinds
    assert "http.request" in kinds
    assert len(correlations) == 1, "the log and the request should share one correlation"


def test_concurrent_requests_get_separate_correlations() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    client = build(runtime)
    client.get("/ok")
    client.get("/ok")

    correlations = {e.payload.correlation.id for e in seen if e.payload.correlation is not None}
    assert len(correlations) == 2


class TestFailingRequests:
    def test_the_exception_still_reaches_the_application(self) -> None:
        # Observing must not swallow: the application's error handling, and the
        # 500 its client is owed, both depend on it propagating.
        runtime = Runtime()
        runtime.start_session()
        response = build(runtime).get("/boom")
        assert response.status_code == 500

    def test_publishes_exception_captured(self) -> None:
        runtime = Runtime()
        runtime.start_session()
        seen = events(runtime)

        build(runtime).get("/boom")

        exceptions = only(seen, "exception.captured")
        assert len(exceptions) == 1
        attributes = exceptions[0].payload.attributes
        assert attributes["name"] == "ValueError"
        assert attributes["message"] == "handler exploded"
        assert "ValueError: handler exploded" in str(attributes["stack"])

    def test_still_publishes_the_request(self) -> None:
        runtime = Runtime()
        runtime.start_session()
        seen = events(runtime)

        build(runtime).get("/boom")

        requests = only(seen, "http.request")
        assert len(requests) == 1
        assert requests[0].payload.attributes["statusCode"] == 500

    def test_the_exception_and_the_request_share_a_correlation(self) -> None:
        runtime = Runtime()
        runtime.start_session()
        seen = events(runtime)

        build(runtime).get("/boom")

        correlations = {e.payload.correlation.id for e in seen if e.payload.correlation is not None}
        assert len(correlations) == 1


class TestPassThrough:
    def test_non_http_scopes_are_untouched(self) -> None:
        # Wrapping a lifespan or websocket scope would mean deciding what a
        # "request" is for a protocol with no such boundary, and getting it
        # wrong would break the application rather than merely fail to observe.
        seen_scopes: list[str] = []

        async def app(scope, receive, send):  # type: ignore[no-untyped-def]
            seen_scopes.append(scope["type"])

        runtime = Runtime()
        runtime.start_session()
        published = events(runtime)

        import asyncio

        async def noop_receive():  # type: ignore[no-untyped-def]
            return {"type": "lifespan.startup"}

        async def noop_send(message):  # type: ignore[no-untyped-def]
            return None

        middleware = WevnaMiddleware(app, runtime=runtime)
        asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
            middleware({"type": "lifespan"}, noop_receive, noop_send)
        )

        assert seen_scopes == ["lifespan"]
        assert published == []

    def test_works_before_a_session_is_started(self) -> None:
        # The middleware may be installed before wevna.start() runs. That must
        # be a no-op, not a crash.
        runtime = Runtime()
        response = build(runtime).get("/ok")
        assert response.status_code == 200


class TestNeverBreaksTheApplication:
    def test_a_failing_publish_does_not_fail_the_request(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        runtime = Runtime()
        runtime.start_session()
        runtime.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("subscriber down")))

        with caplog.at_level(logging.ERROR):
            response = build(runtime).get("/ok")

        assert response.status_code == 200

    def test_a_route_object_without_a_path_degrades_quietly(self) -> None:
        # scope["route"] is not part of the ASGI spec, so a framework that
        # populates it differently must produce no route rather than an error.
        from wevna.asgi import _route_of

        assert _route_of({"route": object()}) is None
        assert _route_of({}) is None
        assert _route_of({"route": None}) is None
