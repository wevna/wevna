#!/usr/bin/env bash
# Runs a command inside this package's virtualenv, creating it first if it
# does not exist or if pyproject.toml has changed since it was last built.
#
# Exists because turbo drives every package through the same four task names,
# and a Python package has to satisfy them without asking the Node toolchain
# to understand pip. The stamp file is what keeps a warm run fast — without
# it, every `pnpm test` would reinstall.
set -euo pipefail

cd "$(dirname "$0")/.."

VENV=".venv"
STAMP="$VENV/.deps-stamp"
PYTHON="${WEVNA_PYTHON:-python3}"

needs_install() {
  [ ! -d "$VENV" ] && return 0
  [ ! -f "$STAMP" ] && return 0
  [ "pyproject.toml" -nt "$STAMP" ] && return 0
  return 1
}

if needs_install; then
  echo "[wevna-python] preparing $VENV"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -e ".[dev]"
  touch "$STAMP"
fi

exec "$VENV/bin/$1" "${@:2}"
