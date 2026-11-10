"""Small private persistent UI state, independent of the Aegis model backend."""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile


def state_path():
    return Path(os.environ.get("AEGIS_HOME", str(Path.home()))) / ".aegis-local" / "ui-state.json"


def load_gaming():
    try:
        return json.loads(state_path().read_text(encoding="utf-8")).get("gaming") is True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def save_gaming(enabled: bool):
    path = state_path()
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".aegis-ui-",dir=path.parent)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f:
            json.dump({"gaming":bool(enabled)}, f)
        os.chmod(temp,0o600)
        os.replace(temp,path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
