# @wevna/protocol

The shared runtime protocol used by the [Wevna](https://github.com/wevna/wevna)
ecosystem: the event, envelope, and recording-file types every Wevna
producer and consumer agrees on.

## When you need this

Most Wevna users never install this directly — the `@wevna/sdk` SDK already
depends on it. Install `@wevna/protocol` yourself if you're:

- **writing a Wevna plugin** and need `CapturedEvent`/`Envelope` to type
  the events your plugin produces
- **reading a `.jsonl` recording file** produced by `wevna.startRecording()`
  outside of Wevna itself, and want the exact shapes to parse it against
- building a **custom tool** that consumes the live protocol stream

## Install

```bash
npm install @wevna/protocol
```

## Usage

```ts
import type { CapturedEvent, Envelope, RecordingLine } from "@wevna/protocol";
import { PROTOCOL_VERSION, RECORDING_FORMAT_VERSION } from "@wevna/protocol";

// The shape of one observation (an HTTP request, a SQL query, a log line, ...).
const event: CapturedEvent = {
  id: "…",
  kind: "http.request",
  occurredAt: Date.now(),
  attributes: { method: "GET", url: "/widgets", statusCode: 200 },
};

// The wire wrapper every payload — events, sessions — travels in.
const envelope: Envelope<CapturedEvent> = {
  version: PROTOCOL_VERSION,
  sessionId: "…",
  sequence: 1,
  payload: event,
};

// A recording file is JSON Lines: one RecordingLine per line, in write
// order — a header, any number of events, and (on a clean stop) a footer.
function parseLine(line: string): RecordingLine {
  return JSON.parse(line);
}
```

`PROTOCOL_VERSION` (the shape of `CapturedEvent`/`Envelope`/`Session`) and
`RECORDING_FORMAT_VERSION` (the shape of the `.jsonl` file itself) are
versioned independently and stamped onto every envelope and recording
header, so a consumer always knows what it's reading. Both are frozen for
the `@wevna/sdk` 1.x line — see
[STABILITY.md](https://github.com/wevna/wevna/blob/main/STABILITY.md) for
exactly what that guarantees.

## Learn more

This package only defines shapes; it doesn't run anything. See the
[main Wevna repository](https://github.com/wevna/wevna) for the SDK,
runtime, and dashboard that produce and consume them.
