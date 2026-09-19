#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

BACKEND_REQUIREMENTS="$ROOT_DIR/webapp/backend/requirements.txt"
WORKERS_REQUIREMENTS="$ROOT_DIR/workers/requirements.txt"
UI_DIR="$ROOT_DIR/webapp/ui"
VRF_SERVICE_DIR="$ROOT_DIR/webapp/backend/vrf-service"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: Python executable not found: $PYTHON_BIN" >&2
  exit 1
fi

if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
  echo "Error: pip is not available for $PYTHON_BIN" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not available in PATH" >&2
  exit 1
fi

if [[ ! -f "$BACKEND_REQUIREMENTS" ]]; then
  echo "Error: backend requirements file not found: $BACKEND_REQUIREMENTS" >&2
  exit 1
fi

if [[ ! -f "$WORKERS_REQUIREMENTS" ]]; then
  echo "Error: workers requirements file not found: $WORKERS_REQUIREMENTS" >&2
  exit 1
fi

echo "Installing backend dependencies from $BACKEND_REQUIREMENTS"
"$PYTHON_BIN" -m pip install -r "$BACKEND_REQUIREMENTS"

echo
echo "Installing workers dependencies from $WORKERS_REQUIREMENTS"
"$PYTHON_BIN" -m pip install -r "$WORKERS_REQUIREMENTS"

install_node_dependencies() {
  local project_dir="$1"
  local label="$2"

  if [[ ! -f "$project_dir/package.json" || ! -f "$project_dir/package-lock.json" ]]; then
    echo "Error: package.json/package-lock.json not found for $label: $project_dir" >&2
    exit 1
  fi

  echo
  echo "Installing $label dependencies"
  (
    cd "$project_dir"
    npm ci
  )
}

install_node_dependencies "$UI_DIR" "frontend"
install_node_dependencies "$VRF_SERVICE_DIR" "VRF service"

echo
echo "Done. Dependencies for run_dev.sh are installed."
