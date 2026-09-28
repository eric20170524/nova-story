#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/local/launcher/novastory.pid"

is_our_process() {
  local command_line
  command_line="$(ps -p "$1" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *" --import tsx $ROOT_DIR/server.ts"* ]]
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "No NovaStory process started by start_all.command was found."
  exit 0
fi

pid="$(cat "$PID_FILE")"
if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! is_our_process "$pid"; then
  rm -f "$PID_FILE"
  echo "NovaStory is not running; removed its stale PID file."
  exit 0
fi

echo "Stopping NovaStory (PID $pid)..."
kill "$pid"
for ((attempt = 0; attempt < 30; attempt++)); do
  if ! is_our_process "$pid"; then
    rm -f "$PID_FILE"
    echo "NovaStory stopped."
    exit 0
  fi
  sleep 0.2
done

if is_our_process "$pid"; then
  kill -KILL "$pid"
fi
rm -f "$PID_FILE"
echo "NovaStory stopped."
