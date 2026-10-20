"""Cross-site access to the dashboard server.

The unit tests pin the decision logic; the socket tests at the bottom are the
ones that matter, because the attack is a *browser-shaped* connection: a real
WebSocket upgrade carrying an ``Origin`` header, and a real HTTP request under
a rebound ``Host``. These mirror the Node SDK's tests of the same name.
"""

from __future__ import annotations

import http.client
import socket
import time

import pytest
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect
from websockets.typing import Origin

from wevna.host_guard import (
    allowed_hosts_for,
    hostname_of,
    is_allowed_host,
    is_allowed_origin,
)
from wevna.protocol import CapturedEvent, Envelope
from wevna.server import DashboardServer

LOCAL = allowed_hosts_for("localhost")


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("localhost:4123", "localhost"),
        ("LOCALHOST", "localhost"),
        ("127.0.0.1:80", "127.0.0.1"),
        ("[::1]:4123", "::1"),
        ("[::1]", "::1"),
        ("::1", "::1"),
        ("evil.example.com:4123", "evil.example.com"),
    ],
)
def test_hostname_of(header: str, expected: str) -> None:
    assert hostname_of(header) == expected


class TestAllowedHosts:
    def test_loopback_only_by_default(self) -> None:
        assert allowed_hosts_for("localhost") == ("localhost", "127.0.0.1", "::1")

    def test_adds_a_host_the_operator_bound_to(self) -> None:
        assert "devbox.internal" in allowed_hosts_for("devbox.internal")

    @pytest.mark.parametrize("bind", ["0.0.0.0", "::", ""])
    def test_allows_anything_when_bound_to_every_interface(self, bind: str) -> None:
        assert allowed_hosts_for(bind) == ("*",)


class TestIsAllowedHost:
    def test_accepts_loopback_and_refuses_anything_else(self) -> None:
        assert is_allowed_host("localhost:4123", LOCAL)
        assert not is_allowed_host("evil.example.com", LOCAL)

    @pytest.mark.parametrize("lookalike", ["localhost.evil.com", "127.0.0.1.evil.com"])
    def test_a_lookalike_does_not_pass_a_prefix_check(self, lookalike: str) -> None:
        assert not is_allowed_host(lookalike, LOCAL)

    def test_a_request_with_no_host_is_not_a_browser(self) -> None:
        assert is_allowed_host(None, LOCAL)


class TestIsAllowedOrigin:
    def test_no_origin_means_a_non_browser_client(self) -> None:
        assert is_allowed_origin(None, LOCAL)

    @pytest.mark.parametrize(
        "origin", ["http://localhost:4123", "http://127.0.0.1:5173", "http://[::1]:3000"]
    )
    def test_accepts_a_local_origin_on_any_port(self, origin: str) -> None:
        assert is_allowed_origin(origin, LOCAL)

    @pytest.mark.parametrize(
        "origin",
        ["https://evil.example.com", "https://localhost.evil.com", "null", "not a url", ""],
    )
    def test_refuses_a_foreign_sandboxed_or_malformed_origin(self, origin: str) -> None:
        assert not is_allowed_origin(origin, LOCAL)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("localhost", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture
def server():  # type: ignore[no-untyped-def]
    instance = DashboardServer(host="localhost", port=free_port())
    instance.start()
    yield instance
    instance.stop()


def request_with_host(port: int, host: str, path: str = "/health") -> int:
    # http.client, not urllib: it lets the Host header be set to anything, which
    # is the request a rebinding page's browser sends.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest("GET", path, skip_host=True)
        connection.putheader("Host", host)
        connection.endheaders()
        return connection.getresponse().status
    finally:
        connection.close()


def secret_envelope() -> Envelope:
    return Envelope(
        session_id="s",
        sequence=0,
        payload=CapturedEvent(
            id="e", kind="sql.query", occurred_at=1, attributes={"query": "select secret"}
        ),
    )


class TestRealSockets:
    def test_a_rebound_hostname_is_refused_on_every_route(self, server: DashboardServer) -> None:
        for path in ("/health", "/"):
            assert request_with_host(server.port, "evil.example.com", path) == 403

    def test_a_local_host_still_works(self, server: DashboardServer) -> None:
        assert request_with_host(server.port, f"localhost:{server.port}") == 200

    def test_a_foreign_origin_websocket_is_refused_before_it_opens(
        self, server: DashboardServer
    ) -> None:
        with pytest.raises(InvalidStatus) as refused:
            connect(f"ws://localhost:{server.port}/ws", origin=Origin("https://evil.example.com"))

        assert refused.value.response.status_code == 403

    def test_a_foreign_origin_never_receives_the_event_stream(
        self, server: DashboardServer
    ) -> None:
        with pytest.raises(InvalidStatus):
            connect(f"ws://localhost:{server.port}/ws", origin=Origin("https://evil.example.com"))
        time.sleep(0.1)

        server.broadcaster.publish(secret_envelope())

        assert server.broadcaster.client_count == 0

    @pytest.mark.parametrize("origin", [None, "http://localhost"])
    def test_the_dashboards_own_origin_and_scripts_still_stream(
        self, server: DashboardServer, origin: str | None
    ) -> None:
        sent = Origin(f"{origin}:{server.port}") if origin else None
        with connect(f"ws://localhost:{server.port}/ws", origin=sent, open_timeout=5) as ws:
            deadline = time.time() + 2
            while server.broadcaster.client_count == 0 and time.time() < deadline:
                time.sleep(0.02)
            server.broadcaster.publish(secret_envelope())
            assert "select secret" in str(ws.recv(timeout=3))
