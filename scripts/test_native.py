"""Platform-neutral v2 RC validation; native AppKit runtime requires an actual Mac."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "src/ui/native"
sys.path.insert(0, str(NATIVE))

from api import stream_request
from service import ServiceController
from selected_text import selected_text
from preferences import load_gaming, save_gaming


class SourceCompatibilityTests(unittest.TestCase):
    def test_fullscreen_and_hotkey_contract(self):
        content = (NATIVE/"app.py").read_text()
        self.assertIn("NSWindowCollectionBehaviorCanJoinAllSpaces", content)
        self.assertIn("NSWindowCollectionBehaviorFullScreenAuxiliary", content)
        self.assertIn("NSWindowCollectionBehaviorStationary", content)
        self.assertIn("NSPopUpMenuWindowLevel", content)
        self.assertIn("NSApplicationActivationPolicyAccessory", content)
        for shortcut in ("<alt>+<space>", "<alt>+<shift>+<space>",
                         "<alt>+<enter>", "<alt>+<esc>",
                         "<alt>+<shift>+<esc>"):
            self.assertIn(shortcut, content)
        self.assertNotIn("import electron", content.lower())

    def test_selected_text_returns_safely_without_quartz_on_linux(self):
        if sys.platform != "darwin":
            self.assertEqual(selected_text(), "")

    def test_gaming_mode_survives_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {"AEGIS_HOME":folder}):
                self.assertFalse(load_gaming())
                save_gaming(True)
                self.assertTrue(load_gaming())
                save_gaming(False)
                self.assertFalse(load_gaming())

    def test_gaming_mode_does_not_kill_unmanaged_core(self):
        svc = ServiceController()
        with patch.object(svc, "alive", return_value=False), patch.object(svc, "_plist") as plist:
            plist.return_value.exists.return_value = False
            message = svc.enter_gaming()
            self.assertIn("shortcuts paused", message)
            self.assertTrue(svc.gaming)


class TransportTests(unittest.TestCase):
    def test_local_sse_reader_collects_events(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.server.request_path = self.path
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(
                    b'event: phase\ndata: {"label":"Planning"}\n\n'
                    b'event: delta\ndata: {"text":"Hello"}\n\n'
                    b'event: result\ndata: {"response":"Hello"}\n\n'
                    b'event: done\ndata: {"ok":true}\n\n')
            def log_message(self, *_args): pass
        http = HTTPServer(("127.0.0.1",0),Handler)
        threading.Thread(target=http.serve_forever,daemon=True).start()
        try:
            events=[]
            ref={}
            with patch.dict(os.environ, {"AEGIS_PORT":str(http.server_port)}):
                stream_request("Hello",lambda k,v: events.append((k,v)),threading.Event(),ref)
            self.assertEqual(http.request_path, "/api/stream")
            self.assertEqual([x[0] for x in events],["phase","delta","result","done"])
            self.assertEqual(events[1][1]["text"],"Hello")
            self.assertEqual(ref,{})
        finally:
            http.shutdown()
            http.server_close()


if __name__=="__main__":
    unittest.main()
