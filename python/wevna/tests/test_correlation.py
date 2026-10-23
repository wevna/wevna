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


class TestBind:
    """Work handed to a bare thread does not inherit the caller's context."""

    def test_work_in_a_thread_pool_stays_attached_to_the_submitting_request(self) -> None:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=1) as pool, correlation.start("req-1"):
            bare = pool.submit(correlation.current).result()
            bound = pool.submit(correlation.bind(correlation.current)).result()

        assert bare is None  # the gap this exists to close
        assert bound is not None
        assert bound.id == "req-1"

    def test_the_binding_is_taken_at_wrap_time_not_call_time(self) -> None:
        with correlation.start("first"):
            wrapped = correlation.bind(correlation.current)
        with correlation.start("second"):
            result = wrapped()

        assert result is not None
        assert result.id == "first"

    def test_the_wrapped_call_does_not_leak_the_correlation_afterwards(self) -> None:
        def work() -> None:
            return None

        with correlation.start("req-1"):
            wrapped = correlation.bind(work)
        wrapped()

        assert correlation.current() is None

    def test_without_a_correlation_the_function_is_returned_unchanged(self) -> None:
        def work() -> int:
            return 1

        assert correlation.bind(work) is work

    def test_arguments_return_value_and_name_survive(self) -> None:
        def add(a: int, b: int = 0) -> int:
            return a + b

        with correlation.start("req-1"):
            wrapped = correlation.bind(add)

        assert wrapped(2, b=3) == 5
        assert wrapped.__name__ == "add"


class TestBegin:
    """``begin`` is for a context that is discarded with the request."""

    def test_sets_a_correlation_for_the_rest_of_that_context_only(self) -> None:
        import contextvars

        context = contextvars.copy_context()

        def inside() -> str:
            started = correlation.begin()
            current = correlation.current()
            assert current is not None
            assert current.id == started.id
            return started.id

        request_id = context.run(inside)

        assert correlation.current() is None  # the caller's context is untouched
        later = context.run(correlation.current)
        assert later is not None
        assert later.id == request_id  # still there on the next step of the same context

    def test_an_explicit_id_is_used(self) -> None:
        import contextvars

        assert (
            contextvars.copy_context().run(correlation.begin, "from-a-header").id == "from-a-header"
        )

    def test_each_context_gets_its_own_id(self) -> None:
        import contextvars

        first = contextvars.copy_context().run(correlation.begin)
        second = contextvars.copy_context().run(correlation.begin)

        assert first.id != second.id
