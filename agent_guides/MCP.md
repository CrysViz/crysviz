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

- Nothing moves the camera or zoom unless that is its job (`set_view`,
  `rotate_camera`, `recenter_camera`). `save_image` photographs the view as
  you framed it; without a size it uses the window's own size and shape.
- Building a supercell or transforming the lattice keeps your viewing
  direction and refits the zoom.
- `get_state` includes your selection; `apply` and `remove_atoms` take
  `selection: "user"` to act on it.
- Every command redraws the window itself; no click is needed to see a change.
- The server's instructions tell the model the same: leave the camera,
  zoom, renderer and display alone unless asked, check views as text with
  `get_state`, take a picture only when the look matters.

## Tools

A tool called without a required argument answers with what it needs, e.g.
`find needs: what (atoms | bonds | polyhedra | voids); optional: where, limit`.

### Structure
| Tool | What it does |
|---|---|
| `load` | A structure from `path`, or `text` plus `name` (the extension picks the format). Never stops to ask (no CIF symmetry or unit dialog). |
| `list_structures`, `select` | Loaded structures; make one (and a frame) active. |
| `add_atoms`, `remove_atoms` | As the Add Atom window: fractional positions, a 0.5 Å collision check (`force` to override). `remove_atoms` returns what it removed, so `add_atoms` can undo it. |
| `build_supercell` | `n: [nx, ny, nz]`, as the Cell & Supercell window. |
| `build_slab` | `hkl`, `layers`, `vacuum` (Å, along the surface normal) as a new structure. |
| `symmetrize` | The standardised (conventional or primitive) cell at a tolerance, as a new structure. |
| `update_lattice`, `update_fractional_positions`, `commit_positions` | Edit the active structure in memory. |

### View
| Tool | What it does |
|---|---|
| `set_view` | Direction (`a`/`b`/`c`, `x`/`y`/`z`, `[u, v, w]`, or Cartesian with `cartesian: true`), optional `up` and `zoom`, in one call. `get_state`'s camera passed back with `cartesian: true` restores a view. |
| `rotate_camera`, `recenter_camera` | Orbit about a world axis; bring the structure back to the middle. |
| `set_render_pipeline` | `forward`, `raytrace`, `pathtrace`, ... |
| `save_image` | PNG of the view as framed (a different aspect than the window is letterboxed, never cropped). Returned to the model up to 2048 px a side; with `filename` and `returnImage: false`, saved at up to 16384 px without returning it. A large ray-traced image can take a minute; the call waits up to 15 minutes. `transparent` works with the raster renderers; the ray and path tracers still paint their backdrop (known gap). |

### Display and every other control
| Tool | What it does |
|---|---|
| `search_controls` | Any window, action or labelled control by what it does ("bonds off", "detect cages", "atom size"), through the app's own feature search. |
| `get_control`, `set_control`, `click_control` | Read, set or press it as a user would, so the app reacts exactly as to a click. |
| `read_window` | A window's visible status and result text, when no command returns the result. |

### Query and act
| Tool | What it does |
|---|---|
| `get_state` | Active structure (formula, lattice, frame, commit state; atoms on request, up to 500), camera, renderer, your selection, jobs. |
| `find` | `atoms`, `bonds` (full periodic graph, with image offsets), `polyhedra` (centred and cages) or `voids`, filtered; returns a selection id. |
| `apply` | `highlight`, `select`, `clear`, `color`, `hide`, `show` on a selection, atom indices or `selection: "user"`; `color` also takes polyhedra selections and `bondPair`. |
| `get_polyhedra`, `get_voids` | Polyhedra per site; interstitial sites with their first shell. |
| `get_bonding` | CrysViz's bond rule: `{min, max, shown}` per element pair, and the exact rule as text. |

### Calculations (jobs)
Long runs start a job and return `jobId` at once; poll with `wait_job`
(up to 25 s per call), stop with `cancel_job`, inspect with `job_status`.
One calculation runs at a time. The potential is the Atomistic window's
(NEP89 by default).

| Tool | What it does |
|---|---|
| `run_md` | NVT or NPT MD: steps, temperature, timestep, save stride; a new trajectory row. |
| `run_relax` | Positions (and cell with `relaxCell`) to `fmax`; a new trajectory row. |
| `compute_energy` | Energy, forces, stress of the active structure. |
| `run_eos` | Volume (`volumeRangePct`) or pressure scan, then the EOS fit: E0, V0, B0, B0'. The fit loads SciPy (Pyodide) from the network. |
| `order_structure` | Ordered approximants of a disordered structure, with energies, best first. |

### Analysis
| Tool | What it does |
|---|---|
| `get_symmetry` | Space group (number, symbol, Hall, Pearson) and Wyckoff letters at a tolerance (Moyo). |
| `get_phonon_state`, `set_phonon_mode`, `phonon_animation`, `phonon_frames` | phonopy files: q-points and frequencies, choose a mode (`"Gamma"`, `"lowest_optical"`), animate, or write N displaced frames as a trajectory. |
| `get_field_info`, `set_isosurface`, `add_field_slice` | Volumetric data (CHGCAR, cube): range, iso level, a slice plane `hkl` through an atom or at an offset. |

### Exports
| Tool | What it does |
|---|---|
| `export_structure` | CIF or POSCAR, as the Save window, to the export folder. Returns the absolute path and the atom order (POSCAR groups by element: `<name>.order.json` maps file atoms to CrysViz indices). |
| `export_trajectory` | extxyz (lattice, species, positions, energy) of all or chosen frames. |

## Heavy analysis: export, script, apply

The model need not see a structure atom by atom. For rings, displacements,
statistics or anything else CrysViz does not compute:

1. `export_structure` (or `export_trajectory`) writes the file;
   `get_bonding` gives CrysViz's exact bond rule.
2. A script (networkx, pymatgen, numpy) rebuilds the bond graph with that
   rule and computes what is needed.
3. The answer goes back as atom indices (through the order map for POSCAR):
   `apply {atoms: [...], action: "color", value: "#ff0000"}`.

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
  live in `controls.js` (generic controls), `query.js` (find, apply,
  bonding, export), `jobs.js` (long runs) and `structureTools.js`
  (symmetry, phonons, fields, slabs, trajectory export).
- `docs/host/commands.json` describes each command: description, JSON Schema
  for the arguments, tier (`read`, `write`, `file`). The MCP server builds its
  tools from it, without opening a window. `tools/unittest/hostcommands.test.mjs`
  fails if it and the handlers disagree.
- The host dispatch redraws after every command.
- `src/crysviz/_mcp.py` is the server (official `mcp` SDK 2.x, low-level
  `Server`). Tools that move files (`load`, `save_image`, `export_structure`,
  `export_trajectory`) are written by hand; every other command maps one to one.

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
2. Describe it in `docs/host/commands.json`; it becomes an MCP tool and a
   `Viewer.call` command with no Python change.
3. Test it: `make unittest`, a check in
   `tools/browsertest/tests/hostfacade.test.js`, and, for a user workflow, a
   step in `tools/mcp_acceptance.py`.
