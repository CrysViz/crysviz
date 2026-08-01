"""Managed Python controller for a private CrysViz pywebview host."""

from __future__ import annotations

import base64
import json
import math
import os
import queue
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from multiprocessing.connection import Client
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
            # Keep a verbose GUI backend from blocking on its stderr pipe. The
            # bootstrap secret is never written to stderr by this module.
            threading.Thread(target=lambda: process.stderr.read(), name="crysviz-host-stderr", daemon=True).start()
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
                for attachment in attachments.values():
                    attachment.close()
                if message_type == "response":
                    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
                        raise ViewerProtocolError("response has no request id")
                    with self._lock:
                        pending = self._pending.pop(payload["id"], None)
                    if pending is not None:
                        pending.put(payload)
                elif message_type == "event":
                    self._accept_event(payload)
                else:
                    raise ViewerProtocolError(f"unexpected host message type {message_type!r}")
        except (EOFError, OSError, ProtocolError, ViewerError) as error:
            self._fail(ViewerProtocolError(str(error)))

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
                 timeout: float | None = None) -> object:
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
            if not isinstance(response, dict) or response.get("ok") is not True:
                if isinstance(response, ViewerError):
                    raise response
                error = response.get("error") if isinstance(response, dict) else None
                if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
                    raise ViewerProtocolError("browser response has an invalid error")
                raise BrowserCommandError(error["code"], error["message"], error.get("details"))
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

    def commit_positions(self) -> None:
        self._command("commit_positions")

    def recenter_camera(self) -> None:
        self._command("recenter_camera")

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
