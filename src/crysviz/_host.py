"""Private pywebview process used by :class:`crysviz.Viewer`."""

from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
from multiprocessing.connection import Listener
from urllib.parse import urlsplit

from ._protocol import Attachment, ProtocolError, recv_frame, send_frame
from ._server import CrysVizServer
from ._sources import PreparedSource
from ._windowing import create_native_window

_FIXED_TRIGGER = "window.crysvizHost.processBridgeCommand()"


def _prepared_sources(payload: object, attachments: dict[str, Attachment]) -> list[PreparedSource]:
    if not isinstance(payload, dict) or set(payload) != {"sources"} or not isinstance(payload["sources"], list):
        raise ProtocolError("bootstrap has an invalid schema")
    sources: list[PreparedSource] = []
    used: set[str] = set()
    try:
        for item in payload["sources"]:
            if not isinstance(item, dict) or set(item) != {"attachment", "name", "format", "binary"}:
                raise ProtocolError("bootstrap source has an invalid schema")
            name, format_name, binary, attachment_name = item["name"], item["format"], item["binary"], item["attachment"]
            if (not isinstance(name, str) or not isinstance(attachment_name, str) or attachment_name in used
                    or (format_name is not None and not isinstance(format_name, str)) or not isinstance(binary, bool)):
                raise ProtocolError("bootstrap source fields are invalid")
            attachment = attachments.get(attachment_name)
            if attachment is None:
                raise ProtocolError("bootstrap source attachment is missing")
            used.add(attachment_name)
            sources.append(PreparedSource(name=name, format=format_name, binary=binary,
                                          stream=attachment.stream, spool=attachment.stream))
        if set(attachments) != used:
            raise ProtocolError("bootstrap has unreferenced attachments")
        return sources
    except BaseException:
        for source in sources:
            source.close()
        for attachment in attachments.values():
            if not attachment.stream.closed:
                attachment.close()
        raise


class _BridgeAPI:
    """The complete object exposed through pywebview's recursive JS bridge."""

    def __init__(self, runtime: "HostRuntime"):
        # pywebview ignores underscored attributes while discovering methods.
        self._runtime = runtime

    def receive_event(self, capability: object, record: object) -> None:
        return self._runtime._receive_event(capability, record)

    def next_command(self, capability: object) -> object:
        return self._runtime._next_command(capability)

    def command_result(self, capability: object, request_id: object, result: object) -> None:
        return self._runtime._command_result(capability, request_id, result)


