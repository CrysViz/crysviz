from __future__ import annotations

import queue
import pathlib
import threading
import tempfile
import unittest
from unittest import mock

from crysviz import (
    Payload,
    Viewer,
    ViewerClosedError,
    ViewerCommandTimeout,
    ViewerProtocolError,
    ViewerReentrancyError,
    ViewerStartupError,
)
from crysviz._protocol import recv_frame, send_frame


class _Connection:
    def __init__(self):
        self.incoming: queue.Queue[bytes | None] = queue.Queue()
        self.peer: _Connection | None = None

    def send_bytes(self, value: bytes) -> None:
        assert self.peer is not None
        self.peer.incoming.put(bytes(value))

    def recv_bytes(self, maxlength: int | None = None) -> bytes:
        value = self.incoming.get(timeout=3)
        if value is None:
            raise EOFError
        if maxlength is not None and len(value) > maxlength:
            raise OSError("frame too large")
        return value

    def close(self) -> None:
        if self.peer is not None:
            self.peer.incoming.put(None)


def _pair() -> tuple[_Connection, _Connection]:
    left, right = _Connection(), _Connection()
    left.peer, right.peer = right, left
    return left, right


class _Host:
    def __init__(self, connection: _Connection, *, crash_command: str | None = None, ignore_command: str | None = None,
                 response_mode: str | None = None):
        self.connection = connection
        self.crash_command, self.ignore_command = crash_command, ignore_command
        self.response_mode = response_mode
        self.bootstrap: tuple[object, dict[str, object]] | None = None
        self.commands: list[tuple[str, object, dict[str, bytes]]] = []
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def run(self) -> None:
        message_type, payload, attachments = recv_frame(self.connection)
        self.bootstrap = (payload, {name: attachment.read() for name, attachment in attachments.items()})
        for attachment in attachments.values():
            attachment.close()
        assert message_type == "bootstrap"
        send_frame(self.connection, "event", {"event": "ready", "data": {"protocolVersion": 1}})
        while True:
            try:
                message_type, payload, attachments = recv_frame(self.connection)
            except EOFError:
                return
            assert message_type == "command"
            assert isinstance(payload, dict)
            command, request_id = payload["command"], payload["id"]
            data = {name: attachment.read() for name, attachment in attachments.items()}
            for attachment in attachments.values():
                attachment.close()
            self.commands.append((command, payload["args"], data))
            if command == self.crash_command:
                self.connection.close()
                return
            if command == self.ignore_command:
                continue
            result: object = True
            if command == "list_structures":
                result = [{"id": "structure-1", "name": "a.cif", "frames": 2, "active": True, "activeFrame": 0}]
            elif command == "load":
                result = {"id": "structure-2", "name": payload["args"]["name"], "frames": 1, "active": True, "activeFrame": 0}
            elif command == "update_fractional_positions":
                result = {"atomCount": 2, "fastPathApplied": False, "rebuilt": True, "fallbackReason": "FAST_PATH_UNAVAILABLE"}
            elif command == "set_render_pipeline":
                result = "raytrace"
            if command == "save_image":
                png = b"\x89PNG\r\n\x1a\nmanaged-png"
                if self.response_mode == "bad_signature":
                    png = b"not-a-png"
                metadata = {"contentType": "image/png", "size": len(png), "attachment": "image"}
                if self.response_mode == "bad_metadata":
                    metadata["contentType"] = "image/jpeg"
                if self.response_mode == "bad_size":
                    metadata["size"] += 1
                attachments = {} if self.response_mode == "missing" else {"image": png}
                send_frame(self.connection, "response", {
                    "id": request_id, "ok": True,
                    "result": metadata,
                }, attachments)
            elif self.response_mode == "unexpected" and command == "list_structures":
                send_frame(self.connection, "response", {"id": request_id, "ok": True, "result": result}, {"extra": b"unexpected"})
            else:
                send_frame(self.connection, "response", {"id": request_id, "ok": True, "result": result})
            if command == "close":
                return


