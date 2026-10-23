"""Checks that a built wheel and sdist contain what a working install needs.

Run by the release and package-check workflows before anything is published:

    python scripts/verify_dist.py dist/

The dashboard bundle is the reason this exists. It is copied into the package by
a build step that is easy to skip, and without it the build still succeeds: the
wheel is valid, installs cleanly and then serves a blank page. Nothing else in
the pipeline would notice.

Standard library only, so it can run before any dependency is installed.
"""

from __future__ import annotations

import sys
import tarfile
import zipfile
from pathlib import Path

# Paths inside the wheel, relative to site-packages.
WHEEL_REQUIRED = (
    "wevna/__init__.py",
    "wevna/py.typed",
    "wevna/dashboard/index.html",
)

# The bundle references hashed files under assets/. An index.html with no
# scripts next to it is the same blank page.
ASSET_DIR = "wevna/dashboard/assets/"


def stray_files(names: set[str]) -> list[str]:
    """Compiled files and build metadata from a local tree, never wanted in a release.

    Both have been committed to this repository by mistake before. A build from a
    tree that has them can carry them into the archive.
    """
    return sorted(
        n
        for n in names
        if n.endswith((".pyc", ".pyo")) or "/__pycache__/" in n or ".egg-info/" in n
    )


def check_wheel(path: Path) -> list[str]:
    problems: list[str] = []
    with zipfile.ZipFile(path) as wheel:
        names = set(wheel.namelist())
    for required in WHEEL_REQUIRED:
        if required not in names:
            problems.append(f"{path.name}: missing {required}")
    if not any(n.startswith(ASSET_DIR) and n.endswith(".js") for n in names):
        problems.append(f"{path.name}: no JavaScript under {ASSET_DIR}")
    if not any(n.endswith(".dist-info/METADATA") for n in names):
        problems.append(f"{path.name}: no METADATA")
    if not any("/licenses/" in n or n.endswith("/LICENSE") for n in names):
        problems.append(f"{path.name}: no license file")
    if any(n.startswith("tests/") or "/tests/" in n for n in names):
        problems.append(f"{path.name}: contains tests")
    for stray in stray_files(names):
        problems.append(f"{path.name}: contains {stray}")
    return problems


def check_sdist(path: Path) -> list[str]:
    problems: list[str] = []
    with tarfile.open(path) as sdist:
        names = {
            member.name.split("/", 1)[1] for member in sdist.getmembers() if "/" in member.name
        }
    for required in ("pyproject.toml", "README.md", "LICENSE", "PKG-INFO"):
        if required not in names:
            problems.append(f"{path.name}: missing {required}")
    # A wheel built *from* the sdist needs the bundle too.
    if "src/wevna/dashboard/index.html" not in names:
        problems.append(f"{path.name}: missing src/wevna/dashboard/index.html")
    for stray in stray_files(names):
        problems.append(f"{path.name}: contains {stray}")
    return problems


def verify(directory: Path) -> list[str]:
    wheels = sorted(directory.glob("*.whl"))
    sdists = sorted(directory.glob("*.tar.gz"))
    problems: list[str] = []
    if len(wheels) != 1:
        problems.append(f"expected exactly one wheel in {directory}, found {len(wheels)}")
    if len(sdists) != 1:
        problems.append(f"expected exactly one sdist in {directory}, found {len(sdists)}")
    for wheel in wheels:
        problems += check_wheel(wheel)
    for sdist in sdists:
        problems += check_sdist(sdist)
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: verify_dist.py <dist-directory>", file=sys.stderr)
        return 2
    problems = verify(Path(argv[1]))
    for problem in problems:
        print(f"FAIL {problem}", file=sys.stderr)
    if problems:
        return 1
    print("dist ok: wheel and sdist contain the dashboard bundle, license and type marker")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
