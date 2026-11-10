#!/usr/bin/env bash
# Compatibility entry point; all launchers share the same source of truth.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/launch.sh" "$@"
