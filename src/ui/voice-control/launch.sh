#!/usr/bin/env bash
# Portable launcher for the guarded Aegis server and Electron voice UI.
set -euo pipefail
VOICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$VOICE_DIR/../../.." && pwd)"
PORT="${AEGIS_PORT:-3210}"
mkdir -p "$HOME/.aegis-local/logs"

if ! curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/api/bootstrap" >/dev/null; then
  echo "Starting local Aegis server on port $PORT"
  (cd "$ROOT" && nohup node src/server.mjs > "$HOME/.aegis-local/logs/server.log" 2>&1 &)
  for _ in $(seq 1 20); do
    if curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/api/bootstrap" >/dev/null; then break; fi
    sleep 0.5
  done
  if ! curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/api/bootstrap" >/dev/null; then
    echo "Aegis did not start; see ~/.aegis-local/logs/server.log" >&2
    exit 1
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Warning: ffmpeg unavailable; voice capture needs ffmpeg installed." >&2
fi
if [[ ! -x "${PARAKEET_TRANSCRIBE:-$HOME/.local/bin/parakeet-transcribe}" ]]; then
  echo "Warning: Parakeet executable not found. Set PARAKEET_TRANSCRIBE." >&2
fi
cd "$VOICE_DIR"
if [[ ! -x node_modules/.bin/electron ]]; then npm ci; fi
echo "Press Option+Space to start/stop voice capture. Audio device: ${AEGIS_AUDIO_DEVICE:-:0}"
exec npm start
