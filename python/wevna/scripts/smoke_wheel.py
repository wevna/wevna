"""Smoke test for an *installed* wheel. Run with the interpreter of a fresh venv.

    python scripts/smoke_wheel.py

It proves the package that was built is the package that gets imported (not the
source tree next to it), that its version matches its metadata, and that the
dashboard it ships can actually be served and the server shut down again.
Standard library only.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
import urllib.request


def fetch(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.status, response.read().decode()


def main() -> int:
    import wevna

    location = wevna.__file__ or ""
    if "site-packages" not in location:
        print(f"FAIL imported wevna from {location}, not from an installed wheel", file=sys.stderr)
        return 1

    installed = importlib.metadata.version("wevna")
    if wevna.__version__ != installed:
        print(
            f"FAIL wevna.__version__ is {wevna.__version__} "
            f"but the package metadata says {installed}",
            file=sys.stderr,
        )
        return 1

    result = wevna.start(port=0)
    try:
        status, body = fetch(f"{result.url}/health")
        if status != 200 or json.loads(body).get("product") != "wevna":
            print(f"FAIL /health returned {status}: {body}", file=sys.stderr)
            return 1

        status, page = fetch(f"{result.url}/")
        if status != 200 or 'id="root"' not in page:
            print("FAIL the dashboard index page was not served", file=sys.stderr)
            return 1
    finally:
        wevna.stop()

    print(f"smoke ok: wevna {installed} from {location}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
