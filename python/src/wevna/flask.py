"""Flask integration: the route pattern, which only Flask knows.

    wevna.flask.install(app)

Wraps the WSGI app and records the matched rule ("/orders/<int:order_id>") so
the dashboard groups requests by endpoint rather than by URL. Flask itself is
imported lazily, so merely installing wevna does not require it.
"""

from __future__ import annotations

from typing import Any

from ._context import set_route
from .wsgi import WevnaWSGIMiddleware


def install(app: Any) -> None:
    from flask import request  # type: ignore[import-not-found]

    app.wsgi_app = WevnaWSGIMiddleware(app.wsgi_app)

    @app.before_request
    def _wevna_route() -> None:
        rule = request.url_rule
        if rule is not None:
            set_route(rule.rule)
