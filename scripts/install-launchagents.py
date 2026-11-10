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
NATIVE = "com.aegis.local.native"
OLD_VOICE = "com.aegis.local.voicecontrol"
ROOT = Path(__file__).resolve().parents[1]
AGENTS = Path.home() / "Library/LaunchAgents"
LOGS = Path.home() / ".aegis-local/logs"
VOICE_FILE = ROOT / "src/ui/voice-control/headless_voice.py"
NATIVE_FILE = ROOT / "src/ui/native/app.py"
APP_EXECUTABLE = Path("/Applications/Aegis.app/Contents/MacOS/Aegis")
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


def make_plist(label: str, command: list[str], *, voice: bool = False, native: bool = False) -> dict:
    return {
        "Label": label,
        "ProgramArguments": command,
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {
            "PATH": ENV_PATH,
            "AEGIS_ROOT": str(ROOT),
            "AEGIS_PORT": os.environ.get("AEGIS_PORT", "3210"),
            "AEGIS_AUDIO_DEVICE": os.environ.get("AEGIS_AUDIO_DEVICE", ":0"),
            "AEGIS_MIC_BACKEND": os.environ.get("AEGIS_MIC_BACKEND", "native" if native else "ffmpeg"),
            "PARAKEET_TRANSCRIBE": os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe")),
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "ProcessType": "Interactive" if native else "Background",
        "Umask": 0o077,
        "StandardOutPath": str(LOGS / ("native.log" if native else "voice.log" if voice else "server.log")),
        "StandardErrorPath": str(LOGS / ("native-error.log" if native else "voice-error.log" if voice else "server-error.log")),
    }


def register(label: str, command: list[str], *, voice: bool = False, native: bool = False) -> None:
    AGENTS.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True, mode=0o700)
    LOGS.chmod(0o700)
    p = plist_path(label)
    bootout(label)
    with p.open("wb") as file:
        plistlib.dump(make_plist(label, command, voice=voice, native=native), file, sort_keys=True)
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


def validate_native() -> None:
    validate_voice()
    if not NATIVE_FILE.is_file():
        raise RuntimeError("Native controller file missing.")
    checks = subprocess.run([sys.executable, "-c",
        "import AppKit, Foundation, objc, Quartz, pynput.keyboard"],
        text=True, capture_output=True, timeout=15, check=False)
    if checks.returncode != 0:
        raise RuntimeError(
            "Native dependencies missing. In your venv run "
            "'python -m pip install -r requirements-native.txt'. "
            + checks.stderr[-300:])


def retire_other(label: str) -> None:
    """Disable the other voice implementation; never register competing hotkeys."""
    bootout(label)
    old = plist_path(label)
    if old.exists():
        backup = old.with_name(old.name + ".v2-disabled")
        if backup.exists():
            backup = old.with_name(old.name + f".v2-disabled-{os.getpid()}")
        old.rename(backup)
        print(f"Disabled previous service {label}; original plist backed up to {backup}")


def install(with_voice: bool, with_native: bool = False, with_app: bool = False) -> None:
    node = shutil.which("node", path=ENV_PATH)
    if not node:
        raise RuntimeError("Cannot locate Node.js. Install Node 20+ and try again.")
    if sum((bool(with_native), bool(with_voice), bool(with_app))) > 1:
        raise RuntimeError("Choose exactly one voice controller: --with-native, --with-voice or --with-app.")
    if with_app:
        if not APP_EXECUTABLE.is_file() or not os.access(APP_EXECUTABLE, os.X_OK):
            raise RuntimeError("No executable Aegis.app in /Applications. Build and copy the app first.")
        tr = Path(os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe")))
        if not tr.is_file() or not os.access(tr, os.X_OK):
            raise RuntimeError("Parakeet executable missing. Set PARAKEET_TRANSCRIBE or install it in ~/.local/bin.")
    elif with_native:
        validate_native()  # Check dependencies before touching login services.
    elif with_voice:
        validate_voice()
    retire_legacy_voice()
    if with_native or with_app:
        retire_other(VOICE)
    elif with_voice:
        retire_other(NATIVE)
    register(SERVER, [str(Path(node).resolve()), str(ROOT / "src/server.mjs")])
    if with_app:
        register(NATIVE, [str(APP_EXECUTABLE)], native=True)
    elif with_native:
        register(NATIVE, [str(Path(sys.executable).absolute()), str(NATIVE_FILE)], native=True)
    elif with_voice:
        register(VOICE, [str(Path(sys.executable).absolute()), str(VOICE_FILE)], voice=True)
    else:
        print("Server installed. To install native overlay use --with-native or --with-app.")
    status()


def uninstall() -> None:
    for label in (NATIVE, VOICE, SERVER):
        bootout(label)
        p = plist_path(label)
        if p.exists():
            p.unlink()
        print(f"Unregistered {label}")
    print("Logs and Aegis settings have been retained.")


def status() -> None:
    for label in (SERVER, NATIVE, VOICE):
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
    parser.add_argument("--with-voice", action="store_true", help="Install legacy headless Python voice (instead of native overlay)")
    parser.add_argument("--with-native", action="store_true", help="Install v2 native AppKit menu-bar overlay")
    parser.add_argument("--with-app", action="store_true", help="Install packaged /Applications/Aegis.app as native LaunchAgent")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("LaunchAgents only work on macOS.", file=sys.stderr)
        return 2
    if os.geteuid() == 0:
        print("Run as your logged-in user, without sudo.", file=sys.stderr)
        return 2
    try:
        if args.command == "install":
            install(args.with_voice, args.with_native, args.with_app)
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
