"""Managed Python controller for a private CrysViz pywebview host."""

from __future__ import annotations

import base64
import json
import math
import os
import queue
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from multiprocessing.connection import Client
from numbers import Real
from pathlib import Path
from typing import Any, Callable, Sequence

from ._payload import Payload
from ._protocol import ProtocolError, recv_frame, send_frame
from ._sources import prepare_sources

DEFAULT_STARTUP_TIMEOUT = 20.0
DEFAULT_COMMAND_TIMEOUT = 30.0


class ViewerError(RuntimeError):
    """Base class for managed-viewer failures."""


class ViewerStartupError(ViewerError):
    """The private GUI host could not be started."""


class ViewerClosedError(ViewerError):
    """A command was attempted after the viewer closed."""


class ViewerCommandTimeout(ViewerError):
    """A browser command exceeded its deadline; the host has been poisoned."""


class ViewerProtocolError(ViewerError):
    """The private host violated the JSON IPC protocol."""


class BrowserCommandError(ViewerError):
    """The browser facade rejected a valid controller command."""

    def __init__(self, code: str, message: str, details: object = None):
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.details = code, message, details


class ViewerReentrancyError(ViewerError):
    """``wait`` cannot run from an event callback, where it would deadlock."""


@dataclass(frozen=True, slots=True)
class StructureInfo:
    id: str
    name: str
    frames: int
    active: bool = False
    active_frame: int | None = None


@dataclass(frozen=True, slots=True)
class LoadResult:
    structure: StructureInfo


@dataclass(frozen=True, slots=True)
class PositionUpdateResult:
    atom_count: int
    fast_path_applied: bool
    rebuilt: bool
    fallback_reason: str | None = None


@dataclass(frozen=True, slots=True)
class ViewerEvent:
    name: str
    data: object = None


def _structure(value: object) -> StructureInfo:
    if not isinstance(value, dict):
        raise ViewerProtocolError("browser returned an invalid structure result")
    try:
        ident, name, frames = value["id"], value["name"], value["frames"]
    except KeyError as error:
        raise ViewerProtocolError("browser structure result is incomplete") from error
    if not isinstance(ident, str) or not isinstance(name, str) or isinstance(frames, bool) or not isinstance(frames, int):
        raise ViewerProtocolError("browser structure result has invalid fields")
    active_frame = value.get("activeFrame")
    if active_frame is not None and (isinstance(active_frame, bool) or not isinstance(active_frame, int)):
        raise ViewerProtocolError("browser structure active frame is invalid")
    return StructureInfo(ident, name, frames, value.get("active") is True, active_frame)


def _terminate_process(process: subprocess.Popen[str]) -> None:
    try:
        process.terminate()
        process.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    finally:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass


