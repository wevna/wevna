# @wevna/plugin-mysql

The official [Wevna](https://github.com/wevna/wevna) plugin for MySQL and
MariaDB: captures every query made through [`mysql2`'s promise
API](https://sidorares.github.io/node-mysql2/docs) as a `sql.query` event,
correlated to the request that ran it. It requires `@wevna/sdk` and does
nothing on its own.

It emits the same `sql.query` kind the built-in Postgres support does, so
everything that works on Postgres — the SQL timing, the **Repeated Query**
(N+1) insight, the SQL filter — works on MySQL unchanged.

## Install

```bash
npm install @wevna/plugin-mysql
```

## Usage

```ts
import { wevna } from "@wevna/sdk";
import { createMysqlPlugin } from "@wevna/plugin-mysql";
import mysql from "mysql2/promise";

const wevnaMysql = createMysqlPlugin();
wevna.use(wevnaMysql);

const pool = mysql.createPool(config);
wevnaMysql.instrument(pool);

await wevna.start();
```

Pass a pool, a connection, or a pool connection — anything from
`mysql2/promise` with `query()` / `execute()`. The same object keeps working
exactly as before.

## What it records

| Attribute | Notes |
| --- | --- |
| `query` | The statement text, with your `?` placeholders |
| `durationMs` | Measured with `performance.now()` |
| `rows` | Rows returned by a `SELECT`, or `affectedRows` for a write |
| `error` | The MySQL error code (`ER_DUP_ENTRY`), present only on failure |

## What it never records

**Parameter values** — only the statement is read, never the values array.
Failures are reported by error code rather than message, because
`Duplicate entry 'a@b.com'` quotes the value.

## Limits

Promise API only: callback-style `connection.query(sql, cb)` calls pass
through unobserved rather than being guessed at, the same as the `pg`
support. Like it, the wrapper stays installed after `wevna.stop()` and simply
goes quiet.
