"""Secure loopback static/capability server used by the launcher."""

from __future__ import annotations

import errno
import json
import mimetypes
import re
import secrets
import sys
import tempfile
import threading
from contextlib import ExitStack
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit

from ._protocol import MAX_BLOB_BYTES
from ._sources import PreparedSource, SPOOL_THRESHOLD

_CAPABILITY_RE = re.compile(r"^[A-Za-z0-9_-]{32,}$")
_VALID_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
}
_CHUNK_SIZE = 64 * 1024
_MAX_COMPLETION_BODY = 16 * 1024


def _new_capability(used: set[str]) -> str:
    while True:
        value = secrets.token_urlsafe(32)
        if value not in used:
            used.add(value)
            return value


def _safe_json_error(code: str, message: str, details: object = None) -> dict[str, object]:
    result: dict[str, object] = {"code": code, "message": message}
    if details is not None:
        result["details"] = details
    return result


class _LaunchState:
    def __init__(self, root: Path, sources: list[PreparedSource], debug: bool,
                 bridge_capability: str | None = None):
        self.root = root
        self.sources = sources
        self.debug = debug
        self.lock = threading.RLock()
        self.used: set[str] = set()
        self.manifest_capability = _new_capability(self.used)
        self.input_capabilities = [_new_capability(self.used) for _ in sources]
        self.one_use_capabilities: set[str] = set()
        self.output_pending: set[str] = set()
        self.output_claimed: dict[str, tempfile.SpooledTemporaryFile] = {}
        self.output_completed: dict[str, tempfile.SpooledTemporaryFile] = {}
        self.bridge_capability = bridge_capability
        self.active = True
        self.manifest_active = True

    def manifest(self, base_url: str) -> bytes:
        inputs: list[dict[str, object]] = []
        for capability, source in zip(self.input_capabilities, self.sources, strict=True):
            item: dict[str, object] = {
                "url": f"{base_url}/_crysviz/input/{capability}",
                "name": source.name,
            }
            if source.format is not None:
                item["format"] = source.format
            if source.binary:
                item["binary"] = True
            inputs.append(item)
        manifest: dict[str, object] = {"version": 1, "inputs": inputs}
        if self.bridge_capability is not None:
            manifest["bridgeCapability"] = self.bridge_capability
        return json.dumps(manifest, separators=(",", ":")).encode("utf-8")

    def expire(self) -> None:
        with self.lock:
            self.active = False
            self.manifest_active = False
            for source in self.sources:
                source.close()
            self.sources.clear()
            self.input_capabilities.clear()
            self.one_use_capabilities.clear()
            for stream in self.output_completed.values():
                stream.close()
            for stream in self.output_claimed.values():
                stream.close()
            self.output_pending.clear()
            self.output_claimed.clear()
            self.output_completed.clear()

    def complete_manifest(self) -> None:
        """Revoke bootstrap inputs while retaining a managed bridge server."""
        with self.lock:
            self.manifest_active = False
            if self.bridge_capability is None:
                self.expire()
                return
            for source in self.sources:
                source.close()
            self.sources.clear()
            self.input_capabilities.clear()
            self.one_use_capabilities.clear()
            for stream in self.output_completed.values():
                stream.close()
            for stream in self.output_claimed.values():
                stream.close()
            self.output_pending.clear()
            self.output_claimed.clear()
            self.output_completed.clear()

    def add_source(self, source: PreparedSource) -> str:
        """Publish one private, capability-addressed input for the JS bridge."""
        with self.lock:
            if not self.active:
                source.close()
                raise RuntimeError("server is closed")
            capability = _new_capability(self.used)
            self.sources.append(source)
            self.input_capabilities.append(capability)
            self.one_use_capabilities.add(capability)
            return capability

    def input_source(self, capability: str, *, consume: bool) -> tuple[PreparedSource | None, bool]:
        """Return an input source, atomically claiming one-use GET routes."""
        with self.lock:
            if not self.active:
                return None, False
            try:
                index = self.input_capabilities.index(capability)
            except ValueError:
                return None, False
            source = self.sources[index]
            one_use = capability in self.one_use_capabilities
            if consume and one_use:
                self.input_capabilities.pop(index)
                self.sources.pop(index)
                self.one_use_capabilities.remove(capability)
            return source, consume and one_use

    def reserve_output(self, base_url: str) -> str:
        with self.lock:
            if not self.active:
                raise RuntimeError("server is closed")
            capability = _new_capability(self.used)
            self.output_pending.add(capability)
            return f"{base_url}/_crysviz/output/{capability}"

    def claim_output_post(self, capability: str) -> tempfile.SpooledTemporaryFile | None:
        with self.lock:
            if capability not in self.output_pending or not self.active:
                return None
            self.output_pending.remove(capability)
            stream = tempfile.SpooledTemporaryFile(max_size=SPOOL_THRESHOLD, mode="w+b")
            self.output_claimed[capability] = stream
            return stream

    def complete_output_upload(self, capability: str) -> bool:
        with self.lock:
            stream = self.output_claimed.pop(capability, None)
            if stream is not None:
                self.output_completed[capability] = stream
                return True
            return False

    def take_output(self, capability: str) -> tempfile.SpooledTemporaryFile | None:
        with self.lock:
            return self.output_completed.pop(capability, None)

    def discard_output(self, capability: str) -> None:
        with self.lock:
            self.output_pending.discard(capability)
            stream = self.output_claimed.pop(capability, None)
            completed = self.output_completed.pop(capability, None)
        for item in (stream, completed):
            if item is not None:
                item.close()


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    server_version = "CrysViz"
    sys_version = ""

    def __init__(self, address: tuple[str, int], state: _LaunchState):
        self.state = state
        super().__init__(address, _RequestHandler)
        self.expected_host = f"127.0.0.1:{self.server_address[1]}"

    def handle_error(self, request: object, client_address: object) -> None:
        if self.state.debug:
            super().handle_error(request, client_address)


