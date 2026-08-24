"""Stand-ins for a database and a cache, so this example needs no services.

These are not mocks of Wevna. Phase 2 will instrument SQLAlchemy and redis-py
directly; until then the example publishes sql.query and redis.command events
through the same plugin-style path those integrations will use, so the
dashboard shows exactly what it will show for the real thing.

What is fake is the storage. What is real is the event stream, the
correlation, and the timing.
"""

from __future__ import annotations

import asyncio
from typing import Any

import wevna
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import default_runtime

ORDERS: list[dict[str, Any]] = [
    {"id": 42, "customer_id": 7, "total_cents": 8400, "status": "shipped"}
]

ORDER_ITEMS: list[dict[str, Any]] = [
    {"id": 1, "order_id": 42, "sku": "WV-KEYBOARD-87", "qty": 1, "price_cents": 6900},
    {"id": 2, "order_id": 42, "sku": "WV-CABLE-USBC", "qty": 2, "price_cents": 500},
    {"id": 3, "order_id": 42, "sku": "WV-STICKER-PK", "qty": 1, "price_cents": 300},
    {"id": 4, "order_id": 42, "sku": "WV-MAT-DESK", "qty": 1, "price_cents": 700},
]


def _publish(kind: str, attributes: dict[str, Any]) -> None:
    default_runtime().publish(
        CapturedEvent(id=new_id(), kind=kind, occurred_at=now_ms(), attributes=attributes)
    )


class FakeSession:
    """Publishes sql.query events, the way the SQLAlchemy integration will.

    Note what is recorded: the query *text* and a duration, never the bound
    parameters. That is the same boundary the Node SDK holds for pg, and it is
    a deliberate limit rather than an oversight — parameterised query text
    normally contains no data, and the values are exactly where the secrets are.
    """

    async def fetch_one(self, statement: str, params: dict[str, Any]) -> dict[str, Any]:
        started = now_ms()

        if '"Orders"' in statement:
            await asyncio.sleep(0.003)
            row = ORDERS[0]
        elif '"OrderItems"' in statement:
            await asyncio.sleep(0.038)
            row = ORDER_ITEMS[0]
        elif '"Customers"' in statement:
            await asyncio.sleep(0.004)
            row = {"id": 7, "name": "Ada Lovelace", "tier": "gold"}
        else:
            await asyncio.sleep(0.002)
            row = {}

        _publish(
            "sql.query",
            {
                "query": statement,
                "durationMs": float(now_ms() - started),
                "rowCount": 1 if row else 0,
            },
        )
        return row


class FakeRedis:
    """Publishes redis.command events, the way the redis-py integration will.

    Only the command *name* and a duration. Redis commands routinely carry the
    value inline — `SET session:abc <token>` — so unlike parameterised SQL
    there is no safe subset of the arguments to keep.
    """

    def __init__(self) -> None:
        self._store: dict[str, str] = {"session:abc": "gold"}

    async def get(self, key: str) -> str | None:
        started = now_ms()
        await asyncio.sleep(0.002)
        _publish("redis.command", {"command": "get", "durationMs": float(now_ms() - started)})
        return self._store.get(key)

    async def set(self, key: str, value: str) -> None:
        started = now_ms()
        await asyncio.sleep(0.003)
        self._store[key] = value
        _publish("redis.command", {"command": "set", "durationMs": float(now_ms() - started)})


__all__ = ["ORDERS", "ORDER_ITEMS", "FakeRedis", "FakeSession", "wevna"]
