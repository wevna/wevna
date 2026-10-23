# Python SDK under pre-fork servers

Status: proposal. Nothing here is implemented. The decisions it needs from you
are at the end.

## The question

`gunicorn -w 4`, `uvicorn --workers 4` and `multiprocessing` run the application
in several processes. The Python SDK hosts the dashboard inside the process that
calls `wevna.start()`, so with several worker processes the question is which
process hosts it and what happens to the others' events. This note compares two
ways to capture every worker and recommends one.

## What happens today

Measured on `main` after #85 to #87, not assumed.

There are two ways a server ends up with several workers, and they behave
differently.

**Fork after `start()`** (gunicorn with `--preload`, or an application that
calls `start()` at import time in the master). The workers inherit the dashboard
object and a copy of its event loop, but the thread that runs that loop does not
survive `fork()`. Before #87 each worker queued events onto a loop nobody was
running: events were lost and memory grew by about 180 MB per 200,000 events.
Since #87 a forked worker drops its events and logs one warning. The dashboard
shows only what the master process does, which for a server is almost nothing.

**Each worker imports the application and calls `start()`** (gunicorn without
`--preload`, `uvicorn --workers`, which spawns fresh interpreters). Every worker
tries to bind port 4123. I ran two processes against one port:

- The first starts in 0.05 seconds and serves the dashboard.
- The second logs a bind error, then waits 5.9 seconds, then prints
  `Wevna running at http://localhost:4177` and reports `is_running()` as `True`,
  although its server never started. Its events go to a broadcaster with no loop
  and are dropped without a message.

So with N workers, N minus 1 of them stall startup by five seconds, print a
message that is not true, and capture nothing. Only one worker's traffic is
visible, chosen by which process won a race. This is the more common case, and it
is worse than the forked case because it looks like it is working. It is not part
of this proposal to fix, but any option below replaces this behavior.

`uvicorn --reload` is neither: the reloader spawns one server process, so it
behaves like a single worker.

## What any solution has to respect

These are existing properties, and each one rules something out.

1. **Nothing leaves the machine, and the dashboard is local.** No external
   service, no network listener beyond loopback by default. The Host and Origin
   guard (`host_guard.py`, `host-guard.json`) applies to every route.
2. **One dashboard, one stream.** The dashboard connects to one WebSocket and
   shows one session's events. It orders events by `(occurredAt, sequence)`, so
   `sequence` is only a tiebreak at equal timestamps. Events from different
   processes can be merged by time without breaking request grouping, which is by
   correlation id.
3. **A recording requires `sequence` to increase along the file.** The loader
   reports `sequence-gap` otherwise. Anything that merges several processes into
   one recording must assign one sequence, not pass each worker's through.
4. **A session has an identity and a clock of its own.** Each `Runtime` creates a
   session id and numbers events from zero. Today that is per process.
5. **Bounded memory everywhere.** The dashboard queue and the recorder queue are
   each limited to 10,000 events and drop with one warning. A new component must
   have the same bound, and must never be able to slow or block a request.
6. **The SDK must not break the application.** `publish()` never raises and never
   waits on the network or the disk. Instrumentation failing is acceptable;
   blocking a request is not.
7. **Zero required dependencies beyond what the dashboard already needs.**
8. **The protocol is shared with Node.** A change to the wire format goes through
   `packages/protocol/schema` and the shared fixtures, and both SDKs read them.

## Option A: each worker hosts its own dashboard

Every worker process starts its own dashboard on its own port, 4123 for the first
and the next free port for the rest (or `4123 + worker index`, or port 0 with the
chosen port printed).

