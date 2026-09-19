#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/webapp/backend"
UI_DIR="$ROOT_DIR/webapp/ui"
WORKERS_DIR="$ROOT_DIR/workers"
VRF_SERVICE_DIR="$BACKEND_DIR/vrf-service"
LOG_DIR="$ROOT_DIR/.local-run-logs"

PYTHON_BIN="${PYTHON_BIN:-}"
BACKEND_HOST="${BACKEND_HOST:-localhost}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
UI_HOST="${UI_HOST:-localhost}"
UI_PORT="${UI_PORT:-3200}"
UI_URL="http://${UI_HOST}:${UI_PORT}"
VRF_SERVICE_HOST="${VRF_SERVICE_HOST:-localhost}"
VRF_SERVICE_PORT="${VRF_SERVICE_HOST_PORT:-8788}"
VRF_SERVICE_URL="http://${VRF_SERVICE_HOST}:${VRF_SERVICE_PORT}"

mkdir -p "$LOG_DIR"

for env_file in "$ROOT_DIR/.env" "$ROOT_DIR/.env.local"; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

LOCAL_NETWORK="${NETWORK:-devnet}"
LOCAL_SOLANA_RPC_URL="${SOLANA_RPC_URL:-${SOLANA_HTTP_ENDPOINT:-https://api.devnet.solana.com}}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-30}"
LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON="${LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON:-}"
LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH="${LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH:-}"
LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON="${LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON:-}"
LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS="${LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS:-}"
LOCAL_LOTTERY_ADMIN_VRF_CONFIG_JSON="${LOTTERY_ADMIN_VRF_CONFIG_JSON:-}"
LOCAL_LOTTERY_AUTOSTART_ENABLED="${LOTTERY_AUTOSTART_ENABLED:-true}"
LOCAL_LOTTERY_AUTOSTART_FEE_WALLET="${LOTTERY_AUTOSTART_FEE_WALLET:-EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ}"
LOCAL_LOTTERY_AUTOSTART_KEEPER_WALLET="${LOTTERY_AUTOSTART_KEEPER_WALLET:-6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9}"
LOCAL_LOTTERY_AUTOSTART_MAX_TOTAL_SOL="${LOTTERY_AUTOSTART_MAX_TOTAL_SOL:-0.15}"
LOCAL_LOTTERY_AUTOSTART_FEE_BPS="${LOTTERY_AUTOSTART_FEE_BPS:-300}"
LOCAL_LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH="${LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH:-0x2ec9c530fcd55efd0838bd79245e2543e24f41cd3c2d660eaff43c0387629929}"
LOCAL_PROGRAM_IDL_PATH="${PROGRAM_IDL_PATH:-$WORKERS_DIR/idl/lottery.json}"

resolve_python_bin() {
  local candidates=()
  if [[ -n "$PYTHON_BIN" ]]; then
    candidates+=("$PYTHON_BIN")
  fi
  candidates+=("python3" "/usr/local/bin/python3" "python")

  local candidate
  for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -m uvicorn --version >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      return 0
    fi
  done

  echo "Error: no Python executable with uvicorn is available." >&2
  echo "Run ./install_run_dev_deps.sh or set PYTHON_BIN explicitly." >&2
  exit 1
}

resolve_python_bin

if [[ ! -f "$LOCAL_PROGRAM_IDL_PATH" ]]; then
  echo "Error: lottery program IDL not found: $LOCAL_PROGRAM_IDL_PATH" >&2
  exit 1
fi

LOCAL_LOTTERY_PROGRAM_ID="${LOTTERY_PROGRAM_ID:-${PROGRAM_ID:-}}"
if [[ -z "$LOCAL_LOTTERY_PROGRAM_ID" ]]; then
  LOCAL_LOTTERY_PROGRAM_ID="$("$PYTHON_BIN" -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print(data.get("address") or data.get("metadata", {}).get("address") or "")' "$LOCAL_PROGRAM_IDL_PATH")"
fi
if [[ -z "$LOCAL_LOTTERY_PROGRAM_ID" ]]; then
  echo "Error: lottery program ID is missing from env and IDL: $LOCAL_PROGRAM_IDL_PATH" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not available in PATH" >&2
  exit 1
fi

ensure_port_is_free() {
  local port="$1"
  local label="$2"

  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Error: $label port $port is already in use." >&2
    lsof -iTCP:"$port" -sTCP:LISTEN -n -P >&2 || true
    exit 1
  fi
}

