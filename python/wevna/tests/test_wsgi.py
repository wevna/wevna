"""The WSGI middleware, against hand-written WSGI applications.

WSGI is a synchronous, iterator-based interface, and the awkward parts are all
about *when* things happen: the body is pulled after the application has
returned, a server may close a response it never finished reading, and one
thread may be partway through several responses. These tests are about those
properties, not about any one framework (see test_wsgi_flask.py and
test_wsgi_django.py for those).
"""

from __future__ import annotations

import http.client
import socketserver
import threading
import time
from collections.abc import Iterator
from typing import Any
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

import pytest
from wsgi_helpers import Call, collect, kinds, make_environ, run

from wevna import correlation
from wevna.protocol import CapturedEvent, Envelope
from wevna.runtime import Runtime
from wevna.wsgi import REPORTED_KEY, ROUTE_KEY, WevnaMiddleware


def make() -> tuple[Runtime, list[Envelope]]:
    runtime = Runtime()
    runtime.start_session()
    return runtime, collect(runtime)


def request_event(envelopes: list[Envelope]) -> CapturedEvent:
    [event] = [e.payload for e in envelopes if e.payload.kind == "http.request"]
    return event


def simple_app(status: str = "200 OK", body: list[bytes] | None = None) -> Any:
    def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
        start_response(status, [("Content-Type", "text/plain")])
        return body if body is not None else [b"ok"]

    return app


