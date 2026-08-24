"""The middleware against FastAPI specifically.

FastAPI is the framework the Python SDK is aimed at, and it resolves routes
differently from bare Starlette — it records the matched route in
``scope["route"]`` where Starlette records nothing. Testing only one of them
would leave the other's path untested while appearing to cover "ASGI".
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from wevna.asgi import WevnaMiddleware
from wevna.logging_capture import install
from wevna.protocol import Envelope
from wevna.runtime import Runtime


def build(runtime: Runtime) -> TestClient:
    app = FastAPI()

    @app.get("/orders/{order_id}")
    async def read_order(order_id: int) -> dict[str, int]:
        logging.getLogger("app.fastapi").info("fetching order %s", order_id)
        return {"order_id": order_id}

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/boom")
    async def boom() -> None:
        raise ValueError("pricing failed")

    app.add_middleware(WevnaMiddleware, runtime=runtime)
    return TestClient(app, raise_server_exceptions=False)


def events(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def only(seen: list[Envelope], kind: str) -> list[Envelope]:
    return [e for e in seen if e.payload.kind == kind]


def test_captures_a_fastapi_route_pattern() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    response = build(runtime).get("/orders/42")

    assert response.status_code == 200
    attributes = only(seen, "http.request")[0].payload.attributes
    assert attributes["route"] == "/orders/{order_id}"
    assert attributes["url"] == "/orders/42"
    assert attributes["statusCode"] == 200
    assert attributes["method"] == "GET"


def test_a_route_with_no_parameters_reports_its_own_path() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    build(runtime).get("/health")

    assert only(seen, "http.request")[0].payload.attributes["route"] == "/health"


def test_logs_inside_a_handler_join_the_request() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    logger = logging.getLogger("app.fastapi")
    logger.setLevel(logging.INFO)
    uninstall = install(runtime.publish, logger)
    try:
        build(runtime).get("/orders/7")
    finally:
        uninstall()

    logs = only(seen, "log.record")
    requests = only(seen, "http.request")
    assert logs and requests
    assert logs[0].payload.correlation is not None
    assert requests[0].payload.correlation is not None
    assert logs[0].payload.correlation.id == requests[0].payload.correlation.id


def test_a_raising_endpoint_is_captured_and_still_500s() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    response = build(runtime).get("/boom")

    assert response.status_code == 500
    exceptions = only(seen, "exception.captured")
    assert exceptions[0].payload.attributes["name"] == "ValueError"
    assert exceptions[0].payload.attributes["message"] == "pricing failed"


def test_validation_failures_are_reported_with_their_status() -> None:
    # order_id is typed int, so a non-numeric path segment is a 422 raised
    # inside FastAPI rather than in the handler. It should be observed as an
    # ordinary request with its real status, not as an exception.
    runtime = Runtime()
    runtime.start_session()
    seen = events(runtime)

    response = build(runtime).get("/orders/not-a-number")

    assert response.status_code == 422
    requests = only(seen, "http.request")
    assert requests[0].payload.attributes["statusCode"] == 422
    assert only(seen, "exception.captured") == []
