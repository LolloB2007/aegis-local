#!/usr/bin/env python3
"""Entry point for the bundled Aegis menu bar app (not the Node executor)."""
from __future__ import annotations

import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(ROOT / "src/ui/native"))
    sys.path.insert(0, str(ROOT / "src/ui/voice-control"))
    os.environ.setdefault("AEGIS_ROOT", str(ROOT))
else:
    # Override via the AEGIS_ROOT LaunchAgent environment variable when the
    # checkout is not ~/aegis-local. No shell or tool execution is bundled.
    os.environ.setdefault("AEGIS_ROOT", str(Path.home() / "aegis-local"))

os.environ["PATH"] = ":".join(filter(None, [
    str(Path.home() / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
    "/usr/bin", "/bin", os.environ.get("PATH", "")]))
os.environ.setdefault("PARAKEET_TRANSCRIBE", str(
    Path.home() / ".local/bin/parakeet-transcribe"))

from app import main

if __name__ == "__main__":
    main()
