# Wevna + Flask

A runnable Flask app with Wevna watching it.

## Run it

From the repository root:

```bash
pnpm install
pnpm build
pnpm --filter @wevna/python example:flask
```

Then open **<http://localhost:4123>** and, in another terminal:

```bash
curl http://localhost:8002/orders/42   # the interesting one
curl http://localhost:8002/health
curl http://localhost:8002/boom        # raises on purpose
```

No database, no Redis, no containers.

## What you should see

`GET /orders/42` is one request with 13 events in it: log lines, six SQL queries
(an order, a customer, and **four identical queries against `order_items`**, an
N+1), two Redis commands and an outgoing HTTP call. The route is
`/orders/<int:order_id>`, so `/orders/1` and `/orders/2` would group as one
endpoint. `GET /boom` is a 500 with an exception attached to it.

The whole setup is these lines:

```python
wevna.start()
app.wsgi_app = WevnaMiddleware(app.wsgi_app)
wevna.flask.instrument(app)
```

The app is threaded, as Flask's server is by default, and the events of
concurrent requests stay separate.

The example quiets the `httpx` and `werkzeug` loggers. Both log the full URL,
query string included, at INFO, and Wevna's log capture records what your
loggers write. The `api_key` in the outgoing call is redacted in the
`http.client` event; it would not be in a log line some other library wrote.
