from __future__ import annotations

from typing import Any

import pytest
from protocol_artifacts import SCHEMA_PATH, load_schema


@pytest.fixture(scope="session")
def schema() -> dict[str, Any]:
    if not SCHEMA_PATH.exists():  # pragma: no cover - wiring mistake, not behaviour
        pytest.fail(
            f"protocol schema not found at {SCHEMA_PATH}. These tests read the "
            "TypeScript package's schema on purpose; they are meaningless against a copy."
        )
    return load_schema()
