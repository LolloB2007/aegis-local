# Aegis Local v1.4

A local macOS assistant designed for an **M1 MacBook Air with 8 GB unified memory**. Aegis combines two Ollama models with a deterministic, permission-bounded tool executor.

**Current status:** v1.4 development branch. Unit/integration tests run in Linux CI with mocked Ollama. **macOS Calendar, Apple Mail, Electron, Python hotkeys/permissions, brightness control and login-time LaunchAgents require validation on the owner's Mac.** Passing CI does not prove an end-to-end on-device installation.

## Architecture and memory

| Component | Responsibility |
|---|---|
| **Kev** (`kev:0.8b-q8_0`) | Fast `/v1/systemone` intent classification. It **never** executes tools directly. |
| **3B generator** (`llama3.2:3b` or your local iMatrix tag) | Conversation and asynchronous JSON parameter generation for explicitly requested actions. |
| **Node.js** (`src/server.mjs` / `src/agent.mjs`) | Single serialized action queue, validation, allowlists, approvals and persistence. No arbitrary shell interpolation. |
| **Python voice daemon** (`src/ui/voice-control/headless_voice.py`) | Optional lightweight background hotkey, ffmpeg recording, Parakeet transcription, HTTP request to Node. **No Electron required.** |
| **Electron UI** (`src/ui/voice-control/`) | Optional visual microphone overlay. Uses the same Node API; no independent privileged IPC tool runner. |
| **LaunchAgents** (`scripts/install-launchagents.py`) | Installable per-user login-time services for Node and optionally Python voice. |

For model residency on 8 GB, configure Ollama:

```bash
# Set these for the Ollama process, not merely the Aegis terminal:
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_CONTEXT_LENGTH=4096
```

The server serializes requests. When `autoUnload` is enabled, it unloads the generator before Kev classification, unloads Kev before the generator, uses `keep_alive: 0` where supported, and can optionally warm Kev afterwards. **The models are sequential, not simultaneously resident.** System One support and memory usage must be checked on the real Ollama installation.

## Installation: always-running service on macOS

**Requirements:** macOS, Node.js 20+, Ollama with `/v1/systemone`, installed Kev and a separate local generator. The core server has no npm dependencies.

```bash
git clone https://github.com/LolloB2007/aegis-local.git
cd aegis-local
ollama pull kev:0.8b-q8_0
ollama pull llama3.2:3b  # skip if using your own local 3B tag
npm test
npm start
```

Open `http://127.0.0.1:3210`. In Configuration set your actual model tags, `vaultRoot`, exact Apple Calendar name and Reminders list name as desired.

**Crucial:** running `launch.sh` or cloning the project **does not register a macOS Login Agent.** The repository cannot install a LaunchAgent remotely; you must execute the following on your own Mac.

### Make the core server start on every login

From the repository root:

```bash
python3 scripts/install-launchagents.py install
python3 scripts/install-launchagents.py status
```

This creates `~/Library/LaunchAgents/com.aegis.local.server.plist`, registers it with `launchctl bootstrap gui/<uid>`, enables the service, and starts it immediately. The installer also disables and backs up a stale `com.aegis.local.voicecontrol.plist` when present, to prevent the old Electron process competing for Option+Space. It uses the current absolute repository path and the locally discovered Node binary. `RunAtLoad` and `KeepAlive` handle login/restart in the **user GUI session**. Do not run with `sudo`. If you move the repository or replace Node's path, **rerun the installer**.

### Install the lightweight Python voice hotkey (recommended)