class TestRequestEvent:
    def test_publishes_an_http_request_with_method_path_status_and_duration(self) -> None:
        runtime, seen = make()

        status, body = run(
            WevnaMiddleware(simple_app("201 Created"), runtime), "/orders/42", "POST"
        )

        assert (status, body) == ("201 Created", b"ok")
        attributes = request_event(seen).attributes
        assert attributes["method"] == "POST"
        assert attributes["url"] == "/orders/42"
        assert attributes["statusCode"] == 201
        assert attributes["durationMs"] >= 0

    def test_the_query_string_is_never_recorded(self) -> None:
        runtime, seen = make()

        run(WevnaMiddleware(simple_app(), runtime), "/search", query="token=SECRET&q=books")

        assert "SECRET" not in repr([e.payload for e in seen])

    def test_script_name_is_part_of_the_path(self) -> None:
        runtime, seen = make()
        middleware = WevnaMiddleware(simple_app(), runtime)
        environ_call = Call(middleware, "/x")  # warm: ensure no crash on defaults
        environ_call.read()
        seen.clear()

        def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
            environ["SCRIPT_NAME"] = "/mounted"
            start_response("200 OK", [])
            return []

        run(WevnaMiddleware(app, runtime), "/inner")

        assert request_event(seen).attributes["url"] == "/mounted/inner"

    def test_the_route_comes_from_the_environ_key_a_framework_sets(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
            environ[ROUTE_KEY] = "/orders/<int:id>"
            start_response("200 OK", [])
            return [b""]

        run(WevnaMiddleware(app, runtime), "/orders/7")

        assert request_event(seen).attributes["route"] == "/orders/<int:id>"

    def test_no_route_attribute_when_no_framework_provided_one(self) -> None:
        runtime, seen = make()
        run(WevnaMiddleware(simple_app(), runtime), "/x")
        assert "route" not in request_event(seen).attributes

    def test_the_response_reaches_the_server_unchanged(self) -> None:
        runtime, _ = make()
        call = Call(WevnaMiddleware(simple_app("404 Not Found", [b"a", b"b"]), runtime), "/missing")

        assert call.read() == b"ab"
        assert call.status == "404 Not Found"
        assert call.headers == [("Content-Type", "text/plain")]

    def test_a_sized_body_keeps_its_length_so_the_server_can_set_content_length(
        self,
    ) -> None:
        # wsgiref and gunicorn set Content-Length from len(body) for a one-item
        # list. Hiding len() would change the headers the client receives.
        runtime, _ = make()
        sized = WevnaMiddleware(simple_app(body=[b"hello"]), runtime)(
            make_environ(), lambda *_: None
        )
        unsized = WevnaMiddleware(lambda e, s: iter([b"x"]), runtime)(
            make_environ(), lambda *_: None
        )

        assert len(sized) == 1  # type: ignore[arg-type]
        assert not hasattr(unsized, "__len__")

    def test_a_framework_that_reported_the_exception_is_not_reported_twice(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
            environ[REPORTED_KEY] = True  # what wevna.flask and wevna.django do
            raise RuntimeError("already reported by the framework hook")

        with pytest.raises(RuntimeError):
            run(WevnaMiddleware(app, runtime), "/x")

        assert "exception.captured" not in kinds(seen)
        assert request_event(seen).attributes["statusCode"] == 500

    def test_a_failure_to_publish_never_reaches_the_application(self) -> None:
        class BrokenRuntime:
            def publish(self, event: Any) -> None:
                raise RuntimeError("the dashboard is on fire")

        status, body = run(WevnaMiddleware(simple_app(), BrokenRuntime()), "/x")  # type: ignore[arg-type]

        assert (status, body) == ("200 OK", b"ok")


class TestExceptions:
    def test_an_exception_before_the_response_is_published_and_reraised_as_a_500(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
            raise ValueError("boom")

        with pytest.raises(ValueError, match="boom"):
            Call(WevnaMiddleware(app, runtime), "/x")

        assert kinds(seen) == ["exception.captured", "http.request"]
        exception = seen[0].payload.attributes
        assert (exception["name"], exception["message"], exception["framework"]) == (
            "ValueError",
            "boom",
            "wsgi",
        )
        assert "Traceback" in exception["stack"]
        assert seen[1].payload.attributes["statusCode"] == 500
        assert seen[0].payload.correlation == seen[1].payload.correlation

    def test_an_exception_while_streaming_keeps_the_status_the_client_already_got(self) -> None:
        runtime, seen = make()
        closed: list[bool] = []

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])

            def body() -> Iterator[bytes]:
                try:
                    yield b"first"
                    raise RuntimeError("mid-stream")
                finally:
                    closed.append(True)

            return body()

        call = Call(WevnaMiddleware(app, runtime), "/stream")
        with pytest.raises(RuntimeError, match="mid-stream"):
            call.read()

        assert kinds(seen) == ["exception.captured", "http.request"]
        # The headers had been sent as 200 before it failed. Reporting 500 would
        # describe a response the client never received.
        assert request_event(seen).attributes["statusCode"] == 200
        assert closed == [True]


class TestEndOfRequest:
    def test_the_event_is_published_when_the_body_ends_not_when_the_app_returns(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])
            yield b"a"
            yield b"b"

        call = Call(WevnaMiddleware(app, runtime), "/x")
        assert kinds(seen) == []  # returned, but the server has pulled nothing yet

        iterator = iter(call.body)
        next(iterator)
        assert kinds(seen) == []  # still streaming
        list(iterator)  # exhaust
        assert kinds(seen) == ["http.request"]

    def test_the_duration_includes_the_time_spent_streaming(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])
            time.sleep(0.05)
            yield b"slow"

        run(WevnaMiddleware(app, runtime), "/x")

        assert request_event(seen).attributes["durationMs"] >= 45

    def test_exhausting_and_then_closing_publishes_once(self) -> None:
        runtime, seen = make()
        run(WevnaMiddleware(simple_app(), runtime), "/x")  # read() exhausts, then closes
        assert kinds(seen).count("http.request") == 1

    def test_closing_a_body_that_was_never_read_still_publishes_and_closes_the_app(self) -> None:
        runtime, seen = make()
        closed: list[bool] = []

        class Body:
            def __iter__(self) -> Iterator[bytes]:
                yield b"never read"

            def close(self) -> None:
                closed.append(True)

        def app(environ: dict[str, Any], start_response: Any) -> Body:
            start_response("200 OK", [])
            return Body()

        call = Call(WevnaMiddleware(app, runtime), "/x")
        call.body.close()  # type: ignore[attr-defined]

        # WSGI requires the server to call close(), and requires us to pass it on,
        # or the application's own cleanup is skipped.
        assert closed == [True]
        assert kinds(seen) == ["http.request"]

    def test_a_generator_body_abandoned_part_way_runs_its_own_cleanup(self) -> None:
        runtime, seen = make()
        cleaned: list[bool] = []

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])

            def body() -> Iterator[bytes]:
                try:
                    yield b"1"
                    yield b"2"
                finally:
                    cleaned.append(True)

            return body()

        call = Call(WevnaMiddleware(app, runtime), "/x")
        next(iter(call.body))
        call.body.close()  # type: ignore[attr-defined]  # a client that disconnected

        assert cleaned == [True]
        assert kinds(seen) == ["http.request"]

    def test_an_empty_body_ends_the_request(self) -> None:
        runtime, seen = make()
        run(WevnaMiddleware(simple_app("204 No Content", []), runtime), "/x")
        assert request_event(seen).attributes["statusCode"] == 204

    def test_start_response_exc_info_and_write_are_passed_through(self) -> None:
        runtime, _ = make()
        received: dict[str, Any] = {}

        def server_start_response(status: str, headers: list[Any], exc_info: Any = None) -> Any:
            received.update(status=status, exc_info=exc_info)
            return lambda data: received.setdefault("written", []).append(data)

        def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
            marker = (ValueError, ValueError("x"), None)
            write = start_response("500 Error", [], marker)
            write(b"via write()")
            return []

        from wsgi_helpers import make_environ

        list(WevnaMiddleware(app, runtime)(make_environ("/x"), server_start_response))

        assert received["exc_info"][0] is ValueError
        assert received["written"] == [b"via write()"]


