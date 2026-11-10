#!/usr/bin/env python3
"""Headless Aegis voice hotkey daemon: ffmpeg -> Parakeet -> guarded Node API.

No Electron, window, shell interpretation, direct LLM calls, or tool permissions.
Requires the optional pynput dependency and macOS Accessibility/Microphone grants.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def notice(message: str) -> None:
    print(f"[aegis-voice] {message}", flush=True)


def mac_notification(message: str) -> None:
    """Best-effort feedback, never run transcript text through AppleScript."""
    safe = message.replace("\r", " ").replace("\n", " ")[:120]
    try:
        # osascript arg is data, not constructed executable code.
        subprocess.run(
            ["/usr/bin/osascript", "-e",
             'on run argv\n display notification (item 1 of argv) with title "Aegis Local"\nend run',
             safe],
            capture_output=True, timeout=4, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def transcribe(audio_file: Path, output_file: Path) -> str:
    binary = os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe"))
    if not Path(binary).is_file():
        raise RuntimeError(f"Parakeet binary not found: {binary}")
    result = subprocess.run(
        [binary, "--format", "text", "--output", str(output_file), str(audio_file)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=120, check=False, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Parakeet failed: {result.stderr[-300:]}")
    if not output_file.is_file():
        raise RuntimeError("Parakeet did not create a transcript")
    return output_file.read_text(encoding="utf-8").strip()[:12000]


def submit_transcript(text: str) -> dict:
    port = int(os.environ.get("AEGIS_PORT", "3210"))
    if not 1 <= port <= 65535:
        raise ValueError("AEGIS_PORT is invalid")
    url = f"http://127.0.0.1:{port}/api/chat"
    body = json.dumps({"message": text}).encode("utf-8")
    request = Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-Aegis-Local": "1"},
    )
    with urlopen(request, timeout=240) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise RuntimeError("Unexpected Aegis API response")
    return result


class HeadlessVoice:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.recording: subprocess.Popen | None = None
        self.record_dir: Path | None = None
        self.record_path: Path | None = None
        self.processing = False
        self.last_press = 0.0
        self.stopped = False

    def toggle(self) -> None:
        with self.lock:
            now = time.monotonic()
            if self.stopped or now - self.last_press < 0.55:
                return
            self.last_press = now
            if self.processing:
                notice("Already transcribing; hotkey ignored")
                return
            if self.recording is not None:
                proc = self.recording
                audio_path = self.record_path
                directory = self.record_dir
                self.recording = None
                self.processing = True
                threading.Thread(
                    target=self._finish, args=(proc, audio_path, directory),
                    daemon=True, name="aegis-transcribe",
                ).start()
                notice("Recording stopped, transcribing")
                return
            ffmpeg = shutil.which("ffmpeg")
            if ffmpeg is None:
                notice("ffmpeg missing; install with brew install ffmpeg")
                return
            device = os.environ.get("AEGIS_AUDIO_DEVICE", ":0")
            self.record_dir = Path(tempfile.mkdtemp(prefix="aegis-voice-"))
            self.record_path = self.record_dir / "recording.wav"
            try:
                self.recording = subprocess.Popen(
                    [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                     "-f", "avfoundation", "-i", device, "-t", "60", "-y",
                     "-ac", "1", "-ar", "16000", str(self.record_path)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True,
                )
            except OSError as exc:
                notice(f"Could not start recording: {exc}")
                shutil.rmtree(self.record_dir, ignore_errors=True)
                self.recording = None
                self.record_dir = None
                self.record_path = None
                return
            threading.Thread(target=self._watch_recording, args=(self.recording,), daemon=True, name="aegis-recording-monitor").start()
            notice(f"Recording started (device {device}); press Option+Space to stop")
            mac_notification("Recording. Press Option+Space again to stop.")

    def _watch_recording(self, proc: subprocess.Popen) -> None:
        proc.wait()
        with self.lock:
            if self.recording is not proc or self.stopped:
                return
            directory = self.record_dir
            audio_path = self.record_path
            self.recording = None
            self.processing = True
            threading.Thread(
                target=self._finish, args=(proc, audio_path, directory),
                daemon=True, name="aegis-transcribe",
            ).start()
            notice("Recording stopped automatically; transcribing")

    def _finish(self, proc: subprocess.Popen, path: Path | None, directory: Path | None) -> None:
        try:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
            if path is None or not path.is_file() or path.stat().st_size < 44:
                raise RuntimeError("No usable audio recorded. Check device index and Microphone permission.")
            if directory is None:
                raise RuntimeError("Temporary audio directory missing")
            spoken = transcribe(path, directory / "transcript.txt")
            if not spoken:
                notice("No speech recognized")
                mac_notification("No speech detected.")
                return
            notice(f"Transcribed {len(spoken)} characters")
            result = submit_transcript(spoken)
            response_text = str(result.get("response", ""))
            notice(f"Aegis [{result.get('action', '?')}]: {response_text[:550]}")
            if result.get("needsInput"):
                mac_notification("Action requires confirmation. Open Aegis dashboard.")
            else:
                mac_notification((response_text or "Aegis completed the request")[:120])
        except (RuntimeError, OSError, ValueError, HTTPError, URLError, subprocess.TimeoutExpired) as exc:
            notice(f"Voice request failed: {exc}")
            mac_notification("Voice request failed. See ~/.aegis-local/logs/voice.log")
        finally:
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)
            with self.lock:
                self.processing = False
                self.record_dir = None
                self.record_path = None

    def shutdown(self) -> None:
        with self.lock:
            self.stopped = True
            proc = self.recording
            directory = self.record_dir
            self.recording = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
        if directory is not None and not self.processing:
            shutil.rmtree(directory, ignore_errors=True)


def main() -> int:
    if sys.platform != "darwin":
        notice("Voice daemon requires macOS.")
        return 2
    try:
        from pynput.keyboard import GlobalHotKeys
    except ImportError:
        notice("pynput unavailable. Install requirements-voice.txt in the selected Python environment.")
        return 2
    daemon = HeadlessVoice()
    notice("Starting headless voice hotkey. Option+Space toggles recording.")
    try:
        with GlobalHotKeys({"<alt>+<space>": daemon.toggle}) as hotkeys:
            hotkeys.join()
    except KeyboardInterrupt:
        notice("Stopping voice daemon")
    except Exception as exc:
        notice(f"Hotkey listener failed: {exc}")
        return 1
    finally:
        daemon.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
