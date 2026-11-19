from __future__ import annotations

import io
import unittest
from unittest import mock

from crysviz._protocol import ProtocolError
from crysviz._host import HostRuntime, _BridgeAPI


class BridgeSurfaceTests(unittest.TestCase):
    def test_pywebview_api_exposes_exactly_its_five_callbacks(self):
        api = _BridgeAPI(mock.Mock())
        public_callables = {
            name for name in dir(api)
            if not name.startswith("_") and callable(getattr(api, name))
        }
        self.assertEqual(public_callables, {"receive_event", "next_command", "command_result",
                                            "reserve_download", "download_done"})

    def test_app_downloads_go_to_python_only_when_captured_and_authorized(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server = mock.Mock(bridge_capability="cap")
        runtime.server.reserve_output.return_value = "http://127.0.0.1:1/_crysviz/output/" + "b" * 32
        runtime.origin_ok = lambda: True
        # Not captured (no Viewer download_dir): the window downloads it itself.
        self.assertIsNone(runtime._reserve_download("cap", "a.png", "image/png"))
        runtime.capture_downloads = True
        self.assertIsNone(runtime._reserve_download("wrong", "a.png", "image/png"))
        self.assertIsNone(runtime._reserve_download("cap", "", "image/png"))
        self.assertIsNone(runtime._reserve_download("cap", "a.png", "image/png\r\nX-Evil: 1"))
        url = runtime._reserve_download("cap", "a.svg", "image/svg+xml;charset=utf-8")
        runtime.server.reserve_output.assert_called_once_with("image/svg+xml;charset=utf-8")
        output = io.BytesIO(b"<svg/>")
        runtime.server.take_output.return_value = output
        runtime.send = mock.Mock()
        self.assertTrue(runtime._download_done("cap", url))
        message_type, payload, attachments = runtime.send.call_args.args
        self.assertEqual((message_type, payload["name"], payload["size"]), ("download", "a.svg", 6))
        self.assertIs(attachments["file"], output)
        self.assertFalse(runtime._download_done("cap", url))  # one use

    def test_save_image_svg_reserves_an_svg_upload(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server = mock.Mock()
        runtime.server.reserve_output.return_value = "http://127.0.0.1:1234/_crysviz/output/" + "c" * 32
        runtime._prepare_request("request", "save_image", {"format": "svg"}, {})
        runtime.server.reserve_output.assert_called_once_with("image/svg+xml")

    def test_bridge_authorization_requires_live_exact_loopback_origin(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server.start()
        try:
            capability = runtime.server.bridge_capability
            runtime._pending_descriptors.put({"id": "one", "request": {"command": "get_state"}})
            runtime.window = mock.Mock()
            runtime.window.get_current_url.side_effect = RuntimeError("unavailable")
            self.assertIsNone(runtime._bridge_api.next_command(capability))
            runtime.window.get_current_url.side_effect = None
            runtime.window.get_current_url.return_value = "https://example.invalid/"
            self.assertIsNone(runtime._bridge_api.next_command(capability))
            runtime.window.get_current_url.return_value = runtime.server.url
            self.assertEqual(runtime._bridge_api.next_command(capability)["id"], "one")
        finally:
            runtime.server.close()

    def test_managed_window_enables_web_storage(self):
        connection = mock.Mock()
        connection.recv_bytes.side_effect = EOFError
        webview = mock.MagicMock()
        webview.settings = {}
        settings_at_start = {}
        webview.start.side_effect = lambda **kwargs: settings_at_start.update(webview.settings)
        window = webview.create_window.return_value

        runtime = HostRuntime(connection, [], gui="qt", debug=True)
        runtime.server = mock.Mock(url="http://127.0.0.1:1234/index.html")
        with mock.patch.dict("sys.modules", {"webview": webview}):
            runtime.run()

        webview.create_window.assert_called_once_with(
            "CrysViz", runtime.server.url, width=1280, height=800,
            min_size=(640, 480), js_api=runtime._bridge_api,
        )
        webview.start.assert_called_once_with(debug=True, private_mode=False, gui="qt")
        self.assertEqual(settings_at_start["ALLOW_DOWNLOADS"], True)

    def test_save_image_preparation_reserves_private_output_and_discards_invalid_request(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server = mock.Mock()
        runtime.server.reserve_output.return_value = "http://127.0.0.1:1234/_crysviz/output/" + "a" * 32
        descriptor = runtime._prepare_request("request", "save_image", {"width": 320}, {})
        self.assertEqual(descriptor["request"]["args"]["outputUrl"], runtime.server.reserve_output.return_value)
        runtime.server.discard_output.assert_not_called()

        runtime._prepare_request("invalid", "save_image", None, {})
        runtime.server.discard_output.assert_called_once_with(runtime.server.reserve_output.return_value)

    def _load_runtime(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server = mock.Mock()
        runtime.server.publish.return_value = "http://127.0.0.1:1/_crysviz/input/x"
        return runtime

    def _attachment(self):
        return {"data": mock.Mock(stream=mock.Mock())}

    def test_DW_6_2_load_rewrite_carries_periodic(self):
        for value in (True, False):
            runtime = self._load_runtime()
            args = {"name": "a.cube", "format": None, "periodic": value}
            descriptor = runtime._prepare_request("r", "load", args, self._attachment())
            self.assertIs(descriptor["request"]["args"]["periodic"], value)
        runtime = self._load_runtime()
        descriptor = runtime._prepare_request("r", "load", {"name": "a.cube", "format": None}, self._attachment())
        self.assertNotIn("periodic", descriptor["request"]["args"])
        # An unknown format is left out (the browser detects it), never sent as null.
        self.assertNotIn("format", descriptor["request"]["args"])

    def test_DW_6_2_load_rewrite_rejects_non_boolean_periodic(self):
        for bad in ("false", 0, None):
            runtime = self._load_runtime()
            attachments = self._attachment()
            with self.assertRaises(ProtocolError):
                runtime._prepare_request("r", "load", {"name": "a", "format": None, "periodic": bad}, attachments)
            runtime.server.publish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
