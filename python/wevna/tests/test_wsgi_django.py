"""WSGI middleware plus ``wevna.django``, against real Django."""

from __future__ import annotations

from typing import Any

import pytest
from django.conf import settings
from django.http import HttpResponse
from django.urls import path
from wsgi_helpers import Call, collect, kinds

from wevna.protocol import CapturedEvent, Envelope
from wevna.runtime import Runtime, default_runtime, reset_default_runtime
from wevna.wsgi import WevnaMiddleware


def order(request: Any, order_id: int) -> HttpResponse:
    default_runtime().publish(CapturedEvent(id="q", kind="sql.query", occurred_at=1))
    return HttpResponse(f"order {order_id}")


def boom(request: Any) -> HttpResponse:
    raise RuntimeError("view failed")


urlpatterns = [
    path("orders/<int:order_id>/", order),
    path("boom/", boom),
]

if not settings.configured:
    settings.configure(
        DEBUG=False,
        SECRET_KEY="test-only",
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["*"],
        MIDDLEWARE=["wevna.django.WevnaDjangoMiddleware"],
        USE_TZ=True,
    )


@pytest.fixture
def stack() -> Any:
    from django.core.wsgi import get_wsgi_application

    reset_default_runtime()
    runtime = default_runtime()
    runtime.start_session()
    seen = collect(runtime)
    app = WevnaMiddleware(get_wsgi_application(), runtime)
    yield app, runtime, seen
    reset_default_runtime()


def requests_of(seen: list[Envelope]) -> list[CapturedEvent]:
    return [e.payload for e in seen if e.payload.kind == "http.request"]


def test_the_route_pattern_is_recorded_with_a_leading_slash(
    stack: tuple[WevnaMiddleware, Runtime, list[Envelope]],
) -> None:
    app, _, seen = stack

    Call(app, "/orders/7/").read()

    [request] = requests_of(seen)
    assert request.attributes["route"] == "/orders/<int:order_id>/"
    assert request.attributes["url"] == "/orders/7/"
    assert request.attributes["statusCode"] == 200


def test_queries_in_a_view_are_correlated_with_the_request(
    stack: tuple[WevnaMiddleware, Runtime, list[Envelope]],
) -> None:
    app, _, seen = stack

    Call(app, "/orders/7/").read()

    sql = next(e.payload for e in seen if e.payload.kind == "sql.query")
    [request] = requests_of(seen)
    assert sql.correlation is not None
    assert sql.correlation == request.correlation


def test_an_exception_django_turns_into_a_500_is_still_reported(
    stack: tuple[WevnaMiddleware, Runtime, list[Envelope]],
) -> None:
    app, _, seen = stack

    call = Call(app, "/boom/")
    call.read()

    assert call.status.startswith("500")
    exception = next(e.payload for e in seen if e.payload.kind == "exception.captured")
    assert exception.attributes["message"] == "view failed"
    assert exception.attributes["framework"] == "django"
    [request] = requests_of(seen)
    assert request.attributes["statusCode"] == 500
    assert exception.correlation == request.correlation


def test_an_unknown_url_records_a_404_with_no_route(
    stack: tuple[WevnaMiddleware, Runtime, list[Envelope]],
) -> None:
    app, _, seen = stack

    call = Call(app, "/missing/")
    call.read()

    assert call.status.startswith("404")
    [request] = requests_of(seen)
    assert "route" not in request.attributes
    assert kinds(seen).count("exception.captured") == 0
