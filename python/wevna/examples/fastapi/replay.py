"""Replays a recording in the dashboard.

    pnpm --filter @wevna/python example:replay session.jsonl

Works on a recording made by this SDK or by the Node SDK.
"""

from __future__ import annotations

import sys
import time

import wevna


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -m examples.fastapi.replay <recording.jsonl>", file=sys.stderr)
        return 2
    try:
        opened = wevna.open_recording(sys.argv[1])
    except wevna.RecordingError as error:
        print(f"cannot open the recording ({error.type}): {error}", file=sys.stderr)
        return 1
    print("Press Ctrl-C to stop.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        opened.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