class TestCorrelation:
    def test_work_done_while_the_body_streams_belongs_to_the_request(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])
            # Runs when the *server* pulls the body, after the app returned.
            runtime.publish(CapturedEvent(id="q", kind="sql.query", occurred_at=1))
            yield b"x"

        run(WevnaMiddleware(app, runtime), "/x")

        sql = next(e.payload for e in seen if e.payload.kind == "sql.query")
        assert sql.correlation is not None
        assert sql.correlation == request_event(seen).correlation

    def test_interleaved_responses_each_keep_their_own_correlation(self) -> None:
        # One thread, two responses, pulled alternately: the case that breaks
        # anything keeping the correlation in thread-local or in a with-block.
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [])
            name = environ["PATH_INFO"]

            def body() -> Iterator[bytes]:
                for step in range(3):
                    runtime.publish(
                        CapturedEvent(
                            id=f"{name}{step}",
                            kind="sql.query",
                            occurred_at=1,
                            attributes={"for": name},
                        )
                    )
                    yield b"."

            return body()

        middleware = WevnaMiddleware(app, runtime)
        first, second = Call(middleware, "/a"), Call(middleware, "/b")
        a, b = iter(first.body), iter(second.body)
        for _ in range(3):
            next(a)
            next(b)
        for response in (a, b):
            list(response)
        first.body.close()  # type: ignore[attr-defined]
        second.body.close()  # type: ignore[attr-defined]

        ids: dict[str, set[str]] = {"/a": set(), "/b": set()}
        for envelope in seen:
            if envelope.payload.kind == "sql.query":
                assert envelope.payload.correlation is not None
                ids[envelope.payload.attributes["for"]].add(envelope.payload.correlation.id)
        assert {len(v) for v in ids.values()} == {1}, ids
        assert ids["/a"] != ids["/b"]

    def test_the_correlation_does_not_leak_into_the_callers_context(self) -> None:
        runtime, _ = make()
        run(WevnaMiddleware(simple_app(), runtime), "/x")
        assert correlation.current() is None

    def test_separate_requests_get_separate_ids(self) -> None:
        runtime, seen = make()
        middleware = WevnaMiddleware(simple_app(), runtime)
        run(middleware, "/1")
        run(middleware, "/2")

        ids = {e.payload.correlation.id for e in seen if e.payload.correlation}
        assert len(ids) == 2


class TestRealThreadedServer:
    """A real HTTP server with a thread per request, under concurrent load."""

    class ThreadingServer(socketserver.ThreadingMixIn, WSGIServer):
        daemon_threads = True

    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

    def test_concurrent_requests_stay_separate_and_ordered(self) -> None:
        runtime, seen = make()

        def app(environ: dict[str, Any], start_response: Any) -> Iterator[bytes]:
            start_response("200 OK", [("Content-Type", "text/plain")])
            path = environ["PATH_INFO"]

            def body() -> Iterator[bytes]:
                for step in range(3):
                    runtime.publish(
                        CapturedEvent(
                            id=f"{path}-{step}",
                            kind="sql.query",
                            occurred_at=1,
                            attributes={"path": path, "step": step},
                        )
                    )
                    time.sleep(0.001)
                    yield b"x"

            return body()

        server = make_server(
            "127.0.0.1",
            0,
            WevnaMiddleware(app, runtime),
            server_class=self.ThreadingServer,
            handler_class=self.QuietHandler,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_port
        requests = 30

        def hit(index: int) -> None:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            connection.request("GET", f"/r{index}")
            assert connection.getresponse().read() == b"xxx"
            connection.close()

        try:
            workers = [threading.Thread(target=hit, args=(i,)) for i in range(requests)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=30)
            deadline = time.time() + 5
            while (
                sum(1 for e in seen if e.payload.kind == "http.request") < requests
                and time.time() < deadline
            ):
                time.sleep(0.02)
        finally:
            server.shutdown()
            server.server_close()

        by_path: dict[str, set[str]] = {}
        for envelope in seen:
            payload = envelope.payload
            if payload.kind == "sql.query":
                assert payload.correlation is not None
                by_path.setdefault(payload.attributes["path"], set()).add(payload.correlation.id)
        requests_by_id = {
            e.payload.correlation.id: e.payload.attributes["url"]
            for e in seen
            if e.payload.kind == "http.request" and e.payload.correlation
        }

        assert len(requests_by_id) == requests
        assert len(by_path) == requests
        for path, ids in by_path.items():
            assert len(ids) == 1, f"{path} was split across correlations: {ids}"
            assert requests_by_id[next(iter(ids))] == path
        sequences = [e.sequence for e in seen]
        assert len(set(sequences)) == len(sequences)
        assert sequences == sorted(sequences)
        assert sum(1 for e in seen if e.payload.kind == "sql.query") == requests * 3
