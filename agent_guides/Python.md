# CrysViz from Python

Drive a CrysViz window from Python: load structures, change the view, edit,
run MD or relaxations, read symmetry, export files. The window stays fully
interactive. You can rotate, select and edit by hand between commands, and
Python is told what you changed.

This guide is for people writing Python by hand, in a REPL, IPython or a
Jupyter notebook. For Claude and other AI assistants, see [MCP.md](MCP.md);
both use the same commands.

## Install

```bash
# with uv, reusing the system's Qt (Linux): no 200 MB Qt download
uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python crysviz

# or with pip, bringing its own GUI backend
pip install 'crysviz[qt]'          # or crysviz[gtk]
```

Until the next release, the commands described here are only in a checkout:
`pip install -e '.[qt]'` (or `uv pip install --python .venv/bin/python -e .`) from the repository.

The window is a pywebview window. If it doesn't open, check that pywebview
works on its own; see [examples/README.md](../examples/README.md).

## A session

The REPL, IPython and Jupyter are the natural places for this. The window runs
in its own process, so the prompt comes back at once and both stay responsive.

```python
>>> from crysviz import show
>>> v = show(["SrTiO3.cif"])            # the window opens; the prompt returns
>>> v
<crysviz.Viewer open, showing SrTiO3.cif>
>>> v.get_state()["structure"]["formula"]
'SrTiO3'
>>> v.set_supercell(n=[2, 2, 2])
>>> v.set_view(direction="c")             # look along c
>>> v.save_image("view.png")              # in Jupyter the picture shows inline
```

`v.close()` closes the window, and so does closing it by hand.

**Scripts** (`python my_script.py`) are different: when the script ends,
Python exits and the window closes with it. End a script with `v.wait()` to
keep the window open until you close it. In a REPL or notebook you never need
`wait()`. `with Viewer(...) as v:` closes the window at the end of the block,
which suits scripts that save files and finish.

## Every command is a method

Each command in the registry (`crysviz.web/host/commands.json`) is a method of
`Viewer`, with keyword arguments in snake_case:

```python
v.find(what="atoms", where={"element": "O"})
v.set_view(direction=[1, 1, 0], up="c", zoom=1.5)
v.apply(atoms=[0, 3], action="color", color="#ff0000")
v.run_relax(fmax=0.02)
```

- `help(v.find)` shows what a command does and its arguments.
- `dir(v)` lists them all, so tab completion works in IPython and Jupyter.
- They return plain dicts, ready to print or index.
- `v.call("find", what="atoms")` is the same thing by name.

| What | Methods |
|---|---|
| Read | `get_state`, `find`, `get_bonding`, `get_symmetry`, `search_controls`, `get_control`, `read_window` |
| Change in place | `select_structure`, `add_atoms`, `remove_atoms`, `set_element`, `move_atoms`, `set_lattice`, `set_supercell`, `set_view`, `set_renderer`, `apply`, `set_phonon`, `set_isosurface`, `add_plane`, `set_control`, `click_control` |
| Make a new structure row | `build_slab`, `build_symmetrized`, `build_phonon_frames` |
| Calculations | `run_md`, `run_relax`, `run_energy`, `run_eos`, `run_ordering`, `wait_job`, `cancel_job` |
| Files | `load(path or Payload)`, `save_image(path)`, `export_structure(path, format=...)` |

The methods from the 0.11 release still work: `list_structures`, `select`,
`update_lattice`, `update_fractional_positions`, `commit_positions`,
`recenter_camera`, `rotate_camera`, `set_render_pipeline`.

**Conventions:**
- **Atoms** are 0-based indices in structure order.
- **`selection`** is a `find` id, `"user"` (what you have selected in the window) or `"all"`.
- **Positions** are fractional unless an argument says `cartesian`.
- **Units:** lengths in Å and energies in eV carry no suffix; everything else does (`temperature_k`, `timestep_fs`, `pressure_gpa`, `volume_range_pct`, degrees).

**Display settings that have no command of their own** are all reachable by
name through the app's feature search (Ctrl+F), with a query ending in on or off:

```python
ref = v.search_controls(query="bonds off", limit=1)["controls"][0]["ref"]
v.set_control(ref=ref, value=False)
```

## Working together with the window

You may change things by hand at any time: elements, atoms, a supercell, the
selection, the camera, the renderer. Python finds out in three ways, and
**each change is reported once**, by whichever comes first:

1. **`sinceLastCall` in results.** When something changed by hand since the
   previous command, the next result carries it:
   ```python
   >>> v.find(what="atoms", where={"element": "C"})["sinceLastCall"]["note"]
   'Changed in the window since your last call (not by you): 2 atoms changed element (B->C x2).'
   ```
2. **`v.take_user_changes()`** returns every change not yet taken, oldest
   first, and clears the list. It checks the window first, so an edit you made a
   moment ago is included. Typed methods such as `load` and `save_image` return
   their own values, so read their notes here.
