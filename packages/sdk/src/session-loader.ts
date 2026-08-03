import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  type CapturedEvent,
  type Envelope,
  PROTOCOL_VERSION,
  RECORDING_FORMAT_VERSION,
  type RecordingLine,
  type Session,
} from "@wevna/protocol";

export type SessionLoaderErrorType =
  | "io-error"
  | "empty-file"
  | "invalid-json"
  | "invalid-record-shape"
  | "unsupported-format-version"
  | "unsupported-protocol-version";

// Structured, not thrown — see SessionLoader's own doc comment for why.
export interface SessionLoaderError {
  type: SessionLoaderErrorType;
  message: string;
  lineNumber?: number;
}

export interface SessionMetadata {
  session: Session;
  formatVersion: number;
  protocolVersion: number;
  recordingStartedAt: number;
  // Only known once events() has streamed through to the footer (or
  // reached the end of the file without one) — undefined right after
  // open(), which only reads the header.
  recordingEndedAt: number | undefined;
  eventCount: number | undefined;
}

export type OpenSessionResult =
  | { ok: true; metadata: SessionMetadata }
  | { ok: false; error: SessionLoaderError };

export interface RecordedEvent {
  envelope: Envelope<CapturedEvent>;
  lineNumber: number;
}

export type ReadEventResult =
  | { ok: true; event: RecordedEvent }
  | { ok: false; error: SessionLoaderError };

// A validation concern serious enough to note but not to abort the read
// over — the underlying data is still readable and worth showing. Only
// fully known once events() has streamed to completion (or as far as the
// file goes).
export interface SessionLoaderIssue {
  type: "sequence-gap" | "event-count-mismatch" | "missing-footer";
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidEnvelope(value: unknown): value is Envelope<CapturedEvent> {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.version !== "number" ||
    typeof value.sessionId !== "string" ||
    typeof value.sequence !== "number"
  ) {
    return false;
  }
  if (!isRecord(value.payload)) {
    return false;
  }
  const payload = value.payload;
  return (
    typeof payload.id === "string" &&
    typeof payload.kind === "string" &&
    typeof payload.occurredAt === "number" &&
    isRecord(payload.attributes)
  );
}

function parseLine(
  raw: string,
  lineNumber: number,
): { ok: true; line: RecordingLine } | { ok: false; error: SessionLoaderError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: { type: "invalid-json", message: `Line ${lineNumber} is not valid JSON.`, lineNumber },
    };
  }

  if (
    !isRecord(parsed) ||
    (parsed.type !== "header" && parsed.type !== "event" && parsed.type !== "footer")
  ) {
    return {
      ok: false,
      error: {
        type: "invalid-record-shape",
        message: `Line ${lineNumber} is not a recognized recording record.`,
        lineNumber,
      },
    };
  }

  return { ok: true, line: parsed as unknown as RecordingLine };
}

