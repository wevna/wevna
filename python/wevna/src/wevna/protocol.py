"""Wevna's runtime event protocol, in Python.

This module is not the definition of the protocol. ``packages/protocol/schema/
wevna-protocol.schema.json`` is, and ``packages/protocol/src/index.ts`` is the
TypeScript expression of the same thing. Everything here exists to make a
Python producer indistinguishable on the wire from the Node one, so a single
dashboard and a single recording format serve both.

``tests/test_conformance.py`` validates this module's output against that
schema and against the shared fixtures, which is what keeps the claim honest
rather than aspirational.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

# Stamped onto every envelope. Frozen at 1 for the whole 1.x line — see
# STABILITY.md. A test asserts the value, because every other module just
# reads the constant rather than checking it, so an accidental bump would
# pass everything else and mislabel every recording written afterward.
PROTOCOL_VERSION = 1

# The recording *file* format, versioned separately from PROTOCOL_VERSION
# because the two evolve independently: a new recording format does not imply
# a new protocol version, or vice versa.
RECORDING_FORMAT_VERSION = 1

SessionStatus = Literal["running", "stopped"]


def now_ms() -> int:
    """Milliseconds since the epoch, matching JavaScript's ``Date.now()``.

    The protocol's timestamps are compared against, and interleaved with,
    events produced by the Node SDK, so the unit has to be the one the wire
    format already uses rather than Python's float seconds.
    """
    return int(time.time() * 1000)


def new_id() -> str:
    """A fresh event id. UUID4, as the Node SDK's ``randomUUID()`` produces."""
    return str(uuid.uuid4())


@dataclass(frozen=True, slots=True)
class Correlation:
    """Marks several events as belonging to one execution flow.

    Deliberately minimal, matching the TypeScript: future metadata (a parent
    id for nested flows, a depth) can arrive as additional optional fields
    without changing the shape of anything that already exists.
    """

    id: str

    def to_wire(self) -> dict[str, Any]:
        return {"id": self.id}


@dataclass(frozen=True, slots=True)
class CapturedEvent:
    """A single observation made by the runtime.

    Generic on purpose. Per-kind shapes (HTTP, SQL, Redis, ...) are not
    modelled here; consumers narrow ``attributes`` themselves.
    """

    id: str
    kind: str
    occurred_at: int
    attributes: dict[str, Any] = field(default_factory=dict)
    correlation: Correlation | None = None
    source: str | None = None

    def to_wire(self) -> dict[str, Any]:
        # Optional fields are *omitted*, never sent as null. The TypeScript
        # says "omitted entirely (not present as a key)" for both, and that is
        # a wire-compatibility property rather than a stylistic one: a
        # recording written today has to stay byte-comparable with one written
        # by the Node SDK, and a consumer that predates a field must see no
        # key rather than a null it has no branch for.
        wire: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "occurredAt": self.occurred_at,
            "attributes": self.attributes,
        }
        if self.correlation is not None:
            wire["correlation"] = self.correlation.to_wire()
        if self.source is not None:
            wire["source"] = self.source
        return wire

    @classmethod
    def from_wire(cls, wire: dict[str, Any]) -> CapturedEvent:
        correlation = wire.get("correlation")
        return cls(
            id=wire["id"],
            kind=wire["kind"],
            occurred_at=wire["occurredAt"],
            attributes=wire.get("attributes", {}),
            correlation=Correlation(id=correlation["id"]) if correlation else None,
            source=wire.get("source"),
        )


@dataclass(frozen=True, slots=True)
class Session:
    """One in-memory execution of Wevna."""

    id: str
    started_at: int
    status: SessionStatus

    def to_wire(self) -> dict[str, Any]:
        return {"id": self.id, "startedAt": self.started_at, "status": self.status}

    @classmethod
    def from_wire(cls, wire: dict[str, Any]) -> Session:
        status: SessionStatus = wire["status"]
        return cls(id=wire["id"], started_at=wire["startedAt"], status=status)


@dataclass(frozen=True, slots=True)
class Envelope:
    """The wire wrapper around a payload.

    Only ``CapturedEvent`` payloads travel the wire today, so this is not
    generic — Python has no need to mirror TypeScript's ``Envelope<T>`` until
    a second payload type exists, and an unused type parameter would be
    noise in every annotation.
    """

    session_id: str
    sequence: int
    payload: CapturedEvent
    version: int = PROTOCOL_VERSION

    def to_wire(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "sessionId": self.session_id,
            "sequence": self.sequence,
            "payload": self.payload.to_wire(),
        }

    @classmethod
    def from_wire(cls, wire: dict[str, Any]) -> Envelope:
        return cls(
            session_id=wire["sessionId"],
            sequence=wire["sequence"],
            payload=CapturedEvent.from_wire(wire["payload"]),
            version=wire["version"],
        )


def recording_header(session: Session, started_at: int | None = None) -> dict[str, Any]:
    """The first line of a recording file."""
    return {
        "type": "header",
        "formatVersion": RECORDING_FORMAT_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "session": session.to_wire(),
        "recordingStartedAt": started_at if started_at is not None else now_ms(),
    }


def recording_event(envelope: Envelope) -> dict[str, Any]:
    """One event line of a recording file."""
    return {"type": "event", "envelope": envelope.to_wire()}


def recording_footer(event_count: int, ended_at: int | None = None) -> dict[str, Any]:
    """The last line of a recording file, written only on a clean stop.

    A reader that finds no footer should treat the recording as having ended
    abnormally, not as invalid — the format is line-oriented precisely so a
    recording cut short by a crash stays readable up to its last full line.
    """
    return {
        "type": "footer",
        "recordingEndedAt": ended_at if ended_at is not None else now_ms(),
        "eventCount": event_count,
    }