class HostRuntime:
    def __init__(self, connection: object, sources: list[PreparedSource], *, gui: str | None = None,
                 debug: bool = False, hidden: bool = False):
        self.connection = connection
        self.gui, self.debug, self.hidden = gui, debug, hidden
        self.server = CrysVizServer(
            sources, bridge_capability=base64.urlsafe_b64encode(os.urandom(32)).decode("ascii"),
        )
        self.window = None
        self._send_lock = threading.Lock()
        self._browser_lock = threading.Lock()
        self._result_lock = threading.Lock()
        self._results: dict[str, queue.Queue[object]] = {}
        self._pending_descriptors: queue.Queue[dict[str, object]] = queue.Queue()
        self._commands: queue.Queue[tuple[dict[str, object], dict[str, Attachment]] | None] = queue.Queue()
        self._closing = threading.Event()
        self._bridge_api = _BridgeAPI(self)

    def send(self, message_type: str, payload: object, attachments: dict[str, object] | None = None) -> None:
        with self._send_lock:
            send_frame(self.connection, message_type, payload, attachments)

    def origin_ok(self) -> bool:
        if self.window is None:
            return False
        try:
            current = self.window.get_current_url()
        except Exception:
            return False
        expected, actual = urlsplit(self.server.url), urlsplit(str(current))
        return actual.scheme == expected.scheme and actual.hostname == "127.0.0.1" and actual.netloc == expected.netloc

    def _authorized(self, capability: object) -> bool:
        return capability == self.server.bridge_capability and self.origin_ok()

    def _receive_event(self, capability: object, record: object) -> None:
        if not self._authorized(capability):
            return None
        if not isinstance(record, dict) or set(record) - {"event", "data"} or not isinstance(record.get("event"), str):
            return None
        if record["event"] not in {"ready", "structure_loaded", "active_structure_changed", "error", "closed"}:
            return None
        self.send("event", {"event": record["event"], "data": record.get("data")})
        if record["event"] == "closed":
            self._closing.set()
        return None

    def _next_command(self, capability: object) -> object:
        if not self._authorized(capability):
            return None
        try:
            return self._pending_descriptors.get_nowait()
        except queue.Empty:
            return None

    def _command_result(self, capability: object, request_id: object, result: object) -> None:
        if not self._authorized(capability) or not isinstance(request_id, str):
            return None
        with self._result_lock:
            pending = self._results.get(request_id)
        if pending is not None:
            pending.put(result)
        return None

    def _prepare_request(self, request_id: str, command: str, args: object, attachments: dict[str, Attachment]) -> dict[str, object]:
        if command == "save_image":
            if attachments:
                raise ProtocolError("save_image accepts no attachment")
            output_url = self.server.reserve_output()
            if not isinstance(args, dict):
                self.server.discard_output(output_url)
                return {"id": request_id, "request": {"command": command, "args": args}}
            command_args = {**args, "outputUrl": output_url, "hidden": self.hidden}
            return {"id": request_id, "request": {"command": command, "args": command_args}}
        if command != "load":
            if attachments:
                raise ProtocolError("only load accepts an attachment")
            return {"id": request_id, "request": {"command": command, "args": args}}
        if set(attachments) != {"data"} or not isinstance(args, dict):
            raise ProtocolError("load requires exactly one data attachment")
        attachment = attachments["data"]
        source = PreparedSource(
            name=args.get("name"), format=args.get("format"), binary=args.get("binary"),
            stream=attachment.stream, spool=attachment.stream,
        )
        if not isinstance(source.name, str) or (source.format is not None and not isinstance(source.format, str)) or not isinstance(source.binary, bool):
            source.close()
            raise ProtocolError("load arguments are invalid")
        try:
            input_url = self.server.publish(source)
        except BaseException:
            source.close()
            raise
        # Remove the attachment only after the server has accepted ownership.
        attachments.pop("data")
        return {"id": request_id, "request": {"command": "load", "args": {
            "name": source.name, "format": source.format, "binary": source.binary, "inputUrl": input_url,
        }}}

    def reader_loop(self) -> None:
        """Read IPC continuously so parent EOF can interrupt a browser call."""
        try:
            while not self._closing.is_set():
                message_type, payload, attachments = recv_frame(self.connection)
                if message_type != "command" or not isinstance(payload, dict) or set(payload) != {"id", "command", "args"}:
                    for attachment in attachments.values():
                        attachment.close()
                    raise ProtocolError("host expected a command frame")
                request_id, command, args = payload["id"], payload["command"], payload["args"]
                if not isinstance(request_id, str) or not isinstance(command, str):
                    for attachment in attachments.values():
                        attachment.close()
                    raise ProtocolError("command has invalid fields")
                self._commands.put((payload, attachments))
        except (EOFError, OSError, ProtocolError):
            self._closing.set()
            self._commands.put(None)
            if self.window is not None:
                try:
                    self.window.destroy()
                except Exception:
                    pass

    def command_loop(self) -> None:
        """Serialize browser mutations received by :meth:`reader_loop`."""
        while True:
            delivery = self._commands.get()
            if delivery is None:
                return
            payload, attachments = delivery
            request_id, command, args = payload["id"], payload["command"], payload["args"]
            assert isinstance(request_id, str) and isinstance(command, str)
            descriptor = None
            try:
                try:
                    if command == "close":
                        if attachments:
                            raise ProtocolError("close has no attachments")
                        self._closing.set()
                        if self.window is not None:
                            self.window.destroy()
                        self.send("response", {"id": request_id, "ok": True, "result": True})
                        continue
                    descriptor = self._prepare_request(request_id, command, args, attachments)
                    result_queue: queue.Queue[object] = queue.Queue(maxsize=1)
                    with self._result_lock:
                        self._results[request_id] = result_queue
                    self._pending_descriptors.put(descriptor)
                    with self._browser_lock:
                        if self.window is None:
                            raise RuntimeError("browser window is not available")
                        self.window.run_js(_FIXED_TRIGGER)
                    result = result_queue.get()
                    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                        raise ProtocolError("browser result has an invalid schema")
                    response = {"id": request_id, **result}
                    output_url = descriptor["request"]["args"].get("outputUrl") if (
                        command == "save_image" and isinstance(descriptor.get("request"), dict)
                        and isinstance(descriptor["request"].get("args"), dict)
                    ) else None
                    output = self.server.take_output(output_url) if isinstance(output_url, str) and result.get("ok") else None
                    if command == "save_image" and result.get("ok"):
                        if output is None:
                            raise ProtocolError("PNG upload is missing")
                        try:
                            response["result"] = {
                                "contentType": "image/png", "size": output.seek(0, 2), "attachment": "image",
                            }
                            output.seek(0)
                            self.send("response", response, {"image": output})
                        finally:
                            output.close()
                    else:
                        self.send("response", response)
                except Exception as error:
                    if command == "save_image" and isinstance(locals().get("descriptor"), dict):
                        request_args = descriptor.get("request", {}).get("args", {})
                        if isinstance(request_args, dict) and isinstance(request_args.get("outputUrl"), str):
                            self.server.discard_output(request_args["outputUrl"])
                    self.send("response", {"id": request_id, "ok": False,
                                           "error": {"code": "HOST_COMMAND_FAILED", "message": str(error)}})
                finally:
                    if command == "save_image" and isinstance(locals().get("descriptor"), dict):
                        request_args = descriptor.get("request", {}).get("args", {})
                        if isinstance(request_args, dict) and isinstance(request_args.get("outputUrl"), str):
                            self.server.discard_output(request_args["outputUrl"])
                    with self._result_lock:
                        self._results.pop(request_id, None)
                    for attachment in attachments.values():
                        attachment.close()
            except (EOFError, OSError):
                self._closing.set()
                return

    def run(self) -> None:
        try:
            import webview
        except Exception as error:
            try:
                self.send("event", {"event": "error", "data": {
                    "code": "PYWEBVIEW_UNAVAILABLE",
                    "message": (
                        f"pywebview could not be imported: {error}. On Linux install the "
                        "crysviz[gtk] or crysviz[qt] backend and its system libraries; "
                        "the crysviz --browser CLI is the no-GUI fallback."
                    ),
                }})
                self.send("event", {"event": "closed", "data": None})
            finally:
                self.server.close()
            return
        self.server.start()
        reader: threading.Thread | None = None
        commands: threading.Thread | None = None
        try:
            self.window = create_native_window(
                webview, self.server.url, js_api=self._bridge_api, hidden=self.hidden,
            )
            self.window.events.closed += lambda: self._closing.set()
            reader = threading.Thread(target=self.reader_loop, name="crysviz-host-ipc", daemon=True)
            commands = threading.Thread(target=self.command_loop, name="crysviz-host-browser", daemon=True)
            reader.start()
            commands.start()
            # Match the command launcher: CrysViz requires localStorage, which
            # is unavailable in the private data store of some renderers.
            options = {"debug": self.debug, "private_mode": False}
            if self.gui is not None:
                options["gui"] = self.gui
            webview.start(**options)
        except Exception as error:
            try:
                self.send("event", {"event": "error", "data": {
                    "code": "PYWEBVIEW_START_FAILED",
                    "message": (
                        f"pywebview could not start its GUI backend: {error}. On Linux install "
                        "the crysviz[gtk] or crysviz[qt] backend and its system libraries; "
                        "the crysviz --browser CLI is the no-GUI fallback."
                    ),
                }})
            except Exception:
                pass
        finally:
            self._closing.set()
            try:
                self.send("event", {"event": "closed", "data": None})
            except Exception:
                pass
            try:
                self.connection.close()
            except OSError:
                pass
            self._commands.put(None)
            if reader is not None:
                reader.join(timeout=1)
            if commands is not None:
                commands.join(timeout=1)
            while True:
                try:
                    delivery = self._commands.get_nowait()
                except queue.Empty:
                    break
                if delivery is not None:
                    for attachment in delivery[1].values():
                        attachment.close()
            self.server.close()


def main() -> int:
    try:
        bootstrap = json.loads(sys.stdin.readline())
        secret = base64.b64decode(bootstrap["auth"], validate=True)
        gui, debug = bootstrap.get("gui"), bootstrap.get("debug", False)
        hidden = bootstrap.get("hidden", False)
        if (bootstrap.get("version") != 1 or len(secret) < 16
                or gui not in {None, "gtk", "qt", "cef"} or not isinstance(debug, bool)
                or not isinstance(hidden, bool)):
            raise ValueError
    except Exception:
        return 2
    listener = Listener(("127.0.0.1", 0), authkey=secret)
    try:
        address = listener.address
        print(json.dumps({"version": 1, "address": [address[0], address[1]]}), flush=True)
        connection = listener.accept()
        message_type, payload, attachments = recv_frame(connection)
        if message_type != "bootstrap":
            raise ProtocolError("first host frame must be bootstrap")
        sources = _prepared_sources(payload, attachments)
        HostRuntime(connection, sources, gui=gui, debug=debug, hidden=hidden).run()
    except (EOFError, OSError, ProtocolError):
        return 2
    finally:
        listener.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
