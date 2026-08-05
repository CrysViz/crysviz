"""Small, versioned IPC protocol for the managed CrysViz host.

The protocol deliberately uses :meth:`multiprocessing.connection.Connection.send_bytes`
only.  ``Connection.send`` and ``Connection.recv`` are pickle helpers and are
never suitable at this process boundary.
"""

from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass
from typing import BinaryIO, Iterable

PROTOCOL_VERSION = 1
MAX_CONTROL_BYTES = 1024 * 1024
MAX_CHUNK_BYTES = 1024 * 1024
MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024
SPOOL_THRESHOLD = 8 * 1024 * 1024


class ProtocolError(RuntimeError):
    """A peer sent a malformed, unsupported, or oversized protocol frame."""


@dataclass(slots=True)
class Attachment:
    """A received binary attachment, potentially backed by a temporary file."""

    name: str
    size: int
    stream: BinaryIO

    def read(self) -> bytes:
        self.stream.seek(0)
        return self.stream.read()

    def close(self) -> None:
        self.stream.close()


def _json_bytes(value: object) -> bytes:
    try:
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ProtocolError("protocol frame is not JSON serializable") from error
    if len(encoded) > MAX_CONTROL_BYTES:
        raise ProtocolError("protocol control frame exceeds 1 MiB")
    return encoded


def _decode_control(raw: bytes) -> dict[str, object]:
    if len(raw) > MAX_CONTROL_BYTES:
        raise ProtocolError("protocol control frame exceeds 1 MiB")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("protocol control frame is not JSON") from error
    if not isinstance(value, dict) or set(value) - {"version", "type", "payload", "attachments"}:
        raise ProtocolError("protocol control frame has an invalid schema")
    if (value.get("version") != PROTOCOL_VERSION or not isinstance(value.get("type"), str)
            or not value["type"]):
        raise ProtocolError("protocol version or type is invalid")
    if "payload" not in value:
        raise ProtocolError("protocol control frame has no payload")
    attachments = value.get("attachments", [])
    if not isinstance(attachments, list):
        raise ProtocolError("attachment descriptors must be a list")
    names: set[str] = set()
    for descriptor in attachments:
        if not isinstance(descriptor, dict) or set(descriptor) != {"name", "size"}:
            raise ProtocolError("attachment descriptor has an invalid schema")
        name, size = descriptor["name"], descriptor["size"]
        if not isinstance(name, str) or not name or name in names:
            raise ProtocolError("attachment name is invalid")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= MAX_BLOB_BYTES:
            raise ProtocolError("attachment size is invalid")
        names.add(name)
    return value


def _iter_chunks(data: bytes | bytearray | memoryview | BinaryIO) -> tuple[int, Iterable[bytes]]:
    if isinstance(data, (bytes, bytearray, memoryview)):
        value = bytes(data)
        if len(value) > MAX_BLOB_BYTES:
            raise ProtocolError("attachment exceeds 2 GiB")
        return len(value), (value[index:index + MAX_CHUNK_BYTES] for index in range(0, len(value), MAX_CHUNK_BYTES))
    try:
        position = data.tell()
        data.seek(0, 2)
        size = data.tell()
        data.seek(position)
    except (AttributeError, OSError) as error:
        raise ProtocolError("attachment must be bytes-like or a seekable binary stream") from error
    if not 0 <= position <= size <= MAX_BLOB_BYTES:
        raise ProtocolError("attachment exceeds 2 GiB")

    def chunks() -> Iterable[bytes]:
        remaining = size - position
        while remaining:
            block = data.read(min(MAX_CHUNK_BYTES, remaining))
            if not isinstance(block, bytes) or not block:
                raise ProtocolError("attachment ended before its advertised size")
            remaining -= len(block)
            yield block

    return size - position, chunks()


def send_frame(connection: object, message_type: str, payload: object, attachments: dict[str, object] | None = None) -> None:
    """Send one JSON control frame followed by its explicit binary chunks."""

    if not isinstance(message_type, str) or not message_type:
        raise ProtocolError("protocol type must be a nonempty string")
    prepared: list[tuple[str, Iterable[bytes]]] = []
    descriptors: list[dict[str, object]] = []
    for name, value in (attachments or {}).items():
        if not isinstance(name, str) or not name:
            raise ProtocolError("attachment name is invalid")
        size, chunks = _iter_chunks(value)  # type: ignore[arg-type]
        descriptors.append({"name": name, "size": size})
        prepared.append((name, chunks))
    connection.send_bytes(_json_bytes({
        "version": PROTOCOL_VERSION, "type": message_type, "payload": payload,
        "attachments": descriptors,
    }))
    for _, chunks in prepared:
        for chunk in chunks:
            if len(chunk) > MAX_CHUNK_BYTES:
                raise ProtocolError("attachment chunk exceeds 1 MiB")
            connection.send_bytes(chunk)


def recv_frame(connection: object) -> tuple[str, object, dict[str, Attachment]]:
    """Receive a control frame and spool attachments above 8 MiB."""

    try:
        raw = connection.recv_bytes(MAX_CONTROL_BYTES + 1)
    except OSError as error:
        raise ProtocolError("protocol control frame exceeds its size limit") from error
    control = _decode_control(raw)
    received: dict[str, Attachment] = {}
    try:
        for descriptor in control.get("attachments", []):
            assert isinstance(descriptor, dict)
            name, size = descriptor["name"], descriptor["size"]
            assert isinstance(name, str) and isinstance(size, int)
            stream = tempfile.SpooledTemporaryFile(max_size=SPOOL_THRESHOLD, mode="w+b")
            try:
                remaining = size
                while remaining:
                    try:
                        chunk = connection.recv_bytes(min(MAX_CHUNK_BYTES, remaining) + 1)
                    except OSError as error:
                        raise ProtocolError("attachment chunk exceeds its size limit") from error
                    if not chunk or len(chunk) > MAX_CHUNK_BYTES or len(chunk) > remaining:
                        raise ProtocolError("attachment chunk is invalid")
                    stream.write(chunk)
                    remaining -= len(chunk)
                stream.seek(0)
                received[name] = Attachment(name, size, stream)
            except BaseException:
                stream.close()
                raise
        return control["type"], control["payload"], received  # type: ignore[return-value]
    except BaseException:
        for attachment in received.values():
            attachment.close()
        raise
