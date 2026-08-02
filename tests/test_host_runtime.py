from __future__ import annotations

import unittest
from unittest import mock

from crysviz._host import HostRuntime, _BridgeAPI


class BridgeSurfaceTests(unittest.TestCase):
    def test_pywebview_api_exposes_exactly_three_callbacks(self):
        api = _BridgeAPI(mock.Mock())
        public_callables = {
            name for name in dir(api)
            if not name.startswith("_") and callable(getattr(api, name))
        }
        self.assertEqual(public_callables, {"receive_event", "next_command", "command_result"})

    def test_bridge_authorization_requires_live_exact_loopback_origin(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server.start()
        try:
            capability = runtime.server.bridge_capability
            runtime._pending_descriptors.put({"id": "one", "request": {"command": "list_structures"}})
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
        window = webview.create_window.return_value

        runtime = HostRuntime(connection, [], gui="qt", debug=True)
        runtime.server = mock.Mock(url="http://127.0.0.1:1234/index.html")
        with mock.patch.dict("sys.modules", {"webview": webview}):
            runtime.run()

        webview.create_window.assert_called_once_with(
            "CrysViz", runtime.server.url, js_api=runtime._bridge_api,
        )
        webview.start.assert_called_once_with(debug=True, private_mode=False, gui="qt")

    def test_save_image_preparation_reserves_private_output_and_discards_invalid_request(self):
        runtime = HostRuntime(mock.Mock(), [])
        runtime.server = mock.Mock()
        runtime.server.reserve_output.return_value = "http://127.0.0.1:1234/_crysviz/output/" + "a" * 32
        descriptor = runtime._prepare_request("request", "save_image", {"width": 320}, {})
        self.assertEqual(descriptor["request"]["args"]["outputUrl"], runtime.server.reserve_output.return_value)
        runtime.server.discard_output.assert_not_called()

        runtime._prepare_request("invalid", "save_image", None, {})
        runtime.server.discard_output.assert_called_once_with(runtime.server.reserve_output.return_value)


if __name__ == "__main__":
    unittest.main()
