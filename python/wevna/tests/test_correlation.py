from __future__ import annotations

import asyncio

from wevna import correlation
from wevna.protocol import Correlation


def test_nothing_is_current_by_default() -> None:
    assert correlation.current() is None


def test_start_sets_and_restores() -> None:
    with correlation.start() as active:
        assert correlation.current() == active
    assert correlation.current() is None


def test_start_mints_a_unique_id() -> None:
    with correlation.start() as first:
        pass
    with correlation.start() as second:
        pass
    assert first.id != second.id


def test_start_accepts_a_supplied_id() -> None:
    with correlation.start("from-a-trace-header") as active:
        assert active.id == "from-a-trace-header"


def test_nesting_restores_the_outer_correlation() -> None:
    # A background task started inside a request needs its own identity, so
    # nesting has to work rather than being rejected.
    with correlation.start("outer") as outer:
        with correlation.start("inner") as inner:
            assert correlation.current() == inner
            assert inner.id == "inner"
        assert correlation.current() == outer


def test_run_with_adopts_an_existing_correlation() -> None:
    existing = Correlation(id="replayed")
    with correlation.run_with(existing):
        assert correlation.current() == existing
    assert correlation.current() is None


def test_restores_even_when_the_block_raises() -> None:
    try:
        with correlation.start("doomed"):
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert correlation.current() is None


async def test_a_correlation_is_visible_to_everything_awaited_from_it() -> None:
    seen: list[str | None] = []

    async def deep() -> None:
        active = correlation.current()
        seen.append(active.id if active else None)

    async def middle() -> None:
        await deep()

    with correlation.start("request-1"):
        await middle()

    assert seen == ["request-1"]


async def test_sibling_tasks_do_not_see_each_others_correlation() -> None:
    # The property the whole design rests on: two requests handled
    # concurrently must not bleed into one another.
    observed: dict[str, str | None] = {}

    async def handle(name: str) -> None:
        with correlation.start(name):
            await asyncio.sleep(0)  # force a suspension point mid-request
            active = correlation.current()
            observed[name] = active.id if active else None

    await asyncio.gather(handle("a"), handle("b"))

    assert observed == {"a": "a", "b": "b"}
