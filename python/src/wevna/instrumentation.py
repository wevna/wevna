"""Opt-in capture of what a request does: outgoing HTTP, Redis, logs, SQL.

Everything here follows the rules the Node SDK does: arguments and values are
never recorded (SQL parameters, Redis arguments, request and response bodies,
headers), failures are reported by a short stable code rather than a message
that may quote data, and a failure inside Wevna can never reach the caller.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any, Callable, Dict, Optional

from . import _client
from ._patching import patch
from ._sanitize import sanitize_url

# --------------------------------------------------------------------------
# Logging -> console.log
# --------------------------------------------------------------------------


class WevnaLogHandler(logging.Handler):
    """Records log records as `console.log` events (the dashboard's name for
    "the app printed something"), carrying the level."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            _client.emit(
                "console.log",
                {"level": record.levelname.lower(), "message": record.getMessage()},
            )
        except Exception:  # noqa: BLE001
            self.handleError(record)


_log_handler: Optional[WevnaLogHandler] = None


def instrument_logging(level: int = logging.INFO) -> None:
    global _log_handler
    if _log_handler is not None:
        return
    _log_handler = WevnaLogHandler(level)
    logging.getLogger().addHandler(_log_handler)
    # A root logger left at its default WARNING would never hand us the INFO
    # records we were asked for.
    root = logging.getLogger()
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)


def uninstrument_logging() -> None:
    global _log_handler
    if _log_handler is not None:
        logging.getLogger().removeHandler(_log_handler)
        _log_handler = None


# --------------------------------------------------------------------------
# Outgoing HTTP: requests, httpx
# --------------------------------------------------------------------------


def _publish_http_client(method: str, url: str, started: float, **extra: Any) -> None:
    try:
        _client.emit(
            "http.client",
            {
                "method": method.upper(),
                "url": sanitize_url(url),
                "durationMs": (time.perf_counter() - started) * 1000,
                **extra,
            },
        )
    except Exception:  # noqa: BLE001
        pass


