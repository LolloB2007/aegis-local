#!/bin/bash
# Aegis Voice Control - Main Launcher
# This script should be called by the launch agent or manually

set -e

# Configuration
AEGIS_REPO="/Users/lorenzobarbagelata/Desktop/aegis-local"
AEGIS_PORT=3210
VOICE_CONTROL_PORT=9222

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a process is running
is_running() {
    pgrep -F "$1" > /dev/null 2>&1
}

# Function to start Aegis Local server
start_aegis_server() {
    if is_running "server.mjs"; then
        log_info "Aegis Local server already running"
        return 0
    fi
    
    log_info "Starting Aegis Local server..."
    cd "$AEGIS_REPO"
    
    # Start server in background
    nohup node src/server.mjs > ~/.aegis-local/logs/server.log 2>&1 &
    local pid=$!
    echo $pid > ~/.aegis-local/server.pid
    
    # Wait for server to be ready
    for i in {1..10}; do
        if curl -s "http://127.0.0.1:$AEGIS_PORT/api/bootstrap" > /dev/null 2>&1; then
            log_info "Aegis Local server started (PID: $pid)"
            return 0
        fi
        sleep 1
    done
    
    log_error "Failed to start Aegis Local server"
    return 1
}

# Function to check whisper availability
check_whisper() {
    local whisper_available=false
    
    # Check for whisper.cpp
    if command -v whisper &> /dev/null; then
        if [ -f "$HOME/.cache/whisper/ggml-base.bin" ]; then
            log_info "Found whisper.cpp with base model"
            whisper_available=true
        else
            log_warn "whisper.cpp found but model not downloaded"
            log_info "Run: ollama pull kev:0.8b-q8_0 (for classification)"
            log_info "Download whisper model to: $HOME/.cache/whisper/ggml-base.bin"
        fi
    fi
    
    # Check for Python whisper
    if python3 -c "import whisper" 2>/dev/null; then
        log_info "Found Python whisper library"
        whisper_available=true
    fi
    
    if [ "$whisper_available" = false ]; then
        log_warn "No whisper installation found"
        log_info "Install options:"
        log_info "  - whisper.cpp: brew install whisper.cpp"
        log_info "  - Python whisper: pip install whisper"
    fi
    
    return 0
}

# Function to start voice control
start_voice_control() {
    cd "$AEGIS_REPO/src/ui/voice-control"
    
    # Check if electron is installed
    if [ ! -d "node_modules" ]; then
        log_info "Installing dependencies..."
        npm install --silent
    fi
    
    log_info "Starting Aegis Voice Control menu bar app..."
    npm start &
}

# Main execution
main() {
    log_info "Aegis Voice Control launching..."
    
    # Create logs directory
    mkdir -p ~/.aegis-local/logs
    
    # Check and start Aegis server
    start_aegis_server
    
    # Check whisper availability
    check_whisper
    
    # Start the menu bar app
    start_voice_control
    
    log_info "✅ Aegis Voice Control is running"
    log_info "Press Option+Control to activate voice capture"
    log_info "Click the menu bar icon for more options"
}

# Handle shutdown
cleanup() {
    log_info "Shutting down Aegis Voice Control..."
    
    # Kill voice control
    pkill -f "electron.*main.js" 2>/dev/null || true
    
    # Optionally kill server
    # pkill -f "node.*server.mjs" 2>/dev/null || true
    
    exit 0
}

trap cleanup SIGINT SIGTERM

# Run main
main "$@"