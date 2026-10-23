"""Recording: the writer, the reader, replay serving, and the public API.

Properties over mirrors. The questions these answer are things a user relies on:
is every line valid against the shared schema, does a crash leave something
readable, is memory bounded, does a forked worker leave the file alone, and does
what is written come back out unchanged.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

import wevna
from wevna.protocol import (
    PROTOCOL_VERSION,
    RECORDING_FORMAT_VERSION,
    CapturedEvent,
    Correlation,
    Envelope,
    Session,
    dumps_wire,
    recording_event,
    recording_header,
)
from wevna.recording import RecordingError, SessionLoader, SessionRecorder
from wevna.runtime import Runtime, reset_default_runtime


def event(kind: str = "sql.query", **attributes: Any) -> CapturedEvent:
    return CapturedEvent(id=f"e-{kind}", kind=kind, occurred_at=1000, attributes=attributes)


def lines_of(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def record(path: Path, publish: Callable[[Runtime], None]) -> Runtime:
    """Runs a recorder over a real Runtime, the way the public API wires it."""
    runtime = Runtime()
    session = runtime.start_session()
    recorder = SessionRecorder()
    recorder.start(runtime.subscribe, session, path)
    publish(runtime)
    recorder.stop()
    return runtime


@pytest.fixture(autouse=True)
def clean_state() -> Iterator[None]:
    reset_default_runtime()
    yield
    wevna.stop()
    reset_default_runtime()


class TestRecorderFormat:
    def test_writes_a_header_then_events_in_order_then_a_footer(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"

        def publish(runtime: Runtime) -> None:
            for kind in ("http.request", "sql.query", "redis.command"):
                runtime.publish(event(kind))

        record(path, publish)

        lines = lines_of(path)
        assert [line["type"] for line in lines] == ["header", "event", "event", "event", "footer"]
        assert [line["envelope"]["payload"]["kind"] for line in lines[1:4]] == [
            "http.request",
            "sql.query",
            "redis.command",
        ]
        assert lines[0]["formatVersion"] == RECORDING_FORMAT_VERSION
        assert lines[0]["protocolVersion"] == PROTOCOL_VERSION
        assert lines[-1]["eventCount"] == 3

    def test_every_line_is_valid_against_the_shared_schema(
        self, tmp_path: Path, schema: dict[str, Any]
    ) -> None:
        path = tmp_path / "s.jsonl"

        def publish(runtime: Runtime) -> None:
            runtime.publish(
                CapturedEvent(
                    id="e1",
                    kind="http.request",
                    occurred_at=5,
                    attributes={"method": "GET"},
                    correlation=Correlation(id="c1"),
                    source="wevna:test",
                )
            )

        record(path, publish)

        validator = Draft202012Validator(
            {"$ref": "#/$defs/RecordingLine", "$defs": schema["$defs"]}
        )
        for line in lines_of(path):
            errors = [e.message for e in validator.iter_errors(line)]
            assert errors == [], (line["type"], errors)

    def test_the_header_describes_the_running_session(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        runtime = record(path, lambda r: None)

        header = lines_of(path)[0]
        assert header["session"]["id"] == runtime.session.id  # type: ignore[union-attr]
        assert header["session"]["status"] == "running"

    def test_non_finite_numbers_are_written_as_null_so_the_file_is_valid_json(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "s.jsonl"
        record(path, lambda r: r.publish(event(durationMs=float("nan"), rows=2)))

        text = path.read_text()
        assert "NaN" not in text
        assert lines_of(path)[1]["envelope"]["payload"]["attributes"] == {
            "durationMs": None,
            "rows": 2,
        }

    def test_an_event_that_cannot_be_serialized_is_dropped_and_the_rest_are_kept(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        path = tmp_path / "s.jsonl"
        circular: dict[str, object] = {}
        circular["self"] = circular

        def publish(runtime: Runtime) -> None:
            runtime.publish(event("a"))
            runtime.publish(event("bad", loop=circular))
            runtime.publish(event("c"))

        with caplog.at_level("ERROR", logger="wevna.recording"):
            record(path, publish)

        lines = lines_of(path)
        assert [ln["envelope"]["payload"]["kind"] for ln in lines if ln["type"] == "event"] == [
            "a",
            "c",
        ]
        assert lines[-1]["eventCount"] == 2
        assert "could not be serialized" in caplog.text

    def test_attributes_mutated_after_publishing_do_not_change_what_was_recorded(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "s.jsonl"
        attributes: dict[str, Any] = {"state": "before"}

        def publish(runtime: Runtime) -> None:
            runtime.publish(CapturedEvent(id="e", kind="x", occurred_at=1, attributes=attributes))
            attributes["state"] = "after"

        record(path, publish)

        assert lines_of(path)[1]["envelope"]["payload"]["attributes"] == {"state": "before"}


class TestRecorderLifecycle:
    def test_stop_when_not_recording_does_nothing(self) -> None:
        SessionRecorder().stop()

    def test_stop_twice_writes_one_footer(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        runtime = Runtime()
        recorder = SessionRecorder()
        recorder.start(runtime.subscribe, runtime.start_session(), path)

        recorder.stop()
        recorder.stop()

        assert [line["type"] for line in lines_of(path)].count("footer") == 1

    def test_starting_while_recording_is_a_no_op(self, tmp_path: Path) -> None:
        first, second = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
        runtime = Runtime()
        session = runtime.start_session()
        recorder = SessionRecorder()
        recorder.start(runtime.subscribe, session, first)
        recorder.start(runtime.subscribe, session, second)
        runtime.publish(event())
        recorder.stop()

        assert not second.exists()
        assert [line["type"] for line in lines_of(first)].count("header") == 1
        assert len([ln for ln in lines_of(first) if ln["type"] == "event"]) == 1

    def test_creates_missing_parent_directories(self, tmp_path: Path) -> None:
        path = tmp_path / "deep" / "er" / "s.jsonl"
        record(path, lambda r: None)
        assert path.is_file()

    def test_appends_to_an_existing_file_as_the_node_recorder_does(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        record(path, lambda r: r.publish(event()))
        record(path, lambda r: r.publish(event()))

        assert [line["type"] for line in lines_of(path)].count("header") == 2

    def test_an_unopenable_path_raises_to_the_caller(self, tmp_path: Path) -> None:
        runtime = Runtime()
        with pytest.raises(OSError):
            SessionRecorder().start(runtime.subscribe, runtime.start_session(), tmp_path)

    def test_stops_receiving_events_after_stop(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        runtime = Runtime()
        recorder = SessionRecorder()
        recorder.start(runtime.subscribe, runtime.start_session(), path)
        runtime.publish(event("kept"))
        recorder.stop()
        runtime.publish(event("late"))

        kinds = [
            ln["envelope"]["payload"]["kind"] for ln in lines_of(path) if ln["type"] == "event"
        ]
        assert kinds == ["kept"]

    def test_concurrent_producers_lose_nothing_and_stay_in_order(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"

        def publish(runtime: Runtime) -> None:
            def work() -> None:
                for _ in range(500):
                    runtime.publish(event())

            threads = [threading.Thread(target=work) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        record(path, publish)

        sequences = [ln["envelope"]["sequence"] for ln in lines_of(path) if ln["type"] == "event"]
        assert len(sequences) == 3000
        assert sequences == sorted(sequences)
        assert len(set(sequences)) == 3000


class TestBoundedMemory:
    def test_a_stuck_disk_drops_events_instead_of_growing_without_bound(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        gate = threading.Event()

        class StuckRecorder(SessionRecorder):
            def _write_loop(self) -> None:
                gate.wait(timeout=10)  # the writer cannot make progress
                super()._write_loop()

        path = tmp_path / "s.jsonl"
        runtime = Runtime()
        recorder = StuckRecorder(max_queued=3)
        recorder.start(runtime.subscribe, runtime.start_session(), path)

        with caplog.at_level("WARNING", logger="wevna.recording"):
            for _ in range(50):
                runtime.publish(event())
        assert recorder.dropped_count == 47
        # One warning, not fifty: a flood of log lines would hide the problem.
        assert caplog.text.count("queue is full") == 1

        gate.set()
        recorder.stop()
        # The footer counts what was actually written, so the reader sees a
        # recording that is consistent with itself rather than a count mismatch.
        lines = lines_of(path)
        assert len([ln for ln in lines if ln["type"] == "event"]) == 3
        assert lines[-1]["eventCount"] == 3

    def test_a_writer_still_stuck_at_stop_gets_no_footer_and_raises_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # stop() waits a bounded time for the writer. A footer written while the
        # writer is still going would land between its lines, so it is left off.
        import wevna.recording as recording_module

        monkeypatch.setattr(recording_module, "STOP_TIMEOUT_SECONDS", 0.2)
        gate = threading.Event()

        class StuckRecorder(SessionRecorder):
            def _write_loop(self) -> None:
                gate.wait(timeout=10)
                super()._write_loop()

        path = tmp_path / "s.jsonl"
        runtime = Runtime()
        recorder = StuckRecorder()
        recorder.start(runtime.subscribe, runtime.start_session(), path)
        thread = recorder._thread
        runtime.publish(event())

        recorder.stop()  # must return, and must not raise
        gate.set()
        assert thread is not None
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert [ln["type"] for ln in lines_of(path)] == ["header"]


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
class TestForkedWorkers:
    def test_a_forked_child_neither_writes_nor_closes_the_parents_recording(
        self, tmp_path: Path
    ) -> None:
        import warnings

        path = tmp_path / "s.jsonl"
        runtime = Runtime()
        recorder = SessionRecorder()
        recorder.start(runtime.subscribe, runtime.start_session(), path)
        runtime.publish(event("parent-before"))

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            pid = os.fork()
        if pid == 0:
            code = 1
            try:
                for _ in range(100):
                    runtime.publish(event("child"))
                recorder.stop()  # must not write a footer into the parent's file
                code = 0
            finally:
                os._exit(code)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0

        runtime.publish(event("parent-after"))
        recorder.stop()

        lines = lines_of(path)
        kinds = [ln["envelope"]["payload"]["kind"] for ln in lines if ln["type"] == "event"]
        assert kinds == ["parent-before", "parent-after"]
        assert [ln["type"] for ln in lines].count("footer") == 1
        assert lines[-1]["eventCount"] == 2


class TestPublicApi:
    def test_start_recording_after_start_records_until_stop(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        wevna.start(port=0, capture_logging=False)
        wevna.start_recording(path)
        assert wevna.is_recording()
        wevna.default_runtime().publish(event())
        wevna.stop_recording()

        assert not wevna.is_recording()
        assert [line["type"] for line in lines_of(path)] == ["header", "event", "footer"]

    def test_start_recording_before_start_waits_instead_of_raising(self, tmp_path: Path) -> None:
        # The Node SDK queues this call rather than throwing, because every other
        # call made before start() is safe and a recording should not be the one
        # that breaks the rule.
        path = tmp_path / "s.jsonl"
        wevna.start_recording(path)
        assert not wevna.is_recording()
        assert not path.exists()

        result = wevna.start(port=0, capture_logging=False)
        assert wevna.is_recording()
        wevna.default_runtime().publish(event())
        wevna.stop()

        lines = lines_of(path)
        assert lines[0]["session"]["id"] == result.session_id
        assert [line["type"] for line in lines] == ["header", "event", "footer"]

    def test_only_the_first_request_before_start_begins_a_recording(self, tmp_path: Path) -> None:
        first, second = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
        wevna.start_recording(first)
        wevna.start_recording(second)
        wevna.start(port=0, capture_logging=False)
        wevna.stop()

        assert first.exists()
        assert not second.exists()

    def test_a_recording_requested_before_start_that_cannot_open_does_not_break_start(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        wevna.start_recording(tmp_path)  # a directory: cannot be opened as a file
        with caplog.at_level("ERROR", logger="wevna.api"):
            result = wevna.start(port=0, capture_logging=False)

        assert result.url
        assert not wevna.is_recording()
        assert "could not start the recording" in caplog.text

    def test_start_recording_after_start_raises_if_the_file_cannot_be_opened(
        self, tmp_path: Path
    ) -> None:
        wevna.start(port=0, capture_logging=False)
        with pytest.raises(OSError):
            wevna.start_recording(tmp_path)

    def test_stop_finalizes_a_recording_in_progress(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        wevna.start(port=0, capture_logging=False)
        wevna.start_recording(path)
        wevna.default_runtime().publish(event())

        wevna.stop()

        assert lines_of(path)[-1]["type"] == "footer"

    def test_stop_recording_when_not_recording_is_safe(self) -> None:
        wevna.stop_recording()
        wevna.stop_recording()

    def test_logging_output_is_recorded_too(self, tmp_path: Path) -> None:
        import logging

        path = tmp_path / "s.jsonl"
        wevna.start(port=0)
        wevna.start_recording(path)
        logging.getLogger("app").warning("disk almost full")
        wevna.stop()

        kinds = [
            ln["envelope"]["payload"]["kind"] for ln in lines_of(path) if ln["type"] == "event"
        ]
        assert "log.record" in kinds

    def test_a_process_that_exits_without_stopping_still_gets_a_footer(
        self, tmp_path: Path
    ) -> None:
        # Python programs usually just end. Without an exit hook the recording
        # would have no footer and read as though the process had crashed.
        path = tmp_path / "s.jsonl"
        script = (
            "import wevna\n"
            "wevna.start(port=0, capture_logging=False)\n"
            f"wevna.start_recording({str(path)!r})\n"
            "from wevna.protocol import CapturedEvent\n"
            "wevna.default_runtime().publish(CapturedEvent(id='e', kind='x', occurred_at=1))\n"
        )
        subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, timeout=60)

        lines = lines_of(path)
        assert lines[-1]["type"] == "footer"
        assert lines[-1]["eventCount"] == 1


class TestLoader:
    def written(self, tmp_path: Path, count: int = 3) -> Path:
        path = tmp_path / "s.jsonl"

        def publish(runtime: Runtime) -> None:
            for _ in range(count):
                runtime.publish(event())

        record(path, publish)
        return path

    def test_reads_back_what_the_recorder_wrote(self, tmp_path: Path) -> None:
        path = self.written(tmp_path)

        loader = SessionLoader(path)
        metadata = loader.open()
        events = list(loader.events())

        assert metadata.format_version == RECORDING_FORMAT_VERSION
        assert [e.envelope.sequence for e in events] == [0, 1, 2]
        assert [e.line_number for e in events] == [2, 3, 4]
        assert loader.issues == []
        assert loader.errors == []
        assert loader.metadata is not None
        assert loader.metadata.event_count == 3
        assert loader.metadata.recording_ended_at is not None

    def test_a_round_trip_preserves_every_field(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        sent = CapturedEvent(
            id="e1",
            kind="http.request",
            occurred_at=1234,
            attributes={"method": "GET", "nested": {"a": [1, 2, None]}},
            correlation=Correlation(id="c1"),
            source="wevna:x",
        )
        record(path, lambda r: r.publish(sent))

        loader = SessionLoader(path)
        loader.open()
        [recorded] = list(loader.events())

        assert recorded.envelope.payload == sent

    @pytest.mark.parametrize(
        ("content", "error_type"),
        [
            ("", "empty-file"),
            ("not json\n", "invalid-json"),
            ('{"type":"event"}\n', "invalid-record-shape"),
            ('{"type":"mystery"}\n', "invalid-record-shape"),
            (
                json.dumps(
                    {
                        "type": "header",
                        "formatVersion": 99,
                        "protocolVersion": PROTOCOL_VERSION,
                        "session": {"id": "s", "startedAt": 1, "status": "running"},
                        "recordingStartedAt": 1,
                    }
                )
                + "\n",
                "unsupported-format-version",
            ),
            (
                json.dumps(
                    {
                        "type": "header",
                        "formatVersion": RECORDING_FORMAT_VERSION,
                        "protocolVersion": 99,
                        "session": {"id": "s", "startedAt": 1, "status": "running"},
                        "recordingStartedAt": 1,
                    }
                )
                + "\n",
                "unsupported-protocol-version",
            ),
        ],
    )
    def test_open_reports_the_same_error_types_as_the_node_loader(
        self, tmp_path: Path, content: str, error_type: str
    ) -> None:
        path = tmp_path / "bad.jsonl"
        path.write_text(content)

        with pytest.raises(RecordingError) as raised:
            SessionLoader(path).open()

        assert raised.value.type == error_type

    def test_a_missing_file_is_an_io_error(self, tmp_path: Path) -> None:
        with pytest.raises(RecordingError) as raised:
            SessionLoader(tmp_path / "nope.jsonl").open()
        assert raised.value.type == "io-error"

    def test_a_malformed_line_in_the_middle_is_skipped_and_reported_not_fatal(
        self, tmp_path: Path
    ) -> None:
        path = self.written(tmp_path)
        rows = path.read_text().splitlines()
        rows.insert(2, "{ this is not json")
        rows.insert(3, json.dumps({"type": "event", "envelope": {"version": 1}}))
        path.write_text("\n".join(rows) + "\n")

        loader = SessionLoader(path)
        loader.open()
        events = list(loader.events())

        assert len(events) == 3
        assert [e.type for e in loader.errors] == ["invalid-json", "invalid-record-shape"]
        assert [e.line_number for e in loader.errors] == [3, 4]

    def test_a_recording_cut_short_by_a_crash_is_readable_up_to_the_last_full_line(
        self, tmp_path: Path
    ) -> None:
        path = self.written(tmp_path, count=4)
        rows = path.read_text().splitlines()
        # Lose the footer and half of the last event, as a killed process would.
        crashed = "\n".join(rows[:-2]) + "\n" + rows[-2][: len(rows[-2]) // 2]
        path.write_text(crashed)

        loader = SessionLoader(path)
        loader.open()
        events = list(loader.events())

        assert len(events) == 3
        assert [i.type for i in loader.issues] == ["missing-footer"]
        assert [e.type for e in loader.errors] == ["invalid-json"]

    def test_issues_for_a_count_mismatch_and_out_of_order_sequences(self, tmp_path: Path) -> None:
        path = self.written(tmp_path)
        rows = path.read_text().splitlines()
        footer = json.loads(rows[-1])
        footer["eventCount"] = 9
        rows[-1] = json.dumps(footer)
        rows[3], rows[2] = rows[2], rows[3]  # swap two events: sequence goes backwards
        path.write_text("\n".join(rows) + "\n")

        loader = SessionLoader(path)
        loader.open()
        list(loader.events())

        assert sorted(i.type for i in loader.issues) == ["event-count-mismatch", "sequence-gap"]

    def test_events_before_open_is_a_programming_error(self, tmp_path: Path) -> None:
        with pytest.raises(RuntimeError):
            list(SessionLoader(tmp_path / "x").events())

    def test_a_large_recording_is_streamed_not_loaded(self, tmp_path: Path) -> None:
        # Written directly rather than through the recorder: this test is about
        # reading, and should not depend on how fast a writer thread keeps up.
        path = tmp_path / "big.jsonl"
        runtime = Runtime()
        lines = [dumps_wire(recording_header(runtime.start_session()))]
        for sequence in range(20_000):
            envelope = Envelope(session_id="s", sequence=sequence, payload=event(blob="x" * 200))
            lines.append(dumps_wire(recording_event(envelope)))
        path.write_text("\n".join(lines) + "\n")

        loader = SessionLoader(path)
        loader.open()
        iterator = loader.events()
        first = next(iterator)

        assert first.line_number == 2
        assert sum(1 for _ in iterator) == 19_999


def get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


class TestReplayServing:
    def test_serves_a_recording_the_way_the_node_server_does(
        self, tmp_path: Path, schema: dict[str, Any]
    ) -> None:
        path = tmp_path / "s.jsonl"

        def publish_three(runtime: Runtime) -> None:
            for kind in ("a", "b", "c"):
                runtime.publish(event(kind))

        record(path, publish_three)

        with wevna.open_recording(path, port=0) as opened:
            info = get_json(f"{opened.url}/api/session")
            body = get_json(f"{opened.url}/api/session/events")

        assert info["mode"] == "recording"
        assert info["metadata"]["eventCount"] == 3
        assert info["metadata"]["recordingEndedAt"] is not None
        assert info["metadata"]["formatVersion"] == RECORDING_FORMAT_VERSION
        assert [e["payload"]["kind"] for e in body["events"]] == ["a", "b", "c"]
        validator = Draft202012Validator(
            {"$ref": "#/$defs/EventEnvelope", "$defs": schema["$defs"]}
        )
        for envelope in body["events"]:
            assert list(validator.iter_errors(envelope)) == []

    def test_a_live_server_says_so(self) -> None:
        result = wevna.start(port=0, capture_logging=False)
        assert get_json(f"{result.url}/api/session") == {"mode": "live"}

    def test_a_recording_server_has_no_websocket(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        record(path, lambda r: None)

        with (
            wevna.open_recording(path, port=0) as opened,
            pytest.raises(urllib.error.HTTPError) as missing,
        ):
            urllib.request.urlopen(f"{opened.url}/ws", timeout=5)

        assert missing.value.code in (403, 404, 426)

    def test_serves_a_recording_with_no_events(self, tmp_path: Path) -> None:
        path = tmp_path / "s.jsonl"
        record(path, lambda r: None)

        with wevna.open_recording(path, port=0) as opened:
            assert get_json(f"{opened.url}/api/session/events") == {"events": []}

    def test_a_bad_file_raises_a_structured_error(self, tmp_path: Path) -> None:
        path = tmp_path / "bad.jsonl"
        path.write_text("garbage\n")

        with pytest.raises(RecordingError) as raised:
            wevna.open_recording(path, port=0)

        assert raised.value.type == "invalid-json"

    def test_the_host_guard_covers_the_replay_routes_too(self, tmp_path: Path) -> None:
        import http.client

        path = tmp_path / "s.jsonl"
        record(path, lambda r: r.publish(event()))

        with wevna.open_recording(path, port=0) as opened:
            port = int(opened.url.rsplit(":", 1)[1])
            connection = http.client.HTTPConnection("localhost", port, timeout=5)
            connection.putrequest("GET", "/api/session/events", skip_host=True)
            connection.putheader("Host", "evil.example.com")
            connection.endheaders()
            status = connection.getresponse().status
            connection.close()

        assert status == 403

    def test_replay_serves_what_a_recording_of_a_whole_session_contained(
        self, tmp_path: Path
    ) -> None:
        # The loop a user actually runs: record a session, then replay it.
        path = tmp_path / "s.jsonl"
        wevna.start(port=0, capture_logging=False)
        wevna.start_recording(path)
        runtime = wevna.default_runtime()
        for index in range(25):
            runtime.publish(event("sql.query", n=index))
        wevna.stop()

        with wevna.open_recording(path, port=0) as opened:
            body = get_json(f"{opened.url}/api/session/events")

        assert [e["payload"]["attributes"]["n"] for e in body["events"]] == list(range(25))
        assert [e["sequence"] for e in body["events"]] == sorted(
            e["sequence"] for e in body["events"]
        )


def test_session_roundtrips_through_the_wire() -> None:
    session = Session(id="s", started_at=1, status="running")
    assert Session.from_wire(session.to_wire()) == session


def test_envelope_roundtrips_through_the_wire() -> None:
    envelope = Envelope(session_id="s", sequence=4, payload=event())
    assert Envelope.from_wire(envelope.to_wire()) == envelope
