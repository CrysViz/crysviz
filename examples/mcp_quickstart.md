# MCP quickstart: Claude in your CrysViz window

`crysviz-mcp` is a local MCP server. It lets Claude (or another MCP client)
work in a CrysViz window on your computer, together with you. You talk to
Claude; Claude loads structures, changes the view, edits atoms, runs
calculations and sends you pictures. The window stays yours: rotate, select and
edit by hand at any time, and Claude is told what you changed.

Everything runs on your computer. Only local clients are supported for now
(Claude Code and Claude Desktop); claude.ai in the browser is not supported yet.

## 1. Install

The `mcp` extra is newer than the latest release, so install from a checkout
of this repository:

```bash
git clone https://github.com/CrysViz/crysviz.git && cd crysviz
pip install -e '.[mcp,qt]'
```

On Linux, to reuse the system's Qt instead of downloading it:

```bash
uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python -e '.[mcp]'
```

Check that it starts: `.venv/bin/crysviz-mcp --help` (or `crysviz-mcp --help`).

## 2. Connect your client

**Claude Code**, from the folder you will work in:

```bash
claude mcp add crysviz -- /path/to/.venv/bin/crysviz-mcp --gui qt
```

Start Claude Code (or restart it if it was running) and run `/mcp`: `crysviz`
should be listed as connected.

**Claude Desktop**: add the server to `claude_desktop_config.json` and restart
Claude Desktop:

```json
{
  "mcpServers": {
    "crysviz": { "command": "/path/to/.venv/bin/crysviz-mcp", "args": ["--gui", "qt"] }
  }
}
```

Options: `--gui qt|gtk|cef` picks the window backend, `--export-dir DIR` sets
where pictures and exported files go (default `./crysviz-exports`).

## 3. First session

The window opens on Claude's first CrysViz request. Try, one at a time:

1. "Load ~/structures/NaCl.cif and show me the view along c."
2. "Make a 2x2x2 supercell and colour all Cl atoms green."
3. "Find the octahedra around Na and highlight them."
4. "Relax it with the default potential and tell me the energy per atom."
5. "Save a 1600x1200 picture as nacl.png."

Then rotate the structure by hand and ask "save a picture of what I see now":
Claude photographs your view without moving the camera.

More to ask:

- "Remove one O from this supercell, relax it and tell me how far the
  neighbours moved."
- "What is the space group at 0.01 and at 0.1 Å tolerance? Symmetrise to the
  higher one and export a CIF."
- "Run 2 ps of MD at 600 K, export the trajectory and plot the Li mean square
  displacement."
- "Cut a four-layer (111) slab with 15 Å of vacuum and show it side-on."
- "Find all six-membered carbon rings and colour them red." (Claude exports the
  structure, finds the rings with a script and colours them by index.)

## Good to know

- **Shared window.** Claude leaves your camera, zoom and display settings alone
  unless you ask. Every answer it gets from CrysViz says what you changed by
  hand since its last request, so you don't have to tell it.
- **Long calculations** (MD, relaxations, EOS scans) run as jobs; Claude
  checks on them and can cancel them.
- **Reconnecting** the server (`/mcp` in Claude Code) opens a fresh window:
  ask Claude to export what you want to keep first.
- The full tool list and conventions are in
  [agent_guides/MCP.md](../agent_guides/MCP.md).