class ViewerControllerTests(unittest.TestCase):
    def start_fake(self, viewer: Viewer, host: _Host) -> Viewer:
        # The host owns the peer end; bootstrap is deliberately sent before
        # the parent reader/event worker is started, matching the real child.
        def launch() -> None:
            viewer._connection = host.connection.peer
            assert viewer._connection is not None
            sources = viewer._sources
            descriptors, attachments = [], {}
            for index, source in enumerate(sources):
                assert isinstance(source, Payload)
                name = f"source-{index}"
                descriptors.append({"attachment": name, "name": source.name, "format": source.format, "binary": source.format == "traj"})
                attachments[name] = source.data.encode() if isinstance(source.data, str) else source.data
            send_frame(viewer._connection, "bootstrap", {"sources": descriptors}, attachments)
        viewer._launch = launch  # type: ignore[method-assign]
        host.start()
        return viewer.start()

    def test_ordered_bootstrap_binary_and_typed_command_results(self):
        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer([Payload("a.cif", "text"), Payload("b.traj", b"\x00\xff", "traj")]), host)
        try:
            assert host.bootstrap is not None
            bootstrap, attachments = host.bootstrap
            self.assertEqual([item["name"] for item in bootstrap["sources"]], ["a.cif", "b.traj"])
            self.assertEqual(attachments, {"source-0": b"text", "source-1": b"\x00\xff"})
            structures = viewer.list_structures()
            self.assertEqual(structures[0].id, "structure-1")
            loaded = viewer.load(Payload("later.cif", b"later"))
            self.assertEqual(loaded.structure.id, "structure-2")
            viewer.select("structure-1", frame=0)
            update = viewer.update_fractional_positions([[0, 0, 0], [0.5, 0.5, 0.5]], commit=False)
            self.assertEqual((update.atom_count, update.fast_path_applied, update.rebuilt), (2, False, True))
            viewer.commit_positions()
            viewer.recenter_camera()
            self.assertEqual(next(data for command, _, data in host.commands if command == "load"), {"data": b"later"})
        finally:
            viewer.close()

    def test_concurrent_commands_are_demultiplexed(self):
        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer(), host)
        results: list[str] = []
        threads = [threading.Thread(target=lambda: results.append(viewer.list_structures()[0].id)) for _ in range(8)]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=2)
            self.assertEqual(results, ["structure-1"] * 8)
            self.assertEqual(sum(command == "list_structures" for command, _, _ in host.commands), 8)
        finally:
            viewer.close()

    def test_callback_command_close_and_wait_reentrancy(self):
        client, server = _pair()
        host = _Host(server)
        viewer = Viewer()
        observed: list[str] = []
        done = threading.Event()
        def ready(event):
            observed.append(viewer.list_structures()[0].id)
            with self.assertRaises(ViewerReentrancyError):
                viewer.wait(0.01)
            viewer.close()
            done.set()
        viewer.on("ready", ready)
        self.start_fake(viewer, host)
        self.assertTrue(done.wait(2))
        self.assertEqual(observed, ["structure-1"])

    def test_timeout_poisoning_and_eof_fail_pending_with_typed_errors(self):
        client, server = _pair()
        viewer = self.start_fake(Viewer(command_timeout=0.05), _Host(server, ignore_command="recenter_camera"))
        with self.assertRaises(ViewerCommandTimeout):
            viewer.recenter_camera()
        with self.assertRaises(ViewerClosedError):
            viewer.list_structures()

        client, server = _pair()
        viewer = self.start_fake(Viewer(), _Host(server, crash_command="list_structures"))
        with self.assertRaises(ViewerProtocolError):
            viewer.list_structures()

    def test_native_host_crash_preserves_stderr_diagnostic(self):
        connection = _Connection()
        connection.incoming.put(None)
        viewer = Viewer()
        viewer._connection = connection
        process = mock.Mock()
        process.poll.return_value = 1
        viewer._process = process
        viewer._host_stderr = "Qt platform plugin failed"

        viewer._reader_loop()

        self.assertIsInstance(viewer._close_error, ViewerProtocolError)
        self.assertIn("Qt platform plugin failed", str(viewer._close_error))
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_close_during_startup_and_late_replay_target_only_new_callback(self):
        client, server = _pair()
        viewer = Viewer(startup_timeout=0.5)
        def launch() -> None:
            viewer._connection = client
            send_frame(client, "bootstrap", {"sources": []})
            send_frame(server, "event", {"event": "closed", "data": None})
        viewer._launch = launch  # type: ignore[method-assign]
        with self.assertRaises(ViewerStartupError):
            viewer.start()

        client, server = _pair()
        viewer = Viewer(startup_timeout=0.5)
        def failed_backend_launch() -> None:
            viewer._connection = client
            send_frame(client, "bootstrap", {"sources": []})
            send_frame(server, "event", {"event": "error", "data": {
                "code": "PYWEBVIEW_START_FAILED", "message": "install a GUI backend",
            }})
            send_frame(server, "event", {"event": "closed", "data": None})
        viewer._launch = failed_backend_launch  # type: ignore[method-assign]
        with self.assertRaisesRegex(ViewerStartupError, "install a GUI backend"):
            viewer.start()

        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer(), host)
        first, second, replayed = [], [], threading.Event()
        viewer.on("ready", lambda event: (first.append(event.name), replayed.set()))
        self.assertTrue(replayed.wait(1))
        replayed.clear()
        viewer.on("ready", lambda event: (second.append(event.name), replayed.set()))
        self.assertTrue(replayed.wait(1))
        self.assertEqual(first, ["ready"])
        self.assertEqual(second, ["ready"])
        viewer.close()
        closed, delivered = [], threading.Event()
        viewer.on("closed", lambda event: (closed.append(event.name), delivered.set()))
        self.assertTrue(delivered.wait(1))
        self.assertEqual(closed, ["closed"])

    def test_callback_failure_closes_viewer(self):
        client, server = _pair()
        host = _Host(server)
        viewer = Viewer()
        viewer.on("ready", lambda event: (_ for _ in ()).throw(RuntimeError("boom")))
        self.start_fake(viewer, host)
        self.assertTrue(viewer._closed.wait(2))

        client, server = _pair()
        host = _Host(server)
        viewer = Viewer()
        viewer.on("ready", lambda event: (_ for _ in ()).throw(SystemExit("stop")))
        self.start_fake(viewer, host)
        self.assertTrue(viewer._closed.wait(2))

    def test_startup_os_error_is_typed(self):
        viewer = Viewer()
        with mock.patch.object(viewer, "_launch", side_effect=OSError("cannot spawn")):
            with self.assertRaisesRegex(ViewerStartupError, "cannot spawn"):
                viewer.start()

    def test_controller_validation_and_png_attachment_round_trip(self):
        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer(), host)
        try:
            with self.assertRaises(TypeError):
                viewer.rotate_camera(True)
            with self.assertRaises(ValueError):
                viewer.rotate_camera(float("inf"))
            with self.assertRaises(ValueError):
                viewer.rotate_camera(1, axis="q")
            with self.assertRaises(ValueError):
                viewer.set_render_pipeline("fallback")
            with tempfile.TemporaryDirectory() as directory:
                target = pathlib.Path(directory) / "image.png"
                with mock.patch.object(viewer, "_command", wraps=viewer._command) as command:
                    self.assertEqual(viewer.save_image(target, timeout=4.5), target)
                    self.assertEqual(command.call_args.kwargs["timeout"], 4.5)
                self.assertEqual(target.read_bytes(), b"\x89PNG\r\n\x1a\nmanaged-png")
            self.assertEqual(host.commands[-1][0], "save_image")
        finally:
            viewer.close()

    def test_png_write_failure_preserves_existing_target_and_removes_temp(self):
        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer(), host)
        try:
            with tempfile.TemporaryDirectory() as directory:
                target = pathlib.Path(directory) / "image.png"
                target.write_bytes(b"sentinel")
                with mock.patch("crysviz._viewer.shutil.copyfileobj", side_effect=OSError("write failed")):
                    with self.assertRaises(OSError):
                        viewer.save_image(target)
                self.assertEqual(target.read_bytes(), b"sentinel")
                self.assertEqual(list(pathlib.Path(directory).iterdir()), [target])
        finally:
            viewer.close()

    def test_camera_and_pipeline_commands_forward_args_and_results(self):
        client, server = _pair()
        host = _Host(server)
        viewer = self.start_fake(Viewer(), host)
        try:
            self.assertIsNone(viewer.rotate_camera(12.5, axis="z"))
            self.assertEqual(viewer.set_render_pipeline("raytrace"), "raytrace")
            self.assertEqual(host.commands[-2][0], "rotate_camera")
            self.assertEqual(host.commands[-2][1], {"angleDegrees": 12.5, "axis": "z"})
            self.assertEqual(host.commands[-1][1], {"pipelineId": "raytrace"})
        finally:
            viewer.close()

    def test_png_missing_unexpected_and_malformed_responses_close_or_reject(self):
        for mode, command in (("missing", "save"), ("bad_metadata", "save"), ("bad_size", "save"),
                              ("bad_signature", "save"), ("unexpected", "normal")):
            with self.subTest(mode=mode):
                client, server = _pair()
                host = _Host(server, response_mode=mode)
                viewer = self.start_fake(Viewer(), host)
                try:
                    with tempfile.TemporaryDirectory() as directory:
                        if command == "save":
                            with self.assertRaises(ViewerProtocolError):
                                viewer.save_image(pathlib.Path(directory) / "bad.png")
                        else:
                            with self.assertRaises(ViewerProtocolError):
                                viewer.list_structures()
                finally:
                    viewer.close()
