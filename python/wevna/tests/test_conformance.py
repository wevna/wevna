"""Validates this SDK against the shared protocol contract.

These are the tests that make "a Python-produced event stream is
indistinguishable from a Node-produced one" a fact rather than an intention.
They read ``packages/protocol``'s schema and fixtures directly — the same
files the TypeScript suite reads — so the two implementations cannot drift
without one of them going red.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from protocol_artifacts import fixture_files, load_fixture

from wevna.protocol import (
    PROTOCOL_VERSION,
    RECORDING_FORMAT_VERSION,
    CapturedEvent,
    Correlation,
    Envelope,
    Session,
    recording_event,
    recording_footer,
    recording_header,
)


def validator_for(schema: dict[str, Any], definition: str) -> Draft202012Validator:
    """A validator for one ``$def``, resolved through the whole schema.

    The schema is passed as the root rather than the ``$def`` alone so that
    internal ``$ref``s (``EventEnvelope`` referencing ``CapturedEvent``, and
    that referencing ``Correlation``) still resolve.
    """
    return Draft202012Validator({"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]})


def definition_of(path: Path) -> str:
    """Fixtures are named ``<Definition>.<description>.json``."""
    return path.name.split(".")[0]


def test_schema_itself_is_valid(schema: dict[str, Any]) -> None:
    Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("path", fixture_files("valid"), ids=lambda p: p.name)
def test_valid_fixtures_are_accepted(schema: dict[str, Any], path: Path) -> None:
    validator = validator_for(schema, definition_of(path))
    errors = sorted(validator.iter_errors(load_fixture(path)), key=str)
    assert errors == [], f"{path.name}: {[e.message for e in errors]}"


@pytest.mark.parametrize("path", fixture_files("invalid"), ids=lambda p: p.name)
def test_invalid_fixtures_are_rejected(schema: dict[str, Any], path: Path) -> None:
    validator = validator_for(schema, definition_of(path))
    assert not validator.is_valid(load_fixture(path)), (
        f"{path.name} should have been rejected by {definition_of(path)}"
    )


def test_fixtures_were_actually_found() -> None:
    # Without this, a wrong path would make every parametrised test above
    # collect zero cases and the suite would pass by validating nothing.
    assert len(fixture_files("valid")) >= 9
    assert len(fixture_files("invalid")) >= 10


class TestThisSdkProducesValidWire:
    """The direction fixtures cannot cover: what this module actually emits."""

    def test_minimal_event(self, schema: dict[str, Any]) -> None:
        event = CapturedEvent(id="e-1", kind="log.record", occurred_at=1_755_043_200_000)
        validator = validator_for(schema, "CapturedEvent")
        assert validator.is_valid(event.to_wire()), list(validator.iter_errors(event.to_wire()))

    def test_fully_populated_envelope(self, schema: dict[str, Any]) -> None:
        envelope = Envelope(
            session_id="s-1",
            sequence=3,
            payload=CapturedEvent(
                id="e-2",
                kind="sql.query",
                occurred_at=1_755_043_200_123,
                attributes={"query": 'select * from "Orders" where "id" = $1', "durationMs": 3.4},
                correlation=Correlation(id="c-1"),
                source="wevna.sqlalchemy",
            ),
        )
        validator = validator_for(schema, "EventEnvelope")
        wire = envelope.to_wire()
        assert validator.is_valid(wire), list(validator.iter_errors(wire))

    @pytest.mark.parametrize(
        "line",
        [
            recording_header(Session(id="s-1", started_at=1, status="running")),
            recording_event(
                Envelope(
                    session_id="s-1",
                    sequence=0,
                    payload=CapturedEvent(id="e", kind="k", occurred_at=1),
                )
            ),
            recording_footer(event_count=0),
        ],
        ids=["header", "event", "footer"],
    )
    def test_every_recording_line_variant(self, schema: dict[str, Any], line: Any) -> None:
        validator = validator_for(schema, "RecordingLine")
        assert validator.is_valid(line), list(validator.iter_errors(line))


class TestWireCompatibilityDetails:
    """Properties the schema permits but wire compatibility with Node requires."""

    def test_absent_optionals_are_omitted_not_null(self) -> None:
        # The TypeScript says "omitted entirely (not present as a key)" for
        # both correlation and source. A null would satisfy neither a consumer
        # predating the field nor a byte-comparison against a Node recording.
        wire = CapturedEvent(id="e", kind="k", occurred_at=1).to_wire()
        assert "correlation" not in wire
        assert "source" not in wire

    def test_present_optionals_are_included(self) -> None:
        wire = CapturedEvent(
            id="e", kind="k", occurred_at=1, correlation=Correlation(id="c"), source="p"
        ).to_wire()
        assert wire["correlation"] == {"id": "c"}
        assert wire["source"] == "p"

    def test_keys_are_camel_case_on_the_wire(self) -> None:
        # Python names them snake_case; the wire format is JavaScript's.
        wire = CapturedEvent(id="e", kind="k", occurred_at=7).to_wire()
        assert wire["occurredAt"] == 7
        assert "occurred_at" not in wire

    def test_round_trips_through_the_wire(self) -> None:
        original = CapturedEvent(
            id="e",
            kind="sql.query",
            occurred_at=123,
            attributes={"query": "select 1"},
            correlation=Correlation(id="c"),
            source="wevna.sqlalchemy",
        )
        assert CapturedEvent.from_wire(original.to_wire()) == original

    def test_envelope_round_trips(self) -> None:
        original = Envelope(
            session_id="s",
            sequence=9,
            payload=CapturedEvent(id="e", kind="k", occurred_at=1),
        )
        assert Envelope.from_wire(original.to_wire()) == original


class TestFrozenVersions:
    """Mirrors the TypeScript package's own guard on these constants."""

    def test_protocol_version_matches_the_typescript(self, schema: dict[str, Any]) -> None:
        assert PROTOCOL_VERSION == 1
        assert schema["$defs"]["EventEnvelope"]["properties"]["version"]["minimum"] == (
            PROTOCOL_VERSION
        )

    def test_recording_format_version_matches_the_typescript(self, schema: dict[str, Any]) -> None:
        assert RECORDING_FORMAT_VERSION == 1
        assert schema["$defs"]["RecordingHeader"]["properties"]["formatVersion"]["minimum"] == (
            RECORDING_FORMAT_VERSION
        )