ensure_port_is_free "$BACKEND_PORT" "Backend"
ensure_port_is_free "$UI_PORT" "Frontend"

START_VRF_SERVICE=false
if [[ -n "${SWITCHBOARD_SIGNER_KEYPAIR_JSON:-}" ]]; then
  START_VRF_SERVICE=true
  ensure_port_is_free "$VRF_SERVICE_PORT" "VRF service"
else
  echo "Warning: SWITCHBOARD_SIGNER_KEYPAIR_JSON is not set; vrf-service will not start." >&2
  echo "         Non-empty lotteries cannot complete phase 2 without it." >&2
fi

START_LOTTERY_PHASE_WORKER=false
if [[ "${PHASE2_AUTOMATION_ENABLED:-true}" == "true" ]]; then
  if [[ -n "$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON" || -n "$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH" || -n "$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON" || -n "$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS" ]]; then
    START_LOTTERY_PHASE_WORKER=true
  else
    echo "Warning: lottery-phase-worker will not start because no lottery admin signer is configured." >&2
    echo "         Automatic phase transitions and automatic close are unavailable." >&2
  fi
fi

PIDS=()

cleanup() {
  local exit_code=$?
  trap - INT TERM EXIT

  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo
    echo "Stopping local frontend, backend and workers..."
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
    done

    for pid in "${PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  exit "$exit_code"
}

trap cleanup INT TERM EXIT

start_background_process() {
  local name="$1"
  local workdir="$2"
  shift 2

  echo "Starting $name..."
  (
    cd "$workdir"
    exec "$@"
  ) >"$LOG_DIR/${name}.log" 2>&1 &

  local pid=$!
  PIDS+=("$pid")
  echo "  $name pid=$pid log=$LOG_DIR/${name}.log"
}

wait_for_backend() {
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$BACKEND_URL/ping" >/dev/null 2>&1; then
      echo "Backend is ready at $BACKEND_URL"
      return 0
    fi

    local now
    now="$(date +%s)"
    if (( now - started_at >= STARTUP_TIMEOUT_SECONDS )); then
      echo "Error: backend did not become ready within ${STARTUP_TIMEOUT_SECONDS}s" >&2
      echo "Backend log tail:" >&2
      tail -n 50 "$LOG_DIR/backend.log" >&2 || true
      return 1
    fi

    sleep 1
  done
}

wait_for_ui() {
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$UI_URL" >/dev/null 2>&1; then
      echo "Frontend is ready at $UI_URL"
      return 0
    fi

    local now
    now="$(date +%s)"
    if (( now - started_at >= STARTUP_TIMEOUT_SECONDS )); then
      echo "Error: frontend did not become ready within ${STARTUP_TIMEOUT_SECONDS}s" >&2
      echo "Frontend log tail:" >&2
      tail -n 50 "$LOG_DIR/frontend.log" >&2 || true
      return 1
    fi

    sleep 1
  done
}

wait_for_vrf_service() {
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$VRF_SERVICE_URL/health" >/dev/null 2>&1; then
      echo "VRF service is ready at $VRF_SERVICE_URL"
      return 0
    fi

    local now
    now="$(date +%s)"
    if (( now - started_at >= STARTUP_TIMEOUT_SECONDS )); then
      echo "Error: VRF service did not become ready within ${STARTUP_TIMEOUT_SECONDS}s" >&2
      echo "VRF service log tail:" >&2
      tail -n 50 "$LOG_DIR/vrf-service.log" >&2 || true
      return 1
    fi

    sleep 1
  done
}

BACKEND_PYTHONPATH="$BACKEND_DIR"
WORKERS_PYTHONPATH="$WORKERS_DIR:$BACKEND_DIR"

if [[ "$START_VRF_SERVICE" == "true" ]]; then
  start_background_process \
    "vrf-service" \
    "$VRF_SERVICE_DIR" \
    env PORT="$VRF_SERVICE_PORT" \
    SOLANA_RPC_URL="$LOCAL_SOLANA_RPC_URL" \
    SWITCHBOARD_SIGNER_KEYPAIR_JSON="$SWITCHBOARD_SIGNER_KEYPAIR_JSON" \
    SWITCHBOARD_QUEUE="${SWITCHBOARD_QUEUE:-}" \
    VRF_SERVICE_API_KEY="${VRF_SERVICE_API_KEY:-}" \
    npm start

  wait_for_vrf_service
fi

