"""Django integration: the route pattern, and exceptions Django handles itself.

    # settings.py
    MIDDLEWARE = ["wevna.django.WevnaDjangoMiddleware", ...]

    # wsgi.py
    application = WevnaMiddleware(get_wsgi_application())

``WevnaMiddleware`` captures the request. This adds what only Django knows: the
matched route (``articles/<int:pk>/``) so requests group by endpoint, and the
exception behind a 500, which Django converts into a response before the WSGI
layer can see it.

It records the route on ``request.META``, which under a WSGI server *is* the
WSGI ``environ`` the middleware reads. Under ASGI, Django's ``META`` is a separate
dict, so there is no route to share and ``wevna.asgi.WevnaMiddleware`` is the
tool to use there. Django itself is never imported here.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from wevna.runtime import default_runtime
from wevna.wsgi import REPORTED_KEY, ROUTE_KEY, publish_exception


class WevnaDjangoMiddleware:
    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        return self.get_response(request)

    def process_view(self, request: Any, view_func: Any, view_args: Any, view_kwargs: Any) -> None:
        match = getattr(request, "resolver_match", None)
        route = getattr(match, "route", None)
        if isinstance(route, str) and route:
            request.META[ROUTE_KEY] = route if route.startswith("/") else "/" + route

    def process_exception(self, request: Any, exception: Exception) -> None:
        publish_exception(default_runtime(), exception, framework="django")
        # With DEBUG_PROPAGATE_EXCEPTIONS the exception continues up to the
        # middleware, which would report it again.
        request.META[REPORTED_KEY] = True
