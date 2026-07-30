# Wevna + BullMQ

**Not implemented yet.** Wevna has no BullMQ instrumentation — job
processing isn't captured, and there's no `wevna.instrument*()` call for
it the way there is for `pg` or `ioredis`.

It's on the roadmap (see [the root README](../../README.md#roadmap)) as
one of the next instrumentation targets, alongside Prisma and MongoDB.
This package is a placeholder for that: once BullMQ support exists, this
README will show the actual integration pattern and a runnable example,
the same way [Express](../express/README.md), [Fastify](../fastify/README.md),
and [NestJS](../nest/README.md) already do.

## What works today, in the meantime

If your BullMQ workers run in the same process as an app you've already
started Wevna in, you'll still see:

- any `console.log` calls your job handlers make
- any instrumented `pg`/`ioredis` calls they make (via
  `wevna.instrumentPg()` / `wevna.instrumentRedis()` — see the root
  README)

Those events just won't be correlated to "which job," or grouped the way
HTTP request events are — that grouping is what BullMQ-specific
instrumentation would add.