class _RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CrysViz"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        if self.server.state.debug:  # type: ignore[attr-defined]
            # Never include the target: it may contain a capability.
            print(f"[crysviz] {getattr(self, 'command', 'HTTP')} request completed", file=sys.stderr)

    @staticmethod
    def _is_disconnect(error: BaseException) -> bool:
        return isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)) or (
            isinstance(error, OSError)
            and error.errno in {errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED, errno.ENOTCONN}
        )

    @property
    def state(self) -> _LaunchState:
        return self.server.state  # type: ignore[attr-defined]

    def _send(self, status: int, content_type: str, length: int = 0, body: bytes | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        if getattr(self, "close_connection", False):
            self.send_header("Connection", "close")
        for key, value in _SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        if body is not None and getattr(self, "command", "") != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self.close_connection = True
        body = json.dumps({"error": _safe_json_error(code, message)}, separators=(",", ":")).encode()
        self._send(status, "application/json", len(body), body)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        try:
            phrase = HTTPStatus(code).phrase
        except ValueError:
            phrase = "HTTP request error"
        self._error(code, "HTTP_ERROR", phrase)

    def _host_ok(self) -> bool:
        values = self.headers.get_all("Host", [])
        return len(values) == 1 and values[0] == self.server.expected_host  # type: ignore[attr-defined]

    def _request_path(self) -> tuple[str, str] | None:
        if not self.path or "\x00" in self.path:
            return None
        split = urlsplit(self.path)
        if split.scheme or split.netloc or split.fragment or not split.path.startswith("/"):
            return None
        if split.query:
            # The launch document is the sole URL allowed to carry the
            # manifest capability.  Keep the spelling exact so alternate
            # query encodings cannot become capability aliases.
            expected = f"_crysviz_manifest={self.state.manifest_capability}"
            if split.path not in {"/", "/index.html"} or split.query != expected:
                return None
        if _VALID_PERCENT_RE.search(split.path):
            return None
        try:
            decoded = unquote_to_bytes(split.path).decode("utf-8", "strict")
        except UnicodeDecodeError:
            return None
        if "\\" in decoded or "\x00" in decoded or "//" in decoded:
            return None
        parts = decoded.split("/")
        if any(part in {".", ".."} for part in parts):
            return None
        return split.path, decoded

    def do_GET(self) -> None:
        self._dispatch(False)

    def do_HEAD(self) -> None:
        self._dispatch(True)

    def _unsupported_method(self) -> None:
        if not self._host_ok():
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Only GET and HEAD are allowed")

    do_DELETE = _unsupported_method
    do_OPTIONS = _unsupported_method
    do_PATCH = _unsupported_method
    do_PUT = _unsupported_method
    do_TRACE = _unsupported_method
    do_CONNECT = _unsupported_method

    def do_POST(self) -> None:
        if not self._host_ok():
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        request_path = self._request_path()
        if request_path is None:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        raw_path, path = request_path
        manifest_prefix = "/_crysviz/manifest/"
        output_prefix = "/_crysviz/output/"
        if path.startswith(manifest_prefix):
            if raw_path != path:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            if path.endswith("/complete"):
                capability = path[len(manifest_prefix):-len("/complete")]
                if _CAPABILITY_RE.fullmatch(capability):
                    self._complete(capability)
                    return
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        if path.startswith(output_prefix):
            if raw_path != path:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            capability = path[len(output_prefix):]
            if _CAPABILITY_RE.fullmatch(capability):
                self._upload_output(capability)
                return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "Only GET and HEAD are allowed")

    def _dispatch(self, head: bool) -> None:
        if not self._host_ok():
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        request_path = self._request_path()
        if request_path is None:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        raw_path, path = request_path
        manifest_prefix = "/_crysviz/manifest/"
        input_prefix = "/_crysviz/input/"
        output_prefix = "/_crysviz/output/"
        if path.startswith(manifest_prefix):
            if raw_path != path:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            capability = path[len(manifest_prefix):]
            if _CAPABILITY_RE.fullmatch(capability) and capability == self.state.manifest_capability:
                with self.state.lock:
                    if self.state.active and self.state.manifest_active:
                        body = self.state.manifest(self._base_url())
                    else:
                        body = None
                if body is not None:
                    self._send(HTTPStatus.OK, "application/json", len(body), body)
                    return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        if path.startswith(input_prefix):
            if raw_path != path:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            capability = path[len(input_prefix):]
            if _CAPABILITY_RE.fullmatch(capability):
                source, claimed = self.state.input_source(capability, consume=not head)
                if source is not None:
                    try:
                        self._stream_source(source)
                    finally:
                        if claimed:
                            source.close()
                    return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        if path.startswith(output_prefix):
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        self._serve_static(path)

    def _base_url(self) -> str:
        return f"http://{self.server.expected_host}"  # type: ignore[attr-defined]

    def _stream_source(self, source: PreparedSource) -> None:
        headers_sent = False
        try:
            stream = source.open()
            size = self._stream_length(stream)
            content_type = "application/octet-stream" if source.binary else "text/plain; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            for key, value in _SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            headers_sent = True
            if self.command != "HEAD":
                while True:
                    block = stream.read(_CHUNK_SIZE)
                    if not block:
                        break
                    self.wfile.write(block)
        except (FileNotFoundError, OSError) as error:
            if headers_sent or self._is_disconnect(error):
                return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")

    @staticmethod
    def _stream_length(stream: object) -> int:
        current = stream.tell()  # type: ignore[attr-defined]
        stream.seek(0, 2)  # type: ignore[attr-defined]
        size = stream.tell()  # type: ignore[attr-defined]
        stream.seek(current)  # type: ignore[attr-defined]
        return size

    def _serve_static(self, path: str) -> None:
        relative = path.lstrip("/")
        if not relative:
            relative = "index.html"
        candidate = self.state.root / relative
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(self.state.root)
        except (FileNotFoundError, OSError, ValueError):
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        if not resolved.is_file():
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        content_type = _content_type(resolved)
        headers_sent = False
        try:
            size = resolved.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            for key, value in _SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            headers_sent = True
            if self.command == "HEAD":
                return
            with resolved.open("rb") as stream:
                while block := stream.read(_CHUNK_SIZE):
                    self.wfile.write(block)
        except OSError as error:
            if headers_sent or self._is_disconnect(error):
                return
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")

    def _complete(self, capability: str) -> None:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        content_lengths = self.headers.get_all("Content-Length", [])
        transfer_encodings = self.headers.get_all("Transfer-Encoding", [])
        if len(content_lengths) != 1 or transfer_encodings:
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        content_length = content_lengths[0]
        try:
            length = int(content_length) if content_length is not None else -1
        except ValueError:
            length = -1
        if length < 0 or length > _MAX_COMPLETION_BODY:
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        body = self.rfile.read(length)
        if len(body) != length:
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        if not isinstance(value, dict) or set(value) not in ({"ok"}, {"ok", "error"}):
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        if value.get("ok") is True and set(value) == {"ok"}:
            pass
        elif value.get("ok") is False and set(value) == {"ok", "error"}:
            error = value["error"]
            if not isinstance(error, dict) or set(error) - {"code", "message", "details"}:
                self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
                return
            if not isinstance(error.get("code"), str) or not error["code"]:
                self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
                return
            if not isinstance(error.get("message"), str) or not error["message"]:
                self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
                return
        else:
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_COMPLETION", "Invalid completion body")
            return
        with self.state.lock:
            if (not self.state.active or not self.state.manifest_active
                    or capability != self.state.manifest_capability):
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
                return
            self.state.complete_manifest()
        self._send(HTTPStatus.OK, "application/json", 2, b"{}")

    def _upload_output(self, capability: str) -> None:
        content_type = self.headers.get("Content-Type", "")
        lengths = self.headers.get_all("Content-Length", [])
        transfers = self.headers.get_all("Transfer-Encoding", [])
        stream = self.state.claim_output_post(capability)
        if stream is None:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Resource not found")
            return
        if content_type.strip().lower() != "image/png" or len(lengths) != 1 or transfers:
            self.state.discard_output(capability)
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_OUTPUT", "Invalid PNG upload")
            return
        raw_length = lengths[0]
        if raw_length is None or not re.fullmatch(r"[0-9]+", raw_length.strip()):
            self.state.discard_output(capability)
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_OUTPUT", "Invalid PNG upload")
            return
        length = int(raw_length)
        if length == 0:
            self.state.discard_output(capability)
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_OUTPUT", "Invalid PNG upload")
            return
        if length > MAX_BLOB_BYTES:
            self.state.discard_output(capability)
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "OUTPUT_TOO_LARGE", "PNG upload is too large")
            return
        try:
            remaining = length
            while remaining:
                block = self.rfile.read(min(_CHUNK_SIZE, remaining))
                if not block:
                    raise OSError("PNG upload ended before its advertised length")
                stream.write(block)
                remaining -= len(block)
            stream.seek(0)
            if not self.state.complete_output_upload(capability):
                raise OSError("PNG upload capability was revoked")
            self._send(HTTPStatus.OK, "application/json", 2, b"{}")
        except (OSError, ConnectionError):
            self.state.discard_output(capability)
            try:
                self._error(HTTPStatus.BAD_REQUEST, "INVALID_OUTPUT", "Invalid PNG upload")
            except OSError:
                self.close_connection = True


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".js", ".mjs"}:
        return "text/javascript"
    if suffix == ".wasm":
        return "application/wasm"
    if suffix == ".json":
        return "application/json"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