How it works: this is the current design applied per process, plus a fix so a
second worker does not stall on a taken port: try 4123, then the next ports, and
report the port actually bound (#86 already reports the real port for port 0).

- **Protocol impact:** none. Each worker is its own session with its own
  sequence, exactly as now.
- **Session identity and ordering:** trivially correct. Each dashboard sees one
  process, one session, one sequence. There is nothing to merge.
- **Memory:** unchanged, one queue per worker.
- **Recording:** each worker records its own file. The Python recorder (in review
  as Phase 3) already has a fork guard, and a spawned worker would take a path
  that includes its pid.
- **Failure modes:** a worker that cannot bind any port runs without a dashboard
  and says so, instead of claiming to be running. A crashed worker takes only its
  own dashboard with it. Ports shift between runs, so a developer must find the
  right one.
- **Security:** each new listener is covered by the existing guard. More open
  ports on loopback, none beyond it.
- **The cost to the user:** a request lands on whichever worker the OS gives it
  to, so to see a request you have to look at the right dashboard. With four
  workers that is four browser tabs and a guess. This does not solve the
  problem, it relocates it.
- **Effort:** small. About 50 lines for port selection and the honest status
  message, plus tests. One or two days including docs.

## Option B: workers relay events to one collector

One process hosts the dashboard (the collector). Every worker sends its events to
it over a local connection.

There are three ways to choose the collector:

- **B1, the first worker wins.** Each worker tries to bind the port. The winner
  hosts the dashboard and also receives events from the others. No new process,
  but the dashboard dies with that worker, and a restart of that worker leaves the
  others sending to nobody until a new leader appears.
- **B2, a separate collector process** (`python -m wevna.collector`) started by
  the developer before the server. Stable and simple to reason about, but one more
  command to run, which cuts against "one line of code".
- **B3, the master process.** With a pre-fork server the master exists and
  outlives workers. Under gunicorn it can be given a hook (`when_ready`) to start
  the collector. This needs per-server integration and does not work for
  `uvicorn --workers`.

Transport options: a loopback HTTP or WebSocket connection to the collector, or a
Unix domain socket (not on Windows). Events are already serialized to JSON for the
dashboard, so the wire format already exists.

- **Protocol impact:** the collector receives events that already have a session
  id and sequence from the worker. It must do what the Node ingest endpoint did
  (which I prototyped and dropped when the self-hosted Python SDK landed): assign
  one session id and one sequence of its own and ignore the worker's, so that the
  stream and any recording are consistent (constraints 3 and 4). Each worker's
  events keep their correlation ids, so requests still group. The worker's
  original sequence is lost, which only matters as a tiebreak at equal timestamps.
  No schema change is needed, because an envelope is rewritten, not extended. Add
  an optional attribute or field to say which worker an event came from if that is
  wanted in the UI. That would be a protocol change.
- **Ordering:** by `occurredAt`, which comes from each worker's wall clock on one
  machine, so consistent. Within a worker the order is preserved by the transport.
  Across workers it is by timestamp, which is the dashboard's rule anyway. Events
  arriving slightly out of timestamp order is fine for the dashboard but means the
  collector's sequence reflects arrival order, not time order. A recording is
  consistent with itself and replays identically.
- **Memory:** two bounded queues now (worker to collector, collector to dashboard).
  Each worker's queue must be bounded and must drop with a warning, never block,
  when the collector is slow or absent. The collector bounds its own.
- **Failure modes:**
  - Collector not running: workers drop events and say so once, as now. They need
    to retry the connection in the background without busy-looping.
  - Collector restarts: workers reconnect. Events during the gap are lost.
  - A worker dies mid-request: its request shows as pending in the dashboard, which
    is already how an incomplete request looks.
  - Fork after connect: the connection is inherited and shared by parent and child,
    and writing to one socket from two processes interleaves bytes. Each process
    must open its own connection, which means the same pid check as #87 and a
    reconnect in the child.
  - Slow dashboard: back-pressure must stop at the collector's queue, not reach
    the request path.
- **Security:** this adds a way to write events into the dashboard from another
  process. That is the same class of surface as the Node ingest endpoint, and it
  has the same hazard: any web page can send a request to a localhost port. The
  existing Host and Origin guard blocks browsers, and `application/json` only
  was my extra defence for the Node endpoint. A Unix socket avoids the browser
  reaching it at all. The collector must still refuse a foreign Host and Origin,
  and the worker connection must not be reachable from a web page. A recording
  made from relayed events contains whatever the workers sent, so redaction stays
  the workers' job, as today.
- **Effort:** larger. The collector (a receive endpoint, re-stamping, bounded
  queue), the worker side (a background sender with reconnect, bounded, fork
  aware), leader election or a launcher depending on B1, B2 or B3, per-server
  documentation, and real multi-process tests (gunicorn and uvicorn) in CI.
  Roughly a week for B1 or B2, more for B3 because each server needs its own
  integration and test.

## Comparison

| | A: per-worker dashboards | B1: first worker leads | B2: separate collector |
| --- | --- | --- | --- |
| One place to look | no | yes | yes |
| Protocol change | none | none (collector re-stamps) | none (collector re-stamps) |
| Extra process or command | none | none | yes |
| Dashboard survives a worker restart | n/a | no | yes |
| Cross-process write surface | none | yes | yes |
| Worker fork handling | existing guard | needs per-process connection | needs per-process connection |
| Memory bound | one queue per worker | two queues | two queues |
| Fixes the 5 s startup stall | yes | yes | yes |
| Effort | 1 to 2 days | about 1 week | about 1 week |
| Works for `gunicorn -w` and `uvicorn --workers` | yes | yes | yes |

## Recommendation

Do option A now, as a small change, and treat B2 as the real answer if people
need one dashboard across workers.

1. **Fix the startup stall first, regardless.** A worker that cannot bind its port
   should say so, not wait five seconds and claim to be running. That is a bug
   independent of which option is chosen, and it is a few lines.
2. **Ship A.** It removes the misleading behavior and needs no protocol, security
   or memory changes. It is honest about its limit: several dashboards.
3. **Do not build B1.** Leader election by port race gives a dashboard that
   disappears with a worker, and the failure is silent. It is the least
   predictable option for a tool whose point is being trustworthy.
4. **Build B2 only if A proves too awkward in practice.** A separate collector is
   the design with clear ownership, and the cleanest place to add the re-stamping
   and the single bounded queue. It is also the first time the SDK accepts
   events from another process, so it deserves its own security review, using the
   Node ingest endpoint's lessons (the JSON-only requirement and the Host and
   Origin guard).
5. **B3 only as an add-on to B2**, for gunicorn users who want it started
   automatically.

Most development work uses one worker, where none of this applies. The pre-fork
case matters mostly to people reproducing a production topology locally, and for
them a clear message and per-worker ports may be enough.

## Decisions I need from you

1. Is "several dashboards, one per worker" acceptable as the supported answer for
   pre-fork servers, or is one dashboard across workers a requirement?
2. If one dashboard is required: B2 (separate collector, one extra command) or B1
   (no extra command, fragile)? I recommend B2.
3. Port scheme for option A: next free port from 4123, a fixed offset by worker
   index, or port 0 with the chosen port printed?
4. Should a worker that cannot bind any port keep running without a dashboard
   (my recommendation, with a clear message), or fail fast?
5. If a relay is built: do you want an event to carry which worker produced it
   (a protocol change, an optional attribute), or is the correlation id enough?
