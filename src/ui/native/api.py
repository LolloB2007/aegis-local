"""Bounded local HTTP transport for the native Aegis overlay (stdlib only)."""
from __future__ import annotations

import json
import os
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

MAX_EVENT_BYTES = 180_000
HEADERS = {"Content-Type": "application/json", "X-Aegis-Local": "1"}


def base_url() -> str:
    port = int(os.environ.get("AEGIS_PORT", "3210"))
    if not (1 <= port <= 65535):
        raise ValueError("Invalid AEGIS_PORT")
    return f"http://127.0.0.1:{port}"


def get_json(endpoint: str, timeout: int = 5) -> dict:
    if endpoint not in ("/api/health", "/api/bootstrap"):
        raise ValueError("Endpoint not allowed")
    with urlopen(Request(base_url() + endpoint), timeout=timeout) as response:
        payload = response.read(160_000)
    return json.loads(payload)


def post_json(endpoint: str, body: dict, timeout: int = 30) -> dict:
    if endpoint not in ("/api/unload", "/api/chat"):
        raise ValueError("Endpoint not allowed")
    payload = json.dumps(body).encode("utf-8")
    req = Request(base_url() + endpoint, method="POST", data=payload, headers=HEADERS)
    with urlopen(req, timeout=timeout) as response:
        return json.loads(response.read(200_000))


def stream_request(message: str, callback, cancel: threading.Event, response_ref: dict) -> None:
    """POST request; dispatch SSE events to callback on background thread.

    Closing response_ref['stream'] aborts work. UI updates belong on AppKit's
    main thread and must be queued by the caller.
    """
    if not message.strip() or len(message) > 12_000:
        raise ValueError("Message must contain between 1 and 12,000 characters")
    body = json.dumps({"message": message}).encode("utf-8")
    req = Request(base_url() + "/api/stream", data=body, method="POST", headers=HEADERS)
    with urlopen(req, timeout=245) as response:
        response_ref["stream"] = response
        event = "message"
        payload = []
        completed = False
        try:
            try:
                for raw in response:
                    if cancel.is_set():
                        break
                    if len(raw) > MAX_EVENT_BYTES:
                        raise RuntimeError("SSE frame too large")
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        if payload:
                            data = json.loads("\n".join(payload))
                            callback(event, data)
                            if event == "done":
                                completed = True
                        event, payload = "message", []
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        payload.append(line[5:].strip())
                        if sum(len(p) for p in payload) > MAX_EVENT_BYTES:
                            raise RuntimeError("SSE event too large")
            except (ConnectionResetError, ConnectionAbortedError):
                # Some macOS TCP stacks reset a connection after a complete
                # event stream. Never mask an incomplete response.
                if not (completed or cancel.is_set()):
                    raise
            if not (completed or cancel.is_set()):
                raise RuntimeError("Aegis event stream ended before the done event.")
        finally:
            response_ref.pop("stream", None)
