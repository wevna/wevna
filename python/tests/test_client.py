import json
import os
import time
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


class BatchSizeTests(unittest.TestCase):
    def test_large_events_are_split_into_several_requests(self):
        from wevna._client import MAX_BODY_BYTES, _chunk_by_size

        event = {"kind": "sql.query", "attributes": {"query": "x" * 4000}}
        batch = [dict(event) for _ in range(500)]  # ~2 MB in one go

        chunks = _chunk_by_size(batch, MAX_BODY_BYTES)

        self.assertGreater(len(chunks), 1)
        self.assertEqual(sum(len(chunk) for chunk in chunks), 500)
        for chunk in chunks:
            self.assertLessEqual(len(json.dumps({"events": chunk})), MAX_BODY_BYTES + 1000)

    def test_an_event_too_large_to_ever_send_is_dropped_without_costing_its_neighbours(self):
        from wevna._client import _chunk_by_size

        small = {"kind": "a", "attributes": {}}
        huge = {"kind": "b", "attributes": {"blob": "x" * 2000}}

        chunks = _chunk_by_size([small, huge, small], 1000)

        self.assertEqual([len(chunk) for chunk in chunks], [2])

    def test_delivery_sends_every_chunk(self):
        sent = []
        _client.stop_client()
        client = _client.start_client(sender=sent.append, flush_interval=3600)
        try:
            for _ in range(500):
                client.emit("sql.query", {"query": "x" * 4000})
            client.flush()
        finally:
            _client.stop_client()

        self.assertGreater(len(sent), 1)
        self.assertEqual(sum(len(chunk) for chunk in sent), 500)


@unittest.skipUnless(hasattr(os, "fork"), "needs os.fork")
class ForkTests(unittest.TestCase):
    def test_a_forked_worker_sends_its_own_events_and_not_its_parents(self):
        received = []
        lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                with lock:
                    received.extend(e["attributes"]["m"] for e in body["events"])
                self.send_response(202)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            _client.stop_client()
            client = _client.start_client(
                f"http://127.0.0.1:{server.server_port}", flush_interval=0.05
            )
            # Queued but unsent when the fork happens: belongs to the parent.
            client._sender = lambda batch: None
            client.emit("console.log", {"m": "parent-unsent"})
            client._sender = client._post

            pid = os.fork()
            if pid == 0:
                try:
                    _client.emit("console.log", {"m": "child"})
                    time.sleep(0.6)  # the child's own thread must flush this
                finally:
                    os._exit(0)
            os.waitpid(pid, 0)
            _client.stop_client()
        finally:
            server.shutdown()
            server.server_close()

        self.assertIn("child", received)
        self.assertEqual(received.count("parent-unsent"), 1)


class BindContextTests(unittest.TestCase):
    def test_work_run_in_a_pool_stays_attached_to_the_submitting_request(self):
        from concurrent.futures import ThreadPoolExecutor

        import wevna

        with Capture() as capture:
            with ThreadPoolExecutor(1) as pool:
                with request_scope():
                    pool.submit(lambda: _client.emit("sql.query", {"v": "bare"})).result()
                    pool.submit(wevna.bind_context(lambda: _client.emit("sql.query", {"v": "bound"}))).result()
                    mine = wevna.current_correlation_id()
            bare, bound = capture.flushed()

        self.assertNotIn("correlation", bare)
        self.assertEqual(bound["correlation"]["id"], mine)

    def test_preserves_arguments_return_value_and_name(self):
        import wevna

        def add(a, b=0):
            return a + b

        with request_scope():
            wrapped = wevna.bind_context(add)

        self.assertEqual(wrapped(2, b=3), 5)
        self.assertEqual(wrapped.__name__, "add")
