#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_FILE="$RUN_DIR/pnpm-dev.log"
PID_FILE="$RUN_DIR/pnpm-dev.pid"
SITE_PORT="${SITE_PORT:-3000}"
EDITOR_PORT="${EDITOR_PORT:-4100}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-4200}"

mkdir -p "$RUN_DIR"

echo "Restarting dev servers for ai-site-editor..."

echo "1) Killing any processes on ports ${SITE_PORT}, ${EDITOR_PORT}, ${ORCHESTRATOR_PORT}"
for port in "$SITE_PORT" "$EDITOR_PORT" "$ORCHESTRATOR_PORT"; do
  lsof -ti :"$port" | xargs -r kill -9 || true
done

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]]; then
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

echo "2) Starting pnpm dev in background from repo root"
(
  cd "$ROOT_DIR"
  nohup pnpm dev >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
)

sleep 4

echo "3) Verifying servers"
site_up="down"
editor_up="down"
orchestrator_up="down"

if curl -sf "http://localhost:${ORCHESTRATOR_PORT}/health" >/dev/null; then
  orchestrator_up="up"
fi
if curl -sf "http://localhost:${EDITOR_PORT}" >/dev/null; then
  editor_up="up"
fi
if curl -sf "http://localhost:${SITE_PORT}" >/dev/null; then
  site_up="up"
fi

echo "4) Server status"
echo "orchestrator (${ORCHESTRATOR_PORT}): $orchestrator_up"
echo "editor (${EDITOR_PORT}): $editor_up"
echo "site (${SITE_PORT}): $site_up"
echo "log: $LOG_FILE"
echo "pid: $(cat "$PID_FILE" 2>/dev/null || echo unknown)"