class Viewer:
    """A process-managed CrysViz window.

    Constructing this object is side-effect-free. :meth:`start` creates the
    private child process; all browser mutations are then serialized there.
    """

    def __init__(self, sources: Sequence[object] = (), *, startup_timeout: float = DEFAULT_STARTUP_TIMEOUT,
                 command_timeout: float = DEFAULT_COMMAND_TIMEOUT, gui: str | None = None, debug: bool = False):
        if startup_timeout <= 0 or command_timeout <= 0:
            raise ValueError("timeouts must be positive")
        if gui not in {None, "gtk", "qt", "cef"}:
            raise ValueError("gui must be one of gtk, qt, cef, or None")
        self._sources = ((sources,) if isinstance(sources, (Payload, str, os.PathLike)) else tuple(sources))
        self._startup_timeout = float(startup_timeout)
        self._command_timeout = float(command_timeout)
        self._gui, self._debug = gui, debug
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._connection: Any | None = None
        self._process: subprocess.Popen[str] | None = None
        self._host_stderr = ""
        self._stderr_thread: threading.Thread | None = None
        self._reader: threading.Thread | None = None
        self._event_worker: threading.Thread | None = None
        self._events: queue.Queue[ViewerEvent | tuple[ViewerEvent, Callable[[ViewerEvent], object]] | None] = queue.Queue()
        self._pending: dict[str, queue.Queue[object]] = {}
        self._subscribers: dict[str, list[Callable[[ViewerEvent], object]]] = {}
        self._replay: dict[str, ViewerEvent] = {}
        self._started = False
        self._closed = threading.Event()
        self._ready = threading.Event()
        self._close_error: ViewerError | None = None
        self._callback_thread: int | None = None

    def __enter__(self) -> "Viewer":
        return self.start()

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def on(self, event: str, callback: Callable[[ViewerEvent], object]) -> "Viewer":
        if event not in {"ready", "structure_loaded", "active_structure_changed", "error", "closed"}:
            raise ValueError("unknown viewer event")
        if not callable(callback):
            raise TypeError("event callback must be callable")
        with self._lock:
            self._subscribers.setdefault(event, []).append(callback)
            replay = self._replay.get(event)
        if replay is not None:
            self._enqueue_event((replay, callback))
        return self

    def _enqueue_event(self, item: ViewerEvent | tuple[ViewerEvent, Callable[[ViewerEvent], object]]) -> None:
        """Schedule callbacks on the event worker, including late replay."""
        with self._lock:
            self._ensure_event_worker_locked()
        self._events.put(item)

    def _ensure_event_worker_locked(self) -> None:
        if self._event_worker is None or not self._event_worker.is_alive():
            self._event_worker = threading.Thread(target=self._event_loop, name="crysviz-events", daemon=True)
            self._event_worker.start()

    def off(self, event: str, callback: Callable[[ViewerEvent], object]) -> "Viewer":
        with self._lock:
            callbacks = self._subscribers.get(event, [])
            try:
                callbacks.remove(callback)
            except ValueError:
                pass
        return self

    def start(self) -> "Viewer":
        with self._lock:
            if self._closed.is_set():
                raise ViewerClosedError("viewer is closed")
            if self._started:
                launch = False
            else:
                self._started = True
                launch = True
        if not launch:
            self._wait_for_startup()
            return self
        try:
            self._launch()
            with self._lock:
                self._ensure_event_worker_locked()
            self._reader = threading.Thread(target=self._reader_loop, name="crysviz-ipc", daemon=True)
            self._reader.start()
            self._wait_for_startup()
            return self
        except BaseException as error:
            if isinstance(error, ViewerError):
                normalized = error
            else:
                normalized = ViewerStartupError(str(error) or "CrysViz host startup failed")
            self._fail(normalized)
            if isinstance(error, (ViewerError, TypeError, ValueError)):
                raise
            raise normalized from error

    def _wait_for_startup(self) -> None:
        if not self._ready.wait(self._startup_timeout):
            raise ViewerStartupError("CrysViz host did not become ready before startup timeout")
        if self._closed.is_set() and "ready" not in self._replay:
            if isinstance(self._close_error, ViewerStartupError):
                raise self._close_error
            raise ViewerStartupError("CrysViz host closed during startup") from self._close_error

    def _launch(self) -> None:
        prepared_sources = prepare_sources(list(self._sources))
        secret = secrets.token_bytes(32)
        bootstrap = json.dumps({
            "version": 1, "auth": base64.b64encode(secret).decode("ascii"),
            "gui": self._gui, "debug": self._debug,
        }) + "\n"
        process: subprocess.Popen[str] | None = None
        connection: Any | None = None
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "crysviz._host"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1,
            )
            with self._lock:
                cancelled = self._closed.is_set()
                if not cancelled:
                    self._process = process
            if cancelled:
                _terminate_process(process)
                raise ViewerClosedError("viewer was closed during startup")
            assert process.stdin is not None and process.stdout is not None and process.stderr is not None
            process.stdin.write(bootstrap)
            process.stdin.close()
            # Keep a verbose GUI backend from blocking on its stderr pipe, but
            # retain a bounded tail so an early native crash remains
            # diagnosable. The bootstrap secret is never written to stderr.
            def drain_stderr() -> None:
                stderr = process.stderr.read()
                with self._lock:
                    self._host_stderr = stderr[-4096:]

            self._stderr_thread = threading.Thread(
                target=drain_stderr, name="crysviz-host-stderr", daemon=True,
            )
            self._stderr_thread.start()
            deadline = time.monotonic() + self._startup_timeout
            advertised_lines: queue.Queue[str] = queue.Queue(maxsize=1)
            threading.Thread(
                target=lambda: advertised_lines.put(process.stdout.readline()),
                name="crysviz-host-advertisement", daemon=True,
            ).start()
            try:
                advertisement = advertised_lines.get(timeout=self._startup_timeout)
            except queue.Empty as error:
                raise ViewerStartupError("CrysViz host did not advertise its loopback address") from error
            if not advertisement:
                raise ViewerStartupError("CrysViz host exited before advertising its loopback address")
            try:
                advertised = json.loads(advertisement)
                address = advertised["address"]
                if (not isinstance(address, list) or len(address) != 2 or address[0] != "127.0.0.1"
                        or isinstance(address[1], bool) or not isinstance(address[1], int)):
                    raise ValueError
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
                raise ViewerStartupError("CrysViz host advertised an invalid address") from error
            while True:
                try:
                    connection = Client((address[0], address[1]), authkey=secret)
                    descriptors: list[dict[str, object]] = []
                    attachments: dict[str, object] = {}
                    for index, source in enumerate(prepared_sources):
                        attachment_name = f"source-{index}"
                        descriptors.append({
                            "attachment": attachment_name, "name": source.name, "format": source.format,
                            "binary": source.binary,
                        })
                        attachments[attachment_name] = source.open()
                    with self._send_lock:
                        send_frame(connection, "bootstrap", {"sources": descriptors}, attachments)
                    with self._lock:
                        if self._closed.is_set():
                            raise ViewerClosedError("viewer was closed during startup")
                        self._connection = connection
                        connection = None
                    return
                except (ConnectionRefusedError, OSError) as error:
                    if connection is not None:
                        connection.close()
                        connection = None
                    if self._closed.is_set():
                        raise ViewerClosedError("viewer was closed during startup") from error
                    if time.monotonic() >= deadline:
                        raise ViewerStartupError("could not authenticate to CrysViz host") from error
                    if process.poll() is not None:
                        raise ViewerStartupError("CrysViz host exited during startup") from error
                    time.sleep(0.02)
        finally:
            if connection is not None:
                try:
                    connection.close()
                except OSError:
                    pass
            for source in prepared_sources:
                source.close()

    def _reader_loop(self) -> None:
        try:
            while True:
                connection = self._connection
                if connection is None:
                    return
                message_type, payload, attachments = recv_frame(connection)
                if message_type == "response":
                    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
                        for attachment in attachments.values():
                            attachment.close()
                        raise ViewerProtocolError("response has no request id")
                    with self._lock:
                        pending = self._pending.pop(payload["id"], None)
                    if pending is not None:
                        pending.put((payload, attachments))
                    else:
                        for attachment in attachments.values():
                            attachment.close()
                        raise ViewerProtocolError("response arrived for an unknown request")
                elif message_type == "event":
                    for attachment in attachments.values():
                        attachment.close()
                    if attachments:
                        raise ViewerProtocolError("events cannot carry attachments")
                    self._accept_event(payload)
                else:
                    for attachment in attachments.values():
                        attachment.close()
                    raise ViewerProtocolError(f"unexpected host message type {message_type!r}")
        except (EOFError, OSError, ProtocolError, ViewerError) as error:
            message = str(error)
            process = self._process
            stderr_thread = self._stderr_thread
            if not message and process is not None and process.poll() is None:
                try:
                    process.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    pass
            if not message and process is not None and process.poll() is not None:
                if stderr_thread is not None:
                    stderr_thread.join(timeout=0.2)
                with self._lock:
                    stderr = self._host_stderr.strip()
                if stderr:
                    message = f"host exited unexpectedly:\n{stderr}"
            self._fail(ViewerProtocolError(message or "host connection closed unexpectedly"))

    def _accept_event(self, payload: object) -> None:
        if not isinstance(payload, dict) or set(payload) != {"event", "data"} or not isinstance(payload["event"], str):
            raise ViewerProtocolError("event has an invalid schema")
        event = ViewerEvent(payload["event"], payload["data"])
        if event.name not in {"ready", "structure_loaded", "active_structure_changed", "error", "closed"}:
            raise ViewerProtocolError("event has an unknown name")
        if event.name in {"ready", "closed"}:
            with self._lock:
                self._replay[event.name] = event
        if event.name == "ready":
            self._ready.set()
        elif event.name == "error" and not self._ready.is_set() and isinstance(event.data, dict):
            message = event.data.get("message")
            if isinstance(message, str):
                with self._lock:
                    self._close_error = ViewerStartupError(message)
        with self._lock:
            callbacks = tuple(self._subscribers.get(event.name, ()))
        for callback in callbacks:
            self._enqueue_event((event, callback))
        if event.name == "closed":
            with self._lock:
                close_error = self._close_error
            self._fail(close_error or ViewerClosedError("viewer window was closed"), emit_closed=False)

    def _event_loop(self) -> None:
        while True:
            delivery = self._events.get()
            if delivery is None:
                with self._lock:
                    if self._event_worker is threading.current_thread():
                        self._event_worker = None
                    if not self._events.empty():
                        self._ensure_event_worker_locked()
                return
            if isinstance(delivery, tuple):
                event, callbacks = delivery[0], (delivery[1],)
            else:
                event = delivery
                with self._lock:
                    callbacks = tuple(self._subscribers.get(event.name, ()))
            for callback in callbacks:
                self._callback_thread = threading.get_ident()
                try:
                    callback(event)
                except BaseException as error:
                    if event.name != "error":
                        self._events.put(ViewerEvent("error", {"code": "CALLBACK_FAILED", "message": str(error)}))
                    self._fail(ViewerError(f"viewer event callback failed: {error}"))
                    break
                finally:
                    self._callback_thread = None

    def _command(self, command: str, args: object = None, attachments: dict[str, object] | None = None,
                 timeout: float | None = None, *, include_attachments: bool = False) -> object:
        if not self._started:
            self.start()
        if self._closed.is_set():
            raise ViewerClosedError("viewer is closed")
        request_id = secrets.token_urlsafe(16)
        pending: queue.Queue[object] = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[request_id] = pending
        try:
            with self._send_lock:
                if self._connection is None:
                    raise ViewerClosedError("viewer is closed")
                send_frame(self._connection, "command", {"id": request_id, "command": command, "args": args}, attachments)
            try:
                response = pending.get(timeout=timeout or self._command_timeout)
            except queue.Empty as error:
                timeout_error = ViewerCommandTimeout(f"browser command {command!r} timed out")
                self._fail(timeout_error)
                raise timeout_error from error
            received: dict[str, object] = {}
            if isinstance(response, ViewerError):
                raise response
            if isinstance(response, tuple) and len(response) == 2:
                response, received = response
            if not isinstance(response, dict):
                for item in received.values():
                    item.close()
                raise ViewerProtocolError("browser response has an invalid schema")
            if response.get("ok") is not True:
                for item in received.values():
                    item.close()
                error = response.get("error")
                if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
                    raise ViewerProtocolError("browser response has an invalid error")
                raise BrowserCommandError(error["code"], error["message"], error.get("details"))
            if received and not include_attachments:
                for item in received.values():
                    item.close()
                raise ViewerProtocolError("browser response has unexpected attachments")
            if include_attachments:
                return response.get("result"), received
            return response.get("result")
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def load(self, source: object) -> LoadResult:
        sources = prepare_sources([source])
        prepared = sources[0]
        try:
            payload = {"name": prepared.name, "format": prepared.format, "binary": prepared.binary}
            result = self._command("load", payload, {"data": prepared.open()})
            return LoadResult(_structure(result))
        finally:
            prepared.close()

    def list_structures(self) -> list[StructureInfo]:
        value = self._command("list_structures")
        if not isinstance(value, list):
            raise ViewerProtocolError("browser list_structures result is invalid")
        return [_structure(item) for item in value]

    def select(self, structure_id: str, *, frame: int = 0) -> None:
        self._command("select", {"id": structure_id, "frame": frame})

    def update_fractional_positions(self, positions: Sequence[Sequence[float]], *, commit: bool = False) -> PositionUpdateResult:
        if isinstance(positions, (str, bytes)) or not isinstance(positions, Sequence):
            raise ValueError("positions must be a sequence of three-component coordinates")
        copied: list[list[float]] = []
        for point in positions:
            if isinstance(point, (str, bytes)) or not isinstance(point, Sequence) or len(point) != 3:
                raise ValueError("every position must be exactly three finite numbers")
            values: list[float] = []
            for value in point:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError("every position must be exactly three finite numbers")
                values.append(float(value))
            copied.append(values)
        if not isinstance(commit, bool):
            raise TypeError("commit must be boolean")
        value = self._command("update_fractional_positions", {"positions": copied, "commit": commit})
        if not isinstance(value, dict):
            raise ViewerProtocolError("position update result is invalid")
        try:
            return PositionUpdateResult(value["atomCount"], value["fastPathApplied"], value["rebuilt"], value.get("fallbackReason"))
        except KeyError as error:
            raise ViewerProtocolError("position update result is incomplete") from error

    def update_lattice(self, lattice: Sequence[Sequence[float]]) -> None:
        if isinstance(lattice, (str, bytes)) or not isinstance(lattice, Sequence) or len(lattice) != 3:
            raise ValueError("lattice must be a sequence of three three-component vectors")
        copied: list[list[float]] = []
        for vector in lattice:
            if isinstance(vector, (str, bytes)) or not isinstance(vector, Sequence) or len(vector) != 3:
                raise ValueError("every lattice vector must be exactly three finite numbers")
            values: list[float] = []
            for value in vector:
                if isinstance(value, bool) or not isinstance(value, Real):
                    raise ValueError("every lattice vector must be exactly three finite numbers")
                try:
                    copied_value = float(value)
                except OverflowError as error:
                    raise ValueError("every lattice vector must be exactly three finite numbers") from error
                if not math.isfinite(copied_value):
                    raise ValueError("every lattice vector must be exactly three finite numbers")
                values.append(copied_value)
            copied.append(values)
        determinant = (
            copied[0][0] * (copied[1][1] * copied[2][2] - copied[1][2] * copied[2][1])
            - copied[0][1] * (copied[1][0] * copied[2][2] - copied[1][2] * copied[2][0])
            + copied[0][2] * (copied[1][0] * copied[2][1] - copied[1][1] * copied[2][0])
        )
        if abs(determinant) < 1e-12:
            raise ValueError("lattice must be nonsingular")
        self._command("update_lattice", {"lattice": copied})

    def commit_positions(self) -> None:
        self._command("commit_positions")

    def recenter_camera(self) -> None:
        self._command("recenter_camera")

    def rotate_camera(self, angle_degrees: float, *, axis: str = "y") -> None:
        if isinstance(angle_degrees, bool) or not isinstance(angle_degrees, (int, float)):
            raise TypeError("angle_degrees must be a number")
        try:
            angle = float(angle_degrees)
        except OverflowError as error:
            raise ValueError("angle_degrees must be finite") from error
        if not math.isfinite(angle):
            raise ValueError("angle_degrees must be finite")
        if axis not in {"x", "y", "z"}:
            raise ValueError("axis must be x, y, or z")
        self._command("rotate_camera", {"angleDegrees": angle, "axis": axis})

    def set_render_pipeline(self, pipeline_id: str) -> str:
        valid = {"depthpeel", "wboit", "forward", "raytrace", "pathtrace", "split-atoms", "sorted-atoms"}
        if not isinstance(pipeline_id, str) or pipeline_id not in valid:
            raise ValueError("unknown rendering pipeline")
        result = self._command("set_render_pipeline", {"pipelineId": pipeline_id})
        if not isinstance(result, str) or result not in valid:
            raise ViewerProtocolError("browser returned an invalid active pipeline")
        return result

    def save_image(self, path: str | os.PathLike[str], *, width: int = 800, height: int = 600,
                   margin: int = 0, transparent: bool = False, timeout: float | None = None) -> Path:
        if isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 16384:
            raise ValueError("width must be an integer from 1 through 16384")
        if isinstance(height, bool) or not isinstance(height, int) or not 1 <= height <= 16384:
            raise ValueError("height must be an integer from 1 through 16384")
        if isinstance(margin, bool) or not isinstance(margin, int) or not 0 <= margin <= 4096:
            raise ValueError("margin must be an integer from 0 through 4096")
        if not isinstance(transparent, bool):
            raise TypeError("transparent must be boolean")
        if timeout is not None:
            try:
                valid_timeout = (not isinstance(timeout, bool) and isinstance(timeout, (int, float))
                                 and math.isfinite(float(timeout)) and timeout > 0)
            except OverflowError:
                valid_timeout = False
            if not valid_timeout:
                raise ValueError("timeout must be a positive finite number")
        target = Path(path)
        result, received = self._command(
            "save_image", {"width": width, "height": height, "margin": margin, "transparent": transparent},
            timeout=timeout, include_attachments=True,
        )
        try:
            if not isinstance(result, dict) or result.get("contentType") != "image/png" \
                    or result.get("attachment") != "image" or set(received) != {"image"}:
                raise ViewerProtocolError("browser PNG response is missing its image attachment")
            attachment = received["image"]
            if not isinstance(result.get("size"), int) or result["size"] != attachment.size:
                raise ViewerProtocolError("browser PNG response has an invalid image size")
            attachment.stream.seek(0)
            if attachment.stream.read(8) != b"\x89PNG\r\n\x1a\n":
                raise ViewerProtocolError("browser PNG response has an invalid signature")
            attachment.stream.seek(0)
            temp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w+b", prefix=f".{target.name}.", suffix=".tmp", dir=target.parent, delete=False,
                ) as output:
                    temp_path = Path(output.name)
                    shutil.copyfileobj(attachment.stream, output, length=1024 * 1024)
                    output.flush()
                os.replace(temp_path, target)
                temp_path = None
            finally:
                if temp_path is not None:
                    try:
                        temp_path.unlink()
                    except OSError:
                        pass
        finally:
            for attachment in received.values():
                attachment.close()
        return target

    def wait(self, timeout: float | None = None) -> None:
        if self._callback_thread == threading.get_ident():
            raise ViewerReentrancyError("Viewer.wait() cannot be called from a viewer event callback")
        if not self._closed.wait(timeout):
            raise TimeoutError("viewer did not close before timeout")

    def close(self) -> None:
        if self._closed.is_set():
            return
        try:
            if self._started and self._connection is not None:
                try:
                    self._command("close", timeout=2.0)
                except ViewerError:
                    pass
        finally:
            self._fail(ViewerClosedError("viewer closed"))

    def _fail(self, error: ViewerError, *, emit_closed: bool = True) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
            self._close_error = error
            self._ready.set()
            closed_callbacks: tuple[Callable[[ViewerEvent], object], ...] = ()
            if emit_closed:
                self._replay.setdefault("closed", ViewerEvent("closed", None))
                closed_callbacks = tuple(self._subscribers.get("closed", ()))
            pending, self._pending = tuple(self._pending.values()), {}
            connection, self._connection = self._connection, None
            process, self._process = self._process, None
        for waiter in pending:
            waiter.put(error)
        if emit_closed:
            closed = ViewerEvent("closed", None)
            for callback in closed_callbacks:
                self._enqueue_event((closed, callback))
        self._events.put(None)
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        if process is not None:
            _terminate_process(process)


def show(sources: Sequence[object] | object = (), **kwargs: object) -> Viewer:
    """Create, start, and wait until a managed viewer reports ``ready``."""

    return Viewer(sources, **kwargs).start()
