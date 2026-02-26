#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run/devctl"
PID_FILE="$RUN_DIR/dev.pid"
LOG_FILE="$RUN_DIR/dev.log"

# Detached/background launches can have a stripped PATH in some shells/app hosts.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-packages/bin:$PATH"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm || true)}"
if [[ -z "$PNPM_BIN" ]]; then
  for candidate in "/opt/homebrew/bin/pnpm" "$HOME/.npm-packages/bin/pnpm" "/usr/local/bin/pnpm"; do
    if [[ -x "$candidate" ]]; then
      PNPM_BIN="$candidate"
      break
    fi
  done
fi

mkdir -p "$RUN_DIR"

if [[ -z "$PNPM_BIN" ]]; then
  echo "pnpm not found on PATH."
  echo "Set PNPM_BIN explicitly, e.g. PNPM_BIN=/opt/homebrew/bin/pnpm ./scripts/devctl.sh start"
  exit 1
fi

# Run the long-lived workspace command directly instead of "pnpm dev" wrapper.
DEV_CMD=(
  "$PNPM_BIN"
  -r
  --parallel
  --filter @ai-site-editor/site
  --filter @ai-site-editor/editor
  --filter @ai-site-editor/orchestrator
  dev
)

cleanup_orphans() {
  # Only target this workspace's known dev commands.
  pkill -f "/Users/yury/Projects/ai-site-editor/apps/site/node_modules/.*/next dev -p 3000" 2>/dev/null || true
  pkill -f "/Users/yury/Projects/ai-site-editor/apps/editor/node_modules/.*/vite/bin/vite.js --port 4100 --strictPort" 2>/dev/null || true
  pkill -f "/Users/yury/Projects/ai-site-editor/apps/orchestrator/node_modules/.*/tsx/dist/cli.mjs watch src/index.ts" 2>/dev/null || true
  pkill -f "pnpm -r --parallel --filter @ai-site-editor/site --filter @ai-site-editor/editor --filter @ai-site-editor/orchestrator dev" 2>/dev/null || true
}

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  local cmd
  cmd="$(ps -p "$pid" -o command= || true)"
  [[ "$cmd" == *"pnpm"*"--parallel"* ]]
}

check_health() {
  curl -sf "http://localhost:4200/status/planner" >/dev/null || return 1
  curl -sf "http://localhost:3000" >/dev/null || return 1
  curl -sf "http://localhost:4100" >/dev/null || return 1
}

wait_for_ready() {
  local timeout_secs="${1:-60}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if ! is_running; then
      echo "dev stack exited before becoming healthy."
      return 1
    fi

    if check_health; then
      echo "dev stack is healthy."
      return 0
    fi

    local now elapsed
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if (( elapsed >= timeout_secs )); then
      echo "timed out waiting for health (${timeout_secs}s)."
      return 1
    fi

    sleep 1
  done
}

parse_wait_args() {
  WAIT_MODE="0"
  WAIT_TIMEOUT="60"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wait)
        WAIT_MODE="1"
        shift
        ;;
      --timeout)
        WAIT_MODE="1"
        if [[ $# -lt 2 ]]; then
          echo "missing value for --timeout"
          exit 1
        fi
        WAIT_TIMEOUT="$2"
        shift 2
        ;;
      *)
        echo "unknown option: $1"
        exit 1
        ;;
    esac
  done
}

start() {
  local wait_mode="${1:-0}"
  local wait_timeout="${2:-60}"

  if is_running; then
    echo "dev stack already running (pid $(cat "$PID_FILE"))."
    echo "logs: $LOG_FILE"
    if [[ "$wait_mode" == "1" ]]; then
      wait_for_ready "$wait_timeout"
    fi
    return 0
  fi

  # Remove stale pid file before starting a fresh managed process.
  rm -f "$PID_FILE"
  cleanup_orphans

  # Launch from repo root and disown so it remains detached from caller shell.
  (
    cd "$ROOT_DIR"
    nohup "${DEV_CMD[@]}" >"$LOG_FILE" 2>&1 < /dev/null &
    local child_pid="$!"
    disown "$child_pid" 2>/dev/null || true
    echo "$child_pid" > "$PID_FILE"
  )

  local pid
  pid="$(cat "$PID_FILE")"

  sleep 1
  if ! is_running; then
    echo "failed to start dev stack. check logs: $LOG_FILE"
    return 1
  fi

  echo "dev stack started (pid $pid)."
  echo "logs: $LOG_FILE"

  if [[ "$wait_mode" == "1" ]]; then
    wait_for_ready "$wait_timeout" || {
      echo "recent logs:"
      logs 120
      return 1
    }
  fi
}

stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "dev stack is not running (no pid file)."
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    cleanup_orphans
    echo "removed stale pid file and cleaned orphaned dev processes."
    return 0
  fi

  collect_descendants() {
    local parent="$1"
    local children
    children="$(pgrep -P "$parent" || true)"
    for child in $children; do
      echo "$child"
      collect_descendants "$child"
    done
  }

  local targets
  targets="$(collect_descendants "$pid" | tr '\n' ' ') $pid"

  # Kill the managed process tree only; do not kill the caller's process group.
  kill -TERM $targets 2>/dev/null || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "dev stack stopped."
      return 0
    fi
    sleep 0.5
  done

  kill -KILL $targets 2>/dev/null || true

  rm -f "$PID_FILE"
  cleanup_orphans
  echo "dev stack force-stopped."
}

status() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    local pgid
    pgid="$(ps -o pgid= -p "$pid" | tr -d ' ' || true)"
    echo "running"
    echo "pid: $pid"
    if [[ -n "$pgid" ]]; then
      echo "pgid: $pgid"
    fi
    echo "log: $LOG_FILE"
    return 0
  fi

  echo "stopped"
  return 1
}

logs() {
  local lines="${1:-120}"
  if [[ -f "$LOG_FILE" ]]; then
    tail -n "$lines" "$LOG_FILE"
  else
    echo "no log file yet: $LOG_FILE"
  fi
}

doctor() {
  local failed="0"

  echo "== devctl doctor =="
  echo "time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "root: $ROOT_DIR"
  echo "pid_file: $PID_FILE"
  echo "log_file: $LOG_FILE"
  echo

  echo "-- status --"
  status || true
  echo

  echo "-- pid details --"
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "tracked_pid: $pid"
    ps -p "$pid" -o pid,ppid,pgid,tty,etime,command || true
    echo "children:"
    pgrep -P "$pid" | tr '\n' ' ' || true
    echo
  else
    echo "no pid file"
  fi
  echo

  echo "-- listeners (3000,4100,4200) --"
  lsof -nP -iTCP:3000 -iTCP:4100 -iTCP:4200 -sTCP:LISTEN || true
  echo

  echo "-- health --"
  if curl -sf "http://localhost:4200/status/planner" >/dev/null; then
    echo "orchestrator: ok"
  else
    echo "orchestrator: fail"
    failed="1"
  fi
  if curl -sf "http://localhost:3000" >/dev/null; then
    echo "site: ok"
  else
    echo "site: fail"
    failed="1"
  fi
  if curl -sf "http://localhost:4100" >/dev/null; then
    echo "editor: ok"
  else
    echo "editor: fail"
    failed="1"
  fi
  echo

  echo "-- matching processes --"
  ps -axo pid,ppid,pgid,tty,etime,command | rg "pnpm -r --parallel --filter @ai-site-editor/site --filter @ai-site-editor/editor --filter @ai-site-editor/orchestrator dev|/Users/yury/Projects/ai-site-editor/apps/site/node_modules/.*/next dev -p 3000|/Users/yury/Projects/ai-site-editor/apps/editor/node_modules/.*/vite/bin/vite.js --port 4100 --strictPort|/Users/yury/Projects/ai-site-editor/apps/orchestrator/node_modules/.*/tsx/dist/cli.mjs watch src/index.ts" -S || true
  echo

  echo "-- recent logs --"
  logs 80 || true

  if [[ "$failed" == "1" ]]; then
    return 1
  fi
}

usage() {
  cat <<USAGE
Usage: scripts/devctl.sh <command> [options]

Commands:
  start [--wait] [--timeout SECS]   Start managed dev stack (singleton)
  stop                              Stop managed dev stack
  restart [--wait] [--timeout SECS] Restart managed dev stack
  status                            Print running status
  logs [N]                          Tail log file (default 120 lines)
  doctor                            Diagnose PID/ports/health/orphans
USAGE
}

command="${1:-}"
shift || true

case "$command" in
  start)
    parse_wait_args "$@"
    start "$WAIT_MODE" "$WAIT_TIMEOUT"
    ;;
  stop)
    stop
    ;;
  restart)
    parse_wait_args "$@"
    stop
    start "$WAIT_MODE" "$WAIT_TIMEOUT"
    ;;
  status)
    status
    ;;
  logs)
    logs "${1:-120}"
    ;;
  doctor)
    doctor
    ;;
  *)
    usage
    exit 1
    ;;
esac
