"""On-demand macOS Accessibility selected-text retrieval; never watches screens."""
from __future__ import annotations


def _value(result):
    # PyObjC C APIs with out-arguments may return (AXError, value).
    if isinstance(result, tuple) and len(result) == 2:
        code, data = result
        if code != 0:
            raise RuntimeError(f"Accessibility denied or unsupported ({code})")
        return data
    return result


def selected_text(max_chars: int = 8000) -> str:
    try:
        import Quartz
        system = Quartz.AXUIElementCreateSystemWide()
        focused = _value(Quartz.AXUIElementCopyAttributeValue(
            system, Quartz.kAXFocusedUIElementAttribute, None))
        if not focused:
            return ""
        selected = _value(Quartz.AXUIElementCopyAttributeValue(
            focused, Quartz.kAXSelectedTextAttribute, None))
        return str(selected or "").strip()[:max_chars]
    except (ImportError, AttributeError, RuntimeError, TypeError, ValueError):
        return ""
