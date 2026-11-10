# Aegis Voice Control (v1.3 candidate)

Electron menu-bar microphone frontend for the **guarded Aegis Node server**. It does not implement its own command executor, LLM generator, shell access or privileged tool registry.

## Launch

From the repository:

```bash
cd src/ui/voice-control
./launch.sh
```

`launch.sh`, `start-voice-control.sh`, and `run-voice-control.sh` now use the same launch path. The launcher finds the repo by its own location, starts `src/server.mjs` only if its API is not answering on `127.0.0.1:${AEGIS_PORT:-3210}`, writes logs to `~/.aegis-local/logs/server.log`, and runs Electron using `npm ci` when needed.

Requirements: macOS, Node 20+, local Ollama and both model tags, Electron dependencies, `ffmpeg`, and `parakeet-transcribe` (default `~/.local/bin/parakeet-transcribe`, override with `PARAKEET_TRANSCRIBE`).

To choose a microphone, run:

```bash
ffmpeg -f avfoundation -list_devices true -i ""
AEGIS_AUDIO_DEVICE=":0" ./launch.sh
```

The default is **`:0`** as an initial guess, not an automatically detected Mac microphone. Set the actual avfoundation audio index from ffmpeg's device listing if needed.

## Interaction

Press **Option+Space once** to start recording and **again** to stop, or click the overlay's Stop recording button. Maximum capture is 60 seconds. Parakeet transcribes and sends the text through the guarded `/api/chat` endpoint. The overlay displays the assistant's response, including any confirmation request. Calendar and Reminders mutations require approval via the dashboard or a one-time `confirm <token>` command.

The overlay uses Electron's `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. Only close, stop, copy, and display events cross the narrow preload bridge. The old JSON tool chain and arbitrary shell/AppleScript handlers were removed. New capabilities belong in `src/integrations.mjs` on the server.

## Limitations and troubleshooting

This version has **not been tested on the owner's M1 Mac**. Verify Electron startup, microphone permission, hotkey registration, ffmpeg output, Parakeet transcription, and long-running Ollama responses on-device before treating the voice interface as reliable.

If capture fails, check device index and macOS microphone permission. If transcription fails, check executable permissions and `PARAKEET_TRANSCRIBE`. If commands fail, check `~/.aegis-local/logs/server.log`, `ollama ps`, model tags, and that the server uses the same `AEGIS_PORT` as the voice controller. Avoid claiming LaunchAgent auto-start unless you have actually installed a matching LaunchAgent plist; none is created by this script.
