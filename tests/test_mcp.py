"""crysviz-mcp tool layer with a fake viewer, plus the MCP protocol in-process when the SDK is installed."""

from __future__ import annotations

import base64
import json
import importlib.util
import tempfile
import unittest
from pathlib import Path

from crysviz import BrowserCommandError, LoadResult, StructureInfo
from crysviz._mcp import CrysVizTools, ToolError, command_spec

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


class _FakeViewer:
    instances: list["_FakeViewer"] = []

    def __init__(self):
        self.calls: list[tuple[str, object]] = []
        self.started = False

        class _Closed:
            def is_set(inner) -> bool:  # noqa: N805 - tiny stand-in for threading.Event
                return self.closed
        self.closed = False
        self._closed = _Closed()
        _FakeViewer.instances.append(self)

    def start(self):
        self.started = True
        return self

    def close(self):
        self.closed = True

    def call(self, name, **args):
        return self._command(name, args)

    def _command(self, name, args):
        self.calls.append((name, args))
        if name == "set_view" and args.get("direction") == "q":
            raise BrowserCommandError("INVALID_ARGS", "set_view.direction must be a, b, c, x, y, z or three finite numbers")
        return {"direction": [0, 0, 5]} if name == "set_view" else True

    def load(self, source, *, periodic=None, interactive=True):
        assert interactive is False, "MCP loads must never wait on a dialog"
        self.calls.append(("load", source))
        return LoadResult(StructureInfo("s1", getattr(source, "name", "x"), 1, True, 0))

    def export_structure(self, path, *, format):
        self.calls.append(("export_structure", format))
        Path(path).write_text("POSCAR text")
        return {"rows": 3, "order": [2, 0, 1] if format == "poscar" else None, "warning": None}

    def save_image(self, path, **options):
        self.calls.append(("save_image", options))
        Path(path).write_bytes(PNG)
        return Path(path)