// The read side of exactly what SessionRecorder writes — streams a
// recording file line by line via node:readline over a real filesystem
// read stream, never reading the whole file into memory, so a very large
// recording is exactly as practical to open as a small one.
//
// Never throws for anything about the *recording itself* being invalid —
// a malformed line, an unsupported version, a missing footer are all
// facts a caller needs to handle gracefully (this is meant to open files
// a developer hands it, not files this process wrote), so they come back
// as structured OpenSessionResult/ReadEventResult values instead. The one
// exception is calling events() before open() has succeeded, which is a
// programming error in the caller, not a fact about the file — that still
// throws.
export class SessionLoader {
  readonly filePath: string;
  #metadata: SessionMetadata | undefined;
  #issues: SessionLoaderIssue[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get metadata(): SessionMetadata | undefined {
    return this.#metadata;
  }

  get issues(): readonly SessionLoaderIssue[] {
    return this.#issues;
  }

  // Reads and validates only the first line — cheap, and never touches
  // the rest of the file. Safe to call more than once (re-reads the
  // header each time). Must succeed before events() is iterated.
  async open(): Promise<OpenSessionResult> {
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    let firstLine: string | undefined;
    try {
      for await (const line of rl) {
        firstLine = line;
        break;
      }
    } catch (error) {
      return { ok: false, error: toIoError(error) };
    } finally {
      rl.close();
      stream.destroy();
    }

    if (firstLine === undefined) {
      return { ok: false, error: { type: "empty-file", message: "Recording file is empty." } };
    }

    const parsed = parseLine(firstLine, 1);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.line.type !== "header") {
      return {
        ok: false,
        error: {
          type: "invalid-record-shape",
          message: "The first line of the recording is not a header.",
          lineNumber: 1,
        },
      };
    }

    const header = parsed.line;
    if (header.formatVersion !== RECORDING_FORMAT_VERSION) {
      return {
        ok: false,
        error: {
          type: "unsupported-format-version",
          message: `Recording format version ${header.formatVersion} is not supported by this build (expected ${RECORDING_FORMAT_VERSION}).`,
        },
      };
    }
    if (header.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        error: {
          type: "unsupported-protocol-version",
          message: `Recording protocol version ${header.protocolVersion} is not supported by this build (expected ${PROTOCOL_VERSION}).`,
        },
      };
    }

    this.#metadata = {
      session: header.session,
      formatVersion: header.formatVersion,
      protocolVersion: header.protocolVersion,
      recordingStartedAt: header.recordingStartedAt,
      recordingEndedAt: undefined,
      eventCount: undefined,
    };
    return { ok: true, metadata: this.#metadata };
  }

  // Streams every event line after the header, in file order. Independent
  // each call — re-opens its own read stream from the start of the file,
  // so calling this more than once (e.g. to serve more than one HTTP
  // request from the same loader) re-reads rather than replaying a cached
  // copy. issues/metadata's recordingEndedAt/eventCount are recomputed
  // fresh at the start of every call for the same reason.
  async *events(): AsyncGenerator<ReadEventResult> {
    const metadata = this.#metadata;
    if (!metadata) {
      throw new Error("SessionLoader.events() called before open() succeeded.");
    }
    this.#issues = [];

    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    let lineNumber = 0;
    let lastSequence: number | undefined;
    let eventCount = 0;
    let sawFooter = false;

    try {
      for await (const raw of rl) {
        lineNumber += 1;
        if (lineNumber === 1) {
          continue; // the header — already read and validated by open()
        }

        const parsed = parseLine(raw, lineNumber);
        if (!parsed.ok) {
          yield parsed;
          continue;
        }

        if (parsed.line.type === "footer") {
          sawFooter = true;
          this.#metadata = {
            ...metadata,
            recordingEndedAt: parsed.line.recordingEndedAt,
            eventCount: parsed.line.eventCount,
          };
          if (parsed.line.eventCount !== eventCount) {
            this.#issues.push({
              type: "event-count-mismatch",
              message: `Footer reports ${parsed.line.eventCount} events, but ${eventCount} were actually read.`,
            });
          }
          continue;
        }

        if (parsed.line.type !== "event") {
          yield {
            ok: false,
            error: {
              type: "invalid-record-shape",
              message: `Unexpected "${parsed.line.type}" record after the header.`,
              lineNumber,
            },
          };
          continue;
        }

        if (!isValidEnvelope(parsed.line.envelope)) {
          yield {
            ok: false,
            error: {
              type: "invalid-record-shape",
              message: `Line ${lineNumber} has a malformed event envelope.`,
              lineNumber,
            },
          };
          continue;
        }

        const envelope = parsed.line.envelope;
        if (lastSequence !== undefined && envelope.sequence <= lastSequence) {
          this.#issues.push({
            type: "sequence-gap",
            message: `Event at line ${lineNumber} has sequence ${envelope.sequence}, not greater than the previous event's ${lastSequence}.`,
          });
        }
        lastSequence = envelope.sequence;
        eventCount += 1;

        yield { ok: true, event: { envelope, lineNumber } };
      }
    } catch (error) {
      yield { ok: false, error: toIoError(error) };
    } finally {
      rl.close();
      stream.destroy();
    }

    if (!sawFooter) {
      this.#issues.push({
        type: "missing-footer",
        message:
          "Recording has no footer — it may have stopped abnormally (e.g. the process crashed while recording).",
      });
    }
  }
}

function toIoError(error: unknown): SessionLoaderError {
  return { type: "io-error", message: error instanceof Error ? error.message : String(error) };
}
