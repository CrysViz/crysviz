"""Opt-in real GUI smoke test, used by the Xvfb/Qt GitHub Actions job."""

from __future__ import annotations

import os
import tempfile
import unittest


@unittest.skipUnless(os.environ.get("CRYSVIZ_PYWEBVIEW_SMOKE") == "1", "GUI smoke is CI-only")
class PywebviewSmokeTests(unittest.TestCase):
    def test_managed_viewer_reaches_ready_and_closes(self):
        from crysviz import Viewer

        viewer = Viewer(startup_timeout=60, command_timeout=180, hidden=True)
        try:
            viewer.start()
            structures = viewer.list_structures()
            self.assertEqual(len(structures), 1)
            viewer.select(structures[0].id, frame=0)
            viewer.recenter_camera()
            self.assertEqual(viewer.set_render_pipeline("raytrace"), "raytrace")
            with tempfile.TemporaryDirectory() as directory:
                output = viewer.save_image(
                    os.path.join(directory, "smoke.png"), width=320, height=240, timeout=180,
                )
                with output.open("rb") as stream:
                    self.assertEqual(stream.read(8), b"\x89PNG\r\n\x1a\n")
                    self.assertGreater(os.fstat(stream.fileno()).st_size, 8)
        finally:
            viewer.close()
