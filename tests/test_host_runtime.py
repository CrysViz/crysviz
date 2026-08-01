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


if __name__ == "__main__":
    unittest.main()