start_background_process \
  "backend" \
  "$BACKEND_DIR" \
  env PYTHONPATH="$BACKEND_PYTHONPATH" \
  LOTTERY_PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
  PROGRAM_IDL_PATH="$LOCAL_PROGRAM_IDL_PATH" \
  SOLANA_HTTP_ENDPOINT="$LOCAL_SOLANA_RPC_URL" \
  VRF_SERVICE_BASE_URL="$VRF_SERVICE_URL" \
  "$PYTHON_BIN" -m uvicorn main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" --reload

wait_for_backend

start_background_process \
  "frontend" \
  "$UI_DIR" \
  env HOST="$UI_HOST" PORT="$UI_PORT" \
  npm start -- --host "$UI_HOST" --port "$UI_PORT"

wait_for_ui

start_background_process \
  "events-worker" \
  "$WORKERS_DIR" \
  env PYTHONPATH="$WORKERS_PYTHONPATH" \
  PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
  LOTTERY_PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
  PROGRAM_IDL_PATH="$LOCAL_PROGRAM_IDL_PATH" \
  SOLANA_HTTP_ENDPOINT="$LOCAL_SOLANA_RPC_URL" \
  "$PYTHON_BIN" -m events_worker

start_background_process \
  "backfill-worker" \
  "$WORKERS_DIR" \
  env PYTHONPATH="$WORKERS_PYTHONPATH" \
  PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
  LOTTERY_PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
  PROGRAM_IDL_PATH="$LOCAL_PROGRAM_IDL_PATH" \
  SOLANA_HTTP_ENDPOINT="$LOCAL_SOLANA_RPC_URL" \
  "$PYTHON_BIN" -m backfill_worker

start_background_process \
  "bet-finalizer-worker" \
  "$WORKERS_DIR" \
  env PYTHONPATH="$WORKERS_PYTHONPATH" \
  SOLANA_HTTP_ENDPOINT="$LOCAL_SOLANA_RPC_URL" \
  "$PYTHON_BIN" -m bet_finalizer_worker

if [[ "$START_LOTTERY_PHASE_WORKER" == "true" ]]; then
  start_background_process \
    "lottery-phase-worker" \
    "$WORKERS_DIR" \
    env PYTHONPATH="$WORKERS_PYTHONPATH" \
    NETWORK="$LOCAL_NETWORK" \
    LOTTERY_PROGRAM_ID="$LOCAL_LOTTERY_PROGRAM_ID" \
    PROGRAM_IDL_PATH="$LOCAL_PROGRAM_IDL_PATH" \
    SOLANA_HTTP_ENDPOINT="$LOCAL_SOLANA_RPC_URL" \
    VRF_SERVICE_BASE_URL="$VRF_SERVICE_URL" \
    LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON="$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON" \
    LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH="$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH" \
    LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON="$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON" \
    LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS="$LOCAL_LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS" \
    LOTTERY_ADMIN_VRF_CONFIG_JSON="$LOCAL_LOTTERY_ADMIN_VRF_CONFIG_JSON" \
    LOTTERY_AUTOSTART_ENABLED="$LOCAL_LOTTERY_AUTOSTART_ENABLED" \
    LOTTERY_AUTOSTART_FEE_WALLET="$LOCAL_LOTTERY_AUTOSTART_FEE_WALLET" \
    LOTTERY_AUTOSTART_KEEPER_WALLET="$LOCAL_LOTTERY_AUTOSTART_KEEPER_WALLET" \
    LOTTERY_AUTOSTART_MAX_TOTAL_SOL="$LOCAL_LOTTERY_AUTOSTART_MAX_TOTAL_SOL" \
    LOTTERY_AUTOSTART_FEE_BPS="$LOCAL_LOTTERY_AUTOSTART_FEE_BPS" \
    LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH="$LOCAL_LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH" \
    "$PYTHON_BIN" -m lottery_phase_worker
fi

echo
echo "Local services are running."
echo "Backend: $BACKEND_URL"
echo "Frontend: $UI_URL"
echo "Program:  $LOCAL_LOTTERY_PROGRAM_ID"
if [[ "$START_VRF_SERVICE" == "true" ]]; then
  echo "VRF:      $VRF_SERVICE_URL"
else
  echo "VRF:      not started (SWITCHBOARD_SIGNER_KEYPAIR_JSON is missing)"
fi
if [[ "$START_LOTTERY_PHASE_WORKER" == "true" ]]; then
  echo "Lifecycle: automatic"
else
  echo "Lifecycle: manual (lottery-phase-worker is not running)"
fi
echo "Logs:    $LOG_DIR"
echo "Press Ctrl+C to stop everything."

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done
