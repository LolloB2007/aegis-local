# Voice options for Aegis Local v1.4

**Recommended for M1 / 8 GB:** `headless_voice.py`, a Python background process. **Electron is optional** and is not required for Ollama, Calendar, Mail, vault tools, or any Node server functionality.

## Headless Python voice

The Python process listens for **Option+Space** using `pynput`, records mono WAV with `ffmpeg`, transcribes locally using the already-installed `parakeet-transcribe` executable, and posts a natural-language command to the Node server's guarded `/api/chat` endpoint. It has **no direct tool execution, shell access, file deletion, email sending, or arbitrary AppleScript**. All v1.4 commands, approvals and two-model orchestration are done by `src/agent.mjs`.

From repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-voice.txt
.venv/bin/python src/ui/voice-control/headless_voice.py
```

For login-time startup, run the **installer on your Mac**:

```bash
.venv/bin/python scripts/install-launchagents.py install --with-voice
.venv/bin/python scripts/install-launchagents.py status
```

The installer registers user GUI-domain LaunchAgents and their log locations. It is **not** enough to run the launcher script once. The server service starts independently of the optional voice process.

macOS must grant Accessibility and microphone permissions to the relevant interpreter, hotkey process, or ffmpeg executable. Use `ffmpeg -f avfoundation -list_devices true -i ""` to identify the proper input index, and supply it in `AEGIS_AUDIO_DEVICE` when installing. Check the actual logs at `~/.aegis-local/logs/voice*.log`.

## Optional Electron overlay

```bash
cd src/ui/voice-control
./launch.sh
```

Electron adds a translucent visual recording overlay and tray icon, but uses more memory than the Python daemon. It shares the same server, and its sandboxed overlay cannot call privileged tools. Hotkey: **Option+Space**, press once to record and again to stop. Do not launch Electron and the Python voice service simultaneously with the same shortcut.

Neither option has been on-device validated by Linux CI. See the root [README](../../../README.md) for launchctl inspection, troubleshooting, command examples, security boundaries, and dependencies.
