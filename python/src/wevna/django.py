"""Django integration: the route pattern, which only Django's resolver knows.

Add after the WSGI/ASGI wrapper is in place (see the README), and list the
middleware in settings:

    MIDDLEWARE = ["wevna.django.WevnaDjangoMiddleware", ...]

It records `articles/<int:pk>/` rather than `/articles/17/`, so requests group
by endpoint. Django itself is never imported here.
"""

from __future__ import annotations

from typing import Any, Callable

from ._context import set_route


class WevnaDjangoMiddleware:
    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        return self.get_response(request)

    def process_view(self, request: Any, view_func: Any, view_args: Any, view_kwargs: Any) -> None:
        match = getattr(request, "resolver_match", None)
        route = getattr(match, "route", None)
        if isinstance(route, str) and route:
            set_route(route if route.startswith("/") else "/" + route)
        return None
