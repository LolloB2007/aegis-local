# Aegis Local

**Location:** `~/aegis-local` (moved from Desktop)

A private, Mac-focused personal assistant using **two Ollama models**:

- **System 1:** `kev:0.8b-q8_0`, using Ollama's native `/v1/systemone` decision endpoint.
- **System 2:** Your preferred local text-generation model, using `/api/chat` (default: `llama3.2:3b`, but set the exact tag of your own 3-bit iMatrix build in Configuration).

It includes a browser-based dashboard, real macOS actions, persistent local notes and chat history, and **serial model handoff** so Kev and the text generator do not compete for RAM during a request.

## Getting started on your M1 MacBook Air

**Requirements:** macOS, Ollama **0.40.4+**, and Node.js **20+**. No npm install or project build is required. The app has zero npm dependencies. Models are downloaded separately through Ollama and are **not included** in this ZIP.

1. Install or upgrade [Ollama](https://ollama.com/). Ensure it is running in the menu bar.

   ```bash
   ollama pull kev:0.8b-q8_0
   ollama list
   ```

2. Check that a small text-generation model is installed. For example, to use Ollama's regular Llama 3.2 3B:

   ```bash
   ollama pull llama3.2:3b
   ```

   If you already have a custom **3-bit iMatrix Llama**, do **not** download another model. Just set its exact tag in the Aegis settings page.

3. Double-click **`Configure Ollama Memory.command`** (recommended for 8 GB MacBooks). Fully **quit** Ollama and reopen it. The helper configures:

   ```bash
   OLLAMA_MAX_LOADED_MODELS=1
   OLLAMA_NUM_PARALLEL=1
   OLLAMA_CONTEXT_LENGTH=4096
   ```

   These settings are applied to macOS's current login environment with `launchctl setenv`. You can also configure them manually. `MAX_LOADED_MODELS=1` protects against other Ollama clients loading additional models.

4. Double-click **`Start Aegis.command`**. The local dashboard opens at `http://127.0.0.1:3210` in your default browser. Leave the Terminal window open while using Aegis; press `Ctrl+C` to stop it.

   **macOS Gatekeeper note:** On some Macs, downloaded `.command` scripts may initially be blocked. Use Finder's **right-click > Open**, review the script, and approve if appropriate. You can always avoid double-clicking and run:

   ```bash
   cd /path/to/aegis-local
   node src/server.mjs
   ```

5. In **Configuration**, set the actual tag for your generator. Verify that both models show as installed in the runtime monitor. Use **Wake Kev** to test the decision model.

## Voice Control (Option+Control)

Aegis Local includes a **menu bar voice control app** that runs in the background and lets you talk to Aegis without switching windows.

### Features

- **Global hotkey**: Press `Option+Space` (fallback for Option+Control compatibility) to activate voice capture
- **Visual overlay**: On-screen indicator with blinking red light shows recording status
- **Menu bar icon**: Persistent icon shows status and provides quick access
- **Local transcription**: Uses Parakeet Ultra (same model as Hermes)
- **No window needed**: Works from anywhere, even while using other apps
- **Auto-start**: Launches at login via LaunchAgent
- **Hidden from Dock**: Appears only as a menu bar icon, not a separate app

### Setup Voice Control

1. Install Electron dependencies:
   ```bash
   cd src/ui/voice-control
   npm install
   ```

2. Parakeet is already installed (via Hermes setup at `~/.local/bin/parakeet-transcribe`). No additional installation needed.

3. Launch the voice control app:
   ```bash
   ./start-voice-control.sh
   ```

### Auto-start at Login

Enable the launch agent to start automatically at login:

```bash
launchctl load ~/Library/LaunchAgents/com.aegis.local.voicecontrol.plist
```

To disable:

```bash
launchctl unload ~/Library/LaunchAgents/com.aegis.local.voicecontrol.plist
```

### Using Voice Control

1. Launch the app (or it auto-starts at login)
2. Click the menu bar icon to see status
3. **Press and hold `Option+Space`**: A blinking red indicator shows recording is active (iPhone-sized 340px dashboard)
4. Speak your command (up to 60 seconds)
5. **Release the key**: Recording stops, transcribes via Parakeet, and shows results in dashboard
6. **Click Copy** to copy the transcribed text (button only appears when text available)
7. **Click Close (×)** or press Option+Space again to dismiss the dashboard

### Menu Actions

Right-click on the menu bar icon for:
- **Sleep (Free RAM)**: Temporarily disables shortcuts and frees RAM while keeping the tray icon visible
- **Wake Up**: Re-enable shortcuts and recording functionality
- **Quit (Close App)**: Fully exit the application

Click the tray icon anytime to toggle recording when awake.

## What it can actually do

| Command | Behavior |
|---------|----------|
| `Open Safari` | Opens Safari through macOS's `open -a` |
| `Open Obsidian` | Opens Obsidian (if installed) |
| `Open github.com` | Opens the supplied HTTP(S) URL in the browser |
| `Search the web for volatility models` | Opens a search in the browser (internet access needed for results) |
| `Find files named statistics` | Searches **filenames**, not file contents, within configured home-directory folders |
| `Remember that the meeting is at 4` | Writes a Markdown note to `~/Documents/Aegis Notes` |
| `Save a note: Thesis \| Explore infrastructure financing` | Writes a titled Markdown note |
| `List my notes` | Lists recently created local Markdown note filenames |
| `What time is it?` | Reports the local device clock |
| `Explain the CAPM` | Passes the prompt to your local text LLM |

Allowlisted apps: Safari, Finder, Notes, Calendar, Reminders, Mail, Music, Photos, Terminal, Visual Studio Code, Obsidian, Google Chrome, System Settings, Preview.

**Not yet supported:** sending mail or messages, computer vision, arbitrary mouse automation, persistent reminders outside Markdown notes, content indexing, shell execution, autonomous multistep GUI interactions, or arbitrary third-party integrations. The assistant will not pretend these actions were completed.

### System One Model OSA Script Tools

The System One model (`kev:0.8b-q8_0`) can execute **macOS AppleScript commands** for system-level actions. These are exposed as IPC handlers in the voice control app:

| Command Pattern | AppleScript Executed |
|-----------------|---------------------|
| `open Microsoft Outlook` | `tell application "Microsoft Outlook" to launch` |
| `open Slack` | `tell application "Slack" to launch` |
| `quit Spotify` | `tell application "Spotify" to quit` |
| `what apps are running?` | Lists visible apps via System Events |

**Usage with Voice Control:**
1. Speak: "Open Microsoft Outlook"
2. The overlay dashboard will show the transcribed command
3. Copy and paste into Aegis if needed, or press Option+Space to send via voice control
4. System One model receives the command and executes via osascript

**Manual IPC Usage (for scripting):**
```bash
# Direct osascript execution
osascript -e 'tell application "Microsoft Outlook" to launch'

# Via voice control IPC (when app running)
# The System One model can call these handlers directly
```

**Available IPC Handlers:**
- `osascript-execute(script: string)` - Execute any AppleScript
- `system-open-app(appName: string)` - Launch an application
- `system-quit-app(appName: string)` - Quit an application  
- `system-get-apps()` - List currently running applications

### File Operation Tools

The System One model can perform file operations directly:

| Tool | Parameters | Description |
|------|------------|-------------|
| `file-move` | `(sourcePath, destPath)` | Move file to destination folder |
| `file-copy` | `(sourcePath, destPath)` | Copy file to destination |
| `file-delete` | `(filePath)` | Delete a file |
| `file-rename` | `(filePath, newName)` | Rename a file |
| `file-read-text` | `(filePath)` | Read text file contents |
| `file-write-text` | `(filePath, content)` | Write text to file |
| `file-list` | `(dirPath)` | List directory contents |
| `file-sort-text` | `(filePath, order)` | Sort lines alphabetically (asc/desc) |
| `desktop-reorganize` | `(action, params)` | Clean desktop items |

**File Operation Examples:**
```
Move "vacation photos" from Desktop to Documents
Rename "draft.md" to "final.md"  
Sort the "todo.txt" file alphabetically
Delete the old "backup.zip" file
Organize my desktop
```

**Desktop Reorganization Actions:**
- `clean` - Move all desktop items to a "Desktop Cleanup" folder
- `sort-names` - Alphabetize desktop items
- `arrange-grid` - Set desktop to icon grid view

## How model switching works

1. If the generator is still loaded, Aegis unloads it before asking Kev.
2. It classifies the request using `/v1/systemone` with `intent` and `target_app` questions.
3. Explicit user command patterns are validated to prevent accidental tool execution. **A model's classification alone never authorizes a side-effecting action.**
4. For direct commands, Aegis performs the allowlisted macOS action.
5. For text generation, Aegis stops a loaded Kev with the documented `ollama stop` CLI command. If CLI is unavailable, it tries the documented generate-unload API as a fallback.
6. It calls the LLM with `keep_alive: 0` (if auto unload is enabled) to free RAM after answering.
7. Optionally, it reloads Kev by issuing a tiny `/v1/systemone` readiness question. This can make a completed generation request slightly slower, but leaves your fast model warm.

**Important:** Ollama's System One endpoint does **not** document a `keep_alive` request argument, so this app never assumes one. For best results, also set `OLLAMA_MAX_LOADED_MODELS=1` as described above.

### Performance tips for an 8 GB M1 Air

- Use a compact LLM quantization and start with 2,048 tokens of LLM context.
- Avoid 8k+ prompt contexts unless you need them.
- If repeated handoffs feel slow, turn off **Reload Kev after generation**. Kev will load when you next need it.
- To see actual RAM residency run `ollama ps` in another Terminal.
- Kev's 812 MB download size is **not** its total in-memory footprint; runtime buffers and caching also use unified memory.

## Privacy, storage, and security

- Server binds **only to `127.0.0.1`** and calls Ollama **only via localhost**.
- Configuration, conversation history, and local notes are stored **on your Mac**.
- Application files are in `~/.aegis-local/settings.json` and `~/.aegis-local/history.json`. New notes default to `~/Documents/Aegis Notes/`.
- Model text is processed by **your local Ollama instance**. Use local model tags, not `:cloud` models. If you use browser search, the resulting search is opened in your browser and naturally involves that external search engine.
- HTTP POST requests require a custom local header and same-origin validation; the app does not expose its interface on the network.
- Apps are allowlisted. URLs are restricted to HTTP(S). No arbitrary shell code, file deletion, or sending external messages from the model.
- Clear chat history through the dashboard. Clearing chat does not delete notes.
- The app is intended for **a single local user**, not a remotely exposed server. Do not forward its port to the internet.

## Running and developing

```bash
npm start       # or node src/server.mjs
npm test        # built-in Node.js test runner, no packages to install
AEGIS_PORT=3211 node src/server.mjs  # different dashboard port
```

Architecture:

```
public/index.html, styles.css, app.js  Local dashboard
src/server.mjs                       Loopback HTTP API and request queue
src/agent.mjs                        Classification, model handoff, tool policy
src/ollama.mjs                       Ollama System One, text generation, unloading
src/intent.mjs                       Explicit command parsing and app detection
src/tools.mjs                        Allowlisted real macOS actions
src/store.mjs                        Local settings and persistent chat history
src/ui/voice-control/               Menu bar voice control app
```

No cloud dependencies. No token usage charges. No background agents running after the server stops. No bundled model weights.

## Troubleshooting

**Ollama offline**: Ensure the Ollama app is open, and `curl http://127.0.0.1:11434/api/tags` returns JSON.

**Kev missing**: Run `ollama pull kev:0.8b-q8_0`. Requires Ollama >=0.40.4. Do not pull bare `kev`: it points to a much larger default model.

**LLM missing**: Run `ollama list`, then copy your model's exact name into Configuration.

**`ollama stop` not found**: The model-unload fallback is best-effort; ensure the Ollama CLI is on your shell `PATH` or configure the single-model environment helper. Starting the assistant from Terminal may pick up your shell-specific paths.

**Terminal window doesn't find Node**: Install Node.js 20+ and run `node src/server.mjs` from the project folder. Some macOS apps do not inherit the same PATH as your interactive shell.

**Port already in use**: Stop the other Aegis instance (`Ctrl+C`), or set `AEGIS_PORT=3211` when starting from Terminal. The double-click launcher assumes port 3210.

**macOS permissions**: Access to Desktop, Documents, or Downloads may be restricted by macOS permissions for Terminal or your Node process; approve access only if you want Aegis to search those folders.

**Model switch error**: Confirm `ollama ps`, and verify that `Configure Ollama Memory.command` ran and Ollama was restarted. Disable "Reload Kev after generation" in settings to reduce handoff latency.

**Voice Control issues**: See the Voice Control section above and `src/ui/voice-control/README.md` for detailed troubleshooting.

**Hotkey not working**: The app tries `Option+Control` first, then falls back to `Option+Space`. If neither works, use the tray menu to activate recording.