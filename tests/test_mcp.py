"""crysviz-mcp tool layer with a fake viewer, plus the MCP protocol in-process when the SDK is installed."""

from __future__ import annotations

import base64
import json
import importlib.util
import tempfile
import unittest
from pathlib import Path

from crysviz import BrowserCommandError, CommandRefused, LoadResult, StructureInfo
from crysviz._mcp import CrysVizTools, ToolError, command_spec

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


class _FakeViewer:
    instances: list["_FakeViewer"] = []
    pipeline = "forward"

    def __init__(self):
        self.calls: list[tuple[str, object]] = []
        self.started = False

        class _Closed:
            def is_set(inner) -> bool:  # noqa: N805 - tiny stand-in for threading.Event
                return self.closed
        self.closed = False
        self.fail_next = None
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
        if self.fail_next is not None:
            error, self.fail_next = self.fail_next, None
            raise error
        if name == "set_view" and args.get("direction") == "q":
            raise BrowserCommandError("INVALID_ARGS", "set_view.direction must be a, b, c, x, y, z or three finite numbers")
        if name == "get_state":
            return {"structure": None, "renderer": _FakeViewer.pipeline}
        return {"direction": [0, 0, 5]} if name == "set_view" else {"ok": True}

    def load(self, source, *, periodic=None, interactive=True):
        assert interactive is False, "MCP loads must never wait on a dialog"
        self.calls.append(("load", source))
        details = {"structure": "s1", "name": getattr(source, "name", "x"), "frames": 1, "activeFrame": 0,
                   "atomCount": 2, "revision": "r1", "formula": "Si2"}
        return LoadResult(StructureInfo("s1", details["name"], 1, True, 0), details)

    def take_user_changes(self, *, check=True):
        changes, self.user_changes = getattr(self, "user_changes", []), []
        return changes

    def export_structure(self, path, *, format, frames=None, structure=None, frame=None):
        self.calls.append(("export_structure", {"format": format, "frames": frames, "structure": structure, "frame": frame}))
        if self.fail_next is not None:
            error, self.fail_next = self.fail_next, None
            raise error
        if format == "extxyz":
            Path(path).write_text("1\nLattice=\"1 0 0 0 1 0 0 0 1\" Properties=species:S:1:pos:R:3\nH 0 0 0\n")
            return {"format": format, "structure": "s1", "name": "md", "frames": 1, "atomCount": 1, "sameOrder": True,
                    "attachment": "text"}
        Path(path).write_text("POSCAR text")
        result = {"format": format, "structure": "s1", "name": "x", "frames": 1, "atomCount": 3,
                  "sameOrder": format != "poscar", "attachment": "text"}
        if format == "poscar":
            result["order"] = [2, 0, 1]
        return result

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
        names = {command["name"] for command in command_spec()["commands"] if command.get("mcp") is not False}
        self.assertEqual(set(self.tools.tools), names)
        self.assertNotIn("update_fractional_positions", self.tools.tools, "Python-only commands stay off MCP")
        self.assertEqual(self.tools.tools["get_state"]["tier"], "read")

    def test_viewer_opens_lazily_and_reopens_after_close(self):
        self.assertEqual(_FakeViewer.instances, [])
        self.tools.call("set_view", {"recenter": True})
        self.tools.call("set_view", {"recenter": True})
        self.assertEqual(len(_FakeViewer.instances), 1)
        _FakeViewer.instances[0].closed = True
        self.tools.call("set_view", {"recenter": True})
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
        loaded = json.loads(self.tools.call("load", {"path": str(cif)})[0]["text"])
        self.assertEqual((loaded["structure"], loaded["atomCount"], loaded["revision"]), ("s1", 2, "r1"))
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

    def test_export_structure_extxyz_writes_frames_into_export_folder(self):
        out = json.loads(self.tools.call("export_structure", {"format": "extxyz", "filename": "md-run", "frames": "all",
                                                              "structure": "s1"})[0]["text"])
        self.assertEqual(Path(out["path"]), (self.export / "md-run.extxyz").resolve())
        self.assertTrue(Path(out["path"]).read_text().startswith("1\n"))
        self.assertEqual((out["frames"], out["atomCount"], out["sameOrder"]), (1, 1, True))
        self.assertNotIn("attachment", out)
        self.assertEqual(_FakeViewer.instances[0].calls[-1][1], {"format": "extxyz", "frames": "all", "structure": "s1", "frame": None})
        with self.assertRaises(ToolError):
            self.tools.call("export_structure", {"format": "extxyz", "filename": "../x"})

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

    def test_expected_revision_listed_on_index_addressed_tools_only(self):
        guarded = {c["name"] for c in command_spec()["commands"] if c.get("guard")}
        self.assertEqual(guarded, {"add_atoms", "remove_atoms", "set_element", "move_atoms", "apply", "set_lattice",
                                   "update_fractional_positions", "set_supercell"})
        for name, tool in self.tools.tools.items():
            listed = "expectedRevision" in tool["schema"].get("properties", {})
            self.assertEqual(listed, name in guarded, name)
        self.assertTrue(self.tools.tools["remove_atoms"]["destructive"])
        self.assertFalse(self.tools.tools["set_view"]["destructive"])

    def test_transparent_with_a_tracer_warns(self):
        try:
            _FakeViewer.pipeline = "raytrace"
            content = self.tools.call("save_image", {"transparent": True})
            self.assertIn("not supported by the raytrace renderer", content[-1]["text"])
            _FakeViewer.pipeline = "forward"
            content = self.tools.call("save_image", {"transparent": True})
            self.assertEqual([c["type"] for c in content], ["image"])
        finally:
            _FakeViewer.pipeline = "forward"

    def test_missing_required_argument_is_named(self):
        with self.assertRaises(ToolError) as caught:
            self.tools.call("find", {})
        self.assertEqual(str(caught.exception),
                         "INVALID_ARGS: find needs: what (atoms | bonds | polyhedra | voids); optional: where, limit, fields, groupBy")
        with self.assertRaisesRegex(ToolError, r"^INVALID_ARGS: set_control needs: ref \(string\); "
                                               r"value \(boolean \| number \| string\)$"):
            self.tools.call("set_control", {"ref": "x"})
        with self.assertRaisesRegex(ToolError, r"^INVALID_ARGS: select_structure needs: structure \(string\); optional: frame$"):
            self.tools.call("select_structure", None)
        self.assertEqual(_FakeViewer.instances, [], "a missing argument never reaches the viewer")

    def test_unknown_arguments_are_refused_not_ignored(self):
        # A misplaced filter ("element" at the top, or under where for bonds) used to be dropped,
        # answering a different question than the one asked.
        with self.assertRaisesRegex(ToolError, r"^INVALID_ARGS: find does not take element\. find needs: what"):
            self.tools.call("find", {"what": "atoms", "element": "O"})
        with self.assertRaisesRegex(ToolError, r"find does not take where\.colour"):
            self.tools.call("find", {"what": "atoms", "where": {"colour": "red"}})
        with self.assertRaisesRegex(ToolError, r"find does not take where\.near\.radius"):
            self.tools.call("find", {"what": "atoms", "where": {"near": {"atom": 0, "within": 1, "radius": 2}}})
        with self.assertRaisesRegex(ToolError, r"save_image does not take size"):
            self.tools.call("save_image", {"size": 400})
        self.assertEqual(_FakeViewer.instances, [], "a refused call never reaches the viewer")

    def test_browser_error_details_reach_the_model(self):
        content = self.tools.call("get_state", {})  # starts the fake viewer
        self.assertTrue(content)
        _FakeViewer.instances[0].fail_next = BrowserCommandError("INVALID_ARGS", "bad", {"field": "where", "atomCount": 9})
        with self.assertRaisesRegex(ToolError, r'INVALID_ARGS: bad \{"field": "where", "atomCount": 9\}'):
            self.tools.call("get_state", {})

    def test_a_refusal_is_a_result_not_a_failed_tool(self):
        self.tools.call("get_state", {})
        viewer = _FakeViewer.instances[0]
        viewer.fail_next = CommandRefused("NO_ACTIVE_STRUCTURE", "No active structure", {"atomCount": 0})
        content = self.tools.call("export_structure", {"format": "cif"})
        self.assertEqual(json.loads(content[0]["text"]),
                         {"applied": False, "reason": "No active structure", "code": "NO_ACTIVE_STRUCTURE", "atomCount": 0})

    def test_user_changes_reach_the_hand_written_tools(self):
        self.tools.call("get_state", {})
        viewer = _FakeViewer.instances[0]
        viewer.user_changes = [{"note": "Changed in the window since your last call (not by you): the camera moved."}]
        content = self.tools.call("export_structure", {"format": "cif"})
        self.assertEqual(json.loads(content[0]["text"])["sinceLastCall"]["note"][:7], "Changed")
        self.assertEqual(viewer.user_changes, [], "the note is taken once")

    def test_viewer_call_marks_writes_applied_and_returns_refusals(self):
        from crysviz import Viewer
        viewer = Viewer()
        replies = iter([{"revision": "r2", "atomCount": 3},
                        {"applied": False, "reason": "atoms moved", "code": "STRUCTURE_CHANGED"},
                        {"structure": None}])
        viewer._command = lambda command, args=None, **options: next(replies)  # type: ignore[method-assign]
        self.assertEqual(viewer.call("set_element", atoms=[0], element="C"), {"applied": True, "revision": "r2", "atomCount": 3})
        self.assertEqual(viewer.call("set_element", atoms=[0], element="C")["applied"], False)
        self.assertNotIn("applied", viewer.call("get_state"), "reads do not say applied")
        self.assertTrue(issubclass(CommandRefused, BrowserCommandError), "existing except clauses still catch it")

    def test_mcp_commands_get_a_long_timeout(self):
        from crysviz import _mcp
        self.assertGreaterEqual(_mcp.MCP_COMMAND_TIMEOUT, 120)

    def test_save_image_gets_a_long_timeout(self):
        # A slow (large or ray-traced) image must not hit the 30 s command timeout, which closes the window.
        self.tools.call("save_image", {"width": 400, "height": 300})
        options = next(o for name, o in _FakeViewer.instances[0].calls if name == "save_image")
        self.assertGreaterEqual(options["timeout"], 300)

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
                self.assertTrue(by_name["get_state"].annotations.read_only_hint)
                self.assertNotIn("commit_positions", by_name)
                self.assertFalse(by_name["set_view"].annotations.read_only_hint)
                image = await client.call_tool("save_image", {})
                self.assertFalse(image.is_error)
                self.assertEqual(image.content[0].type, "image")
                failed = await client.call_tool("set_view", {"direction": "q"})
                self.assertTrue(failed.is_error)


if __name__ == "__main__":
    unittest.main()
