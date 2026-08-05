"""Validation and preparation of CLI/library launch sources."""

from __future__ import annotations

import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from ._payload import Payload

SPOOL_THRESHOLD = 8 * 1024 * 1024
_USEFUL_FORMATS = {
    "cif", "mcif", "vasp", "poscar", "contcar", "outcar", "xyz", "extxyz",
    "exyz", "cube", "chgcar", "elfcar", "traj", "crysviz", "pwscf",
}


@dataclass(slots=True)
class PreparedSource:
    """A validated source held by a running launch server."""

    name: str
    format: str | None
    binary: bool
    stream: BinaryIO | None = None
    path: Path | None = None
    spool: BinaryIO | None = None

    def open(self) -> BinaryIO:
        if self.stream is None:
            raise RuntimeError("source has no content")
        self.stream.seek(0)
        return self.stream

    def close(self) -> None:
        stream, self.stream = self.stream, None
        self.spool = None
        if stream is not None:
            stream.close()


def _suffix_format(name: str) -> tuple[str | None, bool]:
    suffix = Path(name).suffix.lower()
    if not suffix:
        return None, False
    format_name = suffix[1:]
    return (format_name if format_name in _USEFUL_FORMATS else None), format_name == "traj"


def _path_source(source: str | os.PathLike[str]) -> PreparedSource:
    try:
        candidate = os.fspath(source)
    except TypeError:
        raise TypeError("launch source must be a path or Payload") from None
    if isinstance(candidate, bytes):
        raise TypeError("launch paths must be text, not bytes")
    original = Path(candidate)
    name = original.name
    if not name or name in {".", ".."}:
        raise ValueError("input path has no usable basename")
    descriptor = -1
    try:
        resolved = original.resolve(strict=True)
        flags = os.O_RDONLY
        flags |= getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        # Do not block while opening a FIFO which replaced a validated path.
        flags |= getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(resolved, flags)
    except (FileNotFoundError, OSError, RuntimeError) as error:
        raise ValueError(f"input path is not a readable regular file: {original}") from error
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError(f"input path is not a readable regular file: {original}")
        stream = os.fdopen(descriptor, "rb", closefd=True)
        descriptor = -1
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        raise
    format_name, binary = _suffix_format(name)
    return PreparedSource(name=name, format=format_name, binary=binary, stream=stream, path=resolved)


def _payload_source(payload: Payload) -> PreparedSource:
    # Bytes are only a transport representation.  The browser needs an
    # ArrayBuffer for trajectory parsing; text structure formats still use
    # fetch().text(), even when their in-memory input arrived as bytes.
    spool = tempfile.SpooledTemporaryFile(max_size=SPOOL_THRESHOLD, mode="w+b")
    try:
        data = payload.data.encode("utf-8") if isinstance(payload.data, str) else payload.data
        spool.write(data)
        spool.seek(0)
    except BaseException:
        spool.close()
        raise
    format_name = payload.format
    if format_name is None:
        format_name, _ = _suffix_format(payload.name)
    binary = format_name is not None and format_name.lower() == "traj"
    return PreparedSource(
        name=payload.name,
        format=format_name,
        binary=binary,
        stream=spool,
        spool=spool,
    )


def prepare_sources(sources: tuple[object, ...] | list[object]) -> list[PreparedSource]:
    """Validate every source in order before any server is started."""

    prepared: list[PreparedSource] = []
    try:
        for source in sources:
            item = _payload_source(source) if isinstance(source, Payload) else _path_source(source)  # type: ignore[arg-type]
            prepared.append(item)
    except BaseException:
        for item in prepared:
            item.close()
        raise
    return prepared