3. **Events, as they happen:**
   ```python
   def changed(event):
       print(event.data["note"])
   v.on("user_changed", changed)
   ```
   A moment (about 0.25 s) after you stop interacting, the window sends what
   changed. Nothing is sent for changes your own commands make, or while a
   calculation runs.

   Callbacks run on a background thread, one at a time. They may call viewer
   commands, but not `wait()`, which raises `ViewerReentrancyError` there.

   The other events are `ready`, `structure_loaded`, `active_structure_changed`,
   `error`, `closed` and `file_saved` (below). Use `v.off(event, callback)` to
   unsubscribe.

`get_state()["selection"]` also says how the selection was made: `origin`
`{"by": "pick", "atom": 12}` is a click on atom 12; `by` `marquee`,
`focus-region` or `row-click` selected a group at once (`atom` is `None`).

**Index-based edits are guarded.** If you add or remove atoms while a script
holds indices, an edit given `expected_revision=` (the `revision` from
`get_state()["structure"]`) is not applied to the wrong atoms. Edits to other
atoms, such as another atom's element, don't block it. The revision follows
which atoms there are (identity, species, the cell), not where they sit, so
`move_atoms` keeps it: a live MD run or relaxation moves every atom every frame
and would otherwise break every guard. Moves you make by hand are still
reported in `sinceLastCall`.

**After a relaxation, check the chemistry.** Relaxing badly placed atoms (far
too close) can break bonds and destroy the structure while `get_symmetry()`
still reports the same space group. Look at the bonding before building on it.

## Refused is not an error

A command that is valid but that the situation refuses returns a normal
result: `{"applied": False, "reason": "...", "code": "..."}`. Nothing was changed.
The common cases:
- `STRUCTURE_CHANGED`: the atoms it addressed moved.
- `JOB_BUSY`: a calculation is already running.
- `ATOMS_TOO_CLOSE`: pass `force=True` to add them anyway.
- `CONTROL_DISABLED`: the control is greyed out in the window.

A successful write says `"applied": True`.

```python
r = v.add_atoms(atoms=[{"element": "N", "position": [0.5, 0.5, 0.5]}])
if not r["applied"]:
    print(r["reason"])
```

The typed methods (`load`, `save_image`, ...) raise `CommandRefused` instead.
A wrong call (a bad argument, an unknown element or index) raises
`BrowserCommandError` with a message naming what was wrong, and so does a call
missing a required argument. `CommandRefused` is a subclass of it, so one
`except BrowserCommandError` catches both.

## Calculations

`run_md`, `run_relax`, `run_energy`, `run_eos` and `run_ordering` use the
potential chosen in the Atomistic window (NEP89 by default, 89 elements), or
the one `potential=` picks (`"nep"`, `"pet-mad"`, `"ase"`), as a click on
the window's Choose potential does (it stays picked; the PET-MAD or ASE model
is the window's). `"ase"` without a connected ASE server raises
`CommandRefused`. Only one runs at a time. A run started from the Atomistic window (Relax, MD) or the
EOS window is a job too: `get_state` lists it and `cancel_job` stops it, and
the window's Stop button stops a run your script started.

As methods they **block until the job ends** and return its final status:

```python
>>> job = v.run_relax(fmax=0.02)
>>> job["status"], job["result"]["converged"], job["result"]["steps"]
('done', True, 12)
>>> job["active"]                # the structure and frame on show afterwards
```

`wait=False` returns at once with the job. Check on it with `wait_job` or stop
it with `cancel_job`:

```python
job = v.run_md(steps=5000, temperature_k=600, wait=False)
v.wait_job(job_id=job["jobId"], wait_s=10)        # waits up to 10 s, reports progress
v.cancel_job(job_id=job["jobId"])                 # an MD run keeps the frames it saved
```

`timeout=` on a blocking run raises `TimeoutError` after that many seconds;
the job keeps running.

## Files

- **`v.load(path)`** loads a file. `v.load(Payload("si.cif", text))` loads text.
  `interactive=False` skips load-time dialogs such as the CIF symmetry question.
- **`v.save_image(path)`** saves the view as you see it. With no size it uses
  the window's own size and shape. It never moves the camera. A path ending in
  `.svg` (or `format="svg"`) writes the Download Image window's SVG: the
  structure as an embedded image with editable labels and axes, or as vector
  shapes with `vector=True`. In Jupyter either shows inline.
- **`v.revert_structure()`** puts the structure back as it was created (a file
  as read, which also undoes a supercell), as the Modify Structure window's
  Revert Changes does, without asking.
- **The app's own downloads** (Files > Download, Save, the Download Image
  window) normally open the window's Save dialog. Give the viewer a folder and
  they are saved there instead: `Viewer(download_dir="exports")`. A command
  that caused one (for example `v.click_control(ref=...)` on a Download button)
  lists them in its result as `savedFiles`; a file saved by hand raises
  `file_saved` (`event.data["path"]`) and appears in `take_user_changes()`.
