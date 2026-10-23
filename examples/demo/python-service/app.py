"""The pricing service: a Python (FastAPI) service that quotes orders.

    pnpm --filter @wevna/example-demo demo

Dashboard: http://localhost:4124   Service: http://localhost:3002

The Node storefront calls ``/quote/{order_id}``. This service looks up each line's
price and calls back to the storefront's ``/stock/{order_id}``, so the two
dashboards show opposite halves of one conversation.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
import uvicorn
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import wevna
from wevna.asgi import WevnaMiddleware
from wevna.httpx import instrument as instrument_httpx
from wevna.redis import instrument as instrument_redis
from wevna.sqlalchemy import instrument as instrument_sqlalchemy

PORT = int(os.environ.get("PRICING_PORT", "3002"))
DASHBOARD_PORT = int(os.environ.get("PRICING_DASHBOARD_PORT", "4124"))
STOREFRONT_URL = os.environ.get("STOREFRONT_URL", "http://localhost:3001")
DATABASE_URL = os.environ.get(
    "PRICING_DATABASE_URL", "postgresql+asyncpg://demo:demo@localhost:5433/demo"
)
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380")

logging.basicConfig(level=logging.INFO)
# httpx and Werkzeug-style access loggers write the full URL, query string
# included, and Wevna's logging capture records what your loggers write. The
# outgoing call below carries an api_key, which Wevna redacts in its own event.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("pricing")

# ---------------------------------------------------------------------------
# This is the whole Wevna setup.
# ---------------------------------------------------------------------------

wevna.start(port=DASHBOARD_PORT)

engine = create_async_engine(DATABASE_URL, pool_size=5)
instrument_sqlalchemy(engine)

cache = aioredis.from_url(REDIS_URL)
instrument_redis(cache)

storefront = httpx.AsyncClient(base_url=STOREFRONT_URL)
instrument_httpx(storefront)

# ---------------------------------------------------------------------------
# Below here is an ordinary FastAPI app. Nothing is Wevna-aware.
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    await storefront.aclose()
    await cache.aclose()
    await engine.dispose()
    wevna.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(WevnaMiddleware)


@app.get("/health")
async def health() -> dict[str, object]:
    return {"ok": True, "service": "pricing"}


@app.get("/quote/{order_id}")
async def quote(order_id: int) -> dict[str, object]:
    if order_id < 1:
        # The failing request on this side: a bad id that reaches the handler.
        log.warning("refusing to quote order %s", order_id)
        raise ValueError(f"order id must be positive, got {order_id}")

    log.info("quoting order %s", order_id)

    async with engine.connect() as conn:
        lines = (
            (
                await conn.execute(
                    text("select sku, qty from order_items where order_id = :id order by id"),
                    {"id": order_id},
                )
            )
            .mappings()
            .all()
        )

        # The N+1 on this side: one price query per line instead of a join. It runs
        # on every request on purpose; caching the prices would make it disappear
        # after the first quote, and the point here is to be able to see it.
        total = 0
        priced = []
        for line in lines:
            row = (
                (
                    await conn.execute(
                        text("select cents from prices where sku = :sku"),
                        {"sku": line["sku"]},
                    )
                )
                .mappings()
                .first()
            )
            cents = int(row["cents"]) if row else 0
            total += cents * int(line["qty"])
            priced.append({"sku": line["sku"], "qty": line["qty"], "cents": cents})

    # Redis is used for the last quote of each order: read it, then write the new one.
    previous = await cache.get(f"quote:{order_id}")
    if previous is not None:
        log.info("previous quote for order %s was %s cents", order_id, int(previous))
    await cache.set(f"quote:{order_id}", total, ex=60)

    # Back to the storefront: a request in the opposite direction.
    stock = await storefront.get(f"/stock/{order_id}")

    log.info("quoted order %s at %s cents", order_id, total)
    return {"orderId": order_id, "totalCents": total, "lines": priced, "stock": stock.json()}


def main() -> None:
    print(f"pricing listening on http://localhost:{PORT}")
    print(f"dashboard at {wevna.url()}")
    uvicorn.run(app, host="localhost", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
