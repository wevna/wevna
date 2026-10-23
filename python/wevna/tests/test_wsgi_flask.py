"""WSGI middleware plus ``wevna.flask``, against real Flask."""

from __future__ import annotations

from collections.abc import Iterator

import flask
import pytest
from wsgi_helpers import collect, kinds

import wevna.flask as wevna_flask
from wevna.protocol import CapturedEvent, Envelope
from wevna.runtime import Runtime
from wevna.wsgi import WevnaMiddleware


def build() -> tuple[flask.Flask, Runtime, list[Envelope]]:
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)
    app = flask.Flask(__name__)
    app.config["PROPAGATE_EXCEPTIONS"] = False
    app.wsgi_app = WevnaMiddleware(app.wsgi_app, runtime)  # type: ignore[method-assign]
    wevna_flask.instrument(app, runtime)

    @app.route("/orders/<int:order_id>")
    def order(order_id: int) -> str:
        runtime.publish(CapturedEvent(id="q", kind="sql.query", occurred_at=1))
        return f"order {order_id}"

    @app.route("/stream")
    def stream() -> flask.Response:
        def generate() -> Iterator[str]:
            yield "a"
            runtime.publish(CapturedEvent(id="q2", kind="sql.query", occurred_at=1))
            yield "b"

        return flask.Response(flask.stream_with_context(generate()))

    @app.route("/boom")
    def boom() -> str:
        raise RuntimeError("handler failed")

    @app.route("/gone")
    def gone() -> str:
        flask.abort(404)

    return app, runtime, seen


def get(app: flask.Flask, path: str) -> int:
    # Read the body, then close it: what a real server does, and what ends the
    # request. (The test client does not pull a streamed body unless asked.)
    with app.test_client().get(path) as response:
        response.get_data()
        return int(response.status_code)


def requests_of(seen: list[Envelope]) -> list[CapturedEvent]:
    return [e.payload for e in seen if e.payload.kind == "http.request"]


def test_the_route_pattern_groups_requests_to_one_endpoint() -> None:
    app, _, seen = build()

    get(app, "/orders/1")
    get(app, "/orders/2")

    first, second = requests_of(seen)
    assert first.attributes["route"] == second.attributes["route"] == "/orders/<int:order_id>"
    assert first.attributes["url"] == "/orders/1"
    assert second.attributes["url"] == "/orders/2"


def test_queries_in_a_view_are_correlated_with_the_request() -> None:
    app, _, seen = build()

    get(app, "/orders/1")

    sql = next(e.payload for e in seen if e.payload.kind == "sql.query")
    [request] = requests_of(seen)
    assert sql.correlation is not None
    assert sql.correlation == request.correlation


def test_a_streamed_response_keeps_its_correlation() -> None:
    app, _, seen = build()

    get(app, "/stream")

    sql = next(e.payload for e in seen if e.payload.kind == "sql.query")
    [request] = requests_of(seen)
    assert sql.correlation == request.correlation


def test_an_unhandled_exception_is_reported_even_though_flask_hides_it_as_a_500() -> None:
    app, _, seen = build()

    status = get(app, "/boom")

    assert status == 500
    exception = next(e.payload for e in seen if e.payload.kind == "exception.captured")
    assert exception.attributes["name"] == "RuntimeError"
    assert exception.attributes["message"] == "handler failed"
    assert exception.attributes["framework"] == "flask"
    [request] = requests_of(seen)
    assert request.attributes["statusCode"] == 500
    assert exception.correlation == request.correlation


def test_a_deliberate_abort_is_not_reported_as_an_exception() -> None:
    app, _, seen = build()

    assert get(app, "/gone") == 404

    assert "exception.captured" not in kinds(seen)
    [request] = requests_of(seen)
    assert request.attributes["statusCode"] == 404


def test_an_unknown_url_has_no_route_and_still_records_the_request() -> None:
    app, _, seen = build()

    assert get(app, "/nope") == 404

    [request] = requests_of(seen)
    assert "route" not in request.attributes
    assert request.attributes["url"] == "/nope"


def test_the_query_string_is_not_recorded() -> None:
    app, _, seen = build()

    get(app, "/orders/1?api_key=SECRET")

    assert "SECRET" not in repr([e.payload for e in seen])


def test_a_propagated_exception_is_reported_once_not_twice() -> None:
    # Debug mode (and TESTING) propagate the exception out of Flask, so the
    # middleware sees it after the Flask hook already reported it.
    app, _, seen = build()
    app.config["PROPAGATE_EXCEPTIONS"] = True

    with pytest.raises(RuntimeError):
        get(app, "/boom")

    assert kinds(seen).count("exception.captured") == 1
    [request] = requests_of(seen)
    assert request.attributes["statusCode"] == 500
