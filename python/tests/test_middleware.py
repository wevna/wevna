import asyncio
import unittest

from wevna.asgi import WevnaMiddleware
from wevna.wsgi import WevnaWSGIMiddleware
from wevna import emit, set_route
from tests.helpers import Capture


def run_asgi(app, path="/orders/42", query=b"", method="GET"):
    scope = {"type": "http", "method": method, "path": path, "query_string": query}
    sent = []

    async def receive():
        return {"type": "http.request"}

    async def send(message):
        sent.append(message)

    async def go():
        await WevnaMiddleware(app)(scope, receive, send)

    asyncio.run(go())
    return scope, sent


async def ok_app(scope, receive, send):
    emit("sql.query", {"query": "select 1"})
    await send({"type": "http.response.start", "status": 201, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


class AsgiTests(unittest.TestCase):
    def test_emits_http_request_with_status_and_duration(self):
        with Capture() as capture:
            run_asgi(ok_app, query=b"page=2")
            [request] = capture.of_kind("http.request")

        attributes = request["attributes"]
        self.assertEqual(attributes["method"], "GET")
        self.assertEqual(attributes["url"], "/orders/42?page=2")
        self.assertEqual(attributes["statusCode"], 201)
        self.assertGreaterEqual(attributes["durationMs"], 0)

    def test_correlates_inner_events_with_the_request(self):
        with Capture() as capture:
            run_asgi(ok_app)
            [sql] = capture.of_kind("sql.query")
            [request] = capture.of_kind("http.request")

        self.assertEqual(sql["correlation"], request["correlation"])

    def test_uses_the_route_pattern_when_the_framework_provides_one(self):
        class Route:
            path = "/orders/{order_id}"

        async def app(scope, receive, send):
            scope["route"] = Route()
            await ok_app(scope, receive, send)

        with Capture() as capture:
            run_asgi(app)
            [request] = capture.of_kind("http.request")

        self.assertEqual(request["attributes"]["route"], "/orders/{order_id}")

    def test_records_an_exception_and_a_500_then_reraises(self):
        async def app(scope, receive, send):
            raise ValueError("boom")

        with Capture() as capture:
            with self.assertRaises(ValueError):
                run_asgi(app)
            [exception] = capture.of_kind("exception.captured")
            [request] = capture.of_kind("http.request")

        self.assertEqual(exception["attributes"]["name"], "ValueError")
        self.assertEqual(exception["attributes"]["message"], "boom")
        self.assertIn("Traceback", exception["attributes"]["stack"])
        self.assertEqual(request["attributes"]["statusCode"], 500)
        self.assertEqual(exception["correlation"], request["correlation"])

    def test_passes_non_http_scopes_through_untouched(self):
        seen = []

        async def app(scope, receive, send):
            seen.append(scope["type"])

        async def go():
            await WevnaMiddleware(app)({"type": "lifespan"}, None, None)

        with Capture() as capture:
            asyncio.run(go())
            self.assertEqual(capture.flushed(), [])
        self.assertEqual(seen, ["lifespan"])


def run_wsgi(app, path="/ping", query=""):
    environ = {
        "REQUEST_METHOD": "POST",
        "SCRIPT_NAME": "",
        "PATH_INFO": path,
        "QUERY_STRING": query,
    }
    captured = {}

    def start_response(status, headers, exc_info=None):
        captured["status"] = status

    body = b"".join(WevnaWSGIMiddleware(app)(environ, start_response))
    return captured, body


class WsgiTests(unittest.TestCase):
    def test_emits_http_request_and_preserves_the_response(self):
        def app(environ, start_response):
            emit("redis.command", {"command": "get"})
            start_response("404 Not Found", [])
            return [b"nope"]

        with Capture() as capture:
            response, body = run_wsgi(app, query="x=1")
            [request] = capture.of_kind("http.request")
            [redis] = capture.of_kind("redis.command")

        self.assertEqual((response["status"], body), ("404 Not Found", b"nope"))
        self.assertEqual(request["attributes"]["method"], "POST")
        self.assertEqual(request["attributes"]["url"], "/ping?x=1")
        self.assertEqual(request["attributes"]["statusCode"], 404)
        self.assertEqual(redis["correlation"], request["correlation"])

    def test_route_set_during_the_request_is_reported(self):
        def app(environ, start_response):
            set_route("/orders/<int:order_id>")
            start_response("200 OK", [])
            return [b""]

        with Capture() as capture:
            run_wsgi(app)
            [request] = capture.of_kind("http.request")

        self.assertEqual(request["attributes"]["route"], "/orders/<int:order_id>")

    def test_records_an_exception_and_reraises(self):
        def app(environ, start_response):
            raise RuntimeError("bad")

        with Capture() as capture:
            with self.assertRaises(RuntimeError):
                run_wsgi(app)
            [exception] = capture.of_kind("exception.captured")
            [request] = capture.of_kind("http.request")

        self.assertEqual(exception["attributes"]["message"], "bad")
        self.assertEqual(request["attributes"]["statusCode"], 500)

    def test_closes_the_inner_iterable(self):
        closed = []

        class Body:
            def __iter__(self):
                return iter([b"a"])

            def close(self):
                closed.append(True)

        def app(environ, start_response):
            start_response("200 OK", [])
            return Body()

        with Capture():
            run_wsgi(app)

        self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
