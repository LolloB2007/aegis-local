# Aegis Local v2.2 — Native Integrations & Read-Only Vault Release Candidate

Local-first macOS assistant for an M1 MacBook Air with **8 GB RAM**. **No Electron is required.** The default v2 interface is a native PyObjC/AppKit menu-bar controller with a small, transient, top-right floating panel. The Node core remains the sole tool executor and Ollama orchestrator.

> **Release-candidate status:** The native panel, global hotkeys, microphone access, Accessibility permissions, fullscreen Spaces, and LaunchAgent startup must be verified on the target Mac. Passing CI does not prove fullscreen or microphone behavior. See [RC verification checklist](docs/RELEASE_CANDIDATE_CHECKLIST.md).

## v2.2 RC: macOS integrations, vault access gate, 3B context compaction

- **WhatsApp** and **Opera GX** are added to the fixed app-launch/quit allowlist. Aegis does not send WhatsApp messages or read WhatsApp conversations.
- **Preferred browser** defaults to **Google Chrome** for Aegis website/search commands, independently of the system's Opera GX default. Configure Chrome, Safari, Opera GX, or macOS default in Settings; explicit `in Safari` / `in Opera GX` overrides work.
- **Apple Notes**: `Create a note in the Notes app...` uses fixed JXA via `/usr/bin/osascript`, requires an exact title/body and an existing Notes folder, and is **always approval-gated**. It is entirely separate from Aegis-owned Markdown memory.
- **Apple Calendar** creation continues to use JXA/`osascript` with an exact existing calendar, bounded ISO8601 dates, a full preview and one-use confirmation token.
- **Obsidian read-only contract**: personal-vault list/read/search, backlinks, outgoing links, task lookup and document-index rebuild require a valid `_Aegis.md` at `~/Documents/Obsidian/claude/_Aegis.md`. The file is read and verified on every vault operation. Missing/invalid manuals cause vault tools to fail closed. [Vault PR #17](https://github.com/LolloB2007/remote-vault/pull/17) has been merged; your local vault must sync it before these tools become available.
- **Ollama-assisted context compaction:** when old chat grows, the local 3B chooses important *IDs* of past user messages; Aegis retains only verbatim excerpts validated against the actual messages. The session rollup lives in `~/.aegis-local/session-compaction.json` and is used as **unverified historical context**, never as a new instruction or personal memory. This does not change `Persistent memory.md`. Toggle automatic compaction in Settings.

**Spotify playlist controls intentionally deferred.** No new Spotify playlist automation or configuration is part of this release.

### Additional commands

```text
Open WhatsApp
Open github.com                  # Google Chrome by default
Open github.com in Safari
Search the web for Apple Notes tutorials in Opera GX
Create a note in the Notes app called Shopping: buy coffee and rice
Schedule a meeting tomorrow at 10 on Personal calendar
```

**On-device release gate:** macOS must grant Apple Notes/Calendar Automation permissions. CI validates routing, fixed commands, approvals and vault access but cannot guarantee the target Mac's Notes or Calendar accounts are configured.

---

## v2.1: Boot memory and protected Obsidian

**Two distinct directories, two distinct trust levels:**

| Location | Aegis access |
|---|---|
| `~/Documents/Obsidian/claude/` | **Strictly read-only.** Existing vault graph, backlinks, open-task checkboxes and note search. Never edited by Aegis. |
| `~/Documents/Obsidian/aegis/` | **Aegis-owned Markdown memory.** Reads are bounded. New notes and edits require explicit requests and an approval token. |

**You create your own Markdown files.** Neither GitHub nor Aegis automatically generates templates, context, task lists, daily notes or system prompts. Aegis includes a confirmed Create Markdown Note tool that creates an **empty** `.md` file, never overwriting an existing one.

### Required file before Aegis becomes available

On your Mac, create the directory and an optionally empty note called **`Persistent memory.md`**:

```text
~/Documents/Obsidian/aegis/Persistent memory.md
```

The file may contain zero bytes. The core reads it **before accepting requests**; if it is missing or inaccessible, the process reports a boot error and does not serve chat. The menu-bar icon can still exist because it runs in its own small process; create the file locally, then restart the core. Nothing is silently created for you.

The optional `~/Documents/Obsidian/aegis/System Prompt.md` is also read **once at boot** and supplied to Ollama as a bounded `system` message. The core's tool-authorization rules remain in code and cannot be modified by either Markdown file. Changes to the prompt or persistent memory require a core restart to refresh the startup snapshot. On a 3B model, prompt size is capped at 3,800 characters; persistent memory is read (up to 24 KB) but only **small relevant excerpts** enter each conversation.

Optional, personally authored scope notes:

- `To-Do List.md` for explicitly approved tasks.
- `Routine Tasks.md` for recurring-task descriptions, not automatically scheduled tasks.
- `Daily/YYYY-MM-DD.md` for an individual daily journal, created only when requested.
- Other Aegis-owned `.md` files as you need them.

Memory is **not** an autonomous extraction system. No LLM decides what to remember. Aegis's deterministic command parser selects which note may be edited; it previews the exact text, asks for approval, then writes to that note only. It never promotes arbitrary chat messages into persistent memory.

### Example memory commands

```text
Create Aegis Markdown note: To-Do List.md
Start my daily note
List Aegis memory files
Show Aegis memory
Aegis remember: I prefer short morning briefings
Remember that I prefer short morning briefings
Add to Aegis to-do list: Review the internship tracker
Mark Aegis task done: Review the internship tracker
Add an Aegis routine: Prepare the calendar every Sunday
Aegis journal: Worked on the Aegis release
Search Aegis memory for internship
```

The legacy `Remember that ...` phrase now uses the confirmed `Persistent memory.md` workflow, not the old standalone notes directory. The separate `Save a note: ...` command still creates ordinary standalone notes outside the protected Obsidian folders.

Each creation or change is **human-confirmed**. Memory edits fail with a helpful message if the target scope note has not yet been created; no hidden templates are generated.

## v2.1: New tools

- **Vault navigation (read-only):** `Show vault backlinks: Projects/Aegis/Aegis Local.md`, `Show vault outgoing links: Index.md`, `Show vault tasks`. Searches actual Markdown links and unchecked task markers. Never alters the personal vault.
- **Calendar intelligence:** `Find me two free hours this week` and `Check calendar conflicts tomorrow at 10`. Kev routes, the 3B extracts **bounded structured time parameters**, and deterministic code checks retrieved Calendar events. Ambiguous dates or unavailable data produce a request for clarification, **not an invented free slot**. Creating actual events still needs confirmation.
- **Local documents:** `Index my documents` builds a **private SQLite FTS5** index from approved folders, only after confirmation; `Search my indexed documents for terminal growth` searches that local index. Supports Markdown/text/code, Office ZIP formats and PDF extraction when `pdftotext` is installed. It excludes `Obsidian/aegis`, hidden files, symlinks and oversized inputs. No external embeddings, cloud API or extra AI model.
- **Developer and GitHub tools (read-only):** `git status: ~/Projects/example`, `git log: ~/Projects/example`, `git diff: ~/Projects/example`, `github prs: ~/Projects/example`, `github ci: ~/Projects/example`. These use fixed Git/gh argument arrays on a validated local repository. GitHub operations require `gh` authenticated on the Mac; they cannot commit, push, delete or run arbitrary commands.

### Dependencies and limits

`python3` is needed for document indexing using the standard-library `sqlite3` module, and the macOS `pdftotext` CLI is optional for PDFs (for example via Poppler). The index lives under `~/.aegis-local/documents.sqlite3`; no index is built automatically at startup.

The 3B generator is used for **response synthesis and clearly bounded parameter extraction**, not deciding what is true or executing arbitrary workflows. Literal search, note writes, free-time calculation, file access and Git operations remain deterministic. Source texts and memory are treated as data, not authority to change permissions.

---

## The v2 experience

- **Always-available Λ menu-bar icon.** The icon belongs to a small Python process, not a resident LLM. The floating panel is hidden until Aegis is listening, working, asking for approval, or displaying a response. Short results fade after a few seconds; long answers remain. Pin, Copy, and Dismiss controls are available.
- **Fullscreen floating panel:** An AppKit NSPanel at `NSPopUpMenuWindowLevel`, with `CanJoinAllSpaces | FullScreenAuxiliary | Stationary`. It follows the display containing the pointer and is designed to appear over ordinary fullscreen macOS Spaces without automatically stealing keyboard focus. Protected screens and some exclusive fullscreen games may block third-party overlays.
- **Streaming:** `/api/stream` emits queued/running/step/token/result/error SSE events. The 3B's generated text appears incrementally while tool and Kev steps show real progress. Existing `/api/chat` remains supported.
- **In-panel approval:** Review the action, then click Approve, Reject, or Edit, or use a keyboard shortcut. Approval requires a valid, visible, unexpired token; hidden or expired approvals cannot be invoked from a hotkey.
- **Gaming Mode:** Unregisters global hotkeys and stops voice, hides the panel, unloads both Aegis models, then stops the managed Node LaunchAgent. The menu-bar icon remains available to resume. Gaming Mode is remembered after app restarts. An unmanaged Node process is not killed automatically.
- **Emergency dismiss:** Hides the overlay and requests cancellation. Already-started OS side effects cannot necessarily be rolled back.
- **On-demand selected text:** Option+Shift+S reads the selected text from an accessibility-aware foreground app and asks for an explanation. There is no continuous screenshot capture or clipboard takeover.
- **First bounded multistep workflow:** “Brief me for tomorrow” reads a calendar interval and searches vault notes for open items, then summarizes actual data with the 3B. There is no arbitrary agent-selected shell or multistep tool execution.
- **Activity history:** Recent actions and answers in the native panel, with persisted chat history available from the core.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Option+Space** | Start or stop voice capture |
| **Option+Shift+Space** | Focus quick text |
| **Option+Return** | Approve the currently visible pending operation |
| **Option+Escape** | Reject the currently visible pending operation |
| **Option+Shift+Escape** | Emergency dismiss + request cancellation |
| **Option+Shift+S** | Explain currently selected text |

All shortcuts are unregistered in Gaming Mode. macOS Accessibility and Input Monitoring permissions may be required. Some games capture keys exclusively.

## Architecture and model residency

```text
Menu bar / fullscreen NSPanel (Python, PyObjC, pynput)
  | voice: ffmpeg -> Parakeet
  | text: quick field / on-demand Accessibility selection
  v
127.0.0.1:3210 /api/stream (POST + SSE + local request header)
  |
Node guarded queue: tool policy, approval tokens, history
  |                                       |
  +-- Kev System One                      +-- 3B generator (streaming)
        sequential model handoffs
  v
Allowlisted apps / Obsidian / Calendar / Mail / Files / system tools
```

The Python panel cannot directly execute privileged tools. It submits a natural-language request through the same guarded Node service used by the browser dashboard. The generator may extract parameters only for a preauthorized action. A one-use, five-minute confirmation is required for mutations and external communications.

The Node server attempts to unload the two configured Ollama models after about two minutes of inactivity. The Python menu-bar controller and Node server remain in ordinary idle. Gaming Mode pauses the managed Node service as well. The Ollama application itself might still be running; that is separate from having model weights resident.

## Install on macOS (v2 native interface)

Requires macOS, Python 3.10+, Node.js 20+, Ollama with `/v1/systemone`, Kev plus a separate local generator, ffmpeg, and Parakeet transcription if using voice.

```bash
cd ~/aegis-local                    # or your actual repo path
git pull origin main               # after PR merge; otherwise checkout the RC branch
brew install ffmpeg
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-native.txt
ollama pull kev:0.8b-q8_0
# Install your preferred local 3B generator (or set your existing iMatrix tag in Settings)
npm test
```

First run the native controller interactively:

```bash
.venv/bin/python src/ui/native/app.py
```

Look for the **Λ** menu-bar icon. There should be no panel while idle. Test the quick-text shortcut, fullscreen overlay, then voice and approvals. The v2 RC uses a Python venv; packaging into a signed `.app` bundle is recommended for stable long-term macOS Accessibility/TCC permissions but is not validated here.

### Start at every login: two per-user LaunchAgents

Run the installer **on your Mac** (not via GitHub), without `sudo`, from the repository root:

```bash
.venv/bin/python scripts/install-launchagents.py install --with-native
.venv/bin/python scripts/install-launchagents.py status
```

This installs `~/Library/LaunchAgents/com.aegis.local.server.plist` and `~/Library/LaunchAgents/com.aegis.local.native.plist`. Both use `RunAtLoad`, `KeepAlive`, absolute paths, and private logs. The installer backs up/disables obsolete voice controller agents to prevent shortcut conflicts. It does not work before you log into your macOS GUI session, and **merging a PR alone does not install an agent**.

Verify and troubleshoot:

```bash
launchctl print "gui/$(id -u)/com.aegis.local.server"
launchctl print "gui/$(id -u)/com.aegis.local.native"
curl --fail http://127.0.0.1:3210/api/health
tail -n 80 ~/.aegis-local/logs/native-error.log
tail -n 80 ~/.aegis-local/logs/server-error.log
.venv/bin/python scripts/install-launchagents.py status
.venv/bin/python scripts/install-launchagents.py uninstall
```

The Λ menu offers **Restart Core**, **Enter Gaming Mode**, **Resume Aegis**, and **Quit Completely**. The menu icon is visible whenever the macOS menu bar itself is shown. In fullscreen apps the OS may auto-hide the entire menu bar until the pointer reaches it.

The previous headless-only controller is still available via `install --with-voice` instead of `--with-native`; do not install both. Electron remains as legacy optional UI code and is not part of the v2 default.

## Supported tools

The guarded v1.4 tool registry is retained:

- Allowlisted app launch/quit, running apps, URLs and browser search.
- Read-only Obsidian Markdown browsing/search in `~/Documents/Obsidian/claude`. Vault modifications must follow `_ChatGPT.md` and `_CLAUDE.md` and Git syncing.
- Apple Calendar listing/confirmed event creation, Reminders, Apple Mail drafts and confirmed sends.
- Confirmed file moves, recoverable Trash, bounded Desktop/Documents/Downloads organization.
- Volume, optional brightness CLI, network, battery, clipboard and fixed diagnostics.
- Standalone Markdown notes and local text generation.

The new v2 “Brief me for tomorrow” workflow reads two existing sources and summarizes actual returned data. No arbitrary shell access or unrestricted autonomous workflows are introduced.

## Tests

```bash
npm test
python3 -m unittest discover -s scripts -p 'test_*.py' -v
python3 -m py_compile src/ui/native/*.py scripts/install-launchagents.py
node src/server.mjs
```

CI covers fragmented Ollama NDJSON, SSE lifecycle, approval handoffs, path guards, Python transport and LaunchAgent plist contracts. A macOS runner can smoke-test PyObjC imports, but **does not exercise the graphical UI, fullscreen Spaces, microphone, or the target Mac's permissions**.

## Limitations

- Third-party panels cannot promise visibility over exclusive fullscreen games or protected OS screens. Test the exact fullscreen applications you care about.
- Shortcuts and selected text rely on macOS Accessibility permissions.
- Cancelling prevents queued/unstarted actions; it cannot undo an OS action that has already started.
- The menu-bar controller always consumes a little memory. Only the model weights and optional backend are unloaded.
- Only Aegis's configured Ollama model tags are subject to automatic unload.
- Never expose the loopback API beyond your computer.
- The experimental native Swift app and the older Electron UI are not the v2 frontend.

**Release gate:** Mark v2.0 stable only after completing [on-device release candidate verification](docs/RELEASE_CANDIDATE_CHECKLIST.md) on the M1 Mac.
