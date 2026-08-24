"""Locates the shared protocol artifacts, which live outside this package.

The schema and fixtures belong to ``packages/protocol`` because they are the
contract both SDKs answer to, not something the Python SDK keeps a copy of.
A copy is exactly what these tests exist to make unnecessary.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
PROTOCOL_DIR = REPO_ROOT / "packages" / "protocol"
SCHEMA_PATH = PROTOCOL_DIR / "schema" / "wevna-protocol.schema.json"
FIXTURES_DIR = PROTOCOL_DIR / "fixtures"


def load_schema() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(SCHEMA_PATH.read_text())
    return data


def fixture_files(kind: str) -> list[Path]:
    return sorted((FIXTURES_DIR / kind).glob("*.json"))


def load_fixture(path: Path) -> Any:
    return json.loads(path.read_text())
