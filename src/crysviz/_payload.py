"""Representation-neutral in-memory launch input."""

from __future__ import annotations

import re
from dataclasses import dataclass

_FORMAT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _validate_name(name: str) -> str:
    if not isinstance(name, str):
        raise TypeError("Payload name must be a string")
    if not name.strip() or name in {".", ".."}:
        raise ValueError("Payload name must not be empty")
    if "\x00" in name:
        raise ValueError("Payload name must not contain NUL")
    if "/" in name or "\\" in name:
        raise ValueError("Payload name must be a filename, not a path")
    return name


def _snapshot_data(data: object) -> str | bytes:
    if isinstance(data, str):
        if not data:
            raise ValueError("Payload data must not be empty")
        return data
    if isinstance(data, (bytes, bytearray, memoryview)):
        snapshot = bytes(data)
        if not snapshot:
            raise ValueError("Payload data must not be empty")
        return snapshot
    try:
        view = memoryview(data)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise TypeError("Payload data must be str or bytes-like") from None
    snapshot = view.tobytes()
    if not snapshot:
        raise ValueError("Payload data must not be empty")
    return snapshot


def _validate_format(format: str | None) -> str | None:
    if format is None:
        return None
    if not isinstance(format, str):
        raise TypeError("Payload format must be a string or None")
    if not format or format != format.strip():
        raise ValueError("Payload format must not be empty")
    if format.startswith("."):
        format = format[1:]
    if not _FORMAT_RE.fullmatch(format.casefold()):
        raise ValueError("Payload format must be a simple format name")
    return format.casefold()


@dataclass(frozen=True, slots=True)
class Payload:
    """Immutable, snapshotting in-memory input for a future viewer launch.

    Text remains text for callers inspecting the object; bytes-like values are
    copied to immutable :class:`bytes`.  The launcher encodes text as UTF-8
    when it spools the input for the browser.
    """

    name: str
    data: str | bytes
    format: str | None = None

    def __init__(self, name: str, data: object, format: str | None = None):
        object.__setattr__(self, "name", _validate_name(name))
        object.__setattr__(self, "data", _snapshot_data(data))
        object.__setattr__(self, "format", _validate_format(format))
