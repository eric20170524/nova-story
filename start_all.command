#!/bin/bash
set -euo pipefail

# Finder-launched Terminal sessions may not inherit Homebrew's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/local/launcher"
PID_FILE="$RUN_DIR/novastory.pid"
LOG_FILE="$RUN_DIR/novastory.log"
APP_URL="http://127.0.0.1:3000/"

is_our_process() {
  local command_line
  command_line="$(ps -p "$1" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *" --import tsx $ROOT_DIR/server.ts"* ]]
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 18+ and retry."
  exit 1
fi

mkdir -p "$RUN_DIR"
if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && is_our_process "$existing_pid"; then
    echo "NovaStory is already running (PID $existing_pid): $APP_URL"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3000 is already in use. Stop that service before starting NovaStory."
  exit 1
fi

cd "$ROOT_DIR"
if [[ ! -x node_modules/.bin/tsx || ! -x node_modules/.bin/vite ]]; then
  echo "Installing Node.js dependencies..."
  npm install --no-audit --no-fund
fi

# SettingsManager applies this process-only override after loading backend/.env.
export NOVASTORY_COMFYUI_MODE=remote
echo "Starting NovaStory with remote ComfyUI..."
nohup "$(command -v node)" --import tsx "$ROOT_DIR/server.ts" >> "$LOG_FILE" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$PID_FILE"

for ((attempt = 0; attempt < 40; attempt++)); do
  if ! is_our_process "$pid"; then
    break
  fi
  if curl --noproxy '*' --silent --fail --max-time 1 "$APP_URL" > /dev/null; then
    echo "NovaStory is ready: $APP_URL"
    echo "Log: $LOG_FILE"
    if [[ "${NOVASTORY_NO_BROWSER:-}" != "1" ]]; then
      open "$APP_URL"
    fi
    exit 0
  fi
  sleep 0.5
done

if is_our_process "$pid"; then
  kill "$pid" 2>/dev/null || true
fi
rm -f "$PID_FILE"
echo "NovaStory did not become ready. Check the log: $LOG_FILE"
exit 1
