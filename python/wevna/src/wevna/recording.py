"""Session recording and loading: the ``.jsonl`` format, in Python.

A recording is JSON Lines: one header, then one line per event, then a footer
written on a clean stop. It is the same format the Node SDK writes
(``packages/sdk/src/session-recorder.ts``), validated by the same schema and
fixtures, so a recording made by either SDK opens in either one and replays in
the same dashboard.

``SessionRecorder`` writes. ``SessionLoader`` reads, and reports problems with
the same error types as the Node loader, so the two cannot disagree about what a
bad recording is.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypeGuard

from wevna.protocol import (
    PROTOCOL_VERSION,
    RECORDING_FORMAT_VERSION,
    Envelope,
    Session,
    dumps_wire,
    now_ms,
    recording_event,
    recording_footer,
    recording_header,
)

_log = logging.getLogger("wevna.recording")

# The same bound the dashboard's own queue has, for the same reason: a recording
# to a slow or stuck disk must cost a bounded amount of memory, not grow until
# the process dies. Past it events are dropped and counted.
MAX_QUEUED_EVENTS = 10_000

# How long stop() waits for the writer thread to drain before giving up on it.
STOP_TIMEOUT_SECONDS = 10.0

# Most lines the writer thread writes in one call.
WRITE_BATCH = 500

Subscribe = Callable[[Callable[[Envelope], None]], Callable[[], None]]


class SessionRecorder:
    """Writes the events of one session to a file, on a background thread.

    Events are serialized on the calling thread (so a producer that mutates its
    attributes afterwards cannot change what was recorded) and written by a
    writer thread, so a slow disk never delays the application. The queue is
    bounded; see ``MAX_QUEUED_EVENTS``.

    ``start`` and ``stop`` are idempotent, as in the Node recorder: starting
    while recording is a no-op, and stopping when not recording does nothing.
    """

    def __init__(self, *, max_queued: int = MAX_QUEUED_EVENTS) -> None:
        self._max_queued = max_queued
        self._lock = threading.Lock()
        self._queue: queue.Queue[str] = queue.Queue(maxsize=max_queued)
        self._file: Any = None
        self._thread: threading.Thread | None = None
        self._unsubscribe: Callable[[], None] | None = None
        self._closing = threading.Event()
        self._owner_pid: int | None = None
        self._warned_forked = False
        self._warned_dropped = False
        self._failed = False
        self._written = 0
        self._dropped = 0
        self.path: Path | None = None

    @property
    def is_recording(self) -> bool:
        return self._file is not None

    @property
    def event_count(self) -> int:
        """Events written to the file so far."""
        return self._written

    @property
    def dropped_count(self) -> int:
        """Events not recorded because the queue was full."""
        return self._dropped

    def start(self, subscribe: Subscribe, session: Session, path: str | os.PathLike[str]) -> None:
        """Opens ``path`` for appending, writes the header, and starts recording.

        Raises ``OSError`` if the file cannot be opened: the caller asked for a
        recording explicitly, so failing to make one is theirs to know about.
        """
        with self._lock:
            if self._file is not None:
                return

            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Appended, as in the Node recorder. Line-buffered, so every line is
            # on its way to disk as soon as it is written and a recording cut
            # short by a crash stays readable up to its last full line.
            handle = open(target, "a", encoding="utf-8", newline="\n", buffering=1)  # noqa: SIM115
            try:
                handle.write(dumps_wire(recording_header(session)) + "\n")
            except Exception:
                handle.close()
                raise

            self.path = target
            self._file = handle
            self._owner_pid = os.getpid()
            self._written = 0
            self._dropped = 0
            self._failed = False
            self._warned_forked = False
            self._warned_dropped = False
            self._closing = threading.Event()
            self._queue = queue.Queue(maxsize=self._max_queued)
            self._thread = threading.Thread(
                target=self._write_loop, name="wevna-recorder", daemon=True
            )
            self._thread.start()
            self._unsubscribe = subscribe(self._on_event)

    def stop(self) -> None:
        """Writes the footer and closes the file. Safe when not recording."""
        with self._lock:
            handle = self._file
            if handle is None:
                return

            if self._owner_pid != os.getpid():
                # A forked child. The file handle is shared with the parent, which
                # owns the recording and writes its footer; writing one here would
                # put a second footer in the middle of someone else's file.
                self._file = None
                return

            unsubscribe, self._unsubscribe = self._unsubscribe, None
            if unsubscribe is not None:
                unsubscribe()
            self._closing.set()
            thread, self._thread = self._thread, None
            if thread is not None:
                thread.join(timeout=STOP_TIMEOUT_SECONDS)
                if thread.is_alive():
                    # The writer is stuck on a slow disk. A footer written now would
                    # land between its lines, so leave it off: the loader reports a
                    # missing footer, which is the truth about this recording.
                    self._failed = True
                    _log.warning("the recording writer did not finish; closing without a footer")
            self._file = None

            try:
                if not self._failed:
                    handle.write(dumps_wire(recording_footer(self._written, now_ms())) + "\n")
            except OSError:
                _log.exception("could not write the recording footer")
            finally:
                handle.close()

    def _on_event(self, envelope: Envelope) -> None:
        """Called by the runtime for every event. Never raises, never blocks."""
        if self._file is None or self._failed:
            return

        if self._owner_pid != os.getpid():
            # A forked worker inherits this recorder and its file handle but not
            # the thread that writes to it. Queueing here would never be drained,
            # and writing from here would interleave with the parent. Drop, and
            # say so once, as the dashboard server does.
            if not self._warned_forked:
                self._warned_forked = True
                _log.warning(
                    "this process was forked after wevna.start_recording(), so its events "
                    "are not recorded: the recording belongs to the process that started it."
                )
            return

        try:
            line = dumps_wire(recording_event(envelope))
        except (TypeError, ValueError):
            _log.exception(
                "did not record a %r event that could not be serialized", envelope.payload.kind
            )
            return

        try:
            self._queue.put_nowait(line)
        except queue.Full:
            self._dropped += 1
            if not self._warned_dropped:
                self._warned_dropped = True
                _log.warning("the recording queue is full; dropping events until it drains")

    def _write_loop(self) -> None:
        handle = self._file
        while True:
            try:
                line = self._queue.get(timeout=0.1)
            except queue.Empty:
                if self._closing.is_set():
                    return
                continue
            # Take whatever else is already waiting and write it in one call. Under
            # a burst the producer outruns a writer that does one write per event,
            # and the queue fills; one write per batch keeps up far better.
            batch = [line]
            while len(batch) < WRITE_BATCH:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            if self._failed or handle is None:
                continue  # keep draining so a failed disk cannot grow memory
            try:
                handle.write("".join(f"{item}\n" for item in batch))
                self._written += len(batch)
            except (OSError, ValueError):
                # The disk went away or filled (OSError), or stop() gave up waiting
                # and closed the file under us (ValueError). Stop recording rather than raise
                # into the application, as the Node recorder does on a stream
                # error, and keep draining.
                self._failed = True
                _log.exception("recording stopped: could not write to %s", self.path)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

LoaderErrorType = Literal[
    "io-error",
    "empty-file",
    "invalid-json",
    "invalid-record-shape",
    "unsupported-format-version",
    "unsupported-protocol-version",
]


class RecordingError(Exception):
    """A recording could not be read. ``type`` matches the Node loader's types."""

    def __init__(self, type: LoaderErrorType, message: str, line_number: int | None = None) -> None:
        super().__init__(message)
        self.type: LoaderErrorType = type
        self.line_number = line_number


