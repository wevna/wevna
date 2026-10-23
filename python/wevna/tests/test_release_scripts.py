"""The release verification scripts, tested by feeding them broken packages.

A verifier that has only ever been shown a good build proves nothing. These tests
build small fake wheels and sdists and check that each missing piece is caught,
above all the dashboard bundle: without it the wheel still installs and imports,
and serves a blank page.
"""

from __future__ import annotations

import importlib.util
import io
import tarfile
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPTS = Path(__file__).parents[1] / "scripts"


def load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify_dist = load("verify_dist")

GOOD_WHEEL = {
    "wevna/__init__.py": "",
    "wevna/py.typed": "",
    "wevna/dashboard/index.html": '<div id="root"></div>',
    "wevna/dashboard/assets/index-abc.js": "x",
    "wevna-0.1.0.dist-info/METADATA": "Name: wevna",
    "wevna-0.1.0.dist-info/licenses/LICENSE": "MIT",
}

GOOD_SDIST = {
    "pyproject.toml": "",
    "README.md": "",
    "LICENSE": "",
    "PKG-INFO": "",
    "src/wevna/dashboard/index.html": "",
}


def write_wheel(directory: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(directory / "wevna-0.1.0-py3-none-any.whl", "w") as wheel:
        for name, content in files.items():
            wheel.writestr(name, content)


def write_sdist(directory: Path, files: dict[str, str]) -> None:
    with tarfile.open(directory / "wevna-0.1.0.tar.gz", "w:gz") as sdist:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"wevna-0.1.0/{name}")
            info.size = len(data)
            sdist.addfile(info, io.BytesIO(data))


@pytest.fixture
def good(tmp_path: Path) -> Path:
    write_wheel(tmp_path, GOOD_WHEEL)
    write_sdist(tmp_path, GOOD_SDIST)
    return tmp_path


def test_a_complete_build_passes(good: Path) -> None:
    assert verify_dist.verify(good) == []


@pytest.mark.parametrize("missing", ["wevna/dashboard/index.html", "wevna/py.typed"])
def test_a_wheel_missing_a_required_file_fails(tmp_path: Path, missing: str) -> None:
    write_wheel(tmp_path, {k: v for k, v in GOOD_WHEEL.items() if k != missing})
    write_sdist(tmp_path, GOOD_SDIST)

    problems = verify_dist.verify(tmp_path)

    assert any(missing in problem for problem in problems)


def test_a_wheel_without_the_dashboard_bundle_fails(tmp_path: Path) -> None:
    # The case this exists for: valid wheel, installs, imports, blank page.
    without_dashboard = {k: v for k, v in GOOD_WHEEL.items() if "dashboard" not in k}
    write_wheel(tmp_path, without_dashboard)
    write_sdist(tmp_path, GOOD_SDIST)

    problems = verify_dist.verify(tmp_path)

    assert len(problems) >= 2  # no index.html and no scripts


def test_an_index_page_with_no_scripts_beside_it_fails(tmp_path: Path) -> None:
    no_assets = {k: v for k, v in GOOD_WHEEL.items() if "/assets/" not in k}
    write_wheel(tmp_path, no_assets)
    write_sdist(tmp_path, GOOD_SDIST)

    assert any("JavaScript" in p for p in verify_dist.verify(tmp_path))


def test_a_wheel_without_a_license_fails(tmp_path: Path) -> None:
    write_wheel(tmp_path, {k: v for k, v in GOOD_WHEEL.items() if "LICENSE" not in k})
    write_sdist(tmp_path, GOOD_SDIST)

    assert any("license" in p for p in verify_dist.verify(tmp_path))


def test_a_wheel_that_ships_the_test_suite_fails(tmp_path: Path) -> None:
    write_wheel(tmp_path, {**GOOD_WHEEL, "tests/test_x.py": ""})
    write_sdist(tmp_path, GOOD_SDIST)

    assert any("tests" in p for p in verify_dist.verify(tmp_path))


@pytest.mark.parametrize(
    "stray",
    ["wevna/__pycache__/api.cpython-312.pyc", "wevna.egg-info/PKG-INFO"],
)
def test_a_wheel_with_compiled_files_or_egg_info_fails(tmp_path: Path, stray: str) -> None:
    write_wheel(tmp_path, {**GOOD_WHEEL, stray: ""})
    write_sdist(tmp_path, GOOD_SDIST)

    assert any(stray in p for p in verify_dist.verify(tmp_path))


def test_an_sdist_with_compiled_files_fails(tmp_path: Path) -> None:
    stray = "src/wevna/__pycache__/api.cpython-312.pyc"
    write_wheel(tmp_path, GOOD_WHEEL)
    write_sdist(tmp_path, {**GOOD_SDIST, stray: ""})

    assert any(stray in p for p in verify_dist.verify(tmp_path))


def test_an_sdist_without_the_bundle_fails_because_wheels_get_built_from_it(
    tmp_path: Path,
) -> None:
    write_wheel(tmp_path, GOOD_WHEEL)
    write_sdist(tmp_path, {k: v for k, v in GOOD_SDIST.items() if "dashboard" not in k})

    assert any("dashboard" in p for p in verify_dist.verify(tmp_path))


def test_an_empty_directory_fails(tmp_path: Path) -> None:
    assert len(verify_dist.verify(tmp_path)) == 2


def test_two_wheels_fail_rather_than_checking_one_and_publishing_both(tmp_path: Path) -> None:
    write_wheel(tmp_path, GOOD_WHEEL)
    write_sdist(tmp_path, GOOD_SDIST)
    (tmp_path / "wevna-0.0.9-py3-none-any.whl").write_bytes(
        (tmp_path / "wevna-0.1.0-py3-none-any.whl").read_bytes()
    )

    assert any("exactly one wheel" in p for p in verify_dist.verify(tmp_path))


def test_main_returns_a_failing_exit_code(tmp_path: Path) -> None:
    assert verify_dist.main(["verify_dist.py", str(tmp_path)]) == 1


def test_main_returns_zero_for_a_good_build(good: Path) -> None:
    assert verify_dist.main(["verify_dist.py", str(good)]) == 0


def test_the_version_is_defined_in_one_place() -> None:
    # pyproject.toml reads the version from __init__.py (hatch dynamic version).
    # If someone adds a literal version back, the two can drift and a release
    # would publish a wevna.__version__ that disagrees with its metadata.
    pyproject = (Path(__file__).parents[1] / "pyproject.toml").read_text()
    assert 'dynamic = ["version"]' in pyproject
    assert "\nversion = " not in pyproject
