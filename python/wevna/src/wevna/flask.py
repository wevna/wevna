"""Flask integration: the route pattern, and exceptions Flask handles itself.

    app.wsgi_app = WevnaMiddleware(app.wsgi_app)
    wevna.flask.instrument(app)

``WevnaMiddleware`` captures the request. This adds the two things only Flask
knows. The matched rule (``/orders/<int:order_id>``) is recorded so requests to
one endpoint group as one route, and an unhandled exception is published, because
Flask turns it into a 500 response before the middleware, which only sees the
finished response, could notice anything was raised.

Flask is imported lazily, so installing ``wevna`` does not require it.
"""

from __future__ import annotations

from typing import Any

from wevna.runtime import default_runtime
from wevna.wsgi import REPORTED_KEY, ROUTE_KEY, publish_exception


def instrument(app: Any, runtime: Any = None) -> None:
    from flask import got_request_exception, has_request_context, request

    def record_route() -> None:
        rule = request.url_rule
        if rule is not None:
            request.environ[ROUTE_KEY] = rule.rule

    def record_exception(_sender: Any, exception: BaseException, **_extra: Any) -> None:
        publish_exception(runtime or default_runtime(), exception, framework="flask")
        # In debug or testing mode Flask re-raises after this signal, and the
        # middleware would report the same exception again.
        if has_request_context():
            request.environ[REPORTED_KEY] = True

    app.before_request(record_route)
    got_request_exception.connect(record_exception, app, weak=False)