class CrysVizServer:
    """Own a loopback server and its importlib resource lifetime."""

    def __init__(self, sources: list[PreparedSource], port: int = 0, debug: bool = False,
                 *, bridge_capability: str | None = None):
        if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("port must be an integer from 0 through 65535")
        self.sources = sources
        self.port = port
        self.debug = debug
        self._bridge_capability = bridge_capability
        self._stack: ExitStack | None = None
        self._httpd: _Server | None = None
        self._thread: threading.Thread | None = None
        self._closed = False

    def start(self) -> "CrysVizServer":
        if self._closed:
            raise RuntimeError("server is closed")
        if self._httpd is not None:
            return self
        stack = ExitStack()
        httpd: _Server | None = None
        thread: threading.Thread | None = None
        try:
            traversable = resources.files("crysviz.web")
            root = stack.enter_context(resources.as_file(traversable))
            state = _LaunchState(Path(root).resolve(), self.sources, self.debug,
                                 self._bridge_capability)
            httpd = _Server(("127.0.0.1", self.port), state)
            self._stack = stack
            self._httpd = httpd
            thread = threading.Thread(
                target=httpd.serve_forever,
                kwargs={"poll_interval": 0.05},
                name="crysviz-http",
                daemon=True,
            )
            self._thread = thread
            thread.start()
            return self
        except BaseException:
            self._closed = True
            if httpd is not None:
                httpd.state.expire()
                if thread is not None and thread.is_alive():
                    httpd.shutdown()
                    thread.join(timeout=5)
                httpd.server_close()
            self._httpd = None
            self._thread = None
            self._stack = None
            stack.close()
            for source in self.sources:
                source.close()
            raise

    @property
    def address(self) -> tuple[str, int]:
        if self._httpd is None:
            raise RuntimeError("server has not started")
        return self._httpd.server_address

    @property
    def url(self) -> str:
        if self._httpd is None:
            raise RuntimeError("server has not started")
        return f"http://127.0.0.1:{self.address[1]}/index.html?_crysviz_manifest={self._httpd.state.manifest_capability}"

    @property
    def bridge_capability(self) -> str | None:
        return self._httpd.state.bridge_capability if self._httpd is not None else self._bridge_capability

    def publish(self, source: PreparedSource) -> str:
        """Return a one-time-private input URL for a managed browser command."""
        if self._httpd is None:
            raise RuntimeError("server has not started")
        capability = self._httpd.state.add_source(source)
        return f"http://{self._httpd.expected_host}/_crysviz/input/{capability}"

    def reserve_output(self) -> str:
        """Reserve a one-use PNG upload URL for the managed browser."""
        if self._httpd is None:
            raise RuntimeError("server has not started")
        return self._httpd.state.reserve_output(f"http://{self._httpd.expected_host}")

    def _output_capability(self, url: str) -> str | None:
        if self._httpd is None or not isinstance(url, str):
            return None
        try:
            split = urlsplit(url)
        except ValueError:
            return None
        prefix = "/_crysviz/output/"
        if (split.scheme != "http" or split.netloc != self._httpd.expected_host
                or split.query or split.fragment or split.username or split.password
                or not split.path.startswith(prefix)
                or not _CAPABILITY_RE.fullmatch(split.path[len(prefix):])
                or f"http://{split.netloc}{split.path}" != url):
            return None
        return split.path[len(prefix):]

    def take_output(self, url: str):
        capability = self._output_capability(url)
        if capability is None:
            return None
        return self._httpd.state.take_output(capability)

    def discard_output(self, url: str) -> None:
        capability = self._output_capability(url)
        if capability is not None:
            self._httpd.state.discard_output(capability)

    def wait(self) -> None:
        if self._thread is None:
            raise RuntimeError("server has not started")
        self._thread.join()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._httpd is not None:
            self._httpd.state.expire()
            self._httpd.shutdown()
            self._httpd.server_close()
        else:
            for source in self.sources:
                source.close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._stack is not None:
            self._stack.close()
        self._httpd = None
        self._thread = None

    def __enter__(self) -> "CrysVizServer":
        return self.start()

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()