Install ffmpeg (`brew install ffmpeg`) and ensure `~/.local/bin/parakeet-transcribe` is executable (or set `PARAKEET_TRANSCRIBE`). The sole extra Python dependency is `pynput` (which may pull macOS accessibility bindings). From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-voice.txt
.venv/bin/python scripts/install-launchagents.py install --with-voice
.venv/bin/python scripts/install-launchagents.py status
```

This installs **two separate LaunchAgents**, the Node core and the Python voice daemon. Aegis still runs without voice. The voice process wakes on **Option+Space**, records via ffmpeg, transcribes with Parakeet, and forwards the text to the same guarded `/api/chat` endpoint. A second Option+Space stops recording. It does not load either Ollama model until a request arrives. Text-only notifications and logs replace the Electron overlay; open the browser dashboard for confirmation buttons and full responses.

For mic device selection, run `ffmpeg -f avfoundation -list_devices true -i ""`, then set `AEGIS_AUDIO_DEVICE=":0"` (or your real input index) **when running the installer**. By default the daemon uses `:0`; this is a guess, not automatic device discovery. macOS may require Accessibility, Input Monitoring, Microphone and Automation permissions for the actual Python, ffmpeg, Terminal, or launcher binaries. Test voice interactively before trusting login startup:

```bash
.venv/bin/python src/ui/voice-control/headless_voice.py
```

**Do not run the optional Electron overlay and Python voice daemon together with the same hotkey.** They can race to register Option+Space.

### Verify and troubleshoot LaunchAgents

```bash
python3 scripts/install-launchagents.py status
launchctl print "gui/$(id -u)/com.aegis.local.server"
launchctl print "gui/$(id -u)/com.aegis.local.voice"
curl --fail http://127.0.0.1:3210/api/bootstrap
tail -n 60 ~/.aegis-local/logs/server-error.log
tail -n 60 ~/.aegis-local/logs/voice-error.log
tail -n 60 ~/.aegis-local/logs/voice.log
```

Manual restart:

```bash
launchctl kickstart -k "gui/$(id -u)/com.aegis.local.server"
launchctl kickstart -k "gui/$(id -u)/com.aegis.local.voice"
```

Remove login-time services without deleting notes, models or settings:

```bash
python3 scripts/install-launchagents.py uninstall
```

Services run after **user login**, not before the Mac has an active GUI session. If the computer has restarted but you have not signed in yet, a per-user LaunchAgent is not expected to be running.

## Tools (v1.4)

Every tool runs through the Node executor. Kev may select a broad intent; it never supplies arbitrary executables. For actions requiring arguments, the local generator extracts or writes structured JSON for the **preselected tool only**. Validation and explicit approval are enforced after model output.

| Example command | Effect | Approval |
|---|---|---|
| `Open Obsidian`, `Open Slack`, `Open Microsoft Outlook` | Open an allowlisted macOS app | No |
| `Quit Spotify` | Request app quit, potentially losing unsaved state | **Yes** |
| `List running apps` | List visible running applications | No |
| `Open github.com`, `Search the web for interest rates` | Open browser or browser search | No |
| `Search my vault for infrastructure`, `Read my vault note Projects/Aegis/Aegis Local.md`, `List my vault folders` | Read-only Obsidian navigation and search | No |
| `Find files named statistics` | Filename-only local search | No |
| `Remember that ...`, `List my notes` | Create/list standalone Aegis Markdown notes | Existing note creation is immediate |
| `What's on my calendar tomorrow?` | Read Calendar events for a bounded range | No |
| `Schedule a meeting tomorrow at 10 on Personal calendar` | Create a Calendar event | **Yes** |
| `Remind me to check the thesis on Tasks list` | Create a Reminders item | **Yes** |
| `Draft an email to someone@example.com about the meeting` | Generate and create an **unsent** Apple Mail draft | **Yes** |
| `Send an email to someone@example.com about the meeting` | Generate and send via local Apple Mail | **Yes**, full body preview |
| `Move the file ~/Downloads/report.pdf to ~/Documents` | Move a single file | **Yes** |
| `Delete the file ~/Downloads/old.pdf` | Move to the user's local Trash, **not permanent deletion** | **Yes** |
| `Organize my Downloads` | Preview and sort up to 30 loose files into categories | **Yes**, item-by-item preview |
| `What's my Wi-Fi status?`, `What's the current volume?`, `List running apps` | Read local system status | No |
| `Set the volume to 40`, `Set brightness to 60` | Change macOS system setting | **Yes** |
| `Check disk space`, `Run a memory diagnostic` | Fixed, read-only system diagnostic command | No |
| `What is my battery level?`, `Read my clipboard`, `Copy X to my clipboard` | Local device utilities | Clipboard writes require approval |

