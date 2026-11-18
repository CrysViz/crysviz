# CrysViz MCP server

`crysviz-mcp` lets Claude, or any other MCP client, drive a local CrysViz
window, for example "load si.cif, look along c and show me". It runs on your
computer only. It talks to the client over stdio, and to the window over the
same loopback, token-protected channel that the Python `Viewer` uses.

## Install

```bash
pip install 'crysviz[mcp,qt]'          # or crysviz[mcp,gtk]
claude mcp add crysviz -- crysviz-mcp  # Claude Code
```

Options: `--export-dir DIR` (default `./crysviz-exports`, or
`$CRYSVIZ_EXPORT_DIR`), `--gui qt|gtk|cef`, `--debug`.

The window opens on the first tool call, not when the client starts the
server. If you close it, the next tool call opens a new one.

## Tools

| Tool | Tier | What it does |
|---|---|---|
| `load` | file | Load a structure from `path`, or from `text` plus `name` (the extension picks the format). It never stops to ask: a CIF loads as written, with no symmetry dialog. |
| `list_structures` | read | Loaded structures, their ids and frame counts, and which one is active. |
| `select` | write | Make a structure (and frame) active. |
| `set_view` | write | Look along `a`/`b`/`c`, `x`/`y`/`z` or a lattice direction `[u, v, w]`. Keeps the zoom. |
| `rotate_camera` | write | Orbit by `angleDegrees` about world `x`/`y`/`z`. |
| `recenter_camera` | write | Bring the structure back to the middle of the view. |
| `set_render_pipeline` | write | Switch the renderer (`forward`, `raytrace`, `pathtrace`, ...). |
| `save_image` | file | Render the view and return the PNG to the model (16 to 2048 px a side). With `filename`, it also saves a copy in the export folder. |
| `update_lattice`, `update_fractional_positions`, `commit_positions` | write | Edit the active structure in memory. |

Example prompts: "Load ~/data/NaCl.cif and show me the view along c";
"Look along [1 1 1], switch to ray tracing and save it as nacl-111".

## How it is built

- `docs/host/commands.js` is the command registry: one handler per command.
  It serves every transport. Today that is the pywebview bridge
  (`docs/host/BrowserHost.js`); Electron and an MCP App can use it later.
- `docs/host/commands.json` describes each command: its description, JSON
  Schema for the arguments, and tier. The MCP server builds its tools from
  this file, so it can list tools without opening a window. A command added
  to both files becomes an MCP tool without any Python change.
  `tools/unittest/hostcommands.test.mjs` fails if the two files disagree.
- `src/crysviz/_mcp.py` is the server. It uses the official `mcp` SDK
  (2.x, low-level `Server`). `load` and `save_image` move files, so they
  have hand-written tools; every other command maps one-to-one.

## Safety

- Loopback only, with the existing capability token. No network listener.
- No tool runs arbitrary JavaScript.
- `save_image` writes only into the export folder, and only under a plain
  file name (no folders, no `..`).
- Structure files are data. The server's instructions tell the model never
  to follow text found inside them.

## Adding a command

1. Add the handler to `COMMAND_HANDLERS` in `docs/host/commands.js`. Pass
   any app function it needs through `BrowserHost` `configure()` (see
   `initializeCore` in `docs/core/crystal-viewer.js`).
2. Describe it in `docs/host/commands.json`.
3. Optionally add a typed method to `src/crysviz/_viewer.py`.
4. Test it: `make unittest`, and a check in
   `tools/browsertest/tests/hostfacade.test.js`.