- **`v.export_structure(path, format="cif" | "poscar" | "extxyz")`** writes a
  structure file. extxyz writes every frame of a trajectory (`frames="all"`).
  A POSCAR groups atoms by element, so the result's `order` maps file atom `k`
  to CrysViz atom `order[k]`.

**Heavy analysis**, such as rings, displacements or statistics, works best
outside the window: export the structure, rebuild CrysViz's bonds from
`v.get_bonding()` in your own script (numpy, networkx, pymatgen, ...), and
send the answer back as atom indices, e.g. `v.apply(atoms=[...], action="color", color=...)`.

## Recipes

Runnable versions of the first, second and fifth recipes are in
[examples/](../examples/).

**1. Colour the octahedra of a perovskite framework** ([examples/polyhedra_colours.py](../examples/polyhedra_colours.py))
```python
v = show(["WO3.vasp"])
v.set_supercell(n=[2, 2, 2])
ref = v.search_controls(query="polyhedra on", limit=1)["controls"][0]["ref"]
v.set_control(ref=ref, value=True)                       # show the polyhedra
octahedra = v.find(what="polyhedra", where={"cn": 6})
v.apply(selection=octahedra["selection"], action="color", color="#3366ff")
```

**2. Six-membered rings with networkx** ([examples/rings_networkx.py](../examples/rings_networkx.py))
```python
exported = v.export_structure("sheet.vasp", format="poscar")
pairs = v.get_bonding()["pairs"]        # [{"elements": ["C", "C"], "min": .., "max": .., "shown": True}, ...]
# build the periodic bond graph with these cutoffs, find 6-cycles (see the example),
# then map file atoms through exported["order"] and colour:
v.apply(atoms=ring_atoms, action="color", color="#e03030")
```

**3. Relax, then an equation of state**
```python
relaxed = v.run_relax(fmax=0.01)["result"]          # the relaxed frame is now on show
eos = v.run_eos(volume_range_pct=5)["result"]       # volumes over ±5 % around the relaxed cell
fit = eos["fit"]["energyVolume"]
print(fit["V0"], fit["B0GPa"])                      # Å³ per cell, GPa
```
The fit loads SciPy through Pyodide, so `run_eos` needs a network connection.
Check `eos["fitReliable"]` before using the numbers: it is false, with
`eos["warnings"]` saying why, when points did not converge, the scan does not
bracket the minimum or reach zero pressure, or V0 or B0 make no sense.

To keep the space group during a calculation, pass `symmetry=True` (or
`symmetry={"tolerance": 0.1}`) to `run_relax`, `run_md` or `run_eos`: the
structure is locked as by the Symmetry window's Wyckoff editor first, and
`result["symmetry"]["kept"]` says whether the group held. An unconverged
`run_relax` continues where it stopped when called again.

**4. MD, then the mean-squared displacement with numpy**
```python
import re
import numpy as np

v.set_supercell(n=[2, 2, 2])
v.run_md(steps=2000, temperature_k=600, save_stride=10)   # a new trajectory row
v.export_structure("md.xyz", format="extxyz")             # every saved frame

frames, lines, i = [], open("md.xyz").read().splitlines(), 0
while i < len(lines):
    n = int(lines[i])
    cell = np.array(re.search(r'Lattice="([^"]+)"', lines[i + 1]).group(1).split(), float).reshape(3, 3)
    rows = [l.split() for l in lines[i + 2:i + 2 + n]]
    frames.append(np.array([r[1:4] for r in rows], float))
    elements = [r[0] for r in rows]
    i += n + 2
r = np.array(frames)                                       # (frames, atoms, 3), Å
steps = np.diff(r, axis=0)
frac = steps @ np.linalg.inv(cell)
steps = (frac - np.round(frac)) @ cell                     # minimum-image steps: undo wrapping
unwrapped = np.concatenate([r[:1], r[:1] + np.cumsum(steps, axis=0)])
li = [k for k, e in enumerate(elements) if e == "Li"]
msd = ((unwrapped[:, li] - unwrapped[0, li]) ** 2).sum(-1).mean(-1)   # Å² per saved frame
```

**5. A slab and a side view** ([examples/slab_picture.py](../examples/slab_picture.py))
```python
v.load("Cu.vasp")
v.build_slab(hkl=[1, 1, 1], layers=4, vacuum=15)   # vacuum along the surface normal (c)
v.set_view(direction="a", up="c", zoom=0.6)        # edge-on
v.save_image("cu111_slab.png", width=700, height=900)
```

## Errors at a glance

| Exception | When |
|---|---|
| `BrowserCommandError` | A wrong call: bad argument, unknown element, index or control |
| `CommandRefused` (a `BrowserCommandError`) | A typed method's command was refused; `call` and the generated methods return `applied: False` instead |
| `ViewerStartupError` | The window could not start (e.g. no display, or no GUI backend) |
| `ViewerClosedError` | The window was closed |
| `ViewerCommandTimeout` | The window stopped answering; it is closed so nothing half-done continues |
| `ViewerReentrancyError` | `wait()` called inside an event callback |
