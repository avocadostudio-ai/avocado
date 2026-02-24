#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-ai-site-editor}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed. Install with: brew install tmux"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not on PATH. Fix your shell PATH and retry."
  exit 1
fi

# Avoid stale port conflicts from previous runs.
for port in 3000 4100 4200; do
  if lsof -ti :"$port" >/dev/null 2>&1; then
    lsof -ti :"$port" | xargs kill -9 >/dev/null 2>&1 || true
  fi
done

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.0" "ulimit -n 65536; pnpm --filter @ai-site-editor/orchestrator dev" C-m

tmux split-window -h -t "$SESSION_NAME:0" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.1" "ulimit -n 65536; pnpm --filter @ai-site-editor/site dev" C-m

tmux split-window -v -t "$SESSION_NAME:0.1" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:0.2" "ulimit -n 65536; pnpm --filter @ai-site-editor/editor dev" C-m

tmux select-layout -t "$SESSION_NAME:0" tiled

echo "Started tmux session: $SESSION_NAME"
echo "Attach: tmux attach -t $SESSION_NAME"
echo "Detach: Ctrl+b then d"
echo "Stop: tmux kill-session -t $SESSION_NAME"
