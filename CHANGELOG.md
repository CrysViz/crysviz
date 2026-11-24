# Changelog

### Unreleased

### Highlights

- **MCP server:** `crysviz-mcp` (`pip install 'crysviz[mcp]'`) lets Claude and other MCP clients drive a local CrysViz window shared with the user: load and edit structures, find atoms, bonds, polyhedra and voids, set the view, run MD, relaxations, EOS and ordering as jobs, read symmetry, phonons and fields, export files and get pictures back (36 tools; see agent_guides/MCP.md)
- MCP shares the window with the user: every result reports what the user changed by hand since the model's last call (`sinceLastCall`); a call the situation refused (structure changed under its atoms, a job running, atoms too close) returns `applied: false` with a reason instead of a failed tool; the revision guard refuses only when the addressed atoms are no longer the same atoms
- Python for people scripting by hand: every command is a `Viewer` method (`v.find(...)`, `v.set_view(...)`, `v.run_relax(...)`, listed by `dir()`, documented by `help()`); `run_*` methods block until the job ends (`wait=False` to return at once); `v.on("user_changed", ...)` hears the user's hand edits as they happen and `take_user_changes()` always checks the window first; `repr(v)` shows what the window shows and `save_image` displays inline in Jupyter. Guide: agent_guides/Python.md; new examples for polyhedra colours, rings with networkx and a slab
- Python: `Viewer.call(name, **args)` runs any command (snake_case arguments accepted), `Viewer.run_job()` waits for a calculation, `Viewer.set_view()` looks along a, b, c, x, y, z or [u, v, w] with up and zoom, `Viewer.export_structure()` writes CIF, POSCAR or extended XYZ; `Viewer.load(..., interactive=False)` loads a CIF without the symmetry dialog
- Symmetry-constrained calculations from MCP and Python: `run_relax`, `run_md` and `run_eos` take `symmetry` and lock the structure with the Wyckoff editor first; the result says whether the group held. `run_eos` reports `fitReliable` with warnings (unconverged points, minimum not bracketed, V0 outside the scan, unphysical B0/B0'). `wait_job` takes `waitS` like the job starters; `get_symmetry` gives counts per Wyckoff letter (`listAtoms` for indices); argument errors carry the tool's arguments; a rotation shows up as one camera change
- MCP and Python: `save_image` writes SVG too (`format: "svg"`, or a `.svg` path; `vector` for shapes), through the Download Image window's own SVG export; `revert_structure` goes back to the structure as loaded (the Modify Structure window's Revert, without the confirm); `click_control` reports what a click did (windows and dialogs opened, files saved); `get_state` lists windows with refs for `read_window`, and says how the user's selection was made (a click on one atom, or a group)
- The app's Download and Save buttons in a window crysviz-mcp opens save into its export folder (and are reported to the model); `crysviz.Viewer(download_dir=...)` does the same for scripts and raises `file_saved`, while a plain Viewer window keeps its Save dialog
- Wyckoff editor: locking a structure that is only close to symmetric (within the tolerance) now idealises each site onto its exact position. Before, the site freedom and atom mappings were read off the distorted positions, so a whole orbit could collapse onto one point and a symmetry-constrained relaxation failed (NaN stress)
- README brought up to date (features, installation, Python API, MCP), and the examples rewritten for the current API with new ones for user-edit events, relax + EOS jobs and an MCP quickstart
- **Cut Slab (h k l)** in the Cell & Supercell window: a surface slab along (h k l), N layers thick with vacuum along the normal, as a new row. It is the same cutter as the MCP `build_slab`, and the feature search's *make slab*, *surface slab* and *surface* now lead to it (Add Vacuum keeps the vacuum phrases)
- Phonons window: **Make trajectory** keeps one period of the selected mode (2 to 200 frames, at the current amplitude) as a new trajectory row to step through or export, the same path as the MCP `build_phonon_frames`
- Download menu: **Extended XYZ (all frames)** writes every frame of the row on show for ASE, pymatgen or OVITO, the same file the MCP `export_structure` extxyz writes
- **Sync camera across tabs** (Visual ▸ Camera): tabs and windows of one browser with sync on turn and zoom together, gliding rather than jumping; the tab you touch leads. A long press picks what a tab copies (rotation and zoom, so different structures turn together, or the whole view with centre and pan), or makes the other tabs match this one. Perspective and parallel tabs zoom together. A tab spinning by itself (Random) follows the tab you touch instead of fighting it. Messages stay inside the browser (BroadcastChannel, same site only), carry camera numbers only and are checked before use
- Refined camera controls with shortcuts (desktop)
- Setting view along/opposite plane normal
- Added resolution control to plane colormaps

