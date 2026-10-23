# Wevna demo: a Node service and a Python service

Two small services that call each other, each with its own Wevna dashboard. It
exists to be recorded: it has an N+1 in each service, a slow endpoint, a failing
request, and a script that plays them in a good order for about 30 seconds.

```
                 GET /orders/:id
 traffic.mjs ───────────────────────►  Node storefront :3001   dashboard :4123
                                          │  ▲      │
                       GET /quote/:id     │  │      │ Postgres, Redis
                                          ▼  │      │
                                       Python pricing :3002   dashboard :4124
                                          │                   (Postgres, Redis)
                          GET /stock/:id  └──► back to the storefront
```

## Run it

You need Node 22+, pnpm, Python 3.10+ and Docker (for Postgres and Redis).

```bash
pnpm install
pnpm build
pnpm --filter @wevna/example-demo demo
```

That one command starts Postgres and Redis with Docker Compose, creates a Python
virtualenv on first run, starts both services, and waits until both answer. Then
open the two dashboards side by side and, in a second terminal:

```bash
pnpm --filter @wevna/example-demo traffic
```

| | URL |
| --- | --- |
| Node storefront | <http://localhost:3001> |
| Node dashboard | <http://localhost:4123> |
| Python pricing | <http://localhost:3002> |
| Python dashboard | <http://localhost:4124> |

Ctrl-C stops both services. The databases keep running; stop them with
`pnpm --filter @wevna/example-demo demo:down`.

## What is in it

| Endpoint | What it shows |
| --- | --- |
| `GET :3001/orders/:id` | The Node N+1: the item ids, then one query per item. It calls the Python service. |
| `GET :3002/quote/:id` | The Python N+1: one price query per line, with Redis lookups. It calls back to `:3001/stock/:id`. |
| `GET :3001/reports/daily` | The slow endpoint: one query that takes most of a second. |
| `GET :3001/boom` | The failing request: a handler that throws after a successful query. |
| `GET :3002/quote/0` | A failure on the Python side. |

Each service has a **Repeated Query** insight on its N+1, and the outgoing HTTP
calls carry an `api_key` query parameter, which is redacted in the recorded event.

The two dashboards are separate: each SDK hosts the dashboard for its own process,
and requests are not linked across services. Keep them side by side to follow one
order through both.

## Without Docker

Point the services at a Postgres and Redis you already have:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/demo
export PRICING_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/demo
export REDIS_URL=redis://localhost:6379
# Load the schema and seed data once:
psql "$DATABASE_URL" -f examples/demo/db/init.sql
NO_DOCKER=1 pnpm --filter @wevna/example-demo demo
```

`REDIS_READY_CHECK=0` turns off ioredis's startup `INFO` check, for a
Redis-compatible server that does not implement it.

## Ports and settings

Docker Compose publishes Postgres on **5433** and Redis on **6380**, so the demo
does not collide with ones you already run. Every port and URL can be overridden
with an environment variable: `STOREFRONT_PORT`, `PRICING_PORT`,
`STOREFRONT_DASHBOARD_PORT`, `PRICING_DASHBOARD_PORT`, `DATABASE_URL`,
`PRICING_DATABASE_URL`, `REDIS_URL`.

## Recording it

See [RECORDING.md](RECORDING.md).

## Checks

`pnpm check` type-checks the Node service and runs mypy on the Python service.
`pnpm lint` runs Biome and ruff. Both run in CI with the rest of the repository.
CI does not start the demo itself, because that needs Docker; it builds and lints it.
