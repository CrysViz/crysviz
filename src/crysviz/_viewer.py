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
from dataclasses import dataclass, field
from functools import lru_cache
from importlib.resources import files
from multiprocessing.connection import Client
from numbers import Real
from pathlib import Path
from typing import Any, Callable, Sequence

from ._payload import Payload
from ._protocol import ProtocolError, recv_frame, send_frame
from ._sources import prepare_sources

DEFAULT_STARTUP_TIMEOUT = 20.0
DEFAULT_COMMAND_TIMEOUT = 30.0
# Longest single wait_job call: well inside the command timeout.
_JOB_POLL_S = 20.0
# Commands that move files have their own methods.
_FILE_COMMANDS = {"load": "load", "save_image": "save_image", "export_structure": "export_structure", "close": "close"}


@lru_cache(maxsize=1)
def command_spec() -> dict[str, Any]:
    """The browser command registry's description (``crysviz.web/host/commands.json``)."""
    return json.loads(files("crysviz.web").joinpath("host/commands.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def _changes_state(command: str) -> bool:
    """Whether a command is a write (its result reports ``applied``), from its registry tier."""
    entry = next((c for c in command_spec()["commands"] if c["name"] == command), None)
    return entry is not None and entry.get("tier") != "read"


@lru_cache(maxsize=None)
def _argument_names(command: str) -> dict[str, str]:
    """A command's argument names keyed by their letters alone, so ``temperature_k`` finds ``temperatureK``."""
    entry = next((c for c in command_spec()["commands"] if c["name"] == command), None)
    names = list(entry["args"].get("properties", {})) if entry else []
    return {name.replace("_", "").lower(): name for name in [*names, "expectedRevision"]}


def _argument_name(command: str, key: str) -> str:
    return _argument_names(command).get(key.replace("_", "").lower(), key)


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


class CommandRefused(BrowserCommandError):
    """The command was valid but the situation refused it (the structure changed under it, a job is
    running, atoms would collide): nothing was changed. :meth:`Viewer.call` returns these as a result,
    ``{"applied": False, "reason": ..., "code": ...}``; the typed methods raise this exception."""


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
    # The browser's whole result: structure (row id), frames, activeFrame, atomCount, revision,
    # formula, and restored ({supercell}) when the Cell & Supercell window restored one.
    details: dict[str, Any] = field(default_factory=dict, compare=False)


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
    """A row: a command's result (``structure`` is the row id) or a get_state structures entry (``id``)."""
    if not isinstance(value, dict):
        raise ViewerProtocolError("browser returned an invalid structure result")
    try:
        ident, name, frames = value["structure"] if "structure" in value else value["id"], value["name"], value["frames"]
    except KeyError as error:
        raise ViewerProtocolError("browser structure result is incomplete") from error
    if not isinstance(ident, str) or not isinstance(name, str) or isinstance(frames, bool) or not isinstance(frames, int):
        raise ViewerProtocolError("browser structure result has invalid fields")
    active_frame = value.get("activeFrame")
    if active_frame is not None and (isinstance(active_frame, bool) or not isinstance(active_frame, int)):
        raise ViewerProtocolError("browser structure active frame is invalid")
    active = value["active"] is True if "active" in value else active_frame is not None
    return StructureInfo(ident, name, frames, active, active_frame)


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
        # sinceLastCall notes (what the user changed by hand between commands), for take_user_changes.
        self._user_changes: list[dict[str, object]] = []

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
                 timeout: float | None = None, *, include_attachments: bool = False,
                 outcomes: bool = False) -> object:
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
                command_args = {} if args is None else args
                send_frame(self._connection, "command", {
                    "id": request_id, "command": command, "args": command_args,
                }, attachments)
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
            note = (response.get("result") if response.get("ok") is True
                    else (response.get("error") or {}).get("details"))
            if isinstance(note, dict) and isinstance(note.get("sinceLastCall"), dict):
                with self._lock:
                    self._user_changes.append(note["sinceLastCall"])
            if response.get("ok") is not True:
                for item in received.values():
                    item.close()
                error = response.get("error")
                if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
                    raise ViewerProtocolError("browser response has an invalid error")
                raise BrowserCommandError(error["code"], error["message"], error.get("details"))
            result = response.get("result")
            if isinstance(result, dict) and result.get("applied") is False and not outcomes:
                # A refusal ({applied: false, reason, code}): call() hands it back as a result,
                # the typed methods raise, so code that expected the change notices.
                for item in received.values():
                    item.close()
                details = {k: v for k, v in result.items() if k not in {"applied", "reason", "code"}}
                raise CommandRefused(str(result.get("code")), str(result.get("reason")), details or None)
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

    def load(self, source: object, *, periodic: bool | None = None, interactive: bool = True) -> LoadResult:
        """Load a structure. ``interactive=False`` skips load-time questions (CIF symmetry)."""
        if periodic is not None and not isinstance(periodic, bool):
            raise TypeError("periodic must be True, False or None")
        if not isinstance(interactive, bool):
            raise TypeError("interactive must be boolean")
        sources = prepare_sources([source])
        prepared = sources[0]
        try:
            payload: dict[str, object] = {"name": prepared.name, "format": prepared.format}
            if periodic is not None:
                payload["periodic"] = periodic
            if not interactive:
                payload["interactive"] = False
            result = self._command("load", payload, {"data": prepared.open()})
            return LoadResult(_structure(result), dict(result) if isinstance(result, dict) else {})
        finally:
            prepared.close()

    def call(self, command: str, **args: object) -> Any:
        """Run any browser command by name (see crysviz.web/host/commands.json) and return its result.

        A write that the situation refused (the structure changed under it, a job is running,
        atoms would collide) is not an exception here: it returns ``{"applied": False, "reason":
        ..., "code": ..., ...}`` and changes nothing; a successful write has ``"applied": True``.
        A wrong call (bad arguments, an unknown control) raises :class:`BrowserCommandError`.

        Arguments may be given in snake_case or as the command names them:
        ``viewer.call("run_md", temperature_k=600, steps=200)`` sends ``temperatureK``.
        Nested objects (``where``, ``rotate``) are passed as they are. Commands that
        move files have their own methods: :meth:`load`, :meth:`save_image`,
        :meth:`export_structure`. For a ``run_*`` job, :meth:`run_job` waits for it.
        """
        if not isinstance(command, str) or not command:
            raise ValueError("command must be a nonempty string")
        if command in _FILE_COMMANDS:
            raise ValueError(f"use Viewer.{_FILE_COMMANDS[command]}() for {command!r}")
        result = self._command(command, {_argument_name(command, key): value for key, value in args.items()},
                               outcomes=True)
        # A write says whether it changed anything: applied: false (with reason and code) when the
        # situation refused it, applied: true otherwise.
        if isinstance(result, dict) and "applied" not in result and _changes_state(command):
            result = {"applied": True, **result}
        return result

    def run_job(self, command: str, *, timeout: float | None = None, **args: object) -> dict[str, Any]:
        """Start a ``run_*`` job (``run_md``, ``run_relax``, ``run_energy``, ``run_eos``,
        ``run_ordering``) and wait until it ends; return its final status.

        The status has ``status`` (done, failed, cancelled), ``result`` and ``active`` (the
        structure and frame on show afterwards). A failed job raises
        :class:`BrowserCommandError`. After ``timeout`` seconds a ``TimeoutError`` is raised
        and the job keeps running (``call("cancel_job", job_id=...)`` stops it).
        """
        if not isinstance(command, str) or not command.startswith("run_"):
            raise ValueError("run_job runs run_* commands")
        if timeout is not None and not (isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0):
            raise ValueError("timeout must be a positive number of seconds")
        view = self.call(command, **args)
        if isinstance(view, dict) and view.get("applied") is False:  # e.g. JOB_BUSY: nothing started
            details = {k: v for k, v in view.items() if k not in {"applied", "reason", "code"}}
            raise CommandRefused(str(view.get("code")), str(view.get("reason")), details or None)
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        while isinstance(view, dict) and view.get("status") == "running":
            wait = _JOB_POLL_S
            if deadline is not None:
                wait = min(wait, deadline - time.monotonic())
                if wait <= 0:
                    raise TimeoutError(f"job {view.get('jobId')} is still running after {timeout} s")
            view = self._command("wait_job", {"jobId": view["jobId"], "timeoutS": wait})
        if not isinstance(view, dict) or "status" not in view:
            raise ViewerProtocolError(f"browser {command} returned no job")
        if view["status"] == "failed":
            error = view.get("error") if isinstance(view.get("error"), dict) else {}
            raise BrowserCommandError(str(error.get("code", "JOB_FAILED")), str(error.get("message", f"{command} failed")),
                                      error.get("details"))
        return view

    def take_user_changes(self) -> list[dict[str, object]]:
        """What the user changed by hand in the window since earlier commands, and clear it.

        Every command's result (or error details) also carries this as ``sinceLastCall``; the
        typed methods (:meth:`load`, :meth:`save_image`, ...) return their own values, so read it here.
        """
        with self._lock:
            changes, self._user_changes = self._user_changes, []
        return changes

    def list_structures(self) -> list[StructureInfo]:
        value = self._command("get_state", {"include": ["structures"]})
        if not isinstance(value, dict) or not isinstance(value.get("structures"), list):
            raise ViewerProtocolError("browser structure list is invalid")
        return [_structure(item) for item in value["structures"]]

    def get_state(self, *, include: Sequence[str] | None = None) -> dict[str, Any]:
        """What the viewer shows now: the active structure and renderer, plus the ``include``
        sections (default camera, selection, jobs; also structures, colors, phonons, field)."""
        if include is not None and (isinstance(include, (str, bytes)) or not isinstance(include, Sequence)):
            raise TypeError("include must be a sequence of section names")
        value = self._command("get_state", None if include is None else {"include": list(include)})
        if not isinstance(value, dict):
            raise ViewerProtocolError("browser get_state result is invalid")
        return value

    def select(self, structure_id: str, *, frame: int = 0) -> None:
        self._command("select_structure", {"structure": structure_id, "frame": frame})

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
        self._command("set_lattice", {"lattice": copied})

    def commit_positions(self) -> None:
        self._command("commit_positions")

    def recenter_camera(self) -> None:
        self._command("set_view", {"recenter": True})

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
        self._command("set_view", {"rotate": {"axis": axis, "degrees": angle}})

    def set_view(self, direction: str | Sequence[float] | None = None, *, up: str | Sequence[float] | None = None,
                 zoom: float | None = None, cartesian: bool = False) -> dict[str, Any]:
        """Look along ``"a"``/``"b"``/``"c"``, ``"x"``/``"y"``/``"z"`` or a lattice direction [u, v, w]
        (Cartesian with ``cartesian=True``), with ``up`` on screen and ``zoom``; give only what
        should change. Returns the camera as :meth:`get_state` reports it."""
        def vector(value: object, name: str) -> object:
            if isinstance(value, str):
                if value not in {"a", "b", "c", "x", "y", "z"}:
                    raise ValueError(f"{name} must be a, b, c, x, y, z or three finite numbers")
                return value
            if isinstance(value, bytes) or not isinstance(value, Sequence) or len(value) != 3 or any(
                    isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(v) for v in value):
                raise ValueError(f"{name} must be a, b, c, x, y, z or three finite numbers")
            return [float(v) for v in value]

        if not isinstance(cartesian, bool):
            raise TypeError("cartesian must be boolean")
        if zoom is not None and (isinstance(zoom, bool) or not isinstance(zoom, Real) or not math.isfinite(zoom) or zoom <= 0):
            raise ValueError("zoom must be a positive number")
        args: dict[str, object] = {}
        if direction is not None:
            args["direction"] = vector(direction, "direction")
        if up is not None:
            args["up"] = vector(up, "up")
        if zoom is not None:
            args["zoom"] = float(zoom)
        if not args:
            raise ValueError("give direction, up or zoom")
        if cartesian:
            args["cartesian"] = True
        result = self._command("set_view", args)
        if not isinstance(result, dict) or not isinstance(result.get("direction"), list):
            raise ViewerProtocolError("browser set_view result is invalid")
        return result

    def set_render_pipeline(self, pipeline_id: str) -> str:
        valid = {"depthpeel", "wboit", "forward", "raytrace", "pathtrace", "split-atoms", "sorted-atoms"}
        if not isinstance(pipeline_id, str) or pipeline_id not in valid:
            raise ValueError("unknown rendering pipeline")
        result = self._command("set_renderer", {"renderer": pipeline_id})
        if not isinstance(result, dict) or result.get("renderer") not in valid:
            raise ViewerProtocolError("browser returned an invalid active pipeline")
        return result["renderer"]

    def save_image(self, path: str | os.PathLike[str], *, width: int | None = None, height: int | None = None,
                   margin: int = 0, transparent: bool = False, structure_only: bool = False,
                   timeout: float | None = None, max_side: int | None = None) -> Path:
        """Render the current view to a PNG at ``path``.

        Without ``width``/``height`` the image is the view as the user sees it (its size and
        aspect); with one of them, the other follows the view's aspect. ``max_side`` scales such a
        default size down to fit.
        """
        for label, value in (("width", width), ("height", height)):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 16384):
                raise ValueError(f"{label} must be an integer from 1 through 16384")
        if max_side is not None and (isinstance(max_side, bool) or not isinstance(max_side, int) or not 16 <= max_side <= 16384):
            raise ValueError("max_side must be an integer from 16 through 16384")
        if isinstance(margin, bool) or not isinstance(margin, int) or not 0 <= margin <= 4096:
            raise ValueError("margin must be an integer from 0 through 4096")
        if (width is not None and margin * 2 >= width) or (height is not None and margin * 2 >= height):
            raise ValueError("margin must be smaller than half of each dimension")
        if not isinstance(transparent, bool):
            raise TypeError("transparent must be boolean")
        if not isinstance(structure_only, bool):
            raise TypeError("structure_only must be boolean")
        if timeout is not None:
            try:
                valid_timeout = (not isinstance(timeout, bool) and isinstance(timeout, (int, float))
                                 and math.isfinite(float(timeout)) and timeout > 0)
            except OverflowError:
                valid_timeout = False
            if not valid_timeout:
                raise ValueError("timeout must be a positive finite number")
        target = Path(path)
        args: dict[str, object] = {"margin": margin, "transparent": transparent, "structureOnly": structure_only}
        for key, value in (("width", width), ("height", height), ("maxSide", max_side)):
            if value is not None:
                args[key] = value
        result, received = self._command("save_image", args, timeout=timeout, include_attachments=True)
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

    def export_structure(self, path: str | os.PathLike[str], *, format: str, frames: str | Sequence[int] | None = None,
                         structure: str | None = None, frame: int | None = None) -> dict[str, Any]:
        """Write a structure file at ``path``: ``"cif"`` or ``"poscar"`` (one frame, as the Save
        window does) or ``"extxyz"`` (``frames``: ``"all"``, the default, or frame indices).
        ``structure`` and ``frame`` pick a row and frame other than the one on show.

        Returns the browser's result: ``atomCount`` (atoms in the file), ``frames``,
        ``sameOrder`` and, when a POSCAR reorders atoms, ``order`` (file atom ``k`` is CrysViz
        atom ``order[k]``), plus ``warning`` when POSCAR drops partial occupancy.
        """
        if format not in {"cif", "poscar", "extxyz"}:
            raise ValueError("format must be cif, poscar or extxyz")
        args: dict[str, object] = {"format": format}
        if frames is not None:
            if frames != "all" and (isinstance(frames, (str, bytes)) or not isinstance(frames, Sequence)):
                raise ValueError('frames must be "all" or a sequence of frame indices')
            args["frames"] = frames if frames == "all" else list(frames)
        if structure is not None:
            args["structure"] = structure
        if frame is not None:
            args["frame"] = frame
        return self._write_text_output("export_structure", args, path)

    def _write_text_output(self, command: str, args: dict[str, object], path: str | os.PathLike[str]) -> dict[str, Any]:
        """Run a text-export command and write its text to ``path``; return the browser's result."""
        result, received = self._command(command, args, include_attachments=True)
        try:
            # The text arrives as an attachment (the host's managed upload), so size is not capped by IPC.
            if not isinstance(result, dict) or result.get("attachment") != "text" or set(received) != {"text"}:
                raise ViewerProtocolError(f"browser {command} response is missing its text attachment")
            Path(path).write_bytes(received["text"].read())
        finally:
            for attachment in received.values():
                attachment.close()
        return result

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
