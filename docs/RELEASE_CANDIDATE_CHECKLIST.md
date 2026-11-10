# Aegis Local v2.0 RC — on-device acceptance checklist

**Status:** Not run against the owner's M1 MacBook Air (8 GB RAM). This is the release candidate test plan, not a claim that these checks passed. Record actual macOS version, Python/Node/Ollama/Parakeet versions, installed model tags, and test date before marking anything complete.

## 0. Preflight

- [ ] `npm test` and Python unittests pass from a clean checkout.
- [ ] The native virtualenv imports `AppKit`, `Foundation`, `Quartz`, `objc`, and `pynput.keyboard`.
- [ ] `ffmpeg -f avfoundation -list_devices true -i ""` shows the actual intended microphone; set `AEGIS_AUDIO_DEVICE` correctly.
- [ ] Permissions are granted to the app/interpreter and ffmpeg for Microphone, Accessibility, and Input Monitoring as required.
- [ ] `ollama list` and `ollama ps` show Kev and the intended local 3B tag. `curl -s http://127.0.0.1:11434/api/tags` works.
- [ ] No old `com.aegis.local.voice`, `com.aegis.local.voicecontrol`, or Electron hotkey process remains active beside native.

## 1. Clean login / recovery

- [ ] Install using `.venv/bin/python scripts/install-launchagents.py install --with-native`.
- [ ] Inspect `launchctl print gui/$(id -u)/com.aegis.local.server` and `...native`.
- [ ] Log out/in, confirm that the **Λ icon appears without the floating window**, without opening Terminal.
- [ ] Confirm `/api/health` returns HTTP 200 and the icon's Restart Core action works if Node is stopped.
- [ ] Kill the Node server, confirm launchd restarts it unless Gaming Mode intentionally paused it.
- [ ] Move the repo, reinstall with the new path, confirm the prior absolute path does not remain in the LaunchAgents.
- [ ] Confirm all logs are private, rotate/manage logs if they grow, and no stale ffmpeg/parakeet processes remain.
- [ ] Test Quit Completely: icon disappears, user-owned services stop, no immediate KeepAlive restart. On next login, they load normally.

## 2. Overlay / fullscreen / focus

- [ ] In normal Safari/Chrome fullscreen Space, invoke Aegis and confirm panel sits above app at top right.
- [ ] In fullscreen native apps and Stage Manager, confirm the same, including Space switching.
- [ ] On two external/internal displays, invoke from each monitor; panel follows the pointer's display.
- [ ] Confirm that passive listening/progress/result views DO NOT steal keyboard focus from the fullscreen app.
- [ ] Explicit quick-text shortcut focuses the input and can submit text.
- [ ] Test dark/light appearance and Retina scaling; verify readable scrolling, no clipped labels.
- [ ] Try desired games: record any exclusive fullscreen or key-capture limitations; never circumvent protected screens.

## 3. Voice / shortcuts

- [ ] Option+Space starts recording, second press stops; no duplicate hotkey events.
- [ ] Parakeet transcribes spoken words correctly; errors are shown in panel and logged.
- [ ] Unplug microphone mid-recording, verify recoverable error and no abandoned WAV files.
- [ ] Option+Shift+Space opens quick text; Option+Shift+S reads selected text from an approved app only.
- [ ] Option+Shift+Escape immediately hides the panel and requests cancellation.
- [ ] While Gaming Mode is active, none of the global shortcuts triggers; the menu icon still permits resume.

## 4. Streaming, approvals, tool safety

- [ ] Kev -> 3B handoff shows actual routing and step progress in panel.
- [ ] Ask a long explanation. Text should appear incrementally, remain readable, scroll, pin, copy, and dismiss.
- [ ] Approve a harmless **test calendar event** via Option+Return. Only the visible current event is approved once.
- [ ] Reject via Option+Escape; it must never execute the proposed action.
- [ ] Hidden, expired, or previously approved tokens cannot be confirmed by global shortcut.
- [ ] Try Edit on a proposal, submit a revised command, confirm old proposal is not silently executed.
- [ ] Test a deliberate streaming disconnect/cancel while generation is underway; verify no OS action executes after cancellation.
- [ ] Verify 'Brief me for tomorrow' reads calendar and vault and does not invent unavailable data or trigger writes.
- [ ] Verify saved activity/history shows completed and failed actions without claiming success prematurely.

## 5. Memory / Gaming Mode

- [ ] In idle, `ollama ps` shows no Aegis model loaded after approximately two minutes.
- [ ] Compare Activity Monitor RAM for native + Node vs Electron; record actual baseline and spikes during model handoffs.
- [ ] Enter Gaming Mode: overlay hides, voice stops, hotkeys unregister, two Aegis models unload, **managed Node agent stops**, icon remains.
- [ ] Resume from icon: Node returns healthy, hotkeys and voice work; no duplicate registered listeners.
- [ ] While Gaming Mode is active, kill/restart native controller: it must remember Gaming Mode and not wake AI inadvertently.
- [ ] An unmanaged/manual Node process is never silently killed by Gaming Mode.
- [ ] Restart under poor Wi-Fi/offline conditions; only local components are needed.

## 6. Permissions / failure recovery

- [ ] Revoke Microphone/Accessibility: app fails visibly and offers a useful diagnostic.
- [ ] Deny Calendar/Mail Automation: action fails gracefully, remains auditable, and reports no false success.
- [ ] Disconnect Ollama mid-request: panel shows error and remains usable when Ollama restarts.
- [ ] Cancel during model handoff and during a safe tool invocation. No request queue deadlock.
- [ ] Confirm JSON-settings/history are only written locally; review no logs of raw microphone audio or passwords.

## RC to stable decision

Required: all critical login, fullscreen on a normal macOS fullscreen app, keyboard approval, safe tool execution, model memory, and Gaming Mode tests pass on the target Mac. Exclusive fullscreen games are a separately documented compatibility limitation. If any critical item fails, keep the release candidate designation and fix before declaring v2.0 stable.
