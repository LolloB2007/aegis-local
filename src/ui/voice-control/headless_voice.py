#!/usr/bin/env python3
"""Local voice capture: native AVAudioRecorder by default, FFmpeg fallback,
then Parakeet transcription. No transcript goes to logs or privileged tools.
"""
from __future__ import annotations

from array import array
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def notice(message: str) -> None:
    print(f"[aegis-voice] {message}", flush=True)


def mac_notification(message: str) -> None:
    safe = message.replace("\r", " ").replace("\n", " ")[:120]
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e",
             'on run argv\n display notification (item 1 of argv) with title "Aegis Local"\nend run',
             safe],
            capture_output=True, timeout=4, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def microphone_permission(on_state=None) -> bool:
    """Request TCC permission from *this* process, not an FFmpeg subprocess.

    An undecided permission request is asynchronous: do not block AppKit's
    main thread. The user presses the voice hotkey again after granting.
    """
    if sys.platform != "darwin":
        return True
    try:
        import AVFoundation as AV
    except ImportError:
        message = "AVFoundation unavailable. Install requirements-native.txt and rebuild Aegis.app."
        notice(message)
        if on_state:
            on_state("error: " + message)
        return False
    try:
        status = int(AV.AVCaptureDevice.authorizationStatusForMediaType_(AV.AVMediaTypeAudio))
        if status == 3:  # AVAuthorizationStatusAuthorized
            return True
        if status == 0:  # AVAuthorizationStatusNotDetermined
            def callback(granted):
                message = ("Microphone enabled. Press Option+Space again to record." if granted else
                           "error: Microphone permission denied. Enable Aegis in System Settings > Privacy & Security > Microphone.")
                notice(message)
                if on_state:
                    on_state(message)
            AV.AVCaptureDevice.requestAccessForMediaType_completionHandler_(AV.AVMediaTypeAudio, callback)
            notice("Requested microphone permission from Aegis; press hotkey again once approved")
            if on_state:
                on_state("microphone_permission")
            return False
        message = "Microphone access denied or restricted. Enable Aegis in System Settings > Privacy & Security > Microphone."
        notice(message)
        if on_state:
            on_state("error: " + message)
        return False
    except Exception as exc:
        message = "Could not check microphone permission: " + str(exc)
        notice(message)
        if on_state:
            on_state("error: " + message)
        return False


class NativeRecorder:
    """AVAudioRecorder captures inside the signed Aegis.app process.

    Uses the macOS default input device instead of FFmpeg's ambiguous ':0'.
    WAV PCM is required because Parakeet reads the resulting file directly.
    """
    def __init__(self, output: Path) -> None:
        import AVFoundation as AV
        from Foundation import NSURL
        settings = {
            AV.AVFormatIDKey: int.from_bytes(b"lpcm", "big"),
            AV.AVSampleRateKey: 16000.0,
            AV.AVNumberOfChannelsKey: 1,
            AV.AVLinearPCMBitDepthKey: 16,
            AV.AVLinearPCMIsFloatKey: False,
            AV.AVLinearPCMIsBigEndianKey: False,
        }
        result = AV.AVAudioRecorder.alloc().initWithURL_settings_error_(
            NSURL.fileURLWithPath_(str(output)), settings, None)
        self.recorder, error = result if isinstance(result, tuple) else (result, None)
        if self.recorder is None:
            raise RuntimeError("AVAudioRecorder could not initialize: " + str(error))
        if not self.recorder.prepareToRecord():
            raise RuntimeError("AVAudioRecorder could not prepare the microphone.")

    def start(self) -> None:
        if not self.recorder.recordForDuration_(60.0):
            raise RuntimeError("AVAudioRecorder failed to start. Check Aegis microphone permission.")

    def stop(self) -> None:
        self.recorder.stop()

    def running(self) -> bool:
        return bool(self.recorder.isRecording())


