"""Lifecycle management for Aegis Core; the menu-bar Python process stays alive."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

from api import get_json, post_json

ROOT = Path(os.environ.get("AEGIS_ROOT", Path(__file__).resolve().parents[3]))
SERVER_LABEL = "com.aegis.local.server"
NATIVE_LABEL = "com.aegis.local.native"


class ServiceController:
    def __init__(self):
        self.gaming = False
        self._owned = None
        self._lock = threading.RLock()

    @staticmethod
    def _launchctl(*args):
        result = subprocess.run(
            ["/bin/launchctl", *args], capture_output=True, text=True,
            timeout=12, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "launchctl failed")
        return result.stdout

    @staticmethod
    def _plist(label):
        return Path.home() / "Library" / "LaunchAgents" / (label + ".plist")

    @staticmethod
    def _domain():
        return f"gui/{os.getuid()}"

    def alive(self):
        try:
            return get_json("/api/health", timeout=2).get("ok") is True
        except (OSError, ValueError, RuntimeError):
            return False

    def _start(self):
        plist = self._plist(SERVER_LABEL)
        if plist.is_file():
            domain = self._domain()
            # bootout may have been requested by Gaming Mode; bootstrap restores it.
            subprocess.run(["/bin/launchctl", "bootout", f"{domain}/{SERVER_LABEL}"],
                           capture_output=True, timeout=7, check=False)
            self._launchctl("enable", f"{domain}/{SERVER_LABEL}")
            self._launchctl("bootstrap", domain, str(plist))
        else:
            node = shutil.which("node")
            if node is None:
                raise RuntimeError("Node.js not installed. Run the LaunchAgent installer.")
            logdir = Path.home() / ".aegis-local" / "logs"
            logdir.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (logdir / "server.log").open("ab") as stdout:
                self._owned = subprocess.Popen(
                    [node, str(ROOT / "src" / "server.mjs")],
                    cwd=ROOT, stdout=stdout, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(25):
            if self.alive():
                return "Aegis core running"
            time.sleep(0.2)
        raise RuntimeError("Aegis core did not start. See ~/.aegis-local/logs/server-error.log.")

    def restart(self):
        with self._lock:
            if self.gaming:
                raise RuntimeError("Exit Gaming Mode before starting Aegis")
            if self._owned and self._owned.poll() is None:
                self._owned.terminate()
                self._owned.wait(timeout=5)
                self._owned = None
            return self._start()

    def ensure_running(self):
        with self._lock:
            if self.gaming:
                raise RuntimeError("Aegis is paused in Gaming Mode")
            if self.alive():
                return "Aegis core ready"
            return self._start()

    def enter_gaming(self):
        with self._lock:
            self.gaming = True
            if self.alive():
                for model in ("kev", "llm"):
                    try:
                        post_json("/api/unload", {"model": model}, timeout=20)
                    except Exception:
                        pass  # still stop the core if we can
            if self._owned and self._owned.poll() is None:
                self._owned.terminate()
                self._owned = None
                return "Gaming Mode: owned Aegis server stopped"
            if self._plist(SERVER_LABEL).exists():
                # Bootout is the correct way to pause a KeepAlive service.
                result = subprocess.run(
                    ["/bin/launchctl", "bootout", f"{self._domain()}/{SERVER_LABEL}"],
                    capture_output=True, text=True, timeout=12, check=False)
                if result.returncode:
                    return "Gaming Mode: voice and shortcuts paused; unable to stop core: " + result.stderr.strip()
                return "Gaming Mode: AI services paused, menu-bar icon stays available"
            return "Gaming Mode: shortcuts paused. Unmanaged core process was not terminated."

    def leave_gaming(self):
        with self._lock:
            self.gaming = False
            return self.ensure_running()

    def stop_native_on_quit(self):
        if self._plist(NATIVE_LABEL).exists():
            subprocess.run(
                ["/bin/launchctl", "bootout", f"{self._domain()}/{NATIVE_LABEL}"],
                capture_output=True, timeout=8, check=False)