class ToolLayerTests(unittest.TestCase):
    def setUp(self):
        _FakeViewer.instances.clear()
        self.scratch = tempfile.TemporaryDirectory()
        self.export = Path(self.scratch.name) / "exports"
        self.tools = CrysVizTools(export_dir=self.export, viewer_factory=_FakeViewer)

    def tearDown(self):
        self.scratch.cleanup()

    def test_every_registry_command_is_a_tool(self):
        names = {command["name"] for command in command_spec()["commands"]}
        self.assertEqual(set(self.tools.tools), names)
        self.assertEqual(self.tools.tools["list_structures"]["tier"], "read")

    def test_viewer_opens_lazily_and_reopens_after_close(self):
        self.assertEqual(_FakeViewer.instances, [])
        self.tools.call("recenter_camera", {})
        self.tools.call("recenter_camera", {})
        self.assertEqual(len(_FakeViewer.instances), 1)
        _FakeViewer.instances[0].closed = True
        self.tools.call("recenter_camera", {})
        self.assertEqual(len(_FakeViewer.instances), 2)

    def test_generic_command_passes_arguments_and_returns_json(self):
        content = self.tools.call("set_view", {"direction": "c"})
        self.assertEqual(_FakeViewer.instances[0].calls, [("set_view", {"direction": "c"})])
        self.assertEqual(content, [{"type": "text", "text": '{"direction": [0, 0, 5]}'}])

    def test_browser_error_becomes_tool_error(self):
        with self.assertRaisesRegex(ToolError, "INVALID_ARGS"):
            self.tools.call("set_view", {"direction": "q"})

    def test_load_takes_path_or_text(self):
        cif = Path(self.scratch.name) / "si.cif"
        cif.write_text("data_si\n")
        self.assertIn('"id": "s1"', self.tools.call("load", {"path": str(cif)})[0]["text"])
        self.tools.call("load", {"text": "Si\n1.0\n", "name": "si.vasp"})
        with self.assertRaisesRegex(ToolError, "exactly one"):
            self.tools.call("load", {})
        with self.assertRaisesRegex(ToolError, "needs a name"):
            self.tools.call("load", {"text": "x"})
        with self.assertRaisesRegex(ToolError, "no such file"):
            self.tools.call("load", {"path": str(cif) + ".missing"})

    def test_save_image_returns_png_and_saves_only_into_export_folder(self):
        content = self.tools.call("save_image", {"width": 400, "height": 300})
        self.assertEqual(content[0]["mimeType"], "image/png")
        self.assertEqual(base64.b64decode(content[0]["data"]), PNG)
        self.assertFalse(self.export.exists())
        content = self.tools.call("save_image", {"filename": "view-c"})
        self.assertEqual((self.export / "view-c.png").read_bytes(), PNG)
        self.assertIn("view-c.png", content[1]["text"])
        for bad in ("../x.png", "a/b.png", ".hidden", ""):
            with self.assertRaises(ToolError, msg=bad):
                self.tools.call("save_image", {"filename": bad})
        with self.assertRaises(ToolError):
            self.tools.call("save_image", {"width": 100000})

    def test_save_image_defaults_to_the_view_and_saves_large_figures_without_returning(self):
        # No size: the view as the user framed it, capped for the returned picture.
        self.tools.call("save_image", {})
        options = _FakeViewer.instances[0].calls[-1][1]
        self.assertEqual((options["width"], options["height"], options["max_side"]), (None, None, 2048))
        # A returned picture is capped; a saved-only one may be big.
        with self.assertRaises(ToolError):
            self.tools.call("save_image", {"width": 3000, "height": 2000})
        with self.assertRaisesRegex(ToolError, "filename"):
            self.tools.call("save_image", {"width": 3000, "height": 2000, "returnImage": False})
        content = self.tools.call("save_image", {"width": 3000, "height": 2000, "returnImage": False, "filename": "fig2"})
        self.assertEqual([item["type"] for item in content], ["text"])
        self.assertEqual((self.export / "fig2.png").read_bytes(), PNG)
        options = _FakeViewer.instances[0].calls[-1][1]
        self.assertEqual((options["width"], options["height"], options["max_side"]), (3000, 2000, None))

    def test_export_structure_writes_into_export_folder_with_order_file(self):
        out = json.loads(self.tools.call("export_structure", {"format": "poscar", "filename": "graphite"})[0]["text"])
        target = self.export / "graphite.vasp"
        self.assertEqual(Path(out["path"]), target.resolve())
        self.assertEqual(target.read_text(), "POSCAR text")
        self.assertFalse(out["sameOrder"])
        self.assertEqual(json.loads(Path(out["orderFile"]).read_text()), [2, 0, 1])
        cif = json.loads(self.tools.call("export_structure", {"format": "cif"})[0]["text"])
        self.assertTrue(cif["sameOrder"])
        self.assertTrue(cif["path"].endswith("structure.cif"))
        with self.assertRaises(ToolError):
            self.tools.call("export_structure", {"format": "poscar", "filename": "../x"})
        with self.assertRaises(ToolError):
            self.tools.call("export_structure", {"format": "xyz"})

    def test_unknown_tool(self):
        with self.assertRaises(ToolError):
            self.tools.call("evaluate", {"code": "1"})


@unittest.skipUnless(importlib.util.find_spec("mcp"), "MCP SDK not installed (pip install 'crysviz[mcp]')")
class McpProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_and_call_tools_in_process(self):
        from mcp import Client

        from crysviz._mcp import build_server

        with tempfile.TemporaryDirectory() as scratch:
            tools = CrysVizTools(export_dir=Path(scratch), viewer_factory=_FakeViewer)
            async with Client(build_server(tools)) as client:
                listed = await client.list_tools()
                by_name = {tool.name: tool for tool in listed.tools}
                self.assertIn("set_view", by_name)
                self.assertTrue(by_name["list_structures"].annotations.read_only_hint)
                self.assertFalse(by_name["set_view"].annotations.read_only_hint)
                image = await client.call_tool("save_image", {})
                self.assertFalse(image.is_error)
                self.assertEqual(image.content[0].type, "image")
                failed = await client.call_tool("set_view", {"direction": "q"})
                self.assertTrue(failed.is_error)


if __name__ == "__main__":
    unittest.main()
