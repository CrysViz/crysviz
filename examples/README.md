# Python API examples

Small, runnable scripts that drive a CrysViz window from Python. The full guide
is [agent_guides/Python.md](../agent_guides/Python.md).

## Installation

The Python API opens CrysViz in a pywebview window, which needs a native GUI
backend. The `qt` or `gtk` extra installs one:

```bash
pip install 'crysviz[qt]'          # or 'crysviz[gtk]'
```

On Linux you can reuse the system's Qt and WebEngine instead. Create the venv
with access to the system packages, then install CrysViz into it:

```bash
uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python crysviz
# or with plain venv + pip:
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install crysviz
```

The commands these examples use are newer than the latest release. Until the
next release, install from a checkout of this repository instead:
`pip install -e '.[qt]'` (or `uv pip install --python .venv/bin/python -e .`).

If no window opens, check that pywebview works on its own:

```python
import webview
webview.create_window('Hello world', 'https://pywebview.flowrl.com/')
webview.start()
```

and follow the [pywebview installation guide](https://pywebview.flowrl.com/guide/installation.html)
if it does not.

## Running the examples

Run a script with the venv's Python, from the folder where you want its
pictures:

```bash
.venv/bin/python examples/polyhedra_colours.py
.venv/bin/python examples/polyhedra_colours.py --keep-open   # look around before it closes
```

A script owns its window: when the script ends, the window closes. The scripts
therefore close by themselves; `--keep-open` makes them wait (`v.wait()`)
until you close the window. In a REPL, IPython or Jupyter you do not need
`wait()`: the window stays open between commands. Paste the lines of a script's
`main()` one by one to follow along.

| Script | What it shows |
|---|---|
| [`first_steps.py`](first_steps.py) | A first tour of SrTiO3: a 2x2x2 supercell, the TiO6 octahedra in blue, the view along c, a picture and a relaxation. Saves `srtio3_view.png`. |
| [`polyhedra_colours.py`](polyhedra_colours.py) | The WO6 octahedra of a ReO3-type WO3 supercell in blue: display toggles by name, `find`, `apply`. Saves `octahedra.png`. |
| [`rings_networkx.py`](rings_networkx.py) | Export plus your own script: finds the six-membered rings of a graphene sheet with networkx using CrysViz's own bond cutoffs, colours one red. Saves `ring.png`. Needs `networkx`. |
| [`slab_picture.py`](slab_picture.py) | A four-layer Cu(111) slab with 15 Å of vacuum, viewed edge-on. Saves `cu111_slab.png`. |
| [`relax_then_eos.py`](relax_then_eos.py) | Calculations as jobs: relaxes fcc copper, then scans the volume and fits an equation of state (prints V0 and B0). Needs the Internet for the fit. |
| [`watch_user_edits.py`](watch_user_edits.py) | Working together: prints your edits in the window (elements, atoms, selection, camera, renderer) as you make them. `--seconds N` sets how long it watches. |
| [`raytrace_snapshot.py`](raytrace_snapshot.py) | Switches to the ray tracer and saves `crysviz-raytrace.png`. |
| [`rotate_camera.py`](rotate_camera.py) | A short orbit with `set_view(rotate=...)`. |
| [`update_lattice_and_positions.py`](update_lattice_and_positions.py) | Deforms a two-atom silicon cell (`set_lattice`) and moves an atom (`move_atoms`). |
| [`mcp_quickstart.md`](mcp_quickstart.md) | Not a script: a first session with CrysViz through MCP. |

## Notes on the API

- **Every command is a method**, e.g. `v.find(...)`, `v.set_view(...)`,
  `v.run_relax(...)`. `dir(v)` lists them and `help(v.find)` shows the
  arguments. `v.call(name, **args)` is the same thing by name.
- **Refusals and errors.** A command the situation refused (the structure
  changed under the atoms you named, a calculation is already running, atoms
  would be too close) returns `{"applied": False, "reason": ..., "code": ...}`
  and changes nothing. A wrong call (bad arguments, an unknown control) raises
  `BrowserCommandError`.
- **Events.** `v.on(name, callback)` subscribes to `ready`, `structure_loaded`,
  `active_structure_changed`, `user_changed`, `error` and `closed`; `off`
  removes a callback. Callbacks receive `ViewerEvent` records on a dedicated
  event thread, so they may issue commands, but must not call `wait()` (that
  raises `ViewerReentrancyError`). `ready` and `closed` replay to late
  subscribers.
- **Failures are typed:** `ViewerStartupError`, `ViewerClosedError`,
  `ViewerCommandTimeout`, `ViewerProtocolError`, `BrowserCommandError` and its
  subclass `CommandRefused` (also exported under the short names
  `StartupError`, `ClosedViewerError`, `CommandTimeoutError` and
  `ProtocolError`). A command that times out closes the private host rather
  than letting a possibly stuck window keep accepting changes.
- `close()` can be called more than once; Ctrl-C or leaving a `with` block also
  closes the window and cleans up its private host.

The parent and child authenticate over a private loopback IPC connection. The
bootstrap secret travels only through inherited stdin, never command-line
arguments, URLs, or logs. IPC is protocol-versioned JSON with bounded explicit
binary attachments; it never uses pickle. Browser commands use one fixed
dispatcher and the page-to-host bridge is capability- and exact-loopback-origin
checked.