### Fixes

- Loading a structure file larger than ~512 MB through the Python launcher or MCP (e.g. a 1 GB CHGCAR) no longer fails with "POSCAR: missing scale factor": host inputs are read as files, like the file picker
- An open Modify Structure window no longer writes its table back over edits made elsewhere
- A change made by a script or MCP command shows without clicking the window; host-launched windows no longer show the release-note card on every launch
- CHGCAR loading made in parallel worker, with loading bar
- Atoms with default colors being changed to different element, now changes color properly
- Element change and occupation change made slightly faster
- WAVECAR load no longer overwrites the field, but appends it
- Isosurfaces of very fine grids (e.g. a 300x300x324 CHGCAR) no longer crash the marching cubes: a field too large for its 4 GB memory is resampled onto a coarser grid first


## 0.11.0

### Highlights

- **Search everything:** press Ctrl/⌘+F (or click the search field) to find any window, button or setting by name, including descriptive terms such as *lattice vibrations*.
- **Choose your panels:** new users start with the essential windows; **+ Add panels** brings in the others and **Reset to Essentials** goes back. Opening a feature from the search adds its window automatically.
- **Selection Inspector:** the selected atoms in their own 3D view, with every bond length and angle. **Compare** shows the same values in a second structure (experiment vs DFT, before vs after a relaxation, two trajectory steps), and the neighbour tool grows the selection bond by bond.
- **Asymmetric unit:** the Symmetry window draws the asymmetric unit in the cell, with its own colour and opacity, highlights the atoms inside it, and exports it to SVG.
- **Lattice analysis:** new Lattice Analysis and Lattice Comparison windows, and a **Parameters** tab in the Files window with the lattice, positions and Wyckoff sites ready to copy.
- **Complete Rings & Fragments:** molecules and rings that cross the cell boundary are drawn whole.
- **CIF symmetry and errors:** CIF files load with their symmetry detected, and standard uncertainties are read and can be shown with the values (**Show CIF Errors**).
- **Settings remembered per structure:** atom colours, atom and bond sizes, changed bond lengths, focus regions, field isosurface value/colour/opacity, crystal planes (with their field and colour map), spin and force arrow settings, the supercell and the cell boundary are stored in this browser and come back when the same file is loaded again.
- **Compressed URLs and QR codes:** much more compact share links and QR codes for large structures and custom settings (older links still work).
- **Spins from a VASP INCAR:** load an `INCAR` onto the selected structure to replace its spins with the file's `MAGMOM`.
- **Install as an app:** in Chrome or Edge on desktop, install CrysViz and open structure files straight from the file manager (*Open with* → *CrysViz*), or make it the default app for them.
- **Files list:** full-width names, a list that grows with its rows up to a height set by dragging its bottom edge, column titles that stay in view while scrolling, and drag-and-drop to reorder structures.
- **Stress and pressure:** one convention throughout (compression positive), and the stress tensor and energy are shown after EFS, relaxations and MD.
- **Widget mode:** live trajectory control, cameras linked between widgets, recentring over the control channel, and a leaner start-up.
- **Reload warning:** CrysViz asks before a reload throws away loaded structures.

### Fixes

