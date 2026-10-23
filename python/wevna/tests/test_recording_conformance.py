"""Recordings are held to the shared contract, in both directions.

``packages/protocol/fixtures/recordings/`` holds one recording written by each
SDK:

* ``node-basic.jsonl`` was written by the real Node recorder
  (``scripts/generate-node-recording-fixture.mjs``). Python must read it.
* ``python-basic.jsonl`` is written by this SDK's recorder. The test below
  regenerates it and fails if the bytes differ, so the recorder cannot drift
  from what the TypeScript suite was shown. The TypeScript suite loads the same
  file through its own ``SessionLoader``.

Both files are also validated line by line against the JSON Schema. If either
SDK changes the format alone, a suite goes red.

To rewrite the Python fixture after an intentional format change:
``WEVNA_UPDATE_FIXTURES=1 pytest tests/test_recording_conformance.py``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from protocol_artifacts import FIXTURES_DIR

import wevna
from wevna.protocol import CapturedEvent, Correlation, Envelope, Session
from wevna.recording import SessionLoader, SessionRecorder

RECORDINGS = FIXTURES_DIR / "recordings"
NODE_FIXTURE = RECORDINGS / "node-basic.jsonl"
PYTHON_FIXTURE = RECORDINGS / "python-basic.jsonl"

FIXED_START = 1_700_000_000_000


def write_deterministic_python_recording(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The same recording every time: fixed ids, clock and session."""
    clock = iter(range(FIXED_START + 1, FIXED_START + 100))
    for module in ("wevna.protocol", "wevna.recording"):
        monkeypatch.setattr(f"{module}.now_ms", lambda: next(clock))

    session = Session(id="python-fixture-session", started_at=FIXED_START, status="running")
    listeners: list[Callable[[Envelope], None]] = []

    def subscribe(listener: Callable[[Envelope], None]) -> Callable[[], None]:
        listeners.append(listener)
        return lambda: listeners.remove(listener)

    recorder = SessionRecorder()
    recorder.start(subscribe, session, path)

    request = Correlation(id="python-fixture-request")
    events = [
        CapturedEvent(
            id="python-fixture-1",
            kind="sql.query",
            occurred_at=FIXED_START + 10,
            attributes={
                "query": "select * from orders where id = $1",
                "durationMs": 4.2,
                "rows": 1,
            },
            correlation=request,
        ),
        CapturedEvent(
            id="python-fixture-2",
            kind="redis.command",
            occurred_at=FIXED_START + 11,
            attributes={"command": "get", "durationMs": 0.6},
            correlation=request,
        ),
        CapturedEvent(
            id="python-fixture-3",
            kind="http.request",
            occurred_at=FIXED_START + 12,
            attributes={
                "method": "GET",
                "url": "/orders/42",
                "route": "/orders/{order_id}",
                "statusCode": 200,
                "durationMs": 12.5,
            },
            correlation=request,
        ),
        CapturedEvent(
            id="python-fixture-4",
            kind="log.record",
            occurred_at=FIXED_START + 13,
            attributes={"level": "INFO", "logger": "app", "message": "uncorrelated note"},
            source="wevna:logging",
        ),
    ]
    for sequence, payload in enumerate(events):
        for listener in list(listeners):
            listener(Envelope(session_id=session.id, sequence=sequence, payload=payload))
    recorder.stop()


def test_the_python_recorder_still_writes_the_committed_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    produced = tmp_path / "python-basic.jsonl"
    write_deterministic_python_recording(produced, monkeypatch)

    if os.environ.get("WEVNA_UPDATE_FIXTURES") == "1":
        RECORDINGS.mkdir(parents=True, exist_ok=True)
        PYTHON_FIXTURE.write_text(produced.read_text())

    assert PYTHON_FIXTURE.exists(), "run with WEVNA_UPDATE_FIXTURES=1 to create the fixture"
    assert produced.read_text() == PYTHON_FIXTURE.read_text(), (
        "the Python recorder's output no longer matches packages/protocol/fixtures/recordings/"
        "python-basic.jsonl. If the format change is intentional, regenerate it with "
        "WEVNA_UPDATE_FIXTURES=1 and make sure the TypeScript suite still loads it."
    )


@pytest.mark.parametrize("fixture", [NODE_FIXTURE, PYTHON_FIXTURE], ids=lambda p: p.name)
class TestBothFixtures:
    def test_every_line_is_valid_against_the_shared_schema(
        self, schema: dict[str, Any], fixture: Path
    ) -> None:
        validator = Draft202012Validator(
            {"$ref": "#/$defs/RecordingLine", "$defs": schema["$defs"]}
        )
        for number, raw in enumerate(fixture.read_text().splitlines(), start=1):
            errors = [e.message for e in validator.iter_errors(json.loads(raw))]
            assert errors == [], f"{fixture.name} line {number}: {errors}"

    def test_the_python_loader_reads_it_cleanly(self, fixture: Path) -> None:
        loader = SessionLoader(fixture)
        metadata = loader.open()
        events = list(loader.events())

        assert len(events) == 4
        assert loader.errors == []
        assert loader.issues == []
        assert loader.metadata is not None
        assert loader.metadata.event_count == 4
        assert metadata.session.status == "running"
        assert {e.envelope.payload.kind for e in events} >= {"sql.query", "http.request"}

    def test_it_replays_through_the_dashboard_server(self, fixture: Path) -> None:
        import urllib.request

        with wevna.open_recording(fixture, port=0) as opened:
            with urllib.request.urlopen(f"{opened.url}/api/session/events", timeout=10) as response:
                body = json.loads(response.read())
            with urllib.request.urlopen(f"{opened.url}/api/session", timeout=10) as response:
                info = json.loads(response.read())

        assert info["mode"] == "recording"
        assert info["metadata"]["eventCount"] == 4
        assert len(body["events"]) == 4


def test_a_node_recording_has_the_fields_the_python_recording_has() -> None:
    """The two SDKs write the same line shapes, not merely compatible ones."""

    def shapes(path: Path) -> dict[str, set[str]]:
        found: dict[str, set[str]] = {}
        for raw in path.read_text().splitlines():
            line = json.loads(raw)
            found.setdefault(line["type"], set()).update(line)
        return found

    node, python = shapes(NODE_FIXTURE), shapes(PYTHON_FIXTURE)
    assert node["header"] == python["header"]
    assert node["event"] == python["event"]
    assert node["footer"] == python["footer"]
