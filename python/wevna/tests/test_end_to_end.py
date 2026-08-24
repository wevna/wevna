"""A real FastAPI app, a real dashboard, a real websocket.

This is the test that says the Python SDK works. Everything else verifies a
part; this one drives a request through an application and asserts that a
browser connected to the dashboard would have seen it — over an actual socket,
across the thread boundary, in the wire format the TypeScript dashboard parses.
"""

from __future__ import annotations

import json
import logging
import socket
from collections.abc import Iterator
from typing import Any

import pytest
import uvicorn
from fastapi import FastAPI
from websockets.sync.client import connect

import wevna
from wevna.asgi import WevnaMiddleware
from wevna.runtime import Runtime, reset_default_runtime


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("localhost", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture(autouse=True)
def clean_runtime() -> Iterator[None]:
    # Without this, a session left running by one test leaks into the next and
    # the resulting failures are ordering-dependent.
    reset_default_runtime()
    yield
    wevna.stop()
    reset_default_runtime()


def test_a_request_reaches_a_websocket_client() -> None:
    dashboard_port = free_port()
    app_port = free_port()

    result = wevna.start(port=dashboard_port)
    assert result.url == f"http://localhost:{dashboard_port}"

    app = FastAPI()

    @app.get("/orders/{order_id}")
    async def read_order(order_id: int) -> dict[str, int]:
        logging.getLogger("app.e2e").warning("slow lookup for %s", order_id)
        return {"order_id": order_id}

    app.add_middleware(WevnaMiddleware)

    config = uvicorn.Config(app, host="localhost", port=app_port, log_level="error")
    server = uvicorn.Server(config)

    import threading

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(250):
        if server.started:
            break
        threading.Event().wait(0.02)
    assert server.started, "the application under test did not start"

    received: list[dict[str, Any]] = []
    try:
        # Connect first: the dashboard streams live, so an event published
        # before a client attaches is not delivered to it.
        with connect(f"ws://localhost:{dashboard_port}/ws", open_timeout=5) as ws:
            import urllib.request

            with urllib.request.urlopen(
                f"http://localhost:{app_port}/orders/42", timeout=5
            ) as response:
                assert response.status == 200

            # One http.request and one log.record are expected.
            for _ in range(2):
                received.append(json.loads(ws.recv(timeout=5)))
    finally:
        server.should_exit = True
        thread.join(timeout=5)

    kinds = {message["payload"]["kind"] for message in received}
    assert "http.request" in kinds
    assert "log.record" in kinds

    # Every message is a protocol envelope, in the shape the dashboard parses.
    for message in received:
        assert message["version"] == wevna.PROTOCOL_VERSION
        assert message["sessionId"] == result.session_id
        assert isinstance(message["sequence"], int)

    # And the request and its log share one correlation, which is the entire
    # feature: the dashboard groups them under the same request because of it.
    correlations = {
        message["payload"]["correlation"]["id"]
        for message in received
        if "correlation" in message["payload"]
    }
    assert len(correlations) == 1, received

    request_event = next(m for m in received if m["payload"]["kind"] == "http.request")
    attributes = request_event["payload"]["attributes"]
    assert attributes["route"] == "/orders/{order_id}"
    assert attributes["statusCode"] == 200
    assert attributes["method"] == "GET"
    assert attributes["durationMs"] > 0

    log_event = next(m for m in received if m["payload"]["kind"] == "log.record")
    assert log_event["payload"]["attributes"]["message"] == "slow lookup for 42"
    assert log_event["payload"]["attributes"]["level"] == "WARNING"


def test_start_is_idempotent_and_returns_the_same_session() -> None:
    port = free_port()
    first = wevna.start(port=port)
    second = wevna.start(port=port)
    assert first.session_id == second.session_id
    assert first.url == second.url


def test_stop_then_start_again() -> None:
    port = free_port()
    wevna.start(port=port)
    wevna.stop()
    assert not wevna.is_running()
    assert wevna.url() is None

    again = wevna.start(port=free_port())
    assert wevna.is_running()
    assert again.session_id


def test_stop_removes_log_capture() -> None:
    runtime = Runtime()
    wevna.start(port=free_port(), runtime=runtime)
    seen: list[Any] = []
    runtime.subscribe(seen.append)
    wevna.stop(runtime=runtime)

    logging.getLogger("app.after.stop").warning("should not be captured")
    assert seen == []


def test_stop_without_start_is_safe() -> None:
    wevna.stop()
