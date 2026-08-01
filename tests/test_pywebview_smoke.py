"""Opt-in real GUI smoke test, used by the Xvfb/Qt GitHub Actions job."""

from __future__ import annotations

import os
import unittest


@unittest.skipUnless(os.environ.get("CRYSVIZ_PYWEBVIEW_SMOKE") == "1", "GUI smoke is CI-only")
class PywebviewSmokeTests(unittest.TestCase):
    def test_managed_viewer_reaches_ready_and_closes(self):
        from crysviz import Viewer

        viewer = Viewer(startup_timeout=60, command_timeout=30)
        try:
            viewer.start()
            structures = viewer.list_structures()
            self.assertEqual(len(structures), 1)
            viewer.select(structures[0].id, frame=0)
            viewer.recenter_camera()
        finally:
            viewer.close()
