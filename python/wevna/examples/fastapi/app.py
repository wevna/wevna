"""A runnable FastAPI app with Wevna watching it.

    pnpm --filter @wevna/python example

Then open http://localhost:4123 and, in another terminal:

    curl http://localhost:8000/orders/42   # the interesting one
    curl http://localhost:8000/health
    curl http://localhost:8000/boom        # raises on purpose

Every integration here is the real one. SQLAlchemy is real SQLAlchemy over a
real aiosqlite driver, the Redis client is a real redis-py client, and the
outgoing call is real httpx. Nothing about the instrumentation is stubbed —
what is substituted is only the *server* on the other end of it, so the example
needs no database, no Redis and no network.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import fakeredis.aioredis
import httpx
import uvicorn
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import wevna
from wevna.asgi import WevnaMiddleware
from wevna.httpx import instrument as instrument_httpx
from wevna.redis import instrument as instrument_redis
from wevna.sqlalchemy import instrument as instrument_sqlalchemy

APP_PORT = 8000
UPSTREAM_PORT = 8001

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("shop")

ORDER_ITEM_IDS = (1, 2, 3, 4)

# ---------------------------------------------------------------------------
# This is the whole Wevna setup.
# ---------------------------------------------------------------------------

wevna.start()

engine = create_async_engine("sqlite+aiosqlite:///:memory:")
instrument_sqlalchemy(engine)

cache = fakeredis.aioredis.FakeRedis()
instrument_redis(cache)

upstream = httpx.AsyncClient(base_url=f"http://localhost:{UPSTREAM_PORT}")
instrument_httpx(upstream)

# ---------------------------------------------------------------------------
# Below here is an ordinary FastAPI app. Nothing is Wevna-aware.
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Seeds the in-memory database. FastAPI's current startup hook."""
    async with engine.begin() as conn:
        await conn.execute(
            text('create table "Orders" (id integer, customer_id integer, total_cents integer)')
        )
        await conn.execute(text('create table "Customers" (id integer, name text)'))
        await conn.execute(
            text('create table "OrderItems" (id integer, order_id integer, sku text)')
        )
        await conn.execute(text('insert into "Orders" values (42, 7, 8400)'))
        await conn.execute(text("insert into \"Customers\" values (7, 'Ada Lovelace')"))
        for item_id in ORDER_ITEM_IDS:
            await conn.execute(
                text('insert into "OrderItems" values (:id, 42, :sku)'),
                {"id": item_id, "sku": f"WV-ITEM-{item_id}"},
            )
    await cache.set("session:abc", "gold")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(WevnaMiddleware)


@app.get("/orders/{order_id}")
async def read_order(order_id: int) -> dict[str, object]:
    log.info("fetching order %s", order_id)

    async with engine.connect() as conn:
        order = (
            (await conn.execute(text('select * from "Orders" where id = :id'), {"id": order_id}))
            .mappings()
            .first()
        )

        tier = await cache.get("session:abc")
        log.info("customer tier: %s", tier)

        await conn.execute(text('select * from "Customers" where id = :id'), {"id": 7})

        # The N+1: one query per item instead of a single `where order_id = :id`.
        # Watch the Repeated Query insight pick this up in the dashboard.
        items = []
        for item_id in ORDER_ITEM_IDS:
            row = (
                (
                    await conn.execute(
                        text('select * from "OrderItems" where id = :id'), {"id": item_id}
                    )
                )
                .mappings()
                .first()
            )
            items.append(dict(row) if row else {})

    # A real outgoing call, captured and correlated to this request. The
    # api_key value is redacted before it reaches the dashboard.
    rates = await upstream.get("/rates/usd", params={"api_key": "secret123"})

    await cache.set(f"order:{order_id}:cached", "1")
    log.info("order %s assembled with %d items", order_id, len(items))

    return {
        "order": dict(order) if order else {},
        "items": items,
        "tier": tier.decode() if isinstance(tier, bytes) else tier,
        "rates": rates.json(),
    }


@app.get("/health")
async def health() -> dict[str, bool]:
    log.info("health check")
    return {"ok": True}


@app.get("/boom")
async def boom() -> None:
    # Raises on purpose, so you can see an exception attached to the request
    # that produced it rather than floating loose in a log.
    raise ValueError("Something broke while pricing the order")


# A local stand-in for a third-party API, so the httpx capture has something
# real to call without this example needing network access.
rates_api = FastAPI()


@rates_api.get("/rates/{currency}")
async def rates(currency: str) -> dict[str, object]:
    return {"currency": currency, "rate": 1.0}


def main() -> None:
    import threading

    upstream_server = uvicorn.Server(
        uvicorn.Config(rates_api, host="localhost", port=UPSTREAM_PORT, log_level="error")
    )
    threading.Thread(target=upstream_server.run, daemon=True).start()

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
        uvicorn.run(app, host="localhost", port=APP_PORT, log_level="warning")
    finally:
        upstream_server.should_exit = True
        wevna.stop()


if __name__ == "__main__":
    main()
