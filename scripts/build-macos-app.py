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
        # Keep the generated .spec (it embeds absolute paths) out of the repo root.
        "--specpath", str(ROOT / "build"),
        "--osx-bundle-identifier", "com.aegis.local.native",
        "--paths", str(ROOT / "src/ui/native"),
        "--paths", str(ROOT / "src/ui/voice-control"),
        "--hidden-import", "app",
        "--hidden-import", "headless_voice",
        "--hidden-import", "AVFoundation",
        "--hidden-import", "HIServices",
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
    # macOS keys Accessibility/Microphone grants for ad-hoc apps to the exact
    # binary hash, so every ad-hoc rebuild silently drops those permissions.
    # Set AEGIS_CODESIGN_IDENTITY to a (self-signed) code-signing certificate
    # name from Keychain Access to keep grants stable across rebuilds.
    identity = os.environ.get("AEGIS_CODESIGN_IDENTITY", "").strip() or "-"
    subprocess.run([
        "/usr/bin/codesign", "--force", "--deep", "--sign", identity, str(APP)
    ], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(APP)], check=True)
    print("\nBuilt " + str(APP))
    print("Stop older Aegis UI agents, then run:")
    print("  ditto dist/Aegis.app /Applications/Aegis.app")
    print("  .venv/bin/python scripts/install-launchagents.py install --with-app")
    print("The native app must receive microphone permission when macOS asks.")
    if identity == "-":
        print("\nNOTE: ad-hoc signed. macOS treats each rebuild as a new app, so re-enable")
        print("Aegis under Privacy & Security > Accessibility (and Microphone) after installing,")
        print("or set AEGIS_CODESIGN_IDENTITY to a stable code-signing certificate.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
