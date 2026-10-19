# @wevna/plugin-mongodb

The official [Wevna](https://github.com/wevna/wevna) plugin for MongoDB: captures
every command your app sends as a `mongodb.command` event, correlated to the
request that issued it. It requires `@wevna/sdk` and does nothing on its own.

## Install

```bash
npm install @wevna/plugin-mongodb
```

## Usage

The client must be created with `monitorCommands: true` — the driver emits no
command events otherwise, and a plugin cannot switch that on afterwards.

```ts
import { wevna } from "@wevna/sdk";
import { createMongoDbPlugin } from "@wevna/plugin-mongodb";
import { MongoClient } from "mongodb";

const mongo = createMongoDbPlugin();
wevna.use(mongo);

const client = new MongoClient(url, { monitorCommands: true });
mongo.instrument(client);

await wevna.start();
```

Nothing is wrapped or patched: the plugin listens to the driver's own
`commandStarted` / `commandSucceeded` / `commandFailed` events and removes its
listeners on `wevna.stop()`.

## What it records

| Attribute | Notes |
| --- | --- |
| `operation` | The command name: `find`, `insert`, `aggregate`, … |
| `target` | The collection, when the command is about one |
| `database` | The database name |
| `durationMs` | As measured by the driver |
| `error` | The server's code name (`DuplicateKey`), present only on failure |

Repeating the same operation on the same collection inside one request (the
N+1 shape: `users.findOne` ×40) is reported as a **Repeated Database
Operation** insight.

## What it never records

**The command document.** Filters, inserted documents and update operators are
arbitrary user data, so only the operation and collection are read. A failure
is reported by code name rather than message, because a duplicate-key message
quotes the offending value.

The driver's housekeeping (`hello`, `ping`, auth handshakes, …) is ignored.
Add more with `createMongoDbPlugin({ ignoreCommands: ["count"] })`.
