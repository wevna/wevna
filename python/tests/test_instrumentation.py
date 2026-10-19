import logging
import sqlite3
import unittest

import wevna
from wevna import instrumentation
from wevna._sanitize import REDACTED, sanitize_url
from tests.helpers import Capture


class SqlTests(unittest.TestCase):
    def setUp(self):
        self.conn = wevna.instrument_connection(sqlite3.connect(":memory:"))
        self.addCleanup(self.conn.close)
        self.conn.execute("create table users (id integer, email text)")

    def test_cursor_execute_records_query_duration_and_never_the_parameters(self):
        with Capture() as capture:
            cursor = self.conn.cursor()
            cursor.execute("insert into users values (?, ?)", (1, "secret@example.com"))
            [event] = capture.of_kind("sql.query")

        self.assertEqual(event["attributes"]["query"], "insert into users values (?, ?)")
        self.assertEqual(event["attributes"]["rows"], 1)
        self.assertGreaterEqual(event["attributes"]["durationMs"], 0)
        self.assertNotIn("secret@example.com", repr(event))

    def test_results_still_come_back_from_a_chained_fetch(self):
        self.conn.execute("insert into users values (1, 'a')")

        with Capture():
            rows = self.conn.cursor().execute("select id from users").fetchall()

        self.assertEqual(rows, [(1,)])

    def test_connection_execute_shortcut_is_recorded(self):
        with Capture() as capture:
            self.conn.execute("select 1")
            self.assertEqual(len(capture.of_kind("sql.query")), 1)

    def test_a_failing_query_is_recorded_and_reraised(self):
        with Capture() as capture:
            with self.assertRaises(sqlite3.OperationalError):
                self.conn.cursor().execute("select * from missing")
            [event] = capture.of_kind("sql.query")

        self.assertEqual(event["attributes"]["error"], "OperationalError")

    def test_wrapping_twice_is_harmless(self):
        self.assertIs(wevna.instrument_connection(self.conn), self.conn)

    def test_cursor_is_iterable(self):
        self.conn.execute("insert into users values (1, 'a')")
        with Capture():
            cursor = self.conn.cursor()
            cursor.execute("select id from users")
            self.assertEqual(list(cursor), [(1,)])


class LoggingTests(unittest.TestCase):
    def test_log_records_become_console_log_events(self):
        logger = logging.getLogger("wevna-test")
        with Capture() as capture:
            instrumentation.instrument_logging(logging.INFO)
            try:
                logger.info("order %s created", 42)
                [event] = capture.of_kind("console.log")
            finally:
                instrumentation.uninstrument_logging()

        self.assertEqual(event["attributes"], {"level": "info", "message": "order 42 created"})


class SanitizeTests(unittest.TestCase):
    def test_strips_userinfo(self):
        self.assertEqual(
            sanitize_url("https://alice:s3cr3t@api.example.com/data"),
            "https://api.example.com/data",
        )

    def test_redacts_sensitive_values_but_keeps_keys_and_the_rest(self):
        result = sanitize_url("https://x.test/d?api_key=abc123&page=1&token=t")
        self.assertIn("page=1", result)
        self.assertIn("api_key=", result)
        self.assertNotIn("abc123", result)
        self.assertEqual(result.count("%5Bredacted%5D"), 2)

    def test_author_is_not_redacted(self):
        self.assertIn("tolkien", sanitize_url("https://x.test/b?author=tolkien"))

    def test_keyboard_is_not_redacted_but_x_api_key_is(self):
        self.assertIn("qwerty", sanitize_url("https://x.test/d?keyboard_layout=qwerty"))
        self.assertNotIn("leak", sanitize_url("https://x.test/d?x-api-key=leak&apiKey=leak"))

    def test_unparseable_input_is_returned_unchanged(self):
        self.assertEqual(sanitize_url("not a url"), "not a url")


class RequestsTests(unittest.TestCase):
    def test_records_method_sanitized_url_and_status(self):
        try:
            import requests
        except ImportError:
            self.skipTest("requests not installed")

        from unittest import mock

        response = requests.Response()
        response.status_code = 200
        with Capture() as capture:
            self.assertTrue(instrumentation.instrument_requests())
            try:
                with mock.patch.object(requests.adapters.HTTPAdapter, "send", return_value=response):
                    requests.get("https://api.test/x?token=secret&page=2")
                [event] = capture.of_kind("http.client")
            finally:
                wevna.stop()

        self.assertEqual(event["attributes"]["method"], "GET")
        self.assertEqual(event["attributes"]["statusCode"], 200)
        self.assertNotIn("secret", event["attributes"]["url"])


class RedisTests(unittest.TestCase):
    def test_records_only_the_command_name(self):
        try:
            import redis
        except ImportError:
            self.skipTest("redis not installed")

        from unittest import mock

        with Capture() as capture:
            self.assertTrue(instrumentation.instrument_redis())
            try:
                client = redis.Redis()
                # Fail below the wrapper, where the network would be.
                with mock.patch(
                    "redis.connection.ConnectionPool.get_connection",
                    side_effect=RuntimeError("no server"),
                ):
                    with self.assertRaises(Exception):
                        client.get("private-key")
                [event] = capture.of_kind("redis.command")
            finally:
                wevna.stop()

        self.assertEqual(event["attributes"]["command"], "get")
        self.assertNotIn("private-key", repr(event))


class StartStopTests(unittest.TestCase):
    def test_start_and_stop_are_idempotent_and_restore_patches(self):
        wevna.start("http://127.0.0.1:1")
        wevna.start("http://127.0.0.1:1")
        wevna.stop()
        wevna.stop()


if __name__ == "__main__":
    unittest.main()
