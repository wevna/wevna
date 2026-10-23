"""Outgoing HTTP capture for ``requests``, against a real local HTTP server.

A real server means real redirects, real timeouts, real refused connections and
real ``requests`` exceptions, which is what the integration has to survive. The
test that matters most is the leak one: ``requests`` puts the full URL, query
string included, in its exception messages.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
import requests

from wevna import correlation
from wevna.protocol import Envelope
from wevna.requests import describe_error, instrument, instrument_all
from wevna.runtime import Runtime


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass

    def _reply(self, status: int, body: bytes = b"ok", location: str | None = None) -> None:
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/boom":
            self._reply(500, b"nope")
        elif path == "/redirect":
            self._reply(302, location="/ok")
        elif path == "/slow":
            time.sleep(1.0)
            self._reply(200)
        else:
            self._reply(200)

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self._reply(201)


@pytest.fixture(scope="module")
def server() -> Iterator[str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def runtime() -> Runtime:
    instance = Runtime()
    instance.start_session()
    return instance


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def calls(seen: list[Envelope]) -> list[dict[str, Any]]:
    return [e.payload.attributes for e in seen if e.payload.kind == "http.client"]


def closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
    return port


class TestInstrumentedSession:
    def test_publishes_method_url_status_and_duration(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        response = session.get(f"{server}/ok?page=2")

        assert response.status_code == 200
        [call] = calls(seen)
        assert call["method"] == "GET"
        assert call["url"] == f"{server}/ok?page=2"
        assert call["statusCode"] == 200
        assert call["durationMs"] >= 0
        assert "error" not in call

    def test_a_5xx_is_a_status_not_an_error(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        session.get(f"{server}/boom")

        [call] = calls(seen)
        assert call["statusCode"] == 500
        assert "error" not in call

    def test_secrets_in_the_url_are_redacted_and_credentials_dropped(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)
        host = server.removeprefix("http://")

        session.get(f"http://user:hunter2@{host}/ok?api_key=SECRET123&page=1")

        text = repr([e.payload for e in seen])
        assert "SECRET123" not in text
        assert "hunter2" not in text
        assert "page=1" in calls(seen)[0]["url"]

    def test_headers_and_bodies_are_never_recorded(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        session.post(
            f"{server}/ok",
            data=b"BODY-SECRET",
            headers={"Authorization": "Bearer HEADER-SECRET"},
            auth=("user", "AUTH-SECRET"),
        )

        text = repr([e.payload for e in seen])
        for secret in ("BODY-SECRET", "HEADER-SECRET", "AUTH-SECRET"):
            assert secret not in text

    def test_a_refused_connection_is_recorded_and_reraised(self, runtime: Runtime) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(requests.exceptions.ConnectionError):
            session.get(f"http://127.0.0.1:{closed_port()}/charge", timeout=2)

        [call] = calls(seen)
        assert "statusCode" not in call
        assert call["error"].startswith("ConnectionError")

    def test_the_error_never_contains_the_url_the_exception_message_does(
        self, runtime: Runtime
    ) -> None:
        # The reason this module does not use str(error): requests writes the
        # path and query string into its exception messages.
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)
        url = f"http://127.0.0.1:{closed_port()}/charge?api_key=SECRET123"

        with pytest.raises(requests.exceptions.ConnectionError) as raised:
            session.get(url, timeout=2)

        assert "SECRET123" in str(raised.value), "the premise: requests leaks it in its message"
        assert "SECRET123" not in repr([e.payload for e in seen])

    def test_a_timeout_is_recorded_by_class(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(requests.exceptions.ReadTimeout):
            session.get(f"{server}/slow", timeout=0.2)

        assert calls(seen)[0]["error"].startswith("ReadTimeout")

    def test_a_redirect_is_one_event_for_the_call_you_made(
        self, runtime: Runtime, server: str
    ) -> None:
        # Session.send calls itself for each hop. Reporting both would nest the
        # follow-up inside the original and count its time twice.
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        response = session.get(f"{server}/redirect")

        assert response.status_code == 200
        [call] = calls(seen)
        assert call["url"] == f"{server}/redirect"  # what you asked for
        assert call["statusCode"] == 200  # what you got
        assert call["redirects"] == 1

    def test_a_request_with_no_redirect_has_no_redirects_attribute(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        session.get(f"{server}/ok")

        assert "redirects" not in calls(seen)[0]

    def test_concurrent_requests_are_each_reported_once(
        self, runtime: Runtime, server: str
    ) -> None:
        # The nesting guard is per context, so one thread's in-progress request
        # must not suppress another thread's.
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        threads = [
            threading.Thread(target=lambda: session.get(f"{server}/redirect")) for _ in range(8)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert len(calls(seen)) == 8

    def test_ignore_hosts_keeps_a_host_out_of_the_stream(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime, ignore_hosts=["127.0.0.1"])
        seen = collect(runtime)

        session.get(f"{server}/ok")

        assert calls(seen) == []

    def test_calls_belong_to_the_current_request(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("req-1"):
            session.get(f"{server}/ok")

        [event] = [e for e in seen if e.payload.kind == "http.client"]
        assert event.payload.correlation is not None
        assert event.payload.correlation.id == "req-1"

    def test_the_response_is_returned_unchanged(self, runtime: Runtime, server: str) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)

        response = session.get(f"{server}/boom")

        assert (response.status_code, response.text) == (500, "nope")

    def test_a_streamed_response_is_reported_when_the_headers_arrive(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        response = session.get(f"{server}/ok", stream=True)

        assert calls(seen)[0]["statusCode"] == 200
        assert response.content == b"ok"

    def test_instrumenting_twice_does_not_double_the_events(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)
        instrument(session, runtime=runtime)
        seen = collect(runtime)

        session.get(f"{server}/ok")

        assert len(calls(seen)) == 1

    def test_a_failure_while_publishing_never_fails_the_request(
        self, runtime: Runtime, server: str
    ) -> None:
        session = requests.Session()
        instrument(session, runtime=runtime)

        def explode(_envelope: Envelope) -> None:
            raise RuntimeError("subscriber failed")

        runtime.subscribe(explode)

        assert session.get(f"{server}/ok").status_code == 200

    def test_an_object_without_send_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.WARNING, logger="wevna.requests"):
            instrument(object())
        assert "cannot instrument" in caplog.text

    def test_other_sessions_are_untouched(self, runtime: Runtime, server: str) -> None:
        instrument(requests.Session(), runtime=runtime)
        seen = collect(runtime)

        requests.Session().get(f"{server}/ok")

        assert calls(seen) == []


class TestInstrumentAll:
    @pytest.fixture(autouse=True)
    def restore(self) -> Iterator[None]:
        original = requests.Session.send
        yield
        requests.Session.send = original  # type: ignore[method-assign]
        import wevna.requests as module

        module._uninstall_all = None

    def test_covers_module_level_requests_get(self, runtime: Runtime, server: str) -> None:
        undo = instrument_all(runtime=runtime)
        seen = collect(runtime)
        try:
            requests.get(f"{server}/ok?token=SECRET")
        finally:
            undo()

        [call] = calls(seen)
        assert call["statusCode"] == 200
        assert "SECRET" not in repr([e.payload for e in seen])

    def test_the_undo_function_restores_the_original(self, runtime: Runtime, server: str) -> None:
        before = requests.Session.send
        undo = instrument_all(runtime=runtime)
        assert requests.Session.send is not before

        undo()

        assert requests.Session.send is before
        seen = collect(runtime)
        requests.get(f"{server}/ok")
        assert calls(seen) == []

    def test_calling_it_twice_adds_nothing(self, runtime: Runtime, server: str) -> None:
        first = instrument_all(runtime=runtime)
        second = instrument_all(runtime=runtime)
        seen = collect(runtime)
        try:
            requests.get(f"{server}/ok")
        finally:
            first()

        assert first is second
        assert len(calls(seen)) == 1

    def test_a_session_instrumented_both_ways_is_reported_once(
        self, runtime: Runtime, server: str
    ) -> None:
        undo = instrument_all(runtime=runtime)
        session = requests.Session()
        instrument(session, runtime=runtime)
        seen = collect(runtime)
        try:
            session.get(f"{server}/ok")
        finally:
            undo()

        assert len(calls(seen)) == 1

    def test_a_redirect_is_one_event_here_too(self, runtime: Runtime, server: str) -> None:
        undo = instrument_all(runtime=runtime)
        seen = collect(runtime)
        try:
            requests.get(f"{server}/redirect")
        finally:
            undo()

        [call] = calls(seen)
        assert (call["url"], call["statusCode"], call["redirects"]) == (
            f"{server}/redirect",
            200,
            1,
        )

    def test_it_reports_a_failure_and_reraises(self, runtime: Runtime) -> None:
        undo = instrument_all(runtime=runtime)
        seen = collect(runtime)
        try:
            with pytest.raises(requests.exceptions.ConnectionError):
                requests.get(f"http://127.0.0.1:{closed_port()}/x?api_key=SECRET", timeout=2)
        finally:
            undo()

        assert calls(seen)[0]["error"].startswith("ConnectionError")
        assert "SECRET" not in repr([e.payload for e in seen])


class TestDescribeError:
    def test_reports_the_class_and_the_root_cause_class(self) -> None:
        try:
            try:
                raise ConnectionRefusedError("host:1234/secret-path")
            except OSError as inner:
                raise requests.exceptions.ConnectionError("url=/x?k=SECRET") from inner
        except requests.exceptions.ConnectionError as error:
            described = describe_error(error)

        assert described == "ConnectionError (ConnectionRefusedError)"
        assert "SECRET" not in described

    def test_an_error_with_no_cause_is_just_its_class(self) -> None:
        assert describe_error(requests.exceptions.Timeout("x")) == "Timeout"

    def test_a_cyclic_chain_terminates(self) -> None:
        a, b = ValueError("a"), ValueError("b")
        a.__cause__, b.__cause__ = b, a

        assert describe_error(a).startswith("ValueError")
