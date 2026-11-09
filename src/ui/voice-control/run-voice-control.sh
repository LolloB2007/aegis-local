#!/bin/bash
# Aegis Voice Control Launcher
# Starts the menu bar app with voice control

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VOICE_DIR="$PROJECT_ROOT/src/ui/voice-control"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}[Aegis Voice]${NC} Starting..."

# Ensure dependencies are installed
if [ ! -d "$VOICE_DIR/node_modules" ]; then
    echo "Installing Electron dependencies..."
    cd "$VOICE_DIR" && npm install --silent
fi

# Check if Aegis server is running
if ! curl -s http://127.0.0.1:3210/api/bootstrap > /dev/null 2>&1; then
    echo -e "${YELLOW}[Aegis Voice]${NC} Warning: Aegis Local server not responding on port 3210"
    echo "Start it first with: npm start"
fi

# Launch the menu bar app
echo "Launching menu bar app..."
cd "$VOICE_DIR"
exec npm start