#!/usr/bin/env python3
"""Create a menu-bar Aegis.app with stable macOS microphone TCC identity.

Requires macOS, the repository venv, and pyinstaller. The Node backend,
Ollama and Parakeet remain separate and are NOT bundled.
"""
from __future__ import annotations

import os
from pathlib import Path
import plistlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "dist/Aegis.app"

def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("Aegis.app must be built on macOS.")
    if os.geteuid() == 0:
        raise SystemExit("Build as your regular macOS user, never sudo.")
    args = [
        sys.executable, "-m", "PyInstaller",
        "--clean", "--noconfirm", "--onedir", "--windowed",
        "--name", "Aegis",
        "--osx-bundle-identifier", "com.aegis.local.native",
        "--paths", str(ROOT / "src/ui/native"),
        "--paths", str(ROOT / "src/ui/voice-control"),
        "--hidden-import", "app",
        "--hidden-import", "headless_voice",
        "--hidden-import", "AVFoundation",
        "--hidden-import", "pynput.keyboard._darwin",
        str(ROOT / "scripts/aegis_app_entry.py"),
    ]
    subprocess.run(args, cwd=ROOT, check=True)
    plist = APP / "Contents/Info.plist"
    with plist.open("rb") as stream:
        data = plistlib.load(stream)
    data.update({
        "CFBundleIdentifier": "com.aegis.local.native",
        "CFBundleDisplayName": "Aegis",
        "NSMicrophoneUsageDescription": "Aegis locally records speech for Parakeet transcription.",
        "LSUIElement": True,
    })
    with plist.open("wb") as stream:
        plistlib.dump(data, stream)
    # Editing Info.plist invalidates the build-time signature; re-sign after.
    # Ad-hoc identity is only for personal testing, not notarized distribution.
    subprocess.run([
        "/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(APP)
    ], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(APP)], check=True)
    print("\nBuilt " + str(APP))
    print("Stop older Aegis UI agents, then run:")
    print("  ditto dist/Aegis.app /Applications/Aegis.app")
    print("  .venv/bin/python scripts/install-launchagents.py install --with-app")
    print("The native app must receive microphone permission when macOS asks.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
