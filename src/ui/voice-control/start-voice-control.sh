#!/bin/bash
# Start Aegis Voice Control (Menu Bar App)
# This script launches the voice control as a background process

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# voice-control is at: project/src/ui/voice-control
# Go up 3 levels to get project root
PROJECT_ROOT="$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")"
VOICE_DIR="$SCRIPT_DIR"
NODE_PATH="$VOICE_DIR/node_modules/.bin"

echo "SCRIPT_DIR: $SCRIPT_DIR"
echo "PROJECT_ROOT: $PROJECT_ROOT"

# Change to the voice-control directory
cd "$VOICE_DIR"

# Check if Aegis Local server is running, start if not
if ! curl -s http://127.0.0.1:3210/api/bootstrap > /dev/null 2>&1; then
    echo "Aegis Local server not running, starting..."
    # Start in background
    node "$PROJECT_ROOT/src/server.mjs" &
    sleep 2
fi

# Start the voice control app
echo "Starting Aegis Voice Control..."

# Try npx first, then node_modules/.bin/electron, then just electron
if [ -x "$NODE_PATH/electron" ]; then
    exec "$NODE_PATH/electron" main.js
elif command -v npx &> /dev/null; then
    exec npx electron main.js
else
    exec electron main.js
fi