@dataclass(frozen=True, slots=True)
class SessionMetadata:
    session: Session
    format_version: int
    protocol_version: int
    recording_started_at: int
    recording_ended_at: int | None = None
    event_count: int | None = None

    def to_wire(self) -> dict[str, Any]:
        """The shape the dashboard's ``/api/session`` response carries."""
        return {
            "session": self.session.to_wire(),
            "formatVersion": self.format_version,
            "protocolVersion": self.protocol_version,
            "recordingStartedAt": self.recording_started_at,
            "recordingEndedAt": self.recording_ended_at,
            "eventCount": self.event_count,
        }


@dataclass(frozen=True, slots=True)
class LoaderIssue:
    """Something worth noting that did not stop the recording being read."""

    type: Literal["sequence-gap", "event-count-mismatch", "missing-footer"]
    message: str


@dataclass(frozen=True, slots=True)
class RecordedEvent:
    envelope: Envelope
    line_number: int


@dataclass
class _LoaderState:
    metadata: SessionMetadata | None = None
    issues: list[LoaderIssue] = field(default_factory=list)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _as_int(value: Any) -> int | None:
    return int(value) if _is_number(value) else None


def _is_valid_envelope(value: Any) -> TypeGuard[dict[str, Any]]:
    if not isinstance(value, dict):
        return False
    if (
        not _is_number(value.get("version"))
        or not isinstance(value.get("sessionId"), str)
        or not _is_number(value.get("sequence"))
    ):
        return False
    payload = value.get("payload")
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("id"), str)
        and isinstance(payload.get("kind"), str)
        and _is_number(payload.get("occurredAt"))
        and isinstance(payload.get("attributes"), dict)
    )


def _parse_line(raw: str, line_number: int) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise RecordingError(
            "invalid-json", f"Line {line_number} is not valid JSON.", line_number
        ) from None
    if not isinstance(parsed, dict) or parsed.get("type") not in ("header", "event", "footer"):
        raise RecordingError(
            "invalid-record-shape",
            f"Line {line_number} is not a recognized recording record.",
            line_number,
        )
    return parsed