def instrument_requests() -> bool:
    """Capture calls made with the `requests` library. False if not installed."""
    try:
        import requests  # type: ignore[import-not-found]
    except ImportError:
        return False

    def make(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def send(self: Any, request: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                response = original(self, request, **kwargs)
            except Exception as error:
                _publish_http_client(
                    request.method, request.url, started, error=type(error).__name__
                )
                raise
            _publish_http_client(
                request.method, request.url, started, statusCode=response.status_code
            )
            return response

        return send

    patch(requests.Session, "send", make)
    return True


def instrument_httpx() -> bool:
    """Capture calls made with `httpx`, sync and async. False if not installed."""
    try:
        import httpx  # type: ignore[import-not-found]
    except ImportError:
        return False

    def make_sync(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def send(self: Any, request: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                response = original(self, request, **kwargs)
            except Exception as error:
                _publish_http_client(
                    request.method, str(request.url), started, error=type(error).__name__
                )
                raise
            _publish_http_client(
                request.method, str(request.url), started, statusCode=response.status_code
            )
            return response

        return send

    def make_async(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        async def send(self: Any, request: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                response = await original(self, request, **kwargs)
            except Exception as error:
                _publish_http_client(
                    request.method, str(request.url), started, error=type(error).__name__
                )
                raise
            _publish_http_client(
                request.method, str(request.url), started, statusCode=response.status_code
            )
            return response

        return send

    patch(httpx.Client, "send", make_sync)
    patch(httpx.AsyncClient, "send", make_async)
    return True


# --------------------------------------------------------------------------
# Redis (redis-py)
# --------------------------------------------------------------------------


def _publish_redis(args: Any, started: float, error: Optional[BaseException]) -> None:
    try:
        # args[0] only — the command name. Everything after it is keys and
        # values, which are application data.
        command = args[0] if args else ""
        if isinstance(command, bytes):
            command = command.decode("latin-1")
        attributes: Dict[str, Any] = {
            "command": str(command).lower(),
            "durationMs": (time.perf_counter() - started) * 1000,
        }
        if error is not None:
            attributes["error"] = type(error).__name__
        _client.emit("redis.command", attributes)
    except Exception:  # noqa: BLE001
        pass


def instrument_redis() -> bool:
    """Capture redis-py commands, sync and asyncio. False if not installed."""
    try:
        import redis  # type: ignore[import-not-found]
    except ImportError:
        return False

    def make_sync(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def execute_command(self: Any, *args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                result = original(self, *args, **kwargs)
            except Exception as error:
                _publish_redis(args, started, error)
                raise
            _publish_redis(args, started, None)
            return result

        return execute_command

    patch(redis.Redis, "execute_command", make_sync)

    try:
        import redis.asyncio as redis_asyncio  # type: ignore[import-not-found]

        def make_async(original: Callable[..., Any]) -> Callable[..., Any]:
            @functools.wraps(original)
            async def execute_command(self: Any, *args: Any, **kwargs: Any) -> Any:
                started = time.perf_counter()
                try:
                    result = await original(self, *args, **kwargs)
                except Exception as error:
                    _publish_redis(args, started, error)
                    raise
                _publish_redis(args, started, None)
                return result

            return execute_command

        patch(redis_asyncio.Redis, "execute_command", make_async)
    except ImportError:
        pass
    return True


# --------------------------------------------------------------------------
# SQL: any DB-API 2.0 connection (sqlite3, psycopg, psycopg2, mysqlclient...)
# --------------------------------------------------------------------------


def _publish_sql(query: Any, started: float, rows: Any, error: Optional[BaseException]) -> None:
    try:
        attributes: Dict[str, Any] = {
            "query": query if isinstance(query, str) else str(query),
            "durationMs": (time.perf_counter() - started) * 1000,
        }
        if isinstance(rows, int) and rows >= 0:
            attributes["rows"] = rows
        if error is not None:
            code = getattr(error, "pgcode", None) or getattr(error, "sqlstate", None)
            attributes["error"] = code if isinstance(code, str) else type(error).__name__
        _client.emit("sql.query", attributes)
    except Exception:  # noqa: BLE001
        pass


class _WevnaCursor:
    """Delegates everything to the real cursor, timing execute/executemany."""

    def __init__(self, cursor: Any) -> None:
        self._cursor = cursor

    def _timed(self, method: str, query: Any, *args: Any, **kwargs: Any) -> Any:
        started = time.perf_counter()
        try:
            result = getattr(self._cursor, method)(query, *args, **kwargs)
        except Exception as error:
            _publish_sql(query, started, None, error)
            raise
        _publish_sql(query, started, getattr(self._cursor, "rowcount", None), None)
        return result

    # Only args[0] — the statement — is ever read, never the parameters.
    def execute(self, query: Any, *args: Any, **kwargs: Any) -> Any:
        result = self._timed("execute", query, *args, **kwargs)
        # DB-API cursors return themselves from execute() in most drivers;
        # hand back the wrapper so a chained fetch stays on this object.
        return self if result is self._cursor else result

    def executemany(self, query: Any, *args: Any, **kwargs: Any) -> Any:
        result = self._timed("executemany", query, *args, **kwargs)
        return self if result is self._cursor else result

    def __iter__(self) -> Any:
        return iter(self._cursor)

    def __enter__(self) -> "_WevnaCursor":
        self._cursor.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._cursor.__exit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)


class _WevnaConnection:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def cursor(self, *args: Any, **kwargs: Any) -> _WevnaCursor:
        return _WevnaCursor(self._connection.cursor(*args, **kwargs))

    def execute(self, query: Any, *args: Any, **kwargs: Any) -> Any:
        # sqlite3 (and a few others) offer connection.execute() as a shortcut.
        started = time.perf_counter()
        try:
            result = self._connection.execute(query, *args, **kwargs)
        except Exception as error:
            _publish_sql(query, started, None, error)
            raise
        _publish_sql(query, started, getattr(result, "rowcount", None), None)
        return result

    def __enter__(self) -> "_WevnaConnection":
        self._connection.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._connection.__exit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


def instrument_connection(connection: Any) -> Any:
    """Wrap a DB-API 2.0 connection; use the returned object in its place.

        conn = wevna.instrument_connection(psycopg.connect(dsn))

    Wraps rather than patches because the common drivers' connection and
    cursor types are C extensions that cannot be patched in place.
    """
    if isinstance(connection, _WevnaConnection):
        return connection
    return _WevnaConnection(connection)
