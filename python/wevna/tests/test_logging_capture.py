from __future__ import annotations

import logging

from wevna.logging_capture import install
from wevna.protocol import CapturedEvent, Envelope
from wevna.runtime import Runtime


def test_publishes_an_event_per_record() -> None:
    seen: list[CapturedEvent] = []
    logger = logging.getLogger("app.test.basic")
    logger.setLevel(logging.INFO)
    uninstall = install(seen.append, logger)
    try:
        logger.info("hello")
    finally:
        uninstall()

    assert len(seen) == 1
    assert seen[0].kind == "log.record"
    assert seen[0].attributes["message"] == "hello"
    assert seen[0].attributes["level"] == "INFO"
    assert seen[0].attributes["logger"] == "app.test.basic"


def test_records_the_formatted_message_not_the_arguments() -> None:
    # Only record.getMessage() is kept, never record.args. The arguments are
    # arbitrary user objects that get serialized on the way to a dashboard
    # client, and they carry no redaction — this is the exact bug the Node SDK
    # shipped and had to fix.
    seen: list[CapturedEvent] = []
    logger = logging.getLogger("app.test.args")
    logger.setLevel(logging.INFO)
    uninstall = install(seen.append, logger)
    try:
        logger.info("order %s cost %d", "42", 8400)
    finally:
        uninstall()

    assert seen[0].attributes["message"] == "order 42 cost 8400"
    assert "args" not in seen[0].attributes


def test_survives_an_unserializable_log_argument() -> None:
    # console.log(req) — a circular object — is what broke the Node SDK.
    seen: list[CapturedEvent] = []
    logger = logging.getLogger("app.test.circular")
    logger.setLevel(logging.INFO)
    uninstall = install(seen.append, logger)

    circular: dict[str, object] = {"name": "req"}
    circular["self"] = circular

    try:
        logger.info("received %s", circular)
    finally:
        uninstall()

    assert len(seen) == 1
    import json

    json.dumps(seen[0].to_wire())  # the whole point: it must serialize


def test_captures_exception_details() -> None:
    seen: list[CapturedEvent] = []
    logger = logging.getLogger("app.test.exc")
    logger.setLevel(logging.ERROR)
    uninstall = install(seen.append, logger)
    try:
        try:
            raise ValueError("pricing failed")
        except ValueError:
            logger.exception("could not price the order")
    finally:
        uninstall()

    exception = seen[0].attributes["exception"]
    assert isinstance(exception, dict)
    assert exception["type"] == "ValueError"
    assert exception["message"] == "pricing failed"


def test_never_captures_wevnas_own_logging() -> None:
    # Otherwise reporting a failed publish would publish another event, and
    # Wevna's diagnostics would appear in the user's request timeline.
    seen: list[CapturedEvent] = []
    root = logging.getLogger()
    uninstall = install(seen.append, root)
    try:
        logging.getLogger("wevna.event_bus").error("a listener raised")
        logging.getLogger("wevna").warning("something internal")
    finally:
        uninstall()

    assert seen == []


def test_does_not_recurse_when_a_subscriber_logs() -> None:
    # A subscriber logging through a captured logger would otherwise re-enter
    # the handler for its own record, indefinitely.
    logger = logging.getLogger("app.test.reentrant")
    logger.setLevel(logging.INFO)
    published: list[CapturedEvent] = []

    def publish_and_log(event: CapturedEvent) -> None:
        published.append(event)
        logger.info("subscriber says hello")

    uninstall = install(publish_and_log, logger)
    try:
        logger.info("first")
    finally:
        uninstall()

    assert len(published) == 1


def test_leaves_the_applications_own_logging_alone(caplog) -> None:  # type: ignore[no-untyped-def]
    # Being a handler rather than a patch means formatters, levels, other
    # handlers and propagation all behave exactly as before.
    logger = logging.getLogger("app.test.untouched")
    logger.setLevel(logging.INFO)
    uninstall = install(lambda _: None, logger)
    try:
        with caplog.at_level(logging.INFO, logger="app.test.untouched"):
            logger.info("still printed")
    finally:
        uninstall()

    assert "still printed" in caplog.text


def test_uninstall_stops_capture() -> None:
    seen: list[CapturedEvent] = []
    logger = logging.getLogger("app.test.uninstall")
    logger.setLevel(logging.INFO)
    install(seen.append, logger)()
    logger.info("after uninstall")
    assert seen == []


def test_end_to_end_through_the_runtime() -> None:
    runtime = Runtime()
    runtime.start_session()
    envelopes: list[Envelope] = []
    runtime.subscribe(envelopes.append)

    logger = logging.getLogger("app.test.e2e")
    logger.setLevel(logging.INFO)
    uninstall = install(runtime.publish, logger)
    try:
        logger.info("through the runtime")
    finally:
        uninstall()

    assert len(envelopes) == 1
    assert envelopes[0].payload.attributes["message"] == "through the runtime"
