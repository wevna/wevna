"""A runnable FastAPI app with Wevna watching it.

    pnpm --filter @wevna/python example
    # or:  cd python/wevna && .venv/bin/python examples/fastapi/app.py

Then open http://localhost:4123 and, in another terminal:

    curl http://localhost:8000/orders/42   # the interesting one
    curl http://localhost:8000/health
    curl http://localhost:8000/boom        # raises on purpose

No database and no Redis required — see fake_clients.py for why, and for what
it does not fake.
"""

from __future__ import annotations

import logging

import uvicorn
from fastapi import FastAPI

import wevna
from wevna.asgi import WevnaMiddleware

from .fake_clients import ORDER_ITEMS, FakeRedis, FakeSession

APP_PORT = 8000

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("shop")

# ---------------------------------------------------------------------------
# This is the whole Wevna setup.
# ---------------------------------------------------------------------------

wevna.start()

app = FastAPI()
app.add_middleware(WevnaMiddleware)

# ---------------------------------------------------------------------------
# Below here is an ordinary FastAPI app. Nothing is Wevna-aware.
# ---------------------------------------------------------------------------

db = FakeSession()
cache = FakeRedis()


@app.get("/orders/{order_id}")
async def read_order(order_id: int) -> dict[str, object]:
    log.info("fetching order %s", order_id)

    order = await db.fetch_one('select * from "Orders" where "id" = :id', {"id": order_id})
    tier = await cache.get("session:abc")
    log.info("customer tier: %s", tier)

    await db.fetch_one(
        'select * from "Customers" where "id" = :id', {"id": order.get("customer_id")}
    )

    # The N+1: one query per item instead of a single `where "orderId" in (...)`.
    # Watch the Repeated Query insight pick this up in the dashboard.
    items = []
    for item in ORDER_ITEMS:
        row = await db.fetch_one(
            'select * from "OrderItems" where "orderId" = :id', {"id": item["id"]}
        )
        items.append(row)

    await cache.set(f"order:{order_id}:cached", "1")
    log.info("order %s assembled with %d items", order_id, len(items))

    return {"order": order, "items": items, "tier": tier}


@app.get("/health")
async def health() -> dict[str, bool]:
    log.info("health check")
    return {"ok": True}


@app.get("/boom")
async def boom() -> None:
    # Raises on purpose, so you can see an exception attached to the request
    # that produced it rather than floating loose in a log.
    raise ValueError("Something broke while pricing the order")


def main() -> None:
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
        wevna.stop()


if __name__ == "__main__":
    main()
