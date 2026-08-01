<img src="docs/data/CrysViz_logo_clear_back.png" width="400">

# CrysViz - Crystal Structure Visualisation & Analysis

[![Checks](https://github.com/ftrybel/CrysViz_hot_develop/actions/workflows/check.yml/badge.svg)](https://github.com/ftrybel/CrysViz_hot_develop/actions/workflows/check.yml)

## Light-weight browser-based crystal structure visualisation with on-device rendering.

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

Copyright (C) 2025-2026 Florian Trybel, Abhijith S Parackal, Oscar Bulancea-Lindvall, and Rickard Armiento 

## Python package and command line launcher

Install the packaged launcher from a wheel or source distribution with:

```bash
python -m pip install crysviz
```

For development, an editable install keeps the live `docs/` tree as the
frontend resource tree:

```bash
python -m pip install -e .
```

The package requires Python 3.12 or newer and `pywebview` 6.2. It does not
install ASE, httk, or the optional CrysViz computation backend.

Run the viewer with the native pywebview window:

```bash
crysviz structure.cif another.POSCAR
crysviz --gui qt structure.cif
```

Use a system browser when a GUI backend is unavailable:

```bash
crysviz --browser structure.cif
crysviz --browser --no-open --port 8765
```

`--browser` prints a loopback URL and keeps serving until interrupted with
Ctrl-C, whether or not a tab was opened; closing the tab is not observable.
`--port` accepts 0 through 65535 (0 selects a free port), `--gui` accepts
`gtk`, `qt`, or `cef`, `--debug` enables pywebview/server diagnostics, and
`--version` prints the package version. `--no-open` is valid only with
`--browser`. On Linux, install the optional `crysviz[gtk]` or `crysviz[qt]`
extra; these forward pywebview's documented backend extras while retaining
the package's `pywebview>=6.2,<7` constraint. Install the corresponding system
WebKit/GTK or Qt WebEngine backend as well. If that is not practical,
`--browser` is the supported fallback.

Path arguments are validated before the server or GUI starts, loaded in
argument order, and displayed by basename only. `.traj` paths are treated as
binary; ordinary structure paths are text.

### Managed Python API

The library controller launches an isolated pywebview child process while the
calling Python session remains interactive. Importing `crysviz` does not start
a server, browser, process, or network listener. Sources may be filesystem
paths or immutable, snapshotting `Payload` values:

```python
from crysviz import Payload, Viewer, show

payload = Payload("silicon.cif", "data_Si\n_cell_length_a 5.43\n")
with Viewer([payload]) as viewer:
    structures = viewer.list_structures()
    viewer.select(structures[0].id, frame=0)
    viewer.update_fractional_positions([[0.0, 0.0, 0.0]], commit=False)
    viewer.commit_positions()
    viewer.recenter_camera()

# Equivalent concise construction; returns once the window is ready.
viewer = show(["structure.cif"])
```

`load`, `list_structures`, `select`, `update_fractional_positions`,
`commit_positions`, and `recenter_camera` are synchronous controller methods.
They return `LoadResult`, `StructureInfo`, and `PositionUpdateResult` where
appropriate. Structure IDs are opaque and stable for the lifetime of a viewer.
Position updates require exactly one finite three-component fractional point
per atom; a failed fast update automatically performs the full periodic and
topology rebuild, and `commit=True` completes that full synchronization.

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

For Linux GUI use install `crysviz[qt]` or `crysviz[gtk]` plus its documented
system backend. CI exercises the Qt backend under Xvfb. Windows and macOS
smoke coverage should use the native supported Qt, GTK/WebKit, or platform
pywebview backend before releases; `--browser` remains the no-GUI fallback.

The frontend, JavaScript modules, WASM, themes, assets, and local licenses are
packaged together, so normal startup is fully offline. Optional Plotly and
Pyodide-powered tools may contact their existing online resources; if those
resources are unavailable, those optional tools fail while the core viewer
remains usable. The launcher server binds only to `127.0.0.1`, checks its exact
Host header, does not list directories, rejects traversal, and uses short-lived
opaque capability URLs for the manifest and input blobs. It exposes no remote
control HTTP API.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Source code: https://github.com/ftrybel/CrysViz_hot_develop

## Maintainers
- **[Florian Trybel](https://github.com/ftrybel)** - Project lead, core development, and design.
- **[Abhijith S Parackal](https://github.com/Abhivega)** - Core development, and design

## Contributors
- **[Rickard Armiento](https://github.com/rartino)** - CIF Reader, I/O
- **[Oscar Bulancea-Lindvall](https://github.com/oscarlindbul)** - Vector Field Visualisation (ELF, Charge)

## Key Features
- No backend required; runs entirely in the browser, no data leaves your machine. Runs in nearly every device (in particular smartphons and tablets) and in every browser.
- Visualise Input and output files from VASP and Quantum Espress as well as CIFs.
- Measure distances and angles.
- Use custom bond lengths with the optional ability to display atoms outside the unit cell that are bonded neighbours.
- Customizable color schemes can be choosen for any individual atoms
- Forces and spin visualisation. Dynamically for relaxaton or MD trajectories
- Trajectory player. Load OUTCARs and pwscf vc-relax output files directly and visualise the trajectories. Long MD trajecetories might be beyond your browsers memory limits.
- Symmetry anlysis and structure refinement (powered by Moyo WASM)
- Relxations and molecular dynamics simulations directly on your device with NEP potentials with upt to several hundred atoms.
- Possibility to activate a calculation backend. This allow structural relaxations with any ASE compatible calculater, e.g. MACE, UPET; trajectory is added and can be played using the trajectory player
- Bond length histogram (angles and coordiantion numbers are comming)

## Work in progress... (already available)
- Crystal structures structure comparison via structure overlay; Lattice difference analysis inradar plot
- Charge density and electron localisation functions viewer (CHGCAR/ELFCAR or .cube files spin resolved). High memory requirements for large files.
- Share links that contain the structure, view angle, colors and measurements (currently selected structure in trajectory only)

## Comming soon...
- Stress visualisation
- Updated trajectory player for larger and longer trajectories
- Structures manipulation under symmetry constraints
- Add atoms and vaccuum
- eXYZ reader for trajectories or sets of files.

Third-Party Libraries and Attribution:

1. Moyo
   - Repository: https://github.com/spglib/moyo
   - License: MIT or Apache-2.0
   - Copyright: Kohei Shinohara
   - See docs/external/moyo-test/LICENSE for the full license text.
   - Explicitly moyo-wasm is used.
   - License and code can be found in docs/external/moyo-test/

2. NEP_CPU
   - Repository: https://github.com/brucefan1983/NEP_CPU
   - License: GPL-3.0
   - Copyright: NEP_CPU authors
   - See docs/external/nep_wasm/LICENSE-NEP_CPU for the full license text.
   - Explicitly NEP_CPU is compliled into a WASM module. 
   - License and code can be found in docs/external/nep_wasm/

3. THREE.js
   - Repository: https://github.com/mrdoob/three.js/
   - License: MIT
   - Copyright: THREE.js authors
   - See docs/external/three/LICENSE for the full license text.
   - License and code can be found in docs/external/three/

4. NEP89 Weights (from GPUMD)
   - Repository: https://github.com/brucefan1983/GPUMD
   - License: GPL-3.0
   - Copyright: GPUMD authors
   - The weights can be found in docs/external/nep_wasm/
   - See docs/external/nep_wasm/LICENSE-GPUMD for the full license text.

5. three-wboit
   - Repository: https://github.com/stevinz/three-wboit
   - License: MIT
   - Copyright: Stephens Nunnally (@stevinz); portions mrdoob and three.js authors, Alexander Rose
   - See docs/external/three-wboit/LICENSE for the full license text.
   - Used by the optional "Weighted blended (WBOIT)" rendering pipeline.
   - License and code can be found in docs/external/three-wboit/

6. three-depthpeeling-demo
   - Repository: https://github.com/gkjohnson/three-depthpeeling-demo
   - License: MIT
   - Copyright: Garrett Johnson
   - See docs/external/three-depthpeeling/LICENSE for the full license text.
   - Adapted (not verbatim) for the optional "Depth peeling" rendering pipeline;
     see docs/external/three-depthpeeling/README.md for the divergences.
   - License and code can be found in docs/external/three-depthpeeling/

7. THREE.js-RayTracing-Renderer
   - Repository: https://github.com/erichlof/THREE.js-RayTracing-Renderer
   - License: CC0 1.0 (public domain; attribution given as a courtesy)
   - Author: Erich Loftis (@erichlof)
   - See docs/external/three-raytracing/LICENSE for the full license text.
   - GLSL chunk library adapted for the optional "Ray tracing" rendering
     pipeline; see docs/external/three-raytracing/README.md for the adaptations.
   - License and code can be found in docs/external/three-raytracing/

8. THREE.js-PathTracing-Renderer
   - Repository: https://github.com/erichlof/THREE.js-PathTracing-Renderer
   - License: CC0 1.0 (public domain; attribution given as a courtesy)
   - Author: Erich Loftis (@erichlof)
   - See docs/external/three-pathtracing/LICENSE for the full license text.
   - GLSL chunk library adapted for the optional "Path tracing" rendering
     pipeline; see docs/external/three-pathtracing/README.md for the adaptations.
   - License and code can be found in docs/external/three-pathtracing/
