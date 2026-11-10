"""Platform-neutral checks for LaunchAgent generation and headless imports."""
import importlib.util
from pathlib import Path
import plistlib
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class LaunchAgentTests(unittest.TestCase):
    def test_plist_registration_contract(self):
        installer = load("aegis_installer", "scripts/install-launchagents.py")
        p = installer.make_plist(
            "com.aegis.local.server", ["/usr/local/bin/node", "/some/src/server.mjs"]
        )
        self.assertTrue(p["RunAtLoad"])
        self.assertTrue(p["KeepAlive"])
        self.assertEqual(p["ProgramArguments"][0], "/usr/local/bin/node")
        self.assertEqual(p["ThrottleInterval"], 15)
        self.assertEqual(p["ProcessType"], "Background")
        self.assertEqual(p["Umask"], 0o077)
        self.assertTrue(plistlib.loads(plistlib.dumps(p))["RunAtLoad"])
        voice = installer.make_plist(
            "com.aegis.local.voice", ["/some/python", "/some/headless_voice.py"], voice=True
        )
        self.assertIn("voice.log", voice["StandardOutPath"])
        self.assertEqual(voice["EnvironmentVariables"]["AEGIS_PORT"], "3210")

    def test_voice_daemon_can_import_without_pynput(self):
        module = load("headless_voice", "src/ui/voice-control/headless_voice.py")
        daemon = module.HeadlessVoice()
        self.assertFalse(daemon.processing)
        self.assertIsNone(daemon.recording)
        daemon.shutdown()
        self.assertTrue(daemon.stopped)


if __name__ == "__main__":
    unittest.main()
