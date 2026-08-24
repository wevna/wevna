#!/usr/bin/env bash
# Runs a command inside this package's virtualenv, building it first if needed.
#
# Exists because turbo drives every package through the same four task names,
# and a Python package has to satisfy them without asking the Node toolchain to
# understand pip.
#
# The lock is not paranoia. turbo runs build, check, test and lint
# concurrently, so on a cold tree all four invoke this script at once — and
# four concurrent `pip install -e` into one virtualenv corrupts it, leaving
# half-written dist-info directories that pip then reports forever as
# "Ignoring invalid distribution". That failure is timing-dependent, so it
# shows up as an occasionally-red CI run rather than something reproducible.
set -euo pipefail

cd "$(dirname "$0")/.."

VENV=".venv"
STAMP="$VENV/.deps-stamp"
LOCK="$VENV.lock"
PYTHON="${WEVNA_PYTHON:-python3}"
LOCK_TIMEOUT="${WEVNA_LOCK_TIMEOUT:-300}"

needs_install() {
  [ ! -d "$VENV" ] && return 0
  [ ! -f "$STAMP" ] && return 0
  [ "pyproject.toml" -nt "$STAMP" ] && return 0
  return 1
}

install_deps() {
  echo "[wevna-python] preparing $VENV"
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -e ".[dev]"
  touch "$STAMP"
}

if needs_install; then
  # mkdir is atomic on every filesystem worth supporting, which flock is not.
  waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    # Another task got there first. If it finished, there is nothing to do.
    needs_install || break
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      echo "[wevna-python] gave up waiting for $LOCK after ${LOCK_TIMEOUT}s" >&2
      echo "[wevna-python] if no other task is running, remove it and retry" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ -d "$LOCK" ]; then
    # Released even if the install fails, so one bad run does not wedge every
    # later one behind a stale lock.
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    # Re-checked inside the lock: the winner may have installed while we waited.
    if needs_install; then
      install_deps
    fi
    rmdir "$LOCK" 2>/dev/null || true
    trap - EXIT
  fi
fi

exec "$VENV/bin/$1" "${@:2}"