def audio_levels(path: Path) -> tuple[int, float, float]:
    """Bounded WAV sanity check before invoking Parakeet.

    Returns (sample_count, peak, RMS). An all-zero or near-silent recording
    is a capture problem, not a 'no speech' transcription result.
    """
    try:
        with wave.open(str(path), "rb") as sound:
            if sound.getnchannels() != 1 or sound.getsampwidth() != 2:
                raise RuntimeError("Recorded audio was not 16-bit mono PCM WAV.")
            rate = sound.getframerate()
            if not 8000 <= rate <= 48000:
                raise RuntimeError("Unexpected microphone sample rate.")
            count = min(sound.getnframes(), rate * 60)
            raw = sound.readframes(count)
        samples = array("h")
        samples.frombytes(raw[:len(raw) // 2 * 2])
        if sys.byteorder != "little":
            samples.byteswap()
        sample_count = len(samples)
        if sample_count < 1600:
            raise RuntimeError("No usable audio recorded. Check microphone access.")
        subset = samples[::8]
        peak = max(abs(value) for value in subset)
        rms = math.sqrt(sum(value * value for value in subset) / len(subset))
        return sample_count, peak, rms
    except (OSError, EOFError, wave.Error) as exc:
        raise RuntimeError("Invalid or incomplete audio recording: " + str(exc)) from exc


def transcribe(audio_file: Path, output_file: Path) -> str:
    binary = os.environ.get("PARAKEET_TRANSCRIBE", str(Path.home() / ".local/bin/parakeet-transcribe"))
    if not Path(binary).is_file():
        raise RuntimeError("Parakeet executable not found: " + binary)
    result = subprocess.run(
        [binary, "--format", "text", "--output", str(output_file), str(audio_file)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=120, check=False, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("Parakeet failed: " + result.stderr[-350:])
    if not output_file.is_file():
        raise RuntimeError("Parakeet did not create a transcript.")
    return output_file.read_text(encoding="utf-8").strip()[:12000]


def submit_transcript(text: str) -> dict:
    port = int(os.environ.get("AEGIS_PORT", "3210"))
    if not 1 <= port <= 65535:
        raise ValueError("AEGIS_PORT is invalid")
    url = "http://127.0.0.1:" + str(port) + "/api/chat"
    body = json.dumps({"message": text}).encode("utf-8")
    request = Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Aegis-Local": "1"},
    )
    with urlopen(request, timeout=240) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise RuntimeError("Unexpected Aegis API response")
    return result


class HeadlessVoice:
    def __init__(self, on_transcript=None, on_state=None) -> None:
        self.lock = threading.Lock()
        self.recording = None
        self.record_dir: Path | None = None
        self.record_path: Path | None = None
        self.processing = False
        self.last_press = 0.0
        self.stopped = False
        self.on_transcript = on_transcript
        self.on_state = on_state

    def _state(self, state: str) -> None:
        if self.on_state:
            self.on_state(state)
        elif state.startswith("error:"):
            mac_notification(state[6:].strip())

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
                recorder = self.recording
                audio_path = self.record_path
                directory = self.record_dir
                self.recording = None
                self.processing = True
                if isinstance(recorder, NativeRecorder):
                    # Stop native capture on the main AppKit / hotkey thread.
                    recorder.stop()
                threading.Thread(
                    target=self._finish, args=(recorder, audio_path, directory),
                    daemon=True, name="aegis-transcribe",
                ).start()
                notice("Recording stopped; validating audio before Parakeet")
                self._state("transcribing")
                return

            if not microphone_permission(self._state):
                return
            backend = os.environ.get("AEGIS_MIC_BACKEND", "native").strip().lower()
            if backend not in ("native", "ffmpeg"):
                self._state("error: AEGIS_MIC_BACKEND must be native or ffmpeg.")
                return
            self.record_dir = Path(tempfile.mkdtemp(prefix="aegis-voice-"))
            self.record_path = self.record_dir / "recording.wav"
            try:
                if backend == "native":
                    self.recording = NativeRecorder(self.record_path)
                    self.recording.start()
                    notice("Native AVAudioRecorder started (macOS default microphone)")
                else:
                    ffmpeg = shutil.which("ffmpeg")
                    if ffmpeg is None:
                        raise RuntimeError("FFmpeg not found in PATH.")
                    device = os.environ.get("AEGIS_AUDIO_DEVICE", ":0")
                    # Capture FFmpeg errors for actual diagnostics instead of /dev/null.
                    with (self.record_dir / "ffmpeg-error.log").open("wb") as errors:
                        self.recording = subprocess.Popen(
                            [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "warning",
                             "-f", "avfoundation", "-i", device, "-t", "60", "-y",
                             "-ac", "1", "-ar", "16000", str(self.record_path)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=errors, start_new_session=True,
                        )
                    notice("FFmpeg recording started (audio device " + device + ")")
            except Exception as exc:
                message = "Could not start microphone recording: " + str(exc)
                notice(message)
                self._state("error: " + message)
                shutil.rmtree(self.record_dir, ignore_errors=True)
                self.recording = self.record_dir = self.record_path = None
                return
            threading.Thread(
                target=self._watch_recording, args=(self.recording,),
                daemon=True, name="aegis-recording-monitor",
            ).start()
            self._state("listening")
            if not self.on_state:
                mac_notification("Recording. Press Option+Space again to stop.")

    def _watch_recording(self, recorder) -> None:
        if isinstance(recorder, NativeRecorder):
            while recorder.running() and not self.stopped:
                time.sleep(0.15)
        else:
            recorder.wait()
        with self.lock:
            if self.recording is not recorder or self.stopped:
                return
            directory = self.record_dir
            audio_path = self.record_path
            self.recording = None
            self.processing = True
            threading.Thread(
                target=self._finish, args=(recorder, audio_path, directory),
                daemon=True, name="aegis-transcribe",
            ).start()
            notice("Recording stopped automatically; validating audio")
            self._state("transcribing")

    def _finish(self, recorder, path: Path | None, directory: Path | None) -> None:
        try:
            if not isinstance(recorder, NativeRecorder):
                if recorder.poll() is None:
                    recorder.send_signal(signal.SIGINT)
                try:
                    recorder.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    recorder.kill()
                    recorder.wait(timeout=3)
            diagnostic = ""
            if directory is not None:
                log = directory / "ffmpeg-error.log"
                if log.is_file():
                    diagnostic = log.read_text(encoding="utf-8", errors="replace")[-600:].strip()
            if path is None or not path.is_file() or path.stat().st_size < 44:
                raise RuntimeError("No microphone audio file was produced. " +
                    (diagnostic or "Check microphone permission and selected input device."))
            if directory is None:
                raise RuntimeError("Temporary recording directory missing.")
            samples, peak, rms = audio_levels(path)
            notice("Audio diagnostic: " + str(samples) + " samples; peak=" +
                   str(peak) + "; RMS=" + format(rms, ".1f"))
            if peak < 96 and rms < 16:
                raise RuntimeError(
                    "Microphone recording is effectively silent (peak=" + str(peak) +
                    ", RMS=" + format(rms, ".1f") + "). Check Aegis microphone permission " +
                    "and macOS Sound > Input device. " + diagnostic)
            spoken = transcribe(path, directory / "transcript.txt")
            if not spoken:
                raise RuntimeError(
                    "Parakeet returned an empty transcript even though audio was recorded " +
                    "(peak=" + str(peak) + ", RMS=" + format(rms, ".1f") + "). " +
                    "Try a clear 3-second recording and check Parakeet separately.")
            notice("Transcribed " + str(len(spoken)) + " characters")
            if self.on_transcript:
                self.on_transcript(spoken)
                return
            result = submit_transcript(spoken)
            response_text = str(result.get("response", ""))
            notice("Aegis [" + str(result.get("action", "?")) + "]: " + response_text[:550])
            if result.get("needsInput"):
                mac_notification("Action requires confirmation. Open Aegis dashboard.")
            else:
                mac_notification((response_text or "Aegis completed the request")[:120])
        except (RuntimeError, OSError, ValueError, HTTPError, URLError, subprocess.TimeoutExpired) as exc:
            notice("Voice request failed: " + str(exc))
            self._state("error: " + str(exc))
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
            recorder = self.recording
            directory = self.record_dir
            self.recording = None
        if isinstance(recorder, NativeRecorder):
            recorder.stop()
        elif recorder is not None and recorder.poll() is None:
            recorder.terminate()
        if directory is not None and not self.processing:
            shutil.rmtree(directory, ignore_errors=True)


def main() -> int:
    if sys.platform != "darwin":
        notice("Voice daemon requires macOS.")
        return 2
    try:
        from pynput.keyboard import GlobalHotKeys
    except ImportError:
        notice("pynput unavailable. Install requirements-voice.txt.")
        return 2
    daemon = HeadlessVoice()
    notice("Starting headless voice hotkey. Option+Space toggles recording.")
    try:
        with GlobalHotKeys({"<alt>+<space>": daemon.toggle}) as hotkeys:
            hotkeys.join()
    except KeyboardInterrupt:
        notice("Stopping voice daemon")
    except Exception as exc:
        notice("Hotkey listener failed: " + str(exc))
        return 1
    finally:
        daemon.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
