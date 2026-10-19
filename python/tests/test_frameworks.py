import unittest

from tests.helpers import Capture
from wevna.django import WevnaDjangoMiddleware


class DjangoMiddlewareTests(unittest.TestCase):
    def test_reports_the_resolved_route_pattern(self):
        from wevna._context import request_scope

        class Match:
            route = "articles/<int:pk>/"

        class Request:
            resolver_match = Match()

        middleware = WevnaDjangoMiddleware(lambda request: "response")
        with request_scope() as info:
            self.assertIsNone(middleware.process_view(Request(), None, (), {}))

        self.assertEqual(info["route"], "/articles/<int:pk>/")
        self.assertEqual(middleware(Request()), "response")

    def test_tolerates_a_request_with_no_match(self):
        class Request:
            resolver_match = None

        WevnaDjangoMiddleware(lambda r: r).process_view(Request(), None, (), {})


class FlaskTests(unittest.TestCase):
    def test_install_records_the_rule_and_correlates_queries(self):
        try:
            import flask
        except ImportError:
            self.skipTest("flask not installed")
        import wevna
        import wevna.flask

        app = flask.Flask(__name__)

        @app.route("/orders/<int:order_id>")
        def order(order_id):
            wevna.emit("sql.query", {"query": "select 1"})
            return "ok"

        wevna.flask.install(app)
        with Capture() as capture:
            with app.test_client().get("/orders/7") as response:
                self.assertEqual(response.status_code, 200)
            [request] = capture.of_kind("http.request")
            [sql] = capture.of_kind("sql.query")

        self.assertEqual(request["attributes"]["route"], "/orders/<int:order_id>")
        self.assertEqual(request["attributes"]["url"], "/orders/7")
        self.assertEqual(sql["correlation"], request["correlation"])


class FastApiTests(unittest.TestCase):
    def test_reports_the_route_pattern_and_correlates_threadpool_work(self):
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("fastapi not installed")
        import wevna
        from wevna.asgi import WevnaMiddleware

        app = FastAPI()

        @app.get("/items/{item_id}")
        def item(item_id: int):  # sync endpoint: runs in a worker thread
            wevna.emit("sql.query", {"query": "select 1"})
            return {"id": item_id}

        with Capture() as capture:
            response = TestClient(WevnaMiddleware(app)).get("/items/3")
            [request] = capture.of_kind("http.request")
            [sql] = capture.of_kind("sql.query")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(request["attributes"]["route"], "/items/{item_id}")
        self.assertEqual(sql["correlation"], request["correlation"])


if __name__ == "__main__":
    unittest.main()
