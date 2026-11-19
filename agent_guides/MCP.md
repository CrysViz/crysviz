# CrysViz MCP server

`crysviz-mcp` lets Claude, or any other MCP client, drive a local CrysViz
window: "load si.cif, look along c and show me", "relax this vacancy cell",
"colour every 6-ring red". It runs on your computer only. It talks to the
client over stdio, and to the window over the same loopback, token-protected
channel the Python `Viewer` uses. Every tool is also a Python call:
`Viewer.call(name, **args)`.

## Install

```bash
pip install 'crysviz[mcp,qt]'          # or crysviz[mcp,gtk]
claude mcp add crysviz -- crysviz-mcp  # Claude Code
```

Options: `--export-dir DIR` (default `./crysviz-exports`, or
`$CRYSVIZ_EXPORT_DIR`), `--gui qt|gtk|cef`, `--debug`.

The window opens on the first tool call, not when the client starts the
server. If you close it, the next call opens a new one. Reconnecting the
server (`/mcp` in Claude Code) opens a fresh window: export what you want to
keep first.

## Working together in one window

The window is shared: you may rotate, zoom or change settings by hand
between Claude's calls, and Claude sees it through `get_state`.

- Nothing moves the camera or zoom unless that is its job (`set_view`).
  `save_image` photographs the view as you framed it; without a size it uses
  the window's own size and shape.
- `set_supercell` and lattice changes keep your viewing direction and refit
  the zoom.
- `get_state` includes your selection; atom-addressed tools take
  `selection: "user"` to act on it. `apply clear` clears only the highlight
  unless asked to clear the selection, and `apply select` says what selection
  of yours it replaced.
- Every command redraws the window itself; no click is needed to see a change.
- Your edits renumber atoms (a supercell, deleting atoms): edits by index take
  `expectedRevision` (from `get_state` or `find`) and refuse with
  `STRUCTURE_CHANGED` when the structure changed meanwhile. An open Modify
  Structure window follows Claude's edits and never writes a stale table back.
- The server's instructions tell the model the same: leave the camera,
  zoom, renderer and display alone unless asked, check views as text with
  `get_state`, take a picture only when the look matters.

## Conventions

One set of rules for every tool, so a model that learns one knows them all:

- **Verbs.** `get_*` and `find` read; `set_*` change the active structure or
  view in place; `build_*` make a new structure row and show it; `run_*`
  start a calculation job; `export_structure` and `save_image` write files.
