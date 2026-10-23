"""The dashboard server, including a real socket and a real websocket.

These are not unit tests of a mock. The threading boundary between the
application's stack and the server's event loop is the only genuinely
delicate part of the module, and nothing short of actually running it
exercises that.
"""

from __future__ import annotations

import json
import os
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


class TestPortZero:
    """``port=0`` asks the OS for a free port. The docs promise the real one comes back."""

    def test_reports_the_port_the_os_chose_not_zero(self) -> None:
        instance = DashboardServer(port=0)
        instance.start()
        try:
            assert instance.port != 0
            assert instance.url == f"http://localhost:{instance.port}"
            assert get(f"{instance.url}/health")[0] == 200
        finally:
            instance.stop()

    def test_two_servers_on_port_zero_do_not_collide(self) -> None:
        first, second = DashboardServer(port=0), DashboardServer(port=0)
        first.start()
        second.start()
        try:
            assert first.port != second.port
        finally:
            first.stop()
            second.stop()


class _SpyLoop:
    """Stands in for the server's loop and records what is scheduled onto it."""

    def __init__(self) -> None:
        self.scheduled: list[object] = []

    def is_closed(self) -> bool:
        return False

    def call_soon_threadsafe(self, callback: object, *args: object) -> None:
        self.scheduled.append(callback)


class TestForkedWorkers:
    """The dashboard thread exists only in the process that called ``start()``.

    A pre-fork server (gunicorn, ``uvicorn --workers``) forks afterwards. The
    child inherits a copy of the loop, but the thread running it is gone — so
    every ``call_soon_threadsafe`` just appends to a deque nobody drains. Events
    vanish *and* memory grows without bound: 200k small events cost ~180 MB in a
    measurement. The right behaviour is to drop them, say why once, and cost nothing.
    """

    def test_events_from_a_different_process_are_dropped_not_queued(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        broadcaster = _Broadcaster()
        spy = _SpyLoop()
        broadcaster._loop = spy  # type: ignore[assignment]
        broadcaster._queue = object()  # type: ignore[assignment]
        broadcaster._owner_pid = -1  # "a process that is not this one"

        with caplog.at_level("WARNING", logger="wevna.server"):
            for sequence in range(1000):
                broadcaster.publish(envelope(sequence=sequence))

        assert spy.scheduled == []
        # Once, not a thousand times: a warning per event would drown the log.
        assert caplog.text.count("forked") == 1

    def test_the_owning_process_still_delivers(self) -> None:
        broadcaster = _Broadcaster()
        spy = _SpyLoop()
        broadcaster._loop = spy  # type: ignore[assignment]
        broadcaster._queue = object()  # type: ignore[assignment]
        broadcaster._owner_pid = os.getpid()

        broadcaster.publish(envelope())

        assert len(spy.scheduled) == 1

    @pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
    def test_a_really_forked_child_schedules_nothing(self) -> None:
        import warnings

        broadcaster = _Broadcaster()
        spy = _SpyLoop()
        broadcaster._loop = spy  # type: ignore[assignment]
        broadcaster._queue = object()  # type: ignore[assignment]
        broadcaster._owner_pid = os.getpid()

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # fork() in a threaded process
            pid = os.fork()
        if pid == 0:
            code = 1
            try:
                for sequence in range(1000):
                    broadcaster.publish(envelope(sequence=sequence))
                code = 0 if spy.scheduled == [] else 2
            finally:
                os._exit(code)

        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
        broadcaster.publish(envelope())  # and the parent is unaffected
        assert len(spy.scheduled) == 1


class TestWireJson:
    """What goes over the wire must be strict JSON, because the reader is JavaScript.

    Python's ``json.dumps`` writes ``NaN`` and ``Infinity`` as bare tokens by
    default. They are not JSON, and ``JSON.parse`` in the dashboard (and in the
    Node session loader) rejects the whole message, so one ``float('nan')`` in a
    duration lost the entire event. JavaScript's own ``JSON.stringify`` writes
    ``null`` for them, so that is what a Node-produced stream contains.
    """

    @staticmethod
    def _wire_text(attributes: dict[str, object]) -> str:
        import asyncio

        broadcaster = _Broadcaster()
        loop = asyncio.new_event_loop()
        try:
            broadcaster.bind(loop)
            sent: list[str] = []
            broadcaster._enqueue = sent.append  # type: ignore[assignment]
            bad = Envelope(
                session_id="s",
                sequence=0,
                payload=CapturedEvent(
                    id="e", kind="sql.query", occurred_at=1, attributes=attributes
                ),
            )
            broadcaster.publish(bad)
            loop.run_until_complete(asyncio.sleep(0.02))
            assert len(sent) == 1
            return sent[0]
        finally:
            loop.close()

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_numbers_become_null_not_invalid_json(self, value: float) -> None:
        text = self._wire_text({"durationMs": value, "rows": 3})

        def reject(token: str) -> object:
            raise AssertionError(f"not valid JSON: bare {token}")

        parsed = json.loads(text, parse_constant=reject)
        assert parsed["payload"]["attributes"] == {"durationMs": None, "rows": 3}

    def test_non_finite_numbers_nested_in_lists_and_dicts_are_found(self) -> None:
        text = self._wire_text({"timings": [1.0, float("nan")], "nested": {"x": float("inf")}})

        parsed = json.loads(text, parse_constant=lambda t: (_ for _ in ()).throw(AssertionError(t)))
        assert parsed["payload"]["attributes"] == {"timings": [1.0, None], "nested": {"x": None}}

    def test_finite_values_are_untouched(self) -> None:
        text = self._wire_text({"durationMs": 12.5, "ok": True, "name": "x", "none": None})

        attributes = json.loads(text)["payload"]["attributes"]
        assert attributes == {"durationMs": 12.5, "ok": True, "name": "x", "none": None}
