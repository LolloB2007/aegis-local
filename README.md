# Aegis Local

A local, two-model macOS assistant for an M1 MacBook Air (8 GB). **Node.js is the tool executor**, not Kev, the generator, or Electron.

> Current development state: v1.3 feature branch. The guarded Node integrations have automated Linux tests; Apple Calendar, Reminders, Electron, microphone capture and real Ollama System One still require testing on the owner's Mac. These features must not be represented as on-device validated.

## Architecture

- **System One:** `kev:0.8b-q8_0` through the Ollama `/v1/systemone` endpoint. Predicts a broad response type.
- **System Two:** a separate local generator, default `llama3.2:3b` or your custom iMatrix 3B tag, through `/api/chat`. Answers questions and **extracts JSON parameters for explicitly requested tools**.
- **Deterministic guardrails:** tool intent must match an explicit user command; model classification alone does not authorize side effects. The executor validates parameters and uses a fixed allowlist. There is no model-controlled shell, AppleScript, file deletion, email sending, or GUI automation.
- **Memory:** Ollama `autoUnload` can unload Kev before invoking the generator; tool parameter planning uses the same serialized handoff as ordinary answers. `autoReloadKev` optionally warms Kev after the request. Recommended runtime variables: `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`.
- **Queue:** the HTTP server serializes chat and model-management operations, avoiding simultaneous model-residency fights on 8 GB.
- **Voice:** Electron records via ffmpeg and transcribes with Parakeet. The sandboxed overlay sends plain text to the same guarded `/api/chat` route as the dashboard. There is no privileged voice-only tool registry.

## Install and run

Requires macOS, Node.js 20+, a running local Ollama with a working Kev System One endpoint, and your installed generator tag.

```bash
ollama pull kev:0.8b-q8_0
ollama pull llama3.2:3b
npm test
npm start
```

Open `http://127.0.0.1:3210`. In Configuration, choose your actual local generator tag. A custom 3B is supported without changing source code. Ollama models themselves are not bundled. Configure Ollama single-model residency separately if needed.

To use the voice controller, install ffmpeg and the Parakeet transcription executable, then:

```bash
cd src/ui/voice-control
./launch.sh
```

The toggle hotkey is **Option+Space**, press once to record and again to stop. It is not a press-and-hold action. `AEGIS_AUDIO_DEVICE` controls ffmpeg's avfoundation input (default `:0`), and `PARAKEET_TRANSCRIBE` overrides `~/.local/bin/parakeet-transcribe`. List available devices with `ffmpeg -f avfoundation -list_devices true -i ""`. Electron dependencies are installed via `npm ci` in the voice directory.

## Supported commands

| Example | Behavior |
|---|---|
| `Open Safari` | Opens an allowlisted macOS app |
| `Open github.com` | Opens an explicit HTTP(S) URL |
| `Search the web for inflation` | Opens a browser query |
| `Find files named statistics` | Filename-only local search in approved roots |
| `Remember that ...` / `List my notes` | Stores/lists Markdown under `~/Documents/Aegis Notes` |
| `List my vault folders` | Lists the vault directory |
| `Read my vault note Projects/Aegis/Aegis Local.md` | Reads the exact Markdown note; bounded output |
| `Search my vault for infrastructure` | Searches Markdown contents and returns excerpts |
| `What is on my calendar tomorrow?` | Reads Apple Calendar events for a bounded time range |
| `Schedule a meeting tomorrow at 10 on Personal calendar` | Plans an Apple Calendar event; asks for confirmation |
| `Remind me to check my thesis on Tasks list` | Plans an Apple Reminder; asks for confirmation |
| `Read my clipboard` | Reads current clipboard text |
| `Copy this to clipboard: ...` | Plans a clipboard update; asks for confirmation |
| `What is my battery level?` | Reads macOS battery status |
| `Explain the CAPM` | Uses your local generator without tools |

**Vault path:** `~/Documents/Obsidian/claude`, which expands on the owner's Mac to `/Users/lorenzobarbagelata/Documents/Obsidian/claude`. Change `vaultRoot` in Configuration if needed. Vault tools are **read-only**. They never commit or push notes; editing vault files requires a separate GitHub-sync-aware workflow consistent with `_ChatGPT.md`.

**Calendar and Reminders setup:** Set `calendarName` and `reminderListName` in Configuration to the exact names of your target writable Apple Calendar and Reminders list, or specify them in a command. The generator must return unambiguous timestamps with timezone; the executor refuses incomplete, impossible or out-of-range values. macOS may ask permission to control Calendar or Reminders.

**Confirmation:** For calendar creation, reminder creation and clipboard writes, Aegis prints a human-readable preview and one-time 12-character approval token. The dashboard shows **Confirm action** and **Cancel** buttons; text/voice can use `confirm <token>` or `cancel <token>`. Pending operations expire in five minutes and are lost on restart. Never regard a proposed operation as completed before confirmation and successful executor response.

## Security and limits

The HTTP server binds to `127.0.0.1` and accepts only local Ollama endpoints. POST requests require `X-Aegis-Local: 1` and valid local Origin/Host checks. Do not port-forward this development server. Paths are bounded to the home directory; vault file tools reject traversal and symlinks leaving the vault; file reads and search outputs are size-limited.

The generator supplies **data for a preselected action**. It cannot choose arbitrary tool names or shell arguments. Electron uses a sandboxed, context-isolated overlay with a minimal preload bridge; the old broad voice tool chain and privileged IPC were removed.

Voice, JXA Apple Calendar scripting, Apple Reminders scripting, actual Ollama unload/residency behavior and the experimental Swift menu-bar app have **not been verified on the target Mac**. Calendar integration depends on macOS Automation permissions and Calendar's installed scripting dictionary. Any broken macOS integration should be fixed after device testing rather than assumed functional from Linux unit tests.

## Development

```bash
npm test
node --check src/agent.mjs
node --check src/integrations.mjs
node --check src/ui/voice-control/main.js
```

Directories: `src/server.mjs` (HTTP queue), `src/agent.mjs` (routing and handoffs), `src/ollama.mjs` (Kev/LLM), `src/tool-planner.mjs` (JSON extraction), `src/integrations.mjs` (bounded tools), `src/approvals.mjs` (one-shot consent), `src/store.mjs` (settings/history), `public/` (dashboard), `src/ui/voice-control/` (Electron and Parakeet).

## Troubleshooting

If Kev cannot classify, check `ollama list`, `ollama ps`, and `/v1/systemone` support. If the generator fails, check the configured exact tag. If the vault cannot be opened, verify the local folder, macOS Documents permissions, and symlink resolution. If voice fails, check `ffmpeg` and `AEGIS_AUDIO_DEVICE`; a nonexistent microphone index will not record. Calendar/Reminder failures may reflect missing macOS Automation permissions or wrong list names. Local tests cannot verify these OS permissions.
