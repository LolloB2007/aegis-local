"""Voice capture checks that run without FFmpeg, Parakeet or macOS hardware."""
import importlib.util
from array import array
import math
from pathlib import Path
import tempfile
import unittest
import wave
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "aegis_voice_capture", ROOT / "src/ui/voice-control/headless_voice.py")
voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voice)


class AudioCaptureTests(unittest.TestCase):
    @staticmethod
    def wav_file(folder, samples):
        path = Path(folder) / "test.wav"
        audio = array("h", samples)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(audio.tobytes())
        return path

    def test_silent_capture_is_detectable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav_file(directory, [0] * 16000)
            count, peak, rms = voice.audio_levels(path)
            self.assertEqual(count, 16000)
            self.assertEqual(peak, 0)
            self.assertEqual(rms, 0.0)

    def test_spoken_level_audio_is_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            tone = [int(6000 * math.sin(2 * math.pi * 440 * i / 16000))
                    for i in range(16000)]
            path = self.wav_file(directory, tone)
            count, peak, rms = voice.audio_levels(path)
            self.assertEqual(count, 16000)
            self.assertGreater(peak, 96)
            self.assertGreater(rms, 16)

    def test_too_short_file_reports_microphone_problem(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav_file(directory, [5] * 100)
            with self.assertRaisesRegex(RuntimeError, "No usable audio"):
                voice.audio_levels(path)

    def test_missing_native_framework_is_not_silently_ignored(self):
        with patch.object(voice.sys, "platform", "darwin"):
            with patch.dict("sys.modules", {"AVFoundation": None}):
                errors = []
                self.assertFalse(voice.microphone_permission(errors.append))
                self.assertTrue(errors and errors[0].startswith("error:"))


if __name__ == "__main__":
    unittest.main()
