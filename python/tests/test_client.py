import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from wevna import _client
from wevna._context import request_scope
from tests.helpers import Capture


class ClientTests(unittest.TestCase):
    def test_emit_is_a_noop_before_start(self):
        _client.stop_client()
        _client.emit("console.log", {"message": "x"})  # must not raise

    def test_event_shape(self):
        with Capture() as capture:
            _client.emit("sql.query", {"query": "select 1"})
            [event] = capture.flushed()

        self.assertEqual(event["kind"], "sql.query")
        self.assertEqual(event["attributes"], {"query": "select 1"})
        self.assertEqual(event["source"], "wevna-python")
        self.assertIsInstance(event["occurredAt"], float)
        self.assertNotIn("correlation", event)

    def test_events_inside_a_request_scope_share_its_correlation_id(self):
        with Capture() as capture:
            with request_scope():
                _client.emit("sql.query", {})
                _client.emit("redis.command", {})
            _client.emit("console.log", {})
            first, second, outside = capture.flushed()

        self.assertEqual(first["correlation"], second["correlation"])
        self.assertTrue(first["correlation"]["id"])
        self.assertNotIn("correlation", outside)

    def test_concurrent_scopes_do_not_share_an_id(self):
        ids = []

        def work():
            with request_scope():
                _client.emit("sql.query", {})

        with Capture() as capture:
            threads = [threading.Thread(target=work) for _ in range(3)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            ids = {event["correlation"]["id"] for event in capture.flushed()}

        self.assertEqual(len(ids), 3)

    def test_a_failing_sender_never_raises_and_warns_once(self):
        calls = []

        def broken(batch):
            calls.append(batch)
            raise ConnectionRefusedError("nope")

        _client.stop_client()
        client = _client.start_client(sender=broken, flush_interval=3600)
        try:
            client.emit("console.log", {})
            client.flush()
            client.emit("console.log", {})
            client.flush()
        finally:
            _client.stop_client()

        self.assertEqual(len(calls), 2)

    def test_the_queue_is_bounded_and_drops_the_oldest(self):
        _client.stop_client()
        received = []
        client = _client.start_client(
            sender=received.extend, flush_interval=3600, max_queue=3
        )
        try:
            for index in range(5):
                client.emit("console.log", {"n": index})
            client.flush()
        finally:
            _client.stop_client()

        self.assertEqual([event["attributes"]["n"] for event in received], [2, 3, 4])


class WireTests(unittest.TestCase):
    def test_posts_json_to_the_ingest_endpoint(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["content-length"])
                received["path"] = self.path
                received["content_type"] = self.headers["content-type"]
                received["body"] = json.loads(self.rfile.read(length))
                self.send_response(202)
                self.end_headers()
                self.wfile.write(b'{"accepted":1}')

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            _client.stop_client()
            client = _client.start_client(
                f"http://127.0.0.1:{server.server_port}", flush_interval=3600
            )
            client.emit("console.log", {"message": "hello"})
            _client.stop_client()
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(received["path"], "/api/ingest")
        self.assertEqual(received["content_type"], "application/json")
        [event] = received["body"]["events"]
        self.assertEqual(event["attributes"], {"message": "hello"})

    def test_an_unreachable_dashboard_does_not_raise(self):
        _client.stop_client()
        client = _client.start_client("http://127.0.0.1:1", flush_interval=3600)
        client.emit("console.log", {})
        _client.stop_client()


if __name__ == "__main__":
    unittest.main()
