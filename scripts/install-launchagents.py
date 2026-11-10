#!/usr/bin/env python3
"""Install, uninstall, diagnose per-user launchd jobs for Aegis Local.

This must be executed on the owner's Mac. Merely cloning the repository never
registers a LaunchAgent. Do not run with sudo.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

SERVER = "com.aegis.local.server"
VOICE = "com.aegis.local.voice"
OLD_VOICE = "com.aegis.local.voicecontrol"
ROOT = Path(__file__).resolve().parents[1]
AGENTS = Path.home() / "Library/LaunchAgents"
LOGS = Path.home() / ".aegis-local/logs"
VOICE_FILE = ROOT / "src/ui/voice-control/headless_voice.py"
ENV_PATH = ":".join(filter(None, [
    str(Path.home() / ".local/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    os.environ.get("PATH", ""),
]))


def launchctl(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(["/bin/launchctl", *args], text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"launchctl {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def domain() -> str:
    return f"gui/{os.getuid()}"


def plist_path(label: str) -> Path:
    return AGENTS / (label + ".plist")


def bootout(label: str) -> None:
    launchctl("bootout", f"{domain()}/{label}", check=False)


def make_plist(label: str, command: list[str], *, voice: bool = False) -> dict:
    return {
        "Label": label,
        "ProgramArguments": command,
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {
            "PATH": ENV_PATH,
            "AEGIS_PORT": os.environ.get("AEGIS_PORT", "3210"),
            "AEGIS_AUDIO_DEVICE": os.environ.get("AEGIS_AUDIO_DEVICE", ":0"),
            "PARAKEET_TRANSCRIBE": os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe")),
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": str(LOGS / ("voice.log" if voice else "server.log")),
        "StandardErrorPath": str(LOGS / ("voice-error.log" if voice else "server-error.log")),
    }


def register(label: str, command: list[str], *, voice: bool = False) -> None:
    AGENTS.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True, mode=0o700)
    LOGS.chmod(0o700)
    p = plist_path(label)
    bootout(label)
    with p.open("wb") as file:
        plistlib.dump(make_plist(label, command, voice=voice), file, sort_keys=True)
    p.chmod(0o600)
    launchctl("enable", f"{domain()}/{label}", check=True)
    launchctl("bootstrap", domain(), str(p), check=True)
    launchctl("kickstart", "-k", f"{domain()}/{label}", check=True)
    print(f"Installed {label} at {p}")


def validate_voice() -> None:
    if not VOICE_FILE.is_file():
        raise RuntimeError("headless_voice.py is missing.")
    if shutil.which("ffmpeg", path=ENV_PATH) is None:
        raise RuntimeError("ffmpeg missing. Install with: brew install ffmpeg")
    tr = os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe"))
    if not Path(tr).is_file():
        raise RuntimeError("Parakeet binary missing. Set PARAKEET_TRANSCRIBE to its executable path.")
    result = subprocess.run([sys.executable, "-c", "import pynput.keyboard"], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            "pynput missing from this Python interpreter. Run "
            "python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-voice.txt, "
            "then .venv/bin/python scripts/install-launchagents.py install --with-voice"
        )


def retire_legacy_voice() -> None:
    """Do not let the old Electron login job compete for the same hotkey."""
    old = plist_path(OLD_VOICE)
    bootout(OLD_VOICE)  # Also stop a legacy service whose plist has gone missing.
    if old.exists():
        launchctl("disable", f"{domain()}/{OLD_VOICE}")
        backup = old.with_name(old.name + ".v1.4-disabled")
        if backup.exists():
            backup = old.with_name(old.name + f".v1.4-disabled-{os.getpid()}")
        old.rename(backup)
        print(f"Disabled obsolete voice LaunchAgent; backup retained at {backup}")


def install(with_voice: bool) -> None:
    node = shutil.which("node", path=ENV_PATH)
    if not node:
        raise RuntimeError("Cannot locate Node.js. Install Node 20+ and try again.")
    if with_voice:
        validate_voice()  # Fail before altering the existing service.
    retire_legacy_voice()
    register(SERVER, [str(Path(node).resolve()), str(ROOT / "src/server.mjs")])
    if with_voice:
        register(VOICE, [str(Path(sys.executable).absolute()), str(VOICE_FILE)], voice=True)  # Preserve venv interpreter shim
    else:
        print("Server installed. To install voice as well, rerun with --with-voice.")
    status()


def uninstall() -> None:
    for label in (VOICE, SERVER):
        bootout(label)
        p = plist_path(label)
        if p.exists():
            p.unlink()
        print(f"Unregistered {label}")
    print("Logs and Aegis settings have been retained.")


def status() -> None:
    for label in (SERVER, VOICE):
        result = launchctl("print", f"{domain()}/{label}")
        if result.returncode != 0:
            print(f"{label}: not registered (or not running in current GUI login)")
        else:
            lines = [line.strip() for line in result.stdout.splitlines()
                     if "state =" in line or "pid =" in line or "last exit code =" in line]
            print(f"{label}: " + "; ".join(lines[:6]))


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Aegis login-time LaunchAgents")
    parser.add_argument("command", choices=["install", "status", "uninstall"])
    parser.add_argument("--with-voice", action="store_true", help="Install optional Python hotkey/transcription daemon")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("LaunchAgents only work on macOS.", file=sys.stderr)
        return 2
    if os.geteuid() == 0:
        print("Run as your logged-in user, without sudo.", file=sys.stderr)
        return 2
    try:
        if args.command == "install":
            install(args.with_voice)
        elif args.command == "uninstall":
            uninstall()
        else:
            status()
        return 0
    except (RuntimeError, OSError) as exc:
        print(f"LaunchAgent setup failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
