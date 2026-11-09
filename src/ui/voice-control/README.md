# Aegis Voice Control

Menu bar app for voice interaction with Aegis Local using local transcription.

## Version: 1.1.0

## Features

- **Global hotkey**: Press `Option+Control` to activate voice capture
- **Visual overlay**: On-screen indicator shows when recording (pulsing microphone + 60s countdown timer)
- **Menu bar icon**: Persistent icon shows status and provides quick access
- **Local transcription**: Uses Parakeet Ultra (via `parakeet-transcribe` from Hermes)
- **No window**: Runs as a background process with no visible window
- **Auto-start**: Launches automatically at login via LaunchAgent
- **Right-click quit**: Quit from menu bar to free RAM

## Requirements

1. **Node.js 20+** (already installed if Aegis Local works)
2. **Aegis Local server running** on port 3210
3. **Parakeet transcription** (via `parakeet-transcribe` in `~/.local/bin/`)

## Quick Start

```bash
# From the aegis-local directory
cd src/ui/voice-control
npm install
npm start
```

Or use the launcher script:

```bash
./launch.sh
```

## Parakeet Setup (Already Installed via Hermes)

Parakeet Ultra MLX is installed at:
- Binary: `~/.local/bin/parakeet-transcribe`
- Python package: `~/.local/share/uv/tools/parakeet-mlx/`
- Model: `~/.cache/huggingface/hub/models--selcukkubur--parakeet-ultra-mlx/`

No additional installation needed if you already use Hermes.

## Auto-start at Login

```bash
# Install the launch agent
launchctl load ~/Library/LaunchAgents/com.aegis.local.voicecontrol.plist
```

Or to uninstall:
```bash
launchctl unload ~/Library/LaunchAgents/com.aegis.local.voicecontrol.plist
```

## Using the Voice Control

1. Ensure Aegis Local server is running
2. Start the voice control app: `npm start` (or run the launch script)
3. Press `Option+Control` to start recording
4. **On-screen overlay appears**: You'll see a visual indicator with countdown timer
5. Speak your command (up to 60 seconds)
6. Release the keys or wait for automatic processing
7. The command is transcribed and sent to Aegis for execution

### Visual Overlay

When recording, a transparent overlay appears at the top-right of your screen showing:
- 🎙️ "Listening..." status
- A pulsing red recording indicator
- A 60-second countdown timer (turns red when ≤10 seconds remaining)
- Click the × button to stop recording early

### Menu Actions

Right-click on the menu bar icon for:
- **Quit (Free RAM)**: Exit the app to free memory
- **Configuration**: Open Aegis dashboard

## Technical Details

- Recorded audio: 16kHz mono WAV format
- Maximum recording length: 60 seconds
- Transcription: Sends audio to Parakeet, receives text, posts to Aegis `/api/chat`
- Audio device: MacBook Air Microphone (device `:2`)
- Overlay: Transparent window with blur effect, always on top

## Troubleshooting

**Hotkey not working**: Check for conflicts with other apps (Carabiner, Focus, etc.), restart the voice control app.

**No icon**: Ensure `resources/aegis-icon.png` exists and Electron dependencies installed (`npm install`).

**Overlay not showing**: Check console logs, ensure no window manager conflicts.

**Parakeet not found**: Check that `~/.local/bin/parakeet-transcribe` exists and is executable.

**Permission denied**: Grant Terminal/Audio permissions in System Settings > Privacy & Security.

**Cannot connect to Aegis**: Ensure Aegis Local server is running on port 3210.

**Audio recording fails**: Check that microphone permissions are granted to Terminal/Node.js in System Preferences > Security & Privacy > Microphone.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send transcribed text to Aegis |
| `/api/bootstrap` | GET | Check if server is running |

## Configuration

Settings are stored in:
- `~/.aegis-local/settings.json` - Aegis Local settings
- `~/.aegis-local/history.json` - Voice command history

## License

MIT - Same as Aegis Local