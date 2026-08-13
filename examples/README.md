# Python API examples

## Installation

The Python CrysViz API requires a working native pywebview GUI backend.
This sometimes works automatically via CrysViz dependency handling,
but if not, follow the [installation instructions for pywebview](https://pywebview.flowrl.com/guide/installation.html)).

We suggest that you set up pywebview and CrysViz in a venv.
For pywebview to access its required system packages, you may need to create it as, e.g.:
```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install pywebview
```
And then test that the pywebview backend works:
```python
import webview
webview.create_window('Hello world', 'https://pywebview.flowrl.com/')
webview.start()
```

Now you can install CrysViz with its dependencies as:
```
python3 -m pip install .
```

## Overview

The rotation example performs a short orbit and then closes its window.
The ray-tracing example writes `crysviz-raytrace.png` in the current directory,
prints its resolved path, and closes as soon as the synchronous image export
finishes. The lattice-and-positions example visibly deforms a two-atom silicon
cell, changes both fractional positions, recenters the camera, then closes.
Ctrl-C or a context exit also closes the managed window and cleans up its
private host.

## Details

Three self-contained remote-control examples are in [`examples/`](examples/):
[`rotate_camera.py`](examples/rotate_camera.py) demonstrates a camera orbit,
[`raytrace_snapshot.py`](examples/raytrace_snapshot.py) selects ray tracing
and saves a PNG, and
[`update_lattice_and_positions.py`](examples/update_lattice_and_positions.py)
updates a two-atom structure. The managed controller also provides
`rotate_camera(angle_degrees, axis="y")`, `set_render_pipeline(pipeline_id)`,
and `save_image(path, width=800, height=600, margin=0, transparent=False, structure_only=False,
timeout=None)`. `save_image` returns the written `pathlib.Path`; PNG capture is
full-view and restores the browser's render state after export.

`load`, `list_structures`, `select`, `update_lattice`,
`update_fractional_positions`, `commit_positions`, and `recenter_camera` are
synchronous controller methods.
They return `LoadResult`, `StructureInfo`, and `PositionUpdateResult` where
appropriate. Structure IDs are opaque and stable for the lifetime of a viewer.
Position updates require exactly one finite three-component fractional point
per atom; a failed fast update automatically performs the full periodic and
topology rebuild, and `commit=True` completes that full synchronization.
`update_lattice` takes exactly three finite Cartesian row vectors in Å. It
preserves fractional positions, affects only the active frame, synchronously
performs a full browser rebuild, and leaves the camera untouched.

Subscribe before or after startup with `viewer.on("ready", callback)` and
remove a callback with `off`. Callbacks receive `ViewerEvent` records and run
on a dedicated event worker, so they may issue controller commands or call
`close`; `wait()` from a callback raises `ViewerReentrancyError`. The events
are `ready`, `structure_loaded`, `active_structure_changed`, `error`, and
`closed`; `ready` and `closed` replay to late subscribers. `close()` is
idempotent and `wait()` waits for the window to close.

Failures are typed: `ViewerStartupError`, `ViewerClosedError`,
`ViewerCommandTimeout`, `ViewerProtocolError`, and `BrowserCommandError`
(also exported under the short names `StartupError`, `ClosedViewerError`,
`CommandTimeoutError`, and `ProtocolError`). A command timeout intentionally
closes the private host rather than allowing a potentially wedged GUI to keep
accepting mutations.

The parent and child authenticate over a private loopback IPC connection. The
bootstrap secret travels only through inherited stdin, never command-line
arguments, URLs, or logs. IPC is protocol-versioned JSON with bounded explicit
binary attachments; it never uses pickle. Browser commands use one fixed
dispatcher and the page-to-host bridge is capability- and exact-loopback-origin
checked.