- **Atoms.** Tools that act on atoms (`apply`, `remove_atoms`,
  `set_element`, `move_atoms`) take `atoms` (0-based indices) or `selection`
  (a `find` id, `"user"` for the user's selection, `"all"`), never both.
- **Results** are always objects. Structural edits return `atomCount` and
  `revision`; tools that make or show a row return
  `{structure, name, frames, activeFrame, atomCount, revision}`. A row id is
  `structure` in arguments and results (`id` inside `get_state`'s
  `structure` and `structures`).
- **Units.** Å, eV and fractional coordinates are unsuffixed; other units are
  suffixed (`temperatureK`, `timestepFs`, `pressureGPa`, `volumeRangePct`,
  `frequencyTHz`, `waitS`). Forces are `fmax` (eV/Å).
- **Errors** are `{code, message, details}`; `INVALID_ARGS` names the
  argument. A tool called without a required argument, or with one it does
  not take, answers with what it takes, e.g. `find needs: what (atoms | bonds
  | polyhedra | voids); optional: where, limit, fields, groupBy`. Unknown keys
  are refused, never ignored.

## Tools (35)

### State and query
| Tool | What it does |
|---|---|
| `get_state` | The active structure (formula, lattice, frame, `revision`) and renderer; `include` adds `structures` (every loaded row), `camera`, `selection`, `jobs` (the default three), `colors`, `phonons`, `field`. |
| `find` | `atoms`, `bonds` (full periodic graph with image offsets; `where.atoms` gives neighbour lists), `polyhedra` (centred and cages, built on demand) or `voids` (interstitial sites with their first shell); filters, selection algebra (`in`, `notIn`), compact output (`fields`, `groupBy`). Returns a selection id (not for voids). |
| `get_bonding` | CrysViz's bond rule: `{min, max, shown}` per element pair, and the exact rule as text. |
| `get_symmetry` | Space group (number, symbol, Hall, Pearson) and Wyckoff letters at a tolerance (Moyo). |
| `search_controls`, `get_control`, `set_control`, `click_control` | Any window, action or labelled control by what it does ("bonds off", "detect cages"); read, set or press it as a user would. |
| `read_window` | A window's visible status and result text, when no command returns the result. |

### The active structure, in place
| Tool | What it does |
|---|---|
| `select_structure` | Show a loaded row and frame. |
| `add_atoms`, `remove_atoms` | As the Add Atom window: fractional positions, a 0.5 Å collision check (`force` to override). `remove_atoms` returns what it removed, so `add_atoms` can undo it. |
| `set_element` | Change atoms to another element in place (indices, positions and selections kept). |
| `move_atoms` | `to` (one position per atom) or `by` (one shift), fractional or `cartesian`. |
| `set_lattice` | New lattice vectors; fractional positions kept. |
| `set_supercell` | `n: [nx, ny, nz]` in place, as the Cell & Supercell window; `[1, 1, 1]` goes back. |

### New rows
| Tool | What it does |
|---|---|
| `build_slab` | `hkl`, `layers`, `vacuum` (Å, along the surface normal). |
| `build_symmetrized` | The standardised (conventional or primitive) cell at a tolerance. |
| `build_phonon_frames` | The chosen phonon mode as N displaced frames, a trajectory. |

### View and display
| Tool | What it does |
|---|---|
| `set_view` | In one call: `direction` (`a`/`b`/`c`, `x`/`y`/`z`, `[u, v, w]`, or Cartesian with `cartesian: true`), `up`, `zoom`, `rotate: {axis, degrees}`, `recenter`. Returns the camera; `get_state`'s camera passed back with `cartesian: true` restores a view. |
| `set_renderer` | `forward`, `raytrace`, `pathtrace`, ... |
| `apply` | `highlight`, `select`, `clear`, `color` (`color: "#rrggbb"`), `reset_color`, `hide`, `show`; a drawn polyhedra selection's `color` colours the polyhedra, `bondPair` colours a bond pair. |
| `set_phonon` | Mode (`qpoint`: index, `"Gamma"` or a label; `band`: index or `"lowest_optical"`), `animate` (play, pause, stop), `amplitude`, `speed`. |
| `set_isosurface` | A volumetric field's iso level (CHGCAR, cube). |
| `add_plane` | A Crystal Planes plane `hkl` through an atom or at an offset; `show: "field"` makes it a 2D slice of the field, `cut` hides one side. |

### Calculations (jobs)
A `run_*` tool starts a job and returns `{jobId, kind, status, progress,
elapsedS}` at once, or with its `result` if it ends within `waitS` (0 to 25 s;
a quick `run_energy` with `waitS: 25` is one call). Poll with `wait_job`
(`timeoutS` 0 to 25; 0 just reports), stop with `cancel_job`. A finished job
says which structure and frame are on show (`active`). One calculation runs
at a time. The potential is the Atomistic window's (NEP89 by default).

| Tool | What it does |
|---|---|
| `run_md` | NVT or NPT MD: steps, temperatureK, timestepFs, saveStride; a new trajectory row. |
| `run_relax` | Positions (and cell with `relaxCell`) to `fmax`; a new trajectory row whose last frame is shown. Says which `targetPressureGPa` it used and hints at a pressure in the file name. |
| `run_energy` | Energy, energy per atom, `fmax`, pressure of the active structure. |
| `run_eos` | Volume (`volumeRangePct`) or pressure scan, then the EOS fit: E0, V0, B0GPa, B0Prime. The fit loads SciPy (Pyodide) from the network. |
| `run_ordering` | Ordered approximants of a disordered structure, with energies, best first. |

### Files
| Tool | What it does |
|---|---|
| `load` | A structure from `path`, or `text` plus `name` (the extension picks the format). Never stops to ask (no CIF symmetry or unit dialog). Returns the row, its formula, and `restored` when the Cell & Supercell window restored a remembered supercell. |
| `save_image` | PNG of the view as framed (a different aspect than the window is letterboxed, never cropped). Returned to the model up to 2048 px a side; with `filename` and `returnImage: false`, saved at up to 16384 px without returning it. A large ray-traced image can take a minute; the call waits up to 15 minutes. `transparent` works with the raster renderers; the ray and path tracers still paint their backdrop (known limitation; `save_image` warns). |
| `export_structure` | `cif` or `poscar` (one frame, as the Save window; POSCAR's atom order goes to `<name>.order.json`) or `extxyz` (frames, for ASE, pymatgen, OVITO), into the export folder; `structure` and `frame` export a row or frame that is not on show, without showing it. Returns the absolute path. |

## Heavy analysis: export, script, apply

The model need not see a structure atom by atom. For rings, displacements,
statistics or anything else CrysViz does not compute:

1. `export_structure` (cif, poscar, or extxyz for trajectories) writes the file;
   `get_bonding` gives CrysViz's exact bond rule.
2. A script (networkx, pymatgen, numpy) rebuilds the bond graph with that
   rule and computes what is needed.
3. The answer goes back as atom indices (through the order map for POSCAR):
   `apply {atoms: [...], action: "color", color: "#ff0000"}`.

Only file paths and indices pass through the conversation, so it scales
with the structure.

## Acceptance run

`tools/mcp_acceptance.py` drives the real server over stdio through ten user
workflows (vacancy relax, publication figure, charge density, MD diffusion,
symmetry, ordering, EOS, phonon frames, slab, screening) and the shared-window
checks, and prints a PASS/FAIL table. A window opens; it needs a display.

```bash
.venv/bin/python tools/mcp_acceptance.py                  # all, under 2 minutes
.venv/bin/python tools/mcp_acceptance.py --only 5,9,collab --out /tmp/acc
```

## How it is built

- `docs/host/commands.js` is the command registry, one handler per command,
  for every transport (the pywebview bridge in `docs/host/BrowserHost.js`
  today; Electron and an MCP App later). Handlers reuse the windows' own
  functions: a command and its button run the same code. Related handlers
  live in `controls.js` (generic controls), `query.js` (find, apply, the
  shared atoms/selection resolver, bonding, export), `jobs.js` (long runs)
  and `structureTools.js` (symmetry, phonons, fields, planes, slabs).
- `docs/host/commands.json` describes each command: description, JSON Schema
  for the arguments, tier (`read`, `write`, `file`). The MCP server builds its
  tools from it, without opening a window. `tools/unittest/hostcommands.test.mjs`
  fails if it and the handlers disagree.
- The host dispatch redraws after every command.
- `src/crysviz/_mcp.py` is the server (official `mcp` SDK 2.x, low-level
  `Server`). Tools that move files (`load`, `save_image`, `export_structure`)
  are written by hand; every other command maps one to one. Commands marked
  `"mcp": false` (`update_fractional_positions`, `commit_positions`) are for
  the Python `Viewer` only.

## From Python

Every tool is also `Viewer.call(name, **args)`; arguments may be snake_case
(`viewer.call("run_md", temperature_k=600)` sends `temperatureK`).
`Viewer.run_job(name, **args)` starts a `run_*` job and blocks until it ends.
The released methods (`list_structures`, `select`, `update_lattice`,
`update_fractional_positions`, `commit_positions`, `recenter_camera`,
`rotate_camera`, `set_render_pipeline`, `save_image`, `load`) keep working
as thin wrappers over these commands.

## Safety

- Loopback only, with the existing capability token. No network listener.
- No tool runs arbitrary JavaScript.
- Files are written only into the export folder, under a plain file name.
- Structure files are data. The server's instructions tell the model never
  to follow text found inside them.

## Adding a command

1. Add the handler to `COMMAND_HANDLERS` in `docs/host/commands.js`, reusing
   the window's function (extract it from the click handler if needed, so
   both call one path). Pass app functions it needs through `BrowserHost`
   `configure()` (`initializeCore` in `docs/core/crystal-viewer.js`).
2. Describe it in `docs/host/commands.json`, following the conventions
   above (verb, `atoms`/`selection`, result envelope, unit suffixes); it
   becomes an MCP tool and a `Viewer.call` command with no Python change.
3. Test it: `make unittest`, a check in
   `tools/browsertest/tests/hostfacade.test.js`, and, for a user workflow, a
   step in `tools/mcp_acceptance.py`.