**Not provided:** general `bash -c` or model-controlled shell execution; arbitrary AppleScript; unrestricted filesystem browsing; permanent deletion; unsupervised multi-step external communication; automatic vault modification/committing. These were among the unsafe legacy voice pathways and are deliberately replaced by dedicated, bounded tools. `system_diagnostic` offers a fixed set of read-only diagnostics instead of an open shell.

All new mutating tools use **single-use 12-character confirmation tokens**, expiring after five minutes. The dashboard renders Confirm/Cancel buttons, or the user may reply `confirm <token>` / `cancel <token>`. A proposal does not execute until confirmed.

### File protections

File modification is confined to the owner's **Desktop, Documents and Downloads**, excluding hidden/system paths and the configured Obsidian vault. Symlinks that escape the approved roots are rejected. Trash uses `~/.Trash` with unique names. Folder organization is limited to the **top-level** Desktop/Documents/Downloads, up to 30 loose files per preview; it does not recursively move folder contents. Changed files invalidate the organization preview. All operations require confirmation and guard against overwriting existing destination files.

### Obsidian vault

Default `vaultRoot`: `~/Documents/Obsidian/claude` (on the owner's Mac: `/Users/lorenzobarbagelata/Documents/Obsidian/claude`). Vault navigation is **read-only**. To update this Git-backed vault, follow `_ChatGPT.md` and `_CLAUDE.md` (pull main, inspect open PRs, commit and push approved edits). Do **not** use generic desktop tools to modify this vault.

### macOS-specific dependencies

- **Apple Mail:** the Apple Mail application must be configured with a sending account; macOS may ask Automation permissions. Sending requires a full preview and confirmation. Validate the recipient carefully.
- **Calendar/Reminders:** use real calendar/list names from macOS, and allow Automation prompts. Creation does not imply invitations were delivered to anyone.
- **Brightness:** v1.4 uses the optional `brightness` command-line utility, e.g. `brew install brightness`. If absent, brightness tools report a missing dependency rather than claiming to have changed the display.
- **Network, battery, volume:** macOS built-in tools. Network information may be limited without Wi-Fi permissions.

## Optional Electron overlay

Electron is **not required** for the core server or Python voice daemon. For the visual overlay only:

```bash
cd src/ui/voice-control
./launch.sh
```

Electron depends on npm packages from `src/ui/voice-control/package.json`; it runs the same guarded API, and cannot directly invoke shell, AppleScript or file deletion. Do not simultaneously enable both voice frontends using Option+Space. The Python daemon is the recommended low-overhead login-time choice.

## Privacy, safety and limitations

- Local dashboard binds to `127.0.0.1:3210` and Ollama URL must be loopback. Never expose or port-forward the development server.
- Local chat/settings: `~/.aegis-local/`; standalone notes: `~/Documents/Aegis Notes/`; LaunchAgent logs: `~/.aegis-local/logs/`.
- No model can create arbitrary process command lines; all subprocess commands use fixed executables and argument lists. File and email operations require reviewable approvals.
- Automated tests mock Ollama, and Linux CI does **not** prove correct macOS Automation permissions, microphone selection, AppleScript/JXA semantics, Python global shortcuts, LaunchAgent registration, or timing on an 8 GB M1.
- The native Swift menu-bar experiment is not treated as supported.
- To run tests: `npm test`; to start manually: `node src/server.mjs`.

**Release gate:** verify a clean macOS login, loaded LaunchAgents, voice hotkey/transcription, Kev↔generator handoffs and model residency, and explicitly confirmed Calendar, Mail and file operations before labeling v1.4 production-ready.
