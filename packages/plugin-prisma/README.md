# @wevna/plugin-prisma

The official [Wevna](https://github.com/wevna/wevna) plugin for Prisma: captures
every Prisma Client operation as a `prisma.query` event, correlated to the
request that ran it. It requires `@wevna/sdk` and does nothing on its own.

## Install

```bash
npm install @wevna/plugin-prisma
```

## Usage

Prisma client extensions return a *new* client, so use what `extend` gives back:

```ts
import { wevna } from "@wevna/sdk";
import { createPrismaPlugin } from "@wevna/plugin-prisma";
import { PrismaClient } from "@prisma/client";

const wevnaPrisma = createPrismaPlugin();
wevna.use(wevnaPrisma);

export const prisma = wevnaPrisma.extend(new PrismaClient());

await wevna.start();
```

This uses Prisma's supported `$extends` query hook: no monkey-patching, and no
need to configure the `query` log level.

## What it records

| Attribute | Notes |
| --- | --- |
| `operation` | `findMany`, `create`, `$queryRaw`, … |
| `target` | The model (`User`), absent for raw queries |
| `durationMs` | Measured with `performance.now()` |
| `error` | Prisma's error code (`P2002`), present only on failure |

This is the *operation*, not the SQL beneath it: "`User.findMany` ran 40 times
in one request" is the N+1 you can act on, and is reported as a **Repeated
Database Operation** insight.

## What it never records

**Arguments.** `where` clauses and written values are never read. Failures are
reported by Prisma's stable error code rather than the message, which can
quote the offending values.
