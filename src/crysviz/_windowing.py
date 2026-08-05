"""Shared native-window defaults for CrysViz pywebview launchers."""

from __future__ import annotations

from typing import Any


# Keep the initial content area above the frontend's 1024 px compact-layout
# breakpoint without forcing maximization on large or multi-monitor desktops.
DEFAULT_WINDOW_SIZE = (1280, 800)
MINIMUM_WINDOW_SIZE = (640, 480)


def create_native_window(webview: Any, url: str, *, js_api: object | None = None) -> object:
    """Create a consistently sized, resizable CrysViz native window."""
    options: dict[str, object] = {
        "width": DEFAULT_WINDOW_SIZE[0],
        "height": DEFAULT_WINDOW_SIZE[1],
        "min_size": MINIMUM_WINDOW_SIZE,
    }
    if js_api is not None:
        options["js_api"] = js_api
    return webview.create_window("CrysViz", url, **options)
