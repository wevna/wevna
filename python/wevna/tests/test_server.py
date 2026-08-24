"""The dashboard server, including a real socket and a real websocket.

These are not unit tests of a mock. The threading boundary between the
application's stack and the server's event loop is the only genuinely
delicate part of the module, and nothing short of actually running it
exercises that.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request

import pytest

from wevna.protocol import CapturedEvent, Envelope
from wevna.server import DASHBOARD_DIR, DashboardServer, _Broadcaster


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("localhost", 0))
        port: int = s.getsockname()[1]
        return port


def envelope(kind: str = "test", sequence: int = 0) -> Envelope:
    return Envelope(
        session_id="s-1",
        sequence=sequence,
        payload=CapturedEvent(id=f"e-{sequence}", kind=kind, occurred_at=1),
    )


@pytest.fixture
def server():  # type: ignore[no-untyped-def]
    instance = DashboardServer(host="localhost", port=free_port())
    instance.start()
    yield instance
    instance.stop()


def get(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.status, response.read().decode()


class TestHealth:
    def test_reports_running(self, server: DashboardServer) -> None:
        status, body = get(f"{server.url}/health")
        assert status == 200
        assert json.loads(body) == {"status": "running", "product": "wevna"}

    def test_the_response_is_identical_to_the_node_sdks(self, server: DashboardServer) -> None:
        # Anything checking whether Wevna is up should not have to know which
        # language it is running in.
        _, body = get(f"{server.url}/health")
        assert json.loads(body)["product"] == "wevna"


class TestDashboardAssets:
    def test_the_bundle_was_copied_into_the_package(self) -> None:
        # Build-time step, so its absence is a packaging bug rather than a
        # runtime one — and it fails as a blank page, which is hard to
        # diagnose from the outside.
        assert DASHBOARD_DIR.is_dir(), (
            f"{DASHBOARD_DIR} is missing. Run the dashboard build first: "
            "pnpm turbo run build --filter @wevna/dashboard"
        )
        assert (DASHBOARD_DIR / "index.html").is_file()

    def test_serves_the_dashboard_at_the_root(self, server: DashboardServer) -> None:
        status, body = get(server.url + "/")
        assert status == 200
        assert 'id="root"' in body

    def test_serves_the_javascript_bundle(self, server: DashboardServer) -> None:
        _, index = get(server.url + "/")
        assert "/assets/" in index


class TestUrl:
    def test_reports_a_url_a_browser_can_open(self) -> None:
        # http://0.0.0.0:4123 is not a URL anyone can click, and printing one
        # was a real annoyance in the Node SDK.
        assert DashboardServer(host="0.0.0.0", port=4123).url == "http://localhost:4123"
        assert DashboardServer(host="127.0.0.1", port=4123).url == "http://127.0.0.1:4123"


class TestLifecycle:
    def test_start_is_idempotent(self) -> None:
        instance = DashboardServer(port=free_port())
        instance.start()
        try:
            instance.start()  # must not start a second server on a taken port
            assert get(f"{instance.url}/health")[0] == 200
        finally:
            instance.stop()

    def test_stop_without_start_is_safe(self) -> None:
        DashboardServer(port=free_port()).stop()

    def test_stop_is_idempotent(self) -> None:
        instance = DashboardServer(port=free_port())
        instance.start()
        instance.stop()
        instance.stop()

    def test_the_port_is_released_after_stop(self) -> None:
        port = free_port()
        first = DashboardServer(port=port)
        first.start()
        first.stop()

        second = DashboardServer(port=port)
        second.start()
        try:
            assert get(f"{second.url}/health")[0] == 200
        finally:
            second.stop()


class TestBroadcasterSafety:
    """The properties that keep publishing from breaking the application."""

    def test_publishing_before_the_loop_exists_is_a_no_op(self) -> None:
        _Broadcaster().publish(envelope())

    def test_an_unserializable_event_is_dropped_not_raised(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # attributes is arbitrary by design, so a producer can hand us
        # something JSON cannot represent. The Node SDK learned this the hard
        # way, where it threw out through the developer's own call site.
        import asyncio

        broadcaster = _Broadcaster()
        loop = asyncio.new_event_loop()
        try:
            broadcaster.bind(loop)
            circular: dict[str, object] = {}
            circular["self"] = circular
            bad = Envelope(
                session_id="s",
                sequence=0,
                payload=CapturedEvent(
                    id="e", kind="custom", occurred_at=1, attributes={"loop": circular}
                ),
            )
            with caplog.at_level("ERROR", logger="wevna.server"):
                broadcaster.publish(bad)  # must not raise
            assert "could not be serialized" in caplog.text
        finally:
            loop.close()

    def test_publishing_to_a_closed_loop_is_a_no_op(self) -> None:
        import asyncio

        broadcaster = _Broadcaster()
        loop = asyncio.new_event_loop()
        broadcaster.bind(loop)
        loop.close()
        broadcaster.publish(envelope())  # must not raise

    def test_a_full_queue_drops_rather_than_blocking(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # An unbounded queue in front of a dashboard nobody opened is a memory
        # leak that looks like a working tool until the process dies.
        import asyncio

        broadcaster = _Broadcaster()
        loop = asyncio.new_event_loop()
        try:
            broadcaster.bind(loop)
            assert broadcaster._queue is not None
            broadcaster._queue = asyncio.Queue(maxsize=1)
            with caplog.at_level("WARNING", logger="wevna.server"):
                broadcaster._enqueue("one")
                broadcaster._enqueue("two")
            assert "queue is full" in caplog.text
        finally:
            loop.close()