- Pressure was shown with different units and signs in different places (an OUTCAR showed 10× its pressure, a NEP calculation the wrong sign); all readers and calculators now use one convention.
- Protostructure labels assigned the formula letters in the wrong order for some compositions: C11N4 now reads `A11B4_tP15_111_…:C-N` (was `A4B11_…`).
- VASP 4 POSCAR/CONTCAR files without a line of element names (as written by AFLOW) now open; the elements are taken from the per-atom labels or the title.
- Force and bond-length colour maps stay correct across trajectory frames, relaxations and MD, and the trajectory player's plots work in full screen.
- "Clear local data" in the Settings window now really clears everything: pending saves are cancelled and nothing is written back afterwards (focus regions were re-saved during trajectory playback).
- Bonds now end more closely to the atom surface instead of reaching 20% into the atom.
- Fewer transparency ghosts in large structures: the default number of depth-peeling layers is now 15 (was 10).
- Large structures and fields no longer get cut away depending on camera angle and pan: the orthographic camera is kept outside the structure (loading a big molecule after a small cell used to leave it inside), and the far clipping plane now grows with the scene.
- Focus region fading now applies to the phonon displacement arrows.
- Focus regions are no longer locked to the atoms they were created from; they stay at the specified centre.
- The plane d-parameter slider now moves between the limits of the plane within the cell.
- Dropping a window into the dock no longer clicks whatever is underneath it.
- The Cell window's Reset buttons use the standard reset style, and the "+ Add panels" button no longer shows a missing-character box in some fonts.

## 0.10.0

### Highlights

- **Phonopy support:** load `band.yaml`, `mesh.yaml` or `qpoints.yaml` (plus `total_dos.dat`/`projected_dos.dat` and `phonopy.yaml`) to get the band structure and DOS in a new Phonon Plots window. Click any point to animate that mode on the atoms, with displacement arrows and a suggested supercell for modes away from Γ. Å/Bohr length units are detected automatically. Mode-map energy scans are experimental and only appear when you open the app with `?experimental`.
- **New file formats:** CASTEP `.cell` files and `.geom`/`.md`/`.ts` trajectories (with per-frame energy, forces and stress), SHELX/AIRSS `.res` files (including many structures in one file), and FHI-aims `geometry.in` and `aims.out` (relaxation/MD trajectory, forces, spin moments). File types are now recognised from the file contents, not only the file name.
- **More export formats:** CIF (plain P1, or symmetrised with a tolerance preview), CASTEP `.cell`, FHI-aims `geometry.in`, and Quantum ESPRESSO structural cards you can copy.
- **Focus Regions:** fade everything outside a sphere around selected atoms, a molecule or a defect, with a soft radial edge, exclusions and a "Select inner atoms" action. Bonds, polyhedra, spins, forces and volumetric fields all follow the region, and regions are remembered per structure.
- **Load from online databases:** paste an OPTIMADE structure URL or an Alexandria ID (`agm…`) to fetch the structure directly.
- **Embeddable widget mode** (`?widget=1`): a structure-only view for embedding in other web pages. It includes a compact menu, a conventional/primitive cell switch, bond and polyhedra toggles, a light or dark theme, and an "Open in CrysViz" link.
- **Faster, lighter trajectories:** large multi-frame OUTCARs are read in the background and loaded frame by frame, so they use far less memory. Smooth trajectories play back by moving atoms and bonds in place, and there is a new "max" playback speed.
- **Fields, spins and forces:** volumetric fields, spin arrows and force arrows now repeat across an extended cell boundary. You can type an exact isosurface level. Spin arrows can be scaled automatically and have an arrowhead-length slider.

### Fixes

- Wyckoff mode: the "Add Site" dropdown no longer gets stuck on "free" for some cells (for example NaCl, primitive or conventional).
- POSCAR files with a negative scale factor (a target cell volume) now load with the correct cell, and Cartesian coordinates are scaled together with the lattice.
- WBOIT transparency mode no longer loses anti-aliasing when the scene is fully opaque, and the change from opaque to slightly transparent is smoother.
- Custom atom colours are once again kept after a browser reload.
- Isosurfaces no longer show artifacts at full opacity, and fields render correctly when a supercell is combined with an extended cell boundary.
- Spin and force arrows no longer vanish when zooming in after changing the cell boundary, and magnetic moments from mCIF files load correctly again.
- Playing long trajectories no longer makes memory use grow steadily.

## 0.1.0

Initial public release of CrysViz.