class SessionLoader:
    """Reads a recording written by either SDK.

    ``open()`` reads and validates the header and returns the metadata, raising
    ``RecordingError`` if the file cannot be used at all. ``events()`` then
    streams the events without loading the file into memory. A malformed line
    in the middle is skipped and recorded in ``errors`` rather than ending the
    read, and smaller concerns (a missing footer, a count that does not match)
    land in ``issues``, available once ``events()`` has run to the end.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._state = _LoaderState()
        self.errors: list[RecordingError] = []

    @property
    def metadata(self) -> SessionMetadata | None:
        return self._state.metadata

    @property
    def issues(self) -> list[LoaderIssue]:
        return self._state.issues

    def open(self) -> SessionMetadata:
        try:
            with open(self.path, encoding="utf-8") as handle:
                first = handle.readline()
        except OSError as error:
            raise RecordingError("io-error", str(error)) from error
        except UnicodeDecodeError as error:
            raise RecordingError("invalid-json", "Line 1 is not valid UTF-8 text.", 1) from error

        if first == "":
            raise RecordingError("empty-file", "Recording file is empty.")

        header = _parse_line(first, 1)
        if header["type"] != "header":
            raise RecordingError(
                "invalid-record-shape", "The first line of the recording is not a header.", 1
            )
        if header.get("formatVersion") != RECORDING_FORMAT_VERSION:
            raise RecordingError(
                "unsupported-format-version",
                f"Recording format version {header.get('formatVersion')} is not supported by "
                f"this build (expected {RECORDING_FORMAT_VERSION}).",
            )
        if header.get("protocolVersion") != PROTOCOL_VERSION:
            raise RecordingError(
                "unsupported-protocol-version",
                f"Recording protocol version {header.get('protocolVersion')} is not supported by "
                f"this build (expected {PROTOCOL_VERSION}).",
            )

        session = header.get("session")
        started = _as_int(header.get("recordingStartedAt"))
        if not isinstance(session, dict) or started is None:
            raise RecordingError("invalid-record-shape", "The recording header is malformed.", 1)

        try:
            parsed_session = Session.from_wire(session)
        except (KeyError, TypeError):
            raise RecordingError(
                "invalid-record-shape", "The recording header is malformed.", 1
            ) from None

        self._state.metadata = SessionMetadata(
            session=parsed_session,
            format_version=header["formatVersion"],
            protocol_version=header["protocolVersion"],
            recording_started_at=started,
        )
        return self._state.metadata

    def events(self) -> Iterator[RecordedEvent]:
        metadata = self._state.metadata
        if metadata is None:
            raise RuntimeError("SessionLoader.events() called before open() succeeded.")

        self._state.issues = []
        self.errors = []
        last_sequence: float | None = None
        event_count = 0
        saw_footer = False

        try:
            handle = open(self.path, encoding="utf-8")  # noqa: SIM115
        except OSError as error:
            self.errors.append(RecordingError("io-error", str(error)))
            return

        with handle:
            for line_number, raw in enumerate(handle, start=1):
                if line_number == 1:
                    continue  # the header, already validated by open()
                raw = raw.rstrip("\r\n")
                if raw == "":
                    continue

                try:
                    record = _parse_line(raw, line_number)
                except RecordingError as error:
                    self.errors.append(error)
                    continue

                if record["type"] == "footer":
                    saw_footer = True
                    count = record.get("eventCount")
                    ended = record.get("recordingEndedAt")
                    self._state.metadata = SessionMetadata(
                        session=metadata.session,
                        format_version=metadata.format_version,
                        protocol_version=metadata.protocol_version,
                        recording_started_at=metadata.recording_started_at,
                        recording_ended_at=_as_int(ended),
                        event_count=_as_int(count),
                    )
                    if count != event_count:
                        self._state.issues.append(
                            LoaderIssue(
                                "event-count-mismatch",
                                f"Footer reports {count} events, but {event_count} were "
                                "actually read.",
                            )
                        )
                    continue

                if record["type"] != "event":
                    self.errors.append(
                        RecordingError(
                            "invalid-record-shape",
                            f'Unexpected "{record["type"]}" record after the header.',
                            line_number,
                        )
                    )
                    continue

                wire = record.get("envelope")
                if not _is_valid_envelope(wire):
                    self.errors.append(
                        RecordingError(
                            "invalid-record-shape",
                            f"Line {line_number} has a malformed event envelope.",
                            line_number,
                        )
                    )
                    continue

                envelope = Envelope.from_wire(wire)
                if last_sequence is not None and envelope.sequence <= last_sequence:
                    self._state.issues.append(
                        LoaderIssue(
                            "sequence-gap",
                            f"Event at line {line_number} has sequence {envelope.sequence}, "
                            f"not greater than the previous event's {last_sequence}.",
                        )
                    )
                last_sequence = envelope.sequence
                event_count += 1
                yield RecordedEvent(envelope=envelope, line_number=line_number)

        if not saw_footer:
            self._state.issues.append(
                LoaderIssue(
                    "missing-footer",
                    "Recording has no footer: it may have stopped abnormally "
                    "(for example, the process crashed while recording).",
                )
            )
