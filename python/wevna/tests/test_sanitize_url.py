"""The URL sanitizer, asserted against the Node implementation's own output.

packages/plugin-fetch/src/sanitize-url.ts is authoritative and the fixture is
generated from it. Both suites read the same file, so a rule that changes in one
language and not the other turns one of them red — which is what makes
"a Python recording redacts what a Node recording redacts" a property rather
than a hope.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wevna.sanitize_url import REDACTED, is_sensitive, sanitize_url

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "plugin-fetch"
    / "fixtures"
    / "sanitize-url.json"
)


def cases() -> list[dict[str, str]]:
    data: dict[str, Any] = json.loads(FIXTURE.read_text())
    return list(data["cases"])


def test_the_fixture_was_found() -> None:
    # A wrong path would make the parametrised test below collect nothing and
    # the suite would pass by checking zero cases.
    assert len(cases()) >= 14


@pytest.mark.parametrize("case", cases(), ids=lambda c: c["url"])
def test_matches_the_node_implementation(case: dict[str, str]) -> None:
    assert sanitize_url(case["url"]) == case["sanitized"]


class TestRules:
    """The rules themselves, independent of the fixture."""

    @pytest.mark.parametrize(
        "name",
        [
            "token",
            "refreshToken",
            "secret",
            "password",
            "passwd",
            "credential",
            "signature",
            "authorization",
            "api_key",
            "apiKey",
            "API_KEY",
            "x-api-key",
            "keys",
            "sig",
            "pwd",
        ],
    )
    def test_sensitive_names(self, name: str) -> None:
        assert is_sensitive(name)

    @pytest.mark.parametrize(
        "name", ["page", "per_page", "keyboard_layout", "monkey_id", "sight", "id", "query"]
    )
    def test_insensitive_names(self, name: str) -> None:
        # "key" and "sig" are matched as whole words precisely so these survive.
        assert not is_sensitive(name)

    def test_author_is_over_redacted(self) -> None:
        # A known quirk, shared with the Node implementation on purpose: "auth"
        # is matched as a substring, so `author` is caught. Mirrored rather than
        # fixed here, because the two sanitizers agreeing matters more than
        # either being perfect — and fixing it is tracked separately.
        # See https://github.com/wevna/wevna/issues/48
        assert is_sensitive("author")


class TestAlwaysRemoved:
    def test_userinfo_goes_unconditionally(self) -> None:
        assert "@" not in sanitize_url("https://user:pw@api.example.com/x")
        assert "user" not in sanitize_url("https://user:pw@api.example.com/x")

    def test_sensitive_values_are_replaced_but_keys_are_kept(self) -> None:
        # "there was an api_key here" is useful; the secret never is.
        out = sanitize_url("https://x.test/y?api_key=abc123")
        assert "api_key" in out
        assert "abc123" not in out


class TestAlwaysKept:
    def test_path_and_pagination_survive(self) -> None:
        # A URL with its path stripped tells you nothing about which call was
        # slow, which is the only question this data exists to answer.
        out = sanitize_url("https://api.test/v1/orders/42?page=2&per_page=50")
        assert "/v1/orders/42" in out
        assert "page=2" in out
        assert "per_page=50" in out

    def test_port_survives(self) -> None:
        assert ":8443" in sanitize_url("https://api.test:8443/x")


class TestNeverRaises:
    @pytest.mark.parametrize(
        "value", ["", "not-a-url", "://broken", "http://", "%%%", "just some text"]
    )
    def test_unparseable_values_come_back_rather_than_raising(self, value: str) -> None:
        # An unparseable target is itself worth seeing, and a sanitizer that
        # raised would take down the request it was observing.
        assert isinstance(sanitize_url(value), str)


def test_redacted_marker_matches_the_node_constant() -> None:
    assert REDACTED == "[redacted]"
