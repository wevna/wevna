"""A runnable Flask app with Wevna watching it.

    pnpm --filter @wevna/python example:flask

Then open http://localhost:4123 and, in another terminal:

    curl http://localhost:8002/orders/42   # the interesting one
    curl http://localhost:8002/health
    curl http://localhost:8002/boom        # raises on purpose

The same three real integrations as the FastAPI example, in their synchronous
forms: SQLAlchemy over sqlite, a redis-py client (served from memory by
fakeredis), and httpx. Only the servers on the other end are substituted, so it
needs no database, no Redis and no network.
"""

from __future__ import annotations

import logging
import threading

import fakeredis
import httpx
from flask import Flask, jsonify
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool
from werkzeug.serving import make_server

import wevna
import wevna.flask
from wevna.httpx import instrument as instrument_httpx
from wevna.redis import instrument as instrument_redis
from wevna.sqlalchemy import instrument as instrument_sqlalchemy
from wevna.wsgi import WevnaMiddleware

APP_PORT = 8002
UPSTREAM_PORT = 8003

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("shop")

# httpx and Werkzeug log the full request URL at INFO, query string included, and
# Wevna's logging capture records what your loggers write. Wevna redacts the
# api_key in the http.client event it records itself; it cannot rewrite a URL that
# some other library has already put in a log message. Quieting these two keeps
# the demo's secret out of the log stream.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)

ORDER_ITEM_IDS = (1, 2, 3, 4)

# ---------------------------------------------------------------------------
# This is the whole Wevna setup.
# ---------------------------------------------------------------------------

wevna.start()

# StaticPool: one in-memory sqlite database shared by every request thread.
engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
instrument_sqlalchemy(engine)

cache = fakeredis.FakeRedis()
instrument_redis(cache)

upstream = httpx.Client(base_url=f"http://localhost:{UPSTREAM_PORT}")
instrument_httpx(upstream)

app = Flask(__name__)
app.wsgi_app = WevnaMiddleware(app.wsgi_app)  # type: ignore[method-assign]
wevna.flask.instrument(app)  # the route pattern, and exceptions Flask hides as a 500

# ---------------------------------------------------------------------------
# Below here is an ordinary Flask app. Nothing is Wevna-aware.
# ---------------------------------------------------------------------------


def seed() -> None:
    with engine.begin() as conn:
        conn.execute(
            text("create table orders (id integer, customer_id integer, total_cents integer)")
        )
        conn.execute(text("create table customers (id integer, name text)"))
        conn.execute(text("create table order_items (id integer, order_id integer, sku text)"))
        conn.execute(text("insert into orders values (42, 7, 8400)"))
        conn.execute(text("insert into customers values (7, 'Ada Lovelace')"))
        for item_id in ORDER_ITEM_IDS:
            conn.execute(
                text("insert into order_items values (:id, 42, :sku)"),
                {"id": item_id, "sku": f"WV-ITEM-{item_id}"},
            )
    cache.set("session:abc", "gold")


@app.get("/orders/<int:order_id>")
def read_order(order_id: int):  # type: ignore[no-untyped-def]
    log.info("fetching order %s", order_id)

    with engine.connect() as conn:
        order = (
            conn.execute(text("select * from orders where id = :id"), {"id": order_id})
            .mappings()
            .first()
        )

        tier = cache.get("session:abc")
        log.info("customer tier: %s", tier)

        conn.execute(text("select * from customers where id = :id"), {"id": 7})

        # The N+1: one query per item instead of a single `where order_id = :id`.
        # Watch the Repeated Query insight pick this up in the dashboard.
        items = []
        for item_id in ORDER_ITEM_IDS:
            row = (
                conn.execute(text("select * from order_items where id = :id"), {"id": item_id})
                .mappings()
                .first()
            )
            items.append(dict(row) if row else {})

    # A real outgoing call, captured and correlated to this request. The api_key
    # value is redacted before it reaches the dashboard.
    rates = upstream.get("/rates/usd", params={"api_key": "secret123"})

    cache.set(f"order:{order_id}:cached", "1")
    log.info("order %s assembled with %d items", order_id, len(items))

    return jsonify(
        order=dict(order) if order else {},
        items=items,
        tier=tier.decode() if isinstance(tier, bytes) else tier,
        rates=rates.json(),
    )


@app.get("/health")
def health():  # type: ignore[no-untyped-def]
    log.info("health check")
    return jsonify(ok=True)


@app.get("/boom")
def boom():  # type: ignore[no-untyped-def]
    log.warning("about to fail")
    raise RuntimeError("this endpoint always fails")


# The upstream service the app calls. A second Flask app, not instrumented.
rates_api = Flask("rates")


@rates_api.get("/rates/<currency>")
def rates(currency: str):  # type: ignore[no-untyped-def]
    return jsonify(currency=currency, rate=1.0)


def main() -> None:
    seed()
    upstream_server = make_server("localhost", UPSTREAM_PORT, rates_api, threaded=True)
    threading.Thread(target=upstream_server.serve_forever, daemon=True).start()

    print()
    print(f"  Demo app     http://localhost:{APP_PORT}")
    print(f"  Dashboard    {wevna.url()}")
    print()
    print("  Try these, then watch the dashboard:")
    print(f"    curl http://localhost:{APP_PORT}/orders/42   # the interesting one")
    print(f"    curl http://localhost:{APP_PORT}/health")
    print(f"    curl http://localhost:{APP_PORT}/boom        # raises on purpose")
    print()
    try:
        app.run(host="localhost", port=APP_PORT, threaded=True, use_reloader=False)
    finally:
        upstream_server.shutdown()
        wevna.stop()


if __name__ == "__main__":
    main()
